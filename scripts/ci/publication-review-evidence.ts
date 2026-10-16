/**
 * What a publication request's dataset looks like at the reviewed commit, read as git data
 * (ADR 0102).
 *
 * Runs inside the central review workflow against a repository made with `git init` and
 * `git fetch --depth=1 --filter=blob:none`, which has no working tree. **Nothing is checked out and
 * nothing from the dataset is executed**: with no working tree, no hook, filter, `.gitattributes`
 * driver or script in the dataset can run. Every git call passes its arguments as an array (no
 * shell), after the commit id has been checked against a 40-hex shape, with `--literal-pathspecs`
 * and with the environment reduced to what git needs, so a path is only ever data and no token the
 * job holds reaches a child process. **Nothing here touches the network**: lazy fetching is off, so
 * the blobs this module opens are exactly the ones the workflow's fetch step brought in
 * ({@link blobsToRead}), and a blob that is not in the clone reads as unreadable instead of being
 * requested.
 *
 * The output has two halves with different trust, as in the pull-request review:
 *
 *  - {@link buildPublicationEvidence} is the deterministic account: counts, closed words and
 *    numbers, which goes into the report whatever the model says. It is validated by the Worker's
 *    own parser before it is returned, so the job cannot hand the Worker evidence the Worker would
 *    refuse. **No path, file name, subject or task label, header value or finding ever enters it**:
 *    the structural summary is built from the tree's paths and from two numeric keys of a sample of
 *    sidecars, and every other byte of either is discarded unread.
 *  - {@link readRootDocuments} returns the text the model may be shown, all of it untrusted, and
 *    nothing here decides whether it may be sent: `publication-review-presend.ts` does.
 *
 * **What was NOT shown is a fact too.** A document that is absent, annexed, unreadable, not UTF-8,
 * or JSON that does not parse is a closed state in the evidence, not a stub README. A README that
 * is an annexed link is `withheld_annexed`, never `absent`, so it is never judged missing.
 *
 * **A fact the job cannot establish is not recorded as a failure.** The minimums are evaluated on
 * the whole raw files in memory, never on what the model is shown. When the README could not be
 * read at all, the ethics-statement minimum (which may rest on the README) is left out rather than
 * recorded as failed: a re-block for "no ethics statement" over a file nobody could open would send
 * the depositor to fix something that is not wrong, and the unread README already makes the review
 * an `action_required` through `text_withheld`. A description that cannot be read at all is an
 * {@link PublicationEvidenceError}, because every fact below it would be invented.
 */

import { execFileSync } from "node:child_process";
import { formatCoverage } from "../../shared/identifier-scan";
import { SEMVER } from "../../shared/pr-review";
import {
  type BidsState,
  CHANGES_CANDIDATES,
  type ClearedDocuments,
  DOCUMENT_BYTE_CEILING,
  LICENSE_CANDIDATES,
  MAX_COUNT,
  MAX_SAMPLING_RATE_HZ,
  MAX_SUMMARY_VALUES,
  PARTICIPANTS_JSON,
  type PreSendResult,
  type PublicationReviewEvidence,
  REVIEW_DATATYPES,
  REVIEW_DOCUMENTS,
  REVIEW_FORMATS,
  type RawDocument,
  type ReviewDatatype,
  type ReviewDocument,
  type ReviewFacts,
  type StructuralSummary,
  type TagState,
  type VersionShape,
  effectiveVersionOf,
  parsePublicationReviewEvidence,
} from "../../shared/publication-review";
import { firstReadme } from "../../shared/readme-candidates";
import { isPlaceholderAuthor, submissionMinimumFailures } from "../../shared/submission-minimums";
import {
  type Tree,
  type TreeEntry,
  listTree,
  parseAnnexPointer,
} from "../identifier-screen-ci-lib";
import { presend } from "./publication-review-presend";

/** A full commit id. Every revision this module hands to git has this shape. */
export const SHA40 = /^[0-9a-f]{40}$/;

/** At most this many data sidecars are opened, evenly spread over the sorted list. */
export const SIDECAR_SAMPLE = 64;
/** A sidecar larger than this is not read: it is not a sidecar. */
export const SIDECAR_BYTE_CEILING = 1024 * 1024;
/** A file this small can be an unlocked git-annex pointer, which is one short line. */
const POINTER_MAX_BYTES = 1024;

/**
 * Why the evidence could not be read. A closed list, because the word is printed in a public log:
 * an error built from a path or a git message would put a dataset's text there.
 */
export const PUBLICATION_EVIDENCE_ERRORS = [
  "bad_commit_id",
  "tree_unreadable",
  "description_unreadable",
  "tags_unreadable",
] as const;
export type PublicationEvidenceErrorCode = (typeof PUBLICATION_EVIDENCE_ERRORS)[number];

export class PublicationEvidenceError extends Error {
  readonly code: PublicationEvidenceErrorCode;
  constructor(code: PublicationEvidenceErrorCode) {
    super(code);
    this.name = "PublicationEvidenceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading git
// ---------------------------------------------------------------------------------------------

/**
 * What a git child process gets: no token, no user or system config, no prompt, and no lazy fetch.
 * A blob the clone does not hold is reported missing and is never requested from the remote, so
 * nothing this module reads can reach the network, with or without a credential.
 */
function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
  };
}

function git(dir: string, args: string[], maxBuffer: number): Buffer {
  return execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "-C",
      dir,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    { maxBuffer, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
}

type BlobRead = { ok: true; bytes: Buffer } | { ok: false; reason: "missing" | "too_large" };

/**
 * One blob's bytes, never more than `ceiling` of them. The size is asked first, so a blob that is
 * too large is never held in memory. The job's clone is blob-less, but the workflow's fetch step
 * already fetched every blob this module reads (the root documents and the sampled sidecars). Lazy
 * fetching is off (see {@link gitEnv}), so a blob that was not fetched is not requested from the
 * remote, with or without a credential: it is `missing` here, and the document reads as unreadable.
 */
function readBlob(dir: string, oid: string, ceiling: number): BlobRead {
  if (!/^[0-9a-f]{40,64}$/.test(oid)) return { ok: false, reason: "missing" };
  let size: number;
  try {
    size = Number(git(dir, ["cat-file", "-s", oid], 64).toString("utf8").trim());
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!Number.isSafeInteger(size) || size < 0) return { ok: false, reason: "missing" };
  if (size > ceiling) return { ok: false, reason: "too_large" };
  try {
    return { ok: true, bytes: git(dir, ["cat-file", "blob", oid], ceiling + 1024) };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

/** Every file of the commit's tree. A commit that is not there is an error, never an empty tree. */
export async function readTree(dir: string, head: string): Promise<Tree> {
  if (!SHA40.test(head)) throw new PublicationEvidenceError("bad_commit_id");
  const tree = await listTree(dir, head);
  if (tree === null) throw new PublicationEvidenceError("tree_unreadable");
  return tree;
}

// ---------------------------------------------------------------------------------------------
// The root documents
// ---------------------------------------------------------------------------------------------

const DESCRIPTION_FILE = "dataset_description.json";

/** The root file each document is, in the order the first present one is chosen. */
function candidatesOf(document: ReviewDocument, rootNames: readonly string[]): readonly string[] {
  switch (document) {
    case "readme": {
      const first = firstReadme(rootNames);
      return first === null ? [] : [first];
    }
    case "dataset_description":
      return [DESCRIPTION_FILE];
    case "changes":
      return CHANGES_CANDIDATES;
    case "license":
      return LICENSE_CANDIDATES;
    case "participants_json":
      return [PARTICIPANTS_JSON];
  }
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

/** Read one root file as the depositor wrote it. Never throws. */
function readDocument(dir: string, name: string, entry: TreeEntry): RawDocument {
  // A symlink is a pointer to something that is not text in git. At the root of a dataset it is an
  // annexed link, whatever it points at, and it is never opened.
  if (entry.mode === "120000") return { name, state: "annexed", text: null };
  const blob = readBlob(dir, entry.oid, DOCUMENT_BYTE_CEILING);
  if (!blob.ok) return { name, state: "unreadable", text: null };
  // An unlocked pointer file is one short line naming an annex key: the file is in the annex, not
  // in git, and must never be mistaken for a stub.
  if (
    blob.bytes.length <= POINTER_MAX_BYTES &&
    parseAnnexPointer(blob.bytes.toString("latin1"), false) !== null
  ) {
    return { name, state: "annexed", text: null };
  }
  let text: string;
  try {
    text = DECODER.decode(blob.bytes);
  } catch {
    return { name, state: "not_utf8", text: null };
  }
  // UTF-16 with no byte-order mark and only ASCII characters is valid UTF-8, with a NUL between
  // every letter. It is not text a person wrote in UTF-8, and the cleaning that comes later would
  // turn each NUL into a space and split every word the shared rules look for. No text document
  // holds a NUL, so one makes the file `not_utf8`, here and again in the pre-send module (which
  // cannot assume its caller was this function). The exception is the description: it stays
  // `present`, so the evaluator reads the same bytes it always did and says `description_not_json`
  // (a hard minimum that re-blocks the request). An unreadable description would end the run as
  // `evidence_unavailable` instead, an overridable review that could not run, on every restart;
  // the pre-send module still withholds it from the model.
  if (text.includes("\u0000") && name !== DESCRIPTION_FILE) {
    return { name, state: "not_utf8", text: null };
  }
  return { name, state: "present", text };
}

/** The root file each review document is read from, by the rule {@link readRootDocuments} reads by. */
function rootDocumentFiles(
  tree: Tree,
): Record<ReviewDocument, { name: string; entry: TreeEntry } | null> {
  const root = new Map<string, TreeEntry>();
  for (const entry of tree.entries) if (!entry.path.includes("/")) root.set(entry.path, entry);
  const rootNames = [...root.keys()];
  const out = {} as Record<ReviewDocument, { name: string; entry: TreeEntry } | null>;
  for (const document of REVIEW_DOCUMENTS) {
    const name = candidatesOf(document, rootNames).find((n) => root.has(n));
    const entry = name === undefined ? undefined : root.get(name);
    out[document] = name === undefined || entry === undefined ? null : { name, entry };
  }
  return out;
}

/**
 * The five root documents, each `absent` or as the depositor wrote it. The README is the first
 * present of the four BIDS forms (`shared/readme-candidates.ts`, the order the submission gate
 * uses), and the others are the exact BIDS names. Nothing here examines the text: that is the
 * pre-send module's job, over the string it is about to send.
 */
export function readRootDocuments(dir: string, tree: Tree): Record<ReviewDocument, RawDocument> {
  const files = rootDocumentFiles(tree);
  const out = {} as Record<ReviewDocument, RawDocument>;
  for (const document of REVIEW_DOCUMENTS) {
    const found = files[document];
    out[document] =
      found === null
        ? { name: "", state: "absent", text: null }
        : readDocument(dir, found.name, found.entry);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Facts from the description and the README
// ---------------------------------------------------------------------------------------------

type DescriptionFacts = Pick<
  PublicationReviewEvidence,
  | "minimums"
  | "minimum_failures"
  | "name_length"
  | "license_field"
  | "authors_count"
  | "placeholder_authors"
>;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ADR 0026's minimums and the facts the questions are lowered by, from the WHOLE raw
 * `dataset_description.json` and the WHOLE first README, never from the cut the model is shown.
 * `anonymous` inverts the Authors rule exactly as the request gate does. `readmeUnread` says the
 * README exists but could not be read at all; see the file header for why the ethics-statement
 * minimum is then left out.
 */
export function descriptionFacts(
  descriptionText: string | null,
  readmeText: string | null,
  anonymous: boolean,
  options: { readmeUnread?: boolean } = {},
): DescriptionFacts {
  let minimum_failures = submissionMinimumFailures(descriptionText, readmeText, {
    anonymousRelease: anonymous,
  });
  if (options.readmeUnread) {
    minimum_failures = minimum_failures.filter((f) => f !== "ethics_statement_missing");
  }
  const desc = parseObject(descriptionText);
  const name = desc !== null && typeof desc.Name === "string" ? desc.Name.trim() : "";
  const license = desc !== null && typeof desc.License === "string" ? desc.License.trim() : "";
  const authors =
    desc !== null && Array.isArray(desc.Authors)
      ? desc.Authors.filter((a): a is string => typeof a === "string" && a.trim().length > 0).map(
          (a) => a.trim(),
        )
      : [];
  return {
    minimums: minimum_failures.length > 0 ? "failed" : "met",
    minimum_failures,
    name_length: name.length,
    license_field: license.length > 0,
    authors_count: authors.length,
    placeholder_authors: authors.filter(isPlaceholderAuthor).length,
  };
}

/**
 * The version `dataset_description.json` declares. The orchestrator publishes
 * `String(Version || "1.0.0")`, so every falsy value is "missing" here as well; a present value
 * that is not `X.Y.Z` is malformed, and only an `X.Y.Z` string is carried as the version.
 */
export function versionFacts(descriptionText: string | null): {
  version: string | null;
  shape: VersionShape;
} {
  const v = parseObject(descriptionText)?.Version;
  if (!v) return { version: null, shape: "missing" };
  if (typeof v === "string" && SEMVER.test(v)) return { version: v, shape: "ok" };
  return { version: null, shape: "malformed" };
}

// ---------------------------------------------------------------------------------------------
// The tag and the BIDS run
// ---------------------------------------------------------------------------------------------

/**
 * Where the tag `v<version>` points, from `git ls-remote --tags` output. `version` is the one to
 * look up ({@link effectiveVersionOf}); null is a Version with nothing to look up, and is
 * `not_applicable`. Tags are annotated, so the line that names the commit is the peeled
 * `refs/tags/v<version>^{}` one, and it wins over the tag object's own line; a lightweight tag has
 * only the plain line, which is the commit.
 */
export function tagState(tagsText: string, version: string | null, head: string): TagState {
  if (version === null) return "not_applicable";
  const ref = `refs/tags/v${version}`;
  let direct: string | null = null;
  let peeled: string | null = null;
  for (const line of tagsText.split("\n")) {
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trimEnd());
    if (!m) continue;
    if (m[2] === ref) direct = m[1] as string;
    else if (m[2] === `${ref}^{}`) peeled = m[1] as string;
  }
  const target = peeled ?? direct;
  if (target === null) return "absent";
  return target === head ? "at_head" : "elsewhere";
}

/**
 * The newest BIDS validation run at the reviewed commit, from the workflow's run list. A run that
 * passed is `pass`, one that failed is `fail`; none, one still running and one that ended any other
 * way (cancelled, skipped, timed out) are `unconcluded`; a list that could not be read is `unknown`.
 * A run whose own commit is not `head` is never counted.
 */
export function bidsState(runsJson: string, head: string): BidsState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runsJson);
  } catch {
    return "unknown";
  }
  if (!isRecord(parsed) || parsed.unavailable === true || !Array.isArray(parsed.workflow_runs)) {
    return "unknown";
  }
  const runs = parsed.workflow_runs.filter(
    (r): r is Record<string, unknown> => isRecord(r) && r.head_sha === head,
  );
  if (runs.length === 0) return "unconcluded";
  const when = (r: Record<string, unknown>) =>
    typeof r.created_at === "string" ? r.created_at : "";
  const id = (r: Record<string, unknown>) => (typeof r.id === "number" ? r.id : 0);
  const newest = [...runs].sort((a, b) => when(b).localeCompare(when(a)) || id(b) - id(a))[0];
  if (newest === undefined || newest.status !== "completed") return "unconcluded";
  if (newest.conclusion === "success") return "pass";
  if (newest.conclusion === "failure") return "fail";
  return "unconcluded";
}

// ---------------------------------------------------------------------------------------------
// The structural summary: counts and closed words only
// ---------------------------------------------------------------------------------------------

/** What is not the dataset's own raw data: never counted as recordings, never sampled. */
export const NOT_RAW = /^(?:derivatives|sourcedata|code)\//;
/** A BIDS data sidecar: `..._<suffix>.json` for a signal modality. */
export const DATA_SIDECAR = /_(?:eeg|ieeg|meg|emg|nirs)\.json$/;

function datatypeOf(directory: string): ReviewDatatype {
  return (REVIEW_DATATYPES as readonly string[]).includes(directory)
    ? (directory as ReviewDatatype)
    : "other";
}

/** `n` entries spread evenly over a sorted list, so a sample does not depend on how it was ordered. */
function evenly<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)] as T);
}

/** The `n` most frequent values, ties to the smaller, returned ascending. */
function topValues(counts: Map<number, number>, n: number): number[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, n)
    .map(([value]) => value)
    .sort((a, b) => a - b);
}

/** The raw tree's data sidecars (no symlink: an annexed sidecar is never opened), in path order. */
function dataSidecars(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries
    .filter((e) => !NOT_RAW.test(e.path) && DATA_SIDECAR.test(e.path) && e.mode !== "120000")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every blob this module opens for a tree, by object id: the root documents it reads (never a
 * symlink, which is never opened) and the bounded sample of data sidecars {@link structuralSummary}
 * opens. The one place that says which blobs a review needs, for a caller that has to bring them
 * into a blob-less clone before the readers run. The workflow's fetch step is a shell
 * transcription of this selection, and a test holds the two equal.
 */
export function blobsToRead(tree: Tree): string[] {
  const oids = new Set<string>();
  for (const found of Object.values(rootDocumentFiles(tree))) {
    if (found !== null && found.entry.mode !== "120000") oids.add(found.entry.oid);
  }
  for (const entry of evenly(dataSidecars(tree.entries), SIDECAR_SAMPLE)) oids.add(entry.oid);
  return [...oids].sort();
}

/**
 * The two numbers one data sidecar contributes: its sampling rate (rounded to 0.01 hertz, which is
 * how the Worker's parser wants it) and its channel total (the sum of every `*ChannelCount` key).
 * Every other key and value of the sidecar is dropped here, unread.
 */
function sidecarNumbers(sidecar: Record<string, unknown>): {
  rate: number | null;
  channels: number | null;
} {
  const f = sidecar.SamplingFrequency;
  const rounded = typeof f === "number" && Number.isFinite(f) ? Math.round(f * 100) / 100 : 0;
  let channels = 0;
  for (const [key, value] of Object.entries(sidecar)) {
    if (key.endsWith("ChannelCount") && typeof value === "number" && Number.isSafeInteger(value)) {
      if (value > 0) channels += value;
    }
  }
  return {
    rate: rounded > 0 && rounded < MAX_SAMPLING_RATE_HZ ? rounded : null,
    channels: channels > 0 && channels <= MAX_COUNT ? channels : null,
  };
}

/**
 * Subjects, sessions, recordings, datatypes, formats, the three `has_*` flags, and the sampling
 * rates and channel counts of a bounded sample of data sidecars, from the tree's paths and
 * {@link SIDECAR_SAMPLE} sidecars. Recordings are counted in the raw tree only (outside
 * `derivatives/`, `sourcedata/` and `code/`), by the screen's own rule (`formatCoverage`), with EDF
 * and BDF as their own formats and every format the Worker's closed list does not name folded into
 * `.other`, so no file name rides in a key. No path, label or sidecar value is in the result.
 */
export function structuralSummary(dir: string, tree: Tree): StructuralSummary {
  const entries = tree.entries;
  const raw = entries.filter((e) => !NOT_RAW.test(e.path));

  const subjects = new Set<string>();
  const sessions = new Set<string>();
  const datatypes = new Set<ReviewDatatype>();
  for (const { path } of raw) {
    const segments = path.split("/");
    const subject = segments[0] as string;
    if (segments.length < 2 || !subject.startsWith("sub-")) continue;
    subjects.add(subject);
    let at = 1;
    if ((segments[1] as string).startsWith("ses-") && segments.length > 2) {
      sessions.add(`${subject}/${segments[1]}`);
      at = 2;
    }
    if (segments.length > at + 1) datatypes.add(datatypeOf(segments[at] as string));
  }

  const rawPaths = raw.map((e) => e.path);
  const formats: Record<string, number> = {};
  const add = (key: string, n: number) => {
    if (n > 0) formats[key] = (formats[key] ?? 0) + n;
  };
  const lower = rawPaths.map((p) => p.toLowerCase());
  add(".edf", lower.filter((p) => p.endsWith(".edf")).length);
  add(".bdf", lower.filter((p) => p.endsWith(".bdf")).length);
  for (const [format, n] of Object.entries(formatCoverage(rawPaths).unscreened)) {
    add(REVIEW_FORMATS.has(format) ? format : ".other", n);
  }
  const recordings = Object.values(formats).reduce((a, b) => a + b, 0);

  const sidecars = dataSidecars(entries);
  const rates = new Map<number, number>();
  const channels = new Map<number, number>();
  let sidecarsRead = 0;
  for (const entry of evenly(sidecars, SIDECAR_SAMPLE)) {
    const blob = readBlob(dir, entry.oid, SIDECAR_BYTE_CEILING);
    if (!blob.ok) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob.bytes.toString("utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    sidecarsRead++;
    const numbers = sidecarNumbers(parsed);
    if (numbers.rate !== null) rates.set(numbers.rate, (rates.get(numbers.rate) ?? 0) + 1);
    if (numbers.channels !== null) {
      channels.set(numbers.channels, (channels.get(numbers.channels) ?? 0) + 1);
    }
  }

  return {
    subjects: subjects.size,
    sessions: sessions.size,
    recordings,
    datatypes: [...datatypes].sort(),
    formats,
    has_derivatives: entries.some((e) => e.path.startsWith("derivatives/")),
    has_sourcedata: entries.some((e) => e.path.startsWith("sourcedata/")),
    has_code: entries.some((e) => e.path.startsWith("code/")),
    sampling_rates_hz: topValues(rates, MAX_SUMMARY_VALUES),
    channel_counts: topValues(channels, MAX_SUMMARY_VALUES),
    sidecars_read: sidecarsRead,
    sidecars_total: sidecars.length,
  };
}

// ---------------------------------------------------------------------------------------------
// The evidence block
// ---------------------------------------------------------------------------------------------

export interface EvidenceParts {
  head: string;
  anonymous: boolean;
  description: DescriptionFacts;
  version: { version: string | null; shape: VersionShape };
  tag: TagState;
  bids: BidsState;
  presend: PreSendResult;
  summary: StructuralSummary;
}

/**
 * The report's evidence block, from git and the pre-send result alone, validated by the Worker's
 * own parser. A block the parser refuses throws its fixed-word error: that is a bug on this side,
 * and the caller reports it as `report_invalid`.
 */
export function buildPublicationEvidence(parts: EvidenceParts): ReviewFacts {
  return parsePublicationReviewEvidence({
    head: parts.head,
    anonymous: parts.anonymous,
    version: parts.version.version,
    version_shape: parts.version.shape,
    tag: parts.tag,
    bids: parts.bids,
    ...parts.description,
    documents: parts.presend.states,
    withheld_findings: parts.presend.withheld_findings,
    description_keys_shown: parts.presend.description_keys_shown,
    description_keys_not_shown: parts.presend.description_keys_not_shown,
    summary: parts.summary,
  });
}

/** The states of a README that exists and could not be read as text. */
const UNREAD_STATES: readonly RawDocument["state"][] = ["annexed", "unreadable", "not_utf8"];

export interface DocumentEvidenceInputs {
  /** The commit the documents were read at: 40 hex. */
  head: string;
  /** The release kind: inverts the Authors rule, exactly as the request gate does. */
  anonymous: boolean;
  /**
   * `git ls-remote --tags` output; the empty string is a repository with no tag. `null` is a file
   * that could not be read, which is an evidence error: no tag state is invented for it.
   */
  tagsText: string | null;
  /** The BIDS validation workflow's runs at `head`, or `null` when they could not be read (`unknown`). */
  bidsRuns: string | null;
  summary: StructuralSummary;
}

/**
 * The evidence and the cleared documents for the root documents of one commit: the single place the
 * review's facts are put together, run by the review job over what it read from git and by the
 * calibration over what it read from a corpus. The minimums and the version come from the whole raw
 * files, the pre-send check examines each document, and the Worker's parser validates the block.
 *
 * Throws {@link PublicationEvidenceError}: `description_unreadable` when the description exists and
 * could not be read (every fact below it would be invented), and `tags_unreadable` for a tags file
 * that could not be read.
 */
export function evidenceFromDocuments(
  docs: Record<ReviewDocument, RawDocument>,
  inputs: DocumentEvidenceInputs,
): { facts: ReviewFacts; cleared: ClearedDocuments } {
  const descriptionState = docs.dataset_description.state;
  if (descriptionState !== "present" && descriptionState !== "absent") {
    throw new PublicationEvidenceError("description_unreadable");
  }
  const description = descriptionFacts(
    docs.dataset_description.text,
    docs.readme.text,
    inputs.anonymous,
    { readmeUnread: UNREAD_STATES.includes(docs.readme.state) },
  );
  const version = versionFacts(docs.dataset_description.text);
  if (inputs.tagsText === null) throw new PublicationEvidenceError("tags_unreadable");
  const checked = presend(docs);
  const facts = buildPublicationEvidence({
    head: inputs.head,
    anonymous: inputs.anonymous,
    description,
    version,
    // The tag of the version an approval would publish: the described one, or 1.0.0 when the
    // description sets none, so a release of 1.0.0 at another commit is found for a dataset with no
    // Version too. A malformed Version has nothing to look up.
    tag: tagState(
      inputs.tagsText,
      effectiveVersionOf({ version: version.version, version_shape: version.shape }),
      inputs.head,
    ),
    bids: inputs.bidsRuns === null ? "unknown" : bidsState(inputs.bidsRuns, inputs.head),
    presend: checked,
    summary: inputs.summary,
  });
  return { facts, cleared: checked.cleared };
}
