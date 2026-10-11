/**
 * Re-register annexed content NEMAR holds but never advertised (#1392).
 *
 * `batchSetKeysPresent` used to run fifty `setpresentkey` processes at once and
 * count every exit-0 as a registration. It is fixed, but the datasets it already
 * lied about are still out there: a fleet sweep found 528 of 600 imported
 * datasets with ZERO keys recorded at `nemar-s3`, 720,896 keys in total, every
 * one of them sitting in the bucket.
 *
 * Those datasets are not broken for a user -- an imported repository carries
 * OpenNeuro's `s3-PUBLIC` remote with `autoenable=true`, so `git annex get`
 * still works. What is broken is that NEMAR does not serve its own copy, so
 * every clone goes to upstream and the archive's independence from OpenNeuro is
 * not real.
 *
 * Two rules this module will not bend (ADR 0061):
 *
 *  1. **What the bucket holds is established by listing it, once, with
 *     credentials.** Not by a per-key anonymous HEAD: `s3://nemar` denies
 *     anonymous ListBucket, so S3 answers a missing key with 403 rather than
 *     404, and 403 also means private, expired, or signed without a session
 *     token. One `list-objects-v2` per dataset is both conclusive and cheaper
 *     than 4,177 HEADs.
 *  2. **A dataset the bucket cannot fully account for is left alone.** If any
 *     annexed key has no object (whole or chunked), this is not a lost
 *     registration, it is content that was never transferred (#1396), and
 *     registering the rest would write true claims into a repository whose real
 *     problem is elsewhere. Reported and skipped, unless the caller asks
 *     otherwise.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { requestUploadCredentials } from "./api/data.js";
import { listS3ObjectKeys } from "./aws-cli.js";
import { pushToGitHub } from "./git-annex/clone-push.js";
import { getGitHubToken, githubTokenCredentialHelper } from "./git-annex/github.js";
import { runCommand } from "./git-annex/run-command.js";
import { batchSetKeysAbsent, batchSetKeysPresent } from "./git-annex/transfer.js";
import { MIN_DATA_AVAILABILITY, isKeyPresentAtDeclaredSize } from "./s3-server-copy.js";

// Re-exported from their home next to `isKeyPresentAtDeclaredSize`, which is the
// predicate ADR 0064's numerator is defined in terms of. Kept visible here
// because this module is where the sweep applies them.
export { MIN_DATA_AVAILABILITY, dataAvailability } from "./s3-server-copy.js";

/** The name the import gives NEMAR's own S3 special remote. */
export const REMOTE_NAME = "nemar-s3";

/**
 * Why a push did not land, or null when it did. For work that writes ONLY the
 * git-annex branch.
 *
 * `pushToGitHub` reports `{success: true, warning: "Main branch pushed, but
 * git-annex branch failed: ..."}`, which is the right contract for a caller that
 * also changed `main`: the content push succeeded and the location log can be
 * caught up later. It is the wrong reading here. Registering keys and retracting
 * claims both write the git-annex branch and nothing else, so `main` is a no-op
 * and that warning means NOTHING WAS PUSHED. Taking `.success` at face value
 * reported a retraction as repaired, then deleted the clone in `finally`, and
 * the claim was still in GitHub's log. `import-openneuro` already treats the
 * same warning as fatal for the same reason.
 */
function annexBranchPushFailure(pushed: {
  success: boolean;
  warning?: string;
  error?: string;
}): string | null {
  if (!pushed.success) return pushed.error ?? "push failed";
  return pushed.warning ?? null;
}

/**
 * A dataset id, which is also a directory name under the work root.
 *
 * Checked rather than trusted because the id reaches `join(workRoot, id)` and then
 * `rmSync`: `../something` would delete outside the work root, and an id repeated
 * in the target list would give two workers the same clone path, each removing it
 * while the other reads it.
 */
const DATASET_ID_RE = /^[a-z]{2}[0-9]{6}$/;

/**
 * What the bucket holds for a dataset: bare key to object size.
 *
 * The size is what makes this an answer rather than a guess. A failed copy
 * leaves a zero-byte object under the right name (#967), so a set of names
 * reports content that is not there -- on003645 has 653 such objects out of 823
 * and every name-only check called it complete.
 */
export type ObjectSource = (datasetId: string) => Promise<Map<string, number>>;

export interface KeyRegistrationState {
  datasetId: string;
  /** NEMAR's remote UUID from the git-annex branch, or null when it has none. */
  remoteUuid: string | null;
  /** Distinct keys the working tree names. */
  annexed: string[];
  /** Of those, the ones the location log already records at NEMAR's remote. */
  registered: string[];
  /**
   * Of those, the ones the bucket actually holds: an object of the declared size,
   * or every chunk of it (#1565).
   */
  inBucket: string[];
  /** In the bucket and not in the log: the repair target. */
  toRegister: string[];
  /**
   * Annexed, and neither an object of the declared size nor a complete chunk set
   * in the bucket: #1396's shape, not this one's.
   */
  missingContent: string[];
  /**
   * Claimed in the log and NOT in the bucket at its declared size, whole or as a
   * complete chunk set.
   *
   * The sweep used to see the missing content and stop, never noticing that some
   * of it was already advertised, so the false claim outlived every run. A clone
   * reading this is told to fetch bytes NEMAR does not hold, which is worse than
   * an unregistered key: that one merely fails to appear.
   */
  falselyClaimed: string[];
}

export type KeyRegistrationAction =
  | "compliant"
  | "repaired"
  | "would-repair"
  | "skipped-missing-content"
  | "skipped-no-remote"
  | "failed";

export interface KeyRegistrationOutcome {
  datasetId: string;
  action: KeyRegistrationAction;
  state?: KeyRegistrationState;
  pushed: boolean;
  notes: string[];
  error?: string;
}

/**
 * List a dataset's `objects/` prefix with credentials the API mints for it.
 *
 * Read-only against S3 despite the endpoint's name: upload credentials are what
 * grant access to the prefix, and listing is the cheapest thing they can do.
 *
 * It is NOT side-effect free against D1. `POST /datasets/:id/upload-credentials`
 * stamps `last_activity_at` before minting, so even a report without `--apply`
 * resets the staleness clock on every dataset it audits and postpones the 90-day
 * cleanup cron for private DOI-less ones. The obvious alternative is closed:
 * download credentials 400 on a public dataset, which most of the imported fleet
 * is. The command says so in its help rather than pretending otherwise.
 */
export function bucketObjectSource(): ObjectSource {
  return async (datasetId) => {
    const creds = await requestUploadCredentials(datasetId);
    return listS3ObjectKeys({
      credentials: creds.credentials,
      bucket: creds.s3.bucket,
      region: creds.s3.region,
      prefix: creds.s3.prefix,
    });
  };
}

/**
 * Git environment for a fleet clone, and the SLOT ORDER is the whole point.
 *
 * Extracted so the ordering is testable without a network: every test clones
 * from a local path, so the GitHub branch never runs, and if the post-clone
 * config wrote slot 0 (the empty reset) instead of slot 1 (the token helper),
 * every fleet push against GitHub would fail authentication with no test
 * failing. That is the path that pushes a retraction.
 *
 * Returns undefined for a non-GitHub url: a token is for GitHub and only for
 * GitHub, and `originUrl` is a local path in the tests.
 *
 * Slot 0 resets the helper list EVEN WITH NO TOKEN, and that is not redundant.
 * Git accumulates helpers, so the operator's global one -- on a Mac, the Git
 * Credential Manager -- still runs, and it opens a GUI dialog that
 * `GIT_TERMINAL_PROMPT=0` does nothing about; a sweep over hundreds of
 * repositories would sit behind a window nobody is watching. Slot 1 is then the
 * only helper left to answer.
 *
 * The token travels via `GIT_CONFIG_*` rather than argv or the URL so it never
 * lands in a process listing, and a token containing whitespace or a quote is
 * refused rather than embedded in a shell-quoted helper string.
 */
export function fleetCloneEnv(
  url: string,
  token?: string | null,
): Record<string, string> | undefined {
  if (!/^https:\/\/github\.com\//.test(url)) return undefined;
  const base = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GCM_INTERACTIVE: "never",
  };
  if (!token || /[\s']/.test(token)) return base;
  return {
    ...base,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: githubTokenCredentialHelper(token),
  };
}

/**
 * Clone a dataset for inspection, and return an error string or undefined.
 *
 * Deliberately not `cloneDataset`: that runs `git annex init` itself, before any
 * identity can be configured, and git-annex init COMMITS to the git-annex branch.
 * On a machine with no `user.email` -- which is what the required CI tier is --
 * that fails, and the whole repair reports a clone failure for a reason that has
 * nothing to do with cloning.
 *
 * The clone is `--filter=blob:none` by default. That is NOT what avoids fetching
 * annexed content -- annexed content is never a git blob, and the checkout
 * fetches every blob of HEAD regardless. What it skips is historical blobs, and
 * it makes the git-annex branch's location logs lazily fetched, which is worth
 * having across 800 repositories and wrong for a caller that then reads those
 * logs in bulk (`partial: false`).
 */
export async function cloneForFleetWork(
  url: string,
  datasetPath: string,
  options: {
    /**
     * `--filter=blob:none`, the default. Turn it off when the run reads many
     * blobs of the git-annex branch: a partial clone fetches those one at a
     * time on demand, which is minutes per dataset rather than seconds.
     */
    partial?: boolean;
    /** What the clone calls itself in the annex's `uuid.log`. */
    description?: string;
  } = {},
): Promise<string | undefined> {
  // A token is for GitHub, and only for GitHub: `originUrl` is also a local path
  // in the tests, and some imported datasets are private, so https needs one.
  //
  // The empty `credential.helper` in slot 0 is not redundant. Git ACCUMULATES
  // helpers, so the operator's global one -- on a Mac, the Git Credential
  // Manager -- still runs, and it opens a GUI dialog that `GIT_TERMINAL_PROMPT=0`
  // does nothing about. An empty value resets the list, so a sweep over hundreds
  // of repositories cannot sit waiting behind a window nobody is watching.
  let env: Record<string, string> | undefined;
  if (/^https:\/\/github\.com\//.test(url)) {
    const token = process.env.GH_TOKEN?.trim() || (await getGitHubToken()).token;
    env = fleetCloneEnv(url, token);
  }
  const clone = await runCommand(
    [
      "git",
      "clone",
      "--quiet",
      ...(options.partial === false ? [] : ["--filter=blob:none"]),
      url,
      datasetPath,
    ],
    env ? { env } : {},
  );
  if (clone.exitCode !== 0) {
    return clone.stderr.trim() || `git clone exited ${clone.exitCode}`;
  }
  if (env?.GIT_CONFIG_VALUE_1) {
    // The clone-time helpers covered only that process; the push needs them too,
    // in this order: the empty value resets whatever the global config set up,
    // then ours is the only one left to answer.
    await runCommand(["git", "config", "credential.helper", ""], { cwd: datasetPath });
    await runCommand(
      ["git", "config", "credential.https://github.com.helper", env.GIT_CONFIG_VALUE_1],
      { cwd: datasetPath, redact: [env.GIT_CONFIG_VALUE_1] },
    );
  }
  // An identity per clone, BEFORE git-annex init, because that commits.
  await runCommand(["git", "config", "user.email", "nemar-bot@nemar.org"], { cwd: datasetPath });
  await runCommand(["git", "config", "user.name", "NEMAR"], { cwd: datasetPath });
  const init = await runCommand(
    ["git", "annex", "init", "--quiet", options.description ?? "fleet-key-registration"],
    { cwd: datasetPath },
  );
  if (init.exitCode !== 0) {
    return `git annex init failed: ${init.stderr.trim() || `exit ${init.exitCode}`}`;
  }
  return undefined;
}

/** Distinct keys the tree names, sorted. */
async function annexedKeys(datasetPath: string): Promise<string[]> {
  // `--include '*'` and not `--all`, which `find` rejects.
  const { stdout, stderr, exitCode } = await runCommand(
    ["git", "annex", "find", "--include", "*", "--format=${key}\n"],
    { cwd: datasetPath },
  );
  // An empty answer and a failed question look identical on stdout: `find` exits 1
  // with no output when the repository is not annex-initialized. Treating that as
  // "no annexed keys" would hand the operator a clean bill of health for a dataset
  // nothing was read from.
  if (exitCode !== 0) {
    throw new Error(`git annex find failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return [...new Set(stdout.split("\n").filter(Boolean))].sort();
}

/** Keys the location log records at this remote, sorted. */
async function keysRecordedAt(datasetPath: string, remoteUuid: string): Promise<string[]> {
  const { stdout, stderr, exitCode } = await runCommand(
    ["git", "annex", "find", "--include", "*", "--in", remoteUuid, "--format=${key}\n"],
    { cwd: datasetPath },
  );
  // Same trap: `--in` exits 1 with empty stdout when the UUID cannot be resolved,
  // which would read as "the remote holds nothing" and turn every key into work.
  if (exitCode !== 0) {
    throw new Error(
      `git annex find --in ${remoteUuid} failed: ${stderr.trim() || `exit ${exitCode}`}`,
    );
  }
  return [...new Set(stdout.split("\n").filter(Boolean))].sort();
}

/** NEMAR's remote UUID as the git-annex branch records it. */
export async function resolveRemoteUuid(
  datasetPath: string,
  remoteName = REMOTE_NAME,
): Promise<string | null> {
  const { stdout, exitCode } = await runCommand(["git", "show", "git-annex:remote.log"], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) return null;
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // An exact field, not a substring: an exemplar repo carries both `nemar-s3`
    // (inherited from production) and `nemar-s3-dev`, and a substring match would
    // register production's content against the dev remote's UUID -- a false claim
    // of exactly the kind this module exists to stop.
    if (!fields.some((field) => field === `name=${remoteName}`)) continue;
    const uuid = fields[0];
    if (uuid) return uuid;
  }
  return null;
}

/**
 * Read one dataset's registration state. Touches nothing.
 *
 * `datasetPath` must be a clone that already has the git-annex branch and an
 * initialized annex; `sweepKeyRegistration` arranges that.
 */
export async function scanDatasetKeyRegistration(
  datasetId: string,
  datasetPath: string,
  objects: ObjectSource,
  remoteName = REMOTE_NAME,
): Promise<KeyRegistrationState> {
  const remoteUuid = await resolveRemoteUuid(datasetPath, remoteName);
  const annexed = await annexedKeys(datasetPath);
  if (!remoteUuid) {
    return {
      datasetId,
      remoteUuid: null,
      annexed,
      registered: [],
      inBucket: [],
      toRegister: [],
      missingContent: [],
      falselyClaimed: [],
    };
  }
  const registered = await keysRecordedAt(datasetPath, remoteUuid);
  const held = await objects(datasetId);
  const recorded = new Set(registered);
  // Present AT ITS DECLARED SIZE. A key whose object is truncated or zero bytes
  // is not content, and registering it tells every clone NEMAR has something it
  // cannot serve (ADR 0063).
  const inBucket = annexed.filter((key) => isKeyPresentAtDeclaredSize(key, held));
  return {
    datasetId,
    remoteUuid,
    annexed,
    registered,
    inBucket,
    toRegister: inBucket.filter((key) => !recorded.has(key)),
    missingContent: annexed.filter((key) => !isKeyPresentAtDeclaredSize(key, held)),
    falselyClaimed: annexed.filter(
      (key) => recorded.has(key) && !isKeyPresentAtDeclaredSize(key, held),
    ),
  };
}

export interface KeyRegistrationOptions {
  /** Where clones go. Each is removed when its dataset is done. */
  workRoot: string;
  /** Write and push. Without it nothing is changed. */
  apply?: boolean;
  /** Commit locally and push nothing, for a rehearsal. */
  push?: boolean;
  /** Act even on a dataset whose content the bucket cannot fully account for. */
  includeIncomplete?: boolean;
  /**
   * Withdraw claims the bucket cannot back, instead of only reporting them.
   *
   * Off by default, because a missing object is usually a transfer still owed
   * rather than content that is gone: recover it and the claim becomes true.
   * Turn this on once recovery has reported the keys unrecoverable, when the
   * claim cannot be made true and leaving it is the dishonest option.
   */
  retractFalseClaims?: boolean;
  /** Where to clone from; the org repository by default. */
  originUrl?: string;
  remoteName?: string;
}

/**
 * Repair one dataset, and prove it from the location log before pushing.
 *
 * The order is deliberate: register, re-read the log, and only then push. A push
 * is the irreversible half, and the whole reason this issue exists is that the
 * previous code trusted a return value it never checked.
 */
export async function repairDatasetKeyRegistration(
  datasetId: string,
  objects: ObjectSource,
  options: KeyRegistrationOptions,
): Promise<KeyRegistrationOutcome> {
  const remoteName = options.remoteName ?? REMOTE_NAME;
  if (!DATASET_ID_RE.test(datasetId)) {
    return {
      datasetId,
      action: "failed",
      pushed: false,
      notes: [],
      error: `"${datasetId}" is not a dataset id, and it would become a directory this deletes`,
    };
  }
  const datasetPath = join(options.workRoot, datasetId);
  const notes: string[] = [];
  rmSync(datasetPath, { recursive: true, force: true });

  const url = options.originUrl ?? `https://github.com/nemarDatasets/${datasetId}.git`;
  const cloned = await cloneForFleetWork(url, datasetPath);
  if (cloned) {
    // Before the try, so nothing else removes it: a half-written clone left under
    // the work root outlives the run and the next one deletes it blind.
    rmSync(datasetPath, { recursive: true, force: true });
    return { datasetId, action: "failed", pushed: false, notes, error: cloned };
  }

  try {
    const state = await scanDatasetKeyRegistration(datasetId, datasetPath, objects, remoteName);
    if (!state.remoteUuid) {
      return {
        datasetId,
        action: "skipped-no-remote",
        state,
        pushed: false,
        notes: [`no ${remoteName} remote in the git-annex branch; nothing to register against`],
      };
    }
    // Withdrawing a claim comes BEFORE the missing-content bail-out, because a
    // dataset with missing content is exactly where a false claim lives: the
    // sweep saw it, refused to register, and left the claim standing.
    if (options.retractFalseClaims && state.falselyClaimed.length > 0) {
      if (!options.apply) {
        return {
          datasetId,
          action: "would-repair",
          state,
          pushed: false,
          notes: [
            `${state.falselyClaimed.length} key(s) are advertised at ${remoteName} and not in the bucket; would withdraw`,
          ],
        };
      }
      const withdrawn = await batchSetKeysAbsent(
        datasetPath,
        state.falselyClaimed,
        state.remoteUuid,
      );
      if (withdrawn.failed > 0) {
        return {
          datasetId,
          action: "failed",
          state,
          pushed: false,
          notes,
          error: `${withdrawn.failed} claim(s) still stand after setpresentkey 0: ${withdrawn.missing.join(", ")}`,
        };
      }
      notes.push(`withdrew ${withdrawn.success} claim(s) the bucket cannot back`);
      const retractionPushFailure = annexBranchPushFailure(
        await pushToGitHub(datasetPath, "origin"),
      );
      if (retractionPushFailure) {
        return {
          datasetId,
          action: "failed",
          state,
          pushed: false,
          notes,
          error: `the retraction did not reach GitHub: ${retractionPushFailure}. The claims are still advertised; re-run to redo it.`,
        };
      }
      return { datasetId, action: "repaired", state, pushed: true, notes };
    }
    if (state.missingContent.length > 0 && !options.includeIncomplete) {
      return {
        datasetId,
        action: "skipped-missing-content",
        state,
        pushed: false,
        notes: [
          `${state.missingContent.length} of ${state.annexed.length} annexed key(s) have no object of their declared size, whole or chunked, in the bucket${
            state.falselyClaimed.length > 0
              ? `, ${state.falselyClaimed.length} of them advertised at ${remoteName} anyway (rerun with retractFalseClaims to withdraw)`
              : ""
          }, so this is missing content (#1396) rather than a lost registration; first: ${state.missingContent[0]}`,
        ],
      };
    }
    if (state.toRegister.length === 0) {
      // Checked AFTER the missing-content branch, which `--include-incomplete`
      // skips: without this, a dataset with 480 annexed keys and nothing in the
      // bucket has an empty `toRegister` and would be tallied compliant.
      if (state.missingContent.length > 0) {
        return {
          datasetId,
          action: "skipped-missing-content",
          state,
          pushed: false,
          notes: [
            `nothing to register: the bucket holds none of the ${state.missingContent.length} key(s) still outstanding (#1396)`,
          ],
        };
      }
      return { datasetId, action: "compliant", state, pushed: false, notes };
    }
    if (!options.apply) {
      return {
        datasetId,
        action: "would-repair",
        state,
        pushed: false,
        notes: [`${state.toRegister.length} key(s) are in the bucket and not in the log`],
      };
    }

    const result = await batchSetKeysPresent(datasetPath, state.toRegister, state.remoteUuid);
    // Ask the log rather than the helper. It is fixed and it already does this,
    // but a sweep over 529 published repositories is not the place to take a
    // second-hand answer about whether a write landed.
    const after = new Set(await keysRecordedAt(datasetPath, state.remoteUuid));
    const stillMissing = state.toRegister.filter((key) => !after.has(key));
    if (stillMissing.length > 0) {
      return {
        datasetId,
        action: "failed",
        state,
        pushed: false,
        notes,
        error: `registered ${result.success} of ${state.toRegister.length}, and the location log still does not record ${stillMissing.length} of them (first: ${stillMissing[0]}). Nothing pushed.`,
      };
    }
    notes.push(`registered ${state.toRegister.length} key(s), all confirmed in the location log`);

    if (options.push === false) {
      return { datasetId, action: "repaired", state, pushed: false, notes };
    }
    // NOT `pushToGitHub(path, "origin", "git-annex")`: naming the branch makes that
    // helper treat it as rebasable, and the git-annex branch must never be rebased
    // -- it is an append-only log that merges through git-annex's own union-merge.
    // The default path pushes `main` (unchanged here, so a no-op) and then the
    // git-annex branch with the correct fetch + `git annex merge` retry.
    const pushFailure = annexBranchPushFailure(await pushToGitHub(datasetPath, "origin"));
    if (pushFailure) {
      return {
        datasetId,
        action: "failed",
        state,
        pushed: false,
        notes,
        error: `the git-annex branch did not push: ${pushFailure}. The registration is local only; re-run to redo it.`,
      };
    }
    return { datasetId, action: "repaired", state, pushed: true, notes };
  } finally {
    rmSync(datasetPath, { recursive: true, force: true });
  }
}

/**
 * Run `work` over `items` with at most `limit` in flight, preserving order.
 *
 * Results are written by input index, so the caller gets them in input order
 * however they complete: the `Parts` array a multipart copy hands to
 * `complete-multipart-upload` depends on that.
 *
 * **On a failure it waits for the siblings before rejecting.** There is no
 * cancellation, so the other workers keep running whatever this does; the choice
 * is only whether the caller learns of the failure before or after they stop.
 * Before is worse: the multipart caller's error handler aborts the upload the
 * still-running `upload-part-copy` calls are writing to, and a part that lands
 * after the abort resurrects an upload nobody will ever complete, which is
 * billable storage no object listing can see. The first rejection is still the
 * one thrown, so the reported cause does not change.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // Set by the first worker to throw. The others finish the item they are on --
  // that is what makes the wait safe -- but start no new ones, so a failure
  // still ends the batch promptly instead of copying every remaining part.
  let stopped = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!stopped) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await work(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}

export interface KeyRegistrationSweep {
  outcomes: KeyRegistrationOutcome[];
  tally: Record<KeyRegistrationAction, number>;
  /** Keys registered across the whole sweep. */
  keysRegistered: number;
}

export async function sweepKeyRegistration(
  datasetIds: string[],
  objects: ObjectSource,
  options: KeyRegistrationOptions & {
    concurrency?: number;
    onDataset?: (outcome: KeyRegistrationOutcome, done: number, total: number) => void;
  },
): Promise<KeyRegistrationSweep> {
  // Deduplicated: two workers on one id share a clone path and delete it under
  // each other.
  const unique = [...new Set(datasetIds)];
  let done = 0;
  const outcomes = await mapWithConcurrency(unique, options.concurrency ?? 4, async (datasetId) => {
    let outcome: KeyRegistrationOutcome;
    try {
      outcome = await repairDatasetKeyRegistration(datasetId, objects, options);
    } catch (error) {
      outcome = {
        datasetId,
        action: "failed",
        pushed: false,
        notes: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    options.onDataset?.(outcome, ++done, unique.length);
    return outcome;
  });

  const tally = {
    compliant: 0,
    repaired: 0,
    "would-repair": 0,
    "skipped-missing-content": 0,
    "skipped-no-remote": 0,
    failed: 0,
  } as Record<KeyRegistrationAction, number>;
  let keysRegistered = 0;
  for (const outcome of outcomes) {
    tally[outcome.action]++;
    if (outcome.action === "repaired") keysRegistered += outcome.state?.toRegister.length ?? 0;
  }
  return { outcomes, tally, keysRegistered };
}
