/**
 * Bringing an imported clone onto NEMAR's annex policy.
 *
 * The import deliberately inherits upstream's annex layout -- that is what makes
 * the S3 leg a server-side copy by key -- so it inherits upstream's idea of what
 * counts as data too. OpenNeuro decides by size alone (~1 MB), NEMAR by the
 * policy in `git-annex/policy.ts`, and the gap between the two is what left 675 MB
 * of `_motion.tsv` recordings in a public git repo (#1158). `findUnannexedData`
 * reports that gap; this module closes it, in the two places it has to be closed:
 *
 *   - {@link normalizeUnannexedData} annexes the files already in the clone and
 *     uploads their content, so the tree we push names keys that resolve.
 *   - {@link applyNemarAnnexPolicy} replaces the inherited `annex.largefiles`
 *     attributes with NEMAR's configured expression, because a `.gitattributes`
 *     setting beats both `git annex config` and git config, so until they are
 *     gone every later add keeps following upstream's rule. See ADR 0060.
 *
 * {@link normalizeImportedTree} is the pair of them as the prepare phase performs
 * them, in one commit, and is what `prepareImport` calls.
 *
 * Both run in the prepare phase. It is not the only phase that holds a clone
 * (finalize clones twice), but it is the only one holding a clone before the
 * tree is committed and pushed -- and the copy phase, which does the bulk S3
 * work, holds none at all.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureLargefiles, gitAnnexAdd, unstageTrackedPaths } from "./git-annex/init.js";
import { buildLargefilesExpression } from "./git-annex/policy.js";
import { runCommand } from "./git-annex/run-command.js";
import type { S3Credentials } from "./git-annex/s3-remote.js";
import {
  copyPathsToAnnexRemote,
  getAnnexKeysForPaths,
  listAnnexedKeys,
} from "./git-annex/transfer.js";
import type { ImportManifestItem } from "./s3-server-copy.js";
import { listAnnexedPaths } from "./upload/transfer.js";

/** A file that was moved from plain git into the annex, with the key now holding it. */
export interface NormalizedFile {
  path: string;
  key: string;
  size: number;
}

/**
 * Most content this may upload from the prepare host in one import.
 *
 * ADR 0010 keeps the bulk data plane off the runner, and this leg is the one
 * exception: the content is a plain git blob upstream, so it exists nowhere to be
 * server-side copied from BY KEY, and the clone has already pulled every byte
 * anyway. What makes that exception safe is that the volume is bounded by what
 * upstream put in a git repository -- 675 MB for `ds007788`, the largest the
 * nine-dataset sweep behind ADR 0031 found, and GitHub advises against
 * repositories over 5 GB. This makes the bound explicit rather than assumed, so
 * a pathological dataset stops here with a legible error instead of at the job's
 * six-hour cap. `prepareImport` accepts an override, so raising it is an
 * operator decision rather than a code change.
 */
export const NORMALIZE_MAX_BYTES = 5 * 1024 ** 3;

/**
 * How the content of freshly annexed keys reaches the remote.
 *
 * {@link annexCopyUpload} is git-annex's own S3 client, which is what the import
 * uses and what every test drives. A dataset migration can want a different one:
 * `normalize-dataset.ts` offers an `aws s3 sync` strategy for a host whose own
 * AWS configuration is the credential source (`--via-aws-cli`).
 *
 * There is NO default. The caller that obtains the credentials is the caller that
 * states how the bytes move, because the two have to agree: git-annex caches an
 * S3 remote's key and secret in `.git/annex/creds/<uuid>` but has no slot for a
 * session token, so a transfer that inherits the environment after an
 * `enableremote` with temporary credentials signs without one and S3 refuses every
 * request with a bare 403 -- which is exactly what #1380 recorded, and what it
 * misread as the Worker's IAM identity not reaching an `on######` prefix.
 *
 * A strategy owns transferring AND proving the transfer. It must throw, not return,
 * when it cannot prove every key arrived -- the caller commits immediately after.
 */
export type UploadStrategy = (args: {
  datasetPath: string;
  files: NormalizedFile[];
  remoteName: string;
}) => Promise<{ copied: number }>;

/**
 * What a transfer signs with, stated rather than defaulted.
 *
 * `"inherit"` means the subprocess gets no credentials from us and uses whatever
 * its environment (or git-annex's own cached credentials) carries -- right for a
 * `type=directory` remote and for a host configured with long-lived keys, wrong
 * for anything holding STS credentials.
 */
export type TransferCredentials = S3Credentials | "inherit";

/**
 * True for an access key id STS issued. Temporary keys start `ASIA`, long-lived
 * IAM user keys `AKIA`; AWS documents both prefixes as stable.
 */
export function isTemporaryAccessKeyId(accessKeyId: string): boolean {
  return accessKeyId.startsWith("ASIA");
}

/**
 * Turn a stated credential choice into the environment a transfer runs with, and
 * refuse the one combination S3 rejects without saying why.
 *
 * A temporary key signs nothing without its session token: every request comes
 * back 403 Forbidden with no body, for reads and writes alike, on objects that
 * are anonymously readable. Measured against `nemar/on007788` -- the same minted
 * credentials, the same object, HEAD 200 with the token and 403 without it.
 */
export function resolveTransferCredentials(
  credentials: TransferCredentials,
): S3Credentials | undefined {
  if (credentials === "inherit") return undefined;
  if (isTemporaryAccessKeyId(credentials.accessKeyId) && !credentials.sessionToken) {
    throw new Error(
      'Refusing to transfer with temporary AWS credentials that carry no session token: S3 rejects every such request with a bare 403. Pass the session token the credential response returned, or say "inherit" to use the environment\'s own credentials.',
    );
  }
  return credentials;
}

export interface NormalizeDataResult {
  /** Manifest entries for the uploaded keys, marked `origin: "local"`. */
  items: ImportManifestItem[];
  files: NormalizedFile[];
  /**
   * Files git-annex reported a successful copy record for, which counts a key the
   * remote already held as well as one transferred now. Useful for the operator
   * line, and NOT the evidence that the content arrived: that comes from asking
   * git-annex which paths the remote holds afterwards.
   */
  copied: number;
  bytes: number;
}

/**
 * The three gitattributes spellings that set (or unset) an attribute, for the
 * one attribute this module removes. Real OpenNeuro trees only use the `=value`
 * form; the other two are handled so a hand-edited tree cannot slip through.
 */
const LARGEFILES_TOKEN_RE = /^(?:annex\.largefiles(?:=.*)?|-annex\.largefiles|!annex\.largefiles)$/;

/**
 * True for a gitattributes pattern that governs git's own plumbing files rather
 * than dataset content -- `**\/.git*`, `.git*`, `.gitattributes`.
 *
 * Their `annex.largefiles=nothing` is kept, because annexing a `.gitattributes`
 * would replace it with a symlink git-annex cannot then read its own
 * configuration from. NEMAR's own policy covers `.gitignore` but says nothing
 * about `.gitattributes`, so dropping the line would hand that file to the
 * size threshold. DataLad writes it into every repo it creates, ours included.
 */
export function isGitPlumbingPattern(pattern: string): boolean {
  const last = pattern.split("/").pop() ?? pattern;
  return last.startsWith(".git");
}

/**
 * Remove `annex.largefiles` from the attribute lines of a `.gitattributes` file,
 * leaving every other attribute (`text`, `eol`, `annex.backend`, ...) untouched.
 *
 * A line left with no attributes at all is dropped rather than kept as a bare
 * pattern, so the result has no inert leftovers. Comments, blank lines, untouched
 * lines and the file's final-newline state survive exactly; a line this DOES
 * rewrite is re-emitted from its tokens joined by single spaces, so indentation
 * and tab alignment on that line are lost.
 *
 * A line containing a quote is reported in `skipped` and left alone, because
 * splitting it on whitespace would cut a quoted pattern in half. No OpenNeuro
 * tree has one; a hand-edited file might, and mangling it silently is worse than
 * declining it loudly.
 */
export function stripLargefilesAttributes(content: string): {
  content: string;
  stripped: number;
  skipped: string[];
} {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  // A trailing "\n" splits into a final "" that is not a line; hold it aside so
  // it cannot be mistaken for one and re-emitted as an extra blank line.
  if (hadTrailingNewline) lines.pop();

  const out: string[] = [];
  const skipped: string[] = [];
  let stripped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    if (/["']/.test(trimmed) && trimmed.includes("annex.largefiles")) {
      skipped.push(trimmed);
      out.push(line);
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    const [pattern, ...attributes] = tokens;
    if (isGitPlumbingPattern(pattern)) {
      out.push(line);
      continue;
    }
    const kept = attributes.filter((a) => !LARGEFILES_TOKEN_RE.test(a));
    const removed = attributes.length - kept.length;
    if (removed === 0) {
      out.push(line);
      continue;
    }
    stripped += removed;
    if (kept.length > 0) out.push([pattern, ...kept].join(" "));
    // else: pattern with nothing left to say -- drop the line.
  }

  // A file whose every line was a largefiles rule is left empty rather than holding
  // a single newline: an empty `.gitattributes` says the same thing as no file (and
  // DataLad's `.datalad/.gitattributes` is exactly three such lines), while a stray
  // blank line reads as content somebody deleted by hand.
  const rebuilt = out.length === 0 ? "" : out.join("\n") + (hadTrailingNewline ? "\n" : "");
  return { content: rebuilt, stripped, skipped };
}

/** Every tracked `.gitattributes` in the repo, root and nested, repo-relative. */
async function listTrackedGitattributes(datasetPath: string): Promise<string[]> {
  const { stdout, exitCode, stderr } = await runCommand(
    ["git", "ls-files", "-z", "--", ".gitattributes", "*/.gitattributes"],
    { cwd: datasetPath },
  );
  if (exitCode !== 0) {
    throw new Error(`git ls-files failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout.split("\0").filter(Boolean);
}

export interface AnnexPolicyResult {
  /** Tracked `.gitattributes` files rewritten, repo-relative. */
  changed: string[];
  /** Attributes removed across those files. */
  stripped: number;
  /** Lines left alone because a quote made them unsafe to split; caller warns. */
  skipped: string[];
  /** The expression now configured for the repository. */
  expression: string;
}

/**
 * Put NEMAR's annex policy in force on an imported repository, and prove it.
 *
 * Three steps, none of which works alone:
 *
 * 1. Strip inherited `annex.largefiles` attributes from every tracked
 *    `.gitattributes`, root and nested -- one left in `derivatives/` governs that
 *    subtree and reopens the same hole there.
 * 2. Write NEMAR's expression with `configureLargefiles`. **Stripping without
 *    this is worse than doing nothing**: with `annex.largefiles` set nowhere,
 *    `git annex add` annexes EVERYTHING by default, so `README.md`,
 *    `dataset_description.json` and every sidecar would become pointers, while
 *    `git add -A` (which `commitChanges` and the release path use) would take a
 *    multi-gigabyte recording into git. Measured on git-annex 10.20260901.
 * 3. Read the value back. The expression lands in the git-annex branch, which the
 *    push carries to every clone, so an import that silently failed to write it
 *    would ship a repository with no policy at all.
 *
 * Rewritten files are staged, not committed -- the caller owns the commit. The
 * configuration is not a tree change and needs no staging.
 */
export async function applyNemarAnnexPolicy(datasetPath: string): Promise<AnnexPolicyResult> {
  const changed: string[] = [];
  const skipped: string[] = [];
  let stripped = 0;

  for (const rel of await listTrackedGitattributes(datasetPath)) {
    const abs = join(datasetPath, rel);
    // Tracked but absent from the working tree (a sparse or partial checkout):
    // nothing to rewrite, and inventing one would commit a file this checkout
    // cannot see the rest of.
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, "utf8");
    const result = stripLargefilesAttributes(before);
    for (const line of result.skipped) skipped.push(`${rel}: ${line}`);
    if (result.stripped === 0 || result.content === before) continue;
    writeFileSync(abs, result.content);
    changed.push(rel);
    stripped += result.stripped;
  }

  if (changed.length > 0) {
    const { exitCode, stderr } = await runCommand(["git", "add", "--", ...changed], {
      cwd: datasetPath,
    });
    if (exitCode !== 0) {
      throw new Error(`Failed to stage rewritten .gitattributes: ${stderr.trim()}`);
    }
  }

  // Unconditional: a repo that never carried an inherited attribute still needs
  // our expression, and one that just lost its attributes needs it urgently.
  const expression = buildLargefilesExpression();
  const configured = await configureLargefiles(datasetPath);
  if (!configured.success) {
    throw new Error(
      `Stripped ${stripped} inherited annex.largefiles attribute(s) but could not configure NEMAR's policy: ${configured.error}. Refusing to continue: with no policy set, git-annex annexes everything, including the metadata a clone has to be able to read.`,
    );
  }
  const readBack = await runCommand(["git", "annex", "config", "--get", "annex.largefiles"], {
    cwd: datasetPath,
  });
  if (readBack.exitCode !== 0 || readBack.stdout.trim() !== expression) {
    throw new Error(
      `annex.largefiles did not take: expected NEMAR's expression, git-annex reports "${readBack.stdout.trim()}". Refusing to continue -- the repository would have no annex policy.`,
    );
  }

  return { changed, stripped, skipped, expression };
}

/**
 * Move files the clone carries as plain git blobs into the annex and upload their
 * content to `remoteName`.
 *
 * The enabling fact is that a git-resident file's content is always present in the
 * clone, so this needs no annex fetch: uncache, add, verify the keys, upload. That
 * order is deliberate. Annexing without uploading publishes a pointer nothing can
 * resolve, which is worse than the bloat this fixes, so neither a path that failed
 * to annex nor a failed upload reaches the commit -- both abort the import.
 *
 * The returned items carry `origin: "local"`: their content is already at the
 * destination, so the copy phase must skip them, while finalize's size
 * verification and key registration must not.
 */
export async function normalizeUnannexedData(args: {
  datasetPath: string;
  files: Array<{ path: string; size: number }>;
  remoteName: string;
  bucket: string;
  nemarId: string;
  /** Overridable so the bound itself is testable; production uses the default. */
  maxBytes?: number;
  /** How the bytes move, and with which credentials; see {@link UploadStrategy}. */
  upload: UploadStrategy;
  /**
   * The key backend, when it must not be the one the tree's attributes name. The
   * identifier scrub passes `SHA256E` (ADR 0089); the annex-policy leg leaves it
   * unset and keeps upstream's.
   */
  backend?: "SHA256E";
}): Promise<NormalizeDataResult> {
  const { datasetPath, files, remoteName, bucket, nemarId } = args;
  if (files.length === 0) return { items: [], files: [], copied: 0, bytes: 0 };

  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const maxBytes = args.maxBytes ?? NORMALIZE_MAX_BYTES;
  if (bytes > maxBytes) {
    throw new Error(
      `${files.length} file(s) totaling ${(bytes / 1024 ** 3).toFixed(1)} GiB need annexing, over the ${(maxBytes / 1024 ** 3).toFixed(1)} GiB this leg will upload from the import host (NORMALIZE_MAX_BYTES, ADR 0010/0060). Re-run on a host that can finish the upload with --normalize-max-gb <n> to raise it deliberately, rather than discovering the size at the job timeout.`,
    );
  }

  const paths = files.map((f) => f.path);
  // Un-caching makes each path untracked for the moment the add looks at it, and
  // an untracked path matched by the dataset's own `.gitignore` is skipped --
  // silently, exit 0, leaving the file in neither git nor the annex. gitignore
  // never applied to these paths while they were tracked, so it must not start
  // applying now: `--no-check-gitignore` keeps the add looking at all of them.
  await unstageTrackedPaths(datasetPath, paths);
  const added = await gitAnnexAdd(
    datasetPath,
    paths,
    {},
    { forceLarge: true, checkGitignore: false, ...(args.backend ? { backend: args.backend } : {}) },
  );
  if (!added.success) {
    throw new Error(`Failed to annex ${paths.length} data file(s): ${added.error}`);
  }

  // The add reports success whether or not it did anything, so ask git-annex what
  // it now holds. A path with no key did not annex -- uncached but skipped,
  // vanished, unreadable -- and the tree would not say what the manifest says.
  const keys = await getAnnexKeysForPaths(datasetPath, paths);
  const missing = paths.filter((p) => !keys.has(p));
  if (missing.length > 0) {
    throw new Error(
      `Annexed ${paths.length} file(s) but git-annex reports no key for ${missing.length} of them (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}). Refusing to continue: the commit would carry data files git-annex does not hold.`,
    );
  }

  const normalized: NormalizedFile[] = files.map((f) => ({
    path: f.path,
    // biome-ignore lint/style/noNonNullAssertion: every path is in `keys` (checked above)
    key: keys.get(f.path)!,
    size: f.size,
  }));

  const { copied } = await args.upload({ datasetPath, files: normalized, remoteName });

  // Identical content shares one key, so dedupe: the manifest addresses keys,
  // and a duplicate entry would have finalize verify and register it twice.
  const items = new Map<string, ImportManifestItem>();
  for (const f of normalized) {
    items.set(f.key, {
      key: f.key,
      sourceUrl: null,
      source: null,
      destUri: `s3://${bucket}/${nemarId}/objects/${f.key}`,
      origin: "local",
    });
  }

  return {
    items: [...items.values()],
    files: normalized,
    copied,
    bytes,
  };
}

/**
 * The default upload: git-annex's own client, then the location log as proof.
 *
 * Exit 0 is not evidence on its own. `git annex copy --to` reports success both for
 * a transfer and for a key the remote already held, and says nothing at all for a
 * path it does not consider annexed -- so this asks the location log which paths
 * the remote now holds. A log read, no network.
 *
 * That check is the second net behind `normalizeUnannexedData`'s key verification,
 * which is what makes the silent-skip case unreachable today. It does work on its
 * own: with the copy's exit code ignored, a copy to a remote whose directory had
 * been removed raised exactly this error rather than proceeding (measured by
 * mutating the `!copy.success` branch away).
 */
export function annexCopyUpload(options: {
  credentials: TransferCredentials;
  jobs?: number;
}): UploadStrategy {
  const credentials = resolveTransferCredentials(options.credentials);
  return async ({ datasetPath, files, remoteName }) => {
    const paths = files.map((f) => f.path);
    const copy = await copyPathsToAnnexRemote(
      datasetPath,
      remoteName,
      paths,
      options.jobs ?? 4,
      credentials,
    );
    if (!copy.success) {
      throw new Error(
        `Annexed ${paths.length} data file(s) but the upload to ${remoteName} failed: ${copy.error}. Not committing: the pushed tree would name keys with no content behind them.`,
      );
    }

    const atRemote = await listAnnexedPaths(datasetPath, remoteName);
    const notAtRemote = paths.filter((path) => !atRemote.has(path));
    if (notAtRemote.length > 0) {
      throw new Error(
        `Uploaded to ${remoteName} without error, but git-annex does not record ${notAtRemote.length} of ${paths.length} path(s) as present there (${notAtRemote.slice(0, 3).join(", ")}${notAtRemote.length > 3 ? ", ..." : ""}). Not committing: those keys would have no content behind them.`,
      );
    }
    return { copied: copy.filesCopied };
  };
}

/** What {@link normalizeImportedTree} did, for the caller to report and to manifest. */
export interface NormalizeImportResult {
  policy: AnnexPolicyResult;
  /** Null when the caller passed no files (metadata-only, or `--skip-data`). */
  data: NormalizeDataResult | null;
  /**
   * Keys this tree already carries that no upstream source can account for, so
   * the manifest must claim them as locally uploaded or nothing will verify them.
   */
  carriedOver: ImportManifestItem[];
  /** Manifest entries to append: the newly uploaded keys plus the carried-over ones. */
  items: ImportManifestItem[];
  /** True when the step made a commit. False means it had nothing to change. */
  committed: boolean;
  /** One-line summaries of what changed, for the operator. Empty means no-op. */
  notes: string[];
}

/**
 * Bring one imported tree onto NEMAR's annex policy: the whole step, in one
 * commit, as the prepare phase performs it.
 *
 * Exported as a unit rather than left inline in `prepareImport` because the
 * decisions here are the ones worth testing -- what gets annexed, what gets
 * carried into the manifest, whether a commit happens at all -- and an inline
 * body can only be tested through a full import. It throws rather than exiting,
 * so the caller owns how a failure is reported.
 *
 * `upstreamKeys` is the key set the copy phase can server-side copy from.
 * `carryOverUnaccountedKeys` asks for the re-import behavior: on a second
 * prepare, this tree's own previously-normalized recordings are already annexed,
 * so nothing is re-uploaded and `upstreamKeys` cannot describe them -- without
 * carrying them over, finalize's size gate and its key registration would skip
 * exactly the keys this feature introduced, and a dataset whose only data is
 * normalized would hit the empty-manifest publish guard forever. It is off for a
 * first import, where an unaccounted key means something else entirely (an
 * upstream whereis that yielded no usable URL) and is already reported as such.
 */
export async function normalizeImportedTree(args: {
  datasetPath: string;
  nemarId: string;
  bucket: string;
  remoteName: string;
  /** Files NEMAR policy calls data that git still holds. Empty is a valid no-op. */
  unannexedData: Array<{ path: string; size: number }>;
  upstreamKeys: Set<string>;
  carryOverUnaccountedKeys: boolean;
  maxBytes?: number;
  /**
   * How the annexed content reaches `remoteName`. Required, and only consulted
   * when there is something to move; see {@link UploadStrategy} for why there is
   * no default.
   */
  upload: UploadStrategy;
}): Promise<NormalizeImportResult> {
  const policy = await applyNemarAnnexPolicy(args.datasetPath);

  const data =
    args.unannexedData.length > 0
      ? await normalizeUnannexedData({
          datasetPath: args.datasetPath,
          files: args.unannexedData,
          remoteName: args.remoteName,
          bucket: args.bucket,
          nemarId: args.nemarId,
          maxBytes: args.maxBytes,
          upload: args.upload,
        })
      : null;

  const carriedOver: ImportManifestItem[] = [];
  if (args.carryOverUnaccountedKeys) {
    const freshKeys = new Set((data?.items ?? []).map((it) => it.key));
    const seen = new Set<string>();
    for (const key of (await listAnnexedKeys(args.datasetPath)).values()) {
      if (args.upstreamKeys.has(key) || freshKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      carriedOver.push({
        key,
        sourceUrl: null,
        source: null,
        destUri: `s3://${args.bucket}/${args.nemarId}/objects/${key}`,
        origin: "local",
      });
    }
  }

  const notes: string[] = [];
  if (data && data.files.length > 0) {
    notes.push(
      `annexed ${data.files.length} file(s), ${(data.bytes / 1e6).toFixed(1)} MB uploaded`,
    );
  }
  if (policy.changed.length > 0) {
    notes.push(`stripped ${policy.stripped} inherited annex.largefiles attribute(s)`);
  }
  if (policy.skipped.length > 0) {
    // A quoted pattern the strip will not split. `prepareImport` warns about these;
    // `normalizeDatasetRepo` prints only these notes, so without this the line is
    // left in place and nobody is told -- and per ADR 0060 it still outranks the
    // expression we just configured.
    notes.push(
      `LEFT IN PLACE, still outranking NEMAR's expression: ${policy.skipped.join("; ")} (a quoted pattern; fix by hand)`,
    );
  }

  // Commit only what changed the tree. The carried-over keys are already
  // committed by definition, and the configuration lives in the git-annex branch,
  // so neither is a reason to make a commit here.
  const committed = policy.changed.length > 0 || (data?.files.length ?? 0) > 0;
  if (committed) {
    const body = [
      data && data.files.length > 0
        ? `Moved ${data.files.length} file(s) NEMAR policy treats as data from git into the annex; content uploaded to S3.`
        : null,
      policy.changed.length > 0
        ? `Removed inherited annex.largefiles attributes from ${policy.changed.join(", ")}; NEMAR's own annex.largefiles is now configured for this repository.`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    const commit = await runCommand(
      ["git", "commit", "-m", "Apply NEMAR annex policy to imported tree", "-m", body],
      { cwd: args.datasetPath },
    );
    if (commit.exitCode !== 0 && !commit.stdout.includes("nothing to commit")) {
      throw new Error(`Failed to commit annex-policy changes: ${commit.stderr.trim()}`);
    }
  }

  return {
    policy,
    data,
    carriedOver,
    items: [...(data?.items ?? []), ...carriedOver],
    committed,
    notes,
  };
}
