/**
 * Normalizing an EXISTING dataset repository (#1159 part 2, ADR 0060).
 *
 * The dataset-level path around `normalizeImportedTree`: which clones it will reuse,
 * which it refuses, what it reports, and that the published past survives it. The
 * fixture is a bare "origin" plus a clone shaped like `on007788` -- upstream's
 * `.gitattributes`, a tag standing in for a published version, and motion
 * recordings on both sides of upstream's 1 MB bar.
 *
 * `normalizeDatasetRepo` is driven with a `type=directory` remote, so the S3 leg is
 * a real special-remote transfer rather than a stub. The one thing no test here can
 * reach is the credential mint, which needs the backend.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { runCommand } from "../src/lib/git-annex/run-command";
import type { UploadStrategy } from "../src/lib/import-normalize";
import { findUnannexedData } from "../src/lib/import-openneuro";
import {
  normalizeDatasetRepo,
  planDatasetNormalization,
  resolveSpecialRemoteUuid,
} from "../src/lib/normalize-dataset";

const UPSTREAM_GITATTRIBUTES = `* annex.backend=SHA256E
**/.git* annex.largefiles=nothing
*.tsv text eol=lf annex.largefiles=largerthan=1mb
dataset_description.json annex.largefiles=nothing
`;

const SMALL_MOTION = "sub-01/motion/sub-01_task-walk_tracksys-imu_motion.tsv";
const LARGE_MOTION = "sub-01/motion/sub-01_task-long_tracksys-imu_motion.tsv";
const CHANNELS = "sub-01/motion/sub-01_task-walk_tracksys-imu_channels.tsv";

let workDir: string;
let origin: string;
let clone: string;
const scratch: string[] = [];

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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

/** git-annex commits to its own branch, so every fixture repo needs an author. */
async function setIdentity(dir: string): Promise<void> {
  await run(["git", "config", "user.email", "test@nemar.test"], dir);
  await run(["git", "config", "user.name", "NEMAR Test"], dir);
}

async function headMode(dir: string, path: string, ref = "HEAD"): Promise<string> {
  const stdout = await run(["git", "ls-tree", ref, "--", path], dir);
  return stdout.trim().split(" ")[0] ?? "";
}

/** A published-looking dataset: upstream attributes, a v1.0.0 tag, a split. */
async function buildOriginAndClone(): Promise<{ origin: string; clone: string }> {
  const root = mkdtempSync(join(tmpdir(), "nemar-ds-"));
  scratch.push(root);
  const source = join(root, "source");
  const bare = join(root, "on999999.git");
  mkdirSync(source, { recursive: true });

  await run(["git", "init", "-q", "--initial-branch", "main", "."], source);
  // An identity per repository, the way the other git-touching suites do it: the
  // required CI tier runs with none configured, and `git annex init` commits to the
  // git-annex branch, so without this the fixture depends on the machine.
  await setIdentity(source);
  await run(["git", "annex", "init", "--quiet", "upstream"], source);
  writeFileSync(join(source, ".gitattributes"), UPSTREAM_GITATTRIBUTES);
  writeFileSync(join(source, "dataset_description.json"), '{"Name":"x"}');
  for (const [path, size] of [
    [SMALL_MOTION, 300_000],
    [LARGE_MOTION, 1_500_000],
    [CHANNELS, 200_000],
  ] as Array<[string, number]>) {
    const abs = join(source, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x".repeat(size));
  }
  const added = await gitAnnexAdd(source, [
    ".gitattributes",
    "dataset_description.json",
    SMALL_MOTION,
    LARGE_MOTION,
    CHANNELS,
  ]);
  if (!added.success) throw new Error(`gitAnnexAdd: ${added.error}`);
  await run(["git", "commit", "-qm", "dataset"], source);
  await run(["git", "tag", "v1.0.0"], source);

  // `--initial-branch main` on the BARE repo too: without it the bare repo's HEAD
  // follows the machine's `init.defaultBranch`, so on a runner that still defaults to
  // `master` the clone below checks out nothing at all and HEAD does not resolve.
  // The fixture passed locally only because this machine defaults to `main`.
  await run(["git", "init", "-q", "--bare", "--initial-branch", "main", bare], root);
  await run(["git", "remote", "add", "origin", bare], source);
  await run(["git", "push", "-q", "--all", "origin"], source);
  await run(["git", "push", "-q", "--tags", "origin"], source);

  const cloneDir = join(root, "clone");
  await run(["git", "clone", "-q", bare, cloneDir], root);
  await setIdentity(cloneDir);
  await run(["git", "annex", "init", "--quiet", "clone"], cloneDir);
  // The clone needs the content the way a real clone of a git-resident file does:
  // it comes down with the blobs, so nothing to fetch.
  return { origin: bare, clone: cloneDir };
}

async function addDirectoryRemote(dir: string, name: string): Promise<string> {
  const store = mkdtempSync(join(tmpdir(), "nemar-ds-store-"));
  scratch.push(store);
  await run(
    ["git", "annex", "initremote", name, "type=directory", `directory=${store}`, "encryption=none"],
    dir,
  );
  return store;
}

beforeEach(async () => {
  const built = await buildOriginAndClone();
  origin = built.origin;
  clone = built.clone;
  workDir = dirname(clone);
}, 180_000);

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    chmodTreeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("planDatasetNormalization", () => {
  test("reuses a clean clone at origin/main instead of re-cloning", async () => {
    // The clone is already there under <workDir>/<id>; a re-clone would fail on a
    // non-empty directory, and re-downloading a published dataset to redo an
    // interrupted upload is the thing this avoids.
    const reused = join(workDir, "on999999");
    await run(["cp", "-R", clone, reused], workDir);

    const plan = await planDatasetNormalization("on999999", { workDir });
    expect(plan.datasetPath).toBe(reused);
    expect(plan.files.map((f) => f.path)).toEqual([SMALL_MOTION]);
    expect(plan.bytes).toBe(300_000);
    expect(plan.attributeFiles).toEqual([".gitattributes"]);
  }, 180_000);

  test("works on main even when the repository's default branch is not main", async () => {
    // Sixteen dataset repositories have default_branch = git-annex, so a plain clone
    // checks out git-annex's internal log branch: no dataset files, no
    // .gitattributes, nothing to migrate, and a push that carries the log branch
    // while main keeps upstream's rules. Found on on002720/on002721 during the #1374
    // rollout. The bare origin here is pointed at its git-annex branch the same way.
    await run(["git", "symbolic-ref", "HEAD", "refs/heads/git-annex"], origin);
    const fresh = mkdtempSync(join(tmpdir(), "nemar-ds-defaultbranch-"));
    scratch.push(fresh);

    const plan = await planDatasetNormalization("on999999", { workDir: fresh, originUrl: origin });

    expect(plan.files.map((f) => f.path)).toEqual([SMALL_MOTION]);
    expect(plan.attributeFiles).toEqual([".gitattributes"]);
    const head = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], plan.datasetPath);
    expect(head.trim()).toBe("main");
  }, 180_000);

  test("refuses a clone left dirty by a previous attempt", async () => {
    // The dangerous state, not the merely stale one: the data files are already
    // annexed in the index, so a scan finds nothing left to move and the run would
    // report success having migrated nothing.
    const reused = join(workDir, "on999999");
    await run(["cp", "-R", clone, reused], workDir);
    await run(["git", "rm", "--cached", "--quiet", "--", SMALL_MOTION], reused);
    await gitAnnexAdd(reused, [SMALL_MOTION], {}, { forceLarge: true });

    await expect(planDatasetNormalization("on999999", { workDir })).rejects.toThrow(
      /uncommitted changes/,
    );
  }, 180_000);

  test("reports no attribute work for a repo the policy already governs", async () => {
    // `**/.git* annex.largefiles=nothing` is part of NEMAR's policy, not inherited
    // from upstream, so a repository the fleet sweep has already fixed still matches
    // a grep for the string. Reporting it would tell an operator to migrate a
    // dataset that is done -- which is what the whole fleet looked like after the
    // sweep landed.
    const swept = join(workDir, "on999999");
    await run(["cp", "-R", clone, swept], workDir);
    writeFileSync(
      join(swept, ".gitattributes"),
      "* annex.backend=SHA256E\n**/.git* annex.largefiles=nothing\n",
    );
    await run(["git", "add", ".gitattributes"], swept);
    await run(["git", "commit", "-qm", "policy only"], swept);
    await run(["git", "push", "-q", "origin", "main"], swept);

    const plan = await planDatasetNormalization("on999999", { workDir });
    expect(plan.attributeFiles).toEqual([]);
  }, 180_000);

  test("refuses a directory that is a different repository", async () => {
    const wrong = join(workDir, "on999999");
    mkdirSync(wrong, { recursive: true });
    await run(["git", "init", "-q", "."], wrong);
    await expect(planDatasetNormalization("on999999", { workDir })).rejects.toThrow(
      /origin is not on999999/,
    );
  }, 120_000);
});

describe("normalizeDatasetRepo", () => {
  test("moves the data, installs the policy, and leaves the published tag resolvable", async () => {
    const store = await addDirectoryRemote(clone, "stand-in");
    expect(store).toBeTruthy();
    const files = await findUnannexedData(clone);
    expect(files.map((f) => f.path)).toEqual([SMALL_MOTION]);

    const result = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files,
        bytes: 300_000,
        attributeFiles: [".gitattributes"],
        pendingKeys: [],
      },
      { push: true, remoteName: "stand-in" },
    );

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.keys).toHaveLength(1);

    // HEAD carries the recording as an annex link, and metadata as real files.
    expect(await headMode(clone, SMALL_MOTION)).toBe("120000");
    expect(await headMode(clone, CHANNELS)).toBe("100644");
    expect(await headMode(clone, "dataset_description.json")).toBe("100644");

    // The published version still resolves to the blob it was published with:
    // this is what makes a forward fix safe for a dataset whose version manifest
    // addresses git-resident files by their raw.githubusercontent URL.
    expect(await headMode(clone, SMALL_MOTION, "v1.0.0")).toBe("100644");

    // And the push really landed on the origin, both branches.
    const originMain = await run(["git", "ls-tree", "main", "--", SMALL_MOTION], origin);
    expect(originMain.trim().split(" ")[0]).toBe("120000");
    const branches = await run(["git", "branch", "--list", "git-annex"], origin);
    expect(branches).toContain("git-annex");
  }, 240_000);

  test("a second run finds nothing to do and makes no commit", async () => {
    await addDirectoryRemote(clone, "stand-in");
    const files = await findUnannexedData(clone);
    await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files,
        bytes: 300_000,
        attributeFiles: [".gitattributes"],
        pendingKeys: [],
      },
      { push: false, remoteName: "stand-in" },
    );
    const firstLog = await run(["git", "log", "--oneline"], clone);

    const again = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: await findUnannexedData(clone),
        bytes: 0,
        attributeFiles: [],
      },
      { push: false, remoteName: "stand-in" },
    );
    expect(again.committed).toBe(false);
    expect(again.notes).toEqual([]);
    expect(await run(["git", "log", "--oneline"], clone)).toBe(firstLog);
  }, 240_000);

  test("pushes a policy that only the git-annex branch carries", async () => {
    await addDirectoryRemote(clone, "stand-in");
    // A dataset with nothing to move and no attribute to strip is still a dataset
    // with no annex policy configured -- the shape #1374 backfills across 600
    // imported repositories. The expression lands in the git-annex branch and
    // nowhere in the tree, so a push condition that waited for a commit would
    // leave every clone of it governed by nothing.
    await run(["git", "rm", "-q", "--cached", "--", ".gitattributes"], clone);
    writeFileSync(join(clone, ".gitattributes"), "* annex.backend=SHA256E\n");
    await run(["git", "add", "--", ".gitattributes"], clone);
    await run(["git", "commit", "-qm", "plain attributes"], clone);
    await run(["git", "push", "-q", "origin", "main"], clone);
    // No policy at origin yet (the file may not even exist there, which reads as
    // empty stdout rather than a throw).
    const before = await runCommand(["git", "show", "git-annex:config.log"], { cwd: origin });
    expect(before.stdout).not.toContain("annex.largefiles");

    const result = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: [],
        bytes: 0,
        attributeFiles: [],
      },
      { push: true, remoteName: "stand-in" },
    );
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(true);

    // Read it back where a clone would find it: the origin's git-annex branch.
    const pushedConfig = await run(["git", "show", "git-annex:config.log"], origin);
    expect(pushedConfig).toContain("annex.largefiles");
    expect(pushedConfig).toContain("include=*_motion.tsv");
  }, 180_000);

  test("needs no credentials at all when there is no data to move", async () => {
    // The attributes-only case, which is what #1374's fleet backfill is: the S3 leg
    // must not exist -- no credential mint, no `enableremote`, no transfer. Run
    // against the REAL default remote name (`nemar-s3`, absent from this clone) and
    // with an empty config directory, so any attempt to reach the API for
    // credentials throws instead of quietly succeeding on the developer's own key.
    const configDir = mkdtempSync(join(tmpdir(), "nemar-normalize-noconfig-"));
    scratch.push(configDir);
    const previousConfigDir = process.env.NEMAR_CONFIG_DIR;
    process.env.NEMAR_CONFIG_DIR = configDir;
    try {
      const result = await normalizeDatasetRepo(
        {
          datasetId: "on999999",
          datasetPath: clone,
          files: [],
          bytes: 0,
          attributeFiles: [".gitattributes"],
          pendingKeys: [],
        },
        { push: false },
      );
      expect(result.keys).toEqual([]);
      expect(result.committed).toBe(true);
      expect(result.notes.join(" ")).toContain("stripped");
    } finally {
      if (previousConfigDir === undefined) delete process.env.NEMAR_CONFIG_DIR;
      else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
    }

    // The policy is in force and upstream's rule is gone, with no S3 involvement.
    const attrs = await run(["git", "show", "HEAD:.gitattributes"], clone);
    expect(attrs).not.toContain("largerthan=1mb");
    expect(attrs).toContain("**/.git* annex.largefiles=nothing");
    const configured = await run(["git", "annex", "config", "--get", "annex.largefiles"], clone);
    expect(configured.trim()).toContain("include=*_motion.tsv");
  }, 180_000);

  test("preserves a newer annex tracking ref observed while the push is running", async () => {
    await addDirectoryRemote(clone, "stand-in");
    const hook = join(origin, "hooks", "post-receive");
    writeFileSync(
      hook,
      `#!/bin/sh
set -eu
remote=${shellQuote(origin)}
clone=${shellQuote(clone)}
while IFS=' ' read -r old new ref; do
  [ "$ref" = "refs/heads/git-annex" ] || continue
  tree=$(git --git-dir="$remote" rev-parse "$new^{tree}")
  child=$(printf '%s\\n' 'concurrent annex advance' | GIT_AUTHOR_NAME='NEMAR Test' GIT_AUTHOR_EMAIL='test@nemar.test' GIT_COMMITTER_NAME='NEMAR Test' GIT_COMMITTER_EMAIL='test@nemar.test' git --git-dir="$remote" commit-tree "$tree" -p "$new")
  git --git-dir="$remote" update-ref refs/heads/git-annex "$child" "$new"
  env -u GIT_DIR -u GIT_WORK_TREE git -C "$clone" fetch --quiet --no-tags origin refs/heads/git-annex:refs/remotes/origin/git-annex
done
`,
    );
    chmodSync(hook, 0o755);

    const result = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: await findUnannexedData(clone),
        bytes: 300_000,
        attributeFiles: [".gitattributes"],
        pendingKeys: [],
      },
      { push: true, remoteName: "stand-in" },
    );
    expect(result.pushed).toBe(true);

    const remoteAnnex = await run(["git", "rev-parse", "refs/heads/git-annex"], origin);
    const trackingAnnex = await run(["git", "rev-parse", "refs/remotes/origin/git-annex"], clone);
    const localAnnex = await run(["git", "rev-parse", "refs/heads/git-annex"], clone);
    expect(trackingAnnex.trim()).toBe(remoteAnnex.trim());
    expect(trackingAnnex.trim()).not.toBe(localAnnex.trim());
  }, 240_000);

  test("a second run over an already-normalized dataset pushes nothing", async () => {
    await addDirectoryRemote(clone, "stand-in");
    const first = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: await findUnannexedData(clone),
        bytes: 300_000,
        attributeFiles: [".gitattributes"],
        pendingKeys: [],
      },
      { push: true, remoteName: "stand-in" },
    );
    expect(first.pushed).toBe(true);
    const afterFirst = await run(["git", "rev-parse", "main", "git-annex"], clone);
    const remoteAnnex = await run(
      ["git", "ls-remote", "--heads", "origin", "refs/heads/git-annex"],
      clone,
    );
    const trackingAnnex = await run(
      ["git", "rev-parse", "--verify", "refs/remotes/origin/git-annex"],
      clone,
    );
    expect(trackingAnnex.trim()).toBe(remoteAnnex.trim().split(/\s+/)[0]);

    // Idempotence is what makes a fleet run resumable: re-running over a dataset
    // that is already done must not move either branch. `git annex config --set`
    // to a value already configured writes no commit (measured on git-annex
    // 10.20260901). The checked annex push also has to leave the tracking ref
    // current, even on Git versions that do not map a raw URL back to its remote.
    const again = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: await findUnannexedData(clone),
        bytes: 0,
        attributeFiles: [],
      },
      { push: true, remoteName: "stand-in" },
    );
    expect(again.committed).toBe(false);
    expect(again.pushed).toBe(false);
    expect(await run(["git", "rev-parse", "main", "git-annex"], clone)).toBe(afterFirst);
  }, 240_000);
});

describe("the upload leg is swappable", () => {
  test("resolveSpecialRemoteUuid reads the UUID out of the git-annex branch", async () => {
    // Needed by the ambient-credential path, which must NOT enable the remote (that
    // contacts S3 with the credential handling being bypassed) yet still has to
    // register keys against the UUID every existing clone already knows.
    await addDirectoryRemote(clone, "stand-in");
    const uuid = await resolveSpecialRemoteUuid(clone, "stand-in");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);

    const fromGitAnnex = await run(["git", "config", "remote.stand-in.annex-uuid"], clone);
    expect(uuid).toBe(fromGitAnnex.trim());
    expect(await resolveSpecialRemoteUuid(clone, "no-such-remote")).toBeNull();
  }, 180_000);

  test("a strategy that cannot prove the upload stops the migration before the commit", async () => {
    // The contract every strategy owes: throw rather than return when it cannot
    // show the content arrived. A strategy that lies would be committed on top of.
    await addDirectoryRemote(clone, "stand-in");
    const refusing: UploadStrategy = async () => {
      throw new Error("nothing arrived at the remote");
    };

    await expect(
      normalizeDatasetRepo(
        {
          datasetId: "on999999",
          datasetPath: clone,
          files: await findUnannexedData(clone),
          bytes: 300_000,
          attributeFiles: [".gitattributes"],
          pendingKeys: [],
        },
        { push: true, remoteName: "stand-in", upload: refusing },
      ),
    ).rejects.toThrow(/nothing arrived/);

    const log = await run(["git", "log", "--oneline"], clone);
    expect(log).not.toContain("Apply NEMAR annex policy");
    expect(await headMode(clone, SMALL_MOTION)).toBe("100644");
    const originMain = await run(["git", "ls-tree", "main", "--", SMALL_MOTION], origin);
    expect(originMain.trim().split(" ")[0]).toBe("100644");
  }, 180_000);

  test("a strategy that reports success without moving the content is not pushed", async () => {
    // The failure this gate exists for. A strategy can return cleanly and still
    // have moved nothing -- that is how on003490 and on005121 came to be published
    // with a permanent DOI and content no clone could fetch (#1392). Throwing is
    // the contract, but a strategy that does not throw must not be taken at its
    // word either, so the remote is asked before anything reaches origin.
    await addDirectoryRemote(clone, "stand-in");
    // Returns the shape a successful transfer returns, and moves nothing.
    const silent: UploadStrategy = async ({ files }) => ({ copied: files.length });

    await expect(
      normalizeDatasetRepo(
        {
          datasetId: "on999999",
          datasetPath: clone,
          files: await findUnannexedData(clone),
          bytes: 300_000,
          attributeFiles: [".gitattributes"],
          pendingKeys: [],
        },
        { push: true, remoteName: "stand-in", upload: silent },
      ),
    ).rejects.toThrow(/confirms 0 of \d+ uploaded key\(s\)[\s\S]*NOTHING HAS BEEN PUSHED/);

    // The commit is local (it has to be: the keys are what gets verified), but
    // origin must still be showing the pre-migration tree.
    const originMain = await run(["git", "ls-tree", "main", "--", SMALL_MOTION], origin);
    expect(originMain.trim().split(" ")[0]).toBe("100644");
    const originAnnex = await run(
      ["git", "rev-parse", "--verify", "--quiet", "refs/heads/git-annex"],
      origin,
    ).catch(() => "");
    const localAnnex = await run(["git", "rev-parse", "git-annex"], clone);
    expect(originAnnex.trim()).not.toBe(localAnnex.trim());
  }, 180_000);

  test("a clone left committed-but-unpushed is not reported as already compliant", async () => {
    // The recovery path the failure message itself advertises. Run 1 annexes,
    // commits, fails verification and refuses to push. Run 2 with --dir measures a
    // tree that IS normalized -- locally -- so `files` and `attributeFiles` both
    // come back empty and the command used to print "Nothing to do: this dataset
    // already matches NEMAR policy" while origin/main still carried the recording
    // as a plain blob and the content was never confirmed in S3.
    // The clone lives at workDir/on999999, because that is where a resumed run
    // (`--dir`) looks for it.
    const resumable = join(workDir, "on999999");
    await run(["cp", "-R", clone, resumable], workDir);
    await addDirectoryRemote(resumable, "stand-in");
    const silent: UploadStrategy = async ({ files }) => ({ copied: files.length });

    await expect(
      normalizeDatasetRepo(
        {
          datasetId: "on999999",
          datasetPath: resumable,
          files: await findUnannexedData(resumable),
          bytes: 300_000,
          attributeFiles: [".gitattributes"],
          pendingKeys: [],
        },
        { push: true, remoteName: "stand-in", upload: silent },
      ),
    ).rejects.toThrow(/NOTHING HAS BEEN PUSHED/);

    // Origin is still pre-migration, and the clone is committed but unpushed.
    const originMain = await run(["git", "ls-tree", "main", "--", SMALL_MOTION], origin);
    expect(originMain.trim().split(" ")[0]).toBe("100644");

    const resumed = await planDatasetNormalization("on999999", { workDir });
    expect(resumed.files).toEqual([]);
    expect(resumed.attributeFiles).toEqual([]);
    // ...and the plan says so, which is the whole difference between resuming and
    // ticking the dataset off as done.
    expect(resumed.pendingKeys.length).toBeGreaterThan(0);
  }, 180_000);

  test("the real upload leg is confirmed against the remote, key by key", async () => {
    // The other half: a transfer that did happen is reported as confirmed, and the
    // report names how it was checked rather than asserting it abstractly.
    await addDirectoryRemote(clone, "stand-in");
    const result = await normalizeDatasetRepo(
      {
        datasetId: "on999999",
        datasetPath: clone,
        files: await findUnannexedData(clone),
        bytes: 300_000,
        attributeFiles: [".gitattributes"],
        pendingKeys: [],
      },
      { push: true, remoteName: "stand-in" },
    );

    expect(result.keys.length).toBeGreaterThan(0);
    expect(result.verification?.present).toEqual(result.keys);
    expect(result.verification?.absent).toEqual([]);
    expect(result.verification?.unconfirmed).toEqual([]);
    expect(result.verification?.method).toContain("location log");
    expect(result.pushed).toBe(true);
  }, 180_000);
});
