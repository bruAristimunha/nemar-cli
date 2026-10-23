#!/usr/bin/env bun
/**
 * The original-content facts of Part B (`scripts/ci/pr-review-original.ts`) on the frozen set A:
 * the reader behind the baseline `set-a-original.json` and behind the test that recomputes it
 * (`test/pr-review-original-set-a.test.ts`). Test support, not production code: it starts git, which
 * the module itself never does.
 *
 *   bun run test/fixtures/pr-review-canary/original.ts --clones DIR \
 *     --prs test/fixtures/pr-review-canary/set-a.txt > test/fixtures/pr-review-canary/set-a-original.json
 *
 * Each pull request is read from its frozen clone the way the calibration reads one
 * (`cloneReader` of `scripts/ci/pr-review-calibrate.ts`, with `--offline`): the clone must be a
 * repository of its own holding both pinned commits and every blob of the diff from the merge base
 * to the head, or the row says why in a closed word. The run's git environment is the calibration's
 * (`scopeRunEnvironment`): no global or system configuration, no repository variable, and
 * `GIT_NO_LAZY_FETCH=1`, so nothing is ever fetched; a git older than 2.45.0, which ignores that
 * variable, is refused before any clone is read.
 *
 * The git it runs: `merge-base`, `ls-tree -z` of the two root trees, `diff --raw -z` and
 * `diff --numstat -z` from the merge base to the head, and `cat-file --batch-check` and
 * `cat-file --batch` for blobs. Never `log` or `show`, whose headers carry committer addresses, and
 * never a clone's `.pr.json` or `targets.txt`. The protection anchor is always the merge base (the
 * strict side): the version tags are not read.
 *
 * A row holds the pull request's name, counts, booleans, the module's closed words and closed key
 * names. Never a line of a README, a path or a tag: the module's facts hold none.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CALIBRATION_READ_ERRORS,
  CalibrationReadError,
  type CalibrationTarget,
  cloneReader,
  honorsNoLazyFetch,
  parseGitVersion,
  parseTarget,
  scopeRunEnvironment,
} from "../../../scripts/ci/pr-review-calibrate";
import {
  type RawEntry,
  SHA40,
  childEnv,
  classifyPath,
  parseRawEntries,
  readBlobs,
} from "../../../scripts/ci/pr-review-evidence";
import {
  type AuthorFieldFacts,
  type DescriptionSide,
  type DocumentKind,
  type DocumentPart,
  ORIGINAL_LIMITS,
  type PointerProbe,
  type ProseFacts,
  type ProseRefusal,
  type RecordingChange,
  type RecordingFacts,
  authorFieldFacts,
  authorFieldsAltered,
  inReviewedScope,
  isDocumentName,
  proseAltered,
  proseFacts,
  recordingFacts,
} from "../../../scripts/ci/pr-review-original";

/**
 * Why a row holds no facts: a clone that could not be read as the calibration reads it
 * (`CALIBRATION_READ_ERRORS`), or a git call of this reader that failed.
 */
export const ORIGINAL_ROW_ERRORS = [
  ...CALIBRATION_READ_ERRORS,
  "no_merge_base",
  "diff_unreadable",
  "tree_unreadable",
  "blobs_unreadable",
] as const;
export type OriginalRowError = (typeof ORIGINAL_ROW_ERRORS)[number];

/** One document of a row: refused in a closed word, or its facts. */
export type DocumentRow =
  | { refusal: ProseRefusal }
  | ({ refusal: null; proseAltered: boolean } & ProseFacts);

/** What one pull request did to the original authors' content, in numbers and closed words. */
export interface OriginalRow {
  pr: string;
  error: OriginalRowError | null;
  /** Lines `git diff --numstat` counts as deleted from root README files: what GitHub shows. */
  readmeGitDeleted: number | null;
  /** Null when no README part changed. */
  readme: DocumentRow | null;
  /** Null when no CHANGES part changed. */
  changes: DocumentRow | null;
  /** Null when `dataset_description.json` did not change. */
  authorFields: (AuthorFieldFacts & { authorFieldsAltered: boolean }) | null;
  recordings: (RecordingFacts & { unread: number }) | null;
}

/** Where a failed git call of this reader stops a row. */
class RowError extends Error {
  readonly code: OriginalRowError;
  constructor(code: OriginalRowError) {
    super(code);
    this.code = code;
  }
}

/** One git call in the clone, with the run's environment (see {@link originalRows}). */
function git(dir: string, args: string[], code: OriginalRowError, input?: string): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: childEnv(),
      maxBuffer: 256 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      ...(input === undefined ? {} : { input }),
    });
  } catch {
    throw new RowError(code);
  }
}

/** One entry of a root tree. */
interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  name: string;
}

/** The entries of a commit's root tree, from `ls-tree -z` (not recursive). */
function rootTree(dir: string, commit: string): TreeEntry[] {
  const out = git(dir, ["ls-tree", "-z", commit], "tree_unreadable");
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const m = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s.exec(record);
    if (m === null) throw new RowError("tree_unreadable");
    entries.push({
      mode: m[1] as string,
      type: m[2] as string,
      oid: m[3] as string,
      name: m[4] as string,
    });
  }
  return entries;
}

/** The size of each blob id, or null for an id the clone does not hold as a blob. */
function blobSizes(dir: string, oids: readonly string[]): Map<string, number | null> {
  const ids = [...new Set(oids)];
  const sizes = new Map<string, number | null>();
  if (ids.length === 0) return sizes;
  const out = git(dir, ["cat-file", "--batch-check"], "blobs_unreadable", `${ids.join("\n")}\n`);
  const lines = out.split("\n");
  if (lines.pop() !== "" || lines.length !== ids.length) throw new RowError("blobs_unreadable");
  ids.forEach((id, i) => {
    const m = /^([0-9a-f]{40}) (blob|tree|commit|tag) (\d+)$/.exec(lines[i] as string);
    sizes.set(id, m !== null && m[1] === id && m[2] === "blob" ? Number(m[3]) : null);
  });
  return sizes;
}

/** Blobs by id (see `readBlobs`): a blob left out is one the clone could not give. */
function blobs(dir: string, oids: readonly string[], maxBytes: number): Map<string, Buffer> {
  const read = readBlobs(dir, oids, { maxBytes, maxTotalBytes: 1024 * 1024 * 1024 });
  if (read === null) throw new RowError("blobs_unreadable");
  return read;
}

/** The parts of a document in a root tree, with their bytes or `unreadable`. */
function partsOf(
  document: DocumentKind,
  tree: readonly TreeEntry[],
  read: ReadonlyMap<string, Buffer>,
): DocumentPart[] {
  return tree
    .filter((entry) => isDocumentName(document, entry.name))
    .map((entry) => ({
      name: entry.name,
      mode: entry.mode,
      oid: entry.oid,
      content: entry.type === "blob" ? (read.get(entry.oid) ?? "unreadable") : "unreadable",
    }));
}

/** A document's row. */
function documentRow(
  document: DocumentKind,
  base: readonly TreeEntry[],
  head: readonly TreeEntry[],
  read: ReadonlyMap<string, Buffer>,
): DocumentRow {
  const result = proseFacts({
    document,
    base: partsOf(document, base, read),
    head: partsOf(document, head, read),
    anchor: null,
  });
  if (!result.ok) return { refusal: result.refusal };
  return { refusal: null, proseAltered: proseAltered(result.facts), ...result.facts };
}

/** One side of the dataset description in a root tree. */
function descriptionSide(
  tree: readonly TreeEntry[],
  read: ReadonlyMap<string, Buffer>,
): DescriptionSide {
  const entry = tree.find((e) => e.name === "dataset_description.json");
  if (entry === undefined) return "absent";
  return entry.type === "blob" ? (read.get(entry.oid) ?? "unreadable") : "unreadable";
}

/** The deleted lines of `diff --numstat -z` over the root README files (a binary file counts 0). */
function readmeDeletedLines(numstat: string): number {
  let deleted = 0;
  for (const record of numstat.split("\0")) {
    if (record === "") continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (m === null) throw new RowError("diff_unreadable");
    if (isDocumentName("readme", m[3] as string) && m[2] !== "-") deleted += Number(m[2]);
  }
  return deleted;
}

/** The probe of one side of a changed path for {@link recordingFacts}. */
function probeOf(
  oid: string,
  sizes: ReadonlyMap<string, number | null>,
  small: ReadonlyMap<string, Buffer>,
): PointerProbe {
  const size = sizes.get(oid);
  if (size === undefined || size === null) return "unreadable";
  if (size > ORIGINAL_LIMITS.pointerMaxBytes) return "large";
  return small.get(oid) ?? "unreadable";
}

/**
 * The recording facts over every changed path. The recordings area comes from `classifyPath`, the
 * review's own reading of a path, and the reviewed scope from the module's `inReviewedScope`; a
 * move is matched over every path, as the module does.
 */
function recordingRow(
  dir: string,
  entries: readonly RawEntry[],
): RecordingFacts & { unread: number } {
  const sides: string[] = [];
  for (const entry of entries) {
    if (entry.status !== "added" && entry.modeBefore !== "160000") sides.push(entry.oidBefore);
    if (entry.status !== "removed" && entry.modeAfter !== "160000") sides.push(entry.oidAfter);
  }
  const sizes = blobSizes(dir, sides);
  const small = blobs(
    dir,
    sides.filter(
      (oid) => (sizes.get(oid) ?? Number.POSITIVE_INFINITY) <= ORIGINAL_LIMITS.pointerMaxBytes,
    ),
    ORIGINAL_LIMITS.pointerMaxBytes,
  );
  const changes: RecordingChange[] = entries.map((entry) => ({
    path: entry.path,
    status: entry.status,
    modeBefore: entry.modeBefore,
    modeAfter: entry.modeAfter,
    oidBefore: entry.oidBefore,
    oidAfter: entry.oidAfter,
    recordingArea: classifyPath(entry.path) === "recordings",
    inReviewedScope: inReviewedScope(entry.path),
    before:
      entry.status === "added"
        ? null
        : entry.modeBefore === "160000"
          ? "unreadable"
          : probeOf(entry.oidBefore, sizes, small),
    after:
      entry.status === "removed"
        ? null
        : entry.modeAfter === "160000"
          ? "unreadable"
          : probeOf(entry.oidAfter, sizes, small),
  }));
  return recordingFacts(changes);
}

/** A row that holds only why it holds nothing. */
function errorRow(pr: string, error: OriginalRowError): OriginalRow {
  return {
    pr,
    error,
    readmeGitDeleted: null,
    readme: null,
    changes: null,
    authorFields: null,
    recordings: null,
  };
}

/**
 * The row of one pull request, read from the clone `dir` at the commits `base` and `head`. The
 * documents and the description are compared from the merge base, as the review compares them; a
 * git call that fails is the row's error word. The run's git environment ({@link originalRows}) is
 * set for the call and put back after, so no row is ever read with a lazy fetch allowed.
 */
export function originalRow(dir: string, pr: string, base: string, head: string): OriginalRow {
  const restore = scopeRunEnvironment(true);
  try {
    const mergeBase = git(dir, ["merge-base", base, head], "no_merge_base").trim();
    if (!SHA40.test(mergeBase)) return errorRow(pr, "no_merge_base");
    const raw = parseRawEntries(
      git(
        dir,
        ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", mergeBase, head],
        "diff_unreadable",
      ),
    );
    if (raw === null) return errorRow(pr, "diff_unreadable");
    const numstat = git(
      dir,
      [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        mergeBase,
        head,
      ],
      "diff_unreadable",
    );
    const changed = [...raw.keys()];
    const readmeChanged = changed.some((path) => isDocumentName("readme", path));
    const changesChanged = changed.some((path) => isDocumentName("changes", path));
    const descriptionChanged = raw.has("dataset_description.json");
    const baseTree = rootTree(dir, mergeBase);
    const headTree = rootTree(dir, head);
    const wanted = (entry: TreeEntry): boolean =>
      entry.type === "blob" &&
      ((readmeChanged && isDocumentName("readme", entry.name)) ||
        (changesChanged && isDocumentName("changes", entry.name)) ||
        (descriptionChanged && entry.name === "dataset_description.json"));
    const read = blobs(
      dir,
      [...baseTree, ...headTree].filter(wanted).map((entry) => entry.oid),
      64 * 1024 * 1024,
    );
    let authorFields: OriginalRow["authorFields"] = null;
    if (descriptionChanged) {
      const facts = authorFieldFacts(
        descriptionSide(baseTree, read),
        descriptionSide(headTree, read),
      );
      authorFields = { ...facts, authorFieldsAltered: authorFieldsAltered(facts) };
    }
    return {
      pr,
      error: null,
      readmeGitDeleted: readmeDeletedLines(numstat),
      readme: readmeChanged ? documentRow("readme", baseTree, headTree, read) : null,
      changes: changesChanged ? documentRow("changes", baseTree, headTree, read) : null,
      authorFields,
      recordings: recordingRow(dir, [...raw.values()]),
    };
  } catch (e) {
    if (e instanceof RowError) return errorRow(pr, e.code);
    throw e;
  } finally {
    restore();
  }
}

/**
 * The rows of `targets`, each read from its clone under `clones` as the calibration reads one with
 * `--offline` and no text. The run's git environment is set for the run and put back after, as the
 * calibration sets it. Throws, before any clone is read, when the git on the path is older than
 * 2.45.0 or cannot say its version, because such a git would fetch what a clone lacks.
 */
export function originalRows(clones: string, targets: readonly CalibrationTarget[]): OriginalRow[] {
  const version = parseGitVersion(
    execFileSync("git", ["--version"], { encoding: "utf8", env: childEnv() }),
  );
  if (version === null || !honorsNoLazyFetch(version)) {
    throw new Error("git 2.45.0 or later is needed, so that no clone is fetched into");
  }
  const restore = scopeRunEnvironment(true);
  try {
    const reader = cloneReader(clones, true, false);
    return targets.map((t) => {
      const pr = `${t.dataset}#${t.number}`;
      try {
        const { dir, base, head } = reader(t);
        return originalRow(dir, pr, base, head);
      } catch (e) {
        if (e instanceof CalibrationReadError) return errorRow(pr, e.code);
        throw e;
      }
    });
  } finally {
    restore();
  }
}

/** The pinned pull requests of a manifest such as `set-a.txt`; a line that is not one throws. */
export function readTargets(path: string): CalibrationTarget[] {
  const targets: CalibrationTarget[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const target = parseTarget(line);
    if (target?.pin === undefined) throw new Error("a manifest line is not a pinned pull request");
    targets.push(target);
  }
  return targets;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const clones = value("--clones");
  const prs = value("--prs");
  if (clones === undefined || prs === undefined || argv.length !== 4) {
    console.error("usage: original.ts --clones DIR --prs FILE");
    process.exit(2);
  }
  console.log(JSON.stringify(originalRows(clones, readTargets(prs)), null, 2));
}
