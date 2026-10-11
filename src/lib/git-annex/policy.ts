/**
 * The single source of truth for what git-annex takes and what stays in plain git.
 *
 * ADR 0015 set the policy; this module owns its one spelling. Before it existed
 * the same rule was written out five times -- `configureLargefiles`, the manifest
 * classifier in `transfer.ts`, `isNeverAnnexedMetadata` in `import-openneuro.ts`,
 * `scripts/nemar-restore-dataset.sh`, and twice more in `https://docs.nemar.org/admin/operations/validated-workflows/`
 * -- in three mutually inconsistent forms. That drift is what let `_motion.tsv`
 * (issue #1158) land in git: the annex expression excluded every `*.tsv`, while
 * the manifest classifier called anything over 100 kB a data file.
 *
 * Two consumers, one rule:
 *   - `buildLargefilesExpression()` renders it as a git-annex preferred-content
 *     expression for `git annex config --set annex.largefiles`.
 *   - `shouldAnnex()` evaluates it in TypeScript for the upload manifest.
 * `test/annex-policy.test.ts` drives both against a real git-annex repo and
 * asserts they agree file-for-file, so a disagreement is a failing test rather
 * than a silent one. The one place they differ ON PURPOSE is letter case: the
 * TypeScript rule folds it and git-annex's globs do not, so a name like `X.EDF` is
 * data to one and not to the other (see {@link isCaseVariantData}).
 */

/**
 * Extensions that are always annexed, whatever their size. Recognised
 * neurophysiology recording containers. git-annex matches them as written, in
 * lowercase: an uppercase spelling reaches the annex by size alone, or by the upload
 * forcing it (see {@link isCaseVariantData}).
 */
export const ANNEX_DATA_EXTENSIONS = [
  ".edf",
  ".bdf",
  ".set",
  ".fif",
  ".vhdr",
  ".eeg",
  ".cnt",
  ".fdt",
] as const;

/**
 * Data files that wear a metadata extension, matched by filename glob rather
 * than extension and annexed at any size.
 *
 * `*_motion.tsv` is the whole list, and BIDS makes that exhaustive rather than
 * arbitrary: Motion-BIDS stores the recording itself as a headerless TSV (one
 * column per channel, names in the sibling `_channels.tsv`), and it is the only
 * BIDS continuous-data file specified uncompressed. The other continuous
 * recordings -- `_physio.tsv.gz`, `_stim.tsv.gz` -- are required to be gzipped,
 * so they already annex via {@link NEVER_ANNEX_GLOBS} not matching `.gz`.
 *
 * Without this carve-out a Motion-BIDS dataset puts its entire recorded signal
 * in the git repository: OpenNeuro's `ds007788` carries 675 MB of `_motion.tsv`
 * as git blobs.
 */
export const ANNEX_DATA_GLOBS = ["*_motion.tsv"] as const;

/**
 * Metadata that stays in plain git regardless of size, so a metadata-only clone
 * is readable and GitHub renders it. Note that these are exact globs: `*.tsv`
 * does not match `*.tsv.gz`, so compressed data still annexes.
 */
export const NEVER_ANNEX_GLOBS = [
  "*.tsv",
  "*.json",
  "*.md",
  "*.txt",
  "*.yml",
  "*.yaml",
  "README*",
  "LICENSE*",
  "CHANGES*",
  ".bidsignore",
  ".gitignore",
] as const;

/**
 * Anything larger than this annexes unless it matches {@link NEVER_ANNEX_GLOBS}.
 *
 * 100,000 bytes, not 100 KiB: git-annex reads the `kb` in `largerthan=100kb` as
 * SI (1 kB = 1000 bytes). Measured against git-annex 10.20260901 with the
 * production expression, 99,999 and 100,000 bytes stay in git while 100,001
 * annexes. The expression carries the exact byte count, so no unit is left to
 * misread (ADR 0031, amendment of 2026-10-07).
 */
export const ANNEX_SIZE_THRESHOLD_BYTES = 100_000;

/**
 * The threshold as text for a message, from the constant, never retyped.
 * Exact bytes rather than a rounded unit: the CLI's byte formatter divides by
 * 1024, and "97.7 KB" for a rule git-annex states as 100,000 bytes would be a
 * new way to disagree with it.
 */
export function describeAnnexSizeThreshold(): string {
  return `${ANNEX_SIZE_THRESHOLD_BYTES.toLocaleString("en-US")} bytes`;
}

/**
 * Render the policy as a git-annex preferred-content expression.
 *
 * Shape: `(<data extensions> or <data globs> or largerthan=N) and (<not metadata>) and ...`
 *
 * The data globs appear in BOTH clauses on purpose. git-annex ANDs the top-level
 * terms, so the metadata clause can veto the first one: listing `*_motion.tsv`
 * only among the includes would still lose to `exclude=*.tsv`. Pairing it as
 * `(exclude=*.tsv or include=*_motion.tsv)` reads "not a TSV, or else a motion
 * TSV" and is what actually lets it through.
 */
export function buildLargefilesExpression(): string {
  const dataTerms = [
    ...ANNEX_DATA_EXTENSIONS.map((ext) => `include=*${ext}`),
    ...ANNEX_DATA_GLOBS.map((glob) => `include=${glob}`),
    `largerthan=${ANNEX_SIZE_THRESHOLD_BYTES}`,
  ].join(" or ");

  const metadataTerms = NEVER_ANNEX_GLOBS.map((glob) => {
    // A never-annex glob that a data glob overrides has to be paired with it,
    // or the exclusion vetoes the include (see the doc comment above).
    const overrides = ANNEX_DATA_GLOBS.filter((data) => globOverrides(data, glob));
    if (overrides.length === 0) return `exclude=${glob}`;
    const alternatives = overrides.map((data) => `include=${data}`).join(" or ");
    return `(exclude=${glob} or ${alternatives})`;
  }).join(" and ");

  return `(${dataTerms}) and ${metadataTerms}`;
}

/**
 * True when a repository's configured `annex.largefiles` is NEMAR's policy.
 *
 * Exact equality with {@link buildLargefilesExpression}, plus the one spelling
 * every dataset configured by this module before the amendment of ADR 0031 on
 * 2026-10-07 still carries: `largerthan=100kb`. git-annex evaluates that as 100,000 bytes (SI), the
 * same rule the expression now states in bytes, so a repository holding it is
 * governed correctly and must not be reported as drifted. The fleet sweep
 * (`classifyAnnexPolicy`) would otherwise read every `nm` dataset as needing a
 * rewrite on the strength of a spelling alone, and clone it to commit a
 * config.log line that changes nothing. `test/annex-policy.test.ts` proves the two
 * spellings annex the same files, byte for byte around the boundary.
 */
export function isCurrentLargefilesExpression(configured: string): boolean {
  const current = buildLargefilesExpression();
  if (configured === current) return true;
  const legacy = current.replace(
    `largerthan=${ANNEX_SIZE_THRESHOLD_BYTES}`,
    `largerthan=${ANNEX_SIZE_THRESHOLD_BYTES / 1000}kb`,
  );
  return configured === legacy;
}

/**
 * True when `dataGlob` names a subset of the files `metadataGlob` would exclude,
 * i.e. the exclusion has to be relaxed for it. Both are `*`-prefixed suffix
 * globs in practice (`*_motion.tsv` vs `*.tsv`), which is all this needs to
 * handle; anything else is treated as non-overlapping.
 */
function globOverrides(dataGlob: string, metadataGlob: string): boolean {
  if (!dataGlob.startsWith("*") || !metadataGlob.startsWith("*")) return false;
  return dataGlob.endsWith(metadataGlob.slice(1));
}

/** What a file's NAME says about its plane, before its size is consulted. */
type NameVerdict = "data" | "metadata" | "size";

/**
 * Read the name clauses of the policy. `foldCase` is the one thing that differs
 * between the two readers: the CLI folds case (so `X.EDF` is a recording), while
 * git-annex's `include=` and `exclude=` globs are case-sensitive. Measured against
 * git-annex 10.20260901, `include=*.edf` annexes `lower.edf` but not `UPPER.EDF` or
 * `Mixed.Edf`. git-annex has no case-insensitive option (`iinclude=` does not parse),
 * but a bracket class does match both cases (`include=*.[eE][dD][fF]`); the
 * expression does not use them, for the reasons recorded in ADR 0031's amendment of
 * 2026-10-07.
 */
function nameVerdict(path: string, foldCase: boolean): NameVerdict {
  const name = foldCase ? path.toLowerCase() : path;

  // The metadata clause vetoes everything except an explicit data glob.
  const isDataGlob = ANNEX_DATA_GLOBS.some((glob) => matchesGlob(name, glob, foldCase));
  if (!isDataGlob && NEVER_ANNEX_GLOBS.some((glob) => matchesGlob(name, glob, foldCase))) {
    return "metadata";
  }

  if (isDataGlob) return "data";
  if (ANNEX_DATA_EXTENSIONS.some((ext) => name.endsWith(ext))) return "data";
  return "size";
}

/**
 * Evaluate the policy for one file. Mirrors {@link buildLargefilesExpression}
 * exactly; `test/annex-policy.test.ts` proves the two agree against real
 * git-annex rather than trusting that claim.
 *
 * `path` is relative to the dataset root and matched the way git-annex matches
 * its globs -- against the whole path, with `*` spanning `/`, so `*_motion.tsv`
 * catches `sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv`. The one place
 * the two differ is letter case, which is what {@link isCaseVariantData} names.
 */
export function shouldAnnex(path: string, size: number): boolean {
  const verdict = nameVerdict(path, true);
  if (verdict === "metadata") return false;
  if (verdict === "data") return true;
  return size > ANNEX_SIZE_THRESHOLD_BYTES;
}

/**
 * True when the CLI calls a file data on the strength of its NAME but git-annex's
 * case-sensitive globs would not: `UPPER.EDF`, `Mixed.Edf`, `X_MOTION.tsv`.
 *
 * For these the CLI's decision is authoritative (ADR 0031, amendment of
 * 2026-10-07), so the upload hands them to `git annex add --force-large`. Left to
 * git-annex, a case variant that is not over the size threshold stays in git while
 * the upload plan promised S3, and a variant git-annex's metadata exclusion still
 * matches (`X_MOTION.tsv`: `exclude=*.tsv` matches, `include=*_motion.tsv` does
 * not) stays in git at ANY size. Files over the threshold with no such exclusion
 * annex by size and need no help, but forcing them is harmless and keeps one rule.
 */
export function isCaseVariantData(path: string): boolean {
  return nameVerdict(path, true) === "data" && nameVerdict(path, false) !== "data";
}

/**
 * Match one git-annex-style glob against a path. git-annex globs `*` across `/`
 * (unlike gitignore), which is why `exclude=*.tsv` reaches nested sidecars.
 * Only `*` and `?` are used by this policy. Case-folding by default, the CLI's
 * reading; `foldCase: false` is git-annex's.
 */
function matchesGlob(path: string, glob: string, foldCase = true): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, foldCase ? "i" : "").test(path);
}

/**
 * True for dataset-level metadata that NEMAR keeps in git and never annexes.
 *
 * Used by the OpenNeuro import to convert root metadata an upstream dataset
 * annexed (some annex even `dataset_description.json`) back into git blobs.
 * Case-insensitive on the name prefixes to match `ensureReadmeMd`'s tolerance.
 * A data glob such as `*_motion.tsv` is never "metadata" here, so the import
 * cannot un-annex a motion recording that upstream got right.
 */
export function isNeverAnnexedMetadata(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (ANNEX_DATA_GLOBS.some((glob) => matchesGlob(lower, glob))) return false;
  return NEVER_ANNEX_GLOBS.some((glob) => matchesGlob(lower, glob));
}
