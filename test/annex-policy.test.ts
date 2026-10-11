/**
 * The annex policy has to hold in three places that cannot import each other:
 * the git-annex expression, the TypeScript predicate the upload manifest uses,
 * and the shell copy in scripts/nemar-restore-dataset.sh. Nothing in the type
 * system connects them, so these tests are what keeps them one policy.
 *
 * Real git-annex throughout: every "does this annex?" answer comes from
 * git-annex itself deciding on a real repo, never from a re-implementation of
 * its matching rules. That matters because the bug being fixed here (#1158) was
 * precisely a TS re-implementation quietly disagreeing with the real thing.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configureLargefiles, gitAnnexAdd, initDataset } from "../src/lib/git-annex/init";
import {
  ANNEX_SIZE_THRESHOLD_BYTES,
  buildLargefilesExpression,
  describeAnnexSizeThreshold,
  isCurrentLargefilesExpression,
  isNeverAnnexedMetadata,
  shouldAnnex,
} from "../src/lib/git-annex/policy";
import { runCommand } from "../src/lib/git-annex/run-command";

/**
 * Files spanning every branch of the policy. `size` is the real byte count
 * written to disk, so the size threshold is exercised for real rather than
 * asserted about.
 */
const FIXTURES: Array<{ path: string; size: number; why: string }> = [
  // The regression: a motion recording is data despite the .tsv extension, at
  // any size. The small one is the case the old rule missed entirely -- it fell
  // under the 100 kB manifest threshold, so it never reached `git annex add`.
  {
    path: "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv",
    size: 240_000,
    why: "motion recording, large",
  },
  {
    path: "sub-01/motion/sub-01_task-rest_tracksys-imu_motion.tsv",
    size: 800,
    why: "motion recording, below the size threshold",
  },
  // Motion's own sidecars are metadata and must stay readable in a bare clone.
  {
    path: "sub-01/motion/sub-01_task-walk_tracksys-imu_channels.tsv",
    size: 200_000,
    why: "motion sidecar, large but still metadata",
  },
  {
    path: "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.json",
    size: 150_000,
    why: "motion sidecar json, large but still metadata",
  },
  // Recognised recording containers annex regardless of size.
  { path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 500, why: "recording extension, tiny" },
  { path: "sub-01/eeg/sub-01_task-rest_eeg.set", size: 500, why: "recording extension, tiny" },
  // Metadata stays in git however big it gets (ADR 0015).
  { path: "sub-01/eeg/sub-01_task-rest_events.tsv", size: 300_000, why: "events sidecar, large" },
  { path: "participants.tsv", size: 3, why: "root metadata" },
  { path: "dataset_description.json", size: 400, why: "root metadata" },
  { path: "README", size: 120_000, why: "README stays in git at any size" },
  { path: "CHANGES", size: 120_000, why: "CHANGES stays in git at any size" },
  { path: ".bidsignore", size: 40, why: "root dotfile metadata" },
  // Compressed data annexes where the same size of plain .tsv would not: the
  // exclusion globs are exact, so *.tsv misses *.tsv.gz. Load-bearing for
  // _physio.tsv.gz / _stim.tsv.gz. Note it is the SIZE rule doing the work once
  // the exclusion is out of the way -- a small .tsv.gz still stays in git.
  {
    path: "sub-01/eeg/sub-01_task-rest_physio.tsv.gz",
    size: 300_000,
    why: "gzipped recording over the threshold",
  },
  {
    path: "sub-01/eeg/sub-01_task-nap_physio.tsv.gz",
    size: 5_000,
    why: "gzipped recording under the threshold",
  },
  // Unrecognised extensions fall through to the size threshold.
  { path: "derivatives/blob.dat", size: 300_000, why: "unknown extension over threshold" },
  { path: "derivatives/small.dat", size: 50, why: "unknown extension under threshold" },
  // The .github workflows that must never become symlinks (ADR 0015).
  { path: ".github/workflows/bids-validate.yml", size: 4_000, why: "CI workflow must stay in git" },
];

// Each test builds a repository and runs git-annex a few times; CI machines are slower
// than the 5 s default allows.
setDefaultTimeout(60_000);

let repoDir: string;
/** path -> true when git-annex itself put the file in the annex. */
const annexedByGitAnnex = new Map<string, boolean>();

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "nemar-annex-policy-"));

  const init = await initDataset(repoDir);
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);

  // Exactly what production does -- no test-only pattern override.
  const configured = await configureLargefiles(repoDir);
  if (!configured.success) throw new Error(`configureLargefiles failed: ${configured.error}`);

  for (const f of FIXTURES) {
    const abs = join(repoDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x".repeat(f.size));
  }

  const added = await gitAnnexAdd(
    repoDir,
    FIXTURES.map((f) => f.path),
  );
  if (!added.success) throw new Error(`gitAnnexAdd failed: ${added.error}`);

  // Read the staged mode straight out of the index. 120000 is a symlink, which
  // in a git-annex repo means an annex pointer; anything else is a plain blob.
  // `initDataset` leaves the repo on an adjusted-unlock branch, so also treat a
  // recorded annex pointer as annexed.
  const { stdout, exitCode, stderr } = await runCommand(["git", "ls-files", "-s"], {
    cwd: repoDir,
  });
  if (exitCode !== 0) throw new Error(`git ls-files failed: ${stderr}`);
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^(\d{6})\s+\S+\s+\d+\s+(.*)$/);
    if (!match) continue;
    const [, mode, path] = match;
    annexedByGitAnnex.set(path, mode === "120000");
  }

  // An adjusted-unlock repo stores annexed content as regular files carrying an
  // annex pointer, so cross-check with git-annex's own view and prefer it.
  const whereis = await runCommand(["git", "annex", "find", "--include=*"], { cwd: repoDir });
  if (whereis.exitCode === 0) {
    for (const path of whereis.stdout.trim().split("\n").filter(Boolean)) {
      annexedByGitAnnex.set(path, true);
    }
  }
}, 120_000);

// git-annex marks object files read-only; rm needs write+execute on dirs.
function chmodTreeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

afterAll(() => {
  if (!repoDir) return;
  chmodTreeWritable(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
});

describe("annex policy: git-annex is the oracle", () => {
  test("every fixture was actually staged", () => {
    for (const f of FIXTURES) {
      expect(annexedByGitAnnex.has(f.path), `${f.path} was not staged at all`).toBe(true);
    }
  });

  // The core guarantee: the TS predicate the upload manifest uses agrees with
  // what git-annex did, file for file. If these ever disagree, the manifest
  // either promises S3 for a file that stays in git (#1158) or skips a file that
  // needed `git annex add` and lets `git add -A` bury it in the repo.
  for (const f of FIXTURES) {
    test(`shouldAnnex matches git-annex for ${f.path} (${f.why})`, () => {
      expect(shouldAnnex(f.path, f.size)).toBe(annexedByGitAnnex.get(f.path) as boolean);
    });
  }
});

describe("annex policy: the motion regression (#1158)", () => {
  test("a motion recording is annexed at any size", () => {
    const big = "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv";
    const small = "sub-01/motion/sub-01_task-rest_tracksys-imu_motion.tsv";
    expect(annexedByGitAnnex.get(big)).toBe(true);
    expect(annexedByGitAnnex.get(small)).toBe(true);
    // Explicitly below the threshold, so this is the glob and not the size rule.
    expect(800).toBeLessThan(ANNEX_SIZE_THRESHOLD_BYTES);
  });

  test("motion sidecars stay in git so a bare clone is still readable", () => {
    expect(annexedByGitAnnex.get("sub-01/motion/sub-01_task-walk_tracksys-imu_channels.tsv")).toBe(
      false,
    );
    expect(annexedByGitAnnex.get("sub-01/motion/sub-01_task-walk_tracksys-imu_motion.json")).toBe(
      false,
    );
  });

  test("a motion recording is never treated as un-annexable metadata on import", () => {
    // The import un-annexes root metadata; it must not un-annex a recording
    // that upstream got right.
    expect(isNeverAnnexedMetadata("sub-01_task-walk_tracksys-imu_motion.tsv")).toBe(false);
    expect(isNeverAnnexedMetadata("participants.tsv")).toBe(true);
    expect(isNeverAnnexedMetadata("dataset_description.json")).toBe(true);
    expect(isNeverAnnexedMetadata("README")).toBe(true);
    expect(isNeverAnnexedMetadata("sub-01_task-rest_eeg.edf")).toBe(false);
  });
});

describe("annex policy: ADR 0015 invariants still hold", () => {
  test("metadata stays in git regardless of size", () => {
    for (const path of [
      "sub-01/eeg/sub-01_task-rest_events.tsv",
      "README",
      "CHANGES",
      ".github/workflows/bids-validate.yml",
    ]) {
      expect(annexedByGitAnnex.get(path), `${path} must stay in git`).toBe(false);
    }
  });

  test("compressed data escapes the *.tsv exclusion because the globs are exact", () => {
    // Same size, opposite outcome -- the only difference is the .gz suffix.
    expect(annexedByGitAnnex.get("sub-01/eeg/sub-01_task-rest_physio.tsv.gz")).toBe(true);
    expect(annexedByGitAnnex.get("sub-01/eeg/sub-01_task-rest_events.tsv")).toBe(false);
  });

  test("escaping the exclusion is not the same as always annexing", () => {
    // A .tsv.gz under the threshold has no include of its own to fall back on,
    // so it stays in git. The docs used to flatten this to "tsv.gz IS annexed".
    expect(annexedByGitAnnex.get("sub-01/eeg/sub-01_task-nap_physio.tsv.gz")).toBe(false);
  });
});

describe("annex policy: the shell copy cannot drift", () => {
  test("nemar-restore-dataset.sh ANNEX_LARGEFILES matches the policy module", () => {
    const script = readFileSync(
      join(import.meta.dir, "..", "scripts", "nemar-restore-dataset.sh"),
      "utf-8",
    );
    const match = script.match(/^ANNEX_LARGEFILES="(.*)"$/m);
    expect(match, "ANNEX_LARGEFILES not found in scripts/nemar-restore-dataset.sh").not.toBeNull();
    expect((match as RegExpMatchArray)[1]).toBe(buildLargefilesExpression());
  });
});

// ---------------------------------------------------------------------------
// The size threshold, byte for byte (ADR 0031, amendment of 2026-10-07)
// ---------------------------------------------------------------------------

/**
 * Every spelling of the threshold that a repository can carry is checked against
 * real git-annex at the bytes around the boundary. The expected outcome is written
 * as a literal (more than 100,000 bytes annexes), never derived from the constant:
 * git-annex reads `kb` as SI, so `largerthan=100kb` is 100,000 bytes. An expectation
 * computed from the constant could not disagree with a wrong constant.
 */
const BOUNDARY_SIZES = [99_999, 100_000, 100_001, 102_399, 102_400, 102_401] as const;

/**
 * The expression every `nm` dataset was configured with before the threshold was
 * rendered in exact bytes, verbatim. Hard-coded so that it stays the old spelling
 * whatever `buildLargefilesExpression` becomes.
 */
const LEGACY_EXPRESSION =
  "(include=*.edf or include=*.bdf or include=*.set or include=*.fif or include=*.vhdr or include=*.eeg or include=*.cnt or include=*.fdt or include=*_motion.tsv or largerthan=100kb) and (exclude=*.tsv or include=*_motion.tsv) and exclude=*.json and exclude=*.md and exclude=*.txt and exclude=*.yml and exclude=*.yaml and exclude=README* and exclude=LICENSE* and exclude=CHANGES* and exclude=.bidsignore and exclude=.gitignore";

const boundaryRepos: string[] = [];

/** Add one `.dat` per boundary size under `expression` and return what git-annex annexed. */
async function annexedAtBoundary(expression: string | undefined): Promise<Set<string>> {
  const dir = mkdtempSync(join(tmpdir(), "nemar-annex-boundary-"));
  boundaryRepos.push(dir);
  const init = await initDataset(dir);
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);
  const configured = await configureLargefiles(dir, expression);
  if (!configured.success) throw new Error(`configureLargefiles failed: ${configured.error}`);
  const paths = BOUNDARY_SIZES.map((size) => `size-${size}.dat`);
  for (const [i, size] of BOUNDARY_SIZES.entries()) {
    writeFileSync(join(dir, paths[i]), "x".repeat(size));
  }
  const added = await gitAnnexAdd(dir, paths);
  if (!added.success) throw new Error(`gitAnnexAdd failed: ${added.error}`);
  const found = await runCommand(["git", "annex", "find", "--include", "*"], { cwd: dir });
  if (found.exitCode !== 0) throw new Error(`git annex find failed: ${found.stderr}`);
  return new Set(found.stdout.split("\n").filter(Boolean));
}

afterAll(() => {
  for (const dir of boundaryRepos) {
    chmodTreeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("annex policy: the size threshold is 100,000 bytes", () => {
  test("the expression states the threshold in exact bytes, with no unit to misread", () => {
    const expression = buildLargefilesExpression();
    expect(expression).toContain("or largerthan=100000) and");
    expect(expression).not.toMatch(/largerthan=\S*kb/i);
    expect(ANNEX_SIZE_THRESHOLD_BYTES).toBe(100_000);
    expect(describeAnnexSizeThreshold()).toBe("100,000 bytes");
  });

  for (const [name, expression] of [
    ["the expression NEMAR configures today", undefined],
    ["the largerthan=100kb expression every earlier dataset carries", LEGACY_EXPRESSION],
  ] as const) {
    test(`real git-annex annexes more than 100,000 bytes and nothing less: ${name}`, async () => {
      const annexed = await annexedAtBoundary(expression);
      for (const size of BOUNDARY_SIZES) {
        expect(annexed.has(`size-${size}.dat`), `${size} bytes`).toBe(size > 100_000);
      }
    });

    test(`shouldAnnex agrees with real git-annex at every boundary size: ${name}`, async () => {
      const annexed = await annexedAtBoundary(expression);
      for (const size of BOUNDARY_SIZES) {
        expect(shouldAnnex(`size-${size}.dat`, size), `${size} bytes`).toBe(
          annexed.has(`size-${size}.dat`),
        );
      }
    });
  }

  test("the legacy spelling counts as NEMAR's policy and a different threshold does not", () => {
    // Datasets configured before the amendment carry `100kb`; the fleet sweep must not
    // read them as drifted. Both are the same rule, as the boundary tests above show.
    expect(isCurrentLargefilesExpression(buildLargefilesExpression())).toBe(true);
    expect(isCurrentLargefilesExpression(LEGACY_EXPRESSION)).toBe(true);
    expect(isCurrentLargefilesExpression(LEGACY_EXPRESSION.replace("100kb", "1mb"))).toBe(false);
    expect(isCurrentLargefilesExpression(LEGACY_EXPRESSION.replace("100kb", "100kib"))).toBe(false);
    expect(isCurrentLargefilesExpression("largerthan=100kb")).toBe(false);
  });
});
