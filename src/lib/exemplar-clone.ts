/**
 * Exemplar dataset cloning (epic #923, Phase 5).
 *
 * Clones a PUBLIC nm/on NEMAR dataset into a staging "exemplar" copy
 * (xx099900-xx099999) so the full publish/DOI/reindex pipeline can be
 * exercised end-to-end on the staging environment without touching a real
 * dataset. Modeled closely on `lib/import-openneuro.ts`'s
 * prepare/copy/finalize split, but simplified: the source is a public
 * NEMAR-owned S3/GitHub repo (not OpenNeuro), and this tool is always a
 * single in-process run (`cloneExemplar`) rather than the sharded
 * multi-job CI shape import-openneuro.ts also supports.
 *
 * `--mirror <ds>` makes a mirror rehearsal fixture (ADR 0111's Phase 6 amendment): an `xx` copy of
 * an `on` mirror whose row says `source = 'openneuro'` and `source_id = <ds>`, so an upstream
 * re-pull can be rehearsed on staging, where only an `xx` dataset is re-pulled. The copy's own
 * dev-bucket remote then takes the name `nemar-s3`, the one remote a re-pull reads, and the
 * inherited production remote is renamed out of its way (`nemar-s3-source`, ignored), so the
 * re-pull reads and writes the exemplar's own prefix and never the source's. Every other refusal
 * stands: the route is staging-only, an anonymous exemplar is refused, and an `xx` publishes only
 * through the exemplar exception.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { addCi, createExemplar, reindexDataset } from "./api/admin.js";
import { ApiError } from "./api/errors.js";
import { approvePublication, requestPublication } from "./api/publish.js";
import { cloneDataset, pushToGitHub } from "./git-annex/clone-push.js";
import { configureGitHubRemote } from "./git-annex/github.js";
import { runCommand } from "./git-annex/run-command.js";
import {
  type S3Credentials,
  configureS3Remote,
  markInheritedOpenNeuroRemotesIgnored,
  uuidsNamedInRemoteLog,
} from "./git-annex/s3-remote.js";
import { batchSetKeysPresent, getRemoteUuid } from "./git-annex/transfer.js";
import { waitForBidsValidationRun } from "./import-openneuro.js";
import {
  type CopyItem,
  batchServerSideCopy,
  expectedSizesFromItems,
  filterAlreadyCopied,
  isKeyPresentAtDeclaredSize,
  listExistingObjects,
} from "./s3-server-copy.js";

const NEMAR_DATASETS_ORG = "nemarDatasets";
const SOURCE_BUCKET = "nemar";
const DEST_BUCKET = "nemar-dev";
const S3_REGION = "us-east-2";
/** Matches import-openneuro.ts's COPY_CONCURRENCY: server-side copies stay on
 *  AWS's backbone, so the runner is not the byte bottleneck. */
const COPY_CONCURRENCY = 16;

/** Exemplar id band, mirrors backend `EXEMPLAR_ID_RE` (routes/admin/exemplar.ts). */
export const EXEMPLAR_ID_RE = /^xx0999\d{2}$/;
/** Source dataset id an exemplar is cloned from, mirrors backend `SOURCE_ID_RE`. */
export const EXEMPLAR_SOURCE_ID_RE = /^(nm|on)\d{6}$/;

/**
 * Why `mirror` is not the `ds` the `on` source mirrors (`on004362` mirrors `ds004362`), or null
 * when it is; the route refuses the same pair (`exemplar_mirror_mismatch`).
 */
export function mirrorProblem(sourceId: string, mirror: string): string | null {
  if (!/^ds\d{6}$/.test(mirror))
    return `--mirror takes an OpenNeuro dataset id (ds004362), not "${mirror}"`;
  if (sourceId !== `on${mirror.slice(2)}`) {
    return `--mirror ${mirror} is cloned from on${mirror.slice(2)}, the NEMAR mirror of it, not ${sourceId}`;
  }
  return null;
}

/** The remote a re-pull reads, which a mirror fixture's dev-bucket remote is named. */
const REPULL_REMOTE = "nemar-s3";
/** An ordinary exemplar's dev-bucket remote. */
const DEV_REMOTE = "nemar-s3-dev";
/** What the inherited production remote of a mirror fixture is renamed to, out of the way. */
export const INHERITED_REMOTE = "nemar-s3-source";

/**
 * Rename a special remote the clone inherited, in the clone's git config (when the clone enabled
 * it) and in the git-annex branch's `remote.log` (every uuid that names it), so a new remote can
 * take its name. Refuses when, afterwards, anything still names it: a new remote of that name would
 * otherwise enable the old one, the production one, with the new remote's parameters.
 */
export async function renameInheritedRemote(
  datasetPath: string,
  from: string,
  to: string,
): Promise<void> {
  const cwd = datasetPath;
  const configured = await runCommand(["git", "config", "--get", `remote.${from}.annex-uuid`], {
    cwd,
  });
  if (configured.exitCode === 0 && configured.stdout.trim()) {
    const r = await runCommand(
      ["git", "config", "--rename-section", `remote.${from}`, `remote.${to}`],
      { cwd },
    );
    if (r.exitCode !== 0)
      throw new Error(`Failed to rename the git remote ${from}: ${r.stderr.trim()}`);
  }
  // The git-annex branch's `remote.log`: none on the branch is no special remote, and a branch
  // that cannot be read is an error, never "nothing names it".
  const remoteLog = async () => {
    const listed = await runCommand(["git", "ls-tree", "git-annex", "--", "remote.log"], { cwd });
    if (listed.exitCode !== 0) {
      throw new Error(
        `The git-annex branch could not be read (run git annex init in the clone first): ${listed.stderr.trim()}`,
      );
    }
    if (listed.stdout.trim() === "") return "";
    const r = await runCommand(["git", "cat-file", "blob", "git-annex:remote.log"], { cwd });
    if (r.exitCode !== 0) {
      throw new Error(`The git-annex branch's remote.log could not be read: ${r.stderr.trim()}`);
    }
    return r.stdout;
  };
  for (const uuid of uuidsNamedInRemoteLog(await remoteLog(), from)) {
    const r = await runCommand(["git", "annex", "renameremote", uuid, to], { cwd });
    if (r.exitCode !== 0) {
      throw new Error(`Failed to rename the special remote ${from} (${uuid}): ${r.stderr.trim()}`);
    }
  }
  const left = await runCommand(["git", "config", "--get", `remote.${from}.annex-uuid`], { cwd });
  if (uuidsNamedInRemoteLog(await remoteLog(), from).length > 0 || left.stdout.trim() !== "") {
    throw new Error(`${from} is still named after the rename; nothing was configured.`);
  }
}

/**
 * Steps 5 and 6 of prepare. The clone inherited the source's PRODUCTION `nemar-s3` remote
 * (bucket=nemar): it is marked annex-ignore, so it is never selected as an upload target, and the
 * dev-bucket remote is configured by `configure` (the dev bucket's S3 remote; a test passes a
 * directory remote). An ordinary exemplar's is `nemar-s3-dev`; a mirror fixture's takes the name
 * `nemar-s3`, the one remote a re-pull reads, so the inherited one is first renamed out of its way
 * (`nemar-s3-source`) and that is the one ignored. Returns the dev remote's name and uuid.
 */
export async function prepareDevRemote(
  datasetPath: string,
  opts: {
    mirror: boolean;
    configure: (name: string) => Promise<{ success: boolean; error?: string }>;
    onWarn?: (remote: string, error: string) => void;
  },
): Promise<{ devRemote: string; uuid: string }> {
  const devRemote = opts.mirror ? REPULL_REMOTE : DEV_REMOTE;
  if (opts.mirror) await renameInheritedRemote(datasetPath, REPULL_REMOTE, INHERITED_REMOTE);
  await markInheritedOpenNeuroRemotesIgnored(datasetPath, opts.onWarn, [
    opts.mirror ? INHERITED_REMOTE : REPULL_REMOTE,
  ]);
  const configured = await opts.configure(devRemote);
  if (!configured.success) throw new Error(`Failed to configure ${devRemote}: ${configured.error}`);
  const uuid = await getRemoteUuid(datasetPath, devRemote);
  if (!uuid) throw new Error(`Failed to get ${devRemote} remote UUID`);
  return { devRemote, uuid };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Scrub a cloned dataset's `dataset_description.json` before it becomes an
 * exemplar: prefix the Name with `[TEST COPY]` so it's never mistaken for the
 * real dataset, and drop `DatasetDOI` (the exemplar mints its own sandbox DOI
 * and must never carry the source's real, resolvable DOI). Pure: the caller
 * is responsible for reading/writing the file.
 *
 * It does NOT blind `Authors`, and briefly did (#1423, withdrawn in #1433).
 * NEMAR deliberately does not scrub a depositor's own files: it tells them to
 * blind `dataset_description.json` themselves, and the publication request
 * refuses an anonymous release whose Authors still names anybody. The blind was
 * added because the fleet's anonymous exemplar had no depositor to follow that
 * instruction, but that fixture was in the wrong band to begin with, and its
 * replacement is uploaded from a tree an operator blinds by hand, exactly as a
 * real anonymous depositor does. Re-adding a blind here would make the fixture
 * stop exercising the instruction it exists to demonstrate.
 */
export function scrubDatasetDescription(desc: Record<string, unknown>): Record<string, unknown> {
  const originalName = typeof desc.Name === "string" ? desc.Name : "";
  const { DatasetDOI: _omit, ...rest } = desc;
  return { ...rest, Name: `[TEST COPY] ${originalName}` };
}

/**
 * Rewrite a full bucket-relative S3 key from the source dataset's prefix to
 * the exemplar's prefix, e.g. `nm000132/objects/9f/3a/SHA256E-s1--ab.edf` ->
 * `xx099900/objects/9f/3a/SHA256E-s1--ab.edf`. Works for any sub-prefix
 * (objects/, zarr/, archives/, version/) since only the leading `<id>/`
 * segment changes. Throws if `srcKey` doesn't actually start with
 * `<sourceId>/` (a caller bug, not a runtime data issue).
 */
export function rewriteObjectKeyPrefix(srcKey: string, sourceId: string, xxId: string): string {
  const prefix = `${sourceId}/`;
  if (!srcKey.startsWith(prefix)) {
    throw new Error(`Key "${srcKey}" does not start with expected source prefix "${prefix}"`);
  }
  return `${xxId}/${srcKey.slice(prefix.length)}`;
}

/**
 * Same rewrite as {@link rewriteObjectKeyPrefix}, plus the archive file name
 * itself (#1491): since the rename, an archive's file name embeds its own
 * dataset id (`<id>/archives/<id>_v<version>.zip`), which the generic
 * leading-segment rewrite above does not touch. Left alone, a copied
 * exemplar archive would keep the SOURCE dataset's id baked into its file
 * name (`xx099902/archives/nm000104_v1.0.0.zip`), which is neither the new
 * key `resolveArchiveKey` looks for at the destination
 * (`xx099902/archives/xx099902_v1.0.0.zip`) nor the pre-#1491 fallback (no
 * dataset id in the name at all) -- readers would find nothing.
 *
 * Only rewrites a name that actually starts with `<sourceId>_`; a
 * pre-#1491 source archive (bare `v<version>.zip`) has no such prefix and
 * passes through unchanged, matching {@link rewriteObjectKeyPrefix}'s
 * existing behavior for it.
 */
export function rewriteArchiveKeyPrefix(srcKey: string, sourceId: string, xxId: string): string {
  const rewritten = rewriteObjectKeyPrefix(srcKey, sourceId, xxId);
  const lastSlash = rewritten.lastIndexOf("/");
  const dir = rewritten.slice(0, lastSlash + 1);
  const filename = rewritten.slice(lastSlash + 1);
  const sourceFilePrefix = `${sourceId}_`;
  if (!filename.startsWith(sourceFilePrefix)) return rewritten;
  return `${dir}${xxId}_${filename.slice(sourceFilePrefix.length)}`;
}

/** One curated fleet entry (`scripts/exemplar-fleet.json`). */
export interface ExemplarFleetEntry {
  xx_id: string;
  source_id: string;
  modality: string;
  note?: string;
}

/**
 * Validate a parsed `exemplar-fleet.json` payload. Pure so the fleet file's
 * shape can be unit-tested without touching disk.
 */
export function parseExemplarFleet(raw: unknown): ExemplarFleetEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("Exemplar fleet file must be a JSON array");
  }
  const entries = raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Fleet entry ${i} is not an object`);
    }
    const { xx_id, source_id, modality, note } = entry as Record<string, unknown>;
    if (typeof xx_id !== "string" || !EXEMPLAR_ID_RE.test(xx_id)) {
      throw new Error(`Fleet entry ${i}: xx_id "${xx_id}" must match xx099900-xx099999`);
    }
    if (typeof source_id !== "string" || !EXEMPLAR_SOURCE_ID_RE.test(source_id)) {
      throw new Error(
        `Fleet entry ${i} (${xx_id}): source_id "${source_id}" must be an nm/on dataset id`,
      );
    }
    if (typeof modality !== "string" || modality.length === 0) {
      throw new Error(`Fleet entry ${i} (${xx_id}): modality is required`);
    }
    if (note !== undefined && typeof note !== "string") {
      throw new Error(`Fleet entry ${i} (${xx_id}): note must be a string when present`);
    }
    // REFUSED, not validated (#1433, ADR 0068). The fleet carried a standing
    // anonymous deposit at xx099907 until this epic. That placement was the
    // mistake: `xx` publishes only through the exemplar exception, while an
    // anonymous deposit's defining event is an anonymous RELEASE, so the one
    // path the fixture needed was the one path the band refuses. The standing
    // anonymous deposit now lives at a reserved `nm` id, where that release is
    // an ordinary publication. Refusing here rather than silently ignoring the
    // key means re-adding one fails loudly at load instead of quietly
    // recreating a fixture that cannot do its job.
    const { anonymous } = entry as Record<string, unknown>;
    if (anonymous !== undefined) {
      throw new Error(
        `Fleet entry ${i} (${xx_id}): the exemplar fleet no longer declares an anonymous deposit. The standing anonymous deposit lives at a reserved nm id (ADR 0068, epic #1430); an xx exemplar cannot take the anonymous release that gives it its shape.`,
      );
    }
    return {
      xx_id,
      source_id,
      modality,
      ...(note !== undefined ? { note } : {}),
    };
  });
  return entries;
}

/** Read and validate `scripts/exemplar-fleet.json` (or an equivalent path). */
export function loadExemplarFleet(path: string): ExemplarFleetEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read/parse exemplar fleet file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseExemplarFleet(raw);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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

function readDatasetDescription(datasetPath: string): Record<string, unknown> {
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

/** Best-effort: drop local version tags inherited from the source clone so
 *  they can never leak into the exemplar's own release history. */
async function stripGitTags(datasetPath: string): Promise<void> {
  const { stdout, exitCode } = await runCommand(["git", "tag", "-l"], { cwd: datasetPath });
  if (exitCode !== 0) return;
  const tags = stdout.trim().split("\n").filter(Boolean);
  if (tags.length === 0) return;
  const del = await runCommand(["git", "tag", "-d", ...tags], { cwd: datasetPath });
  if (del.exitCode !== 0) {
    console.warn(chalk.yellow(`  Warning: failed to strip local tags: ${del.stderr.trim()}`));
  }
}

/** Build the CopyItem list for one dataset sub-prefix (objects/, zarr/, ...),
 *  listing what's already at the source and rewriting each key to its
 *  exemplar destination. Returns [] when the sub-prefix has no objects. */
/**
 * Marker file that git-annex's S3 special remote writes at its fileprefix root
 * to identify the remote. It sits alongside the content blobs under `objects/`
 * but is NOT annexed content, so it must be excluded from both halves of the
 * clone: copying the SOURCE remote's marker would overwrite the identity of the
 * freshly-initremoted `nemar-s3-dev`, and handing it to `batchSetKeysPresent`
 * fails because it is not a valid git-annex key.
 */
const ANNEX_REMOTE_MARKER = "annex-uuid";

/**
 * True when a key listed under a remote's prefix is actual annexed content
 * rather than remote bookkeeping. Exported so the exclusion is unit-testable
 * without reaching S3.
 */
export function isAnnexContentKey(relKey: string): boolean {
  return relKey !== ANNEX_REMOTE_MARKER;
}

async function buildExemplarCopyItems(
  sourceId: string,
  xxId: string,
  subPrefix: string,
  // #1491: archives/ needs the file-name-aware rewrite (see
  // rewriteArchiveKeyPrefix's docstring); every other sub-prefix's relative
  // keys don't embed the source dataset id, so the plain rewrite is correct
  // for them.
  rewriteKey: (srcKey: string, sourceId: string, xxId: string) => string = rewriteObjectKeyPrefix,
): Promise<CopyItem[]> {
  const sourcePrefix = `${sourceId}/${subPrefix}`;
  const existing = await listExistingObjects(SOURCE_BUCKET, sourcePrefix, S3_REGION);
  return [...existing.keys()].filter(isAnnexContentKey).map((relKey) => {
    const srcKey = `${sourcePrefix}${relKey}`;
    const destKey = rewriteKey(srcKey, sourceId, xxId);
    return {
      key: relKey,
      source: { bucket: SOURCE_BUCKET, key: srcKey, region: S3_REGION },
      httpUrl: null,
      destUri: `s3://${DEST_BUCKET}/${destKey}`,
    };
  });
}

/**
 * Decide which of a sub-prefix's items still need copying (copySubPrefix's
 * resume gate): an item is skipped only when it's already present at the
 * destination AT ITS DECLARED SIZE -- a 0-byte or truncated leftover from a
 * prior failed run must be re-copied, not mistaken for done (same #967 bug,
 * #982). Exported and pure so the decision is unit-testable without
 * S3/git-annex.
 */
export function planSubPrefixCopy(
  items: CopyItem[],
  destExisting: Map<string, number>,
): { toCopy: CopyItem[]; skipped: string[] } {
  return filterAlreadyCopied(items, destExisting, expectedSizesFromItems(items));
}

/** Copy one sub-prefix's items (resuming past whatever's already at the
 *  destination) and report progress. Throws on any copy failure (resumable
 *  re-run picks up where it left off, matching import-openneuro.ts's
 *  copyShard convention) — callers decide whether that aborts the whole run
 *  or, for `--all`, just this fleet entry. */
async function copySubPrefix(
  sourceId: string,
  xxId: string,
  subPrefix: string,
  label: string,
  // #1491: pass rewriteArchiveKeyPrefix for "archives/" so the copied file
  // carries the DESTINATION dataset's id, not the source's. Note this does
  // NOT change what `filterAlreadyCopied` compares below -- it still checks
  // the SOURCE-relative key against the destination listing, so a renamed
  // archive that is already present at the destination is not recognized as
  // "already copied" and gets re-copied (idempotent, just not skipped) on a
  // re-run. Harmless for this best-effort, single-file-per-dataset prefix.
  rewriteKey: (srcKey: string, sourceId: string, xxId: string) => string = rewriteObjectKeyPrefix,
): Promise<string[]> {
  const items = await buildExemplarCopyItems(sourceId, xxId, subPrefix, rewriteKey);
  if (items.length === 0) {
    console.log(chalk.dim(`  [${label}] nothing to copy`));
    return [];
  }

  const destExisting = await listExistingObjects(DEST_BUCKET, `${xxId}/${subPrefix}`, S3_REGION);
  const { toCopy, skipped } = planSubPrefixCopy(items, destExisting);
  if (toCopy.length === 0) {
    console.log(chalk.green(`  [${label}] nothing to copy (all ${skipped.length} present)`));
    return items.map((i) => i.key);
  }

  const spinner = ora(`[${label}] copying ${toCopy.length} files...`).start();
  const result = await batchServerSideCopy(toCopy, S3_REGION, COPY_CONCURRENCY, (done, total) => {
    spinner.text = `[${label}] ${done}/${total}`;
  });
  if (result.failed.length > 0) {
    spinner.fail(`[${label}] ${result.failed.length} of ${toCopy.length} files failed`);
    for (const f of result.failed.slice(0, 5)) {
      console.error(chalk.red(`    ${f.key}: ${f.error}`));
    }
    console.error(chalk.red(`Re-run to resume [${label}] (already-copied objects are skipped).`));
    throw new Error(
      `[${label}] ${result.failed.length} of ${toCopy.length} files failed to copy: ${result.failed
        .slice(0, 5)
        .map((f) => `${f.key}: ${f.error}`)
        .join("; ")}`,
    );
  }
  spinner.succeed(`[${label}] copied ${result.copied}, skipped ${skipped.length}`);
  return items.map((i) => i.key);
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export interface PrepareExemplarResult {
  datasetPath: string;
  xxId: string;
  sourceId: string;
  /**
   * uuid of the freshly configured dev-bucket remote, `devRemote` (which a mirror fixture names
   * `nemar-s3`; the field keeps the name it had before mirror fixtures).
   */
  nemarS3DevUuid: string;
  /**
   * The dev-bucket remote's name: `nemar-s3-dev`, or `nemar-s3` for a mirror fixture (`--mirror`),
   * whose re-pull reads that one remote. Absent is `nemar-s3-dev`.
   */
  devRemote?: string;
}

export interface CopyExemplarResult {
  /** Relative object keys (under `<xxId>/objects/`) copied or already
   *  present at the destination — these are what get registered with
   *  git-annex in finalize. Derived-artifact keys (zarr/archives/records)
   *  are copied but not registered (they aren't git-annex content). */
  keys: string[];
}

interface ExemplarPrepareOptions {
  workDir?: string;
  name?: string;
  description?: string;
  /** A mirror rehearsal fixture of this OpenNeuro `ds` (see the module comment). */
  mirror?: string;
}

/**
 * Phase 1 (prepare): clone the public source dataset, scrub its
 * dataset_description.json, create the exemplar record + repo, disable the
 * inherited production S3 remote, configure a fresh dev-bucket remote, and
 * push. Does NOT copy data — that's the copy phase.
 */
export async function prepareExemplar(
  xxId: string,
  sourceId: string,
  options: ExemplarPrepareOptions = {},
): Promise<PrepareExemplarResult> {
  if (!EXEMPLAR_ID_RE.test(xxId)) {
    throw new Error(`Invalid exemplar id "${xxId}". Expected xx099900-xx099999.`);
  }
  if (!EXEMPLAR_SOURCE_ID_RE.test(sourceId)) {
    throw new Error(`Invalid source id "${sourceId}". Expected an nm/on dataset id.`);
  }
  const mirror = options.mirror;
  const problem = mirror === undefined ? null : mirrorProblem(sourceId, mirror);
  if (problem) throw new Error(problem);

  const workDir = options.workDir || mkdtempSync(join(tmpdir(), `nemar-exemplar-${xxId}-`));
  const datasetPath = join(workDir, xxId);

  console.log(chalk.cyan(`\n[prepare] ${sourceId} -> ${xxId}\n`));
  console.log(chalk.dim(`Working directory: ${workDir}`));

  // Step 1: Clone the public source dataset (anonymous HTTPS, no auth needed).
  const cloneSpinner = ora(`Cloning ${sourceId}...`).start();
  const sourceUrl = `https://github.com/${NEMAR_DATASETS_ORG}/${sourceId}.git`;
  const cloneResult = await cloneDataset(sourceUrl, datasetPath);
  if (!cloneResult.success) {
    const msg = `Failed to clone: ${cloneResult.error}`;
    cloneSpinner.fail(msg);
    throw new Error(msg);
  }
  cloneSpinner.succeed(`Cloned ${sourceId}`);

  // Step 2: Strip inherited version tags (best-effort, non-fatal).
  await stripGitTags(datasetPath);

  // Step 3: Scrub dataset_description.json (Name -> "[TEST COPY] ...",
  // DatasetDOI removed) and commit. `.nemar/metadata.json` is left as-is.
  const scrubSpinner = ora("Scrubbing dataset_description.json...").start();
  const originalDesc = readDatasetDescription(datasetPath);
  const scrubbedDesc = scrubDatasetDescription(originalDesc);
  writeFileSync(
    join(datasetPath, "dataset_description.json"),
    `${JSON.stringify(scrubbedDesc, null, 2)}\n`,
  );
  const addResult = await runCommand(["git", "add", "dataset_description.json"], {
    cwd: datasetPath,
  });
  if (addResult.exitCode !== 0) {
    const msg = `Failed to stage scrubbed metadata: ${addResult.stderr.trim()}`;
    scrubSpinner.fail(msg);
    throw new Error(msg);
  }
  const commitResult = await runCommand(
    [
      "git",
      "commit",
      "-m",
      `Scrub dataset_description.json for exemplar clone (source: ${sourceId})`,
    ],
    { cwd: datasetPath },
  );
  if (commitResult.exitCode !== 0 && !commitResult.stdout.includes("nothing to commit")) {
    const msg = `Failed to commit scrubbed metadata: ${commitResult.stderr.trim()}`;
    scrubSpinner.fail(msg);
    throw new Error(msg);
  }
  scrubSpinner.succeed("Scrubbed dataset_description.json");

  // Step 4: Create the exemplar record + private nemarDatasets/<xx> repo.
  const displayName =
    options.name || (typeof scrubbedDesc.Name === "string" ? scrubbedDesc.Name : undefined);
  const createSpinner = ora("Creating exemplar dataset record...").start();
  try {
    const result = await createExemplar({
      dataset_id: xxId,
      source_id: sourceId,
      name: displayName,
      description: options.description,
      ...(mirror !== undefined ? { mirror } : {}),
    });
    createSpinner.succeed(`Created ${result.dataset_id} (${result.github_repo})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // The backend returns 409 for two conditions that read alike but mean very
    // different things. "Dataset <id> already exists" means the D1 row is there
    // and resuming is safe. "GitHub repo ... already exists" is only reachable
    // when the D1 row is ABSENT (the D1 check runs first), i.e. a previous run
    // died between repo-create and D1-insert, or its rollback failed. Resuming
    // on that one limps forward against a dataset that does not exist and only
    // surfaces much later as a non-fatal reindex 404, so fail fast and name the
    // actual problem. Keyed off ApiError.statusCode, not a substring of the
    // message ("409" never appears in the message text).
    const isConflict = error instanceof ApiError && error.statusCode === 409;
    if (isConflict && msg.includes("Dataset")) {
      createSpinner.warn(`Exemplar ${xxId} already exists, continuing...`);
    } else if (isConflict) {
      const orphan = `GitHub repo for ${xxId} exists but has no dataset record — a previous run failed between repo creation and the D1 insert. Delete the orphan with 'nemar admin delete-dataset ${xxId}' (or remove the repo manually) and re-run. Original: ${msg}`;
      createSpinner.fail(orphan);
      throw new Error(orphan);
    } else {
      const failMsg = `Failed to create exemplar: ${msg}`;
      createSpinner.fail(failMsg);
      throw new Error(failMsg);
    }
  }

  // Steps 5 and 6: the inherited production remote out of the way, and the dev-bucket remote.
  const s3Spinner = ora("Configuring the dev-bucket remote...").start();
  let dev: { devRemote: string; uuid: string };
  try {
    dev = await prepareDevRemote(datasetPath, {
      mirror: mirror !== undefined,
      onWarn: (remote, err) => {
        console.log(
          chalk.yellow(
            `  Warning: could not mark ${remote} as annex-ignore (${err}). ` +
              `Run 'git config remote.${remote}.annex-ignore true' manually.`,
          ),
        );
      },
      configure: (name) =>
        configureS3Remote(
          datasetPath,
          { name, bucket: DEST_BUCKET, prefix: `${xxId}/objects`, region: S3_REGION },
          resolveS3Credentials(),
        ),
    });
  } catch (err) {
    s3Spinner.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
  const { devRemote, uuid: nemarS3DevUuid } = dev;
  s3Spinner.succeed(`Configured ${devRemote} remote`);

  // Step 7: Reconfigure origin to the new exemplar repo and push.
  const remoteSpinner = ora("Configuring NEMAR remote...").start();
  const removeResult = await runCommand(["git", "remote", "remove", "origin"], {
    cwd: datasetPath,
  });
  if (removeResult.exitCode !== 0 && !removeResult.stderr.includes("No such remote")) {
    const msg = `Failed to remove source remote: ${removeResult.stderr.trim()}`;
    remoteSpinner.fail(msg);
    throw new Error(msg);
  }
  const exemplarRepoUrl = `git@github.com:${NEMAR_DATASETS_ORG}/${xxId}.git`;
  const remoteResult = await configureGitHubRemote(datasetPath, exemplarRepoUrl, "origin");
  if (!remoteResult.success) {
    const msg = `Failed to configure remote: ${remoteResult.error}`;
    remoteSpinner.fail(msg);
    throw new Error(msg);
  }
  remoteSpinner.succeed("Configured NEMAR remote");

  const pushSpinner = ora(`Pushing to ${NEMAR_DATASETS_ORG}...`).start();
  const pushResult = await pushToGitHub(datasetPath, "origin");
  if (!pushResult.success) {
    const msg = `Failed to push: ${pushResult.error}`;
    pushSpinner.fail(msg);
    throw new Error(msg);
  }
  if (pushResult.warning) {
    const msg = `Pushed main but git-annex branch failed: ${pushResult.warning}. Aborting — the exemplar would be uncloneable.`;
    pushSpinner.fail(msg);
    throw new Error(msg);
  }
  pushSpinner.succeed(`Pushed to ${NEMAR_DATASETS_ORG}`);

  console.log(chalk.green(`[prepare] done: ${xxId}`));
  return { datasetPath, xxId, sourceId, nemarS3DevUuid, devRemote };
}

/**
 * Phase 2 (copy): server-side copy the source's annexed objects (and,
 * optionally, derived artifacts) from the production bucket to the dev
 * bucket, resuming past objects already present at the destination.
 */
export async function copyExemplarData(
  prep: PrepareExemplarResult,
  options: { includeDerived?: boolean } = {},
): Promise<CopyExemplarResult> {
  const { xxId, sourceId } = prep;
  console.log(chalk.cyan(`\n[copy] ${sourceId} -> ${xxId}\n`));

  const keys = await copySubPrefix(sourceId, xxId, "objects/", "objects");

  if (options.includeDerived) {
    // Best-effort: zarr/archives mirror the objects/ layout one-for-one.
    // records.json lives under version/ (`version/v<X>-records.json`); only
    // that file, not the version manifests alongside it, is copied.
    await copySubPrefix(sourceId, xxId, "zarr/", "zarr");
    await copySubPrefix(sourceId, xxId, "archives/", "archives", rewriteArchiveKeyPrefix);
    const versionItems = await buildExemplarCopyItems(sourceId, xxId, "version/");
    const recordsItems = versionItems.filter((i) => i.key.endsWith("-records.json"));
    if (recordsItems.length > 0) {
      const spinner = ora(`[records.json] copying ${recordsItems.length} file(s)...`).start();
      const result = await batchServerSideCopy(recordsItems, S3_REGION, COPY_CONCURRENCY);
      if (result.failed.length > 0) {
        // Throw, matching copySubPrefix and the zarr/archives copies above.
        // Previously this only painted a failed spinner and returned normally,
        // so a records.json that never copied was reported as a fully
        // successful clone and did not count toward `--all`'s exit code — the
        // EEGDash-facing artifact would then 404 with nothing to point at it.
        spinner.fail(`[records.json] ${result.failed.length} of ${recordsItems.length} failed`);
        throw new Error(
          `[records.json] ${result.failed.length} of ${recordsItems.length} file(s) failed to copy: ${result.failed
            .slice(0, 5)
            .map((f) => `${f.key}: ${f.error}`)
            .join("; ")}`,
        );
      }
      spinner.succeed(`[records.json] copied ${result.copied}`);
    }
  }

  return { keys };
}

interface ExemplarFinalizeOptions {
  publish?: boolean;
}

/**
 * Decide which copied keys are actually missing at the destination
 * (finalizeExemplar's verify gate): a key present but not at its declared
 * size counts as missing, same as an absent key -- a corrupt leftover from a
 * failed copy must not be mistaken for done (#967, #982). Exported and pure.
 */
export function findMissingCopiedKeys(keys: string[], existing: Map<string, number>): string[] {
  return keys.filter((k) => !isKeyPresentAtDeclaredSize(k, existing));
}

/**
 * Phase 3 (finalize): verify the copied objects landed, register them with
 * git-annex against nemar-s3-dev, push the git-annex branch, deploy CI,
 * refresh metadata, and (if requested) request + approve publication with a
 * sandbox DOI.
 */
export async function finalizeExemplar(
  prep: PrepareExemplarResult,
  copyResult: CopyExemplarResult,
  options: ExemplarFinalizeOptions = {},
): Promise<void> {
  const { datasetPath, xxId, sourceId, nemarS3DevUuid } = prep;
  console.log(chalk.cyan(`\n[finalize] ${sourceId} -> ${xxId}\n`));

  if (copyResult.keys.length > 0) {
    const verifySpinner = ora("Verifying copied data...").start();
    const existing = await listExistingObjects(DEST_BUCKET, `${xxId}/objects/`, S3_REGION);
    const missing = findMissingCopiedKeys(copyResult.keys, existing);
    if (missing.length > 0) {
      const msg = `${missing.length} of ${copyResult.keys.length} objects missing at s3://${DEST_BUCKET}/${xxId}/objects/. Re-run the copy phase before finalizing.`;
      verifySpinner.fail(msg);
      throw new Error(msg);
    }
    verifySpinner.succeed(`Verified ${copyResult.keys.length} objects present`);

    // Defensive uuid-match guard: confirm the local nemar-s3-dev remote still
    // resolves to the uuid prepare recorded before registering keys against
    // it (mirrors import-openneuro.ts's finalize re-clone guard, adapted for
    // the fact this tool never re-clones — datasetPath is shared in-memory).
    const currentUuid = await getRemoteUuid(datasetPath, prep.devRemote ?? DEV_REMOTE);
    if (currentUuid !== nemarS3DevUuid) {
      const msg = `${prep.devRemote ?? DEV_REMOTE} uuid drifted (prepare=${nemarS3DevUuid} now=${currentUuid}). Aborting before registering keys against the wrong remote.`;
      console.error(chalk.red(msg));
      throw new Error(msg);
    }

    const registerSpinner = ora("Registering files in git-annex...").start();
    const regResult = await batchSetKeysPresent(datasetPath, copyResult.keys, nemarS3DevUuid);
    if (regResult.failed > 0) {
      const msg = `${regResult.failed} of ${copyResult.keys.length} git-annex key registrations are not in the location log (e.g. ${regResult.missing.slice(0, 3).join(", ")}). Re-run finalize to retry.`;
      registerSpinner.fail(msg);
      throw new Error(msg);
    }
    registerSpinner.succeed(`Registered ${regResult.success} files in git-annex`);

    const pushSpinner = ora("Pushing git-annex branch...").start();
    const pushResult = await pushToGitHub(datasetPath, "origin");
    if (!pushResult.success) {
      const msg = `Failed to push git-annex branch: ${pushResult.error}`;
      pushSpinner.fail(msg);
      throw new Error(msg);
    }
    if (pushResult.warning) {
      const msg = `git-annex branch push failed: ${pushResult.warning}`;
      pushSpinner.fail(msg);
      throw new Error(msg);
    }
    pushSpinner.succeed("Pushed git-annex branch");
  }

  let ciDeployed = false;
  const ciSpinner = ora("Deploying CI workflows...").start();
  try {
    await addCi(xxId);
    ciSpinner.succeed(
      "CI workflows deployed (BIDS validation, LLM enrichment, archive generation)",
    );
    ciDeployed = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ciSpinner.fail(`CI deployment failed: ${msg}`);
    console.log(chalk.dim(`  After fixing the deploy failure, run 'nemar admin ci add ${xxId}'.`));
  }

  if (ciDeployed) {
    const waitSpinner = ora("Waiting for BIDS validation run to register...").start();
    const poll = await waitForBidsValidationRun(xxId, waitSpinner);
    if (poll.kind === "found") {
      waitSpinner.succeed("BIDS validation run registered");
    } else if (poll.kind === "timeout") {
      waitSpinner.warn(
        "BIDS validation run did not register within 120s; continuing (ci_check retries at approval).",
      );
    } else {
      const msg = poll.lastError instanceof Error ? poll.lastError.message : String(poll.lastError);
      waitSpinner.fail(`BIDS validation polls failed: ${msg}`);
    }
  }

  // reindexOk gates publication below: a failed/partial reindex means
  // .nemar/metadata.json may still carry the SOURCE dataset's real identity
  // (title, pipeline_stage) rather than the scrubbed exemplar one, since
  // reindex is what regenerates that file post-clone. Publishing on top of
  // that would expose a public "exemplar" describing the real dataset.
  let reindexOk = false;
  const reindexSpinner = ora("Refreshing metadata + LLM enrichment...").start();
  try {
    const result = await reindexDataset(xxId);
    const enrichmentOk = result.enrichment?.status === "ok";
    const colsOk = result.sync?.metadata_columns_written === true;
    reindexOk = enrichmentOk && colsOk;
    if (reindexOk) {
      reindexSpinner.succeed("Refreshed enrichment + metadata columns");
    } else {
      reindexSpinner.warn(`Partial reindex (run 'nemar admin reindex ${xxId}' to retry)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reindexSpinner.warn(`Reindex failed (non-fatal): ${msg}`);
  }

  if (!options.publish) {
    console.log(
      chalk.green(
        `\nExemplar clone complete: ${sourceId} -> ${xxId} (not published; re-run with --publish).`,
      ),
    );
    return;
  }

  if (!reindexOk) {
    throw new Error(
      `Refusing to publish ${xxId}: metadata reindex did not fully succeed, so .nemar/metadata.json may still carry the source dataset's real identity. Re-run 'nemar admin reindex ${xxId}' until it succeeds, then 'nemar admin repo publish request/approve ${xxId}' to publish manually.`,
    );
  }

  // Request + approve publication with a sandbox DOI. Mirrors
  // import-openneuro.ts's finalizeImport tail: BIDS validation may still be
  // running right after CI deploy, so retry the request on that specific
  // 422, and retry approve across fresh Worker invocations on transient
  // failures (approvePublication also retries internally; this outer loop
  // covers cases that outlast its budget).
  const REQUEST_MAX_ATTEMPTS = 5;
  const REQUEST_WAIT_MS = 5 * 60_000;
  const pubSpinner = ora("Requesting publication...").start();
  let requested = false;
  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt++) {
    try {
      await requestPublication(xxId);
      requested = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("BIDS validation is currently running")) {
        const failMsg = `Failed to request publication: ${msg}`;
        pubSpinner.fail(failMsg);
        throw new Error(failMsg);
      }
      if (attempt === REQUEST_MAX_ATTEMPTS) {
        const failMsg = `BIDS validation still running after ${REQUEST_MAX_ATTEMPTS} attempts. Re-run 'nemar admin repo publish request/approve ${xxId}' once validation completes.`;
        pubSpinner.fail(failMsg);
        throw new Error(failMsg);
      }
      pubSpinner.text = `Waiting for BIDS validation to complete... (attempt ${attempt}/${REQUEST_MAX_ATTEMPTS})`;
      await new Promise((r) => setTimeout(r, REQUEST_WAIT_MS));
    }
  }
  if (requested) pubSpinner.succeed("Publication requested");

  const approveSpinner = ora("Approving publication (sandbox DOI)...").start();
  const APPROVE_MAX_ATTEMPTS = 10;
  let approved = false;
  for (let attempt = 1; attempt <= APPROVE_MAX_ATTEMPTS; attempt++) {
    try {
      await approvePublication(xxId, attempt > 1, /* sandbox */ true);
      approved = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < APPROVE_MAX_ATTEMPTS) {
        approveSpinner.text = `Approving publication... (attempt ${attempt + 1}/${APPROVE_MAX_ATTEMPTS})`;
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        const failMsg = `Failed to approve publication after ${APPROVE_MAX_ATTEMPTS} attempts: ${msg}`;
        approveSpinner.fail(failMsg);
        throw new Error(failMsg);
      }
    }
  }
  if (approved) approveSpinner.succeed("Publication approved (sandbox DOI)");

  console.log(chalk.green(`\nExemplar clone + publish complete: ${sourceId} -> ${xxId}`));
  console.log(chalk.dim(`  GitHub: https://github.com/${NEMAR_DATASETS_ORG}/${xxId}`));
}

/**
 * Single-process driver: prepare -> copy -> finalize, state passed in
 * memory (no S3 staging round-trip — this tool never runs sharded).
 */
export async function cloneExemplar(opts: {
  xxId: string;
  sourceId: string;
  publish?: boolean;
  includeDerived?: boolean;
  workDir?: string;
  name?: string;
  description?: string;
  /** A mirror rehearsal fixture of this OpenNeuro `ds` (see the module comment). */
  mirror?: string;
}): Promise<void> {
  const prep = await prepareExemplar(opts.xxId, opts.sourceId, {
    workDir: opts.workDir,
    name: opts.name,
    description: opts.description,
    ...(opts.mirror !== undefined ? { mirror: opts.mirror } : {}),
  });
  const copyResult = await copyExemplarData(prep, { includeDerived: opts.includeDerived });
  await finalizeExemplar(prep, copyResult, { publish: opts.publish });
}
