/**
 * The publication review's calibration tooling (ADR 0102, call 6), against REAL git repositories.
 *
 * The corpus builder clones local repositories made with the real `git` (a `file://` remote with
 * the filter capability stands in for the public hosting service, through the same git calls), and
 * reads them through the job's own readers. The calibration runs the job's real pre-send module,
 * prompt builder, model call and report assembly, with the REAL Anthropic SDK pointed at an HTTP
 * server in this file that answers the way the Messages API does. Nothing here reaches any other
 * host: a recorder around `fetch` says so, and a stand-in for the Worker is handed to `main` to
 * prove that nothing is posted to it.
 *
 * The properties the tooling depends on:
 *
 *  - the corpus holds the root documents and the structural summary and no recording data;
 *  - each defect is applied once, changes only the documents it targets, and is visible to the
 *    model (the production pre-send module sends the changed text);
 *  - the calibration sends exactly what production sends (a drift test compares the two requests),
 *    so a README that production withholds is withheld here too;
 *  - the records hold ids, labels, closed words, counts and timings, never a document's text or the
 *    model's words; the review sheet is the one place the model's words go, outside the repository.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  callPublicationReviewModel,
  main,
  runPublicationReview,
} from "../scripts/ci/publication-review";
import {
  CalibrationError,
  type CalibrationRecord,
  assertOutsideRepository,
  calibrate,
  defaultSheetPath,
  deriveOutcome,
  evidenceOf,
  isInsideRepository,
} from "../scripts/ci/publication-review-calibrate";
import {
  type CorpusEntry,
  CorpusError,
  DEFECTS,
  type Defect,
  ETHICS_BOILERPLATE,
  GENERIC_NAME,
  INJECTED_INSTRUCTION,
  LICENSE_FIELD_CC0,
  LICENSE_FIELD_CC_BY,
  LICENSE_TEXT_CC0,
  LICENSE_TEXT_CC_BY,
  PLACEHOLDER_AUTHORS,
  STUB_README,
  buildCorpus,
  cloneBlobless,
  cloneEnv,
  listEntries,
  mismatchedLicense,
  mutate,
  mutateCorpus,
  readEntry,
} from "../scripts/ci/publication-review-corpus";
import {
  blobsToRead,
  readRootDocuments,
  readTree,
  structuralSummary,
} from "../scripts/ci/publication-review-evidence";
import { presend } from "../scripts/ci/publication-review-presend";
import { assemblePublicationReport } from "../scripts/ci/publication-review-prompt";
import {
  ANSWERS,
  CALIBRATION_MODELS,
  DOCUMENT_CHAR_CAPS,
  DOCUMENT_STATES,
  PUBLICATION_FINDING_CODES,
  PUBLICATION_OUTCOMES,
  PUBLICATION_REVIEW_MODELS,
  PUBLICATION_RUN_ERRORS,
  PublicationReviewReportError,
  QUESTIONS,
  REASON_CODES,
  REVIEW_DOCUMENTS,
  type ReviewDocument,
  parsePublicationReviewReport,
  reportReasons,
} from "../shared/publication-review";
import {
  MIN_NAME_LENGTH,
  isPlaceholderAuthor,
  submissionMinimumFailures,
} from "../shared/submission-minimums";

let root: string;
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "/",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function write(dir: string, rel: string, content: string | Buffer) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "publication-review-calibration-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Datasets: local repositories that stand in for the public dataset repositories
// ---------------------------------------------------------------------------------------------

const SUBJECT = "sub-SENTINELSUBJ";
const EEG = `${SUBJECT}/eeg/${SUBJECT}_task-SENTINELTASK_eeg`;

/** Strings planted in the documents. None may reach a record. */
const README_SENTINEL = "SENTINEL_README_TEXT";
const NAME_SENTINEL = "SENTINEL_DESCRIPTION_NAME";
const ETHICS_SENTINEL = "SENTINEL_ETHICS_TEXT";
const CHANGES_SENTINEL = "SENTINEL_CHANGES_TEXT";
const LICENSE_SENTINEL = "SENTINEL_LICENSE_TEXT";
const PATH_SENTINEL = "sentinelperson";
const DOCUMENT_SENTINELS = [
  README_SENTINEL,
  NAME_SENTINEL,
  ETHICS_SENTINEL,
  CHANGES_SENTINEL,
  LICENSE_SENTINEL,
  PATH_SENTINEL,
];

const DESCRIPTION = {
  Name: `Resting state EEG of healthy volunteers ${NAME_SENTINEL}`,
  BIDSVersion: "1.9.0",
  Version: "1.0.0",
  License: "CC0",
  Authors: ["Ada Lovelace", "Alan Turing"],
  EthicsApprovals: [`IRB 2024-0001, University X ${ETHICS_SENTINEL}`],
};

const README = [
  "# Resting EEG",
  "",
  `Two volunteers recorded at rest with a 32 channel cap at 256 Hz. ${README_SENTINEL}.`,
  "",
  "Ethics: approved by the institutional review board of University X.",
  "",
].join("\n");

const BASE_FILES: Record<string, string | null> = {
  "dataset_description.json": JSON.stringify(DESCRIPTION),
  "README.md": README,
  CHANGES: `1.0.0 2026-01-01\n - Initial release ${CHANGES_SENTINEL}\n`,
  LICENSE: `Creative Commons Zero ${LICENSE_SENTINEL}\n`,
  "participants.json": JSON.stringify({ participant_id: { Description: "Unique label" } }),
  "participants.tsv": "participant_id\tSENTINEL_PARTICIPANT_ROW\nsub-SENTINELSUBJ\t30\n",
  [`${EEG}.edf`]: "recording bytes SENTINEL_RECORDING",
  [`${EEG}.json`]: JSON.stringify({
    TaskName: "SENTINEL_TASKNAME",
    SamplingFrequency: 256,
    EEGChannelCount: 32,
  }),
  "code/SENTINELDIR/run.py": "print(1)\n",
};

let originsDir: string;
let REMOTE_BASE: string;

interface Origin {
  dir: string;
  head: string;
}

/** A dataset repository at `<origins>/<id>.git` with `files` laid over the defaults. */
function newOrigin(id: string, files: Record<string, string | Buffer | null> = {}): Origin {
  const dir = join(originsDir, `${id}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  const all: Record<string, string | Buffer | null> = { ...BASE_FILES, ...files };
  for (const [rel, content] of Object.entries(all)) {
    if (content !== null) write(dir, rel, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

const origins: Record<string, Origin> = {};

beforeAll(() => {
  originsDir = join(root, "origins");
  REMOTE_BASE = `file://${originsDir}`;
  // A typical dataset: ethics in the description and the README, a version, a LICENSE.
  origins.nm000001 = newOrigin("nm000001");
  // A README that names a path on somebody's machine: production withholds it.
  origins.nm000002 = newOrigin("nm000002", {
    "README.md": `# Notes\n\nProcessed under /Users/${PATH_SENTINEL}/lab/eeg with a 32 channel cap.\n`,
  });
  // A README.rst, no ethics statement anywhere and no Version.
  origins.nm000003 = newOrigin("nm000003", {
    "README.md": null,
    "README.rst": `Resting EEG\n===========\n\nRecordings at rest. ${README_SENTINEL}.\n`,
    "dataset_description.json": JSON.stringify({
      Name: `Resting EEG without any ethics statement ${NAME_SENTINEL}`,
      BIDSVersion: "1.9.0",
      License: "CC0",
      Authors: ["Ada Lovelace"],
    }),
  });
  // No dataset_description.json: not a dataset the review can read.
  origins.nm000004 = newOrigin("nm000004", { "dataset_description.json": null });
  // Two commits, so a depth-one clone is visibly shallow.
  origins.nm000005 = newOrigin("nm000005");
  write(origins.nm000005.dir, "CHANGES", "1.0.1 2026-02-01\n - Later\n");
  git(origins.nm000005.dir, "commit", "-q", "-am", "second");
  origins.nm000005.head = git(origins.nm000005.dir, "rev-parse", "HEAD");
  // No README at all.
  origins.nm000006 = newOrigin("nm000006", { "README.md": null });
  // A README nobody can read (not UTF-8) and no ethics statement in the description: the minimum that
  // may rest on the README is left out, not failed. Kept out of the corpora the other tests count.
  origins.nm000007 = newOrigin("nm000007", {
    "README.md": Buffer.from([0xff, 0xfe, 0x41, 0x80]),
    "dataset_description.json": JSON.stringify({
      Name: `Resting EEG with a README nobody can read ${NAME_SENTINEL}`,
      BIDSVersion: "1.9.0",
      Version: "1.0.0",
      License: "CC0",
      Authors: ["Ada Lovelace"],
    }),
  });
});

/**
 * A `git` on the PATH that records, for each call, its subcommand, its `HOME` and whether lazy
 * fetching was left on, and then runs the real git (stdin of a fetch is kept, so the objects it
 * asked for can be read back). With `failFetch` it stands in for a network that goes away: a fetch
 * exits 1 and nothing else changes.
 */
function gitSpy(options: { failFetch?: boolean } = {}) {
  const dir = mkdtempSync(join(root, "gitspy-"));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const log = join(dir, "calls.txt");
  const stdin = join(dir, "fetch-stdin.txt");
  const script = [
    "#!/usr/bin/env bash",
    "sub=",
    'for a in "$@"; do case "$a" in clone|fetch|cat-file|ls-tree|rev-parse) sub="$a"; break ;; esac; done',
    `printf '%s\\t%s\\t%s\\n' "$sub" "$HOME" "\${GIT_NO_LAZY_FETCH:-lazy}" >> "${log}"`,
    options.failFetch ? 'if [ "$sub" = fetch ]; then exit 1; fi' : "",
    `if [ "$sub" = fetch ]; then cat > "${stdin}"; exec "${real}" "$@" < "${stdin}"; fi`,
    `exec "${real}" "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "git"), script);
  chmodSync(join(dir, "git"), 0o755);
  return {
    dir,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => {
              const [sub, home, lazy] = l.split("\t") as [string, string, string];
              return { sub, home, lazy };
            })
        : [],
    fetched: () => (existsSync(stdin) ? readFileSync(stdin, "utf8").trim().split("\n").sort() : []),
  };
}

/** Run `body` with the spy first on the PATH, which every git child process of this file inherits. */
async function withSpy<T>(spy: { dir: string }, body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${spy.dir}:${saved ?? ""}`;
  try {
    return await body();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = saved;
  }
}

// ---------------------------------------------------------------------------------------------
// The corpus builder
// ---------------------------------------------------------------------------------------------

const CLOSED_FILES = [
  "CHANGES",
  "LICENSE",
  "README.md",
  "dataset_description.json",
  "entry.json",
  "participants.json",
  "summary.json",
];

/** The four datasets the review can read, as the builder stores them. */
let goodCorpus: string;
/** The same, with one copy of each defect added. */
let mutatedCorpus: string;

beforeAll(async () => {
  goodCorpus = join(root, "corpus-good");
  const result = await buildCorpus({
    ids: ["nm000001", "nm000002", "nm000003", "nm000004", "nm000006", "nm000099"],
    outDir: goodCorpus,
    remoteBase: REMOTE_BASE,
  });
  if (result.built !== 4) throw new Error("the test corpus did not build");
  mutatedCorpus = join(root, "corpus-calibrate");
  cpSync(goodCorpus, mutatedCorpus, { recursive: true });
  if (mutateCorpus(mutatedCorpus, { perDefect: 1 }).made !== DEFECTS.length) {
    throw new Error("the test corpus did not get one copy of each defect");
  }
});

describe("the corpus builder reads public repositories through the job's own readers", () => {
  test("it reports what it built and what it skipped, with a closed word each", async () => {
    const again = await buildCorpus({
      ids: ["nm000001", "nm000004", "nm000099"],
      outDir: join(root, "corpus-report"),
      remoteBase: REMOTE_BASE,
    });
    expect(again.built).toBe(1);
    expect(again.skipped).toBe(2);
    expect(again.skips).toEqual([
      { id: "nm000004", reason: "description_unreadable" },
      { id: "nm000099", reason: "clone_failed" },
    ]);
  });

  test("an entry is the root documents and the summary: no recording, table or code is stored", () => {
    expect(readdirSync(goodCorpus).sort()).toEqual([
      "nm000001",
      "nm000002",
      "nm000003",
      "nm000006",
    ]);
    expect(readdirSync(join(goodCorpus, "nm000001")).sort()).toEqual(CLOSED_FILES);
    const everything = readdirSync(goodCorpus, { recursive: true, encoding: "utf8" });
    for (const path of everything) {
      expect(path).not.toMatch(/\.(edf|tsv)$/);
      expect(path).not.toContain("sub-");
      expect(path).not.toContain("SENTINELDIR");
    }
    for (const id of ["nm000001", "nm000002", "nm000003", "nm000006"]) {
      const text = readdirSync(join(goodCorpus, id))
        .map((f) => readFileSync(join(goodCorpus, id, f), "utf8"))
        .join("\n");
      expect(text, id).not.toContain("SENTINEL_RECORDING");
      expect(text, id).not.toContain("SENTINEL_PARTICIPANT_ROW");
      expect(text, id).not.toContain("SENTINEL_TASKNAME");
      expect(text, id).not.toContain("SENTINELSUBJ");
      expect(text, id).not.toContain("SENTINELTASK");
    }
  });

  test("the documents and the summary are exactly what the job's readers return for the commit", async () => {
    const origin = origins.nm000001 as Origin;
    const tree = await readTree(origin.dir, origin.head);
    const docs = readRootDocuments(origin.dir, tree);
    const entry = readEntry(join(goodCorpus, "nm000001"));
    expect(entry).toMatchObject({ id: "nm000001", label: "good", base: "nm000001" });
    expect(entry.head).toBe(origin.head);
    expect(entry.docs).toEqual(docs);
    expect(entry.summary).toEqual(structuralSummary(origin.dir, tree));
    expect(entry.summary.subjects).toBe(1);
    expect(entry.summary.sampling_rates_hz).toEqual([256]);
  });

  test("each README form is kept under its own name, and a missing document is absent", () => {
    const rst = readEntry(join(goodCorpus, "nm000003"));
    expect(rst.docs.readme).toMatchObject({ name: "README.rst", state: "present" });
    expect(rst.docs.readme.text).toContain(README_SENTINEL);
    const none = readEntry(join(goodCorpus, "nm000006"));
    expect(none.docs.readme).toEqual({ name: "", state: "absent", text: null });
    expect(readdirSync(join(goodCorpus, "nm000006"))).not.toContain("README.md");
  });

  test("the clone is shallow and blob-less, so no recording data is ever fetched", () => {
    const dest = join(root, "clone-check");
    const home = join(root, "clone-home");
    mkdirSync(home, { recursive: true });
    cloneBlobless(`${REMOTE_BASE}/nm000005.git`, dest, home);
    expect(git(dest, "rev-list", "--count", "HEAD")).toBe("1");
    const readmeBlob = git((origins.nm000005 as Origin).dir, "rev-parse", "HEAD:README.md");
    expect(() =>
      execFileSync("git", ["-C", dest, "cat-file", "-e", readmeBlob], {
        env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" },
        stdio: "ignore",
      }),
    ).toThrow();
    // Nothing was checked out either.
    expect(readdirSync(dest)).toEqual([".git"]);
  });

  test("the blobs the readers open are fetched in ONE anonymous fetch, exactly those and no others", async () => {
    const origin = origins.nm000001 as Origin;
    const spy = gitSpy();
    const out = join(root, "corpus-prefetch");
    const result = await withSpy(spy, () =>
      buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase: REMOTE_BASE }),
    );
    expect(result).toMatchObject({ built: 1, skipped: 0 });

    // The readers' own selection: the five root documents and the one sidecar, not the participants
    // table, not the recording and not the code, which the origin holds too.
    const wanted = blobsToRead(await readTree(origin.dir, origin.head));
    expect(wanted).toHaveLength(6);
    const every = git(origin.dir, "ls-tree", "-r", "HEAD").split("\n").length;
    expect(every).toBeGreaterThan(wanted.length);
    expect(spy.fetched()).toEqual(wanted);

    // One fetch for the clone's blobs, and it runs in the clone's own empty home, as the clone does.
    const calls = spy.calls();
    expect(calls.filter((c) => c.sub === "fetch")).toHaveLength(1);
    const homes = new Set(
      calls.filter((c) => ["clone", "fetch"].includes(c.sub)).map((c) => c.home),
    );
    expect(homes.size).toBe(1);
    const [home] = [...homes] as [string];
    expect(home).not.toBe(process.env.HOME);
    expect(home).toMatch(/publication-review-corpus-[^/]+\/home$/);

    // And the readers fetch nothing of their own: every read of the tree and of a blob ran with lazy
    // fetching off, so a gap in the batch would have been a missing blob and not a hidden request.
    const reads = calls.filter((c) => c.sub === "cat-file" || c.sub === "ls-tree");
    expect(reads.some((c) => c.sub === "cat-file")).toBe(true);
    expect(reads.some((c) => c.sub === "ls-tree")).toBe(true);
    expect(reads.filter((c) => c.lazy !== "1")).toEqual([]);
  });

  test("a fetch that fails is a clone that failed, never a README read as unreadable", async () => {
    const spy = gitSpy({ failFetch: true });
    const out = join(root, "corpus-prefetch-fails");
    const result = await withSpy(spy, () =>
      buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase: REMOTE_BASE }),
    );
    // The clone itself succeeded (only a `fetch` is cut off), so what is skipped is the dataset
    // whose blobs could not be brought in, and nothing half-read is stored.
    expect(result.built).toBe(0);
    expect(result.skips).toEqual([{ id: "nm000001", reason: "clone_failed" }]);
    expect(existsSync(join(out, "nm000001"))).toBe(false);
  });

  test("the clone carries no credential of the operator's: an empty home and nothing inherited", () => {
    const planted: Record<string, string> = {
      GH_TOKEN: "planted",
      GITHUB_TOKEN: "planted",
      GIT_ASKPASS: "/bin/planted",
      SSH_ASKPASS: "/bin/planted",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic planted",
      GIT_CONFIG_GLOBAL: "/planted",
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(planted)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const env = cloneEnv("/an/empty/home");
      expect(Object.keys(env).sort()).toEqual([
        "GIT_ALLOW_PROTOCOL",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LC_ALL",
        "PATH",
      ]);
      expect(env).toMatchObject({
        HOME: "/an/empty/home",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "https:file",
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  });

  test("an entry already in the corpus is left alone", async () => {
    const out = join(root, "corpus-exists");
    await buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase: REMOTE_BASE });
    const before = readFileSync(join(out, "nm000001", "README.md"), "utf8");
    writeFileSync(join(out, "nm000001", "README.md"), "edited by hand\n");
    const again = await buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase: REMOTE_BASE });
    expect(again).toMatchObject({ built: 0, skipped: 1 });
    expect(again.skips).toEqual([{ id: "nm000001", reason: "entry_exists" }]);
    expect(readFileSync(join(out, "nm000001", "README.md"), "utf8")).toBe("edited by hand\n");
    expect(before).toContain(README_SENTINEL);
  });

  test("an id or a remote that is not a public https or file location is refused before any clone", async () => {
    const out = join(root, "corpus-refused");
    for (const id of ["nm00001", "../nm000001", "nm000001/x", "NM000001", "nm000001 ", ""]) {
      await expect(
        buildCorpus({ ids: [id], outDir: out, remoteBase: REMOTE_BASE }),
        JSON.stringify(id),
      ).rejects.toMatchObject({ code: "bad_id" });
    }
    for (const remoteBase of ["git://corpus.invalid/x", "ssh://corpus.invalid/x", "ext::sh", "x"]) {
      await expect(
        buildCorpus({ ids: ["nm000001"], outDir: out, remoteBase }),
      ).rejects.toMatchObject({ code: "bad_remote" });
    }
    expect(existsSync(out)).toBe(false);
  });
});

describe("an entry is read back only if it is exactly what the builder writes", () => {
  function tampered(change: (meta: Record<string, unknown>) => void): string {
    const dir = join(root, `corpus-tampered-${++tamperSeq}`, "nm000001");
    cpSync(join(goodCorpus, "nm000001"), dir, { recursive: true });
    // A file the entry has no business reading, where a name with `..` in it would find it.
    writeFileSync(join(dirname(dir), "outside.md"), "outside the entry\n");
    const meta = JSON.parse(readFileSync(join(dir, "entry.json"), "utf8")) as Record<
      string,
      unknown
    >;
    change(meta);
    writeFileSync(join(dir, "entry.json"), JSON.stringify(meta));
    return dir;
  }
  let tamperSeq = 0;
  const documents = (meta: Record<string, unknown>) =>
    meta.documents as Record<string, Record<string, unknown>>;

  test.each([
    [
      "a file name outside the closed lists",
      (m: Record<string, unknown>) => {
        documents(m).readme = { name: "../outside.md", state: "present" };
      },
    ],
    [
      "a name for a document that is absent",
      (m: Record<string, unknown>) => {
        documents(m).changes = { name: "CHANGES", state: "absent" };
      },
    ],
    [
      "a state that is not one of the five",
      (m: Record<string, unknown>) => {
        documents(m).readme = { name: "README.md", state: "sent" };
      },
    ],
    [
      "a label that is not a defect",
      (m: Record<string, unknown>) => {
        m.label = "worse";
      },
    ],
    [
      "an id that does not follow from the base and the label",
      (m: Record<string, unknown>) => {
        m.id = "nm000009";
      },
    ],
    [
      "a head that is not a commit id",
      (m: Record<string, unknown>) => {
        m.head = "main";
      },
    ],
    [
      "a key it does not write",
      (m: Record<string, unknown>) => {
        m.note = "x";
      },
    ],
    [
      "a document missing from the list",
      (m: Record<string, unknown>) => {
        Reflect.deleteProperty(documents(m), "license");
      },
    ],
  ])("%s is refused", (_why, change) => {
    expect(() => readEntry(tampered(change))).toThrow("bad_entry");
  });

  test("a present document whose file is gone is refused, and an untouched entry reads fine", () => {
    const dir = tampered(() => {});
    expect(readEntry(dir).id).toBe("nm000001");
    rmSync(join(dir, "README.md"));
    expect(() => readEntry(dir)).toThrow("bad_entry");
  });

  test("a directory in a corpus that is named for another id is refused", () => {
    const corpus = join(root, "corpus-misnamed");
    cpSync(join(goodCorpus, "nm000001"), join(corpus, "nm000002"), { recursive: true });
    expect(() => listEntries(corpus)).toThrow("bad_entry");
  });
});

// ---------------------------------------------------------------------------------------------
// The defect mutator
// ---------------------------------------------------------------------------------------------

/** The documents each defect is meant to change, and no others. */
const TOUCHES: Record<Defect, ReviewDocument[]> = {
  stub_readme: ["readme"],
  ethics_removed: ["readme", "dataset_description"],
  ethics_boilerplate: ["readme", "dataset_description"],
  placeholder_authors: ["dataset_description"],
  license_mismatch: ["dataset_description", "license"],
  name_not_descriptive: ["dataset_description"],
  readme_contradicts_counts: ["readme"],
  embedded_instruction: ["readme"],
};

function changedDocuments(before: CorpusEntry, after: CorpusEntry): ReviewDocument[] {
  return REVIEW_DOCUMENTS.filter(
    (d) => JSON.stringify(before.docs[d]) !== JSON.stringify(after.docs[d]),
  );
}

/** What the model would be shown of a document, by the production pre-send module. */
function shown(entry: CorpusEntry): Partial<Record<ReviewDocument, string>> {
  return presend(entry.docs).cleared;
}

function descriptionOf(entry: CorpusEntry): Record<string, unknown> {
  return JSON.parse(entry.docs.dataset_description.text as string) as Record<string, unknown>;
}

function minimumFailuresOf(entry: CorpusEntry): string[] {
  return submissionMinimumFailures(entry.docs.dataset_description.text, entry.docs.readme.text);
}

/** True when `text` holds a statement the submission gate's own rule reads as an ethics statement. */
function mentionsEthics(text: string): boolean {
  const description = JSON.stringify({ Name: "x".repeat(MIN_NAME_LENGTH), Authors: ["A. Person"] });
  return !submissionMinimumFailures(description, text).includes("ethics_statement_missing");
}

/** Each defect, asserted from the mutated FILES with the shared rules, never with the mutator's own check. */
const VISIBLE: Record<Defect, (before: CorpusEntry, after: CorpusEntry) => void> = {
  stub_readme: (before, after) => {
    expect(after.docs.readme.text).toBe(STUB_README);
    expect((after.docs.readme.text as string).length).toBeLessThan(80);
    expect(before.docs.readme.text).not.toBe(STUB_README);
  },
  ethics_removed: (before, after) => {
    expect(minimumFailuresOf(before)).not.toContain("ethics_statement_missing");
    expect(minimumFailuresOf(after)).toContain("ethics_statement_missing");
    expect(descriptionOf(after)).not.toHaveProperty("EthicsApprovals");
  },
  ethics_boilerplate: (before, after) => {
    expect(descriptionOf(before).EthicsApprovals).not.toEqual([ETHICS_BOILERPLATE]);
    expect(descriptionOf(after).EthicsApprovals).toEqual([ETHICS_BOILERPLATE]);
    // The mechanical gate still passes: that is why a reviewer is needed.
    expect(minimumFailuresOf(after)).not.toContain("ethics_statement_missing");
    expect(mentionsEthics(after.docs.readme.text as string)).toBe(false);
  },
  placeholder_authors: (before, after) => {
    const authors = descriptionOf(after).Authors as string[];
    expect(authors).toEqual([...PLACEHOLDER_AUTHORS]);
    for (const a of authors) expect(isPlaceholderAuthor(a), a).toBe(true);
    expect((descriptionOf(before).Authors as string[]).some(isPlaceholderAuthor)).toBe(false);
  },
  license_mismatch: (before, after) => {
    // The field changes, and the LICENSE text names the other license: a CC0 dataset becomes
    // CC-BY-4.0 over a CC0 text.
    expect(descriptionOf(before).License).toBe("CC0");
    expect(descriptionOf(after).License).toBe("CC-BY-4.0");
    const text = after.docs.license.text as string;
    expect(text).toContain("Zero");
    expect(text).not.toContain("Attribution");
    expect(before.docs.license.text).not.toBe(text);
  },
  name_not_descriptive: (before, after) => {
    const name = descriptionOf(after).Name as string;
    expect(name).toBe(GENERIC_NAME);
    // Above the mechanical floor, so only a reader can tell it does not describe the data.
    expect(name.length).toBeGreaterThanOrEqual(MIN_NAME_LENGTH);
    expect(descriptionOf(before).Name).not.toBe(name);
  },
  readme_contradicts_counts: (before, after) => {
    const claim = /(\d+) participants/.exec(after.docs.readme.text as string);
    expect(claim).not.toBeNull();
    expect(Number((claim as RegExpExecArray)[1])).not.toBe(after.summary.subjects);
    expect(after.summary).toEqual(before.summary);
  },
  embedded_instruction: (before, after) => {
    expect(after.docs.readme.text).toContain(INJECTED_INSTRUCTION);
    expect(before.docs.readme.text).not.toContain(INJECTED_INSTRUCTION);
    expect(INJECTED_INSTRUCTION).toMatch(/REVIEWER/);
  },
};

describe("each defect is applied once, to a copy, and is visible in the mutated files", () => {
  test("the list is the eight the design note names", () => {
    expect([...DEFECTS]).toEqual([
      "stub_readme",
      "ethics_removed",
      "ethics_boilerplate",
      "placeholder_authors",
      "license_mismatch",
      "name_not_descriptive",
      "readme_contradicts_counts",
      "embedded_instruction",
    ]);
    expect(Object.keys(TOUCHES).sort()).toEqual([...DEFECTS].sort());
    expect(Object.keys(VISIBLE).sort()).toEqual([...DEFECTS].sort());
  });

  test.each([...DEFECTS])("%s", (defect) => {
    const base = join(goodCorpus, "nm000001");
    const out = join(root, `mutant-${defect}`);
    const before = readEntry(base);
    mutate(base, defect, out);
    const after = readEntry(out);

    // A copy: the entry it came from is untouched, and the copy says what it is.
    expect(readEntry(base)).toEqual(before);
    expect(after).toMatchObject({
      id: `nm000001.${defect}`,
      label: defect,
      base: "nm000001",
      head: before.head,
    });
    expect(
      readdirSync(out)
        .sort()
        .every((f) => CLOSED_FILES.includes(f)),
    ).toBe(true);

    // Applied once: only the targeted documents differ, byte for byte.
    expect(changedDocuments(before, after)).toEqual(TOUCHES[defect]);
    VISIBLE[defect](before, after);

    // Visible to the model: the production pre-send module sends the changed text.
    const was = shown(before);
    const now = shown(after);
    for (const d of TOUCHES[defect]) {
      expect(now[d], d).toBeDefined();
      expect(now[d], d).not.toBe(was[d]);
    }
    for (const d of REVIEW_DOCUMENTS.filter((x) => !TOUCHES[defect].includes(x))) {
      expect(now[d], d).toBe(was[d]);
    }
  });

  test("license_mismatch writes the other license whichever one the dataset has", () => {
    expect(mismatchedLicense("CC0")).toEqual({
      field: LICENSE_FIELD_CC_BY,
      text: LICENSE_TEXT_CC0,
    });
    for (const other of ["CC-BY-4.0", "ODC-By-1.0", "", undefined, 7]) {
      expect(mismatchedLicense(other)).toEqual({
        field: LICENSE_FIELD_CC0,
        text: LICENSE_TEXT_CC_BY,
      });
    }
    const dir = join(root, "corpus-license", "nm000001");
    cpSync(join(goodCorpus, "nm000001"), dir, { recursive: true });
    const description = descriptionOf(readEntry(dir));
    writeFileSync(
      join(dir, "dataset_description.json"),
      JSON.stringify({ ...description, License: "ODC-By-1.0" }),
    );
    const out = join(root, "corpus-license", "mutant");
    mutate(dir, "license_mismatch", out);
    const after = readEntry(out);
    expect(descriptionOf(after).License).toBe("CC0");
    expect(after.docs.license.text).toBe(LICENSE_TEXT_CC_BY);
  });

  test("a defect that would change nothing the model reads is refused and leaves nothing behind", () => {
    // nm000003 has no ethics statement anywhere, so there is none to remove.
    const out = join(root, "mutant-noop");
    expect(() => mutate(join(goodCorpus, "nm000003"), "ethics_removed", out)).toThrow(CorpusError);
    try {
      mutate(join(goodCorpus, "nm000003"), "ethics_removed", out);
    } catch (e) {
      expect((e as CorpusError).code).toBe("mutation_not_visible");
    }
    expect(existsSync(out)).toBe(false);
  });

  test("a removal that leaves the statement behind is refused, however much else it changed", () => {
    // The statement is wrapped over two lines, so removing lines one at a time cannot find it. The
    // description still loses its EthicsApprovals and the copy would look different to the model,
    // but it would still carry an ethics statement: it is not an ethics_removed copy.
    const base = join(root, "corpus-wrapped", "nm000001");
    cpSync(join(goodCorpus, "nm000001"), base, { recursive: true });
    writeFileSync(
      join(base, "README.md"),
      "# Resting EEG\n\nThe study was approved by the institutional review\nboard of University X.\n",
    );
    const out = join(root, "corpus-wrapped", "mutant");
    expect(() => mutate(base, "ethics_removed", out)).toThrow("mutation_not_visible");
    expect(existsSync(out)).toBe(false);
  });

  test("a README the model would never be shown cannot carry a README defect", () => {
    // nm000002's README names a local path, so production withholds it.
    const out = join(root, "mutant-withheld");
    expect(() => mutate(join(goodCorpus, "nm000002"), "embedded_instruction", out)).toThrow(
      "mutation_not_visible",
    );
    expect(existsSync(out)).toBe(false);
    // A defect in a document the model does see is fine on the same entry.
    mutate(join(goodCorpus, "nm000002"), "placeholder_authors", join(root, "mutant-withheld-ok"));
    expect(existsSync(join(root, "mutant-withheld-ok", "entry.json"))).toBe(true);
  });

  test("a defect that needs a document the entry lacks is not applicable", () => {
    const out = join(root, "mutant-no-readme");
    expect(() => mutate(join(goodCorpus, "nm000006"), "stub_readme", out)).toThrow(
      "mutation_not_applicable",
    );
    expect(existsSync(out)).toBe(false);
  });

  test("a copy is never mutated again: it would carry two defects under one label", () => {
    const first = join(root, "mutant-twice-1");
    mutate(join(goodCorpus, "nm000001"), "placeholder_authors", first);
    const second = join(root, "mutant-twice-2");
    expect(() => mutate(first, "stub_readme", second)).toThrow("mutation_not_applicable");
    expect(existsSync(second)).toBe(false);
  });

  // A directory made with no permission to create a file in it: the umask is the real filesystem's
  // way to make the write fail after the directory exists. Not meaningful for root, which ignores it.
  test.skipIf(process.getuid?.() === 0)(
    "a write that fails after the directory was made leaves no half-written entry behind",
    () => {
      const out = join(root, "mutant-write-fails");
      const saved = process.umask(0o377);
      try {
        expect(() => mutate(join(goodCorpus, "nm000001"), "stub_readme", out)).toThrow();
      } finally {
        process.umask(saved);
      }
      // A directory without entry.json is not an entry, and listEntries would refuse the corpus.
      expect(existsSync(out)).toBe(false);
    },
  );

  test("an existing directory is never overwritten", () => {
    const out = join(root, "mutant-exists");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "kept");
    expect(() => mutate(join(goodCorpus, "nm000001"), "stub_readme", out)).toThrow("out_exists");
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("kept");
  });

  test("the README insertions land inside what the model is shown, even in a very long README", () => {
    const longBase = join(root, "corpus-long", "nm000001");
    cpSync(join(goodCorpus, "nm000001"), longBase, { recursive: true });
    const readme = readFileSync(join(longBase, "README.md"), "utf8");
    writeFileSync(
      join(longBase, "README.md"),
      `${readme}\n${"A line of text that keeps going.\n".repeat(2000)}`,
    );
    expect((readEntry(longBase).docs.readme.text as string).length).toBeGreaterThan(
      DOCUMENT_CHAR_CAPS.readme,
    );
    for (const defect of ["embedded_instruction", "readme_contradicts_counts"] as const) {
      const out = join(root, "corpus-long", `out-${defect}`);
      mutate(longBase, defect, out);
      expect(shown(readEntry(out)).readme).toContain(
        defect === "embedded_instruction" ? INJECTED_INSTRUCTION : " participants.",
      );
    }
  });
});

describe("a corpus of mutated copies is chosen deterministically", () => {
  test("one copy of each defect, each from an entry it works on, with distinct ids", () => {
    const dir = join(root, "corpus-mutated");
    cpSync(goodCorpus, dir, { recursive: true });
    const result = mutateCorpus(dir, { perDefect: 1 });
    expect(result.made).toBe(DEFECTS.length);
    const mutated = listEntries(dir).filter((e) => e.label !== "good");
    expect(mutated.map((e) => e.label).sort()).toEqual([...DEFECTS].sort());
    expect(new Set(mutated.map((e) => e.id)).size).toBe(DEFECTS.length);
    for (const e of mutated) {
      expect(e.id).toBe(`${e.base}.${e.label}`);
      expect(listEntries(dir).some((g) => g.id === e.base && g.label === "good")).toBe(true);
    }
  });

  test("the same corpus gives the same copies, file for file", () => {
    const a = join(root, "corpus-mutated-a");
    const b = join(root, "corpus-mutated-b");
    cpSync(goodCorpus, a, { recursive: true });
    cpSync(goodCorpus, b, { recursive: true });
    mutateCorpus(a, { perDefect: 2 });
    mutateCorpus(b, { perDefect: 2 });
    const files = (dir: string) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .sort()
        .map((f) => [f, existsSync(join(dir, f)) ? safeRead(join(dir, f)) : null]);
    expect(files(a)).toEqual(files(b));
    expect(files(a).length).toBeGreaterThan(listEntries(goodCorpus).length * 5);
  });

  test("asking for more copies than there are entries stops at what works", () => {
    const dir = join(root, "corpus-mutated-many");
    cpSync(goodCorpus, dir, { recursive: true });
    const result = mutateCorpus(dir, { perDefect: 50 });
    expect(result.made).toBeLessThanOrEqual(DEFECTS.length * 4);
    expect(result.made).toBeGreaterThan(DEFECTS.length);
    expect(result.skipped).toBeGreaterThan(0);
  });
});

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// A stand-in for api.anthropic.com, spoken to by the real SDK, and a recorder around fetch
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..");
// No underscores: the shared sanitizer strips markup characters from the model's words.
const MODEL_SUMMARY_SENTINEL = "SENTINELMODELSUMMARY";
const MODEL_NOTE_SENTINEL = "SENTINELMODELNOTE";
const USAGE = { input_tokens: 1234, output_tokens: 56 };

interface ModelRequest {
  method: string;
  path: string;
  raw: string;
  body: Record<string, unknown>;
}
const modelRequests: ModelRequest[] = [];
const fetched: string[] = [];

const PASS_ANSWERS = {
  complete_and_honest: "pass",
  meets_standards: "pass",
  authors_and_license: "pass",
  name_adequate: "pass",
};
const PASS_OUTPUT = {
  questions: PASS_ANSWERS,
  findings: [],
  summary: `A resting EEG dataset. ${MODEL_SUMMARY_SENTINEL}`,
  steering: false,
};

/** A Messages API reply whose one text block holds `text`. */
function messageReply(text: string, stopReason = "end_turn"): Response {
  return Response.json({
    id: "msg_stand_in",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: USAGE,
  });
}

/** A failure the SDK must not retry, so a test is not slowed by its backoff. */
function failureReply(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
}

let modelReply: (req: ModelRequest) => Response = () => messageReply(JSON.stringify(PASS_OUTPUT));
let modelServer: ReturnType<typeof Bun.serve>;
const SDK_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_IDENTITY_TOKEN",
  "PUBLICATION_REVIEW_CALLBACK_TOKEN",
] as const;
const savedSdkEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeAll(() => {
  modelServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const raw = await req.text();
      const request: ModelRequest = {
        method: req.method,
        path: new URL(req.url).pathname,
        raw,
        body: JSON.parse(raw || "{}") as Record<string, unknown>,
      };
      modelRequests.push(request);
      return modelReply(request);
    },
  });
  for (const k of SDK_ENV) {
    savedSdkEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-ant-stand-in";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${modelServer.port}`;
  // A recorder, not a replacement: every call still goes to the real fetch, and the test says where.
  const recorder = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return realFetch(input, init);
  };
  globalThis.fetch = Object.assign(recorder, { preconnect: realFetch.preconnect });
});
afterAll(() => {
  globalThis.fetch = realFetch;
  modelServer.stop(true);
  for (const k of SDK_ENV) {
    if (savedSdkEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedSdkEnv[k];
  }
});
beforeEach(() => {
  modelRequests.length = 0;
  fetched.length = 0;
  modelReply = () => messageReply(JSON.stringify(PASS_OUTPUT));
});

// ---------------------------------------------------------------------------------------------
// Running the calibration
// ---------------------------------------------------------------------------------------------

let seq = 0;

function oneEntryCorpus(id: string): string {
  const dir = join(root, `corpus-one-${++seq}`);
  cpSync(join(mutatedCorpus, id), join(dir, id), { recursive: true });
  return dir;
}

function readRecords(path: string): CalibrationRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as CalibrationRecord);
}

async function run(corpusDir: string, over: Partial<Parameters<typeof calibrate>[0]> = {}) {
  const out = join(root, `records-${++seq}.jsonl`);
  const result = await calibrate({ corpusDir, out, ...over });
  return { result, out, records: readRecords(out) };
}

/** The request body with the run's random nonce made constant, for comparing two runs' prompts. */
function withoutNonce(raw: string): string {
  return raw.replace(/[0-9a-f]{32}/g, "<nonce>");
}

const MODEL_ORIGIN = () => `http://127.0.0.1:${modelServer.port}`;

describe("calibrate runs the production review over every entry and records one line each", () => {
  test("one record per entry, in id order, with the model's token counts and a timing", async () => {
    const { result, records } = await run(mutatedCorpus);
    const ids = listEntries(mutatedCorpus).map((e) => e.id);
    expect(ids.length).toBe(4 + DEFECTS.length);
    expect(records.map((r) => r.id)).toEqual(ids);
    expect(result).toMatchObject({ records: ids.length, errors: 0 });
    for (const r of records) {
      expect(r.model).toBe("claude-haiku-5-5");
      expect(r.input_tokens).toBe(USAGE.input_tokens);
      expect(r.output_tokens).toBe(USAGE.output_tokens);
      expect(Number.isFinite(r.ms) && r.ms >= 0).toBe(true);
      expect(r.error).toBeNull();
    }
    expect(records.filter((r) => r.label === "good")).toHaveLength(4);
    expect(new Set(records.map((r) => r.label)).size).toBe(1 + DEFECTS.length);
  });

  test("the request is the production request: Haiku, high effort, the schema, no tools", async () => {
    await run(oneEntryCorpus("nm000001"));
    expect(modelRequests).toHaveLength(1);
    const body = (modelRequests[0] as ModelRequest).body;
    expect(body.model).toBe("claude-haiku-5-5");
    expect((body.output_config as { effort: string }).effort).toBe("high");
    expect(Object.keys(body)).not.toContain("tools");
    expect(Object.keys(body)).not.toContain("tool_choice");
  });

  test("it posts nothing and reaches no host but the model stand-in", async () => {
    await run(mutatedCorpus);
    expect(modelRequests.length).toBe(4 + DEFECTS.length);
    for (const r of modelRequests) {
      expect(r.method).toBe("POST");
      expect(r.path).toBe("/v1/messages");
    }
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) expect(url.startsWith(`${MODEL_ORIGIN()}/`), url).toBe(true);
  });

  test("calibration and production send the same request for the same dataset", async () => {
    // The drift guard: calibration measures what production does only if the two prompts agree.
    for (const id of ["nm000001", "nm000002", "nm000003", "nm000006"]) {
      const origin = origins[id] as Origin;
      modelRequests.length = 0;
      const production = await runPublicationReview({
        repoDir: origin.dir,
        head: origin.head,
        fetchedHead: origin.head,
        tagsFile: sideFile(""),
        bidsRunsFile: sideFile(null),
        anonymous: false,
      });
      expect(production.outcome, id).toBe("reported");
      await run(oneEntryCorpus(id));
      expect(modelRequests, id).toHaveLength(2);
      const [fromProduction, fromCalibration] = modelRequests as [ModelRequest, ModelRequest];
      expect(withoutNonce(fromCalibration.raw), id).toBe(withoutNonce(fromProduction.raw));
    }
  });

  test("calibration and production derive the same evidence for the same dataset, a README nobody could read included", async () => {
    // The request drift test above compares what the model is sent; this compares the facts the
    // report carries (the minimums, the version, the tag, the BIDS result, the documents' states),
    // which the verdict is derived from. Each side orchestrates the same function over its own input.
    const unread = join(root, "corpus-unread-readme");
    const built = await buildCorpus({ ids: ["nm000007"], outDir: unread, remoteBase: REMOTE_BASE });
    expect(built.built).toBe(1);
    const dirs: Record<string, string> = { nm000007: join(unread, "nm000007") };
    for (const id of ["nm000001", "nm000002", "nm000003", "nm000006"]) {
      dirs[id] = join(goodCorpus, id);
    }
    for (const [id, dir] of Object.entries(dirs)) {
      const origin = origins[id] as Origin;
      const production = await runPublicationReview({
        repoDir: origin.dir,
        head: origin.head,
        fetchedHead: origin.head,
        tagsFile: sideFile(""),
        bidsRunsFile: sideFile(null),
        anonymous: false,
      });
      if (production.outcome !== "reported") throw new Error(`${id}: ${production.error}`);
      expect(evidenceOf(readEntry(dir)).facts, id).toEqual(production.report.evidence);
    }
    // The case the two sides used to copy separately: the README exists and could not be read, so the
    // ethics minimum that may rest on it is not recorded as failed, and the review says the text was
    // withheld instead.
    const { facts } = evidenceOf(readEntry(join(unread, "nm000007")));
    expect(facts.documents.readme).toBe("withheld_not_utf8");
    expect(facts).toMatchObject({ minimums: "met", minimum_failures: [] });
  });

  test("a README with a path on somebody's machine is withheld, exactly as in production", async () => {
    const { records } = await run(oneEntryCorpus("nm000002"));
    const [record] = records as [CalibrationRecord];
    expect(record.documents?.readme).toBe("withheld_finding");
    expect(record.reasons).toContain("text_withheld");
    expect(record.outcome).not.toBe("pass");
    expect(modelRequests).toHaveLength(1);
    const { raw } = modelRequests[0] as ModelRequest;
    expect(raw).not.toContain(PATH_SENTINEL);
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain("Processed under");
  });

  test("the model never sees a table byte, a label or a file name, whatever the corpus holds", async () => {
    await run(mutatedCorpus);
    for (const { raw } of modelRequests) {
      for (const s of ["SENTINEL_PARTICIPANT_ROW", "SENTINELSUBJ", "SENTINELTASK", "SENTINELDIR"]) {
        expect(raw, s).not.toContain(s);
      }
      expect(raw).not.toMatch(/\bsub-/);
      expect(raw).not.toMatch(/README\.md|README\.rst|dataset_description\.json/);
    }
  });
});

// A file the evidence test also needs: text for the `--tags-file` and `--bids-runs-file` arguments.
let fileSeq = 0;
function sideFile(content: string | null): string {
  const path = join(root, `side-${++fileSeq}.txt`);
  if (content !== null) writeFileSync(path, content);
  return path;
}

describe("a record holds ids, labels, closed words, counts and timings, and no one's words", () => {
  const CLOSED = new Set<string>([
    "good",
    ...DEFECTS,
    ...PUBLICATION_OUTCOMES,
    "error",
    ...REASON_CODES,
    ...QUESTIONS,
    ...ANSWERS,
    ...PUBLICATION_FINDING_CODES,
    ...REVIEW_DOCUMENTS,
    ...DOCUMENT_STATES,
    ...PUBLICATION_RUN_ERRORS,
    ...CALIBRATION_MODELS,
  ]);

  function leaves(value: unknown): unknown[] {
    if (Array.isArray(value)) return value.flatMap(leaves);
    if (typeof value === "object" && value !== null) return Object.values(value).flatMap(leaves);
    return [value];
  }

  test("the keys are fixed and every string is an id or a closed word", async () => {
    modelReply = () =>
      messageReply(
        JSON.stringify({
          ...PASS_OUTPUT,
          findings: [
            {
              question: "complete_and_honest",
              severity: "concern",
              code: "other",
              document: "none",
              note: MODEL_NOTE_SENTINEL,
            },
          ],
        }),
      );
    const { records } = await run(mutatedCorpus);
    const ids = new Set(listEntries(mutatedCorpus).map((e) => e.id));
    for (const r of records) {
      expect(Object.keys(r), r.id).toEqual([
        "id",
        "label",
        "model",
        "outcome",
        "error",
        "reasons",
        "answers",
        "model_answers",
        "steering",
        "finding_codes",
        "documents",
        "input_tokens",
        "output_tokens",
        "ms",
      ]);
      for (const leaf of leaves(r)) {
        if (typeof leaf === "string") expect(CLOSED.has(leaf) || ids.has(leaf), leaf).toBe(true);
        else
          expect(["number", "boolean"].includes(typeof leaf) || leaf === null, String(leaf)).toBe(
            true,
          );
      }
      expect(r.finding_codes).toEqual(["other"]);
    }
  });

  test("no document's text and none of the model's words is in the output file", async () => {
    modelReply = () =>
      messageReply(
        JSON.stringify({
          ...PASS_OUTPUT,
          findings: [
            {
              question: "meets_standards",
              severity: "concern",
              code: "ethics_statement_inadequate",
              document: "readme",
              note: MODEL_NOTE_SENTINEL,
            },
          ],
        }),
      );
    const { out } = await run(mutatedCorpus);
    const text = readFileSync(out, "utf8");
    for (const s of [
      ...DOCUMENT_SENTINELS,
      MODEL_SUMMARY_SENTINEL,
      MODEL_NOTE_SENTINEL,
      "Resting state EEG",
      "Ada Lovelace",
      "IRB 2024",
      "TODO",
      "REVIEWER",
    ]) {
      expect(text, s).not.toContain(s);
    }
    // Control: the stand-in's words and the documents really were in play.
    expect(modelRequests.some((r) => r.raw.includes(README_SENTINEL))).toBe(true);
  });
});

describe("the outcome is derived, never reported, and facts the calibration cannot know are left out", () => {
  test("a good dataset and a model that passes everything is a pass, with no reasons", async () => {
    const { records } = await run(oneEntryCorpus("nm000001"));
    const [record] = records as [CalibrationRecord];
    expect(record).toMatchObject({
      outcome: "pass",
      reasons: [],
      steering: false,
      finding_codes: [],
    });
    expect(record.answers).toEqual(PASS_ANSWERS as CalibrationRecord["answers"]);
    expect(record.model_answers).toEqual(record.answers);
  });

  test("the evidence is that of an unreleased named dataset: the tag absent (a malformed Version has none to look up), BIDS unknown", () => {
    const withVersion = evidenceOf(readEntry(join(mutatedCorpus, "nm000001"))).facts;
    expect(withVersion).toMatchObject({
      anonymous: false,
      version: "1.0.0",
      version_shape: "ok",
      tag: "absent",
      bids: "unknown",
    });
    expect(withVersion.head).toBe((origins.nm000001 as Origin).head);
    // No Version: published as 1.0.0, so there is a tag to look up, and it does not exist yet.
    const without = evidenceOf(readEntry(join(mutatedCorpus, "nm000003"))).facts;
    expect(without).toMatchObject({
      version: null,
      version_shape: "missing",
      tag: "absent",
    });
    expect(without.bids).toBe("unknown");
    // A Version that is not X.Y.Z has nothing to look up.
    const entry = readEntry(join(mutatedCorpus, "nm000001"));
    const malformed = evidenceOf({
      ...entry,
      docs: {
        ...entry.docs,
        dataset_description: {
          ...entry.docs.dataset_description,
          text: JSON.stringify({ ...DESCRIPTION, Version: "one.two" }),
        },
      },
    }).facts;
    expect(malformed).toMatchObject({
      version: null,
      version_shape: "malformed",
      tag: "not_applicable",
    });
  });

  test("an unknown BIDS result would make every dataset a non-pass, so that one reason is not counted", () => {
    const { facts } = evidenceOf(readEntry(join(mutatedCorpus, "nm000001")));
    const report = assemblePublicationReport(PASS_OUTPUT, facts, "claude-haiku-5-5");
    // Production would say so ...
    expect(reportReasons(report).map((r) => r.code)).toContain("bids_unconcluded_at_review");
    // ... and the calibration does not, because it never runs the validator.
    const derived = deriveOutcome(report);
    expect(derived.reasons).toEqual([]);
    expect(derived.outcome).toBe("pass");
  });

  test("every other reason a report gives is kept: a missing Version and a failed minimum count", async () => {
    // nm000003 has no Version and no ethics statement anywhere.
    const { records } = await run(oneEntryCorpus("nm000003"));
    const [record] = records as [CalibrationRecord];
    expect(record.outcome).toBe("fail");
    expect(record.reasons).toContain("submission_minimum_failed");
    expect(record.reasons).toContain("version_missing");
    expect(record.reasons).not.toContain("bids_unconcluded_at_review");
  });

  test("the model's own answers and the answers after the facts are both recorded", async () => {
    const copy = listEntries(mutatedCorpus).find((e) => e.label === "placeholder_authors");
    const { records } = await run(oneEntryCorpus((copy as CorpusEntry).id));
    const [record] = records as [CalibrationRecord];
    expect(record.label).toBe("placeholder_authors");
    // The model, which passes everything, was overruled by the fact that the authors are placeholders.
    expect(record.model_answers?.authors_and_license).toBe("pass");
    expect(record.answers?.authors_and_license).toBe("fail");
    expect(record.outcome).toBe("fail");
    expect(record.reasons).toContain("question_failed");
  });

  test("an instruction aimed at the reviewer is a steering fail when the model reports it", async () => {
    const copy = listEntries(mutatedCorpus).find((e) => e.label === "embedded_instruction");
    modelReply = (req) =>
      messageReply(
        JSON.stringify(
          req.raw.includes("AUTOMATED REVIEWER")
            ? {
                ...PASS_OUTPUT,
                steering: true,
                findings: [
                  {
                    question: "meets_standards",
                    severity: "blocker",
                    code: "steering_attempt",
                    document: "readme",
                    note: "The README addresses the reviewer.",
                  },
                ],
              }
            : PASS_OUTPUT,
        ),
      );
    const { records } = await run(oneEntryCorpus((copy as CorpusEntry).id));
    const [record] = records as [CalibrationRecord];
    expect(record.steering).toBe(true);
    expect(record.finding_codes).toEqual(["steering_attempt"]);
    expect(record.reasons).toContain("steering_attempt");
    expect(record.outcome).toBe("fail");
    // The blocker lowered the question the model had passed.
    expect(record.model_answers?.meets_standards).toBe("unknown");
  });

  test("a run that fails for one entry records the closed word and goes on", async () => {
    let n = 0;
    modelReply = () => {
      n++;
      if (n === 1) return failureReply(401, "bad key");
      if (n === 2) return messageReply("not json at all");
      if (n === 3) return messageReply(JSON.stringify(PASS_OUTPUT), "max_tokens");
      if (n === 4) return messageReply(JSON.stringify(PASS_OUTPUT), "refusal");
      return messageReply(JSON.stringify(PASS_OUTPUT));
    };
    const { result, records } = await run(mutatedCorpus);
    expect(records.slice(0, 4).map((r) => [r.outcome, r.error])).toEqual([
      ["error", "auth_failed"],
      ["error", "model_invalid"],
      ["error", "model_truncated"],
      ["error", "model_refused"],
    ]);
    expect(result.errors).toBe(4);
    expect(result.records).toBe(records.length);
    // A failure carries no verdict, and an answer that did arrive still has its token counts.
    expect(records[0]).toMatchObject({ answers: null, reasons: [], input_tokens: null });
    expect(records[2]).toMatchObject({ answers: null, input_tokens: 1234, output_tokens: 56 });
    expect(records.slice(4).every((r) => r.error === null)).toBe(true);
  });

  test("the same corpus gives the same records, apart from timings", async () => {
    const a = await run(mutatedCorpus);
    const b = await run(mutatedCorpus);
    const stable = (rs: CalibrationRecord[]) => rs.map((r) => ({ ...r, ms: 0 }));
    expect(stable(a.records)).toEqual(stable(b.records));
    const bytes = (rs: CalibrationRecord[]) => stable(rs).map((r) => JSON.stringify(r));
    expect(bytes(a.records)).toEqual(bytes(b.records));
  });
});

describe("the calibration model: Sonnet is accepted here and refused everywhere else", () => {
  const SONNET = "claude-sonnet-5-5";

  test("a Sonnet report parses with the calibration list and is refused by the default parser", () => {
    const { facts } = evidenceOf(readEntry(join(mutatedCorpus, "nm000001")));
    const report = assemblePublicationReport(PASS_OUTPUT, facts, SONNET);
    expect(report.model).toBe(SONNET);
    const raw = {
      v: 1,
      model: SONNET,
      questions: PASS_ANSWERS,
      findings: [],
      summary: "x",
      steering: false,
      evidence: facts,
    };
    expect(parsePublicationReviewReport(raw, { models: CALIBRATION_MODELS }).model).toBe(SONNET);
    expect(() => parsePublicationReviewReport(raw)).toThrow(PublicationReviewReportError);
    try {
      parsePublicationReviewReport(raw);
    } catch (e) {
      expect((e as PublicationReviewReportError).code).toBe("bad_model");
    }
    expect([...PUBLICATION_REVIEW_MODELS]).not.toContain(SONNET);
    // The calibration list names exactly the production model and Sonnet.
    expect([...CALIBRATION_MODELS]).toEqual(["claude-haiku-5-5", SONNET]);
  });

  test("calibrate sends the model it was given and records it", async () => {
    const { records } = await run(oneEntryCorpus("nm000001"), { model: SONNET });
    expect((modelRequests[0] as ModelRequest).body.model).toBe(SONNET);
    expect(records).toMatchObject([{ model: SONNET, outcome: "pass", error: null }]);
  });

  test("without a model it is the production model", async () => {
    const { records } = await run(oneEntryCorpus("nm000001"));
    expect((modelRequests[0] as ModelRequest).body.model).toBe(PUBLICATION_REVIEW_MODELS[0]);
    expect(records[0]?.model).toBe(PUBLICATION_REVIEW_MODELS[0]);
  });

  test("the model call reports its token usage to a caller that asks, and changes nothing for one that does not", async () => {
    const seen: { input_tokens: number; output_tokens: number }[] = [];
    const answer = await callPublicationReviewModel("system", "user", SONNET, (u) => seen.push(u));
    expect(seen).toEqual([USAGE]);
    expect(answer).toEqual(PASS_OUTPUT);
    expect((modelRequests[0] as ModelRequest).body.model).toBe(SONNET);
    expect(await callPublicationReviewModel("system", "user")).toEqual(PASS_OUTPUT);
    expect((modelRequests[1] as ModelRequest).body.model).toBe("claude-haiku-5-5");
  });
});

describe("the review sheet is the one place the model's words go, and never inside the repository", () => {
  const SHEET_DIR_IN_REPO = join(REPO_ROOT, ".calibration-sheet-guard-test");
  afterEach(() => {
    // A directory only the guard test below can create, and only when the guard has failed.
    rmSync(SHEET_DIR_IN_REPO, { recursive: true, force: true });
  });

  test("it holds the model's summary and notes for the maintainer, and none of the documents' text", async () => {
    modelReply = () =>
      messageReply(
        JSON.stringify({
          ...PASS_OUTPUT,
          questions: { ...PASS_ANSWERS, name_adequate: "fail" },
          findings: [
            {
              question: "name_adequate",
              severity: "concern",
              code: "name_not_descriptive",
              document: "dataset_description",
              note: MODEL_NOTE_SENTINEL,
            },
          ],
        }),
      );
    const reviewSheet = join(root, "sheets", "one.csv");
    const { result } = await run(mutatedCorpus, { reviewSheet });
    const csv = readFileSync(reviewSheet, "utf8");
    const lines = csv.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1 + result.records);
    expect(lines[0]).toBe(
      "id,label,outcome,reasons,complete_and_honest,meets_standards,authors_and_license,name_adequate,steering,summary,notes,judged_wrong,comment",
    );
    expect(csv).toContain(MODEL_SUMMARY_SENTINEL);
    expect(csv).toContain(MODEL_NOTE_SENTINEL);
    expect(csv).toContain("name_not_descriptive");
    for (const s of DOCUMENT_SENTINELS) expect(csv, s).not.toContain(s);
    // The maintainer's columns start empty.
    expect(lines[1]?.endsWith(",,")).toBe(true);
  });

  test("a cell that a spreadsheet would run as a formula is made text", async () => {
    modelReply = () =>
      messageReply(
        JSON.stringify({
          ...PASS_OUTPUT,
          summary: '=HYPERLINK("http://corpus.invalid/x","click"), with "quotes"\nand a line break',
        }),
      );
    const reviewSheet = join(root, "sheets", "formula.csv");
    await run(oneEntryCorpus("nm000001"), { reviewSheet });
    const csv = readFileSync(reviewSheet, "utf8");
    // The shared sanitizer already removes the link; what is left starts with `=`, and the cell
    // is made text and quoted (it holds quotes).
    expect(csv).toContain(`,"'=HYPERLINK(`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  test("a path inside the repository is refused before any model is called, and nothing is made", async () => {
    const reviewSheet = join(SHEET_DIR_IN_REPO, "sheet.csv");
    const out = join(root, `records-${++seq}.jsonl`);
    await expect(
      calibrate({ corpusDir: oneEntryCorpus("nm000001"), out, reviewSheet }),
    ).rejects.toMatchObject({ code: "sheet_inside_repository" });
    expect(modelRequests).toHaveLength(0);
    expect(existsSync(SHEET_DIR_IN_REPO)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  test("an existing sheet, and the records file named as the sheet, are refused up front", async () => {
    const corpusDir = oneEntryCorpus("nm000001");
    const reviewSheet = join(root, "sheets", "taken.csv");
    mkdirSync(dirname(reviewSheet), { recursive: true });
    writeFileSync(reviewSheet, "kept");
    await expect(
      calibrate({ corpusDir, out: join(root, `records-${++seq}.jsonl`), reviewSheet }),
    ).rejects.toMatchObject({ code: "sheet_exists" });
    const out = join(root, `records-${++seq}.jsonl`);
    await expect(calibrate({ corpusDir, out, reviewSheet: out })).rejects.toMatchObject({
      code: "sheet_is_out",
    });
    expect(readFileSync(reviewSheet, "utf8")).toBe("kept");
    expect(modelRequests).toHaveLength(0);
  });

  test("the default path is outside the repository", () => {
    const path = defaultSheetPath("claude-haiku-5-5");
    expect(isInsideRepository(path)).toBe(false);
    expect(path.startsWith(tmpdir()) || path.startsWith(realTmp())).toBe(true);
    expect(() => assertOutsideRepository(path)).not.toThrow();
  });

  test("inside means inside any working tree of the repository, by any spelling of the path", () => {
    const repo = join(root, "guard-repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    write(repo, "a.txt", "a");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "initial");
    const worktree = join(root, "guard-worktree");
    git(repo, "worktree", "add", "-q", worktree, "-b", "side");
    const link = join(root, "guard-link");
    symlinkSync(repo, link);
    const other = join(root, "guard-other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");

    const inside = [
      join(repo, "x.csv"),
      join(repo, "new", "deeper", "x.csv"),
      join(repo, "..", "guard-repo", "x.csv"),
      join(worktree, "x.csv"),
      join(worktree, "new", "x.csv"),
      join(link, "new", "x.csv"),
      repo,
    ];
    for (const p of inside) expect(isInsideRepository(p, repo), p).toBe(true);
    const outside = [
      join(root, "sheets", "x.csv"),
      join(root, "guard-repo-sibling", "x.csv"),
      join(other, "x.csv"),
      join(tmpdir(), "x.csv"),
    ];
    for (const p of outside) expect(isInsideRepository(p, repo), p).toBe(false);
    expect(() => assertOutsideRepository(join(worktree, "x.csv"), repo)).toThrow(CalibrationError);
    expect(() => assertOutsideRepository(join(other, "x.csv"), repo)).not.toThrow();
  });
});

function realTmp(): string {
  return realpathOf(tmpdir());
}

function realpathOf(p: string): string {
  return execFileSync("realpath", [p], { encoding: "utf8" }).trim();
}

describe("the run refuses what would make it unsafe or useless, before it calls a model", () => {
  test("an existing records file is never overwritten", async () => {
    const corpusDir = oneEntryCorpus("nm000001");
    const out = join(root, `records-${++seq}.jsonl`);
    writeFileSync(out, "kept");
    await expect(calibrate({ corpusDir, out })).rejects.toMatchObject({ code: "out_exists" });
    expect(readFileSync(out, "utf8")).toBe("kept");
    expect(modelRequests).toHaveLength(0);
  });

  test("a corpus that is empty or holds something that is not an entry is refused", async () => {
    const empty = join(root, "corpus-empty");
    mkdirSync(empty);
    await expect(
      calibrate({ corpusDir: empty, out: join(root, `records-${++seq}.jsonl`) }),
    ).rejects.toMatchObject({ code: "empty_corpus" });
    const broken = join(root, "corpus-broken");
    cpSync(join(mutatedCorpus, "nm000001"), join(broken, "nm000001"), { recursive: true });
    writeFileSync(join(broken, "nm000001", "entry.json"), "{}");
    await expect(
      calibrate({ corpusDir: broken, out: join(root, `records-${++seq}.jsonl`) }),
    ).rejects.toMatchObject({ code: "bad_entry" });
    expect(modelRequests).toHaveLength(0);
  });

  test("--limit takes the first entries in id order, and a bad limit is refused", async () => {
    const { records } = await run(mutatedCorpus, { limit: 3 });
    expect(records.map((r) => r.id)).toEqual(
      listEntries(mutatedCorpus)
        .map((e) => e.id)
        .slice(0, 3),
    );
    expect(modelRequests).toHaveLength(3);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        calibrate({ corpusDir: mutatedCorpus, out: join(root, `records-${++seq}.jsonl`), limit }),
      ).rejects.toMatchObject({ code: "bad_limit" });
    }
  });

  test("records are written as they are made, so a run that stops keeps what it did", async () => {
    // The third answer cannot be read; the first two lines are already on disk when it arrives.
    let n = 0;
    let seenOnDisk = -1;
    const out = join(root, `records-${++seq}.jsonl`);
    modelReply = () => {
      n++;
      if (n === 3) seenOnDisk = readRecords(out).length;
      return messageReply(JSON.stringify(PASS_OUTPUT));
    };
    await calibrate({ corpusDir: mutatedCorpus, out, limit: 3 });
    expect(seenOnDisk).toBe(2);
  });
});

describe("the calibration modules post nothing: no poster, no origin table, no network call of their own", () => {
  const FILES = ["publication-review-calibrate.ts", "publication-review-corpus.ts"];
  const BANNED_NAMES = ["postPublicationCallback", "CALLBACK_ORIGINS", "main"];

  /** What is wrong with `source`, in words; empty when it is clean. */
  function violations(source: string): string[] {
    const found: string[] = [];
    const imports = source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g);
    for (const [, names, from] of imports) {
      for (const raw of (names as string).split(",")) {
        const name =
          raw
            .replace(/^\s*type\s+/, "")
            .split(/\s+as\s+/)[0]
            ?.trim() ?? "";
        if (BANNED_NAMES.includes(name)) found.push(`imports ${name} from ${from}`);
      }
    }
    if (/\bpostPublicationCallback\b|\bCALLBACK_ORIGINS\b/.test(source))
      found.push("names the poster");
    if (/webhooks\/|X-Webhook-Token/.test(source)) found.push("names the callback route");
    if (/\bfetch\s*\(/.test(source)) found.push("calls fetch");
    return found;
  }

  test.each(FILES)("%s", (file) => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "ci", file), "utf8");
    expect(violations(source)).toEqual([]);
  });

  test("the guard sees each spelling: fixtures, not violations", () => {
    const BAD = [
      'import { postPublicationCallback } from "./publication-review";',
      'import {\n  callPublicationReviewModel,\n  postPublicationCallback as post,\n} from "./publication-review";',
      'import { type Environment, CALLBACK_ORIGINS } from "./publication-review";',
      'import { main } from "./publication-review";',
      "const r = await fetch(url, { method: 'POST' });",
      'const route = "/webhooks/publication-review-result";',
      'headers: { "X-Webhook-Token": token }',
    ];
    for (const source of BAD) expect(violations(source), source).not.toEqual([]);
    const GOOD = [
      'import { callPublicationReviewModel, mapError } from "./publication-review";',
      'import { type JobRunError } from "./publication-review";',
      "const prefetch = 1; // fetched later",
    ];
    for (const source of GOOD) expect(violations(source), source).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// main(["calibrate", ...]): the entry point the operator runs
// ---------------------------------------------------------------------------------------------

describe('main(["calibrate", ...]) never posts, and refuses everything that would', () => {
  interface Received {
    path: string;
  }
  const received: Received[] = [];
  let worker: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    worker = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push({ path: new URL(req.url).pathname });
        return Response.json({ ok: true });
      },
    });
  });
  afterAll(() => {
    worker.stop(true);
  });
  beforeEach(() => {
    received.length = 0;
  });

  /** Run `main` with its output captured and both callback origins pointed at the Worker stand-in. */
  async function runMain(argv: string[], env: Record<string, string> = {}) {
    const lines: string[] = [];
    const original = { log: console.log, error: console.error };
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      const code = await main(argv, {
        production: `http://127.0.0.1:${worker.port}`,
        dev: `http://127.0.0.1:${worker.port}`,
      });
      return { code, log: lines.join("\n") };
    } finally {
      Object.assign(console, original);
      for (const k of Object.keys(env)) Reflect.deleteProperty(process.env, k);
    }
  }

  function runArgv(extra: string[] = []): { argv: string[]; out: string } {
    const out = join(root, `records-${++seq}.jsonl`);
    return {
      argv: ["calibrate", "run", "--corpus", oneEntryCorpus("nm000001"), "--out", out, ...extra],
      out,
    };
  }

  function expectNothingHappened(out: string) {
    expect(modelRequests).toHaveLength(0);
    expect(received).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  }

  test("--environment is refused, for either subcommand, before anything is read or sent", async () => {
    for (const environment of ["dev", "production"]) {
      const { argv, out } = runArgv(["--environment", environment]);
      const { code, log } = await runMain(argv);
      expect(code, environment).toBe(2);
      expect(log).toContain("--environment is refused");
      expectNothingHappened(out);
    }
    const ids = join(root, "ids-refused.txt");
    writeFileSync(ids, "nm000001\n");
    const outDir = join(root, "corpus-refused-env");
    const { code } = await runMain([
      "calibrate",
      "corpus",
      "--ids-file",
      ids,
      "--out",
      outDir,
      "--environment",
      "dev",
    ]);
    expect(code).toBe(2);
    expect(existsSync(outDir)).toBe(false);
  });

  test.each([
    ["callback-url", "http://corpus.invalid/x"],
    ["callback-token", "t"],
    ["origin", "http://corpus.invalid"],
    ["token", "t"],
    ["review-id", "41"],
    ["request-id", "17"],
    ["dataset", "nm000001"],
    ["repo-dir", "/tmp/x"],
    ["head", "a".repeat(40)],
    ["fetched-head", "a".repeat(40)],
    ["tags-file", "/tmp/x"],
    ["bids-runs-file", "/tmp/x"],
    ["anonymous", "false"],
  ])("--%s, an argument of the review that posts, is refused", async (flag, value) => {
    const { argv, out } = runArgv([`--${flag}`, value]);
    const { code, log } = await runMain(argv);
    expect(code).toBe(2);
    expect(log).toContain(`--${flag} is refused`);
    expectNothingHappened(out);
  });

  test("a callback token in the environment stops the run: this is not a review", async () => {
    const { argv, out } = runArgv();
    const { code, log } = await runMain(argv, { PUBLICATION_REVIEW_CALLBACK_TOKEN: "a-token" });
    expect(code).toBe(2);
    expect(log).toContain("posts nothing");
    expectNothingHappened(out);
  });

  test("anything it does not know is refused: unknown flags, stray words, missing and repeated values", async () => {
    const cases: string[][] = [
      ["--surprise", "1"],
      ["stray"],
      ["--limit"],
      ["--limit", "3", "--limit", "4"],
      ["--limit", "0"],
      ["--limit", "two"],
      ["--model", "claude-opus-5-5"],
      ["--model", "claude-haiku-5-5-latest"],
    ];
    for (const extra of cases) {
      const { argv, out } = runArgv(extra);
      const { code } = await runMain(argv);
      expect(code, extra.join(" ")).toBe(2);
      expectNothingHappened(out);
    }
    for (const argv of [["calibrate"], ["calibrate", "post"], ["calibrate", "--corpus", "x"]]) {
      const { code } = await runMain(argv);
      expect(code, argv.join(" ")).toBe(2);
    }
    expect(modelRequests).toHaveLength(0);
  });

  test("a run through main reviews the corpus, prints only counts, and sends nothing to the Worker", async () => {
    modelReply = () =>
      messageReply(
        JSON.stringify({
          ...PASS_OUTPUT,
          findings: [
            {
              question: "name_adequate",
              severity: "note",
              code: "other",
              document: "none",
              note: MODEL_NOTE_SENTINEL,
            },
          ],
        }),
      );
    const { argv, out } = runArgv(["--model", "claude-sonnet-5-5"]);
    const { code, log } = await runMain(argv);
    expect(code).toBe(0);
    expect(log).toBe(
      "calibrate: 1 records, 0 errors (pass 1, fail 0, action_required 0); model claude-sonnet-5-5",
    );
    expect(modelRequests).toHaveLength(1);
    expect((modelRequests[0] as ModelRequest).body.model).toBe("claude-sonnet-5-5");
    expect(received).toHaveLength(0);
    expect(readRecords(out)).toMatchObject([{ id: "nm000001", model: "claude-sonnet-5-5" }]);
    for (const url of fetched) expect(url.startsWith(`${MODEL_ORIGIN()}/`), url).toBe(true);
  });

  test("--review-sheet with no path writes to the system temporary directory and says where", async () => {
    const { argv } = runArgv(["--review-sheet"]);
    const { code, log } = await runMain(argv);
    expect(code).toBe(0);
    const line = log.split("\n").find((l) => l.startsWith("review sheet: "));
    const path = (line as string).slice("review sheet: ".length);
    try {
      expect(isInsideRepository(path)).toBe(false);
      expect(readFileSync(path, "utf8")).toContain(MODEL_SUMMARY_SENTINEL);
    } finally {
      // The file this very run made, at the path it printed.
      rmSync(path, { force: true });
    }
  });

  test("--review-sheet inside the repository is refused, and so is a model it cannot reach", async () => {
    const dir = join(REPO_ROOT, ".calibration-sheet-main-test");
    try {
      const { argv, out } = runArgv(["--review-sheet", join(dir, "sheet.csv")]);
      const { code, log } = await runMain(argv);
      expect(code).toBe(2);
      expect(log).toContain("sheet_inside_repository");
      expectNothingHappened(out);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run in which every review failed exits 1, and one in which some did not exits 0", async () => {
    modelReply = () => failureReply(401, "bad key");
    const bad = runArgv();
    expect((await runMain(bad.argv)).code).toBe(1);
    expect(readRecords(bad.out)).toMatchObject([{ outcome: "error", error: "auth_failed" }]);
  });

  test("calibrate corpus builds a corpus from the repositories it is given and adds the copies", async () => {
    const ids = join(root, "ids.txt");
    writeFileSync(ids, "# the ids\nnm000001\n\nnm000003\nnm000004\nnm000099\nnm000001\n");
    const outDir = join(root, "corpus-main");
    const { code, log } = await runMain([
      "calibrate",
      "corpus",
      "--ids-file",
      ids,
      "--out",
      outDir,
      "--remote-base",
      REMOTE_BASE,
      "--mutate-per-defect",
      "1",
    ]);
    expect(code).toBe(0);
    expect(log).toContain("corpus: 2 built, 2 skipped");
    expect(log).toContain("skipped nm000004: description_unreadable");
    expect(log).toContain("skipped nm000099: clone_failed");
    expect(log).toMatch(/mutated copies: \d+ made/);
    const entries = listEntries(outDir);
    expect(entries.filter((e) => e.label === "good").map((e) => e.id)).toEqual([
      "nm000001",
      "nm000003",
    ]);
    expect(entries.length).toBeGreaterThan(2);
    for (const line of log.split("\n")) {
      for (const s of DOCUMENT_SENTINELS) expect(line, s).not.toContain(s);
    }
    expect(received).toHaveLength(0);
  });

  test("calibrate corpus with an ids file it cannot read is refused with a word", async () => {
    const outDir = join(root, "corpus-main-noids");
    const { code, log } = await runMain([
      "calibrate",
      "corpus",
      "--ids-file",
      join(root, "no-such-ids.txt"),
      "--out",
      outDir,
      "--remote-base",
      REMOTE_BASE,
    ]);
    expect(code).toBe(2);
    expect(log).toContain("the ids file could not be read");
    expect(existsSync(outDir)).toBe(false);
  });

  test("calibrate corpus refuses an id that is not a repository id and a remote that is not public https", async () => {
    const ids = join(root, "ids-bad.txt");
    writeFileSync(ids, "nm000001\n../etc\n");
    const outDir = join(root, "corpus-main-bad");
    expect(
      (
        await runMain([
          "calibrate",
          "corpus",
          "--ids-file",
          ids,
          "--out",
          outDir,
          "--remote-base",
          REMOTE_BASE,
        ])
      ).code,
    ).toBe(2);
    writeFileSync(ids, "nm000001\n");
    const { code, log } = await runMain([
      "calibrate",
      "corpus",
      "--ids-file",
      ids,
      "--out",
      outDir,
      "--remote-base",
      "ssh://corpus.invalid/x",
    ]);
    expect(code).toBe(2);
    expect(log).toContain("bad_remote");
    expect(existsSync(outDir)).toBe(false);
  });
});
