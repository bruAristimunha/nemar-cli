/**
 * The upload's acquisition dates (`src/lib/upload/date-normalization.ts`, ADR 0091), driven
 * against real directories: real EDF headers laid out as the format says, real symbolic and hard
 * links, real permission bits, a real git repository and a real git-annex one. Nothing is
 * replaced. The command-level behavior (what a dry run prints, that a refused or unconfirmed run
 * changes no file, that the steps run in that order) is in upload-identifier-preflight-cli.test.ts.
 *
 * Not exercised here: a recording on another filesystem than the dataset's directory. The walk does
 * not follow a symbolic link to a directory, so only a mount point inside the dataset reaches one,
 * and neither CI nor a sandboxed run can mount a filesystem. The check is the comparison of two
 * device numbers in `planUploadDates`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  constants,
  accessSync,
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { normalizeEdfDates } from "../shared/identifier-scrub";
import { runCommand } from "../src/lib/git-annex/run-command";
import {
  applyUploadDates,
  emptyDatePlan,
  gitView,
  planUploadDates,
} from "../src/lib/upload/date-normalization";
import {
  identifierPreflightStep,
  recheckIdentifierPreflight,
} from "../src/lib/upload/identifier-preflight";

function put(out: Uint8Array, text: string, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  out.set(new TextEncoder().encode(text).subarray(0, width), start);
}

/** A recording: an EDF+ header with both dates, then a payload no rule may touch. */
function recording(start = "15.03.85", slot = "15-MAR-1985", seed = 1): Uint8Array {
  const out = new Uint8Array(4096);
  out.fill(0x20, 0, 256);
  put(out, "0", 0, 8);
  put(out, "X X X X", 8, 80);
  put(out, `Startdate ${slot} X X X`, 88, 80);
  put(out, start, 168, 8);
  put(out, "10.11.12", 176, 8);
  let x = seed;
  for (let i = 256; i < out.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** The bytes of `recording()` the date rule may change: the day and month of each date. */
const DATE_BYTES = [98, 99, 101, 102, 103, 168, 169, 171, 172];

let root: string;

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "nemar-upload-dates-")), "dataset");
  mkdirSync(root);
});

afterEach(() => {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      chmodSync(full, st.isDirectory() ? 0o755 : 0o644);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dirname(root));
  rmSync(dirname(root), { recursive: true, force: true });
});

function write(rel: string, content: string | Uint8Array): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const read = (rel: string) => new Uint8Array(readFileSync(join(root, rel)));

function differing(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

async function git(args: string[], cwd = root): Promise<void> {
  const r = await runCommand(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const EDF = "sub-01/eeg/sub-01_task-rest_eeg.edf";
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** What a call printed with console.log, without color codes. */
async function printed(body: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(
      args.join(" ").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), ""),
    );
  };
  try {
    await body();
  } finally {
    console.log = log;
  }
  return lines;
}

describe("the plan reads and changes nothing", () => {
  test("a dated recording outside any repository is planned with the rule's own header", async () => {
    const path = write(EDF, recording());
    const before = statSync(path);
    const plan = await planUploadDates(root);
    expect(plan.items).toHaveLength(1);
    const [item] = plan.items;
    expect(item?.rel).toBe(EDF);
    expect(Buffer.from(item?.after ?? [])).toEqual(
      Buffer.from(normalizeEdfDates(recording()).header),
    );
    // Read-only: the same bytes and the same modification time.
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(join(root, ".nemar"))).toBe(false);
  });

  test("a year-only recording, a file that is not EDF, and a short one are not planned", async () => {
    write(EDF, recording("01.01.85", "01-JAN-1985"));
    write("sub-02/eeg/sub-02_task-rest_eeg.edf", "not an EDF file at all, just text\n".repeat(20));
    // Short of a whole header, though its start date is there: never read as a header.
    write("sub-03/eeg/sub-03_task-rest_eeg.edf", recording().subarray(0, 200));
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
  });

  test("a BDF recording is planned the same way", async () => {
    const bdf = recording();
    bdf[0] = 0xff;
    bdf.set(new TextEncoder().encode("BIOSEMI"), 1);
    write("sub-01/eeg/sub-01_task-rest_eeg.bdf", bdf);
    expect((await planUploadDates(root)).items).toHaveLength(1);
  });

  test("a symbolic link is left, wherever it points", async () => {
    const outside = join(dirname(root), "raw.edf");
    writeFileSync(outside, recording());
    mkdirSync(join(root, "sub-01/eeg"), { recursive: true });
    symlinkSync(outside, join(root, EDF));
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
    expect(plan.left.link).toBe(1);
  });

  // As root, every file is writable whatever its bits, so this says nothing there.
  test.skipIf(AS_ROOT)(
    "a file the uploader cannot write, or in a directory it cannot write, is left",
    async () => {
      const path = write(EDF, recording());
      chmodSync(path, 0o444);
      const readOnly = await planUploadDates(root);
      expect(readOnly.items).toEqual([]);
      expect(readOnly.left["not-writable"]).toBe(1);
      chmodSync(path, 0o644);
      chmodSync(dirname(path), 0o555);
      const lockedDir = await planUploadDates(root);
      expect(lockedDir.items).toEqual([]);
      expect(lockedDir.left["not-writable"]).toBe(1);
    },
  );

  test("in a git repository, a tracked file is left and an untracked one is planned", async () => {
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@nemar.test"]);
    await git(["config", "user.name", "NEMAR Test"]);
    write(EDF, recording());
    write("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("02.11.91", "02-NOV-1991", 2));
    write("sub-03/eeg/sub-03_task-rest_eeg.edf", recording("09.09.90", "09-SEP-1990", 3));
    await git(["add", EDF]);
    await git(["commit", "-qm", "one recording"]);
    // Staged and not committed is tracked too: the index is what is asked.
    await git(["add", "sub-02/eeg/sub-02_task-rest_eeg.edf"]);
    const plan = await planUploadDates(root);
    expect(plan.items.map((i) => i.rel)).toEqual(["sub-03/eeg/sub-03_task-rest_eeg.edf"]);
    expect(plan.left.tracked).toBe(2);
  });

  test("a path git spells in another case or Unicode form is still tracked", async () => {
    await git(["init", "-q", "-b", "main"]);
    write("sub-01/eeg/Café_eeg.edf", recording());
    await git(["add", "."]);
    const view = await gitView(root, ["sub-01/eeg/Caf\u00e9_eeg.edf"]);
    // Folded on both sides: NFC and lower case.
    expect(view?.tracked.has("sub-01/eeg/caf\u00e9_eeg.edf")).toBe(true);
    expect((await planUploadDates(root)).items).toEqual([]);
  });

  test("in a git-annex repository, an annexed recording is left", async () => {
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@nemar.test"]);
    await git(["config", "user.name", "NEMAR Test"]);
    await git(["annex", "init", "--quiet", "test"]);
    write(EDF, recording());
    await git(["annex", "add", "--quiet", EDF]);
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
    expect(plan.left.tracked).toBe(1);
    // The annex object is intact.
    await git(["annex", "fsck", "--quiet", EDF]);
  });

  test("git pointed elsewhere by GIT_DIR, at nothing it can read, plans no file", async () => {
    write(EDF, recording());
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dirname(root), "no-such-repository");
    try {
      const plan = await planUploadDates(root);
      expect(plan.items).toEqual([]);
      expect(plan.left["tracking-unknown"]).toBe(1);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env.GIT_DIR = saved;
    }
  });

  test("a file not named as a recording is never planned, whatever it holds", async () => {
    write("sub-01/eeg/notes.txt", recording());
    write("sub-01/eeg/sub-01_task-rest_eeg.edf.bak", recording());
    expect((await planUploadDates(root)).items).toEqual([]);
  });

  test("a recording git tracks under a decomposed Unicode name is still left", async () => {
    // macOS git precomposes names it reports; the name on disk stays decomposed. Folded to NFC on
    // both sides, the two agree. (On Linux git reports the name as written and this agrees anyway.)
    await git(["init", "-q", "-b", "main"]);
    write("sub-01/eeg/Cafe\u0301_eeg.edf", recording());
    await git(["add", "."]);
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
    expect(plan.left.tracked).toBe(1);
  });

  test("a recording inside a nested repository is left, tracked there or not", async () => {
    // A DataLad subdataset under sourcedata/: its own index, which the dataset's does not include.
    const nested = join(root, "sourcedata/raw");
    mkdirSync(nested, { recursive: true });
    await git(["init", "-q", "-b", "main"], nested);
    await git(["config", "user.email", "test@nemar.test"], nested);
    await git(["config", "user.name", "NEMAR Test"], nested);
    write("sourcedata/raw/a.edf", recording());
    await git(["add", "a.edf"], nested);
    await git(["commit", "-qm", "raw"], nested);
    write("sourcedata/raw/sub/b.edf", recording("02.11.91", "02-NOV-1991", 2));
    write(EDF, recording("09.09.90", "09-SEP-1990", 3));
    const plan = await planUploadDates(root);
    expect(plan.items.map((i) => i.rel)).toEqual([EDF]);
    expect(plan.left["nested-repository"]).toBe(2);
    applyUploadDates(root, plan);
    const status = await runCommand(["git", "status", "--porcelain"], { cwd: nested });
    expect(status.stdout).toBe("?? sub/\n");
  });

  test("a `.git` that is a dangling link still marks a nested repository", async () => {
    write("sourcedata/raw/a.edf", recording());
    symlinkSync(join(dirname(root), "gone"), join(root, "sourcedata/raw/.git"));
    const plan = await planUploadDates(root);
    expect(plan.items).toEqual([]);
    expect(plan.left["nested-repository"]).toBe(1);
  });

  test("a recording git would ignore is left: the upload never sends it", async () => {
    write(".gitignore", "sub-02/\n");
    write(EDF, recording());
    write("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("02.11.91", "02-NOV-1991", 2));
    // Outside any repository, the rules the upload's own repository will apply.
    const fresh = await planUploadDates(root);
    expect(fresh.items.map((i) => i.rel)).toEqual([EDF]);
    expect(fresh.left.ignored).toBe(1);
    // And inside one.
    await git(["init", "-q", "-b", "main"]);
    const inRepo = await planUploadDates(root);
    expect(inRepo.items.map((i) => i.rel)).toEqual([EDF]);
    expect(inRepo.left.ignored).toBe(1);
  });

  test.skipIf(process.platform !== "darwin" || AS_ROOT)(
    "a read-only file is left even when an access control list lets its owner write it",
    async () => {
      const path = write(EDF, recording());
      chmodSync(path, 0o444);
      const acl = await runCommand(["chmod", "+a", `${userInfo().username} allow write`, path]);
      expect(acl.exitCode, acl.stderr).toBe(0);
      // The premise: the system says the file can be written.
      let canWrite = true;
      try {
        accessSync(path, constants.W_OK);
      } catch {
        canWrite = false;
      }
      expect(canWrite).toBe(true);
      const plan = await planUploadDates(root);
      expect(plan.items).toEqual([]);
      expect(plan.left["not-writable"]).toBe(1);
      await runCommand(["chmod", "-N", path]);
    },
  );

  test("inside a repository where git cannot run, no file is planned", async () => {
    // A `.git` above the dataset, and no git on PATH: which files git tracks cannot be told.
    mkdirSync(join(dirname(root), ".git"));
    write(EDF, recording());
    const path = process.env.PATH;
    process.env.PATH = join(dirname(root), "no-tools");
    try {
      const plan = await planUploadDates(root);
      expect(plan.items).toEqual([]);
      expect(plan.left["tracking-unknown"]).toBe(1);
    } finally {
      if (path === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = path;
    }
  });
});

describe("applying the plan", () => {
  test("only the date bytes change; size, permissions and every other byte are kept", async () => {
    const path = write(EDF, recording());
    chmodSync(path, 0o640);
    const before = read(EDF);
    const plan = await planUploadDates(root);
    let result = applyUploadDates(root, emptyDatePlan());
    const lines = await printed(() => {
      result = applyUploadDates(root, plan);
    });
    expect(result).toMatchObject({ set: 1, left: 0 });
    const after = read(EDF);
    expect(after.length).toBe(before.length);
    const changed = differing(before, after);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.filter((i) => !DATE_BYTES.includes(i))).toEqual([]);
    const header = Buffer.from(after.subarray(0, 256)).toString("latin1");
    expect(header).toContain("Startdate 01-JAN-1985 X X X");
    expect(header.slice(168, 184)).toBe("01.01.8510.11.12");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(result.mtimes.get(EDF)).toBe(statSync(path).mtimeMs);
    expect(lines).toEqual([
      "  Acquisition dates in 1 recording header were set to 1 January of their year.",
    ]);
    // The work directory and the `.nemar/` it made are gone again.
    expect(existsSync(join(root, ".nemar"))).toBe(false);
  });

  // A group of this user's other than the one a new file would get, if there is one, on a
  // filesystem that keeps owners (a volume mounted `noowners` ignores every chown).
  const otherGroup = (process.getgroups?.() ?? []).find((g) => g !== process.getgid?.());
  const keepsOwners = (() => {
    if (otherGroup === undefined) return false;
    const probe = join(mkdtempSync(join(tmpdir(), "nemar-owners-")), "probe");
    try {
      writeFileSync(probe, "");
      chownSync(probe, -1, otherGroup);
      return statSync(probe).gid === otherGroup;
    } catch {
      return false;
    } finally {
      rmSync(dirname(probe), { recursive: true, force: true });
    }
  })();
  test.skipIf(!keepsOwners)("the file keeps its group", async () => {
    const path = write(EDF, recording());
    chownSync(path, -1, otherGroup as number);
    applyUploadDates(root, await planUploadDates(root));
    expect(differing(read(EDF), recording()).length).toBeGreaterThan(0);
    expect(statSync(path).gid).toBe(otherGroup as number);
  });

  test("another hard link to the same file keeps the original bytes", async () => {
    const path = write(EDF, recording());
    const backup = join(dirname(root), "backup.edf");
    linkSync(path, backup);
    const ino = statSync(path).ino;
    applyUploadDates(root, await planUploadDates(root));
    expect(Buffer.from(readFileSync(backup))).toEqual(Buffer.from(recording()));
    expect(statSync(path).ino).not.toBe(ino);
    expect(differing(read(EDF), recording()).length).toBeGreaterThan(0);
  });

  test("a header that changed after the plan is left, though size and times did not move", async () => {
    // A round modification time, so it can be put back exactly: what is left to tell the change
    // is the compare of the header bytes.
    const path = write(EDF, recording());
    const at = new Date(1_700_000_000_000);
    utimesSync(path, at, at);
    const plan = await planUploadDates(root);
    expect(plan.items[0]?.mtimeMs).toBe(at.getTime());
    const edited = recording();
    edited.set(new TextEncoder().encode("16"), 168);
    writeFileSync(path, edited);
    utimesSync(path, at, at);
    expect(statSync(path).mtimeMs).toBe(at.getTime());
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(edited));
  });

  test("a file replaced by another with the same bytes and times is left: the inode moved", async () => {
    const path = write(EDF, recording());
    const at = new Date(1_700_000_000_000);
    utimesSync(path, at, at);
    const plan = await planUploadDates(root);
    // Written beside it and renamed over it, so the new file's inode is another one for certain:
    // ext4 hands a freed inode number straight to the next file made.
    const replacement = join(dirname(path), "replacement.tmp");
    writeFileSync(replacement, recording());
    utimesSync(replacement, at, at);
    renameSync(replacement, path);
    expect(statSync(path).ino).not.toBe(plan.items[0]?.ino);
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
  });

  test("a file that grew after the plan, header and times as they were, is left", async () => {
    const path = write(EDF, recording());
    const at = new Date(1_700_000_000_000);
    utimesSync(path, at, at);
    const plan = await planUploadDates(root);
    writeFileSync(path, new Uint8Array([...recording(), 1, 2, 3]));
    utimesSync(path, at, at);
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
  });

  test("a copy that fails part way is removed, and the work directory with it", async () => {
    write(EDF, recording());
    const plan = await planUploadDates(root);
    // A plan whose new header cannot be written: the copy exists when the write fails.
    const [item] = plan.items;
    if (!item) throw new Error("expected a planned file");
    item.after = new Uint8Array(10);
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(existsSync(join(root, ".nemar"))).toBe(false);
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
  });

  test("a file whose modification time moved after the plan is left", async () => {
    const path = write(EDF, recording());
    const plan = await planUploadDates(root);
    utimesSync(path, new Date(), new Date(Date.now() + 60_000));
    const lines = await printed(() => {
      expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    });
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
    // None set: no line, and no claim that any was.
    expect(lines).toEqual([]);
  });

  test("a file replaced by a link after the plan is left, and its target untouched", async () => {
    const path = write(EDF, recording());
    const plan = await planUploadDates(root);
    const outside = join(dirname(root), "elsewhere.edf");
    writeFileSync(outside, recording());
    rmSync(path);
    symlinkSync(outside, path);
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(Buffer.from(readFileSync(outside))).toEqual(Buffer.from(recording()));
  });

  test("a `.nemar` that is a link sets nothing and creates nothing through it", async () => {
    write(EDF, recording());
    const elsewhere = join(dirname(root), "elsewhere-nemar");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, ".nemar"));
    const plan = await planUploadDates(root);
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 0, left: 1 });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));
  });

  test("a copy a crashed run left is removed by the next apply, even one with nothing to set", async () => {
    write(".nemar/date-normalization/123-0123456789abcdef", "stray copy");
    const lines = await printed(() => applyUploadDates(root, emptyDatePlan()));
    expect(readdirSync(join(root, ".nemar/date-normalization"))).toEqual([]);
    // Nothing set, nothing said.
    expect(lines).toEqual([]);
  });

  test("a copy a crashed run left in the work directory is removed; anything else there is kept", async () => {
    write(EDF, recording());
    write(".nemar/config.json", "{}");
    write(".nemar/date-normalization/123-0123456789abcdef", "stray copy");
    write(".nemar/date-normalization/keep-me", "not ours");
    applyUploadDates(root, await planUploadDates(root));
    expect(readdirSync(join(root, ".nemar/date-normalization"))).toEqual(["keep-me"]);
    expect(existsSync(join(root, ".nemar/config.json"))).toBe(true);
  });

  test("planning again after the apply finds nothing to do", async () => {
    write(EDF, recording());
    applyUploadDates(root, await planUploadDates(root));
    const again = await planUploadDates(root);
    expect(again.items).toEqual([]);
    expect(applyUploadDates(root, again)).toEqual({ set: 0, left: 0, mtimes: new Map() });
  });
});

describe("the preflight screens the tree as it will be sent", () => {
  function dataset(): void {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
    write(EDF, recording());
    write("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("02.11.91", "02-NOV-1991", 2));
    write(
      "sub-01/sub-01_scans.tsv",
      "filename\tacq_time\neeg/sub-01_task-rest_eeg.edf\t1985-03-15T10:00:00\n",
    );
  }

  test("planned dates are not warned about, the table's is, and the record sent holds only it", async () => {
    dataset();
    const plan = await planUploadDates(root);
    expect(plan.items).toHaveLength(2);
    let first: Awaited<ReturnType<typeof identifierPreflightStep>> | undefined;
    const firstLines = await printed(async () => {
      first = await identifierPreflightStep(root, {}, false, plan);
    });
    if (first?.status !== "ok" || first.value === null) throw new Error("expected a record");
    expect(first.value.scan.findings_by_kind).toEqual({ "acq-time-dated": 1 });
    expect(firstLines.some((l) => l.includes("(1 entry)"))).toBe(true);
    // Nothing is said about the dates before they are set, and nothing has changed yet.
    expect(firstLines.filter((l) => l.includes("1 January"))).toEqual([]);
    expect(Buffer.from(read(EDF))).toEqual(Buffer.from(recording()));

    const applyLines = await printed(() => {
      expect(applyUploadDates(root, plan).set).toBe(2);
    });
    expect(applyLines).toEqual([
      "  Acquisition dates in 2 recording headers were set to 1 January of their year.",
    ]);
    let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
    const lines = await printed(async () => {
      again = await recheckIdentifierPreflight(root, first?.value as never);
    });
    if (again?.status !== "ok") throw new Error("expected the recheck to pass");
    // The second screen reads the files as they are: the same count, so no second warning.
    expect(again.value.scan.findings_by_kind).toEqual({ "acq-time-dated": 1 });
    expect(lines.some((l) => l.includes("Warning: acquisition dates"))).toBe(false);
  });

  test("a planned file that could not be set is warned about by the second screen", async () => {
    dataset();
    const plan = await planUploadDates(root);
    let first: Awaited<ReturnType<typeof identifierPreflightStep>> | undefined;
    await printed(async () => {
      first = await identifierPreflightStep(root, {}, false, plan);
    });
    // The file moved under the plan: it is left, with its dates.
    utimesSync(join(root, EDF), new Date(), new Date(Date.now() + 60_000));
    expect(applyUploadDates(root, plan)).toMatchObject({ set: 1, left: 1 });
    let again: Awaited<ReturnType<typeof recheckIdentifierPreflight>> | undefined;
    const lines = await printed(async () => {
      again = await recheckIdentifierPreflight(root, first?.value as never);
    });
    if (again?.status !== "ok") throw new Error("expected the recheck to pass");
    expect(again.value.scan.findings_by_kind).toEqual({
      "edf-recording-startdate": 1,
      "edf-startdate": 1,
      "acq-time-dated": 1,
    });
    expect(lines.some((l) => l.includes("(3 entries)"))).toBe(true);
  });

  test("without a plan the step screens the files as they are, as before", async () => {
    dataset();
    let first: Awaited<ReturnType<typeof identifierPreflightStep>> | undefined;
    const lines = await printed(async () => {
      first = await identifierPreflightStep(root, {}, false);
    });
    if (first?.status !== "ok" || first.value === null) throw new Error("expected a record");
    expect(first.value.scan.findings_by_kind).toEqual({
      "edf-recording-startdate": 2,
      "edf-startdate": 2,
      "acq-time-dated": 1,
    });
    expect(lines.some((l) => l.includes("set to 1 January"))).toBe(false);
  });
});
