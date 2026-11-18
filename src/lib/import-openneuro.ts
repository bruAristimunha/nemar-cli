/**
 * OpenNeuro dataset import
 *
 * Clones an OpenNeuro dataset, copies data directly from OpenNeuro S3 to
 * NEMAR S3 (server-side, no local download), and creates the corresponding
 * nemarDatasets repo with 'on' prefix ID.
 */

import {
  type Dirent,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
  isOpenNeuroTag,
  normalizeUpstreamTag,
  sameUpstreamTag,
} from "../../shared/openneuro-tag.js";
import { isOwnSourceEntry, sourceSnapshotOf } from "../../shared/source-snapshot.js";
import { decideReadme, readmeProvenanceStub } from "../../shared/standard-edits/readme.js";
import { addCi, importDataset, reindexDataset } from "./api/admin.js";
import { getDataset, getUserCiStatus, hasReleasedVersion } from "./api/datasets.js";
import { ApiError } from "./api/errors.js";
import { requestPublication } from "./api/publish.js";

import { LEDGER_REPO_PATH } from "../../scripts/scrub/ledger.js";
import { cloneDataset, pushToGitHub } from "./git-annex/clone-push.js";
import { configureGitHubRemote } from "./git-annex/github.js";
import { isNeverAnnexedMetadata, shouldAnnex } from "./git-annex/policy.js";
import { ensureLocalMainBranch } from "./git-annex/repo-state.js";
import { runCommand } from "./git-annex/run-command.js";
import {
  type S3Credentials,
  annexUuidPreflightAction,
  awsCredentialEnv,
  configureS3Remote,
  fetchOriginAnnexBranch,
  markInheritedOpenNeuroRemotesIgnored,
  preflightBucketAnnexUuid,
} from "./git-annex/s3-remote.js";
import { getAnnexWhereisAll, getRemoteUuid, listAnnexedKeys } from "./git-annex/transfer.js";
import {
  DATA_AVAILABILITY_MARKER,
  registerTreeKeys,
  treeGate,
  verifyManifestObjects,
} from "./import-finalize-gate.js";
import {
  ImportRefused,
  NEMAR_ANNEX_UUID_CONFLICT_MARKER,
  OPENNEURO_MIRROR_LAG_MARKER,
  OPENNEURO_UPSTREAM_MARKER,
  OPENNEURO_UPSTREAM_MOVED_MARKER,
} from "./import-markers.js";
import { annexCopyUpload } from "./import-normalize.js";
import {
  type PublicationDecision,
  awaitScreenAndApprove,
  describePublicationDecision,
  screenWaitBudget,
} from "./import-publication.js";
import { httpUpstreamReader, prepareImportedTreeForCopy } from "./import-scrub.js";
import { fetchOpenNeuroLatestTag } from "./openneuro.js";
import {
  type ImportManifest,
  type ImportManifestItem,
  type ImportPrivacyRecord,
  batchServerSideCopy,
  cleanupStaging,
  expectedSizesFromItems,
  filterAlreadyCopied,
  isLocallyUploaded,
  listExistingObjects,
  parseS3Url,
  readManifestFromS3,
  selectShardCopyItems,
  writeManifestToS3,
} from "./s3-server-copy.js";
import { listAnnexedPaths, listTrackedPaths } from "./upload/transfer.js";

const OPENNEURO_ORG = "OpenNeuroDatasets";
const S3_BUCKET = "nemar";
const S3_REGION = "us-east-2";
/** Default parallel server-side copies per shard. Higher than the old 8 because
 *  the runner is no longer the byte bottleneck (copies stay on AWS's backbone). */
const COPY_CONCURRENCY = 16;

interface ImportOptions {
  /**
   * Ceiling on what the tree-normalization step will upload from this host, in
   * bytes. Defaults to `NORMALIZE_MAX_BYTES`; raised deliberately per run with
   * `--normalize-max-gb` when a dataset genuinely carries more data in git.
   */
  normalizeMaxBytes?: number;
  workDir?: string;
  skipData?: boolean;
  /**
   * If the bounded workflow-run poll times out without seeing a registered
   * BIDS validation run, fall back to skip_ci_check=true at publication time.
   * Off by default: missing validation should fail the import. The OpenNeuro
   * onboarding workflow opts in because OpenNeuro pre-validates BIDS upstream
   * (see nemarOrg/nemar-cli#431).
   */
  trustUpstream?: boolean;
  /**
   * Persist the import manifest (and read it back) via S3 staging, so the
   * prepare/copy/finalize phases can run as separate GitHub Actions jobs that
   * don't share a filesystem. The single-process driver leaves this off and
   * passes the manifest in memory.
   */
  persistStaging?: boolean;
  /**
   * How long finalize waits for the identifier screen's verdict, and how often it
   * reads the request's status meanwhile (ADR 0089). Defaults: what the finalize
   * job's timeout leaves, at most `SCREEN_WAIT_MS` (`screenWaitBudget`), and
   * `SCREEN_POLL_MS`.
   */
  screenWaitMs?: number;
  screenPollMs?: number;
  /**
   * The upstream snapshot tag to import (ADR 0111 decision 10). The auto-import passes the tag
   * discovery found; with none, prepare asks OpenNeuro for its latest at run time. Never the
   * mirror's default HEAD.
   */
  tag?: string;
  /**
   * Moves the OpenNeuro GraphQL endpoint prepare asks for the latest tag, and bounds its retries.
   * For tests; a run leaves it unset and asks openneuro.org.
   */
  openNeuroLookup?: Parameters<typeof fetchOpenNeuroLatestTag>[1];
}

/**
 * Outcome of `waitForBidsValidationRun`. Distinguishes three states an
 * operator (and the `--trust-upstream` fallback) must reason about:
 *   - found: a workflow_run registered before the deadline. ci_check at
 *     approval time will evaluate it normally; skipCiCheck must be false.
 *   - timeout: every poll succeeded but no run ever registered. This is
 *     the case `--trust-upstream` is designed to bypass — the deployed
 *     workflow files never produced a run within the budget, likely a
 *     webhook-delivery edge case on a freshly populated repo.
 *   - error: every poll attempt threw (auth, 5xx, network). We never
 *     actually checked validation state, so `--trust-upstream` must NOT
 *     silently approve under this condition — that would reintroduce the
 *     trust-assumption pathology #431 is meant to remove.
 */
export type PollOutcome =
  | { kind: "found" }
  | { kind: "timeout" }
  | { kind: "error"; lastError: unknown };

/**
 * Bounded wait for a BIDS validation workflow run to register on the freshly
 * deployed CI. Polls `getUserCiStatus` and reports the wait visibly via the
 * supplied spinner so operators understand the pause.
 *
 * Replaces the previous unconditional `skip_ci_check=true` trust assumption
 * (see nemarOrg/nemar-cli#431). Reviewer note: a bare `catch {}` here would
 * mask persistent 4xx/5xx and either mislead the operator on timeout or
 * silently approve a never-validated publication under `--trust-upstream`.
 *
 * Exported so the exemplar clone tool (epic #923 Phase 5,
 * `lib/exemplar-clone.ts`) can reuse the same bounded-poll mechanism instead
 * of duplicating it.
 */
export async function waitForBidsValidationRun(
  nemarId: string,
  spinner: ReturnType<typeof ora>,
  maxWaitMs = 120_000,
  pollIntervalMs = 5_000,
): Promise<PollOutcome> {
  const deadline = Date.now() + maxWaitMs;
  let lastError: unknown;
  let sawCleanResponse = false;
  while (Date.now() < deadline) {
    try {
      const status = await getUserCiStatus(nemarId);
      sawCleanResponse = true;
      if (status.bids_validation.present && status.bids_validation.status !== "no_runs") {
        return { kind: "found" };
      }
    } catch (err) {
      lastError = err;
    }
    const remaining = Math.max(0, deadline - Date.now());
    spinner.text = `Waiting for BIDS validation run to register... (${Math.ceil(remaining / 1000)}s left)`;
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }
  if (!sawCleanResponse && lastError !== undefined) {
    return { kind: "error", lastError };
  }
  return { kind: "timeout" };
}

/**
 * Pure decision over the (CI deployed, poll outcome, --trust-upstream)
 * matrix. Centralised so it is unit-testable and so the rules stay legible
 * after this function has been re-read in the next post-mortem.
 *
 * Hard rule: if `addCi()` failed we never proceed to publication, regardless
 * of `--trust-upstream`. The flag bypasses validation lookup, not the
 * presence of validation, enrichment, and archive workflows themselves
 * (reviewer note for nemarOrg/nemar-cli#451).
 *
 * Hard rule: if every poll attempt threw we treat the bounded wait as a hard
 * error even under `--trust-upstream` — we never actually observed validation
 * state, which is the same trust hole #431 was meant to close.
 */
export function decideSkipCiCheck(args: {
  ciDeployed: boolean;
  poll: PollOutcome | null;
  trustUpstream: boolean;
}): { skipCiCheck: boolean; abortReason?: string } {
  if (!args.ciDeployed) {
    return {
      skipCiCheck: false,
      abortReason:
        "CI workflows did not deploy. Aborting before approval: --trust-upstream bypasses validation lookup, not workflow deployment. Re-run after fixing the deploy failure, or run `nemar admin ci add <id>` manually before approving.",
    };
  }
  const poll = args.poll;
  if (poll === null || poll.kind === "found") {
    return { skipCiCheck: false };
  }
  if (poll.kind === "error") {
    const msg = poll.lastError instanceof Error ? poll.lastError.message : String(poll.lastError);
    return {
      skipCiCheck: false,
      abortReason: `Every BIDS validation poll attempt failed (last error: ${msg}). Refusing to bypass under --trust-upstream because validation state was never actually observed. Investigate API/auth health and re-run.`,
    };
  }
  if (args.trustUpstream) {
    return { skipCiCheck: true };
  }
  return {
    skipCiCheck: false,
    abortReason:
      "BIDS validation run did not register within the bounded poll window. Re-run with --trust-upstream to bypass (OpenNeuro datasets are pre-validated upstream), or investigate why the deployed CI did not trigger.",
  };
}

/**
 * True when a POST /admin/datasets/import failure means "the dataset record
 * and/or GitHub repo already exist" -- the expected, non-fatal shape of a
 * RETRIED prepare (#969, epic #967 Phase 2): the row/repo genuinely exist
 * server-side (POST returns 409), so prepare must continue (reuse them,
 * rebuild the manifest, ensure main is pushed) rather than abort. Matches
 * both the D1 duplicate-dataset 409 ("Dataset ... already exists") and the
 * GitHub-repo-exists 409 ("GitHub repo nemarDatasets/... already exists")
 * from routes/admin/imports.ts. Exported for tests.
 */
export function isAlreadyExistsImportError(message: string): boolean {
  return message.includes("already exists") || message.includes("409");
}

/**
 * Pure decision over whether finalize should (re-)request publication for a
 * dataset it just re-copied (#985, epic #967 recover). `publish/request`
 * 409s with "Dataset is already published" once `datasets.visibility` is
 * 'public' (routes/datasets/publication.ts), which is exactly the state the
 * #967 recover workflow re-runs finalize against: prepare -> copy -> finalize
 * on a dataset that was ALREADY published, to repair data that got silently
 * under-delivered the first time. That re-copy must not trip a fatal exit on
 * a 409 that just means "nothing to do here" -- but it must also NOT
 * re-approve or re-mint anything (approvePublication is what actually flips
 * a DOI/S3-lock/etc, and none of that is safe to re-run against a dataset
 * that's already live). Keyed on the dataset's live `visibility` (a status
 * READ, not a string match on the request's own error) so a 409 for any
 * other reason still surfaces as the fatal error it always has.
 */
export function decidePublicationRequestAction(
  visibility: "public" | "private",
): "request" | "skip-already-published" {
  return visibility === "public" ? "skip-already-published" : "request";
}

/**
 * Pure decision over what Step 4c bases a fresh clone's `main` on (#990, #993; ADR 0111
 * decision 10). Re-importing onto a repository that already has a `main` (the #967 recovery case:
 * re-copy data for a version NEMAR already imported once) makes a brand-new OpenNeuro clone whose
 * `main` shares no history with origin's -- origin already carries the FIRST import's metadata
 * commit on the same files (.nemar/metadata.json, README.md), so committing fresh metadata onto
 * the clone's own history and pushing collides, and pushToGitHub's rebase (clone-push.ts)
 * hard-fails with "diverging commits and auto-rebase failed".
 *
 *   - `none`: origin has no resolvable `main` (a genuine first import: nothing to base on), or
 *     the tag is not moved and the clone is not on a plain `main`. Detached HEAD ("HEAD") and
 *     git-annex adjusted branches ("adjusted/main(unlocked)") are not reset: pushToGitHub
 *     special-cases both (HEAD:main push, no-rebase adjusted push) and neither is safe to reset
 *     the same way.
 *   - `hard-reset`: origin's `main` records no upstream tag, or records the tag being imported,
 *     and the clone is on `main`. The same import again, so the tree becomes origin's, as before
 *     the tag pin. An unrecorded tag lands here by design: it never trips the guard (ADR 0111
 *     decision 10).
 *   - `moved`: origin's `main` records a DIFFERENT upstream tag, whatever branch the clone is on:
 *     the guard reads the tag first, so an odd branch can never skip it. What happens next depends
 *     on whether the dataset has released a version, which costs a request, so it is asked only
 *     now (see {@link baseOnOriginMain}).
 */
export function decideReimportBase(args: {
  originMainSha: string | null;
  currentBranch: string;
  recordedTag: string | null;
  importTag: string;
}): "none" | "hard-reset" | "moved" {
  if (args.originMainSha === null || args.originMainSha === "") return "none";
  if (args.recordedTag !== null && !sameUpstreamTag(args.recordedTag, args.importTag)) {
    return "moved";
  }
  return args.currentBranch === "main" ? "hard-reset" : "none";
}

/**
 * Whether Step 6 records the pinned tag as a `SourceDatasets` entry (ADR 0111 decision 10): when
 * the tree is the pinned tag's, a first import or a retarget. After a hard reset the tree is
 * origin's, and recording a tag there would be a guess. Pure, for the test.
 */
export function shouldRecordSourceEntry(base: Pick<ReimportBase, "kind">): boolean {
  return base.kind !== "hard-reset";
}

/** What Step 4c did to the clone's `main`, and the tag origin's `main` recorded. */
export interface ReimportBase {
  /**
   * `none`: left as cloned (a first import, or a fallback). `hard-reset`: now origin's `main`,
   * tree included. `retarget`: HEAD is origin's `main` and the index and working tree are still
   * the clone's, so the next commit is a fast-forward of origin carrying the new tag's tree.
   */
  kind: "none" | "hard-reset" | "retarget";
  recordedTag: string | null;
  /**
   * Set when origin has a `main` whose recorded tag could not be read, and why: the guard is
   * inert then (ADR 0111: an unrecorded tag never trips it), which is said out loud, never left
   * silent.
   */
  unrecorded?: string;
}

/**
 * Step 4c of prepare: base the fresh clone's `main` on origin's tip BEFORE Step 6 seeds a new
 * metadata commit, when origin already has a `main` (#990), and refuse when doing so would move a
 * released mirror to a new upstream tag (#993; ADR 0111 decision 10).
 *
 * The tag origin's `main` records is read from its `dataset_description.json` with Phase 2's
 * parser, `sourceSnapshotOf` (shared/source-snapshot.ts), the one every reader of the tag uses.
 * When it differs from `importTag` (exactly, after a leading `v`: `sameUpstreamTag`, never the
 * parser's numeric `compareSourceTags`, which calls `1.0` and `1.0.0` equal and would take the
 * hard reset that keeps the old tree, #993):
 *   - the dataset has released a version: refuse with `[openneuro-upstream-moved]` before any
 *     reset, S3 setup or push. Moving a released mirror to a newer snapshot is a re-pull's job
 *     (ADR 0111), never a re-import's, and a re-import would keep the old tree while copying the
 *     new tag's data (#993). The refusal names both ways on: a re-pull, to OpenNeuro's latest
 *     snapshot by default (`nemar admin repull plan`), and the repair at the recorded tag.
 *   - it has not: the same import, prepared again at the tag it now imports. `git reset --soft
 *     origin/main` moves HEAD onto origin's tip and keeps the new tag's tree in the index, so the
 *     commits that follow are a fast-forward of origin carrying that tree. Steps 5b and 6 re-apply
 *     NEMAR's edits to it as on a first import; `.github/`, which finalize deploys, is dropped
 *     until finalize deploys it again.
 *
 * `released` is called only in that case, and an error from it is a plain failure: not knowing
 * whether a dataset is released must never read as "unreleased".
 *
 * An origin with no `main` is a first import, told by `git ls-remote --exit-code`'s status 2 (no
 * matching ref), never by git's message, which is localized ("Konnte Remote-Referenz main nicht
 * finden"; see src/lib/git-annex/init.ts on keying on statuses). Any other failure to ask or to
 * fetch throws: an origin that could not be asked is not one with nothing to guard. A failed hard
 * reset still warns and falls back to the normal push path, as before.
 */
export async function baseOnOriginMain(
  datasetPath: string,
  args: { sourceId: string; importTag: string; nemarId: string; released: () => Promise<boolean> },
): Promise<ReimportBase> {
  const originHasMain = await runCommand(
    ["git", "ls-remote", "--exit-code", "origin", "refs/heads/main"],
    { cwd: datasetPath },
  );
  // 2: origin answered and has no such ref, a first import.
  if (originHasMain.exitCode === 2) return { kind: "none", recordedTag: null };
  const originMainFetch =
    originHasMain.exitCode === 0
      ? await runCommand(["git", "fetch", "origin", "main"], { cwd: datasetPath })
      : originHasMain;
  if (originMainFetch.exitCode !== 0) {
    throw new Error(
      `Could not fetch ${args.nemarId}'s main from origin (${originMainFetch.stderr.trim()}). Without it the upstream-moved guard cannot run; nothing was reset or pushed.`,
    );
  }

  const originMainRev = await runCommand(
    ["git", "rev-parse", "--verify", "--quiet", "origin/main"],
    { cwd: datasetPath },
  );
  const currentBranch = await runCommand(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: datasetPath,
  });
  const recorded = await originRecordedTag(datasetPath, args.sourceId);
  const recordedTag = recorded.tag;
  const unrecorded =
    recorded.tag === null && (originMainRev.stdout.trim() || null) !== null
      ? recorded.why
      : undefined;
  if (unrecorded !== undefined) {
    console.log(
      chalk.yellow(
        `  Warning: ${args.nemarId}'s main ${unrecorded}, so the upstream-moved guard cannot check this import at ${args.importTag}. If ${args.nemarId} has released a version and its upstream has moved since, this re-import keeps the old tree while copying the new tag's data (#993).`,
      ),
    );
  }
  const decision = decideReimportBase({
    originMainSha: originMainRev.stdout.trim() || null,
    currentBranch: currentBranch.stdout.trim(),
    recordedTag,
    importTag: args.importTag,
  });

  const extra = unrecorded !== undefined ? { unrecorded } : {};
  if (decision === "none") return { kind: "none", recordedTag, ...extra };

  if (decision === "hard-reset") {
    const reset = await runCommand(["git", "reset", "--hard", "origin/main"], { cwd: datasetPath });
    if (reset.exitCode !== 0) {
      console.log(
        chalk.yellow(
          `  Warning: found origin/main for ${args.nemarId} (re-import) but could not reset onto it (${reset.stderr.trim()}). Falling back to the normal push path.`,
        ),
      );
      return { kind: "none", recordedTag, ...extra };
    }
    return { kind: "hard-reset", recordedTag, ...extra };
  }

  // decision === "moved", so recordedTag is set.
  let released: boolean;
  try {
    released = await args.released();
  } catch (err) {
    throw new Error(
      `${args.nemarId}'s main records upstream tag ${recordedTag}, this import is at ${args.importTag}, and whether ${args.nemarId} has released a version could not be read (${err instanceof Error ? err.message : String(err)}). Nothing was reset or pushed; re-run once the backend answers.`,
    );
  }
  if (released) {
    throw new ImportRefused(
      OPENNEURO_UPSTREAM_MOVED_MARKER,
      `${args.sourceId}: ${args.nemarId} has released a version and its main records upstream tag ${recordedTag}; this import is at ${args.importTag}. Moving a released mirror to a new snapshot is an upstream re-pull (ADR 0111), not a re-import. Nothing was reset, copied or pushed. To pull a newer snapshot as the next major, plan an upstream re-pull: \`nemar admin repull plan ${args.nemarId}\` (OpenNeuro's latest snapshot by default; \`--to-tag ${args.importTag}\` names this one). To repair the released version's data at the tag it mirrors: nemar admin import-openneuro ${args.sourceId} --tag ${recordedTag}`,
    );
  }
  // A retarget takes the new tag's tree whole, so origin's `.nemar/` goes with the old one, and
  // with it whatever the ledger records. Step 5b's scrub writes the new tree's own line from
  // scratch; it does not carry the old ones. So a ledger line the retarget would lose refuses it:
  // a recorded correction (ADR 0085), an upstream re-pull's `repull-scrubbed` line (ADR 0111; a
  // re-pull needs a released mirror, refused above, so dropping its record is not a retarget's to
  // decide), or an `import-scrubbed` line whose scrub changed git (a JSON value blanked, a git-held
  // recording scrubbed), because origin's history still holds those originals and only a hard
  // reset keeps the hold that says so (ADR 0089, earlierHistoryHold).
  const kept = await originLedgerLinesARetargetDrops(datasetPath);
  if (kept !== 0) {
    throw new Error(
      `${args.nemarId}'s main ${kept === "unreadable" ? `has a ${LEDGER_REPO_PATH} git could not read` : `records ${kept} line(s) in ${LEDGER_REPO_PATH} that retargeting it from upstream tag ${recordedTag} to ${args.importTag} would drop`} (a privacy correction, ADR 0085, or a scrub whose originals origin's history still holds, ADR 0089). Nothing was reset or pushed; a person decides how this dataset moves.`,
    );
  }
  if (currentBranch.stdout.trim() !== "main") {
    throw new Error(
      `${args.nemarId}'s unreleased import moved from upstream tag ${recordedTag} to ${args.importTag}, but the clone is on ${currentBranch.stdout.trim()}, not main, which cannot be retargeted safely. Nothing was reset or pushed.`,
    );
  }
  const soft = await runCommand(["git", "reset", "--soft", "origin/main"], { cwd: datasetPath });
  if (soft.exitCode !== 0) {
    throw new Error(
      `Could not move ${args.nemarId}'s unreleased import from upstream tag ${recordedTag} to ${args.importTag}: git reset --soft origin/main failed (${soft.stderr.trim()}). Nothing was pushed.`,
    );
  }
  return { kind: "retarget", recordedTag };
}

/**
 * Whether `origin/main`'s tree has `path`, from `git ls-tree`'s listing (empty for an absent path)
 * and its status, never from a localized message; `unreadable` when git could not list the tree.
 */
async function originMainHasPath(
  datasetPath: string,
  path: string,
): Promise<boolean | "unreadable"> {
  const listed = await runCommand(["git", "ls-tree", "--name-only", "origin/main", "--", path], {
    cwd: datasetPath,
  });
  if (listed.exitCode !== 0) return "unreadable";
  return listed.stdout.split("\n").some((line) => line === path);
}

/**
 * How many lines of `origin/main`'s privacy ledger a retarget would drop with consequence: any line
 * but the importer's own `import-scrubbed` one (a re-pull's `repull-scrubbed` line included),
 * an `import-scrubbed` line whose scrub blanked a
 * JSON value or scrubbed a git-held recording (origin's history holds those originals, ADR 0089),
 * and a line that is not a JSON object, because a ledger that cannot be read cannot be shown to
 * hold none. No ledger is 0; a ledger git cannot read is `unreadable`.
 */
async function originLedgerLinesARetargetDrops(
  datasetPath: string,
): Promise<number | "unreadable"> {
  const present = await originMainHasPath(datasetPath, LEDGER_REPO_PATH);
  if (present === "unreadable") return "unreadable";
  if (!present) return 0;
  const shown = await runCommand(["git", "show", `origin/main:${LEDGER_REPO_PATH}`], {
    cwd: datasetPath,
  });
  if (shown.exitCode !== 0) return "unreadable";
  let count = 0;
  for (const line of shown.stdout.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      count += 1;
      continue;
    }
    const record =
      typeof entry === "object" && entry !== null
        ? (entry as { action?: unknown; counts?: Record<string, unknown> })
        : {};
    if (record.action !== "import-scrubbed") {
      count += 1;
      continue;
    }
    const changed = (key: string) => Number(record.counts?.[key] ?? 0) > 0;
    if (changed("json_values_blanked") || changed("git_held_recordings_scrubbed")) count += 1;
  }
  return count;
}

/**
 * Whether any `SourceDatasets` entry of `desc` is the dataset's own (`isOwnSourceEntry`: its DOI
 * or URL names `sourceId`), tagged or not. `SourceDatasets` is read as the shared parser reads
 * it: an array, or a single object standing for a one-entry array.
 */
export function hasSourceEntryFor(desc: unknown, sourceId: string): boolean {
  if (!desc || typeof desc !== "object" || Array.isArray(desc)) return false;
  const sd = (desc as Record<string, unknown>).SourceDatasets;
  return (Array.isArray(sd) ? sd : [sd]).some((entry) => isOwnSourceEntry(entry, sourceId));
}

/**
 * The upstream tag `origin/main`'s `dataset_description.json` records (`sourceSnapshotOf`), or
 * why it records none: no such file, a file git could not read, one that is not JSON (an annex
 * pointer, say), no entry for the dataset, or entries for it that give no single tag. Unknown
 * never trips the guard; the caller says so.
 */
async function originRecordedTag(
  datasetPath: string,
  sourceId: string,
): Promise<{ tag: string; why?: undefined } | { tag: null; why: string }> {
  const present = await originMainHasPath(datasetPath, "dataset_description.json");
  if (present === "unreadable") {
    return { tag: null, why: "has a tree git could not list" };
  }
  if (!present) return { tag: null, why: "has no dataset_description.json" };
  const shown = await runCommand(["git", "show", "origin/main:dataset_description.json"], {
    cwd: datasetPath,
  });
  if (shown.exitCode !== 0) {
    return {
      tag: null,
      why: `has a dataset_description.json git could not read (${shown.stderr.trim()})`,
    };
  }
  let desc: unknown;
  try {
    desc = JSON.parse(shown.stdout);
  } catch {
    return { tag: null, why: "has a dataset_description.json that is not JSON" };
  }
  const snapshot = sourceSnapshotOf(desc, sourceId);
  if (snapshot.source_version !== null) return { tag: snapshot.source_version };
  return {
    tag: null,
    why: hasSourceEntryFor(desc, sourceId)
      ? `names ${sourceId} in SourceDatasets but records no single upstream tag for it (no entry carries one, they disagree, or one names another dataset too)`
      : `records no upstream tag for ${sourceId}`,
  };
}

/**
 * Map OpenNeuro dataset ID (ds######) to NEMAR ID (on######).
 */
function mapDatasetId(openneuroId: string): string {
  const match = openneuroId.match(/^ds(\d{6})$/);
  if (!match) {
    throw new Error(
      `Invalid OpenNeuro ID "${openneuroId}". Expected format: ds###### (e.g., ds007262)`,
    );
  }
  return `on${match[1]}`;
}

/**
 * True for dataset-level metadata files that NEMAR policy keeps in git and never
 * annexes. Re-exported from the shared annex policy rather than restated here:
 * this used to be an independent regex of the exclusion list, which is exactly
 * how it drifted from `annex.largefiles` (#1158).
 */
export { isNeverAnnexedMetadata };

/** A git-tracked file that NEMAR policy says belongs in the annex. */
export interface UnannexedDataFile {
  path: string;
  size: number;
}

/**
 * Files this clone carries as plain git blobs that NEMAR policy would annex.
 *
 * The import deliberately inherits upstream's annex layout -- that is what makes
 * the S3 copy a server-side copy by key -- so it also inherits upstream's idea of
 * what counts as data. OpenNeuro decides by size alone (~1 MB), which is why
 * `ds007788` splits its `_motion.tsv` recordings across both planes: 690 annexed,
 * 893 left as git blobs totalling 675 MB. Under NEMAR policy every one of those
 * is data.
 *
 * Since #1159 this is the input to an action, not just a warning:
 * `normalizeImportedTree` annexes exactly these paths and uploads their content
 * from the clone, and the manifest carries them as locally sourced keys
 * (`ImportManifestItem.origin`). A path this fails to report is a path that stays
 * in the git repository, so the scan throws rather than returning a short list.
 */
export async function findUnannexedData(datasetPath: string): Promise<UnannexedDataFile[]> {
  // Ask git-annex which files it holds rather than inferring it from the index
  // mode. A plain clone shows annexed files as symlinks, but an adjusted-unlock
  // branch (what `initDataset` leaves behind, and what some clones arrive on)
  // shows them as ordinary-looking files carrying a pointer -- so a mode check
  // silently reports every already-annexed file as un-annexed.
  const [tracked, annexed] = await Promise.all([
    listTrackedPaths(datasetPath),
    listAnnexedPaths(datasetPath),
  ]);

  const found: UnannexedDataFile[] = [];
  for (const path of tracked) {
    if (annexed.has(path)) continue;
    let size: number;
    try {
      size = statSync(join(datasetPath, path)).size;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Vanished between listing and stat: not ours to make a fuss about.
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      // Anything else (EACCES, an I/O error) means this scan cannot answer the
      // question it was asked. Since #1159 the answer decides whether a file is
      // annexed and uploaded or left in git, so a silently shorter list would
      // silently leave data behind.
      throw new Error(
        `Cannot stat tracked file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (shouldAnnex(path, size)) found.push({ path, size });
  }
  return found;
}

/**
 * Find dataset-ROOT metadata files that are git-annex symlinks.
 *
 * Most OpenNeuro datasets keep small metadata in git, but some annex even
 * `dataset_description.json` / `README` / `CHANGES` (e.g. ds007964). A plain
 * clone leaves those as dangling annex symlinks, so reading them fails and the
 * committed tree would carry annex pointers instead of JSON. We scan only the
 * root (bounded fetch; per-subject sidecars stay annexed like data) for
 * symlinks that point into `.git/annex/objects` and match the never-annex
 * policy. Returns the sorted file names. Filesystem errors degrade to [].
 */
export function findAnnexedRootMetadata(datasetPath: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(datasetPath, { withFileTypes: true });
  } catch (err) {
    // A missing dir is a precondition the caller surfaces with a clearer error
    // (readBidsDescription); any other fs failure (e.g. EACCES) should not be
    // silently turned into "no annexed metadata", so re-throw it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new Error(
      `Cannot scan ${datasetPath} for annexed metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const found: string[] = [];
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    if (!isNeverAnnexedMetadata(e.name)) continue;
    try {
      const target = readlinkSync(join(datasetPath, e.name));
      if (target.includes("annex/objects")) found.push(e.name);
    } catch {
      // Unreadable symlink — skip; a genuinely missing required file surfaces
      // later in readBidsDescription with a precise error.
    }
  }
  return found.sort();
}

/** Defined beside the scrub's marker (`import-markers.ts`); re-exported for existing callers. */
export { OPENNEURO_UPSTREAM_MARKER };

/** Defined beside the publish gate that prints it (`import-finalize-gate.ts`); re-exported for existing callers. */
export { DATA_AVAILABILITY_MARKER };

/**
 * Public CURRENT-version URL for a root file in an OpenNeuro dataset's S3 mirror.
 * git-annex records a VERSIONED url that anonymous reads can't fetch; the current
 * object by path is what OpenNeuro serves publicly. Exported for tests.
 */
export function openNeuroCurrentUrl(openneuroId: string, relPath: string): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `https://s3.amazonaws.com/openneuro.org/${openneuroId}/${encoded}`;
}

/**
 * Fetch the content of any annexed root metadata files from the public
 * OpenNeuro remote and convert them to regular git blobs, so prepare can read
 * `dataset_description.json` and downstream tree-readers (website, enrichment,
 * DataCite) get real JSON rather than an annex pointer. No-op for the common
 * case where the metadata is already committed in git. See #768.
 *
 * Mechanism (#808): fetch each file's CURRENT content by path from OpenNeuro's
 * public S3 mirror and replace the annex symlink with a real blob. We do NOT use
 * `git annex get`: git-annex resolves the key to OpenNeuro's recorded VERSIONED
 * url (`?versionId=...`), which an anonymous reader cannot fetch (it needs
 * `s3:GetObjectVersion`) even when the current object is public -- and NEMAR has
 * no signed OpenNeuro login (the s3-PUBLIC remote is `public=no`, so any signed
 * request uses NEMAR's identity, which OpenNeuro rejects). The current object by
 * path is the canonical metadata OpenNeuro serves; re-blobbing it directly also
 * sidesteps OpenNeuro annex key/content drift (no SHA verification needed).
 * Returns the un-annexed file names. No-op when nothing is annexed.
 *
 * If a file's current object is itself not anonymously readable (e.g. ds007541
 * -> 403), there is no way to fetch it without a signed login, so we throw a
 * distinctly-marked OPENNEURO_UPSTREAM_MARKER error: an OpenNeuro-side problem,
 * not a NEMAR bug, and greppable so these datasets can be listed later.
 */
export async function ensureRootMetadataUnannexed(
  datasetPath: string,
  openneuroId: string,
): Promise<string[]> {
  const annexed = findAnnexedRootMetadata(datasetPath);
  if (annexed.length === 0) return [];

  const unreachable: string[] = [];
  for (const file of annexed) {
    const url = openNeuroCurrentUrl(openneuroId, file);
    let bytes: Buffer;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        unreachable.push(`${file} (HTTP ${res.status})`);
        continue;
      }
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // A network/fetch error reaching OpenNeuro -- treat as upstream-unreachable.
      unreachable.push(
        `${file} (fetch failed: ${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    // A 200 with an empty body is a truncated/garbage response, not real
    // metadata; an empty dataset_description.json would later blow up JSON.parse
    // with a misleading "failed to parse" -- reject it here instead.
    if (bytes.length === 0) {
      unreachable.push(`${file} (HTTP 200 but empty body)`);
      continue;
    }
    // Writing to local disk: a failure here is a NEMAR-side problem (disk/perms),
    // NOT an OpenNeuro access issue, so fail loud + distinctly rather than letting
    // it masquerade as the upstream marker below.
    const dest = join(datasetPath, file);
    try {
      rmSync(dest, { force: true }); // drop the annex symlink before writing the blob
      writeFileSync(dest, bytes);
    } catch (writeErr) {
      throw new Error(
        `Failed to write fetched metadata ${file} to ${dest} (local error, not OpenNeuro): ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
    }
  }

  if (unreachable.length > 0) {
    throw new Error(
      `${OPENNEURO_UPSTREAM_MARKER} cannot fetch metadata from OpenNeuro: ${unreachable.join(", ")}. These objects are not anonymously readable and NEMAR has no signed OpenNeuro login. This is an OpenNeuro-side access problem, not a NEMAR import bug. (Any files that did fetch are left as regular files on disk, unstaged.)`,
    );
  }

  // The files were annex symlinks; replacing the worktree file + adding with
  // annex.largefiles=nothing converts them to regular git blobs in the index
  // (the repo's largefiles rules can't re-annex them).
  const add = await runCommand(["git", "-c", "annex.largefiles=nothing", "add", ...annexed], {
    cwd: datasetPath,
  });
  if (add.exitCode !== 0) {
    // The files are already regular files on disk; they are just not staged.
    // Give the exact recovery command so a transient failure (e.g. an
    // index.lock) is fixable without re-cloning.
    throw new Error(
      `Failed to stage un-annexed metadata (${annexed.join(", ")}): ${add.stderr.trim()}. The files are already regular files on disk; recover with: git -C ${datasetPath} -c annex.largefiles=nothing add ${annexed.join(" ")}`,
    );
  }
  return annexed;
}

/**
 * Read dataset_description.json from a cloned dataset directory.
 */
function readBidsDescription(datasetPath: string): Record<string, unknown> {
  const descPath = join(datasetPath, "dataset_description.json");
  if (!existsSync(descPath)) {
    throw new Error(`dataset_description.json not found at ${descPath}`);
  }
  try {
    return JSON.parse(readFileSync(descPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse dataset_description.json at ${descPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve S3 credentials from environment variables.
 * In CI, these come from GitHub secrets. Locally, from env.
 */
function resolveS3Credentials(): S3Credentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in environment for S3 operations",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

/**
 * Extract the OpenNeuro DOI from dataset_description.json, stripping the "doi:" prefix.
 */
function extractOpenNeuroDoi(bidsDesc: Record<string, unknown>): string | null {
  return typeof bidsDesc.DatasetDOI === "string" ? bidsDesc.DatasetDOI.replace(/^doi:/, "") : null;
}

/**
 * Recording-modality detection from a BIDS dataset tree on disk.
 *
 * Scans the cloned dataset for sub-* directories and inspects each
 * subject/session for BIDS datatype directories (eeg, meg, ieeg, emg, func,
 * anat, dwi, fmap, perf, beh, micr, motion, nirs, pet). Returns the sorted,
 * deduplicated set of datatypes found.
 *
 * Mirrors the server-side `detectModalitiesFromTree` (backend datacite.ts)
 * but works from the filesystem rather than a GitHub tree response. Keeping
 * the two in sync is intentional: the backend D1 columns and the CLI-seeded
 * `.nemar/metadata.json` should agree on modality without one needing to
 * import the other.
 */
const BIDS_DATATYPES = [
  "anat",
  "beh",
  "dwi",
  "eeg",
  "emg",
  "fmap",
  "func",
  "ieeg",
  "meg",
  "micr",
  "motion",
  "nirs",
  "perf",
  "pet",
];

export function detectModalitiesFromDataset(datasetPath: string): string[] {
  // Filesystem-failure paths return [] so an unreadable dataset doesn't abort
  // the entire orchestrator inside seedMetadata. The downstream backend
  // detectModalitiesFromTree pass re-derives this from the GitHub tree.
  const found = new Set<string>();
  let subjects: string[] = [];
  try {
    subjects = readdirSync(datasetPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("sub-"))
      .map((e) => e.name);
  } catch {
    return [];
  }
  for (const sub of subjects) {
    const subPath = join(datasetPath, sub);
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("ses-")) {
        // ses-*/datatype/
        let sesEntries: Dirent[] = [];
        try {
          sesEntries = readdirSync(join(subPath, e.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const se of sesEntries) {
          if (se.isDirectory() && BIDS_DATATYPES.includes(se.name)) found.add(se.name);
        }
      } else if (BIDS_DATATYPES.includes(e.name)) {
        // sub-*/datatype/ (no session level)
        found.add(e.name);
      }
    }
  }
  return [...found].sort();
}

/**
 * Coerce a BIDS dataset_description.json `Funding` array into the v2 metadata
 * `funding_references` shape. BIDS spec stores Funding as a list of free-text
 * strings; we map each entry to a sparse FundingReferenceEntry with the text
 * in funder_name. LLM enrichment (Stage 2a) can refine these later with NIH
 * grant numbers, ROR IDs, etc.
 */
export function coerceFunding(bidsDesc: Record<string, unknown>): Array<{ funder_name: string }> {
  const raw = bidsDesc.Funding;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((funder_name) => ({ funder_name: funder_name.trim() }));
}

/**
 * Seed .nemar/metadata.json with source information and IsIdenticalTo relation.
 *
 * Phase 2 of #512 expands the seeded fields beyond name/license/authors to
 * cover bids_version, funding, recording_modality, and datatypes so that
 * `data.nemar.org/<id>/metadata.json` returns useful values on freshly
 * imported OpenNeuro datasets before any LLM enrichment runs. Subject count,
 * tasks, ages, file size, and total_files come from the backend D1 metadata-
 * columns block (`computeDatasetMetadataColumns`) which is triggered by the
 * post-import reindex call at the end of importOpenNeuro().
 */
export function seedMetadata(
  datasetPath: string,
  nemarId: string,
  openneuroId: string,
  bidsDesc: Record<string, unknown>,
  openNeuroDoi: string | null,
): void {
  const nemarDir = join(datasetPath, ".nemar");
  if (!existsSync(nemarDir)) {
    mkdirSync(nemarDir, { recursive: true });
  }

  const relatedIdentifiers = openNeuroDoi
    ? [
        {
          identifier: openNeuroDoi,
          identifier_type: "DOI",
          relation_type: "IsIdenticalTo",
        },
      ]
    : [];

  const modalities = detectModalitiesFromDataset(datasetPath);
  const funding = coerceFunding(bidsDesc);

  const metadata: Record<string, unknown> = {
    version: "2.0",
    dataset_id: nemarId,
    source: "openneuro",
    source_id: openneuroId,
    title: (bidsDesc.Name as string) || nemarId,
    authors: Array.isArray(bidsDesc.Authors)
      ? Object.fromEntries((bidsDesc.Authors as string[]).map((a) => [a, {}]))
      : {},
    license: (bidsDesc.License as string) || "CC0",
    dataset_type: (bidsDesc.DatasetType as string) || "raw",
    related_identifiers: relatedIdentifiers,
    pipeline_stage: "seeded",
  };

  // Optional fields only emitted when there's actual content. Suppressing
  // empty arrays/strings keeps the seeded JSON small and makes "this field
  // came from LLM enrichment, not from seeding" diff-friendly.
  if (typeof bidsDesc.BIDSVersion === "string") metadata.bids_version = bidsDesc.BIDSVersion;
  if (modalities.length > 0) metadata.recording_modality = modalities;
  if (modalities.length > 0) metadata.datatypes = modalities;
  if (funding.length > 0) metadata.funding_references = funding;
  if (
    typeof bidsDesc.Acknowledgements === "string" &&
    bidsDesc.Acknowledgements.trim().length > 0
  ) {
    metadata.acknowledgements = bidsDesc.Acknowledgements.trim();
  }

  writeFileSync(join(nemarDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

/**
 * The `SourceDatasets` entry an import records for the upstream snapshot it mirrors (ADR 0111
 * decisions 1, 4 and 10): the snapshot's DOI, its page, and its tag, all three derived from the one
 * tag, so the entry cannot disagree with itself. The DOI is what the version-DOI mint turns into
 * `IsDerivedFrom` (decision 2), and the entry is what the upstream-moved guard reads back.
 */
export function sourceDatasetEntry(
  openneuroId: string,
  tag: string,
): { DOI: string; URL: string; Version: string } {
  const bare = normalizeUpstreamTag(tag);
  return {
    DOI: `doi:10.18112/openneuro.${openneuroId}.v${bare}`,
    URL: `https://openneuro.org/datasets/${openneuroId}/versions/${bare}`,
    Version: bare,
  };
}

/**
 * Whether `entry` is the dataset's own and names nothing else: every DOI or URL it holds as text
 * names `sourceId` by itself, as the shared parser reads it. A `null`, a non-object and an entry
 * with a field naming another dataset (or nothing the parser knows, a Zenodo DOI say) are not.
 */
function namesOnlyThisDataset(entry: unknown, sourceId: string): entry is Record<string, unknown> {
  if (!isOwnSourceEntry(entry, sourceId)) return false;
  const e = entry as Record<string, unknown>;
  return (["DOI", "URL"] as const).every((key) => {
    const value = e[key];
    return (
      typeof value !== "string" ||
      value.trim() === "" ||
      isOwnSourceEntry({ [key]: value }, sourceId)
    );
  });
}

/**
 * Record {@link sourceDatasetEntry} in the clone's `dataset_description.json`, read from disk now
 * (the scrub in Step 5b may have blanked values in it since prepare first read it). What the file
 * records is read with Phase 2's parser, `sourceSnapshotOf`, and the import writes only a record
 * that parser then reads as `tag`. NEMAR owns one entry per mirrored `ds` (ADR 0111 decision 1),
 * so:
 *   - `already-recorded`: the description already gives a tag for this dataset; left alone.
 *   - `completed`: an entry names this dataset and nothing else but records no tag (a concept DOI,
 *     a dataset page); it gains `Version` and whichever of `DOI` and `URL` it lacks, in place, so
 *     the description still has one entry for the dataset and the guard can read its tag. An
 *     entry that already carries a `Version` (one that is not a tag) or a `DOI` or `URL` that is
 *     not a string is someone else's statement: it is left alone, with a warning, and the record
 *     is appended beside it.
 *   - `appended`: otherwise, a new entry.
 *   - `unreadable`: the record would still not read as `tag`, because an entry for this dataset
 *     carries another tag or names another dataset too, or because `tag` is not one the parser
 *     reads (it reads numeric dotted tags such as `1.0.0` and `00001`); the file is left alone
 *     and a warning says so, because writing would only add to what a person has to settle.
 * Kept in git, never the annex, and written as publication writes the file, two-space JSON.
 * Entries of any shape, `null` included, are kept as they are.
 */
export async function appendSourceDatasetEntry(
  datasetPath: string,
  openneuroId: string,
  tag: string,
): Promise<"already-recorded" | "unreadable" | "completed" | "appended"> {
  const descPath = join(datasetPath, "dataset_description.json");
  const desc = readBidsDescription(datasetPath);
  if (sourceSnapshotOf(desc, openneuroId).source_version !== null) return "already-recorded";
  // A `SourceDatasets` that is not an array is kept as the first entry, as publication keeps it.
  const existing = desc.SourceDatasets;
  const sources: unknown[] = Array.isArray(existing)
    ? [...existing]
    : existing === undefined || existing === null
      ? []
      : [existing];
  const entry = sourceDatasetEntry(openneuroId, tag);
  const index = sources.findIndex((s) => namesOnlyThisDataset(s, openneuroId));
  let outcome: "completed" | "appended";
  const current = index >= 0 ? (sources[index] as Record<string, unknown>) : null;
  const present = (key: string) =>
    current !== null && current[key] !== undefined && current[key] !== null && current[key] !== "";
  const completable =
    current !== null &&
    !present("Version") &&
    (!present("DOI") || typeof current.DOI === "string") &&
    (!present("URL") || typeof current.URL === "string");
  if (current !== null && completable) {
    sources[index] = {
      ...current,
      ...(present("DOI") ? {} : { DOI: entry.DOI }),
      ...(present("URL") ? {} : { URL: entry.URL }),
      Version: entry.Version,
    };
    outcome = "completed";
  } else {
    sources.push(entry);
    outcome = "appended";
  }
  const next = { ...desc, SourceDatasets: sources };
  if (sourceSnapshotOf(next, openneuroId).source_version !== entry.Version) {
    console.log(
      chalk.yellow(
        `  Warning: recording upstream ${openneuroId} ${tag} would not make dataset_description.json read as that tag (an entry for ${openneuroId} carries another tag or names another dataset too, or ${tag} is not a tag the shared parser reads); left it as it is, so the upstream-moved guard stays inert for this dataset until a person settles it`,
      ),
    );
    return "unreadable";
  }
  if (current !== null && !completable) {
    console.log(
      chalk.yellow(
        `  Warning: left the existing SourceDatasets entry for ${openneuroId} as it is (it carries a Version that is not a tag, or a DOI or URL that is not text); recording ${tag} beside it`,
      ),
    );
  }
  writeFileSync(descPath, `${JSON.stringify(next, null, 2)}\n`);
  const add = await runCommand(
    ["git", "-c", "annex.largefiles=nothing", "add", "dataset_description.json"],
    { cwd: datasetPath },
  );
  if (add.exitCode !== 0) {
    throw new Error(`Failed to stage dataset_description.json: ${add.stderr.trim()}`);
  }
  return outcome;
}

/**
 * Outcome of {@link ensureReadmeMd} so the caller can stage the right paths.
 *
 * - `renamed`: an upstream `README` (no extension) was renamed to `README.md`
 *   so GitHub renders it. The on-disk move has been done with `renameSync`;
 *   the caller must follow up with `git add README.md README` (or
 *   equivalent) so the index records both the deletion of the old path and
 *   the addition of the new one. `from` is always `"README"`, even when the
 *   renamed file was a bare README in another case (`readme`): a legacy quirk,
 *   kept as is. On a case-sensitive filesystem the caller's `git add README`
 *   then names a path git does not track, so such an import fails at staging.
 * - `kept`: an upstream README already had a recognised renderable extension
 *   (`.md`, `.rst`, `.txt`, ...). We do not touch the file or its content.
 * - `created`: no README of any shape existed upstream, so a provenance-only
 *   stub was written to `README.md` as a last-resort fallback. The caller
 *   should `git add README.md`.
 */
export type ReadmeOutcome =
  | { kind: "renamed"; from: "README"; to: "README.md" }
  | { kind: "kept"; path: string }
  | { kind: "created"; path: "README.md" };

/**
 * Decide what to do with the imported repo's README file.
 *
 * Rule (from nemarOrg/nemar-cli#642):
 * - If the upstream ships `README` with no extension, rename it to
 *   `README.md` so GitHub renders it. Do NOT modify the content.
 *   Skipped (treated as `kept`) if a `README.md` already exists alongside
 *   — we never clobber an upstream-authored `.md`.
 * - If the upstream ships `README.md`, `README.rst`, `README.txt`, or any
 *   other suffixed variant, leave it alone. We don't second-guess the
 *   upstream author's choice; provenance is also captured in
 *   `.nemar/metadata.json` via `IsDescribedBy` / `IsIdenticalTo`, and the
 *   browser surfaces it from there.
 * - If no README exists at all, write a small provenance-only stub so the
 *   dataset page still has something to render. OpenNeuro datasets
 *   normally ship a README of some form, so this fallback should be rare.
 *
 * When the upstream contains multiple README variants (e.g., both `README`
 * and `README.md`) we prefer the already-suffixed file: leaving it untouched
 * is always safe; renaming the bare `README` over it could destroy
 * authored content.
 *
 * The rule itself is `decideReadme` in `shared/standard-edits/readme.ts`, so the
 * upstream re-pull's planner (ADR 0111) makes the same decision over a git tree;
 * this applies it to the directory. Pure on filesystem state — no git
 * operations, no network. The caller is responsible for staging the returned
 * paths.
 */
export function ensureReadmeMd(
  datasetPath: string,
  openneuroId: string,
  openNeuroDoi: string | null,
): ReadmeOutcome {
  // Regular files only, in listing order: a symlink is not a README here.
  const rootFiles = readdirSync(datasetPath, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const decision = decideReadme(rootFiles);

  if (decision.kind === "kept") return { kind: "kept", path: decision.path };

  if (decision.kind === "renamed") {
    // Bare README (any case) — rename to canonical `README.md` so GitHub
    // renders it. A README with an extension would have been kept instead,
    // so nothing is renamed over authored content.
    renameSync(join(datasetPath, decision.from), join(datasetPath, "README.md"));
    return { kind: "renamed", from: "README", to: "README.md" };
  }

  // No README upstream — write the deterministic provenance-only stub.
  writeFileSync(join(datasetPath, "README.md"), readmeProvenanceStub(openneuroId, openNeuroDoi));
  return { kind: "created", path: "README.md" };
}

/**
 * Build manifest items from the git-annex whereis map. Each annexed file maps
 * to its OpenNeuro S3 source (parsed for server-side copy) plus the raw http
 * URL (kept for the curl fallback) and the flat NEMAR destination URI. Keys
 * with no usable source at all are skipped (returned count).
 */
export function buildManifestItems(
  keyUrlMap: Map<string, string>,
  nemarId: string,
): { items: ImportManifestItem[]; skipped: number } {
  const items: ImportManifestItem[] = [];
  let skipped = 0;
  for (const [key, url] of keyUrlMap) {
    const source = parseS3Url(url);
    const httpUrl = url.startsWith("http") ? url : null;
    if (!source && !httpUrl) {
      skipped++;
      continue;
    }
    items.push({
      key,
      sourceUrl: httpUrl,
      source,
      destUri: `s3://${S3_BUCKET}/${nemarId}/objects/${key}`,
    });
  }
  return { items, skipped };
}

/** The longest an explicit tag's warning-only lookup of OpenNeuro's latest tag may take. */
export const EXPLICIT_TAG_LOOKUP_MS = 10_000;

/** Where OpenNeuro's GitHub mirror of a dataset lives. */
export function openNeuroMirrorUrl(openneuroId: string): string {
  return `https://github.com/${OPENNEURO_ORG}/${openneuroId}.git`;
}

/** A clone of OpenNeuro's mirror whose branch is at the upstream tag being imported. */
export interface PinnedClone {
  /** The tag the clone is at, and the tag this import records. */
  tag: string;
  /** The commit that tag names on the mirror. */
  commit: string;
  /**
   * OpenNeuro's latest tag as this run read it. Null only when an explicit tag was given and the
   * lookup failed: without one, a failed lookup refuses instead.
   */
  latestTag: string | null;
}

/**
 * Step 1 of prepare: clone OpenNeuro's GitHub mirror at the upstream tag being imported, never the
 * default HEAD (ADR 0111 decision 10).
 *
 * With no `tag`, the tag is OpenNeuro's latest, asked of its GraphQL API now -- the tag "the retry
 * discovers" for a retry, which also means a retry never carries a tag that has since moved.
 * Either way, a tag that cannot be resolved or that the mirror does not have yet refuses with
 * `[openneuro-mirror-lag]` before anything is created: OpenNeuro tags a snapshot before its GitHub
 * mirror receives it, and the retry engine retries the refusal until it lands (and parks it after
 * its window). Any other clone failure is an ordinary error.
 *
 * With an explicit `tag`, OpenNeuro's latest is still asked for (best effort) so a caller can warn
 * when they differ: the copy phase copies the object CURRENTLY at each upstream path (a
 * re-pull's copy pins the object version, ADR 0111 decision 8), so a recording that changed
 * between the two tags without changing size is copied with the newer bytes, and only the size
 * check catches the rest.
 *
 * `repoUrl` and `lookup` (passed to `fetchOpenNeuroLatestTag`) move the two endpoints and bound
 * the lookup's retries, for tests.
 */
export async function cloneOpenNeuroAtTag(
  openneuroId: string,
  datasetPath: string,
  options: {
    tag?: string;
    repoUrl?: string;
    lookup?: Parameters<typeof fetchOpenNeuroLatestTag>[1];
  } = {},
): Promise<PinnedClone> {
  if (options.tag !== undefined && !isOpenNeuroTag(options.tag)) {
    throw new Error(
      `Invalid upstream tag ${JSON.stringify(options.tag)}: expected an OpenNeuro snapshot tag such as 1.0.0`,
    );
  }
  const repoUrl = options.repoUrl ?? openNeuroMirrorUrl(openneuroId);
  // With an explicit tag the lookup only decides a warning, so it gets one short try: a slow or
  // absent OpenNeuro must not hold up an import that does not need its answer.
  const lookup = await fetchOpenNeuroLatestTag(
    openneuroId,
    options.tag !== undefined
      ? {
          ...options.lookup,
          attempts: 1,
          timeoutMs: Math.min(
            options.lookup?.timeoutMs ?? EXPLICIT_TAG_LOOKUP_MS,
            EXPLICIT_TAG_LOOKUP_MS,
          ),
        }
      : options.lookup,
  );
  const latestTag = lookup.tag;
  let tag: string;
  if (options.tag !== undefined) {
    tag = options.tag;
  } else if (lookup.tag !== null) {
    tag = lookup.tag;
  } else {
    throw new ImportRefused(
      OPENNEURO_MIRROR_LAG_MARKER,
      `${openneuroId}: the upstream tag to import could not be resolved (${lookup.reason}). Nothing was created; the retry engine retries it.`,
    );
  }
  const cloned = await cloneDataset(repoUrl, datasetPath, { tag });
  if (cloned.missingTag) {
    throw new ImportRefused(
      OPENNEURO_MIRROR_LAG_MARKER,
      `${openneuroId}: upstream tag ${tag} is not on ${repoUrl.replace(/\.git$/, "")} yet. Nothing was created; the retry engine retries it.`,
    );
  }
  if (!cloned.success || cloned.commit === undefined) {
    throw new Error(`Failed to clone: ${cloned.error ?? "unknown error"}`);
  }
  return { tag, commit: cloned.commit, latestTag };
}

/**
 * Print `err` as the run's last failure line and stop. The one place a refusal (`ImportRefused`)
 * from any step of prepare ends up: the onboard workflow's reporter forwards the LAST `✖` line,
 * cut at 600 characters, so the marker has to be both the start of that line and the last thing
 * to fail.
 *
 * Before printing it, when the run persists staging (the workflow's `--phase prepare` does), any
 * staging an earlier attempt left is removed. The copy and finalize jobs still run, under
 * `if: !cancelled()`, and now fail at once reading the missing manifest (`readManifestFromS3`
 * throws) instead of copying and publishing what a previous prepare described. A run without
 * staging (`--local`) has none to clear. A work directory this run created is removed too; one the
 * caller named (`--dir`) is the caller's and stays.
 *
 * Exported for the tests that run it in a child process and feed its output to the workflow's own
 * reporter.
 */
export async function refuseImport(
  err: ImportRefused,
  nemarId: string,
  options: ImportOptions,
  createdWorkDir: string | null = null,
): Promise<never> {
  if (options.persistStaging) {
    // cleanupStaging reports a failed `aws s3 rm` itself; the catch is for what it lets through,
    // a spawn failure such as no `aws` on PATH, which is said here rather than lost.
    try {
      await cleanupStaging(nemarId, S3_BUCKET, S3_REGION);
    } catch (cleanupErr) {
      console.log(
        chalk.yellow(
          `  Could not clear s3://${S3_BUCKET}/${nemarId}/staging/ (${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`,
        ),
      );
    }
  }
  removeCreatedWorkDir(createdWorkDir);
  ora().fail(err.message);
  process.exit(1);
}

/**
 * A failure of prepare that, like a refusal, ends the run before anything is reset or pushed, and
 * whose work directory is removed when this run created it. Raised by the steps the tag pin added
 * (the clone at the tag, the upstream-moved guard), and ended in one place by `prepareImport`.
 */
class PrepareStopped extends Error {}

/** Remove a work directory this run created; git-annex leaves its object directories read-only. */
function removeCreatedWorkDir(dir: string | null): void {
  if (dir === null) return;
  const makeWritable = (path: string): void => {
    let entries: Dirent[];
    try {
      chmodSync(path, 0o755);
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) makeWritable(join(path, entry.name));
    }
  };
  try {
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch (rmErr) {
    console.log(
      chalk.yellow(
        `  Could not remove the work directory ${dir} (${rmErr instanceof Error ? rmErr.message : String(rmErr)})`,
      ),
    );
  }
}

/**
 * Phase 1 (prepare): clone OpenNeuro, create the NEMAR record + repo, build the
 * key->source manifest, configure remotes (recording the nemar-s3 uuid in the
 * git-annex branch), seed metadata, and push `main`. Does NOT copy data or
 * publish — those are the copy/finalize phases. Returns the manifest (also
 * written to S3 staging when `persistStaging`, so a separate copy/finalize job
 * can read it). CI deploy is deferred to finalize (#450: Contents API needs the
 * branch to exist).
 */
export async function prepareImport(
  openneuroId: string,
  options: ImportOptions = {},
): Promise<ImportManifest> {
  const nemarId = mapDatasetId(openneuroId);
  const createdWorkDir = options.workDir
    ? null
    : mkdtempSync(join(tmpdir(), `nemar-import-${nemarId}-`));
  try {
    return await prepareImportSteps(openneuroId, nemarId, {
      ...options,
      workDir: options.workDir ?? (createdWorkDir as string),
    });
  } catch (err) {
    if (err instanceof ImportRefused) return refuseImport(err, nemarId, options, createdWorkDir);
    if (err instanceof PrepareStopped) {
      removeCreatedWorkDir(createdWorkDir);
      ora().fail(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function prepareImportSteps(
  openneuroId: string,
  nemarId: string,
  options: ImportOptions,
): Promise<ImportManifest> {
  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-import-${nemarId}-`));
  const datasetPath = join(workDir, nemarId);

  console.log(chalk.cyan(`\n[prepare] ${openneuroId} -> ${nemarId}\n`));
  console.log(chalk.dim(`Working directory: ${workDir}`));

  // Step 1: Clone OpenNeuro's mirror at the upstream tag being imported, never its default HEAD
  // (ADR 0111 decision 10). A tag that cannot be resolved, or is not on the mirror yet, refuses here
  // with the mirror-lag marker, before the dataset record exists.
  const cloneSpinner = ora("Cloning OpenNeuro dataset...").start();
  let pinned: PinnedClone;
  try {
    pinned = await cloneOpenNeuroAtTag(openneuroId, datasetPath, {
      tag: options.tag,
      lookup: options.openNeuroLookup,
    });
  } catch (err) {
    cloneSpinner.stop();
    if (err instanceof ImportRefused) throw err;
    throw new PrepareStopped(err instanceof Error ? err.message : String(err));
  }
  cloneSpinner.succeed(`Cloned ${openneuroId} at upstream tag ${pinned.tag}`);
  if (pinned.latestTag !== null && !sameUpstreamTag(pinned.latestTag, pinned.tag)) {
    console.log(
      chalk.yellow(
        `  Warning: importing ${pinned.tag}, but OpenNeuro's latest is ${pinned.latestTag}. The copy takes the object currently at each upstream path (a re-pull's copy pins the object version, ADR 0111 decision 8), so a recording that changed between the two without changing size would be copied with the newer bytes.`,
      ),
    );
  }

  // Ensure local branch is "main" (OpenNeuro repos may use "master" or other names)
  const branchOk = await ensureLocalMainBranch(datasetPath, { yes: true });
  if (!branchOk) {
    console.error(chalk.red("Cannot proceed with import: branch must be named 'main'."));
    process.exit(1);
  }

  // Some OpenNeuro datasets annex their dataset-level metadata
  // (dataset_description.json, README, CHANGES; e.g. ds007964). A plain clone
  // leaves those as dangling annex symlinks, so the read below would fail and
  // the committed tree would carry pointers instead of JSON. Fetch + un-annex
  // the root metadata first so it lands as regular git blobs. No-op for the
  // common case. See #768.
  const metaFixSpinner = ora("Normalizing dataset metadata...").start();
  try {
    const unannexed = await ensureRootMetadataUnannexed(datasetPath, openneuroId);
    if (unannexed.length > 0) {
      metaFixSpinner.succeed(
        `Un-annexed ${unannexed.length} metadata file(s): ${unannexed.join(", ")}`,
      );
    } else {
      metaFixSpinner.stop();
    }
  } catch (err) {
    metaFixSpinner.fail(
      `Failed to normalize annexed metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Step 1b: report data files upstream left in git that NEMAR policy annexes.
  // Loud on purpose: this is how ds007788 put 675 MB of motion recordings into a
  // public git repo without anyone noticing (#1158).
  //
  // A diagnostic, not the decision. It runs here, before the dataset record
  // exists, so a failure later still leaves a record of what the clone carried,
  // and it swallows its own errors for the same reason. The scan that decides runs
  // further down, after step 4c may have reset the tree, and aborts on failure.
  let unannexedDiagnosed = 0;
  try {
    const unannexed = await findUnannexedData(datasetPath);
    unannexedDiagnosed = unannexed.length;
    if (unannexed.length > 0) {
      const bytes = unannexed.reduce((sum, f) => sum + f.size, 0);
      const fate = options.skipData
        ? "will stay in the git repo (--skip-data)"
        : "will be moved into the annex and uploaded to S3";
      console.log(
        chalk.yellow(
          `  ${unannexed.length} file(s) (${(bytes / 1e6).toFixed(1)} MB) are data under NEMAR policy but plain git blobs upstream; they ${fate}.`,
        ),
      );
      for (const f of unannexed.slice(0, 5)) {
        console.log(chalk.dim(`    - ${f.path} (${(f.size / 1e6).toFixed(1)} MB)`));
      }
      if (unannexed.length > 5) {
        console.log(chalk.dim(`    ... and ${unannexed.length - 5} more`));
      }
    }
  } catch (err) {
    // Never block an import on a diagnostic; step 5b's own scan is the one that
    // decides, and it does fail the import.
    console.log(
      chalk.dim(
        `  Could not check for un-annexed data: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  // Read BIDS metadata and extract OpenNeuro DOI once for reuse
  const bidsDesc = readBidsDescription(datasetPath);
  const datasetName = (bidsDesc.Name as string) || openneuroId;
  const openNeuroDoi = extractOpenNeuroDoi(bidsDesc);
  console.log(chalk.dim(`  Dataset: ${datasetName}`));
  if (openNeuroDoi) {
    console.log(chalk.dim(`  OpenNeuro DOI: ${openNeuroDoi}`));
  }

  // Step 2: Create NEMAR dataset record + GitHub repo
  const createSpinner = ora("Creating NEMAR dataset record...").start();
  try {
    // Intentionally do not seed a placeholder description here. OpenNeuro
    // provenance is already encoded by `source: "openneuro"`, `source_id`,
    // and the `on*` dataset_id prefix; the website renders the attribution
    // from those fields. Seeding a placeholder string would overwrite the
    // LLM-enriched description on every metadata.json read (#535).
    const result = await importDataset({
      dataset_id: nemarId,
      name: datasetName,
      source: "openneuro",
      source_id: openneuroId,
    });
    createSpinner.succeed(`Created ${result.dataset_id} (${result.github_repo})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isAlreadyExistsImportError(msg)) {
      createSpinner.warn(`Dataset ${nemarId} already exists, continuing...`);
    } else {
      createSpinner.fail(`Failed to create dataset: ${msg}`);
      process.exit(1);
    }
  }

  // Step 3: Enable OpenNeuro S3 remote and build key-to-URL map
  let keyUrlMap = new Map<string, string>();
  if (!options.skipData) {
    const whereisSpinner = ora("Mapping annexed files from OpenNeuro S3...").start();
    // No unsetEnv here (unlike the metadata fetch above): enableremote only
    // records the remote config and getAnnexWhereisAll reads location metadata
    // from the local git-annex branch — neither fetches object CONTENT from S3,
    // so neither signs a GET that the CI IAM boundary would deny (#768). The
    // whole on* fleet imported through this call with CI creds present.
    const enableResult = await runCommand(["git", "annex", "enableremote", "s3-PUBLIC"], {
      cwd: datasetPath,
    });
    if (enableResult.exitCode !== 0) {
      whereisSpinner.fail(`Failed to enable s3-PUBLIC remote: ${enableResult.stderr.trim()}`);
      process.exit(1);
    }

    const whereis = await getAnnexWhereisAll(datasetPath);
    keyUrlMap = whereis.urlMap;

    if (keyUrlMap.size === 0) {
      // Empty-manifest publish guard (#828): if the dataset HAS annexed files
      // (whereis emitted records) but NONE mapped to a copyable URL, we'd
      // otherwise skip the copy and publish a dataset with no data -- the
      // signature of the 7 pre-fix phantom imports (on007720 etc.). Fail the
      // import so it quarantines for review instead. Only a dataset that
      // genuinely has zero annexed files (fileCount === 0, e.g. a metadata-only
      // dataset) is allowed through with no data copy.
      if (whereis.fileCount > 0) {
        whereisSpinner.fail(
          `${whereis.fileCount} annexed file(s) present but none had a copyable source URL`,
        );
        throw new Error(
          `Import aborted: ${nemarId} has ${whereis.fileCount} annexed file(s) but git-annex whereis mapped 0 to a copyable source (likely the content's only location is a remote NEMAR can't read). Refusing to publish a dataset with no data. Investigate the upstream annex remotes before retrying.`,
        );
      }
      whereisSpinner.warn("No annexed files found, skipping data copy");
    } else {
      whereisSpinner.succeed(`Found ${keyUrlMap.size} annexed files`);
    }
  }

  // Inherited OpenNeuro remotes (`s3-PUBLIC`, `s3-PRIVATE`) must not be
  // selected by future `nemar dataset push` calls. nemar-s3 (created by
  // configureS3Remote below) is the canonical write destination. Runs even
  // when --skip-data because the inherited remotes are present in git config
  // from the upstream clone regardless of whether we built the URL map.
  await markInheritedOpenNeuroRemotesIgnored(datasetPath, (remote, err) => {
    console.log(
      chalk.yellow(
        `  Warning: could not mark ${remote} as annex-ignore (${err}). ` +
          `Future pushes may try to upload to ${remote}; ` +
          `run 'git config remote.${remote}.annex-ignore true' manually.`,
      ),
    );
  });

  // Step 4: Reconfigure git remote to nemarDatasets
  const remoteSpinner = ora("Configuring NEMAR remote...").start();
  const removeResult = await runCommand(["git", "remote", "remove", "origin"], {
    cwd: datasetPath,
  });
  if (removeResult.exitCode !== 0 && !removeResult.stderr.includes("No such remote")) {
    remoteSpinner.fail(`Failed to remove OpenNeuro remote: ${removeResult.stderr.trim()}`);
    process.exit(1);
  }
  const nemarRepoUrl = `git@github.com:nemarDatasets/${nemarId}.git`;
  const remoteResult = await configureGitHubRemote(datasetPath, nemarRepoUrl, "origin");
  if (!remoteResult.success) {
    remoteSpinner.fail(`Failed to configure remote: ${remoteResult.error}`);
    process.exit(1);
  }
  remoteSpinner.succeed("Configured NEMAR remote");

  // Step 4b: fold in any git-annex state nemarDatasets/<id> already carries
  // from an earlier prepare attempt (#969, idempotent retry). This clone is
  // always fresh from OpenNeuro, so its local git-annex branch has no
  // knowledge of a nemar-s3 special remote a prior attempt already
  // registered and pushed. Without this merge, the initremote call below
  // (Step 5) can't see that registration and mints a SECOND, independent
  // UUID for the same "nemar-s3" name -- finalize's re-clone then sees two
  // repositories describing themselves as "nemar-s3", `git annex info`
  // reports "multiple repositories with that description", and its
  // enableremote fallback hard-errors ("Multiple remotes have that name"),
  // permanently breaking the import (every further retry makes it worse by
  // minting yet another UUID). Fetching + merging origin's git-annex branch
  // FIRST means the S3-remote setup below sees the prior registration via
  // annexRemoteExists and calls `enableremote` -- reusing the same UUID, so
  // there is nothing to diverge and the eventual push is a plain
  // fast-forward. Best-effort: a brand-new repo (first-ever import) has no
  // git-annex branch to fetch yet, so this is a silent no-op on the common
  // path.
  const originAnnex = await fetchOriginAnnexBranch(datasetPath);
  if (originAnnex.state === "failed") {
    console.log(
      chalk.yellow(
        `  Warning: could not fetch or merge ${nemarId}'s existing git-annex state (${originAnnex.error}). A retry may register the S3 remote under a new UUID; investigate before re-running finalize.`,
      ),
    );
  }

  // Step 4c (re-import only, #990, epic #989 Phase 2; #993, ADR 0111 decision 10): base this
  // fresh clone's `main` on origin's tip BEFORE Step 6 seeds a new metadata commit, if origin
  // already carries a `main`, or refuse when that would move a released mirror to a new upstream
  // tag. This only moves this worktree's `main` ref + HEAD (and, for a hard reset, the tree): the
  // git-annex branch was already merged just above (Step 4b), and the S3 remote config written to
  // .git/config plus the in-memory keyUrlMap/manifest built in Step 3 are untouched, so nothing
  // else about this prepare run changes. See baseOnOriginMain for the three outcomes.
  let base: ReimportBase;
  try {
    base = await baseOnOriginMain(datasetPath, {
      sourceId: openneuroId,
      importTag: pinned.tag,
      nemarId,
      released: () => hasReleasedVersion(nemarId),
    });
  } catch (err) {
    if (err instanceof ImportRefused) throw err;
    throw new PrepareStopped(err instanceof Error ? err.message : String(err));
  }
  const didResetMain = base.kind === "hard-reset";
  if (didResetMain) {
    console.log(
      chalk.dim("  Re-import: based main on origin/main for an idempotent metadata commit"),
    );
  } else if (base.kind === "retarget") {
    console.log(
      chalk.dim(
        `  Re-import of an unreleased dataset: moved from upstream tag ${base.recordedTag} to ${pinned.tag}, as a fast-forward of origin/main`,
      ),
    );
  }
  if (didResetMain && originAnnex.state !== "merged") {
    // The dead marks a correction left (ADR 0085, ADR 0089) live in that branch; without them only
    // the cut to the tree keeps a replaced key out of the copy. Said, not refused: the cut holds.
    console.log(
      chalk.yellow(
        "  Warning: re-import, but the dataset's git-annex branch could not be fetched; keys a correction marked dead are unknown to this run",
      ),
    );
  }

  // The authoritative scan for data upstream left in git, distinct from step 1b's
  // diagnostic in two ways that matter: it runs AFTER 4c's possible
  // `reset --hard`, so it describes the tree that will actually be committed, and
  // a failure here aborts the import instead of being swallowed. Step 1b cannot
  // do this job -- it runs before the dataset record exists, and swallowing its
  // errors is what keeps a diagnostic from blocking an import -- and if this
  // decision read that value, a scan that threw would silently leave the data in
  // git while reporting success (#1159).
  let unannexedData: UnannexedDataFile[] = [];
  // Set by step 4c above when it really reset onto origin/main. Read by step 5b:
  // on that path the tree carries keys from a PREVIOUS prepare that no upstream
  // source accounts for, and they have to be carried into the manifest. A retarget
  // is not that path: its tree is the new tag's, upstream's, as on a first import.
  const isReimportOntoExistingMain = didResetMain;
  if (!options.skipData) {
    try {
      unannexedData = await findUnannexedData(datasetPath);
    } catch (err) {
      console.error(
        chalk.red(
          `Failed to scan for un-annexed data: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      console.error(
        chalk.dim(
          "  Aborting: continuing would commit data files into the git repo and report success.",
        ),
      );
      process.exit(1);
    }
  }

  // Step 5: Configure the NEMAR S3 special remote. This records the nemar-s3
  // uuid in the git-annex branch so the finalize phase (a fresh clone, possibly
  // on another runner) enables the SAME remote and registers keys against the
  // SAME uuid. No data is copied here — that's the copy phase.
  let nemarUuid = "";
  let items: ImportManifestItem[] = [];
  let s3Creds: S3Credentials | null = null;
  // The remote is needed whenever bytes have to reach S3, which is no longer only
  // when upstream keys exist: a dataset whose only data is un-annexed (every
  // `_motion.tsv` under upstream's 1 MB bar) has an empty keyUrlMap and still
  // needs somewhere to upload (#1159).
  if (!options.skipData && (keyUrlMap.size > 0 || unannexedData.length > 0)) {
    const s3Spinner = ora("Setting up NEMAR S3 remote...").start();
    s3Creds = resolveS3Credentials();
    // #1320: an annex-uuid at the prefix that the git-annex branch (merged in Step 4b) does not
    // record as nemar-s3 makes initremote/enableremote fail on this attempt and on every retry.
    // Refused here, before the remote is touched, naming both uuids and the recovery that fits.
    const preflight = annexUuidPreflightAction(
      await preflightBucketAnnexUuid(datasetPath, {
        bucket: S3_BUCKET,
        prefix: `${nemarId}/objects`,
        region: S3_REGION,
        originAnnex: originAnnex.state,
        env: awsCredentialEnv(s3Creds),
      }),
    );
    if ("refuse" in preflight) {
      s3Spinner.stop();
      throw new ImportRefused(NEMAR_ANNEX_UUID_CONFLICT_MARKER, preflight.refuse);
    }
    if ("warn" in preflight) console.log(chalk.yellow(`  ${preflight.warn}`));
    const s3Result = await configureS3Remote(
      datasetPath,
      { name: "nemar-s3", bucket: S3_BUCKET, prefix: `${nemarId}/objects`, region: S3_REGION },
      s3Creds,
    );
    if (!s3Result.success) {
      s3Spinner.fail(`Failed to configure S3 remote: ${s3Result.error}`);
      process.exit(1);
    }
    const uuid = await getRemoteUuid(datasetPath, "nemar-s3");
    if (!uuid) {
      s3Spinner.fail("Failed to get NEMAR S3 remote UUID");
      process.exit(1);
    }
    nemarUuid = uuid;
    s3Spinner.succeed("Configured NEMAR S3 remote");

    if (keyUrlMap.size > 0) {
      const built = buildManifestItems(keyUrlMap, nemarId);
      items = built.items;
      if (built.skipped > 0) {
        console.log(chalk.yellow(`  Skipped ${built.skipped} keys (no usable source URL)`));
      }
      console.log(chalk.dim(`  Prepared ${items.length} files for server-side copy`));
    }
  }

  // Step 5b: the identifier scrub, then NEMAR's annex policy, then the copy manifest
  // cut to the tree that will be pushed (ADR 0089, then #1159 / ADR 0060).
  //
  // The scrub comes first because it is the last moment anything can be changed
  // before bytes reach the bucket: the copy phase copies upstream's bytes by key, and
  // a recording it writes is readable by key at once. A header that needs a scrub is
  // downloaded, patched, annexed under a new key and uploaded from THIS clone, its
  // old key retired; identifier-keyed JSON values are blanked. It refuses, before the
  // push, anything it cannot read, verify or move.
  //
  // The annex-policy half (ADR 0060), in its own commit:
  //   - files upstream left as git blobs are annexed and their content uploaded
  //     from THIS clone, which is why this cannot move to the copy phase: that
  //     phase is pure S3 and has no clone, and no upstream KEY exists for these
  //     files to be server-side copied by;
  //   - the inherited `annex.largefiles` attributes are replaced by NEMAR's own
  //     expression, which is then read back. A `.gitattributes` setting outranks
  //     the `git annex config` value `configureLargefiles` writes, so leaving them
  //     means every later add follows upstream's rule -- and removing them without
  //     installing ours is worse still, because git-annex with no policy set
  //     annexes everything, metadata included.
  //
  // On a re-import it also carries keys this tree already holds into the manifest,
  // so finalize verifies and registers the ones a previous prepare uploaded.
  //
  // The manifest is then cut to the keys the committed tree names, minus any the
  // git-annex branch records as dead. Built from upstream's whereis, it describes
  // upstream's tree: without the cut, a re-import (reset onto origin/main, which a
  // correction rewrote) would copy back every key the correction replaced.
  //
  // After step 4c: a re-import's `reset --hard origin/main` would otherwise throw
  // the rewrite away. Before step 6: its pathspec-less commit would otherwise
  // absorb these changes into the metadata commit.
  let privacy: ImportPrivacyRecord | undefined;
  const policySpinner = ora("Applying the identifier scrub and NEMAR annex policy...").start();
  try {
    // The step 5 gate fires on exactly this condition and exits if the remote
    // cannot be configured, so s3Creds is set here by construction whenever there
    // is data to move. Checked rather than trusted: without credentials the copy
    // would fall back to whatever git-annex cached, which for a temporary key means
    // signing with no session token and 403 on every object (#1380).
    if (unannexedData.length > 0 && !s3Creds) {
      throw new Error(
        `${unannexedData.length} file(s) need moving into the annex but no S3 credentials were resolved for ${nemarId}. Refusing to continue: the upload would be attempted with whatever credentials git-annex had cached.`,
      );
    }
    const prepared = await prepareImportedTreeForCopy({
      datasetPath,
      nemarId,
      bucket: S3_BUCKET,
      remoteName: "nemar-s3",
      keyUrlMap,
      upstreamItems: items,
      unannexedData,
      // Set by step 4c only when it really reset onto origin/main.
      reimport: isReimportOntoExistingMain,
      skipData: options.skipData ?? false,
      maxBytes: options.normalizeMaxBytes,
      reader: httpUpstreamReader(),
      upload: annexCopyUpload({ credentials: s3Creds ?? "inherit" }),
    });
    const { scrub, normalized, manifest: cut } = prepared;
    items = cut.items;
    privacy = prepared.privacy;

    // Counts and fixed words only: this log is public, and a path can be the identifier.
    const c = scrub.counts;
    const notRead = [
      c.headers_not_read_skip_data > 0
        ? `${c.headers_not_read_skip_data} not read (--skip-data)`
        : null,
      c.headers_not_read_no_source > 0
        ? `${c.headers_not_read_no_source} with no upstream source`
        : null,
      c.headers_not_read_nemar_held > 0
        ? `${c.headers_not_read_nemar_held} already NEMAR's (the screen reads them)`
        : null,
      c.headers_not_edf > 0 ? `${c.headers_not_edf} not an EDF/BDF header` : null,
    ].filter(Boolean);
    console.log(
      chalk.dim(
        `  Identifier scrub: ${c.recordings} EDF/BDF recording(s), ${c.headers_read} header(s) read, ${c.headers_scrubbed} scrubbed${notRead.length > 0 ? ` (${notRead.join(", ")})` : ""}; ${c.json_values_blanked} JSON value(s) blanked in ${c.json_files_blanked} file(s), ${c.json_files_unread + c.json_files_annexed} JSON file(s) not read; ${c.images_or_documents_held} image or document path(s) left for review`,
      ),
    );
    // ADR 0091: counts only, as above.
    console.log(
      chalk.dim(
        `  Acquisition dates set to 1 January: ${c.headers_dates_normalized} header(s), ${c.scans_values_normalized} scans table value(s) in ${c.scans_tables_normalized} table(s); ${c.headers_dates_left} header(s) read keep a date (${c.headers_dates_over_bound} over the --normalize-max-gb bound, ${c.headers_dates_failed} whose download failed, ${c.headers_dates_unproven} unproven); ${c.scans_tables_unread + c.scans_tables_annexed} scans table(s) not read`,
      ),
    );
    if (scrub.committed) {
      console.log(chalk.dim("  Committed the privacy correction and its ledger line"));
    }
    const notAnnotated = c.provenance_not_annotated + c.provenance_malformed;
    if (notAnnotated > 0) {
      console.log(
        chalk.yellow(
          `  Warning: ${notAnnotated} provenance file(s) could not be annotated; their checksums still describe the upstream files without saying so`,
        ),
      );
    }

    if (normalized.notes.length === 0) {
      policySpinner.stop();
      // Step 1b said these files would move. If the tree changed under us between
      // the two scans -- a re-import reset to an already-normalized main is the
      // ordinary way -- say so, because silence after that promise reads as done.
      if (unannexedDiagnosed > 0 && unannexedData.length === 0) {
        console.log(
          chalk.dim(
            `  The ${unannexedDiagnosed} file(s) reported above are already annexed on origin/main; nothing to move.`,
          ),
        );
      }
    } else {
      policySpinner.succeed(`Applied NEMAR annex policy: ${normalized.notes.join("; ")}`);
    }
    if (normalized.carriedOver.length > 0) {
      console.log(
        chalk.dim(
          `  Carried ${normalized.carriedOver.length} key(s) already in this tree into the manifest so finalize verifies them`,
        ),
      );
    }
    if (cut.droppedNotInTree > 0 || cut.droppedDead > 0) {
      console.log(
        chalk.dim(
          `  Copy manifest: ${cut.items.length} key(s); dropped ${cut.droppedNotInTree} the pushed tree does not name and ${cut.droppedDead} the git-annex branch records as dead`,
        ),
      );
    }
    for (const line of normalized.policy.skipped) {
      console.log(
        chalk.yellow(
          `  Warning: left a quoted .gitattributes line alone, so it still governs adds -- ${line}`,
        ),
      );
    }
  } catch (err) {
    policySpinner.fail(
      `Failed to apply the identifier scrub or NEMAR annex policy: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Step 6: Seed .nemar/metadata.json and normalize the README extension so
  // GitHub renders it (#642). Content is never modified.
  const metaSpinner = ora("Seeding metadata...").start();
  let readmeOutcome: ReadmeOutcome;
  let recordedEntry: Awaited<ReturnType<typeof appendSourceDatasetEntry>> | null = null;
  try {
    seedMetadata(datasetPath, nemarId, openneuroId, bidsDesc, openNeuroDoi);
    readmeOutcome = ensureReadmeMd(datasetPath, openneuroId, openNeuroDoi);
    // The upstream snapshot this tree is, recorded where the guard and the version-DOI mint read
    // it (ADR 0111 decision 10). Only when the tree IS the pinned tag's: a first import or a
    // retarget. After a hard reset the tree is origin's, and recording a tag there would be a guess.
    if (shouldRecordSourceEntry(base)) {
      recordedEntry = await appendSourceDatasetEntry(datasetPath, openneuroId, pinned.tag);
    }
  } catch (err) {
    metaSpinner.fail(
      `Failed to seed metadata: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  // Any metadata un-annexed above (ensureRootMetadataUnannexed) is already
  // staged as a regular blob with annex disabled and is picked up by a
  // pathspec-less `git commit` -- step 5b's, when it made one, and otherwise the
  // one below. Either way it lands in the same push. It is deliberately NOT added
  // to pathsToStage: a plain `git add` here would re-annex it per the repo's
  // largefiles policy, undoing the un-annex.
  const pathsToStage = [".nemar/metadata.json"];
  if (readmeOutcome.kind === "renamed") {
    pathsToStage.push("README", "README.md");
  } else if (readmeOutcome.kind === "created") {
    pathsToStage.push("README.md");
  }
  const addResult = await runCommand(["git", "add", ...pathsToStage], { cwd: datasetPath });
  if (addResult.exitCode !== 0) {
    metaSpinner.fail(`Failed to stage metadata: ${addResult.stderr.trim()}`);
    process.exit(1);
  }
  const commitResult = await runCommand(
    ["git", "commit", "-m", `Add NEMAR metadata (imported from OpenNeuro ${openneuroId})`],
    { cwd: datasetPath },
  );
  if (commitResult.exitCode !== 0 && !commitResult.stdout.includes("nothing to commit")) {
    metaSpinner.fail(`Failed to commit metadata: ${commitResult.stderr.trim()}`);
    process.exit(1);
  }
  const readmeNote =
    readmeOutcome.kind === "renamed"
      ? "renamed README -> README.md"
      : readmeOutcome.kind === "kept"
        ? `kept upstream ${readmeOutcome.path}`
        : "wrote provenance stub README.md (no upstream README)";
  metaSpinner.succeed(
    `Seeded .nemar/metadata.json (${readmeNote}${recordedEntry === "appended" || recordedEntry === "completed" ? `; recorded upstream ${openneuroId} ${pinned.tag} in SourceDatasets` : ""})`,
  );

  // Step 7: Push main + the git-annex branch (now carrying the nemar-s3 remote
  // config). Data blobs are copied in the next phase; finalize re-pushes the
  // git-annex branch once keys are registered. A `warning` (main landed but the
  // git-annex branch did not) is a hard fail — the dataset would be uncloneable.
  const pushSpinner = ora("Pushing to nemarDatasets...").start();
  const pushResult = await pushToGitHub(datasetPath, "origin");
  if (!pushResult.success) {
    pushSpinner.fail(`Failed to push: ${pushResult.error}`);
    process.exit(1);
  }
  if (pushResult.warning) {
    pushSpinner.fail(
      `Pushed main but git-annex branch failed: ${pushResult.warning}. Aborting — published dataset would be uncloneable. Investigate the git-annex push failure and re-run.`,
    );
    process.exit(1);
  }
  pushSpinner.succeed("Pushed to nemarDatasets");

  const manifest: ImportManifest = { openneuroId, nemarId, nemarUuid, items, privacy };
  if (options.persistStaging) {
    await writeManifestToS3(manifest, S3_BUCKET, S3_REGION);
    console.log(chalk.dim(`  Wrote import manifest to s3://${S3_BUCKET}/${nemarId}/staging/`));
  }
  const localItems = items.filter((it) => isLocallyUploaded(it)).length;
  const toCopy = items.length - localItems;
  console.log(
    chalk.green(
      `[prepare] done: ${nemarId} (${toCopy} files to copy${localItems > 0 ? `, ${localItems} already uploaded` : ""})`,
    ),
  );
  return manifest;
}

/**
 * Phase 2 (copy, sharded): server-side copy this shard's slice of the manifest
 * from OpenNeuro S3 to NEMAR S3, resuming past objects already present at the
 * destination. Pure S3 — no git, no filesystem state. Re-running a shard is
 * safe and resumes (already-copied objects are skipped). Exits non-zero on any
 * copy failure with a resumable message.
 */
export async function copyShard(
  openneuroId: string,
  shard: { index: number; count: number },
  options: ImportOptions = {},
  inMemoryManifest?: ImportManifest,
): Promise<void> {
  const nemarId = mapDatasetId(openneuroId);
  const manifest = inMemoryManifest ?? (await readManifestFromS3(nemarId, S3_BUCKET, S3_REGION));
  const tag = `copy ${shard.index}/${shard.count}`;

  if (options.skipData || manifest.items.length === 0) {
    console.log(chalk.dim(`[${tag}] no data to copy`));
    return;
  }

  // Keys prepare uploaded from the clone have no upstream source to copy from --
  // their bytes are already at the destination (#1159). They stay in the manifest
  // so finalize verifies and registers them; only this phase skips them.
  const { shardItems, localSkipped } = selectShardCopyItems(manifest.items, shard);
  if (localSkipped > 0) {
    console.log(chalk.dim(`[${tag}] ${localSkipped} key(s) already uploaded by prepare`));
  }

  if (shardItems.length === 0) {
    console.log(chalk.dim(`[${tag}] empty shard`));
    return;
  }

  // Resume: skip objects already present at the destination, but only when
  // present at their declared size -- a 0-byte leftover from a prior failed
  // run must be re-copied, not mistaken for done (#967).
  const existing = await listExistingObjects(S3_BUCKET, `${nemarId}/objects/`, S3_REGION);
  const { toCopy, skipped } = filterAlreadyCopied(
    shardItems,
    existing,
    expectedSizesFromItems(shardItems),
  );
  if (skipped.length > 0) {
    console.log(chalk.dim(`[${tag}] skipped ${skipped.length} already present`));
  }
  if (toCopy.length === 0) {
    console.log(chalk.green(`[${tag}] nothing to copy (all ${skipped.length} present)`));
    return;
  }

  const spinner = ora(`[${tag}] copying ${toCopy.length} files...`).start();
  const result = await batchServerSideCopy(toCopy, S3_REGION, COPY_CONCURRENCY, (done, total) => {
    spinner.text = `[${tag}] ${done}/${total}`;
  });

  if (result.fellBack > 0) {
    console.log(
      chalk.yellow(`  ${result.fellBack} objects needed the curl fallback (check S3 permissions)`),
    );
  }
  if (result.failed.length > 0) {
    spinner.fail(`[${tag}] ${result.failed.length} of ${toCopy.length} files failed`);
    for (const f of result.failed.slice(0, 5)) {
      console.error(chalk.red(`    ${f.key}: ${f.error}`));
    }
    if (result.failed.length > 5) {
      console.error(chalk.red(`    ... and ${result.failed.length - 5} more`));
    }
    console.error(chalk.red("Re-run this shard to resume (already-copied objects are skipped)."));
    process.exit(1);
  }
  spinner.succeed(`[${tag}] copied ${result.copied}, skipped ${skipped.length}`);
}

/**
 * Phase 3 (finalize): verify every manifest object landed at the destination
 * (re-listing catches a missing/cancelled copy shard), re-clone, register the
 * copied keys with git-annex against the nemar-s3 remote, push the git-annex
 * branch, deploy CI, and publish. Reuses the publish/approve/reindex tail.
 */
export async function finalizeImport(
  openneuroId: string,
  options: ImportOptions = {},
  inMemoryManifest?: ImportManifest,
): Promise<PublicationDecision> {
  // When this run started, so the wait for the identifier screen can be cut to what
  // the job's timeout leaves (`screenWaitBudget`).
  const finalizeStartedAt = Date.now();
  const nemarId = mapDatasetId(openneuroId);
  const manifest = inMemoryManifest ?? (await readManifestFromS3(nemarId, S3_BUCKET, S3_REGION));
  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-finalize-${nemarId}-`));
  // Distinct from prepare's clone dir so a shared --dir doesn't collide.
  const datasetPath = join(workDir, `${nemarId}-finalize`);

  console.log(chalk.cyan(`\n[finalize] ${openneuroId} -> ${nemarId}\n`));

  const hasData = !options.skipData && manifest.items.length > 0;
  // Empty-manifest publish guard (#828, defense-in-depth for the prepare guard):
  // an empty manifest with !skipData means no data was copied. Before publishing,
  // confirm the dataset GENUINELY has no annexed data -- a dataset WITH annexed
  // files but an empty manifest is the phantom-publish signature (on007720 etc.,
  // published empty pre-fix). Catches a manual finalize re-run against a stale
  // pre-guard empty manifest. A truly metadata-only dataset (0 annexed files)
  // passes through and publishes with no data, as intended.
  if (!options.skipData && manifest.items.length === 0) {
    const guardSpinner = ora("Confirming dataset has no annexed data...").start();
    const cloneResult = await cloneDataset(
      `git@github.com:nemarDatasets/${nemarId}.git`,
      datasetPath,
      { useGitHubToken: true },
    );
    if (!cloneResult.success) {
      guardSpinner.fail(
        `Failed to clone ${nemarId} for the empty-manifest check: ${cloneResult.error}`,
      );
      process.exit(1);
    }
    const { fileCount } = await getAnnexWhereisAll(datasetPath);
    if (fileCount > 0) {
      guardSpinner.fail(`${fileCount} annexed file(s) but the import manifest is empty`);
      throw new Error(
        `Finalize aborted: ${nemarId} has ${fileCount} annexed file(s) but the import manifest is empty (no data was copied). Refusing to publish a dataset with no data. Re-run prepare + copy; if the data is genuinely unfetchable this should quarantine, not publish.`,
      );
    }
    guardSpinner.succeed("Confirmed metadata-only dataset (no annexed data)");
  }
  if (hasData) {
    // Verify all data landed at its correct size by re-listing the destination
    // against the manifest. This is the publish gate: a key that merely exists
    // but is 0 bytes or truncated (a corrupt leftover from a failed copy, #967)
    // counts as missing, same as a key that's absent entirely.
    const verifySpinner = ora("Verifying copied data...").start();
    const existing = await listExistingObjects(S3_BUCKET, `${nemarId}/objects/`, S3_REGION);
    const verified = verifyManifestObjects(manifest.items, existing);
    if (verified.message !== null) {
      verifySpinner.fail(verified.message);
      process.exit(1);
    }
    verifySpinner.succeed(`Verified ${manifest.items.length} objects present`);

    // Re-clone, enable nemar-s3 (reuses the prepare uuid), register keys, push.
    // useGitHubToken: this runs on a CI runner that has GH_TOKEN (HTTPS App
    // token) but no SSH key, so a raw `git@github.com:` clone of the private
    // NEMAR repo fails with "Permission denied (publickey)" (#768).
    const cloneSpinner = ora("Re-cloning for git-annex finalize...").start();
    const cloneResult = await cloneDataset(
      `git@github.com:nemarDatasets/${nemarId}.git`,
      datasetPath,
      { useGitHubToken: true },
    );
    if (!cloneResult.success) {
      cloneSpinner.fail(`Failed to clone ${nemarId}: ${cloneResult.error}`);
      process.exit(1);
    }
    cloneSpinner.succeed(`Cloned ${nemarId}`);

    const s3Creds = resolveS3Credentials();
    const s3Result = await configureS3Remote(
      datasetPath,
      { name: "nemar-s3", bucket: S3_BUCKET, prefix: `${nemarId}/objects`, region: S3_REGION },
      s3Creds,
    );
    if (!s3Result.success) {
      console.error(chalk.red(`Failed to enable S3 remote: ${s3Result.error}`));
      process.exit(1);
    }
    const nemarUuid = await getRemoteUuid(datasetPath, "nemar-s3");
    if (!nemarUuid) {
      console.error(chalk.red("Failed to get NEMAR S3 remote UUID on finalize clone"));
      process.exit(1);
    }
    // The finalize re-clone must resolve the SAME nemar-s3 uuid prepare created
    // (enableremote reuses it from the pushed git-annex branch). A mismatch would
    // register keys against a remote clones can't discover -> blobs unfindable.
    if (manifest.nemarUuid && nemarUuid !== manifest.nemarUuid) {
      console.error(
        chalk.red(
          `nemar-s3 uuid mismatch (prepare=${manifest.nemarUuid} finalize=${nemarUuid}). Aborting to avoid registering keys against the wrong remote.`,
        ),
      );
      process.exit(1);
    }

    // The gate is the TREE against the bucket, not the manifest against the
    // bucket (#1396; `treeGate` says why). `existing` is the listing from the
    // verify step a few lines up; nothing writes to the prefix in between, and
    // re-listing a 60,000-object dataset twice per finalize is not free.
    const treeGateSpinner = ora("Checking every annexed key has an object...").start();
    const treeKeys = new Set((await listAnnexedKeys(datasetPath)).values());
    const gate = treeGate(treeKeys, existing, {
      bucket: S3_BUCKET,
      datasetId: nemarId,
      manifestItems: manifest.items.length,
    });
    if (!gate.ok) {
      treeGateSpinner.fail(gate.message);
      process.exit(1);
    }
    treeGateSpinner.succeed(gate.message);

    // The TREE's keys, the same set the gate just proved, not `manifest.items`.
    // A failure is fatal: the data would be present but uncloneable. Finalize is
    // idempotent, so a re-run retries (re-clone, re-register, re-push).
    const registerSpinner = ora("Registering files in git-annex...").start();
    const registered = await registerTreeKeys(datasetPath, [...treeKeys], nemarUuid);
    if (!registered.ok) {
      registerSpinner.fail(registered.message);
      process.exit(1);
    }
    registerSpinner.succeed(registered.message);

    const pushSpinner = ora("Pushing git-annex branch...").start();
    const pushResult = await pushToGitHub(datasetPath, "origin");
    if (!pushResult.success) {
      pushSpinner.fail(`Failed to push git-annex branch: ${pushResult.error}`);
      process.exit(1);
    }
    if (pushResult.warning) {
      pushSpinner.fail(
        `git-annex branch push failed: ${pushResult.warning}. Aborting — published dataset would be uncloneable.`,
      );
      process.exit(1);
    }
    pushSpinner.succeed("Pushed git-annex branch");
  }

  // Step 8: Deploy CI workflows now that remote main exists.
  // addCi failure is fatal: --trust-upstream bypasses validation lookup,
  // not the deployment of validation/enrichment/archive workflows. Missing
  // workflows mean no future safety net (reviewer note for #451).
  let ciDeployedSuccessfully = false;
  const ciSpinner = ora("Deploying CI workflows...").start();
  try {
    await addCi(nemarId);
    ciSpinner.succeed(
      "CI workflows deployed (BIDS validation, LLM enrichment, archive generation)",
    );
    ciDeployedSuccessfully = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ciSpinner.fail(`CI deployment failed: ${msg}`);
    console.log(
      chalk.dim(
        `  After fixing the deploy failure, run 'nemar admin ci add ${nemarId}' and 'nemar admin repo publish request/approve ${nemarId}' to resume.`,
      ),
    );
  }

  // Step 9: Bounded wait for the BIDS validation workflow run to register
  // (replaces unconditional skip_ci_check=true; see #431). Only run when CI
  // actually deployed; the decision matrix is centralised in decideSkipCiCheck
  // so the post-mortem reading is legible.
  let poll: PollOutcome | null = null;
  if (ciDeployedSuccessfully) {
    const waitSpinner = ora("Waiting for BIDS validation run to register...").start();
    poll = await waitForBidsValidationRun(nemarId, waitSpinner);
    if (poll.kind === "found") {
      waitSpinner.succeed("BIDS validation run registered; deferring to ci_check at approval");
    } else if (poll.kind === "timeout") {
      const note = options.trustUpstream
        ? "trusting upstream OpenNeuro validation (--trust-upstream)"
        : "no --trust-upstream — aborting";
      waitSpinner.warn(`BIDS validation run did not register within 120s; ${note}`);
    } else {
      const msg = poll.lastError instanceof Error ? poll.lastError.message : String(poll.lastError);
      waitSpinner.fail(`All BIDS validation polls failed (last error: ${msg})`);
    }
  }
  const decision = decideSkipCiCheck({
    ciDeployed: ciDeployedSuccessfully,
    poll,
    trustUpstream: options.trustUpstream ?? false,
  });
  if (decision.abortReason) {
    console.error(chalk.red(decision.abortReason));
    process.exit(1);
  }
  const skipCiCheck = decision.skipCiCheck;

  // Step 10: Request and approve publication.
  //
  // Idempotency (#985, epic #967 recover): finalize also runs as the last
  // leg of the recover workflow, which re-runs prepare -> copy -> finalize
  // against a dataset that is ALREADY published, to repair data the first
  // import silently under-delivered (the #967 bug the per-key size check
  // above just re-verified). That re-copy must not attempt to
  // (re-)request/approve publication -- doing so is at best a guaranteed
  // 409 and at worst re-runs approve's DOI-mint/S3-lock side effects
  // against a dataset that must stay untouched. Decide via a live read of
  // the dataset's visibility (decidePublicationRequestAction), not by
  // waiting to catch the request's own 409 -- a positive check that also
  // skips the approve call the 409-catch alone could not prevent.
  let currentVisibility: "public" | "private" | null = null;
  try {
    currentVisibility = (await getDataset(nemarId)).visibility;
  } catch {
    // Status read failed (e.g. transient network blip) -- fall through to
    // the normal request/approve flow below, which has its own fatal-error
    // handling if the backend is genuinely unreachable. The exact-message
    // catch in the request loop below remains a fallback safety net for
    // this specific case.
  }
  // Mutable: the primary signal is the live status read above, but a 409
  // caught below (status read failed, or the dataset was published by
  // something else between the read and the request) sets this too, so
  // every gate downstream (approve, spinner text) sees the same answer.
  let alreadyPublished =
    currentVisibility !== null &&
    decidePublicationRequestAction(currentVisibility) === "skip-already-published";

  const PUBLICATION_REQUEST_MAX_ATTEMPTS = 5;
  const PUBLICATION_REQUEST_WAIT_MS = 5 * 60_000;
  const pubSpinner = ora("Requesting publication...").start();
  let publicationRequested = false;
  // Set when the dataset already has an open request: an earlier run left it for an admin.
  let requestInPlace: "requested" | "approving" | null = null;
  if (alreadyPublished) {
    publicationRequested = true;
    pubSpinner.succeed(
      `${nemarId} is already published; skipping publish/request (data re-copy only)`,
    );
  }
  for (
    let attempt = 1;
    !alreadyPublished && attempt <= PUBLICATION_REQUEST_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      await requestPublication(nemarId);
      publicationRequested = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Exact match against routes/datasets/publication.ts's 409 body --
      // the fallback safety net for when the live status read above
      // couldn't run (see the try/catch); a genuinely already-published
      // dataset is success here, not a fatal error (#985).
      if (msg === "Dataset is already published") {
        alreadyPublished = true;
        publicationRequested = true;
        pubSpinner.succeed(
          `${nemarId} is already published; skipping publish/request (data re-copy only)`,
        );
        break;
      }
      // An open request is the normal end state of an import an earlier run left for an admin
      // (ADR 0089), so a re-run of finalize meets it. Its screen is waited on like a fresh one's;
      // an approval already in progress is not started a second time.
      if (
        err instanceof ApiError &&
        err.statusCode === 409 &&
        msg === "A publication request already exists"
      ) {
        const status = (err.rawBody as { status?: unknown } | undefined)?.status;
        requestInPlace = status === "approving" ? "approving" : "requested";
        publicationRequested = true;
        pubSpinner.succeed(`${nemarId} already has an open publication request; using it`);
        break;
      }
      const isValidationInProgress = msg.includes("BIDS validation is currently running");
      if (!isValidationInProgress) {
        pubSpinner.fail(`Failed to request publication: ${msg}`);
        process.exit(1);
      }
      if (attempt === PUBLICATION_REQUEST_MAX_ATTEMPTS) {
        pubSpinner.fail(
          `BIDS validation still in progress after ${PUBLICATION_REQUEST_MAX_ATTEMPTS} attempts (~${Math.round((PUBLICATION_REQUEST_MAX_ATTEMPTS * PUBLICATION_REQUEST_WAIT_MS) / 60000)}min). Re-run 'nemar admin repo publish request/approve ${nemarId}' once validation completes.`,
        );
        process.exit(1);
      }
      pubSpinner.text = `Waiting for BIDS validation to complete... (attempt ${attempt}/${PUBLICATION_REQUEST_MAX_ATTEMPTS}, next retry in 5min)`;
      await new Promise((r) => setTimeout(r, PUBLICATION_REQUEST_WAIT_MS));
    }
  }
  if (publicationRequested && !alreadyPublished && requestInPlace === null) {
    pubSpinner.succeed("Publication requested");
  }

  // Step 11: wait for the identifier screen's verdict and approve only a clear one
  // (ADR 0089). Requesting publication started the screen (ADR 0086); approving in
  // the same breath is what the gate refuses. A verdict that is not clear leaves the
  // request open for an admin, whom Phase 4 mails, and is NOT an import failure: the
  // data is copied and registered, so this run still completes.
  const approveSpinner = ora("Waiting for the identifier screen...").start();
  let publication: PublicationDecision;
  if (alreadyPublished) {
    publication = { outcome: "already-published" };
  } else if (requestInPlace === "approving") {
    publication = { outcome: "unchecked", reason: "approval-in-progress" };
  } else {
    try {
      publication = await awaitScreenAndApprove({
        nemarId,
        skipCiCheck,
        privacy: manifest.privacy,
        waitMs: options.screenWaitMs ?? screenWaitBudget(Date.now() - finalizeStartedAt),
        pollMs: options.screenPollMs,
        onProgress: (text) => {
          approveSpinner.text = text;
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      approveSpinner.fail(`Failed to approve publication: ${msg}`);
      process.exit(1);
    }
  }
  const outcomeLine = describePublicationDecision(nemarId, publication);
  if (publication.outcome === "published" || publication.outcome === "already-published") {
    approveSpinner.succeed(outcomeLine);
  } else {
    approveSpinner.warn(outcomeLine);
  }

  // Phase 2 of #512: trigger LLM enrichment + D1 metadata-column population
  // for the freshly imported dataset. Without this, on* datasets stay with
  // NULL modalities/subject_count/tasks/etc in the catalog (the existing
  // post-version-DOI sync skips on* because it can't push to nemar.org).
  //
  // Failure here is logged but non-fatal: the import itself is complete (and the
  // dataset published, when the screen was clear). Operators can re-run with
  // `nemar admin reindex <id>` afterward.
  const reindexSpinner = ora("Refreshing metadata + LLM enrichment...").start();
  try {
    const result = await reindexDataset(nemarId);
    const enrichmentOk = result.enrichment?.status === "ok";
    const colsOk = result.sync?.metadata_columns_written === true;
    if (enrichmentOk && colsOk) {
      reindexSpinner.succeed("Refreshed enrichment + metadata columns");
    } else {
      const parts: string[] = [];
      if (!enrichmentOk) parts.push(`enrichment ${result.enrichment?.status ?? "missing"}`);
      if (!colsOk) parts.push("metadata columns not written");
      reindexSpinner.warn(
        `Partial reindex: ${parts.join(", ")} (run 'nemar admin reindex ${nemarId}' to retry)`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reindexSpinner.warn(
      `Reindex failed (non-fatal): ${msg}. Run 'nemar admin reindex ${nemarId}' to retry.`,
    );
  }

  if (options.persistStaging) {
    await cleanupStaging(nemarId, S3_BUCKET, S3_REGION);
  }

  // Summary
  console.log(
    chalk.green(
      `\nImport complete: ${openneuroId} -> ${nemarId} (publication: ${publication.outcome})`,
    ),
  );
  console.log(chalk.dim(`  GitHub: https://github.com/nemarDatasets/${nemarId}`));
  console.log(chalk.dim(`  Working dir: ${datasetPath}`));
  return publication;
}

/**
 * Single-process import driver — unchanged external behavior. Runs prepare ->
 * copy (one shard = all keys) -> finalize in one process, passing the manifest
 * in memory (no S3 staging round-trip). This is the `--local` path and the
 * shape the test/dev workflow exercises.
 */
export async function importOpenNeuro(
  openneuroId: string,
  options: ImportOptions = {},
): Promise<void> {
  const manifest = await prepareImport(openneuroId, options);
  if (!options.skipData) {
    await copyShard(openneuroId, { index: 0, count: 1 }, options, manifest);
  }
  await finalizeImport(openneuroId, options, manifest);
}
