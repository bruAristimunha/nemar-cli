/**
 * Real git-annex tests for annexRemoteExists, initOrEnableSpecialRemote,
 * and the initremote/enableremote fallback regex used by configureS3Remote.
 *
 * Validates that:
 *   - annexRemoteExists returns true only for a registered special remote
 *     and rejects the `here` alias, bare UUIDs, and annexed file paths
 *   - the fallback regex matches git-annex's wording but not S3 bucket
 *     errors that happen to contain the substring "already exists"
 *   - initOrEnableSpecialRemote falls back to enableremote on a duplicate
 *     name and surfaces real stderr otherwise
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import {
  isNonFastForwardPush,
  pushAnnexBranchToGitHub,
  pushToGitHub,
} from "../src/lib/git-annex/clone-push";
import {
  ANNEX_REMOTE_EXISTS_RE,
  annexRemoteExists,
  awsCredentialEnv,
  getAnnexS3Remotes,
  initOrEnableSpecialRemote,
  markInheritedOpenNeuroRemotesIgnored,
  selectAnnexS3Remote,
} from "../src/lib/git-annex/s3-remote";
import { extractWhereisKeyUrl } from "../src/lib/git-annex/transfer";
import { decideReimportMainReset } from "../src/lib/import-openneuro";
import { setVerbose } from "../src/lib/verbose";

describe("extractWhereisKeyUrl (#808 streaming whereis mapping)", () => {
  const run = (line: string): Map<string, string> => {
    const m = new Map<string, string>();
    extractWhereisKeyUrl(line, m);
    return m;
  };

  test("maps key -> first http/s3 url from whereis remotes", () => {
    const line = JSON.stringify({
      key: "SHA256E-s5--abc.edf",
      whereis: [{ urls: ["https://s3.amazonaws.com/openneuro.org/ds1/a.edf?versionId=x"] }],
    });
    expect(run(line).get("SHA256E-s5--abc.edf")).toBe(
      "https://s3.amazonaws.com/openneuro.org/ds1/a.edf?versionId=x",
    );
  });

  test("falls back to untrusted remotes and accepts s3:// urls", () => {
    const line = JSON.stringify({
      key: "k2",
      whereis: [{ urls: ["not-a-url"] }],
      untrusted: [{ urls: ["s3://openneuro.org/ds1/b.edf"] }],
    });
    expect(run(line).get("k2")).toBe("s3://openneuro.org/ds1/b.edf");
  });

  test("skips entries with no key, no usable url, blank lines, and malformed JSON", () => {
    expect(run("").size).toBe(0);
    expect(run("   ").size).toBe(0);
    expect(run("{not json").size).toBe(0); // SyntaxError swallowed, no throw
    expect(run(JSON.stringify({ whereis: [{ urls: ["https://x/y"] }] })).size).toBe(0); // no key
    expect(run(JSON.stringify({ key: "k3", whereis: [{ urls: ["ftp://x/y"] }] })).size).toBe(0); // no http/s3
  });
});

describe("isNonFastForwardPush (#808 finalize push race)", () => {
  test("detects git's non-fast-forward rejection wording", () => {
    // The exact stderr from the on005342 finalize failure.
    const realStderr =
      "To https://github.com/nemarDatasets/on005342.git\n" +
      " ! [rejected]        main -> main (fetch first)\n" +
      "error: failed to push some refs to 'https://github.com/nemarDatasets/on005342.git'\n" +
      "hint: Updates were rejected because the remote contains work that you do not\n" +
      "hint: have locally.";
    expect(isNonFastForwardPush(realStderr)).toBe(true);
    expect(isNonFastForwardPush("! [rejected] (non-fast-forward)")).toBe(true);
  });

  test("does NOT match unrelated push failures (so they fail loud, no pointless rebase)", () => {
    expect(isNonFastForwardPush("Permission denied (publickey).")).toBe(false);
    expect(isNonFastForwardPush("remote: Repository not found.")).toBe(false);
    expect(isNonFastForwardPush("")).toBe(false);
  });
});

describe("awsCredentialEnv (#190)", () => {
  test("returns undefined when no credentials are given (anonymous access)", () => {
    expect(awsCredentialEnv(undefined)).toBeUndefined();
  });

  test("maps access key + secret, omitting the session token when absent", () => {
    expect(awsCredentialEnv({ accessKeyId: "AKIA", secretAccessKey: "secret" })).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
  });

  test("includes AWS_SESSION_TOKEN when the credential carries one (STS)", () => {
    expect(
      awsCredentialEnv({ accessKeyId: "AKIA", secretAccessKey: "secret", sessionToken: "tok" }),
    ).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "tok",
    });
  });

  test("does not spread process.env (runCommand merges it) — only the credential keys", () => {
    const env = awsCredentialEnv({ accessKeyId: "AKIA", secretAccessKey: "secret" });
    expect(Object.keys(env ?? {}).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
  });
});

const TMP_DIR = join(import.meta.dir, ".test-annex-remote");

async function runCmd(
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

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

async function newAnnexRepo(name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  // Force the initial branch to `main` (not the runner's git default, which is
  // `master` on GitHub Actions but `main` on many dev machines). The Step 4c
  // re-import tests fetch/reset `origin/main` explicitly, and production
  // nemarDatasets repos are always `main`, so pinning it here keeps the harness
  // deterministic across environments instead of passing only where the dev's
  // init.defaultBranch happens to be main.
  const initGit = await runCmd(["git", "init", "-q", "-b", "main"], dir);
  if (initGit.exitCode !== 0) {
    throw new Error(`git init failed: ${initGit.stderr}`);
  }
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
  const initAnnex = await runCmd(["git", "annex", "init", "-q", "src"], dir);
  if (initAnnex.exitCode !== 0) {
    throw new Error(`git annex init failed: ${initAnnex.stderr}`);
  }
  return dir;
}

/** Clone `srcDir` (a real git-annex repo, not a fresh init) and initialize the
 *  clone's local git-annex state -- unlike newAnnexRepo, this shares history
 *  (main + git-annex branch) with the source. */
async function cloneAnnexRepo(srcDir: string, name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const clone = await runCmd(["git", "clone", "-q", srcDir, dir]);
  if (clone.exitCode !== 0) {
    throw new Error(`git clone failed: ${clone.stderr}`);
  }
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
  const initAnnex = await runCmd(["git", "annex", "init", "-q", name], dir);
  if (initAnnex.exitCode !== 0) {
    throw new Error(`git annex init failed: ${initAnnex.stderr}`);
  }
  return dir;
}

beforeAll(async () => {
  // Skip the whole suite cleanly if git-annex is not on PATH.
  const probe = await runCmd(["git", "annex", "version"]);
  if (probe.exitCode !== 0) {
    throw new Error("git-annex is required for this test file");
  }
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("annexRemoteExists", () => {
  test("returns false in a fresh annex repo with no special remotes", async () => {
    const repo = await newAnnexRepo("empty");
    expect(await annexRemoteExists(repo, "nemar-s3")).toBe(false);
  });

  test("returns false for a name not registered in the repo", async () => {
    const repo = await newAnnexRepo("only-directory");
    const dirRemote = join(repo, ".dir-remote");
    mkdirSync(dirRemote, { recursive: true });
    const init = await runCmd(
      [
        "git",
        "annex",
        "initremote",
        "local-dir",
        "type=directory",
        `directory=${dirRemote}`,
        "encryption=none",
      ],
      repo,
    );
    expect(init.exitCode).toBe(0);
    expect(await annexRemoteExists(repo, "nemar-s3")).toBe(false);
    // Sanity: it does see the one we just registered
    expect(await annexRemoteExists(repo, "local-dir")).toBe(true);
  });

  test("returns false for the 'here' alias (local repo, not a special remote)", async () => {
    const repo = await newAnnexRepo("here-alias");
    expect(await annexRemoteExists(repo, "here")).toBe(false);
  });

  test("returns false when the name is a bare local UUID", async () => {
    const repo = await newAnnexRepo("uuid-input");
    const probe = await runCmd(["git", "annex", "info", "here", "--json"], repo);
    const uuid = JSON.parse(probe.stdout).uuid as string;
    expect(uuid.length).toBeGreaterThan(0);
    expect(await annexRemoteExists(repo, uuid)).toBe(false);
  });

  test("returns false when the name collides with an annexed file path", async () => {
    const repo = await newAnnexRepo("file-collision");
    const filePath = join(repo, "nemar-s3");
    await Bun.write(filePath, "data");
    const add = await runCmd(["git", "annex", "add", "nemar-s3", "-q"], repo);
    expect(add.exitCode).toBe(0);
    await runCmd(["git", "commit", "-qm", "add"], repo);
    expect(await annexRemoteExists(repo, "nemar-s3")).toBe(false);
  });

  test("returns false in a non-annex git repo (graceful degrade)", async () => {
    const dir = join(TMP_DIR, `plain-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    await runCmd(["git", "init", "-q"], dir);
    expect(await annexRemoteExists(dir, "nemar-s3")).toBe(false);
  });
});

describe("initremote/enableremote fallback regex", () => {
  test("matches git-annex's actual duplicate-remote wording", () => {
    const stderr =
      "initremote nemar-s3 \n" +
      'git-annex: There is already a special remote named "nemar-s3". (Use enableremote to enable an existing special remote.)\n' +
      "failed\ninitremote: 1 failed\n";
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(true);
  });

  test("matches the duplicate message after progress chatter on the same stream", () => {
    const stderr =
      "initremote nemar-s3 (checking bucket...) (probing remote info...) \n" +
      "(Some intermediate warning that should not interfere)\n" +
      'git-annex: There is already a special remote named "nemar-s3". (Use enableremote to enable an existing special remote.)\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(true);
  });

  test("does not match S3 BucketAlreadyOwnedByYou message", () => {
    const stderr =
      "initremote nemar-s3 (checking bucket...) (creating bucket in us-east-2...) \n" +
      'git-annex: S3Error {s3StatusCode = Status {statusCode = 409, statusMessage = "Conflict"}, ' +
      's3ErrorCode = "BucketAlreadyOwnedByYou", s3ErrorMessage = "Your previous request to ' +
      'create the named bucket succeeded and you already own it."}\nfailed\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });

  test("does not match S3 BucketAlreadyExists message", () => {
    const stderr =
      "initremote nemar-s3 (checking bucket...) (creating bucket in us-east-2...) \n" +
      'git-annex: S3Error {s3StatusCode = Status {statusCode = 409, statusMessage = "Conflict"}, ' +
      's3ErrorCode = "BucketAlreadyExists", s3ErrorMessage = "The requested bucket name is ' +
      'not available."}\nfailed\n';
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });

  test("does not match a generic 'key already exists' substring", () => {
    const stderr = "something failed: object key already exists in bucket\n";
    expect(ANNEX_REMOTE_EXISTS_RE.test(stderr)).toBe(false);
  });
});

describe("initOrEnableSpecialRemote (end-to-end fallback)", () => {
  // Use type=directory remotes so we can exercise the duplicate-detection
  // and enableremote fallback paths without S3 credentials.
  function dirRemoteParams(dir: string): string[] {
    return ["type=directory", `directory=${dir}`, "encryption=none"];
  }

  test("first call performs initremote and registers the remote", async () => {
    const repo = await newAnnexRepo("e2e-init");
    const remoteDir = join(repo, ".remote-store");
    mkdirSync(remoteDir, { recursive: true });
    const result = await initOrEnableSpecialRemote(
      repo,
      "first-attempt",
      dirRemoteParams(remoteDir),
      {},
    );
    expect(result.success).toBe(true);
    expect(await annexRemoteExists(repo, "first-attempt")).toBe(true);
  });

  test("second call falls back to enableremote when the remote already exists", async () => {
    const repo = await newAnnexRepo("e2e-resume");
    const remoteDir = join(repo, ".remote-store");
    mkdirSync(remoteDir, { recursive: true });

    // Simulate a prior partial run: register, then drop local enablement so
    // the local-state seam still sees the remote in git-annex branch.
    const first = await initOrEnableSpecialRemote(
      repo,
      "resume-test",
      dirRemoteParams(remoteDir),
      {},
    );
    expect(first.success).toBe(true);

    const second = await initOrEnableSpecialRemote(
      repo,
      "resume-test",
      dirRemoteParams(remoteDir),
      {},
    );
    expect(second.success).toBe(true);
    expect(second.error).toBeUndefined();
  });

  test("getAnnexS3Remotes returns nothing for a fresh annex repo with no special remotes", async () => {
    const repo = await newAnnexRepo("get-empty");
    expect(await getAnnexS3Remotes(repo)).toEqual([]);
  });

  test("getAnnexS3Remotes filters remotes with annex-ignore=true", async () => {
    // Issue #401 Bug A: OpenNeuro mirrors leave inherited s3-PUBLIC/s3-PRIVATE
    // remotes. After import we mark them annex-ignore=true; getAnnexS3Remotes
    // must skip them so push never picks them as the upload destination.
    const repo = await newAnnexRepo("get-filter-ignored");

    // Fake an "S3 remote" via git config alone — we don't need a real bucket
    // for this test, just the shape getAnnexS3Remotes inspects.
    await runCmd(["git", "remote", "add", "nemar-s3", "https://example/nemar-s3"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-uuid", crypto.randomUUID()], repo);

    await runCmd(["git", "remote", "add", "s3-PUBLIC", "https://example/openneuro"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-uuid", crypto.randomUUID()], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-ignore", "true"], repo);

    const remotes = await getAnnexS3Remotes(repo);
    expect(remotes).toEqual(["nemar-s3"]);
  });

  test("selectAnnexS3Remote prefers nemar-s3 over inherited remotes", async () => {
    const repo = await newAnnexRepo("select-prefer-nemar");

    // Two non-ignored S3 remotes; getAnnexS3Remotes returns both; the picker
    // must choose nemar-s3 even when it's not first in iteration order.
    await runCmd(["git", "remote", "add", "s3-PUBLIC", "https://example/openneuro"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-uuid", crypto.randomUUID()], repo);

    await runCmd(["git", "remote", "add", "nemar-s3", "https://example/nemar-s3"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.nemar-s3.annex-uuid", crypto.randomUUID()], repo);

    const remotes = await getAnnexS3Remotes(repo);
    expect(remotes).toContain("nemar-s3");
    expect(remotes).toContain("s3-PUBLIC");
    expect(await selectAnnexS3Remote(repo, remotes)).toBe("nemar-s3");
  });

  test("selectAnnexS3Remote falls back to first match when nemar-s3 is absent", async () => {
    const repo = await newAnnexRepo("select-fallback");
    await runCmd(["git", "remote", "add", "custom-s3", "https://example/custom"], repo);
    await runCmd(["git", "config", "remote.custom-s3.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.custom-s3.annex-uuid", crypto.randomUUID()], repo);

    expect(await selectAnnexS3Remote(repo, ["custom-s3"])).toBe("custom-s3");
  });

  test("selectAnnexS3Remote returns null on empty input", async () => {
    const repo = await newAnnexRepo("select-empty");
    expect(await selectAnnexS3Remote(repo, [])).toBeNull();
  });

  test("selectAnnexS3Remote picks renamed remote by [nemar-s3] description", async () => {
    // Bug A tiebreaker: when an OpenNeuro-imported repo gets renamed so that
    // no remote is literally called `nemar-s3`, the git-annex *description*
    // still says `[nemar-s3]`. selectAnnexS3Remote should match by description
    // UUID rather than falling through to the first alphabetical candidate.
    const repo = await newAnnexRepo("select-description-tiebreaker");
    const remoteDir = join(repo, ".remote-store");
    mkdirSync(remoteDir, { recursive: true });

    // Real directory-type remote so git-annex assigns a real UUID and lets us
    // rename its description. Avoids needing S3 credentials.
    const init = await runCmd(
      [
        "git",
        "annex",
        "initremote",
        "alt-name",
        "type=directory",
        `directory=${remoteDir}`,
        "encryption=none",
      ],
      repo,
    );
    expect(init.exitCode).toBe(0);
    const rename = await runCmd(["git", "annex", "describe", "alt-name", "nemar-s3"], repo);
    expect(rename.exitCode).toBe(0);

    // Add a distractor s3-PUBLIC remote (config-only, alphabetically first).
    await runCmd(["git", "remote", "add", "s3-PUBLIC", "https://example/openneuro"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-s3", "true"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-uuid", crypto.randomUUID()], repo);
    // Flip annex-s3 on the directory remote too so getAnnexS3Remotes finds it.
    await runCmd(["git", "config", "remote.alt-name.annex-s3", "true"], repo);

    const remotes = await getAnnexS3Remotes(repo);
    expect(remotes).toContain("alt-name");
    expect(remotes).toContain("s3-PUBLIC");
    expect(remotes).not.toContain("nemar-s3");

    expect(await selectAnnexS3Remote(repo, remotes)).toBe("alt-name");
  });

  test("markInheritedOpenNeuroRemotesIgnored flags inherited remotes", async () => {
    // Upstream half of Bug A: after import-openneuro runs, any inherited
    // s3-PUBLIC / s3-PRIVATE remotes must come back with annex-ignore=true so
    // selectAnnexS3Remote filters them out on future pushes.
    const repo = await newAnnexRepo("mark-inherited-ignore");
    await runCmd(["git", "remote", "add", "s3-PUBLIC", "https://example/openneuro"], repo);
    await runCmd(["git", "config", "remote.s3-PUBLIC.annex-uuid", crypto.randomUUID()], repo);
    await runCmd(["git", "remote", "add", "s3-PRIVATE", "https://example/openneuro-priv"], repo);
    await runCmd(["git", "config", "remote.s3-PRIVATE.annex-uuid", crypto.randomUUID()], repo);

    const marked = await markInheritedOpenNeuroRemotesIgnored(repo);
    expect(marked.sort()).toEqual(["s3-PRIVATE", "s3-PUBLIC"]);

    const publicIgnore = await runCmd(["git", "config", "remote.s3-PUBLIC.annex-ignore"], repo);
    expect(publicIgnore.stdout.trim()).toBe("true");
    const privateIgnore = await runCmd(["git", "config", "remote.s3-PRIVATE.annex-ignore"], repo);
    expect(privateIgnore.stdout.trim()).toBe("true");
  });

  test("markInheritedOpenNeuroRemotesIgnored skips remotes that don't exist", async () => {
    const repo = await newAnnexRepo("mark-no-inherited");
    expect(await markInheritedOpenNeuroRemotesIgnored(repo)).toEqual([]);
  });

  test("a successful directory copy leaves new commits on local git-annex", async () => {
    // Bug C regression guard: nemar dataset push re-pushes git-annex after the
    // S3 copy because `git annex copy` creates new location commits. Without a
    // bucket we can't exercise the production push end-to-end, but we can pin
    // the invariant the fix relies on: copying to a remote advances the local
    // git-annex branch beyond its state before the copy.
    const repo = await newAnnexRepo("annex-copy-advances-branch");
    const remoteDir = join(repo, ".sink");
    mkdirSync(remoteDir, { recursive: true });
    const init = await runCmd(
      [
        "git",
        "annex",
        "initremote",
        "sink",
        "type=directory",
        `directory=${remoteDir}`,
        "encryption=none",
      ],
      repo,
    );
    expect(init.exitCode).toBe(0);

    // Add a real annexed file so the copy has something to do.
    await Bun.write(join(repo, "data.bin"), "payload");
    const add = await runCmd(["git", "annex", "add", "data.bin", "-q"], repo);
    expect(add.exitCode).toBe(0);
    await runCmd(["git", "commit", "-qm", "add data"], repo);

    const beforeRev = (await runCmd(["git", "rev-parse", "git-annex"], repo)).stdout.trim();
    expect(beforeRev.length).toBeGreaterThan(0);

    const copy = await runCmd(["git", "annex", "copy", "--to", "sink", "data.bin"], repo);
    expect(copy.exitCode).toBe(0);

    const afterRev = (await runCmd(["git", "rev-parse", "git-annex"], repo)).stdout.trim();
    expect(afterRev).not.toBe(beforeRev);
  });

  test("surfaces the real stderr when initremote fails for unrelated reasons", async () => {
    const repo = await newAnnexRepo("e2e-bad-params");
    // Missing required `directory=` param -> initremote refuses and prints
    // a useful error. Must not be matched by the duplicate-remote regex.
    const result = await initOrEnableSpecialRemote(
      repo,
      "bad-remote",
      ["type=directory", "encryption=none"],
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/There is already a special remote/);
  });
});

describe("idempotent retry: prepare reuses the existing nemar-s3 UUID (#969)", () => {
  // Reproduces the real sequence a RETRIED `prepare` runs (import-openneuro.ts
  // Step 4 -> Step 4b -> Step 5 -> Step 7) and pins the fix: fetch + `git
  // annex merge` the ALREADY-PUSHED nemarDatasets git-annex branch BEFORE
  // registering the S3 special remote, so annexRemoteExists sees the prior
  // "nemar-s3" registration and initOrEnableSpecialRemote takes the
  // enableremote path -- REUSING the UUID -- instead of minting a second,
  // independent one under the same name.
  //
  // An earlier version of this fix instead let pushToGitHub's git-annex
  // branch merge-on-rejection loop (clone-push.ts) reconcile two
  // INDEPENDENTLY-minted UUIDs after the fact. That merge succeeds (git
  // doesn't error), but it leaves BOTH uuids describing themselves as
  // "nemar-s3" in the branch -- and finalize's re-clone then hits
  // `git annex info nemar-s3` -> "multiple repositories with that
  // description", whose enableremote fallback hard-errors ("Multiple remotes
  // have that name"), permanently breaking the import. This test asserts the
  // actual fix: reuse, not merge-after-the-fact.
  test("a retry clone that merges origin's git-annex branch first reuses the prior UUID, not a second one", async () => {
    // "OpenNeuro"-like upstream: a plain annex repo with one file.
    const src = await newAnnexRepo("src-upstream");
    await Bun.write(join(src, "data.bin"), "payload");
    const add = await runCmd(["git", "annex", "add", "data.bin", "-q"], src);
    expect(add.exitCode).toBe(0);
    const commit = await runCmd(["git", "commit", "-qm", "add data"], src);
    expect(commit.exitCode).toBe(0);

    // Bare "nemarDatasets" remote.
    const bareDir = join(TMP_DIR, `bare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(bareDir, { recursive: true });
    const bareInit = await runCmd(["git", "init", "-q", "--bare"], bareDir);
    expect(bareInit.exitCode).toBe(0);

    // "First prepare": clone src, register nemar-s3 via the real production
    // helper (mirrors configureS3Remote's Step 5), push main + git-annex.
    const p1 = await cloneAnnexRepo(src, "p1");
    const store1 = join(p1, ".store1");
    mkdirSync(store1, { recursive: true });
    const init1 = await initOrEnableSpecialRemote(
      p1,
      "nemar-s3",
      ["type=directory", `directory=${store1}`, "encryption=none"],
      {},
    );
    expect(init1.success).toBe(true);
    const uuidAfterFirstPrepare = JSON.parse(
      (await runCmd(["git", "annex", "info", "nemar-s3", "--json"], p1)).stdout,
    ).uuid as string;
    expect(uuidAfterFirstPrepare.length).toBeGreaterThan(0);

    await runCmd(["git", "remote", "remove", "origin"], p1);
    const addOrigin1 = await runCmd(["git", "remote", "add", "origin", bareDir], p1);
    expect(addOrigin1.exitCode).toBe(0);
    const push1 = await pushToGitHub(p1, "origin");
    expect(push1.success).toBe(true);
    expect(push1.warning).toBeUndefined();

    // "Second prepare (retry)": an INDEPENDENT fresh clone of src, which by
    // itself has no knowledge of p1's registration -- reproducing the real
    // gap. Mirrors Step 4 (reconfigure origin -> nemarDatasets) then Step 4b
    // (fetch + merge origin's git-annex branch) BEFORE Step 5 (register the
    // S3 remote).
    const p2 = await cloneAnnexRepo(src, "p2");
    await runCmd(["git", "remote", "remove", "origin"], p2);
    const addOrigin2 = await runCmd(["git", "remote", "add", "origin", bareDir], p2);
    expect(addOrigin2.exitCode).toBe(0);

    // Step 4b: the actual fix under test.
    const annexFetch = await runCmd(["git", "fetch", "origin", "git-annex"], p2);
    expect(annexFetch.exitCode).toBe(0);
    const annexMerge = await runCmd(["git", "annex", "merge"], p2);
    expect(annexMerge.exitCode).toBe(0);

    // Step 5: register nemar-s3 again, through the SAME production helper. It
    // must now see the merged-in registration and enableremote (reuse),
    // never initremote (mint a second uuid) -- store2 is deliberately a
    // DIFFERENT path than store1 to prove the reused params don't matter:
    // enableremote wins on the name match, not the directory.
    const store2 = join(p2, ".store2");
    mkdirSync(store2, { recursive: true });
    const init2 = await initOrEnableSpecialRemote(
      p2,
      "nemar-s3",
      ["type=directory", `directory=${store2}`, "encryption=none"],
      {},
    );
    expect(init2.success).toBe(true);
    const uuidAfterRetry = JSON.parse(
      (await runCmd(["git", "annex", "info", "nemar-s3", "--json"], p2)).stdout,
    ).uuid as string;
    expect(uuidAfterRetry).toBe(uuidAfterFirstPrepare);

    // Step 7: with the branches already merged, the push is a plain
    // fast-forward -- no rejection, no reliance on the safety-net loop.
    const push2 = await pushToGitHub(p2, "origin");
    expect(push2.success).toBe(true);
    expect(push2.warning).toBeUndefined();

    // Finalize simulation: a THIRD, fresh clone of the bare remote must see
    // exactly one unambiguous "nemar-s3" registration at the SAME uuid --
    // the concrete proof that finalize's `git annex info nemar-s3` /
    // enableremote would succeed rather than hard-erroring on "multiple
    // repositories with that description".
    const checker = await cloneAnnexRepo(bareDir, "checker");
    const checkerInfo = await runCmd(["git", "annex", "info", "nemar-s3", "--json"], checker);
    expect(checkerInfo.exitCode).toBe(0);
    const checkerParsed = JSON.parse(checkerInfo.stdout);
    expect(checkerParsed.success).toBe(true);
    expect(checkerParsed.uuid).toBe(uuidAfterFirstPrepare);
    const checkerEnable = await initOrEnableSpecialRemote(
      checker,
      "nemar-s3",
      ["type=directory", `directory=${store2}`, "encryption=none"],
      {},
    );
    expect(checkerEnable.success).toBe(true);
  });
});

describe("first git-annex branch push prunes unpublished description history (#1399)", () => {
  const personalDescription = "user@node:/private/scratch/secret";

  async function repoWithLegacyDescription(name: string): Promise<string> {
    const repo = await newAnnexRepo(name);
    const personal = await runCmd(["git", "annex", "describe", "here", personalDescription], repo);
    expect(personal.exitCode).toBe(0);
    const safe = await runCmd(["git", "annex", "describe", "here", "nemar-deposit"], repo);
    expect(safe.exitCode).toBe(0);
    await Bun.write(join(repo, "README.md"), "first push fixture\n");
    expect((await runCmd(["git", "add", "README.md"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "fixture"], repo)).exitCode).toBe(0);
    return repo;
  }

  async function bareOrigin(name: string): Promise<string> {
    const bare = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(bare, { recursive: true });
    const init = await runCmd(["git", "init", "-q", "--bare"], bare);
    expect(init.exitCode).toBe(0);
    return bare;
  }

  async function remoteHasDescription(bare: string, description: string): Promise<boolean> {
    const history = await runCmd(["git", "--git-dir", bare, "rev-list", "refs/heads/git-annex"]);
    expect(history.exitCode).toBe(0);
    for (const revision of history.stdout.trim().split("\n").filter(Boolean)) {
      const log = await runCmd(["git", "--git-dir", bare, "show", `${revision}:uuid.log`]);
      expect(log.exitCode).toBe(0);
      if (log.stdout.includes(description)) return true;
    }
    return false;
  }

  test("re-roots local annex history before its first remote push", async () => {
    const repo = await repoWithLegacyDescription("first-push-legacy");
    const bare = await bareOrigin("first-push-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);

    const result = await pushToGitHub(repo, "origin");

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const remoteLog = await runCmd([
      "git",
      "--git-dir",
      bare,
      "show",
      "refs/heads/git-annex:uuid.log",
    ]);
    expect(remoteLog.exitCode).toBe(0);
    expect(remoteLog.stdout).toContain("nemar-deposit");
    expect(remoteLog.stdout).not.toContain(personalDescription);
    expect(await remoteHasDescription(bare, personalDescription)).toBe(false);
    const history = await runCmd([
      "git",
      "--git-dir",
      bare,
      "rev-list",
      "--count",
      "refs/heads/git-annex",
    ]);
    expect(history.stdout.trim()).toBe("1");
  });

  test("leaves an already-published annex branch history intact", async () => {
    const repo = await repoWithLegacyDescription("existing-push-legacy");
    const bare = await bareOrigin("existing-push-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "push", "origin", "main"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "push", "origin", "git-annex"], repo)).exitCode).toBe(0);
    const historyBefore = await runCmd([
      "git",
      "--git-dir",
      bare,
      "rev-list",
      "refs/heads/git-annex",
    ]);
    expect(historyBefore.exitCode).toBe(0);
    expect(historyBefore.stdout.trim().split("\n").length).toBeGreaterThan(1);
    expect(await remoteHasDescription(bare, personalDescription)).toBe(true);

    const result = await pushToGitHub(repo, "origin");

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const historyAfter = await runCmd([
      "git",
      "--git-dir",
      bare,
      "rev-list",
      "refs/heads/git-annex",
    ]);
    expect(historyAfter.stdout).toBe(historyBefore.stdout);
    expect(await remoteHasDescription(bare, personalDescription)).toBe(true);
  });

  test("withholds a local-only default description when the remote annex branch already exists", async () => {
    const repo = await newAnnexRepo("existing-safe-remote-local-secret");
    const bare = await bareOrigin("existing-safe-remote-local-secret-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);
    await Bun.write(join(repo, "README.md"), "published safe fixture\n");
    expect((await runCmd(["git", "add", "README.md"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "fixture"], repo)).exitCode).toBe(0);

    const firstPush = await pushToGitHub(repo, "origin");
    expect(firstPush.success).toBe(true);
    expect(firstPush.warning).toBeUndefined();
    expect(
      (await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])).exitCode,
    ).toBe(0);
    expect(await remoteHasDescription(bare, personalDescription)).toBe(false);
    const publishedRef = (
      await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])
    ).stdout.trim();

    expect(
      (await runCmd(["git", "annex", "describe", "here", personalDescription], repo)).exitCode,
    ).toBe(0);
    expect(
      (await runCmd(["git", "annex", "describe", "here", "nemar-deposit"], repo)).exitCode,
    ).toBe(0);
    expect(
      (
        await runCmd(
          [
            "git",
            "log",
            "--format=",
            "--no-color",
            "-m",
            "-p",
            "refs/heads/git-annex",
            "--",
            "uuid.log",
          ],
          repo,
        )
      ).stdout,
    ).toContain(personalDescription);
    expect(
      (await runCmd(["git", "--git-dir", bare, "show", "refs/heads/git-annex:uuid.log"])).stdout,
    ).not.toContain(personalDescription);

    const result = await pushToGitHub(repo, "origin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("unpublished machine-specific description");
    expect(result.error).not.toContain(personalDescription);
    expect(
      (await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])).stdout.trim(),
    ).toBe(publishedRef);
    expect(await remoteHasDescription(bare, personalDescription)).toBe(false);
  });

  test("annex-only pushes withhold descriptions added after an earlier safe push", async () => {
    const repo = await newAnnexRepo("annex-only-local-secret");
    const bare = await bareOrigin("annex-only-local-secret-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);
    await Bun.write(join(repo, "README.md"), "published safe fixture\n");
    expect((await runCmd(["git", "add", "README.md"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "fixture"], repo)).exitCode).toBe(0);

    const firstPush = await pushAnnexBranchToGitHub(repo, "origin");
    expect(firstPush.success).toBe(true);
    const publishedRef = (
      await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])
    ).stdout.trim();

    expect(
      (await runCmd(["git", "annex", "describe", "here", personalDescription], repo)).exitCode,
    ).toBe(0);
    expect(
      (await runCmd(["git", "annex", "describe", "here", "nemar-deposit"], repo)).exitCode,
    ).toBe(0);

    const result = await pushAnnexBranchToGitHub(repo, "origin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("unpublished machine-specific description");
    expect(result.error).not.toContain(personalDescription);
    expect(
      (await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])).stdout.trim(),
    ).toBe(publishedRef);
    expect(await remoteHasDescription(bare, personalDescription)).toBe(false);
  });

  test("refuses to check one remote and push the annex history to another", async () => {
    const repo = await newAnnexRepo("split-push-url");
    const fetchRemote = await bareOrigin("split-push-url-fetch");
    const pushRemote = await bareOrigin("split-push-url-push");
    expect((await runCmd(["git", "remote", "add", "origin", fetchRemote], repo)).exitCode).toBe(0);
    expect(
      (await runCmd(["git", "annex", "describe", "here", personalDescription], repo)).exitCode,
    ).toBe(0);
    expect((await runCmd(["git", "push", "origin", "git-annex"], repo)).exitCode).toBe(0);
    expect(await remoteHasDescription(fetchRemote, personalDescription)).toBe(true);
    expect(
      (await runCmd(["git", "annex", "describe", "here", "nemar-deposit"], repo)).exitCode,
    ).toBe(0);
    expect(
      (await runCmd(["git", "remote", "set-url", "--push", "origin", pushRemote], repo)).exitCode,
    ).toBe(0);

    const result = await pushAnnexBranchToGitHub(repo, "origin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("push target does not match");
    const pushRefs = await runCmd([
      "git",
      "--git-dir",
      pushRemote,
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
    ]);
    expect(pushRefs.exitCode).toBe(0);
    expect(pushRefs.stdout).toBe("");
  });

  test("refuses a remote configured with multiple push URLs", async () => {
    const repo = await newAnnexRepo("multiple-push-urls");
    const firstPushRemote = await bareOrigin("multiple-push-urls-first");
    const secondPushRemote = await bareOrigin("multiple-push-urls-second");
    expect((await runCmd(["git", "remote", "add", "origin", firstPushRemote], repo)).exitCode).toBe(
      0,
    );
    expect(
      (await runCmd(["git", "remote", "set-url", "--push", "origin", firstPushRemote], repo))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await runCmd(
          ["git", "remote", "set-url", "--add", "--push", "origin", secondPushRemote],
          repo,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      (await runCmd(["git", "remote", "get-url", "--push", "--all", "origin"], repo)).stdout
        .trim()
        .split("\n"),
    ).toEqual([firstPushRemote, secondPushRemote]);

    const result = await pushAnnexBranchToGitHub(repo, "origin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("push target does not match one verified fetch URL");
    for (const remote of [firstPushRemote, secondPushRemote]) {
      const refs = await runCmd([
        "git",
        "--git-dir",
        remote,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
      ]);
      expect(refs.exitCode).toBe(0);
      expect(refs.stdout).toBe("");
    }
  });

  test("refuses remote URLs with embedded HTTP credentials without echoing them", async () => {
    const repo = await newAnnexRepo("embedded-http-credentials");
    const remote = "https://user:super-secret-token@example.invalid/nemar/dataset.git";
    expect((await runCmd(["git", "remote", "add", "origin", remote], repo)).exitCode).toBe(0);

    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    setVerbose(true);
    let result: Awaited<ReturnType<typeof pushAnnexBranchToGitHub>>;
    try {
      result = await pushAnnexBranchToGitHub(repo, "origin");
    } finally {
      setVerbose(false);
      process.stderr.write = write;
    }

    expect(result.success).toBe(false);
    expect(result.error).toContain("embeds HTTP credentials");
    expect(result.error).not.toContain("super-secret-token");
    expect(chunks.join("")).toContain("[sensitive subprocess output suppressed]");
    expect(chunks.join("")).not.toContain("super-secret-token");
  });

  test("withholds a local-only default description from another merged annex UUID", async () => {
    const repo = await newAnnexRepo("other-uuid-local-secret");
    const bare = await bareOrigin("other-uuid-local-secret-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);
    await Bun.write(join(repo, "README.md"), "published safe fixture\n");
    expect((await runCmd(["git", "add", "README.md"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "fixture"], repo)).exitCode).toBe(0);
    expect((await pushToGitHub(repo, "origin")).success).toBe(true);

    const other = await cloneAnnexRepo(repo, "other-user@node:/private/clone");
    expect((await runCmd(["git", "remote", "add", "other-clone", other], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "fetch", "other-clone", "git-annex"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "annex", "merge"], repo)).exitCode).toBe(0);

    const localHistory = await runCmd(
      [
        "git",
        "log",
        "--format=",
        "--no-color",
        "-m",
        "-p",
        "refs/heads/git-annex",
        "--",
        "uuid.log",
      ],
      repo,
    );
    expect(localHistory.stdout).toContain("other-user@node:/private/clone");
    expect(await remoteHasDescription(bare, "other-user@node:/private/clone")).toBe(false);

    const result = await pushToGitHub(repo, "origin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("unpublished machine-specific description");
    expect(await remoteHasDescription(bare, "other-user@node:/private/clone")).toBe(false);
  });

  test("allows the known NEMAR import-runner description from another annex UUID", async () => {
    const repo = await newAnnexRepo("other-uuid-runner");
    const bare = await bareOrigin("other-uuid-runner-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);
    await Bun.write(join(repo, "README.md"), "published safe fixture\n");
    expect((await runCmd(["git", "add", "README.md"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "fixture"], repo)).exitCode).toBe(0);
    expect((await pushToGitHub(repo, "origin")).success).toBe(true);

    const runnerDescription = "runner@runnervmlun5p:/tmp/nemar-import-test";
    const other = await cloneAnnexRepo(repo, runnerDescription);
    expect((await runCmd(["git", "remote", "add", "import-runner", other], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "fetch", "import-runner", "git-annex"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "annex", "merge"], repo)).exitCode).toBe(0);

    const result = await pushToGitHub(repo, "origin");

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(await remoteHasDescription(bare, runnerDescription)).toBe(true);
  });

  // An OpenNeuro clone arrives with the source's git-annex branch merged in, and OpenNeuro names
  // its own repositories in git-annex's default `user@host:/path` form (ds000001's uuid.log has
  // `root@93184394ac19:/datalad/ds000001`). Those lines belong to the source, the importing
  // runner cannot change them there, and every one of 20 older OpenNeuro datasets checked
  // (ds000001 to ds000248) carries one.
  describe("a default description inherited from the clone's source (OpenNeuro import)", () => {
    const sourceDescription = "root@93184394ac19:/datalad/ds000001";

    async function importedClone(name: string): Promise<{ repo: string; bare: string }> {
      const upstream = await newAnnexRepo(`${name}-upstream`);
      expect(
        (await runCmd(["git", "annex", "describe", "here", sourceDescription], upstream)).exitCode,
      ).toBe(0);
      await Bun.write(join(upstream, "README.md"), "source dataset\n");
      expect((await runCmd(["git", "add", "README.md"], upstream)).exitCode).toBe(0);
      expect((await runCmd(["git", "commit", "-qm", "source"], upstream)).exitCode).toBe(0);
      const repo = await cloneAnnexRepo(upstream, `${name}-import`);
      const bare = await bareOrigin(`${name}-origin`);
      expect((await runCmd(["git", "remote", "set-url", "origin", bare], repo)).exitCode).toBe(0);
      const merged = await runCmd(["git", "show", "refs/heads/git-annex:uuid.log"], repo);
      expect(merged.stdout).toContain(sourceDescription);
      return { repo, bare };
    }

    test("does not stop the first push, and is not published", async () => {
      const { repo, bare } = await importedClone("openneuro-source");

      const result = await pushToGitHub(repo, "origin");

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
      // The label is replaced before the push, and the replaced value is in no commit the remote
      // received: the branch was pruned again after the rewrite.
      expect(await remoteHasDescription(bare, sourceDescription)).toBe(false);
      expect(await remoteHasDescription(bare, "upstream")).toBe(true);
    });

    test("replaces every other repository's description, not only the first", async () => {
      const { repo, bare } = await importedClone("openneuro-two");
      const second = await cloneAnnexRepo(repo, "second-collaborator");
      expect(
        (await runCmd(["git", "annex", "describe", "here", "other@node:/private/clone"], second))
          .exitCode,
      ).toBe(0);
      expect((await runCmd(["git", "remote", "add", "second", second], repo)).exitCode).toBe(0);
      expect((await runCmd(["git", "fetch", "second", "git-annex"], repo)).exitCode).toBe(0);
      expect((await runCmd(["git", "annex", "merge"], repo)).exitCode).toBe(0);
      const merged = (await runCmd(["git", "show", "refs/heads/git-annex:uuid.log"], repo)).stdout;
      expect(merged).toContain(sourceDescription);
      expect(merged).toContain("other@node:/private/clone");

      const result = await pushToGitHub(repo, "origin");

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(await remoteHasDescription(bare, sourceDescription)).toBe(false);
      expect(await remoteHasDescription(bare, "other@node:/private/clone")).toBe(false);
    });

    test("a -diff attribute on uuid.log does not hide a description from the scan", async () => {
      // `git log -p` prints "Binary files differ" and exits 0 for such a path, which would read
      // as a history with nothing in it. The dataset's own .gitattributes is in the tree pushed.
      const { repo, bare } = await importedClone("openneuro-binary");
      await Bun.write(join(repo, ".gitattributes"), "*.log -diff\n");
      expect((await runCmd(["git", "add", ".gitattributes"], repo)).exitCode).toBe(0);
      expect((await runCmd(["git", "commit", "-qm", "attributes"], repo)).exitCode).toBe(0);
      expect(
        (await runCmd(["git", "annex", "describe", "here", "me@laptop:/home/me/data"], repo))
          .exitCode,
      ).toBe(0);

      const result = await pushToGitHub(repo, "origin");

      expect(result.success).toBe(false);
      expect(result.error).toContain("machine-specific description");
      expect(
        (await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])).exitCode,
      ).not.toBe(0);
    });

    test("a hostile first token in the source's uuid.log is never handed to git as an option", async () => {
      // uuid.log comes from the clone's source. A line whose "uuid" is `-ccore.fsmonitor=./x`
      // would be an option to `git annex describe`, which runs a program named by the config.
      const { repo, bare } = await importedClone("openneuro-hostile");
      const marker = join(repo, "marker");
      await Bun.write(join(repo, "x"), `#!/bin/sh\ntouch "${marker}"\n`);
      expect((await runCmd(["chmod", "+x", join(repo, "x")], repo)).exitCode).toBe(0);
      const current = (await runCmd(["git", "show", "refs/heads/git-annex:uuid.log"], repo)).stdout;
      const hostile = `${current}-ccore.fsmonitor=./x evil@host:/tmp/evil timestamp=1s\n`;
      const blob = (
        await runCmd(
          ["sh", "-c", `printf '%s' "$1" | git hash-object -w --stdin`, "sh", hostile],
          repo,
        )
      ).stdout.trim();
      const index = join(repo, ".git", "hostile-index");
      const withIndex = (args: string[]) =>
        runCmd(["env", `GIT_INDEX_FILE=${index}`, "git", ...args], repo);
      expect((await withIndex(["read-tree", "refs/heads/git-annex"])).exitCode).toBe(0);
      expect(
        (await withIndex(["update-index", "--add", "--cacheinfo", `100644,${blob},uuid.log`]))
          .exitCode,
      ).toBe(0);
      const tree = (await withIndex(["write-tree"])).stdout.trim();
      const commit = (
        await runCmd(
          ["git", "commit-tree", tree, "-p", "refs/heads/git-annex", "-m", "hostile"],
          repo,
        )
      ).stdout.trim();
      expect(
        (await runCmd(["git", "update-ref", "refs/heads/git-annex", commit], repo)).exitCode,
      ).toBe(0);

      const result = await pushToGitHub(repo, "origin");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a uuid");
      expect(existsSync(marker)).toBe(false);
      expect(
        (await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])).exitCode,
      ).not.toBe(0);
    });

    test("still refuses when the depositor's own repository has a default description", async () => {
      const { repo, bare } = await importedClone("openneuro-own");
      expect(
        (await runCmd(["git", "annex", "describe", "here", "me@laptop:/home/me/data"], repo))
          .exitCode,
      ).toBe(0);

      const result = await pushToGitHub(repo, "origin");

      expect(result.success).toBe(false);
      expect(result.error).toContain("machine-specific description");
      expect(result.error).toContain("git annex describe here");

      // The way out the message names works, and the refused text is never published.
      expect(
        (await runCmd(["git", "annex", "describe", "here", "nemar-deposit"], repo)).exitCode,
      ).toBe(0);
      const retry = await pushToGitHub(repo, "origin");
      expect(retry.error).toBeUndefined();
      expect(retry.success).toBe(true);
      expect(await remoteHasDescription(bare, "me@laptop:/home/me/data")).toBe(false);
      expect(await remoteHasDescription(bare, sourceDescription)).toBe(false);
    });
  });

  test("pushes only the checked annex snapshot if the local branch advances before push", async () => {
    const repo = await newAnnexRepo("annex-snapshot-race");
    const bare = await bareOrigin("annex-snapshot-race-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);
    await Bun.write(join(repo, "README.md"), "published safe fixture\n");
    expect((await runCmd(["git", "add", "README.md"], repo)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "fixture"], repo)).exitCode).toBe(0);
    expect((await pushToGitHub(repo, "origin")).success).toBe(true);
    const publishedRef = (
      await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])
    ).stdout.trim();

    expect(
      (await runCmd(["git", "annex", "describe", "here", "nemar-deposit-next"], repo)).exitCode,
    ).toBe(0);
    const checkedRef = (
      await runCmd(["git", "rev-parse", "refs/heads/git-annex"], repo)
    ).stdout.trim();
    expect(checkedRef).not.toBe(publishedRef);

    const secretDescription = "race-user@node:/private/race";
    const concurrent = await cloneAnnexRepo(repo, secretDescription);
    expect((await runCmd(["git", "remote", "add", "concurrent", concurrent], repo)).exitCode).toBe(
      0,
    );
    expect(
      (
        await runCmd(
          ["git", "fetch", "concurrent", "git-annex:refs/scratch/concurrent-git-annex"],
          repo,
        )
      ).exitCode,
    ).toBe(0);
    const concurrentRef = (
      await runCmd(["git", "rev-parse", "refs/scratch/concurrent-git-annex"], repo)
    ).stdout.trim();
    expect(concurrentRef).not.toBe(publishedRef);
    const realGit = (await runCmd(["which", "git"])).stdout.trim();
    expect(realGit).not.toBe("");
    const wrapperDir = join(TMP_DIR, `git-wrapper-${Date.now()}`);
    mkdirSync(wrapperDir, { recursive: true });
    const wrapper = join(wrapperDir, "git");
    const raceMarker = join(wrapperDir, "race-triggered");
    writeFileSync(
      wrapper,
      `#!/bin/sh
if [ "$(pwd)" = "${repo}" ] && [ "$1" = push ] && [ "$2" = "${bare}" ] && [ "$3" != "" ] && [ ! -e "${raceMarker}" ]; then
  case "$3" in
    *:refs/heads/git-annex)
      "${realGit}" -C "${repo}" update-ref refs/heads/git-annex "${concurrentRef}" || exit 1
      : > "${raceMarker}"
      ;;
  esac
fi
exec "${realGit}" "$@"
`,
    );
    chmodSync(wrapper, 0o755);

    const originalPath = process.env.PATH;
    let result: Awaited<ReturnType<typeof pushToGitHub>>;
    try {
      process.env.PATH = `${wrapperDir}:${originalPath ?? ""}`;
      result = await pushToGitHub(repo, "origin");
    } finally {
      if (originalPath === undefined) process.env.PATH = undefined;
      else process.env.PATH = originalPath;
    }

    expect(existsSync(raceMarker)).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("local annex branch advanced during the push");
    expect(
      (await runCmd(["git", "--git-dir", bare, "rev-parse", "refs/heads/git-annex"])).stdout.trim(),
    ).toBe(checkedRef);
    expect(await remoteHasDescription(bare, secretDescription)).toBe(false);
  });

  test("does not publish unpruned history if first-push pruning fails", async () => {
    const repo = await repoWithLegacyDescription("first-push-prune-fails");
    const bare = await bareOrigin("first-push-prune-fails-origin");
    expect((await runCmd(["git", "remote", "add", "origin", bare], repo)).exitCode).toBe(0);
    const refHook = join(repo, ".git", "hooks", "reference-transaction");
    writeFileSync(
      refHook,
      '#!/bin/sh\nwhile read old new ref; do\n  [ "$ref" = refs/heads/git-annex ] && exit 1\ndone\nexit 0\n',
    );
    chmodSync(refHook, 0o755);

    const result = await pushToGitHub(repo, "origin");

    expect(result.success).toBe(false);
    expect(result.error).toContain("history could not be pruned");
    const refs = await runCmd([
      "git",
      "--git-dir",
      bare,
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
    ]);
    expect(refs.exitCode).toBe(0);
    expect(refs.stdout).toBe("");
  });
});

describe("Step 4c: re-import main-reset avoids the diverging-history push failure (#990)", () => {
  // Reproduces the real re-import sequence: `prepare` (import-openneuro.ts)
  // clones FRESH from OpenNeuro every time, so a re-import's clone shares
  // only the pre-NEMAR upstream history with whatever nemarDatasets/<id>
  // already carries -- it knows nothing about a PRIOR import's metadata
  // commit already sitting on origin's `main`. Step 6 (seedMetadata +
  // commit) then creates the same .nemar/metadata.json path again with
  // different content, and Step 7's push (pushToGitHub, clone-push.ts) tries
  // to reconcile via fetch+rebase -- which hits a real "both added"
  // conflict and hard-fails ("diverging commits and auto-rebase failed").
  // Step 4c fixes this by resetting the fresh clone's `main` onto
  // origin/main BEFORE the metadata commit, so there is nothing to diverge.

  async function writeMetadata(dir: string, version: number): Promise<void> {
    mkdirSync(join(dir, ".nemar"), { recursive: true });
    await Bun.write(join(dir, ".nemar", "metadata.json"), JSON.stringify({ version }));
  }

  async function commitMetadata(dir: string, message: string): Promise<void> {
    const add = await runCmd(["git", "add", ".nemar/metadata.json"], dir);
    expect(add.exitCode).toBe(0);
    const commit = await runCmd(["git", "commit", "-qm", message], dir);
    expect(commit.exitCode).toBe(0);
  }

  async function newUpstreamAndBare(tag: string): Promise<{ src: string; bareDir: string }> {
    const src = await newAnnexRepo(`step4c-upstream-${tag}`);
    await Bun.write(join(src, "README.md"), "upstream dataset\n");
    expect((await runCmd(["git", "add", "README.md"], src)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "upstream readme"], src)).exitCode).toBe(0);

    const bareDir = join(
      TMP_DIR,
      `bare-step4c-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(bareDir, { recursive: true });
    // `-b main` so the bare repo's HEAD points at main, not the runner's git
    // default (`master` on CI). Otherwise a later `git clone` of this bare repo
    // resolves HEAD to a nonexistent `master` and checks out nothing, so the
    // "third clone sees both metadata commits" assertion counts 0 on CI.
    expect((await runCmd(["git", "init", "-q", "--bare", "-b", "main"], bareDir)).exitCode).toBe(0);
    return { src, bareDir };
  }

  test("regression guard: a fresh re-import clone's metadata commit collides and pushToGitHub fails", async () => {
    const { src, bareDir } = await newUpstreamAndBare("a");

    // First import.
    const p1 = await cloneAnnexRepo(src, "step4c-p1-a");
    await writeMetadata(p1, 1);
    await commitMetadata(p1, "Add NEMAR metadata (imported from OpenNeuro ds000001)");
    await runCmd(["git", "remote", "remove", "origin"], p1);
    expect((await runCmd(["git", "remote", "add", "origin", bareDir], p1)).exitCode).toBe(0);
    const push1 = await pushToGitHub(p1, "origin");
    expect(push1.success).toBe(true);

    // Re-import: a FRESH clone of the upstream (not of bareDir), exactly
    // like a retried `prepare` -- it shares only the upstream readme commit
    // with origin, not the metadata commit.
    const p2 = await cloneAnnexRepo(src, "step4c-p2-a");
    await runCmd(["git", "remote", "remove", "origin"], p2);
    expect((await runCmd(["git", "remote", "add", "origin", bareDir], p2)).exitCode).toBe(0);
    await writeMetadata(p2, 2);
    await commitMetadata(p2, "Add NEMAR metadata (imported from OpenNeuro ds000001)");

    // Without Step 4c: pushToGitHub's fetch+rebase hits a real "both added"
    // conflict on .nemar/metadata.json and hard-fails.
    const pushResult = await pushToGitHub(p2, "origin");
    expect(pushResult.success).toBe(false);
    expect(pushResult.error).toMatch(/diverging commits and auto-rebase failed/i);
  });

  test("fix: Step 4c resets main onto origin/main first, so the same re-import push succeeds", async () => {
    const { src, bareDir } = await newUpstreamAndBare("b");

    // First import.
    const p1 = await cloneAnnexRepo(src, "step4c-p1-b");
    await writeMetadata(p1, 1);
    await commitMetadata(p1, "Add NEMAR metadata (imported from OpenNeuro ds000002)");
    await runCmd(["git", "remote", "remove", "origin"], p1);
    expect((await runCmd(["git", "remote", "add", "origin", bareDir], p1)).exitCode).toBe(0);
    const push1 = await pushToGitHub(p1, "origin");
    expect(push1.success).toBe(true);
    const firstImportSha = (await runCmd(["git", "rev-parse", "main"], p1)).stdout.trim();

    // Re-import: another FRESH clone of the same upstream.
    const p2 = await cloneAnnexRepo(src, "step4c-p2-b");
    await runCmd(["git", "remote", "remove", "origin"], p2);
    expect((await runCmd(["git", "remote", "add", "origin", bareDir], p2)).exitCode).toBe(0);

    // Step 4c, run exactly as import-openneuro.ts's prepare() does it.
    const originMainFetch = await runCmd(["git", "fetch", "origin", "main"], p2);
    expect(originMainFetch.exitCode).toBe(0);
    const originMainRev = await runCmd(
      ["git", "rev-parse", "--verify", "--quiet", "origin/main"],
      p2,
    );
    const currentBranch = await runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], p2);
    const shouldReset = decideReimportMainReset({
      originMainSha: originMainRev.stdout.trim() || null,
      currentBranch: currentBranch.stdout.trim(),
    });
    expect(shouldReset).toBe(true);
    const reset = await runCmd(["git", "reset", "--hard", "origin/main"], p2);
    expect(reset.exitCode).toBe(0);

    // Step 6, AFTER the reset: the metadata commit now lands on TOP of
    // origin/main (the first import's tip), not on the clone's own
    // unrelated history.
    await writeMetadata(p2, 2);
    await commitMetadata(p2, "Add NEMAR metadata (imported from OpenNeuro ds000002)");

    // Step 7: plain fast-forward, no rebase needed.
    const push2 = await pushToGitHub(p2, "origin");
    expect(push2.success).toBe(true);
    expect(push2.warning).toBeUndefined();

    // Confirm it's a genuine fast-forward: the first import's commit is an
    // ancestor of the pushed tip.
    const isAncestor = await runCmd(
      ["git", "merge-base", "--is-ancestor", firstImportSha, "HEAD"],
      p2,
    );
    expect(isAncestor.exitCode).toBe(0);

    // A third, independent clone of the remote sees BOTH metadata commits
    // and the latest content -- nothing was squashed or rebased away.
    const checker = await cloneAnnexRepo(bareDir, "step4c-checker-b");
    const log = await runCmd(["git", "log", "--oneline"], checker);
    const metadataCommitCount = log.stdout
      .split("\n")
      .filter((line) => line.includes("Add NEMAR metadata")).length;
    expect(metadataCommitCount).toBe(2);
    const metadataContent = await Bun.file(join(checker, ".nemar", "metadata.json")).text();
    expect(JSON.parse(metadataContent).version).toBe(2);
  });

  test("recovery: same-version re-import with identical metadata is a no-op commit and a no-op push (#990 Gap 1, primary recovery path)", async () => {
    // The actual #967 recovery scenario Step 4c exists for: re-copying data
    // for a version NEMAR already imported once. seedMetadata is a pure
    // function of (nemarId, openneuroId, bidsDesc, openNeuroDoi) with no
    // timestamp, so a same-version recovery run writes BYTE-FOR-BYTE
    // identical .nemar/metadata.json content to the first import -- there is
    // nothing new to commit or push, and that must be a clean success, not
    // an error.
    const { src, bareDir } = await newUpstreamAndBare("c");

    // First import.
    const p1 = await cloneAnnexRepo(src, "step4c-p1-c");
    await writeMetadata(p1, 1);
    await commitMetadata(p1, "Add NEMAR metadata (imported from OpenNeuro ds000003)");
    await runCmd(["git", "remote", "remove", "origin"], p1);
    expect((await runCmd(["git", "remote", "add", "origin", bareDir], p1)).exitCode).toBe(0);
    const push1 = await pushToGitHub(p1, "origin");
    expect(push1.success).toBe(true);
    const firstImportSha = (await runCmd(["git", "rev-parse", "main"], p1)).stdout.trim();

    // Recovery re-import: another FRESH clone of the same upstream.
    const p2 = await cloneAnnexRepo(src, "step4c-p2-c");
    await runCmd(["git", "remote", "remove", "origin"], p2);
    expect((await runCmd(["git", "remote", "add", "origin", bareDir], p2)).exitCode).toBe(0);

    // Step 4c, run exactly as import-openneuro.ts's prepare() does it.
    const originMainFetch = await runCmd(["git", "fetch", "origin", "main"], p2);
    expect(originMainFetch.exitCode).toBe(0);
    const originMainRev = await runCmd(
      ["git", "rev-parse", "--verify", "--quiet", "origin/main"],
      p2,
    );
    const currentBranch = await runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], p2);
    const shouldReset = decideReimportMainReset({
      originMainSha: originMainRev.stdout.trim() || null,
      currentBranch: currentBranch.stdout.trim(),
    });
    expect(shouldReset).toBe(true);
    const reset = await runCmd(["git", "reset", "--hard", "origin/main"], p2);
    expect(reset.exitCode).toBe(0);

    // Step 6: re-seed IDENTICAL content (version 1, same as the first
    // import) -- `git add` stages nothing (content unchanged), so `git
    // commit` has nothing to commit. Matches the exact guard at
    // import-openneuro.ts's Step 6 (`commitResult.exitCode !== 0 &&
    // !commitResult.stdout.includes("nothing to commit")` is the ONLY
    // failure condition), run here without `-q` to mirror the real command.
    await writeMetadata(p2, 1);
    const add = await runCmd(["git", "add", ".nemar/metadata.json"], p2);
    expect(add.exitCode).toBe(0);
    const commit = await runCmd(
      ["git", "commit", "-m", "Add NEMAR metadata (imported from OpenNeuro ds000003)"],
      p2,
    );
    expect(commit.exitCode).not.toBe(0);
    expect(commit.stdout).toContain("nothing to commit");

    // Step 7: main is already == origin/main (nothing new was committed), so
    // the push is a trivial no-op fast-forward -- it must still report
    // success, not fail.
    const push2 = await pushToGitHub(p2, "origin");
    expect(push2.success).toBe(true);
    expect(push2.warning).toBeUndefined();
    expect((await runCmd(["git", "rev-parse", "main"], p2)).stdout.trim()).toBe(firstImportSha);
  });

  test("first import: origin has no main ref yet, so Step 4c's fetch is skipped and the plain push still succeeds (#990 Gap 2, must-not-regress)", async () => {
    // Codifies the single most important "must not regress" behavior: a
    // genuine first import, where nemarDatasets/<id> is a freshly-created
    // empty repo with no `main` ref at all, must be completely unaffected by
    // Step 4c.
    const src = await newAnnexRepo("step4c-upstream-d");
    await Bun.write(join(src, "README.md"), "upstream dataset\n");
    expect((await runCmd(["git", "add", "README.md"], src)).exitCode).toBe(0);
    expect((await runCmd(["git", "commit", "-qm", "upstream readme"], src)).exitCode).toBe(0);

    // Bare "nemarDatasets" origin, freshly init'd -- nothing has EVER been
    // pushed to it.
    const bareDir = join(
      TMP_DIR,
      `bare-step4c-d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(bareDir, { recursive: true });
    expect((await runCmd(["git", "init", "-q", "--bare"], bareDir)).exitCode).toBe(0);

    const p1 = await cloneAnnexRepo(src, "step4c-p1-d");
    await runCmd(["git", "remote", "remove", "origin"], p1);
    expect((await runCmd(["git", "remote", "add", "origin", bareDir], p1)).exitCode).toBe(0);

    // Step 4c's exact first command: origin has no `main` ref at all, so the
    // fetch itself fails (git's "couldn't find remote ref main") and the
    // whole Step 4c block -- rev-parse, decideReimportMainReset, reset -- is
    // skipped silently, exactly like the `if (originMainFetch.exitCode ===
    // 0)` guard in import-openneuro.ts.
    const originMainFetch = await runCmd(["git", "fetch", "origin", "main"], p1);
    expect(originMainFetch.exitCode).not.toBe(0);

    // Step 6 + Step 7: the ordinary first-import metadata commit + push,
    // unaffected by Step 4c, must still succeed.
    await writeMetadata(p1, 1);
    await commitMetadata(p1, "Add NEMAR metadata (imported from OpenNeuro ds000004)");
    const push1 = await pushToGitHub(p1, "origin");
    expect(push1.success).toBe(true);
    expect(push1.warning).toBeUndefined();
  });
});
