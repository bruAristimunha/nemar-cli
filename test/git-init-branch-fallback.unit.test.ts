/**
 * `git init -b main` needs git >= 2.28; an older git (for example Ubuntu 20.04's
 * 2.25) rejects it with a usage error. `initDataset` falls back to a plain
 * `git init` and points an unborn HEAD at `refs/heads/main`.
 *
 * What is under test is the production entry point, `initDataset`, run against
 * real git and real git-annex. The only stand-in is a `git` on PATH that stands
 * in for an OLDER git BINARY: it logs every call, answers `git init -b` the way
 * an older git does (a hand-written usage error, exit status 129), and passes
 * every other call to the real git, except the few a test makes it answer
 * itself to reach an error path. Every repository below is initialized by the
 * real git. The fallback must key on that exit status and never on the message,
 * because git localizes its messages: the stand-in is run with English and
 * German text and with no text at all, and the real git is asked for its status
 * under English, German and French.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { initDataset } from "../src/lib/git-annex/init";
import { ensureLocalMainBranch } from "../src/lib/git-annex/repo-state";

const foundGit = Bun.which("git");
if (foundGit === null) {
  throw new Error("test/git-init-branch-fallback.unit.test.ts needs a git executable on PATH");
}
const REAL_GIT: string = foundGit;
const AUTHOR = { name: "Test", email: "test@test.com" };

/** What every failure after the fallback began starts with. */
const FALLBACK_NOTE = "git init -b main was rejected (exit 129); ";

const root = mkdtempSync(join(tmpdir(), "nemar-git-init-"));
// A host default that is not "main": plain `git init` then leaves HEAD on
// "trunk", so a fallback that forgot to re-point HEAD cannot pass by accident.
const gitConfig = join(root, "gitconfig");
writeFileSync(gitConfig, "[init]\n\tdefaultBranch = trunk\n[commit]\n\tgpgsign = false\n");

// Canary. A plain init that lands on trunk proves the host git honors both
// init.defaultBranch (2.28) and GIT_CONFIG_GLOBAL (2.32); a git that ignores the
// override would leave the trunk default inert and the "never re-point HEAD"
// mistake would pass unseen. `init -b`, which the modern-git assertions rely on,
// arrived in 2.28 together with `init.defaultBranch`, so only GIT_CONFIG_GLOBAL
// (2.32) can be missing on a git that has `-b`. Such a host skips this file with a
// warning; CI must not.
git(root, "init", "-q", "canary");
const gitIsNewEnough = git(root, "-C", "canary", "symbolic-ref", "HEAD").out === "refs/heads/trunk";
if (!gitIsNewEnough) {
  const why = `${REAL_GIT} ignores GIT_CONFIG_GLOBAL (needs git >= 2.32)`;
  if (process.env.CI) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`git-init-branch-fallback tests: ${why}`);
  }
  console.warn(`SKIPPING test/git-init-branch-fallback.unit.test.ts: ${why}`);
}
const describeGit = describe.skipIf(!gitIsNewEnough);

/** The usage error of a git without `-b`: English as git 2.25 words it, a German wording, and no text. */
const OLD_GIT_STDERR = {
  english: [
    "error: unknown switch `b'",
    "usage: git init [-q | --quiet] [--bare] [--template=<template-directory>] [--shared[=<permissions>]] [<directory>]",
  ].join("\n"),
  german: [
    "Fehler: Unbekannter Schalter `b'",
    "Verwendung: git init [-q | --quiet] [--bare] [--template=<Vorlagenverzeichnis>] [--shared[=<Berechtigungen>]] [<Verzeichnis>]",
  ].join("\n"),
  // A git or wrapper whose stderr is discarded.
  empty: "",
};

/**
 * A call the stand-in answers itself instead of passing it on: `when` is the
 * start of the call's arguments joined by spaces, such as "init -b ".
 */
interface Answer {
  when: string;
  exit: number;
  stderr: string;
}

interface Shim {
  dir: string;
  log: string;
}

let shimCount = 0;

// The calls the stand-ins know how to answer.
const INIT_WITH_BRANCH = "init -b ";
const PLAIN_INIT = "init -- ";
const HEAD_REPOINT = "symbolic-ref HEAD refs/heads/main";
const REV_PARSE_HEAD = "rev-parse -q --verify HEAD";
const SHOW_REF = "show-ref --verify -q ";
const SYMBOLIC_REF_HEAD = "symbolic-ref -q HEAD";

const answer = (when: string, exit: number, stderr: string): Answer => ({ when, exit, stderr });

/**
 * A git stand-in on PATH: logs every call, answers the listed ones, runs the real
 * git for the rest. With no answers it is a plain logging wrapper over the host's
 * git, the stand-in for a modern git.
 */
function makeShim(answers: Answer[] = []): Shim {
  const dir = join(root, `shim-${shimCount++}`);
  const log = join(dir, "calls.log");
  mkdirSync(dir, { recursive: true });
  const arms = answers.flatMap((a) => [
    `  '${a.when}'*)`,
    ...(a.stderr ? ["cat >&2 <<'NEMAR_SHIM_EOF'", a.stderr, "NEMAR_SHIM_EOF"] : []),
    `    exit ${a.exit}`,
    "    ;;",
  ]);
  const body = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    ...(arms.length > 0 ? ['case "$*" in', ...arms, "esac"] : []),
    `exec '${REAL_GIT}' "$@"`,
    "",
  ];
  const shim = join(dir, "git");
  writeFileSync(shim, body.join("\n"));
  chmodSync(shim, 0o755);
  writeFileSync(log, "");
  return { dir, log };
}

/** An older-git stand-in: `git init -b` is a usage error (status 129) with this text. */
function oldGit(stderr: string, ...more: Answer[]): Shim {
  return makeShim([answer(INIT_WITH_BRANCH, 129, stderr), ...more]);
}

function calls(shim: Shim): string[] {
  return readFileSync(shim.log, "utf8").split("\n").filter(Boolean);
}

const initCalls = (shim: Shim): string[] => calls(shim).filter((l) => l.startsWith("init "));
const headRepoints = (shim: Shim): string[] =>
  calls(shim).filter((l) => l === "symbolic-ref HEAD refs/heads/main");

/** Run `fn` with `shim` first on PATH, and an init.defaultBranch that is not main. */
async function withShim<T>(shim: Shim, fn: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string> = {
    PATH: `${shim.dir}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: gitConfig,
  };
  const saved = Object.keys(overrides).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

/**
 * Real git, by absolute path, so inspecting a repository never writes to a shim
 * log, and under the test's own global config so the developer's does not leak in.
 */
function git(dir: string, ...args: string[]): { exit: number; out: string; err: string } {
  const r = spawnSync([REAL_GIT, ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig },
  });
  return {
    exit: r.exitCode ?? -1,
    out: r.stdout.toString().trim(),
    err: r.stderr.toString().trim(),
  };
}

/** `git`, but a fixture step that fails stops the test with git's own words. */
function gitOk(dir: string, ...args: string[]): string {
  const r = git(dir, ...args);
  if (r.exit !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.exit}): ${r.err}`);
  return r.out;
}

const subjects = (dir: string, ref: string): string[] =>
  git(dir, "log", "--format=%s", ref).out.split("\n").filter(Boolean);

const hasBranch = (dir: string, name: string): boolean =>
  git(dir, "show-ref", "--verify", "--quiet", `refs/heads/${name}`).exit === 0;

/**
 * An existing repository whose HEAD names `branch`, with one empty commit per
 * message, made by the real git under the test's config. With no messages the
 * branch is unborn. Plain `git init` plus `symbolic-ref` rather than `init -b`,
 * so the seed does not depend on the git version under test; `gitOk` throws on
 * any failing step, so a failing seed is not mistaken for a failing fallback.
 */
function seed(dir: string, branch: string, ...messages: string[]): void {
  mkdirSync(dir, { recursive: true });
  gitOk(dir, "init", "-q", ".");
  gitOk(dir, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  for (const message of messages) {
    gitOk(
      dir,
      ...["-c", "user.name=t", "-c", "user.email=t@t"],
      ...["commit", "-q", "--allow-empty", "-m", message],
    );
  }
}

let dirCount = 0;
function freshDir(): string {
  return join(root, `repo-${dirCount++}`);
}

afterAll(() => {
  // git-annex makes annexed content read-only; make the tree removable first.
  spawnSync(["chmod", "-R", "u+w", root]);
  rmSync(root, { recursive: true, force: true });
});

describeGit("what the real git answers", () => {
  // The fallback rests on a switch git does not know exiting 129 in every
  // locale (a fatal error exits 128, asserted with the path test below). The
  // stand-ins only hand-write that status, so the real git is asked here. A real git older than 2.28 is the
  // one case no test in this file can reach; check it by hand in a container
  // that has one (Ubuntu 20.04 ships 2.25): `git init -b main /tmp/x; echo $?`
  // should print 129.
  for (const locale of ["C", "de_DE.UTF-8", "fr_FR.UTF-8"]) {
    test(`an unknown switch exits 129 under LC_ALL=${locale}`, () => {
      const target = join(root, `unknown-switch-${locale}`);
      const r = spawnSync([REAL_GIT, "init", "--no-such-switch", target], {
        env: { ...process.env, LC_ALL: locale, LANGUAGE: locale.slice(0, 2) },
      });
      expect(r.exitCode).toBe(129);
      expect(r.stderr.toString()).not.toBe("");
    });
  }
});

// Guards the stand-ins themselves: if one stopped answering `git init -b` with
// status 129 and its text, the fallback tests below would pass or fail for the
// wrong reason.
describeGit("the older-git stand-ins", () => {
  for (const [name, stderr] of Object.entries(OLD_GIT_STDERR)) {
    test(`${name}: refuse git init -b with status 129 and say so on stderr`, async () => {
      const shim = oldGit(stderr);
      const r = await withShim(shim, async () =>
        spawnSync(["git", "init", "-b", "main", join(root, "probe")], { env: { ...process.env } }),
      );
      expect(r.exitCode).toBe(129);
      expect(r.stderr.toString().trim()).toBe(stderr);
    });
  }
});

describeGit("initDataset on a git that rejects --initial-branch (exit status 129)", () => {
  for (const [name, stderr] of Object.entries(OLD_GIT_STDERR)) {
    test(`${name} text: falls back, and the fresh dataset is on main`, async () => {
      const shim = oldGit(stderr);
      const dir = freshDir();
      const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

      expect(res).toEqual({ success: true });
      // -b was tried and refused, then the plain init, then HEAD was re-pointed.
      expect(initCalls(shim)).toEqual([`init -b main -- ${dir}`, `init -- ${dir}`]);
      expect(headRepoints(shim)).toHaveLength(1);
      // The unborn branch was main although the host's default is trunk, so
      // the "Initialize dataset" commit and the adjusted branch both sit on main.
      expect(subjects(dir, "refs/heads/main")).toEqual(["Initialize dataset"]);
      expect(hasBranch(dir, "trunk")).toBe(false);
      expect(git(dir, "symbolic-ref", "--short", "HEAD").out).toStartWith("adjusted/main");
    }, 30_000);
  }
});

describeGit("initDataset when a step of git init fails", () => {
  const cases = [
    {
      name: "fatal status 128 that happens to carry the old usage text",
      exit: 128,
      stderr: OLD_GIT_STDERR.english,
      error: OLD_GIT_STDERR.english,
    },
    {
      name: "status 1 with no message",
      exit: 1,
      stderr: "",
      error: "Failed to initialize git repository (exit 1)",
    },
  ];

  for (const c of cases) {
    test(`${c.name}: reported once, not retried`, async () => {
      const shim = makeShim([answer(INIT_WITH_BRANCH, c.exit, c.stderr)]);
      const dir = freshDir();
      const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

      expect(res).toEqual({ success: false, error: c.error });
      expect(initCalls(shim)).toEqual([`init -b main -- ${dir}`]);
      expect(headRepoints(shim)).toHaveLength(0);
    }, 30_000);
  }

  test("a path that cannot be created is reported by the real git, once", async () => {
    const shim = makeShim();
    const blocker = join(root, "a-file");
    writeFileSync(blocker, "x");
    const target = join(blocker, "sub");
    const res = await withShim(shim, () => initDataset(target, { author: AUTHOR }));

    // The report is git's own stderr, in whatever language git speaks here. A
    // later step failing on the missing directory would word it differently.
    const direct = spawnSync([REAL_GIT, "init", "-b", "main", "--", target]);
    // 128, not the usage error 129 the fallback keys on: a fatal error is not retried.
    expect(direct.exitCode).toBe(128);
    expect(direct.stderr.toString().trim()).not.toBe("");
    expect(res).toEqual({ success: false, error: direct.stderr.toString().trim() });
    expect(initCalls(shim)).toEqual([`init -b main -- ${target}`]);
    expect(headRepoints(shim)).toHaveLength(0);
  });

  // A failure after the fallback began says so, and says what failed: the
  // callers print it under "Failed to initialize git-annex dataset".
  const failingSteps = [
    {
      step: "plain git init",
      rule: PLAIN_INIT,
      said: "plain git init failed: ",
      repoints: 0,
    },
    {
      step: "HEAD re-point",
      rule: HEAD_REPOINT,
      said: "could not point HEAD at main: ",
      repoints: 1,
    },
  ];

  for (const f of failingSteps) {
    for (const [words, stderr, expected] of [
      ["git's words", "fatal: step refused", "fatal: step refused"],
      ["no words at all", "", "exit 128"],
    ] as const) {
      test(`a failing ${f.step} in the fallback is reported with ${words}`, async () => {
        const shim = oldGit(OLD_GIT_STDERR.english, answer(f.rule, 128, stderr));
        const dir = freshDir();
        const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

        expect(res).toEqual({ success: false, error: `${FALLBACK_NOTE}${f.said}${expected}` });
        expect(initCalls(shim)).toEqual([`init -b main -- ${dir}`, `init -- ${dir}`]);
        expect(headRepoints(shim)).toHaveLength(f.repoints);
      });
    }
  }
});

describeGit("initDataset with a path that starts with a dash", () => {
  // `--bare` as a switch would create a bare repository in the working directory
  // and then fail on the missing dataset directory; any other dash word is a
  // usage error (exit 129). Either way the path must be a path: the cwd is a
  // scratch directory, since a mistake here writes into the cwd.
  const gits = [
    { name: "modern git", make: () => makeShim() },
    { name: "git that rejects --initial-branch", make: () => oldGit(OLD_GIT_STDERR.english) },
  ];

  for (const g of gits) {
    test(`${g.name}: the path is a path, not a switch`, async () => {
      const work = freshDir();
      mkdirSync(work, { recursive: true });
      const shim = g.make();
      const before = process.cwd();
      process.chdir(work);
      let res: Awaited<ReturnType<typeof initDataset>>;
      try {
        res = await withShim(shim, () => initDataset("--bare", { author: AUTHOR }));
      } finally {
        process.chdir(before);
      }

      expect(res).toEqual({ success: true });
      expect(existsSync(join(work, "--bare", ".git"))).toBe(true);
      expect(existsSync(join(work, "HEAD"))).toBe(false);
      expect(initCalls(shim)[0]).toBe("init -b main -- --bare");
    }, 30_000);
  }
});

describeGit("initDataset on a modern git", () => {
  test("uses -b main directly: the fallback never runs", async () => {
    const shim = makeShim();
    const dir = freshDir();
    const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));

    expect(res).toEqual({ success: true });
    expect(initCalls(shim)).toEqual([`init -b main -- ${dir}`]);
    expect(headRepoints(shim)).toHaveLength(0);
    expect(subjects(dir, "refs/heads/main")).toEqual(["Initialize dataset"]);
    expect(hasBranch(dir, "trunk")).toBe(false);
  }, 30_000);
});

/**
 * `initDataset` followed by `ensureLocalMainBranch`, run back to back with
 * `yes: true`. The upload runs the second later, in `configureRemotes`; it makes
 * sure the branch is main and renames it if not.
 */
async function initThenEnsureMain(shim: Shim, dir: string): Promise<boolean> {
  return withShim(shim, async () => {
    const res = await initDataset(dir, { author: AUTHOR });
    expect(res).toEqual({ success: true });
    return ensureLocalMainBranch(dir, { yes: true });
  });
}

describeGit("initDataset where the branch name was not chosen by git init", () => {
  test("a fresh directory is already on main, so the upload renames nothing", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english);
    const dir = freshDir();
    const renamedOrKept = await initThenEnsureMain(shim, dir);

    expect(renamedOrKept).toBe(true);
    expect(git(dir, "symbolic-ref", "--short", "HEAD").out).toStartWith("adjusted/main");
    expect(subjects(dir, "refs/heads/main")).toEqual(["Initialize dataset"]);
    expect(hasBranch(dir, "trunk")).toBe(false);
    expect(hasBranch(dir, "master")).toBe(false);
  });

  test("a repository with history keeps it: HEAD is not re-pointed at a new root", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english);
    const dir = freshDir();
    seed(dir, "master", "c1", "c2");
    const renamedOrKept = await initThenEnsureMain(shim, dir);

    expect(renamedOrKept).toBe(true);
    // Plain init re-initialized the repository and HEAD was left where it was.
    expect(initCalls(shim)).toEqual([`init -b main -- ${dir}`, `init -- ${dir}`]);
    expect(headRepoints(shim)).toHaveLength(0);
    // master keeps its history with "Initialize dataset" on top...
    expect(subjects(dir, "refs/heads/master")).toEqual(["Initialize dataset", "c2", "c1"]);
    // ...and the branch check renames the adjusted branch built on it to main, so
    // main carries all of it plus the adjusted branch's own commit (one more
    // than master). Re-pointing HEAD at an unborn main would have made main a
    // one-commit root and stranded c1 and c2 on master.
    expect(subjects(dir, "refs/heads/main")).toEqual(
      expect.arrayContaining(["Initialize dataset", "c2", "c1"]),
    );
  }, 30_000);

  test("the fallback ends where a modern git does on the same repository", async () => {
    // On a modern git `init -b main` is ignored for an existing repository
    // (it warns "re-init: ignored --initial-branch=main"), so this is the
    // reference outcome for the fallback to match.
    const modernDir = freshDir();
    seed(modernDir, "master", "c1", "c2");
    await initThenEnsureMain(makeShim(), modernDir);
    // Equal because both kept the history, not because both came out empty.
    expect(subjects(modernDir, "refs/heads/main")).toEqual(
      expect.arrayContaining(["c1", "c2", "Initialize dataset"]),
    );

    const oldDir = freshDir();
    seed(oldDir, "master", "c1", "c2");
    await initThenEnsureMain(oldGit(OLD_GIT_STDERR.german), oldDir);

    expect(subjects(oldDir, "refs/heads/main")).toEqual(subjects(modernDir, "refs/heads/main"));
    expect(subjects(oldDir, "refs/heads/master")).toEqual(subjects(modernDir, "refs/heads/master"));
    expect(git(oldDir, "symbolic-ref", "HEAD").out).toBe(
      git(modernDir, "symbolic-ref", "HEAD").out,
    );
  }, 60_000);
});

describeGit("initDataset where HEAD names a branch with no commits", () => {
  test("an existing but unborn master is named main at once, with one re-point", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english);
    const dir = freshDir();
    seed(dir, "master");
    await initThenEnsureMain(shim, dir);

    expect(headRepoints(shim)).toHaveLength(1);
    expect(git(dir, "symbolic-ref", "--short", "HEAD").out).toStartWith("adjusted/main");
    expect(subjects(dir, "refs/heads/main")).toEqual(["Initialize dataset"]);
    expect(hasBranch(dir, "master")).toBe(false);
    expect(hasBranch(dir, "trunk")).toBe(false);
  }, 30_000);

  // Modern git ignores -b for an existing repository, so its unborn master is
  // committed to and then renamed; the fallback names main directly. Either way
  // main is an orphan that does not absorb develop, and develop is untouched.
  for (const [name, make] of [
    ["modern git", () => makeShim()],
    ["git that rejects --initial-branch", () => oldGit(OLD_GIT_STDERR.german)],
  ] as const) {
    test(`${name}: unborn master over a populated develop leaves develop alone`, async () => {
      const dir = freshDir();
      seed(dir, "develop", "d1");
      gitOk(dir, "symbolic-ref", "HEAD", "refs/heads/master");
      await initThenEnsureMain(make(), dir);

      expect(subjects(dir, "refs/heads/develop")).toEqual(["d1"]);
      expect(subjects(dir, "refs/heads/main")).toContain("Initialize dataset");
      expect(subjects(dir, "refs/heads/main")).not.toContain("d1");
    }, 30_000);
  }
});

/**
 * `initDataset` under `shim` must refuse: fail with the fallback note and an
 * error that mentions `mention`, without ever re-pointing HEAD.
 */
async function expectRefusal(shim: Shim, dir: string, mention: string): Promise<void> {
  const res = await withShim(shim, () => initDataset(dir, { author: AUTHOR }));
  expect(res.success).toBe(false);
  expect(res.error).toStartWith(FALLBACK_NOTE);
  expect(res.error).toContain(mention);
  expect(headRepoints(shim)).toHaveLength(0);
}

describeGit("initDataset where HEAD cannot be told apart from unborn", () => {
  test("a corrupt branch ref is refused with git's error and HEAD is left alone", async () => {
    const shim = oldGit(OLD_GIT_STDERR.english);
    const dir = freshDir();
    seed(dir, "master", "c1", "c2");
    // The state a modern git refuses on at its first commit ("reference broken").
    writeFileSync(join(dir, ".git", "refs", "heads", "master"), "not-a-sha\n");

    // rev-parse reports the broken branch as plain "does not resolve" (exit 1);
    // symbolic-ref is the probe that fails (exit 128 on git 2.54 and 2.56), and
    // its words, in whatever language git speaks here, are what the user gets.
    const probe = git(dir, "symbolic-ref", "-q", "HEAD");
    expect(probe.exit).not.toBe(0);
    expect(probe.err).not.toBe("");

    await expectRefusal(shim, dir, probe.err);
    expect(readFileSync(join(dir, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
    expect(existsSync(join(dir, ".git", "annex"))).toBe(false);
  });

  test("a rev-parse that fails for another reason than 'unresolved' is reported at once", async () => {
    const shim = oldGit(
      OLD_GIT_STDERR.english,
      answer(REV_PARSE_HEAD, 128, "fatal: simulated unreadable repository"),
    );
    await expectRefusal(shim, freshDir(), "fatal: simulated unreadable repository");

    // Neither the follow-up probes nor any write ran.
    expect(calls(shim).filter((l) => l.startsWith("symbolic-ref"))).toEqual([]);
    expect(calls(shim).filter((l) => l.startsWith("show-ref"))).toEqual([]);
  });

  test("an unresolved HEAD whose branch exists is refused, not re-pointed", async () => {
    // Stand-in for a state git cannot easily be walked into: rev-parse says
    // "does not resolve" (exit 1) while the branch ref it names exists.
    const shim = oldGit(OLD_GIT_STDERR.english, answer(REV_PARSE_HEAD, 1, ""));
    const dir = freshDir();
    seed(dir, "master", "c1", "c2");
    await expectRefusal(shim, dir, "refs/heads/master");
  });

  test("a symbolic-ref that names no branch is refused, not read as unborn", async () => {
    // `git show-ref --verify -q ""` exits 1, the same status as an absent branch,
    // so an empty branch name would read as unborn if it were not refused first.
    // Stand-in for symbolic-ref succeeding without naming anything.
    const shim = oldGit(OLD_GIT_STDERR.english, answer(SYMBOLIC_REF_HEAD, 0, ""));
    await expectRefusal(shim, freshDir(), "its branch cannot be read");
  });

  test("a show-ref that cannot tell is refused, not read as unborn", async () => {
    const shim = oldGit(
      OLD_GIT_STDERR.english,
      answer(SHOW_REF, 128, "fatal: simulated bad ref store"),
    );
    await expectRefusal(shim, freshDir(), "fatal: simulated bad ref store");
  });
});
