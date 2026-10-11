/**
 * Re-registering content NEMAR holds but never advertised (#1392).
 *
 * The sweep that repairs 528 imported datasets, driven against real git-annex
 * repositories with a real `type=directory` remote and a real bare origin. The
 * one boundary that is injected is the bucket listing, because S3 is the one
 * thing a test cannot have; the implementation behind it reads an actual
 * directory of actual objects, so "what the bucket holds" is never a fixture.
 *
 * Every assertion about a registration reads the location log, never a return
 * value, for the reason the issue exists.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_DATA_AVAILABILITY,
  type ObjectSource,
  dataAvailability,
  fleetCloneEnv,
  repairDatasetKeyRegistration,
  resolveRemoteUuid,
  scanDatasetKeyRegistration,
  sweepKeyRegistration,
} from "../src/lib/fleet-key-registration";
import { runCommand } from "../src/lib/git-annex/run-command";
import { batchSetKeysPresent } from "../src/lib/git-annex/transfer";
import { annexKeyDeclaredSize } from "../src/lib/s3-server-copy";

/** A bucket listing in the shape `listExistingObjects` returns: key -> size. */
function sizedObjects(keys: string[]): Map<string, number> {
  return new Map(keys.map((key) => [key, declaredSize(key)]));
}

/**
 * The size a key declares, which is what a real listing would agree with.
 *
 * The production function, not a local regex. A local `/-s(\d+)/` diverges from
 * `annexKeyDeclaredSize`'s `/-s(\d+)--/`: it returns a size for a chunked key
 * where production returns null, so a test built on it would exercise a rule
 * production does not have.
 */
function declaredSize(key: string): number {
  return annexKeyDeclaredSize(key) ?? 0;
}

let root: string;
let origin: string;
let store: string;
let workRoot: string;
const scratch: string[] = [];

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

function removeTree(dir: string): void {
  Bun.spawnSync(["chmod", "-R", "u+w", dir]);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * What the directory remote actually holds, read off disk.
 *
 * git-annex lays a `type=directory` store out as `<a>/<b>/<key>/<key>`, so the
 * key is the name of the directory holding the object. This stands in for the
 * S3 listing at the same boundary and with the same contract: bare keys.
 */
function directoryObjectSource(dir: string): ObjectSource {
  return async () => {
    // Key to the size of the object actually stored, not to the size the key
    // claims: a store holding a truncated object is exactly the state the
    // caller has to notice (#967).
    const objects = new Map<string, number>();
    const walk = (path: string, depth: number): void => {
      if (!existsSync(path)) return;
      for (const name of readdirSync(path, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        if (depth === 2) {
          const stored = join(path, name.name, name.name);
          objects.set(name.name, existsSync(stored) ? statSync(stored).size : 0);
        } else {
          walk(join(path, name.name), depth + 1);
        }
      }
    };
    walk(dir, 0);
    return objects;
  };
}

/** A clone of origin with the annex initialized, as the sweep makes one. */
async function cloneForScan(name = "scan"): Promise<string> {
  const path = join(root, name);
  await run(["git", "clone", "-q", origin, path], root);
  await run(["git", "config", "user.email", "test@nemar.test"], path);
  await run(["git", "config", "user.name", "NEMAR Test"], path);
  await run(["git", "annex", "init", "--quiet", name], path);
  return path;
}

/** The remote's UUID, read the way a clone has to read it: from the branch. */
async function uuidOf(datasetPath: string): Promise<string> {
  const uuid = await resolveRemoteUuid(datasetPath);
  if (!uuid) throw new Error("no nemar-s3 in remote.log");
  return uuid;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nemar-keyreg-fleet-"));
  scratch.push(root);
  origin = join(root, "origin.git");
  store = join(root, "store");
  workRoot = join(root, "work");
  mkdirSync(store, { recursive: true });
  mkdirSync(workRoot, { recursive: true });
  await run(["git", "init", "-q", "--bare", "--initial-branch", "main", origin], root);

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await run(["git", "init", "-q", "--initial-branch", "main", "."], seed);
  await run(["git", "config", "user.email", "test@nemar.test"], seed);
  await run(["git", "config", "user.name", "NEMAR Test"], seed);
  await run(["git", "annex", "init", "--quiet", "seed"], seed);
  // Named `nemar-s3` so the module finds it in remote.log exactly as it does in
  // an imported dataset.
  await run(
    [
      "git",
      "annex",
      "initremote",
      "nemar-s3",
      "type=directory",
      `directory=${store}`,
      "encryption=none",
    ],
    seed,
  );
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(seed, `rec${i}.bin`), `recording-${i}-`.repeat(300));
  }
  await run(["git", "annex", "add", "--quiet", "."], seed);
  await run(["git", "commit", "-qm", "add recordings"], seed);
  await run(["git", "remote", "add", "origin", origin], seed);
  // Push BEFORE copying, so origin learns the remote from `remote.log` and never
  // learns that the content reached it. That is the state #1392 left 528 datasets
  // in -- objects in the bucket, location log silent -- reproduced without having
  // to un-say anything afterwards.
  await run(["git", "push", "-q", "origin", "main", "git-annex"], seed);
  await run(["git", "annex", "copy", "--quiet", "--to", "nemar-s3", "."], seed);
}, 240_000);

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    removeTree(dir);
  }
});

describe("scanDatasetKeyRegistration", () => {
  test("reports content the bucket holds and the log does not", async () => {
    const path = await cloneForScan();
    const state = await scanDatasetKeyRegistration("on999999", path, directoryObjectSource(store));

    expect(state.remoteUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.annexed).toHaveLength(4);
    expect(state.registered).toEqual([]);
    expect(state.inBucket).toHaveLength(4);
    expect(state.toRegister).toEqual(state.annexed);
    expect(state.missingContent).toEqual([]);
  }, 240_000);

  test("registers a key the bucket holds only as complete chunks (ADR 0063, #1565)", async () => {
    // A special remote configured with chunk=<size> stores <fields>-S<size>-C<n>--<name>
    // and never the plain key. The presence test reads a complete chunk set as held,
    // so this sweep now records such a key in the location log; an incomplete one
    // stays missing content. Real keys from a real annex, with the listing built the
    // way a chunked remote lays it out.
    const path = await cloneForScan("scan-chunked");
    const { annexed } = await scanDatasetKeyRegistration("on999999", path, async () => new Map());
    const [chunkedKey, ...plainKeys] = annexed;
    const size = annexKeyDeclaredSize(chunkedKey) as number;
    const chunkSize = 1000;
    const count = Math.ceil(size / chunkSize);
    expect(count).toBeGreaterThan(2);
    const chunkObjects = new Map<string, number>(
      Array.from({ length: count }, (_, i): [string, number] => [
        chunkedKey.replace("--", `-S${chunkSize}-C${i + 1}--`),
        i + 1 < count ? chunkSize : size - chunkSize * (count - 1),
      ]),
    );

    const whole = new Map([...sizedObjects(plainKeys), ...chunkObjects]);
    const held = await scanDatasetKeyRegistration("on999999", path, async () => whole);
    expect(held.inBucket).toContain(chunkedKey);
    expect(held.toRegister).toContain(chunkedKey);
    expect(held.missingContent).toEqual([]);

    const lastChunk = [...chunkObjects.keys()][count - 1];
    const short = new Map(whole);
    short.delete(lastChunk);
    const incomplete = await scanDatasetKeyRegistration("on999999", path, async () => short);
    expect(incomplete.toRegister).not.toContain(chunkedKey);
    expect(incomplete.missingContent).toEqual([chunkedKey]);
  }, 240_000);

  test("separates content the bucket does not hold from a lost registration", async () => {
    // The #1396 shape. An empty bucket is not "every registration was lost", and
    // the two need opposite responses: one is repaired here, the other needs the
    // content transferred.
    const path = await cloneForScan();
    const state = await scanDatasetKeyRegistration("on999999", path, async () => new Map());

    expect(state.toRegister).toEqual([]);
    expect(state.missingContent).toHaveLength(4);
  }, 240_000);

  test("names the keys advertised at the remote that the bucket cannot back", async () => {
    // The state the sweep used to be blind to: registered AND not in the bucket.
    // It saw `missingContent`, refused to register, and left the claim standing,
    // so every clone kept being told to fetch bytes NEMAR does not hold (#967).
    const path = await cloneForScan();
    const uuid = await uuidOf(path);
    const all = await scanDatasetKeyRegistration("on999999", path, directoryObjectSource(store));
    await batchSetKeysPresent(path, all.annexed, uuid);

    const state = await scanDatasetKeyRegistration("on999999", path, async () => new Map());

    expect(state.registered).toHaveLength(4);
    expect(state.missingContent).toHaveLength(4);
    expect([...state.falselyClaimed].sort()).toEqual([...all.annexed].sort());
  }, 240_000);

  test("a key the bucket holds is not a false claim", async () => {
    const path = await cloneForScan();
    const before = await scanDatasetKeyRegistration("on999999", path, directoryObjectSource(store));
    await batchSetKeysPresent(path, before.annexed, await uuidOf(path));

    const state = await scanDatasetKeyRegistration("on999999", path, directoryObjectSource(store));

    expect(state.registered).toHaveLength(4);
    expect(state.falselyClaimed).toEqual([]);
  }, 240_000);

  test("resolveRemoteUuid reads the UUID out of the git-annex branch", async () => {
    const path = await cloneForScan();
    const uuid = await resolveRemoteUuid(path);
    // A clone never ran initremote, so `git config remote.nemar-s3.annex-uuid` is
    // absent; the git-annex branch is the only place the UUID exists.
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    const fromLog = await run(["git", "show", "git-annex:remote.log"], path);
    expect(fromLog).toContain(`${uuid} `);
    expect(await resolveRemoteUuid(path, "no-such-remote")).toBeNull();
  }, 240_000);
});

describe("repairDatasetKeyRegistration, withdrawing a claim", () => {
  /** Claim all four keys, then take the bucket away, as a failed copy would. */
  async function claimWithoutContent(): Promise<string> {
    const path = await cloneForScan("claimed");
    const state = await scanDatasetKeyRegistration("on999999", path, directoryObjectSource(store));
    await batchSetKeysPresent(path, state.annexed, await uuidOf(path));
    const pushed = await runCommand(["git", "push", "-q", "origin", "git-annex"], { cwd: path });
    expect(pushed.exitCode).toBe(0);
    return path;
  }

  test("withdraws the claim and a fresh clone of origin no longer sees it", async () => {
    await claimWithoutContent();
    const before = await cloneForScan("before");
    expect(
      (
        await run(
          [
            "git",
            "annex",
            "find",
            "--include",
            "*",
            "--in",
            await uuidOf(before),
            "--format=${key}\n",
          ],
          before,
        )
      )
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(4);

    const outcome = await repairDatasetKeyRegistration("on999999", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
      retractFalseClaims: true,
    });

    expect(outcome.action).toBe("repaired");
    expect(outcome.pushed).toBe(true);
    expect(outcome.state?.falselyClaimed).toHaveLength(4);

    const after = await cloneForScan("retracted");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toEqual([]);
  }, 240_000);

  test("without the option it reports the false claim and changes nothing", async () => {
    await claimWithoutContent();

    const outcome = await repairDatasetKeyRegistration("on999999", async () => new Map(), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.action).toBe("skipped-missing-content");
    expect(outcome.pushed).toBe(false);
    expect(outcome.notes.join(" ")).toContain("advertised at nemar-s3 anyway");

    const after = await cloneForScan("untouched");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toHaveLength(4);
  }, 240_000);

  test("a dry run names the claims and pushes nothing", async () => {
    await claimWithoutContent();

    const outcome = await repairDatasetKeyRegistration("on999999", async () => new Map(), {
      workRoot,
      originUrl: origin,
      retractFalseClaims: true,
    });

    expect(outcome.action).toBe("would-repair");
    expect(outcome.pushed).toBe(false);

    const after = await cloneForScan("dry");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toHaveLength(4);
  }, 240_000);
});

describe("repairDatasetKeyRegistration", () => {
  test("registers the keys, proves it from the log, and pushes", async () => {
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(outcome.action).toBe("repaired");
    expect(outcome.pushed).toBe(true);
    expect(outcome.state?.toRegister).toHaveLength(4);

    // The claim that matters, asked of a FRESH clone of origin rather than of the
    // clone that did the work.
    const after = await cloneForScan("after");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toHaveLength(4);
  }, 240_000);

  test("changes nothing without --apply", async () => {
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      originUrl: origin,
    });

    expect(outcome.action).toBe("would-repair");
    expect(outcome.pushed).toBe(false);

    const after = await cloneForScan("after");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toEqual([]);
  }, 240_000);

  test("treats a zero-byte object as missing content, not as content", async () => {
    // The defect this exists for: a failed copy leaves an object under the right
    // key name with none of the bytes (#967). on003645 has 653 of those out of
    // 823, and every check that asked only whether the key existed called the
    // dataset complete -- including this sweep, which would then advertise all
    // 653 to clones.
    const held = directoryObjectSource(store);
    const outcome = await repairDatasetKeyRegistration(
      "on999999",
      async (id) =>
        new Map(
          [...(await held(id))].map(([key], index) => [key, index === 0 ? 0 : declaredSize(key)]),
        ),
      { workRoot, apply: true, originUrl: origin },
    );

    expect(outcome.action).toBe("skipped-missing-content");
    expect(outcome.state?.missingContent).toHaveLength(1);
    expect(outcome.pushed).toBe(false);
  }, 240_000);

  test("leaves a dataset alone when the bucket cannot account for its content", async () => {
    // on006159 has 222 of 480 keys with no object at all. Registering the other
    // 258 would be true but would also make a dataset whose real problem is
    // missing content look like it had been repaired.
    const partial = directoryObjectSource(store);
    const outcome = await repairDatasetKeyRegistration(
      "on999999",
      async (id) => {
        const all = [...(await partial(id))];
        return new Map(all.slice(0, 2));
      },
      { workRoot, apply: true, originUrl: origin },
    );

    expect(outcome.action).toBe("skipped-missing-content");
    expect(outcome.pushed).toBe(false);
    expect(outcome.state?.missingContent).toHaveLength(2);
    expect(outcome.notes[0]).toContain("#1396");

    const after = await cloneForScan("after");
    const recorded = await run(
      ["git", "annex", "find", "--include", "*", "--in", await uuidOf(after), "--format=${key}\n"],
      after,
    );
    expect(recorded.split("\n").filter(Boolean)).toEqual([]);
  }, 240_000);

  test("a second run reports compliant and pushes nothing", async () => {
    await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
    });
    const before = await run(["git", "rev-parse", "git-annex"], origin);

    const second = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
    });

    expect(second.action).toBe("compliant");
    expect(second.pushed).toBe(false);
    expect(await run(["git", "rev-parse", "git-annex"], origin)).toBe(before);
  }, 240_000);

  test("a rehearsal registers locally and pushes nothing", async () => {
    const before = await run(["git", "rev-parse", "git-annex"], origin);
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      push: false,
      originUrl: origin,
    });

    expect(outcome.action).toBe("repaired");
    expect(outcome.pushed).toBe(false);
    expect(await run(["git", "rev-parse", "git-annex"], origin)).toBe(before);
  }, 240_000);

  test("a repository with no NEMAR remote is skipped, not failed", async () => {
    const outcome = await repairDatasetKeyRegistration("on999999", directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
      remoteName: "not-configured",
    });
    expect(outcome.action).toBe("skipped-no-remote");
    expect(outcome.pushed).toBe(false);
  }, 240_000);
});

describe("sweepKeyRegistration", () => {
  test("tallies every dataset and counts the keys it registered", async () => {
    const seen: string[] = [];
    const sweep = await sweepKeyRegistration(["on999999"], directoryObjectSource(store), {
      workRoot,
      apply: true,
      originUrl: origin,
      concurrency: 2,
      onDataset: (outcome) => seen.push(outcome.datasetId),
    });

    expect(seen).toEqual(["on999999"]);
    expect(sweep.tally.repaired).toBe(1);
    expect(sweep.tally.failed).toBe(0);
    expect(sweep.keysRegistered).toBe(4);
  }, 240_000);

  test("a dataset that cannot be cloned is one failure, not the end of the sweep", async () => {
    const sweep = await sweepKeyRegistration(
      ["on999999", "on999998"],
      directoryObjectSource(store),
      {
        workRoot,
        apply: true,
        // Both ids clone from the same real origin; the second run's path differs,
        // so only a genuinely bad URL fails. Point the sweep at one that is not a
        // repository at all.
        originUrl: join(root, "not-a-repository"),
        concurrency: 2,
      },
    );
    expect(sweep.tally.failed).toBe(2);
    expect(sweep.outcomes[0].error).toBeTruthy();
  }, 240_000);
});

describe("dataAvailability (ADR 0064)", () => {
  test("measures data only, so metadata cannot dilute the ratio", () => {
    // on008017, measured: 37 keys missing of 171 data keys is 21.6% gone, while the
    // same 37 against its 780 tracked files reads as 4.7%. A threshold on tracked
    // files clears a dataset missing a fifth of its recordings.
    const annexed = Array.from({ length: 171 }, (_, i) => `k${i}`);
    const availability = dataAvailability({ annexed, missingContent: annexed.slice(0, 37) });
    expect(availability).toBeCloseTo(0.784, 3);
    expect(availability).toBeLessThan(MIN_DATA_AVAILABILITY);
  });

  test("a complete dataset is 1 and is not withdrawn", () => {
    const annexed = ["a", "b", "c"];
    expect(dataAvailability({ annexed, missingContent: [] })).toBe(1);
  });

  test("a metadata-only dataset is complete, not wholly unavailable", () => {
    // Zero annexed keys must not divide to 0 and tombstone a dataset that is
    // whole for its kind.
    expect(dataAvailability({ annexed: [], missingContent: [] })).toBe(1);
  });

  test("the threshold is a floor, not a ceiling: exactly 90% available stays listed", () => {
    const annexed = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const availability = dataAvailability({ annexed, missingContent: ["k0"] });
    expect(availability).toBe(0.9);
    expect(availability < MIN_DATA_AVAILABILITY).toBe(false);
  });

  test("one file more missing crosses it", () => {
    const annexed = Array.from({ length: 10 }, (_, i) => `k${i}`);
    expect(dataAvailability({ annexed, missingContent: ["k0", "k1"] })).toBeLessThan(
      MIN_DATA_AVAILABILITY,
    );
  });

  test("everything missing is 0, not a division error", () => {
    const annexed = ["a", "b"];
    expect(dataAvailability({ annexed, missingContent: annexed })).toBe(0);
  });

  test("on004212: the key basis and the entry basis disagree, and the key basis wins", () => {
    // The regression this exists for is in ADR 0064 itself. Its consequence
    // bullet recorded on004212 at 28.2% missing, which is 7,503 of 26,620 TREE
    // ENTRIES. The rule the same ADR states is distinct annex keys, and that is
    // 7,495 of 19,220 = 39.0%. An entry count runs above a key count, so the
    // entry basis always reports the SMALLER shortfall and makes a dataset look
    // less damaged than it is -- the exact error the ADR was written to forbid.
    //
    // Re-measured 2026-09-16 with `nemar admin fleet key-registration on004212`.
    const keys = Array.from({ length: 19220 }, (_, i) => `on004212-key-${i}`);
    const availability = dataAvailability({ annexed: keys, missingContent: keys.slice(0, 7495) });

    expect(availability).toBeCloseTo(0.61, 3);
    expect(1 - availability).toBeCloseTo(0.39, 3);
    expect(availability).toBeLessThan(MIN_DATA_AVAILABILITY);

    // The entry basis would have put it here, and it is NOT what the rule says.
    const entryBasis = (26620 - 7503) / 26620;
    expect(entryBasis).toBeCloseTo(0.718, 3);
    expect(entryBasis).toBeGreaterThan(availability);
  });

  test("reproduces the measured ratios that set the threshold", () => {
    // The five public datasets ADR 0064 puts on NOTICE, from the 2026-09-15
    // sweep. Not withdrawn: the ADR opens a notice period to 15 October 2026
    // rather than tombstoning on measurement day, and the five entries actually
    // on scripts/withdrawn-datasets.json are a different five.
    //
    // on006159's denominator is its DISTINCT KEYS (480), re-measured against the
    // live dataset with `nemar admin fleet key-registration on006159`, which
    // reports "222 of 480". It read 606 here, which is neither its key count nor
    // its tree-entry count, and pinned 36.6% -- the superseded figure the ADR
    // exists to disown.
    const measured: Array<[string, number, number, number]> = [
      ["on006159", 222, 480, 0.4625],
      ["on004917", 104, 410, 0.254],
      ["on004475", 30, 163, 0.184],
      ["on005571", 55, 300, 0.183],
      ["on003574", 11, 90, 0.122],
    ];
    for (const [id, missing, total, missingShare] of measured) {
      const annexed = Array.from({ length: total }, (_, i) => `${id}-${i}`);
      const availability = dataAvailability({
        annexed,
        missingContent: annexed.slice(0, missing),
      });
      expect(1 - availability).toBeCloseTo(missingShare, 3);
      expect(availability).toBeLessThan(MIN_DATA_AVAILABILITY);
    }
  });
});

describe("fleetCloneEnv (the slot order a GitHub push depends on)", () => {
  // Every other test in this file clones from a local path, so the GitHub branch
  // never runs. If the post-clone config wrote slot 0 -- the empty reset --
  // instead of slot 1, every fleet push against GitHub would fail authentication
  // and nothing here would go red. That is the path that pushes a retraction.
  const HELPER_URL = "https://github.com/nemarDatasets/on000001.git";

  test("gives a non-GitHub url no credential environment at all", () => {
    // A token is for GitHub and only for GitHub, and originUrl is a local path
    // throughout these tests.
    expect(fleetCloneEnv("/tmp/some/local/origin", "ghp_token")).toBeUndefined();
    expect(fleetCloneEnv("git@github.com:nemarDatasets/on000001.git", "ghp_token")).toBeUndefined();
  });

  test("resets the helper list even when there is no token", () => {
    // Not redundant: git ACCUMULATES helpers, so the operator's global one (the
    // Git Credential Manager on a Mac) still runs and opens a GUI dialog that
    // GIT_TERMINAL_PROMPT=0 does nothing about. A sweep would sit behind it.
    const env = fleetCloneEnv(HELPER_URL, undefined);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GCM_INTERACTIVE: "never",
    });
  });

  test("puts the token helper in slot 1, after the reset in slot 0", () => {
    const env = fleetCloneEnv(HELPER_URL, "ghp_exampletoken");
    expect(env?.GIT_CONFIG_COUNT).toBe("2");
    // Slot 0 clears, slot 1 answers. Swapping them leaves no helper at all.
    expect(env?.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env?.GIT_CONFIG_VALUE_0).toBe("");
    expect(env?.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
    expect(env?.GIT_CONFIG_VALUE_1).toContain("ghp_exampletoken");
  });

  test("refuses a token carrying whitespace or a quote rather than embedding it", () => {
    // The helper value is a shell-quoted string, so either character would break
    // out of it. Falling back to the reset-only env is the safe direction.
    for (const bad of ["tok en", "tok'en", "tok\nen"]) {
      expect(fleetCloneEnv(HELPER_URL, bad)?.GIT_CONFIG_COUNT).toBe("1");
      expect(fleetCloneEnv(HELPER_URL, bad)?.GIT_CONFIG_VALUE_1).toBeUndefined();
    }
  });

  test("never puts the token anywhere a process listing would show it", () => {
    // Via GIT_CONFIG_* only: not in argv, not in the url.
    const env = fleetCloneEnv(HELPER_URL, "ghp_exampletoken");
    const slots = Object.entries(env ?? {}).filter(([key]) => key.startsWith("GIT_CONFIG_VALUE"));
    expect(slots.filter(([, value]) => value.includes("ghp_exampletoken"))).toHaveLength(1);
  });
});
