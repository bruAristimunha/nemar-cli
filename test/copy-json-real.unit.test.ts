/**
 * `git annex copy --json --json-error-messages`, parsed from what git-annex really
 * prints.
 *
 * Parser inputs are captured from real git-annex invocations against a real `directory`
 * special remote: successful copies, a read-only store that fails mid-transfer, and a
 * missing store that git-annex declines up front. No fabricated command records stand in
 * for behavior at the command boundary.
 *
 * Assertions that read git-annex's own prose, or the shape of a record, rather than
 * ours are marked "version-coupled": they hold on git-annex 10.20260901 and are the
 * ones to look at first if a different git-annex build fails this file.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { redactCredentials } from "../src/lib/git-annex/run-command";
import {
  checkRemoteHolds,
  copyPathsToAnnexRemote,
  copyToAnnexRemote,
  extractCopyJsonError,
  parseCopyJson,
} from "../src/lib/git-annex/transfer";
import {
  chmodTreeWritable,
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

const scratch = makeScratch("nemar-copy-json");
// A read-only directory does not stop root, so the read-only captures cannot run as
// root; under root the test of the de-duplication (which only that failure shape
// exercises) is skipped, and removing the de-duplication goes unnoticed there.
const canBlockWrites = process.getuid?.() !== 0;

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
});
afterAll(() => scratch.cleanup());

interface Capture {
  repo: string;
  store: string;
  paths: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

function copyArgs(paths: string[]): string[] {
  return [
    "git",
    "annex",
    "copy",
    "--to",
    "store",
    "-J",
    "2",
    "--json",
    "--json-error-messages",
    "--",
    ...paths,
  ];
}

/**
 * Annex `count` files, break the remote as `how`, and capture a real JSON copy.
 *
 * `read-only` first copies one file so the store has its `tmp` directory, then makes
 * the store read-only: the next object cannot create its hash directory, which is the
 * failure whose message git-annex repeats inside the record. The copy that is
 * captured covers only the files after that first one.
 */
async function captureCopy(how: "none" | "read-only" | "missing", count: number): Promise<Capture> {
  const repo = await newDatasetRepo(scratch.root, `capture-${how}`);
  const all = Array.from({ length: count + 1 }, (_, i) => `sub-${i}/eeg/run-${i}.edf`);
  for (const [i, p] of all.entries()) writeFile(repo, p, `${i}`.repeat(2_000 + i));
  expect((await gitAnnexAdd(repo, all)).success).toBe(true);
  const store = await initDirectoryRemote(scratch.root, repo, "store");
  let paths = all.slice(0, count);
  if (how === "read-only") {
    const first = await run(["git", "annex", "copy", "--to", "store", "--", all[0]], repo);
    expect(first.exitCode).toBe(0);
    paths = all.slice(1);
    chmodSync(store, 0o555);
  }
  if (how === "missing") renameSync(store, `${store}.gone`);
  const copy = await run(
    [
      "git",
      "annex",
      "copy",
      "--to",
      "store",
      "-J",
      "2",
      "--json",
      "--json-error-messages",
      "--",
      ...paths,
    ],
    repo,
  );
  return { repo, store, paths, ...copy };
}

describe("parseCopyJson against real output", () => {
  test("a successful copy yields one success record per file, and the progress note is no error", async () => {
    const cap = await captureCopy("none", 3);
    expect(cap.exitCode).toBe(0);
    const records = parseCopyJson(cap.stdout);
    expect(records.map((r) => r.file).sort()).toEqual([...cap.paths].sort());
    for (const r of records) {
      expect(r.success).toBe(true);
      expect(r.errors).toEqual([]);
      expect(r.key).toMatch(/^SHA256E-s\d+--/);
    }
  });

  test("a record says whether git-annex moved the content or found it already there", async () => {
    // Guards `transferred`. The first copy sends everything; the second finds it all
    // already at the store and moves nothing; with the store emptied behind git-annex's
    // back the third is a re-send, even though the location log still says "present".
    const cap = await captureCopy("none", 3);
    expect(parseCopyJson(cap.stdout).map((r) => r.transferred)).toEqual([true, true, true]);

    const again = await run(copyArgs(cap.paths), cap.repo);
    expect(again.exitCode).toBe(0);
    const present = parseCopyJson(again.stdout);
    expect(present).toHaveLength(3);
    expect(present.every((r) => r.success && !r.transferred)).toBe(true);

    chmodTreeWritable(cap.store);
    for (const entry of readdirSync(cap.store)) {
      rmSync(join(cap.store, entry), { recursive: true, force: true });
    }
    const resent = await run(copyArgs(cap.paths), cap.repo);
    expect(parseCopyJson(resent.stdout).every((r) => r.success && r.transferred)).toBe(true);
    // The functions built on it carry the count.
    const counted = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
    expect(counted).toMatchObject({ success: true, filesCopied: 3, filesSent: 0 });
  });

  test("a record of another command is not counted as a copy", async () => {
    const cap = await captureCopy("none", 1);
    const found = await run(["git", "annex", "whereis", "--json", "--", cap.paths[0]], cap.repo);
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain('"command":"whereis"');
    expect(parseCopyJson(found.stdout)).toEqual([]);
  });

  test.skipIf(!canBlockWrites)(
    "a transfer that failed carries its reason once per record, de-duplicated",
    async () => {
      const cap = await captureCopy("read-only", 2);
      expect(cap.exitCode).not.toBe(0);
      const raw = cap.stdout
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { "error-messages": string[] });
      const records = parseCopyJson(cap.stdout);
      expect(records).toHaveLength(2);
      for (const [i, r] of records.entries()) {
        expect(r.success).toBe(false);
        // The premise, measured: git-annex repeats the message inside the record...
        expect(raw[i]["error-messages"].length).toBeGreaterThan(1);
        // ...and the parse keeps it once.
        expect(r.errors).toHaveLength(1);
        // Version-coupled: the OS wording. What matters is that a reason is present
        // and names the store it could not write to.
        expect(r.errors[0]).toContain(cap.store);
      }
    },
  );

  test("a remote git-annex declined up front has its reason in the note, not in error-messages", async () => {
    const cap = await captureCopy("missing", 2);
    expect(cap.exitCode).not.toBe(0);
    // Version-coupled: the shape that broke the first parse (success false,
    // error-messages empty, reason in the note). An older git-annex may put the
    // reason in error-messages, and then this premise, not the parse, is what moves.
    const raw = cap.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(raw).toHaveLength(2);
    for (const r of raw) {
      expect(r.success).toBe(false);
      expect(r["error-messages"]).toEqual([]);
    }
    const records = parseCopyJson(cap.stdout);
    for (const r of records) {
      expect(r.success).toBe(false);
      expect(r.errors).toHaveLength(1);
      // Version-coupled: git-annex's wording; the store it names is the stable part.
      expect(r.errors[0]).toContain(cap.store);
    }
  });
});

describe("git-annex copy output that cannot prove every path succeeded", () => {
  test("a clean exit with a path whose content is not here is partial: readable and incomplete", async () => {
    // With real git-annex, a path whose content is absent and whose remote location is
    // already recorded is skipped with exit 0 and no record. The other path still returns
    // its real record, so the answer is partial rather than unrecognized.
    const cap = await captureCopy("none", 2);
    expect(
      (await run(["git", "annex", "drop", "--force", "--", cap.paths[1]], cap.repo)).exitCode,
    ).toBe(0);

    const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);

    expect(result).toMatchObject({ success: true, filesCopied: 1, output: "partial" });
  });
});

describe("file names in error text", () => {
  test("a real failed copy of a file with an ESCAPE in its name prints no ESCAPE", async () => {
    if (!canBlockWrites) return;
    const repo = await newDatasetRepo(scratch.root, "copy-escape-name");
    const name = "esc\x1b[31mred.edf";
    writeFile(repo, name, "x".repeat(3_000));
    writeFile(repo, "first.edf", "y".repeat(3_000));
    expect((await gitAnnexAdd(repo, [name, "first.edf"])).success).toBe(true);
    const store = await initDirectoryRemote(scratch.root, repo, "store");
    expect(
      (await run(["git", "annex", "copy", "--to", "store", "--", "first.edf"], repo)).exitCode,
    ).toBe(0);
    chmodSync(store, 0o555);
    try {
      const result = await copyPathsToAnnexRemote(repo, "store", [name], 2);
      expect(result.success).toBe(false);
      expect(result.error).toContain("red.edf");
      expect(result.error).not.toContain("\x1b");
    } finally {
      chmodSync(store, 0o755);
    }
  });
});

describe("credentials never reach what is printed", () => {
  test("redactCredentials blanks header tuples in any case and any given secret", () => {
    expect(redactCredentials('("x-amz-security-token","abc")', [])).toBe(
      '("x-amz-security-token","<redacted>")',
    );
    expect(redactCredentials('("AUTHORIZATION","AWS4 Credential=x")', [])).toBe(
      '("AUTHORIZATION","<redacted>")',
    );
    expect(redactCredentials("value LONGSECRETVALUE here", ["LONGSECRETVALUE"])).toBe(
      "value <redacted> here",
    );
    // A short or empty "secret" must not blank half the message.
    expect(redactCredentials("a b c", ["", "b"])).toBe("a b c");
    expect(redactCredentials("unrelated text", ["SESSION-TOKEN-VALUE"])).toBe("unrelated text");
  });
});

describe("checkRemoteHolds: files whose content is not in this repository", () => {
  /** n files copied to the store, then every local copy of their content dropped. */
  async function droppedAfterCopy(name: string, n: number) {
    const repo = await newDatasetRepo(scratch.root, name);
    const paths = Array.from({ length: n }, (_, i) => `sub-${i}/eeg/run-${i}.edf`);
    for (const [i, p] of paths.entries()) writeFile(repo, p, `${i}`.repeat(2_000 + i));
    expect((await gitAnnexAdd(repo, paths)).success).toBe(true);
    const store = await initDirectoryRemote(scratch.root, repo, "store");
    expect(
      (await run(["git", "annex", "copy", "--to", "store", "--", ...paths], repo)).exitCode,
    ).toBe(0);
    expect((await run(["git", "annex", "drop", "--force", "--", ...paths], repo)).exitCode).toBe(0);
    return { repo, store, paths };
  }

  test("copy cannot check them: it exits 0 with no record and never contacts the remote", async () => {
    // The premise that makes this function necessary, measured: with the remote's object
    // gone, a copy over the path still exits 0 and reports nothing about it.
    const { repo, store, paths } = await droppedAfterCopy("copy-skips", 2);
    chmodTreeWritable(store);
    for (const entry of readdirSync(store))
      rmSync(join(store, entry), { recursive: true, force: true });
    const result = await copyPathsToAnnexRemote(repo, "store", paths, 2);
    expect(result.success).toBe(true);
    expect(result.filesCopied).toBe(0);
    expect(result.output).toBe("partial");
  });

  test("a file the remote holds is present, a file it lost is reported absent and the log is corrected", async () => {
    const { repo, store, paths } = await droppedAfterCopy("fsck-finds-loss", 3);
    const key = (await run(["git", "annex", "lookupkey", "--", paths[1]], repo)).stdout.trim();
    chmodTreeWritable(store);
    const victims = (readdirSync(store, { recursive: true }) as string[]).filter(
      (e) => e.endsWith(`/${key}`) || e.endsWith(`/${key}/${key}`),
    );
    expect(victims.length).toBeGreaterThan(0);
    for (const v of victims) rmSync(join(store, v), { recursive: true, force: true });
    // The log still says all three are there.
    expect((await run(["git", "annex", "find", "--not", "--in", "store"], repo)).stdout).toBe("");

    const outcome = await checkRemoteHolds(repo, "store", paths, 2);

    expect(outcome.success).toBe(true);
    expect(outcome.present).toBe(2);
    expect(outcome.absent.map((a) => a.file)).toEqual([paths[1]]);
    // git-annex wrote the loss into the location log, where the next walk sees it.
    expect(
      (await run(["git", "annex", "find", "--not", "--in", "store"], repo)).stdout.trim(),
    ).toBe(paths[1]);
  });

  test("a repository that wants two copies does not fail a file the remote holds", async () => {
    // Guards --numcopies=1 --mincopies=1. fsck also enforces the repository's numcopies:
    // with `git annex numcopies 2` and the one copy at the store it fails a file the store
    // DOES hold ("Only 1 of 2 trustworthy copies exist"), and no re-run can help.
    const { repo, paths } = await droppedAfterCopy("fsck-numcopies", 2);
    expect((await run(["git", "annex", "numcopies", "2"], repo)).exitCode).toBe(0);
    // The premise: a bare fsck over the same files does fail them.
    const bare = await run(
      ["git", "annex", "fsck", "--fast", "--from", "store", "--", ...paths],
      repo,
    );
    expect(bare.exitCode).not.toBe(0);

    const outcome = await checkRemoteHolds(repo, "store", paths, 2);

    expect(outcome).toMatchObject({
      success: true,
      present: 2,
      absent: [],
      unanswered: [],
      output: "understood",
    });
  });

  test("a file name with an ESCAPE in it never reaches the reasons raw", async () => {
    // Guards `clean`. git-annex echoes the name inside its messages ("** Based on the
    // location log, <name>"), and shortening only collapses whitespace, so an ESCAPE
    // sequence in the name would reach the terminal through the reason.
    const repo = await newDatasetRepo(scratch.root, "fsck-escape-name");
    const name = "esc\x1b[31mred.edf";
    writeFile(repo, name, "x".repeat(3_000));
    expect((await gitAnnexAdd(repo, [name])).success).toBe(true);
    const store = await initDirectoryRemote(scratch.root, repo, "store");
    expect((await run(["git", "annex", "copy", "--to", "store", "--", name], repo)).exitCode).toBe(
      0,
    );
    expect((await run(["git", "annex", "drop", "--force", "--", name], repo)).exitCode).toBe(0);
    chmodTreeWritable(store);
    for (const entry of readdirSync(store))
      rmSync(join(store, entry), { recursive: true, force: true });

    const outcome = await checkRemoteHolds(repo, "store", [name], 2);

    expect(outcome.absent).toHaveLength(1);
    // The record keeps the real path: callers match it against what they asked about.
    expect(outcome.absent[0].file).toBe(name);
    const reasons = outcome.absent[0].errors.join("\n");
    expect(reasons).toContain("red.edf");
    expect(reasons).not.toContain("\x1b");
    expect(reasons).toContain("\\x1b[31mred.edf");
  });

  test("a remote that cannot be reached is reported per file with its reason, not as present", async () => {
    const { repo, store, paths } = await droppedAfterCopy("fsck-unreachable", 2);
    renameSync(store, `${store}.gone`);
    const outcome = await checkRemoteHolds(repo, "store", paths, 2);
    expect(outcome.present).toBe(0);
    expect(outcome.absent.map((a) => a.file).sort()).toEqual([...paths].sort());
    expect(outcome.absent[0]?.errors.join(" ")).toContain(store);
  });
});

describe("extractCopyJsonError against real output", () => {
  test("names each failed file with the cause git-annex gave, for a declined remote", async () => {
    const cap = await captureCopy("missing", 2);
    const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
    expect(msg).toContain("2 file(s) failed to copy:");
    for (const p of cap.paths) expect(msg).toContain(`${p}: `);
    expect(msg).toContain(cap.store);
    expect(msg).not.toMatch(/: failed$/m);
    // git-annex's own stderr summary is appended whatever it says.
    expect(msg).toContain(cap.stderr.trim());
  });

  test.skipIf(!canBlockWrites)(
    "names each failed file with the cause for a failed transfer",
    async () => {
      const cap = await captureCopy("read-only", 2);
      const msg = extractCopyJsonError(parseCopyJson(cap.stdout), cap.stdout, cap.stderr);
      expect(msg).toContain("2 file(s) failed to copy:");
      for (const p of cap.paths) expect(msg).toContain(`${p}: `);
      // Once per file, not twice: the duplicate inside each record is dropped.
      expect(msg.split(cap.store).length - 1).toBe(cap.paths.length);
    },
  );

  test("bounds a many-file failure to the last failures, and says how many it left out", async () => {
    const cap = await captureCopy("missing", 30);
    const records = parseCopyJson(cap.stdout);
    expect(records).toHaveLength(30);
    const lines = extractCopyJsonError(records, cap.stdout, cap.stderr).split("\n");
    expect(lines[0]).toBe("30 file(s) failed to copy:");
    expect(lines[1]).toContain("10 earlier failed files omitted");
    // header, omission line, the 20 kept failures, git-annex's own summary line
    expect(lines).toHaveLength(23);
  });
});

describe("the copy functions report the cause end to end", () => {
  test("copyPathsToAnnexRemote returns the declined-remote reason and counts no success", async () => {
    const cap = await captureCopy("none", 2);
    // Re-break the remote for the production function under test.
    renameSync(cap.store, `${cap.store}.gone`);
    const result = await copyPathsToAnnexRemote(cap.repo, "store", cap.paths, 2);
    expect(result.success).toBe(false);
    expect(result.filesCopied).toBe(0);
    expect(result.error).toContain(cap.store);
  });

  test("copyToAnnexRemote returns the declined-remote reason too", async () => {
    const cap = await captureCopy("none", 2);
    renameSync(cap.store, `${cap.store}.gone`);
    const result = await copyToAnnexRemote(cap.repo, "store", 2);
    expect(result.success).toBe(false);
    expect(result.error).toContain(cap.store);
  });
});
