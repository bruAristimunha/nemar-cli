/**
 * The runner contract, protocol `nemar.runner.v1` (portable compute, card DM-04): every word, prefix,
 * header, number and shape declared once in `shared/`, and the JSON Schema nemar-process copies byte
 * for byte held to the zod shapes.
 *
 * Three kinds of test. Pins: each word, number and status is written out here a second time, so a
 * change to the contract is a change to this file. Behaviour: each request is closed and each
 * response is open, and the prefixes refuse a secret that is one hex short or in capitals. Agreement:
 * a corpus generated from a valid document of every shape (a key removed, a key of the wrong type, an
 * unknown key, a value at and one past each bound, each pattern broken) is judged by Ajv on the
 * shared schema and by zod, and both must give the verdict the corpus names.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import type { z } from "zod";
import {
  COMPUTE_ACCOUNTING,
  COMPUTE_EXECUTORS,
  COMPUTE_FAILURE_CODES,
  COMPUTE_REFUSAL_CODES,
  COMPUTE_WORD_RE,
  LAUNCHER_DETAILS,
  LAUNCHER_FAILURE_CODES,
  PLATFORM_FAILURE_CODES,
  RUNNER_BACKENDS,
  RUNNER_LOST_DETAILS,
  RUNNER_REFUSALS,
  RUNNER_REFUSAL_STATUS,
  isPlatformFailure,
} from "../shared/compute-state";
import { COMPUTE_POOLS } from "../shared/contract/compute";
import {
  LAUNCH_SPEC_ENV_MAX_CHARS,
  decodeLaunchSpecEnv,
  encodeLaunchSpecEnv,
} from "../shared/contract/compute-launch";
import {
  LEASE_ID_RE,
  RUNNER_ACCESS_PREFIX,
  RUNNER_ACCESS_TOKEN_RE,
  RUNNER_ACCESS_TOKEN_SECONDS,
  RUNNER_ARCHES,
  RUNNER_DEADLINE_GRACE_MINUTES,
  RUNNER_HEARTBEAT_SECONDS,
  RUNNER_ID_RE,
  RUNNER_LEASE_HEADER,
  RUNNER_LEASE_SECONDS,
  RUNNER_LOST_GIVE_UP_MINUTES,
  RUNNER_MAX_CLAIMS,
  RUNNER_MAX_FREE_SLOTS,
  RUNNER_PHASES,
  RUNNER_PROTOCOL,
  RUNNER_RUNTIMES,
  RUNNER_SECRET_PREFIX,
  RUNNER_SECRET_RE,
  RUNNER_SEMVER_RE,
  RUNNER_SITE_RE,
  RUNNER_SWEEP_BATCH,
  RUNNER_TRUST,
  RUNNER_USER_AGENT_PREFIX,
  RUNNER_VERSION_MAX,
  RunnerClaimRequestSchema,
  RunnerClaimResponseSchema,
  RunnerClaimedJobSchema,
  RunnerCompleteRequestSchema,
  RunnerCompleteResponseSchema,
  RunnerHeartbeatRequestSchema,
  RunnerHeartbeatResponseSchema,
  RunnerRegisterRequestSchema,
  RunnerRegisterResponseSchema,
  RunnerTokenRequestSchema,
  RunnerTokenResponseSchema,
} from "../shared/contract/compute-runner";
import runnerSchema from "../shared/contract/compute-runner.schema.json";
import * as contractIndex from "../shared/contract/index";

const HEX64 = "ab".repeat(32);
const JOB_ID = "job_0123456789abcdef01234567";
const LEASE_ID = "0123456789abcdef0123456789abcdef";
const RUNNER_ID = "rnr_0123456789abcdef01234567";
const NOW = "2026-11-13T12:00:00Z";
const SECRET = `${RUNNER_SECRET_PREFIX}${HEX64}`;
const ACCESS = `${RUNNER_ACCESS_PREFIX}${HEX64}`;
const LAUNCH_ENV = encodeLaunchSpecEnv('{"job_id":"job_0123456789abcdef01234567"}');

// --- Words, prefixes, header and numbers, pinned ------------------------------------------------

describe("the words", () => {
  test("each list is exactly the contract's, in order", () => {
    expect([...COMPUTE_EXECUTORS]).toEqual(["tapis", "runner"]);
    expect([...COMPUTE_ACCOUNTING]).toEqual(["su", "none"]);
    expect([...RUNNER_BACKENDS]).toEqual(["local", "slurm"]);
    expect([...RUNNER_PHASES]).toEqual(["started", "uploading"]);
    expect([...RUNNER_ARCHES]).toEqual(["amd64", "arm64"]);
    expect([...RUNNER_RUNTIMES]).toEqual(["apptainer", "docker", "podman"]);
    expect([...RUNNER_TRUST]).toEqual(["lab", "hpc"]);
    expect(RUNNER_PROTOCOL).toBe("nemar.runner.v1");
  });

  test("every word is a fixed word and no list repeats one", () => {
    const lists: readonly (readonly string[])[] = [
      COMPUTE_EXECUTORS,
      COMPUTE_ACCOUNTING,
      RUNNER_BACKENDS,
      RUNNER_PHASES,
      RUNNER_ARCHES,
      RUNNER_RUNTIMES,
      RUNNER_TRUST,
      RUNNER_REFUSALS,
      RUNNER_LOST_DETAILS,
    ];
    for (const list of lists) {
      expect(new Set(list).size).toBe(list.length);
      for (const w of list) expect(COMPUTE_WORD_RE.test(w), w).toBe(true);
    }
  });

  test("the runner refusals and their statuses are the contract's ten", () => {
    expect({ ...RUNNER_REFUSAL_STATUS }).toEqual({
      runner_credential_not_accepted: 401,
      runner_unknown: 401,
      runner_token_expired: 401,
      runners_disabled: 503,
      lease_lost: 409,
      job_not_claimed: 404,
      runner_outdated: 426,
      protocol_unsupported: 426,
      runner_accounting_unbuilt: 409,
      invalid_body: 400,
    });
    expect([...RUNNER_REFUSALS]).toEqual(Object.keys(RUNNER_REFUSAL_STATUS));
  });

  test("a runner refusal is not one of the person-facing compute refusals, except by the one shared word", () => {
    const shared = RUNNER_REFUSALS.filter((w) =>
      (COMPUTE_REFUSAL_CODES as readonly string[]).includes(w),
    );
    expect(shared).toEqual([]);
  });
});

describe("runner_lost", () => {
  test("it is the thirteenth platform failure code, and a failure code of its own", () => {
    expect(PLATFORM_FAILURE_CODES).toHaveLength(13);
    expect(PLATFORM_FAILURE_CODES[12]).toBe("runner_lost");
    expect((COMPUTE_FAILURE_CODES as readonly string[]).filter((c) => c === "runner_lost")).toEqual(
      ["runner_lost"],
    );
    expect((LAUNCHER_FAILURE_CODES as readonly string[]).includes("runner_lost")).toBe(false);
  });

  test("its five details are the contract's, and each is a platform failure", () => {
    expect([...RUNNER_LOST_DETAILS]).toEqual([
      "lease_expired",
      "claims_exhausted",
      "deadline_exceeded",
      "runner_revoked",
      "dataset_ineligible",
    ]);
    for (const d of RUNNER_LOST_DETAILS) expect(isPlatformFailure("runner_lost", d), d).toBe(true);
    expect(isPlatformFailure("runner_lost")).toBe(true);
    expect(isPlatformFailure("runner_lost", null)).toBe(true);
  });

  test("no launcher detail table names it, so the code alone decides", () => {
    expect(Object.hasOwn(LAUNCHER_DETAILS, "runner_lost")).toBe(false);
  });
});

describe("prefixes, identifiers, header and numbers", () => {
  test("the prefixes, the header and the user agent are the contract's", () => {
    expect(RUNNER_SECRET_PREFIX).toBe("nmr_");
    expect(RUNNER_ACCESS_PREFIX).toBe("nmra_");
    expect(RUNNER_LEASE_HEADER).toBe("X-Compute-Lease");
    expect(RUNNER_USER_AGENT_PREFIX).toBe("nemar-runner/");
  });

  test("the numbers are the contract's", () => {
    expect(RUNNER_LEASE_SECONDS).toBe(600);
    expect(RUNNER_HEARTBEAT_SECONDS).toBe(60);
    expect(RUNNER_ACCESS_TOKEN_SECONDS).toBe(900);
    expect(RUNNER_MAX_CLAIMS).toBe(3);
    expect(RUNNER_LOST_GIVE_UP_MINUTES).toBe(60);
    expect(RUNNER_DEADLINE_GRACE_MINUTES).toBe(15);
    expect(RUNNER_SWEEP_BATCH).toBe(10);
    expect(RUNNER_MAX_FREE_SLOTS).toBe(32);
    expect(RUNNER_VERSION_MAX).toBe(32);
  });

  test("a runner can miss several heartbeats before its lease runs out", () => {
    expect(RUNNER_HEARTBEAT_SECONDS * 5).toBeLessThanOrEqual(RUNNER_LEASE_SECONDS);
  });

  test("a secret is nmr_ and exactly 64 lowercase hex", () => {
    expect(RUNNER_SECRET_RE.test(SECRET)).toBe(true);
    const bad = [
      SECRET.slice(0, -1),
      `${SECRET}a`,
      `${RUNNER_SECRET_PREFIX}${HEX64.toUpperCase()}`,
      `${RUNNER_SECRET_PREFIX}${HEX64.slice(0, -1)}A`,
      `${RUNNER_SECRET_PREFIX}${HEX64.slice(0, -1)}g`,
      `${SECRET}\n`,
      ` ${SECRET}`,
      ACCESS,
      HEX64,
      "",
    ];
    for (const b of bad) expect(RUNNER_SECRET_RE.test(b), JSON.stringify(b)).toBe(false);
  });

  test("an access token is nmra_ and exactly 64 lowercase hex, and a secret is not one", () => {
    expect(RUNNER_ACCESS_TOKEN_RE.test(ACCESS)).toBe(true);
    const bad = [
      ACCESS.slice(0, -1),
      `${ACCESS}a`,
      `${RUNNER_ACCESS_PREFIX}${HEX64.toUpperCase()}`,
      `${ACCESS}\n`,
      SECRET,
      HEX64,
    ];
    for (const b of bad) expect(RUNNER_ACCESS_TOKEN_RE.test(b), JSON.stringify(b)).toBe(false);
  });

  test("the two prefixes are told apart by the first characters alone", () => {
    expect(ACCESS.startsWith(RUNNER_SECRET_PREFIX)).toBe(false);
    expect(SECRET.startsWith(RUNNER_ACCESS_PREFIX)).toBe(false);
  });

  test("runner ids, lease ids and sites", () => {
    expect(RUNNER_ID_RE.test(RUNNER_ID)).toBe(true);
    for (const b of [
      "rnr_0123456789abcdef0123456",
      "rnr_0123456789ABCDEF01234567",
      `${RUNNER_ID}0`,
      `${RUNNER_ID}\n`,
      JOB_ID,
    ]) {
      expect(RUNNER_ID_RE.test(b), b).toBe(false);
    }
    expect(LEASE_ID_RE.test(LEASE_ID)).toBe(true);
    for (const b of [LEASE_ID.slice(1), `${LEASE_ID}0`, LEASE_ID.toUpperCase(), `${LEASE_ID}\n`]) {
      expect(LEASE_ID_RE.test(b), b).toBe(false);
    }
    expect(RUNNER_SITE_RE.test("site_a1")).toBe(true);
    expect(RUNNER_SITE_RE.test("a".repeat(32))).toBe(true);
    for (const b of ["", "a".repeat(33), "Site", "a-b", "a b", "a\n"]) {
      expect(RUNNER_SITE_RE.test(b), JSON.stringify(b)).toBe(false);
    }
  });

  test("the version is semver of at most 32 characters", () => {
    for (const ok of ["0.1.0", "10.20.30", "1.2.3-rc.1", "1.0.0+build.5"]) {
      expect(RUNNER_SEMVER_RE.test(ok), ok).toBe(true);
    }
    for (const bad of ["1.2", "01.2.3", "1.2.3.final", "v1.2.3", "1.2.3-", ""]) {
      expect(RUNNER_SEMVER_RE.test(bad), bad).toBe(false);
    }
  });

  test("the contract index re-exports the module", () => {
    expect(contractIndex.RunnerClaimRequestSchema).toBe(RunnerClaimRequestSchema);
    expect(contractIndex.RUNNER_PROTOCOL).toBe(RUNNER_PROTOCOL);
    expect(contractIndex.RUNNER_MAX_FREE_SLOTS).toBe(RUNNER_MAX_FREE_SLOTS);
  });
});

// --- One valid document of every shape ----------------------------------------------------------

type Shape = {
  name: string;
  schema: z.ZodTypeAny;
  open: boolean;
  valid: () => Record<string, unknown>;
};

const claimedJob = () => ({
  id: JOB_ID,
  lease_id: LEASE_ID,
  lease_expires_at: NOW,
  launch_spec_env: LAUNCH_ENV,
  image: {
    uri: `docker://ghcr.io/nemarorg/runtime@sha256:${HEX64}`,
    digest: `sha256:${HEX64}`,
    sif: `${HEX64}.sif`,
  },
  cores: 4,
  memory_mb: 8192,
  gpus: 0,
  minutes: 60,
});

const SHAPES: readonly Shape[] = [
  {
    name: "RunnerRegisterRequest",
    schema: RunnerRegisterRequestSchema,
    open: false,
    valid: () => ({
      name: "workstation_a",
      pool: "cpu",
      cores: 16,
      memory_mb: 65536,
      gpus: 0,
      scratch_gb: 500,
      backend: "local",
      runtimes: ["apptainer", "docker"],
      arch: "amd64",
      accounting: "none",
      site: "lab_one",
      trust: "lab",
    }),
  },
  {
    name: "RunnerTokenRequest",
    schema: RunnerTokenRequestSchema,
    open: false,
    valid: () => ({ protocol: RUNNER_PROTOCOL, runner_version: "0.1.0" }),
  },
  {
    name: "RunnerClaimRequest",
    schema: RunnerClaimRequestSchema,
    open: false,
    valid: () => ({
      protocol: RUNNER_PROTOCOL,
      free_slots: 2,
      runtimes: ["podman"],
      arch: "arm64",
      runner_version: "0.1.0",
    }),
  },
  {
    name: "RunnerHeartbeatRequest",
    schema: RunnerHeartbeatRequestSchema,
    open: false,
    valid: () => ({ job_id: JOB_ID, lease_id: LEASE_ID, phase: "started" }),
  },
  {
    name: "RunnerCompleteRequest",
    schema: RunnerCompleteRequestSchema,
    open: false,
    valid: () => ({
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      exit_number: 0,
      launcher_failure_code: null,
      launcher_detail: null,
      usage: { wall_seconds: 120, cpu_seconds: 400, max_rss_mb: 2048 },
      usage_partial: false,
      scratch_discarded: true,
    }),
  },
  {
    name: "RunnerRegisterResponse",
    schema: RunnerRegisterResponseSchema,
    open: true,
    valid: () => ({ runner_id: RUNNER_ID, secret: SECRET }),
  },
  {
    name: "RunnerTokenResponse",
    schema: RunnerTokenResponseSchema,
    open: true,
    valid: () => ({ access_token: ACCESS, expires_at: NOW }),
  },
  {
    name: "RunnerClaimResponse",
    schema: RunnerClaimResponseSchema,
    open: true,
    valid: () => ({ jobs: [claimedJob()], min_runner_version: "0.1.0" }),
  },
  {
    name: "RunnerHeartbeatResponse",
    schema: RunnerHeartbeatResponseSchema,
    open: true,
    valid: () => ({ lease_expires_at: NOW, cancel: false }),
  },
  {
    name: "RunnerCompleteResponse",
    schema: RunnerCompleteResponseSchema,
    open: true,
    valid: () => ({ state: "archiving" }),
  },
];

const REQUESTS = SHAPES.filter((s) => !s.open);
const RESPONSES = SHAPES.filter((s) => s.open);

describe("requests are closed and responses are open", () => {
  test("every valid instance is accepted", () => {
    expect(SHAPES).toHaveLength(10);
    for (const s of SHAPES) {
      const parsed = s.schema.safeParse(s.valid());
      expect(parsed.success, `${s.name}: ${JSON.stringify(parsed)}`).toBe(true);
    }
  });

  test("an unknown key is refused in every request", () => {
    expect(REQUESTS).toHaveLength(5);
    for (const s of REQUESTS) {
      expect(s.schema.safeParse({ ...s.valid(), extra: 1 }).success, s.name).toBe(false);
    }
  });

  test("an unknown key is refused inside the usage of a completion", () => {
    const doc = RunnerCompleteRequestSchema.shape.usage;
    expect(
      doc.safeParse({ wall_seconds: 1, cpu_seconds: 1, max_rss_mb: 1, extra: 1 }).success,
    ).toBe(false);
  });

  test("an unknown key is kept in every response, at the top and inside a job and its image", () => {
    expect(RESPONSES).toHaveLength(5);
    for (const s of RESPONSES) {
      const parsed = s.schema.safeParse({ ...s.valid(), extra: 1 });
      expect(parsed.success, s.name).toBe(true);
      expect((parsed as { data: Record<string, unknown> }).data.extra, s.name).toBe(1);
    }
    const job = { ...claimedJob(), extra: 1, image: { ...claimedJob().image, extra: 1 } };
    const parsed = RunnerClaimResponseSchema.parse({ jobs: [job], min_runner_version: "0.1.0" });
    expect((parsed.jobs[0] as Record<string, unknown>).extra).toBe(1);
    expect((parsed.jobs[0]?.image as Record<string, unknown>).extra).toBe(1);
  });

  test("a response is never built from a request schema: the registration secret is a response only", () => {
    // A request that carried a credential would be a place to leak one: none of the five does.
    for (const s of REQUESTS) {
      const keys = Object.keys((s.schema as z.AnyZodObject).shape);
      for (const k of ["secret", "access_token", "token"]) expect(keys, s.name).not.toContain(k);
    }
  });
});

describe("the secret and the token", () => {
  test("a registration answer refuses a secret one hex short, one long or in capitals", () => {
    const bad = [
      SECRET.slice(0, -1),
      `${SECRET}0`,
      SECRET.toUpperCase(),
      `nmr_${HEX64.toUpperCase()}`,
    ];
    for (const secret of bad) {
      expect(
        RunnerRegisterResponseSchema.safeParse({ runner_id: RUNNER_ID, secret }).success,
        secret,
      ).toBe(false);
    }
  });

  test("an exchange answer refuses a token one hex short, one long, in capitals or a secret", () => {
    const bad = [ACCESS.slice(0, -1), `${ACCESS}0`, `nmra_${HEX64.toUpperCase()}`, SECRET];
    for (const access_token of bad) {
      expect(
        RunnerTokenResponseSchema.safeParse({ access_token, expires_at: NOW }).success,
        access_token,
      ).toBe(false);
    }
  });
});

describe("the claim answer", () => {
  test("it holds at most RUNNER_MAX_FREE_SLOTS jobs and refuses one more", () => {
    const jobs = (n: number) => Array.from({ length: n }, claimedJob);
    const answer = (n: number) => ({ jobs: jobs(n), min_runner_version: "0.1.0" });
    expect(RunnerClaimResponseSchema.safeParse(answer(0)).success).toBe(true);
    expect(RunnerClaimResponseSchema.safeParse(answer(RUNNER_MAX_FREE_SLOTS)).success).toBe(true);
    expect(RunnerClaimResponseSchema.safeParse(answer(RUNNER_MAX_FREE_SLOTS + 1)).success).toBe(
      false,
    );
  });

  test("a job carries a launch value that decodeLaunchSpecEnv reads, and one of the longest length", () => {
    const job = RunnerClaimedJobSchema.parse(claimedJob());
    expect(decodeLaunchSpecEnv(job.launch_spec_env).ok).toBe(true);
    const longest = "A".repeat(LAUNCH_SPEC_ENV_MAX_CHARS);
    expect(
      RunnerClaimedJobSchema.safeParse({ ...claimedJob(), launch_spec_env: longest }).success,
    ).toBe(true);
    expect(
      RunnerClaimedJobSchema.safeParse({ ...claimedJob(), launch_spec_env: `${longest}A` }).success,
    ).toBe(false);
    for (const bad of ["", "a=", "a b", "a+b", "a/b", "a\n"]) {
      expect(
        RunnerClaimedJobSchema.safeParse({ ...claimedJob(), launch_spec_env: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  test("a job with no memory limit has a null memory_mb", () => {
    expect(RunnerClaimedJobSchema.safeParse({ ...claimedJob(), memory_mb: null }).success).toBe(
      true,
    );
    const { memory_mb: _omitted, ...without } = claimedJob();
    expect(RunnerClaimedJobSchema.safeParse(without).success).toBe(false);
  });
});

describe("a registration, a claim and a completion", () => {
  test("a registration names each runtime at most once and at least one", () => {
    const reg = (runtimes: unknown) => ({ ...SHAPES[0]?.valid(), runtimes });
    expect(RunnerRegisterRequestSchema.safeParse(reg(["docker", "docker"])).success).toBe(false);
    expect(RunnerRegisterRequestSchema.safeParse(reg([])).success).toBe(false);
    expect(RunnerRegisterRequestSchema.safeParse(reg([...RUNNER_RUNTIMES])).success).toBe(true);
    expect(RunnerRegisterRequestSchema.safeParse(reg(["lxc"])).success).toBe(false);
  });

  test("a registration's pool is one of the compute pools", () => {
    for (const pool of COMPUTE_POOLS) {
      expect(RunnerRegisterRequestSchema.safeParse({ ...SHAPES[0]?.valid(), pool }).success).toBe(
        true,
      );
    }
    expect(
      RunnerRegisterRequestSchema.safeParse({ ...SHAPES[0]?.valid(), pool: "tpu" }).success,
    ).toBe(false);
  });

  test("a completion's failure code is a launcher code or null, never a platform one", () => {
    const done = (code: unknown) => ({ ...SHAPES[4]?.valid(), launcher_failure_code: code });
    for (const code of [...LAUNCHER_FAILURE_CODES, null]) {
      expect(RunnerCompleteRequestSchema.safeParse(done(code)).success, String(code)).toBe(true);
    }
    for (const code of ["runner_lost", "tapis_error", "", "Runtime_Error"]) {
      expect(RunnerCompleteRequestSchema.safeParse(done(code)).success, code).toBe(false);
    }
  });

  test("a completion's usage is whole and not negative", () => {
    const usage = (u: unknown) => ({ ...SHAPES[4]?.valid(), usage: u });
    const ok = { wall_seconds: 0, cpu_seconds: 0, max_rss_mb: 0 };
    expect(RunnerCompleteRequestSchema.safeParse(usage(ok)).success).toBe(true);
    for (const k of Object.keys(ok)) {
      expect(RunnerCompleteRequestSchema.safeParse(usage({ ...ok, [k]: -1 })).success, k).toBe(
        false,
      );
      expect(RunnerCompleteRequestSchema.safeParse(usage({ ...ok, [k]: 1.5 })).success, k).toBe(
        false,
      );
      expect(
        RunnerCompleteRequestSchema.safeParse(usage({ ...ok, [k]: Number.MAX_SAFE_INTEGER + 1 }))
          .success,
        k,
      ).toBe(false);
    }
  });
});

// --- The JSON Schema, read back against the constants -------------------------------------------

const AJV_OPTIONS = { strict: true, strictRequired: false, allErrors: true } as const;
const ajv = new Ajv2020(AJV_OPTIONS);
ajv.addSchema(runnerSchema);
const SCHEMA_ID = (runnerSchema as { $id: string }).$id;
// biome-ignore lint/suspicious/noExplicitAny: the schema is read as plain JSON, key by key.
type Json = Record<string, any>;
const DEFS = (runnerSchema as { $defs: Record<string, Json> }).$defs;

function validatorFor(name: string) {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${name}`);
  if (!validate) throw new Error(`no $defs/${name} in the runner schema`);
  return validate;
}

/** A schema pattern ends with a lookahead where a JavaScript pattern ends with `$`; the rest is the same. */
const asPattern = (def: Json): string => (def.pattern as string).replace("(?![\\s\\S])", "$");
const unescapeSlash = (source: string): string => source.replace(/\\\//g, "/");

describe("the JSON Schema is the contract the runner copies", () => {
  test("its identity", () => {
    expect(SCHEMA_ID).toBe("https://api.nemar.org/schemas/compute-runner-v1.json");
    expect(runnerSchema.title).toBe(RUNNER_PROTOCOL);
    expect(runnerSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  test("it is ASCII only, and compiles under strict Ajv", () => {
    const text = readFileSync(
      join(import.meta.dir, "../shared/contract/compute-runner.schema.json"),
      "utf8",
    );
    const nonAscii = [...text].filter(
      (c) => c.charCodeAt(0) > 0x7e || (c.charCodeAt(0) < 0x20 && c !== "\n"),
    );
    expect(nonAscii).toEqual([]);
    expect(() => new Ajv2020(AJV_OPTIONS).compile(runnerSchema)).not.toThrow();
  });

  test("it has one $defs entry for each of the ten shapes, and for no other shape", () => {
    const shapeNames = SHAPES.map((s) => s.name);
    const shapeDefs = Object.keys(DEFS).filter(
      (n) => n.startsWith("Runner") && /(Request|Response)$/.test(n),
    );
    expect(shapeDefs.sort()).toEqual([...shapeNames].sort());
  });

  test("a request is closed and a response is open, at every object", () => {
    for (const s of SHAPES) {
      const def = DEFS[s.name] as Json;
      if (s.open) expect(def.additionalProperties, s.name).toBeUndefined();
      else expect(def.additionalProperties, s.name).toBe(false);
    }
    expect(DEFS.RunnerCompleteRequest?.properties.usage.additionalProperties).toBe(false);
    const job = DEFS.RunnerClaimResponse?.properties.jobs.items as Json;
    expect(job.additionalProperties).toBeUndefined();
    expect(job.properties.image.additionalProperties).toBeUndefined();
  });

  test("the keys and the required keys of each shape are zod's", () => {
    for (const s of SHAPES) {
      const def = DEFS[s.name] as Json;
      const shape = (s.schema as z.AnyZodObject).shape;
      expect(Object.keys(def.properties).sort(), s.name).toEqual(Object.keys(shape).sort());
      expect([...def.required].sort(), s.name).toEqual(Object.keys(shape).sort());
    }
    const jobDef = DEFS.RunnerClaimResponse?.properties.jobs.items as Json;
    expect(Object.keys(jobDef.properties).sort()).toEqual(
      Object.keys(RunnerClaimedJobSchema.shape).sort(),
    );
    expect([...jobDef.required].sort()).toEqual(Object.keys(RunnerClaimedJobSchema.shape).sort());
  });

  test("every enumeration and constant is read from the constants", () => {
    const p = (name: string) => (DEFS[name] as Json).properties;
    expect(p("RunnerRegisterRequest").pool.enum).toEqual([...COMPUTE_POOLS]);
    expect(p("RunnerRegisterRequest").backend.enum).toEqual([...RUNNER_BACKENDS]);
    expect(p("RunnerRegisterRequest").accounting.enum).toEqual([...COMPUTE_ACCOUNTING]);
    expect(p("RunnerRegisterRequest").trust.enum).toEqual([...RUNNER_TRUST]);
    expect(DEFS.Runtimes?.items.enum).toEqual([...RUNNER_RUNTIMES]);
    expect(DEFS.Runtimes?.maxItems).toBe(RUNNER_RUNTIMES.length);
    expect(DEFS.Arch?.enum).toEqual([...RUNNER_ARCHES]);
    expect(p("RunnerHeartbeatRequest").phase.enum).toEqual([...RUNNER_PHASES]);
    expect(p("RunnerTokenRequest").protocol.const).toBe(RUNNER_PROTOCOL);
    expect(p("RunnerClaimRequest").protocol.const).toBe(RUNNER_PROTOCOL);
    expect(p("RunnerCompleteRequest").launcher_failure_code.enum).toEqual([
      ...LAUNCHER_FAILURE_CODES,
      null,
    ]);
  });

  test("every bound is read from the constants", () => {
    const claim = (DEFS.RunnerClaimRequest as Json).properties;
    expect(claim.free_slots).toEqual({
      type: "integer",
      minimum: 1,
      maximum: RUNNER_MAX_FREE_SLOTS,
    });
    const answer = (DEFS.RunnerClaimResponse as Json).properties;
    expect(answer.jobs.maxItems).toBe(RUNNER_MAX_FREE_SLOTS);
    expect(answer.jobs.items.properties.launch_spec_env.maxLength).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
    expect(DEFS.Version?.maxLength).toBe(RUNNER_VERSION_MAX);
    const word = new RegExp(asPattern(DEFS.Word as Json));
    expect(word.source).toBe(COMPUTE_WORD_RE.source);
  });

  test("every pattern is the regular expression zod uses", () => {
    const pairs: [string, RegExp][] = [
      ["JobId", /^job_[0-9a-f]{24}$/],
      ["LeaseId", LEASE_ID_RE],
      ["RunnerId", RUNNER_ID_RE],
      ["RunnerSecret", RUNNER_SECRET_RE],
      ["RunnerAccessToken", RUNNER_ACCESS_TOKEN_RE],
      ["Version", RUNNER_SEMVER_RE],
    ];
    for (const [name, re] of pairs) {
      expect(unescapeSlash(asPattern(DEFS[name] as Json)), name).toBe(unescapeSlash(re.source));
    }
    const site = (DEFS.RunnerRegisterRequest as Json).properties.site;
    expect(asPattern(site)).toBe(RUNNER_SITE_RE.source);
  });
});

// --- Agreement of zod and the schema over a generated corpus ------------------------------------

/** A document, the shape it is judged as, and the verdict both validators must give it. */
type Case = readonly [label: string, shape: Shape, doc: unknown, valid: boolean];

function setPath(doc: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const copy = structuredClone(doc) as Record<string | number, unknown>;
  let cur: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) cur = cur[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return copy;
}

function leafPaths(doc: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(doc)) {
    return doc.flatMap((item, i) =>
      typeof item === "object" ? leafPaths(item, [...prefix, i]) : [[...prefix, i]],
    );
  }
  if (doc !== null && typeof doc === "object") {
    return Object.entries(doc).flatMap(([k, v]) => {
      const here = [...prefix, k];
      return typeof v === "object" && v !== null && !Array.isArray(v)
        ? [here, ...leafPaths(v, here)]
        : [here];
    });
  }
  return [];
}

/** A value no key of any shape accepts: an array holding an empty array. */
const WRONG_TYPE = [[]];

function generate(): Case[] {
  const cases: Case[] = [];
  for (const shape of SHAPES) {
    const base = shape.valid();
    cases.push([`${shape.name}: valid`, shape, base, true]);
    cases.push([`${shape.name}: unknown key`, shape, { ...base, extra: 1 }, shape.open]);
    cases.push([`${shape.name}: not an object`, shape, [base], false]);
    for (const path of leafPaths(base)) {
      const at = path.join(".");
      cases.push([`${shape.name}: ${at} removed`, shape, setPath(base, path, undefined), false]);
      cases.push([
        `${shape.name}: ${at} of the wrong type`,
        shape,
        setPath(base, path, WRONG_TYPE),
        false,
      ]);
    }
  }
  const claim = SHAPES[2] as Shape;
  const reg = SHAPES[0] as Shape;
  const comp = SHAPES[4] as Shape;
  const answer = SHAPES[7] as Shape;
  const token = SHAPES[6] as Shape;
  const secretShape = SHAPES[5] as Shape;
  const bound = (shape: Shape, path: (string | number)[], ok: unknown, bad: unknown) => {
    const base = shape.valid();
    cases.push([
      `${shape.name}: ${path.join(".")} at the bound`,
      shape,
      setPath(base, path, ok),
      true,
    ]);
    cases.push([
      `${shape.name}: ${path.join(".")} past the bound`,
      shape,
      setPath(base, path, bad),
      false,
    ]);
  };
  bound(claim, ["free_slots"], RUNNER_MAX_FREE_SLOTS, RUNNER_MAX_FREE_SLOTS + 1);
  bound(claim, ["free_slots"], 1, 0);
  bound(
    claim,
    ["runner_version"],
    `1.0.0-${"a".repeat(RUNNER_VERSION_MAX - 6)}`,
    `1.0.0-${"a".repeat(RUNNER_VERSION_MAX - 5)}`,
  );
  bound(reg, ["cores"], 256, 257);
  bound(reg, ["cores"], 1, 0);
  bound(reg, ["memory_mb"], 16_777_216, 16_777_217);
  bound(reg, ["gpus"], 8, 9);
  bound(reg, ["gpus"], 0, -1);
  bound(reg, ["scratch_gb"], 100_000, 100_001);
  bound(reg, ["name"], "a".repeat(64), "a".repeat(65));
  bound(reg, ["name"], "workstation_1", "Workstation_1");
  bound(reg, ["site"], "a".repeat(32), "a".repeat(33));
  bound(reg, ["site"], "a_1", "A_1");
  bound(reg, ["runtimes"], [...RUNNER_RUNTIMES], ["docker", "docker"]);
  bound(reg, ["runtimes"], ["podman"], []);
  bound(comp, ["exit_number"], 255, 256);
  bound(comp, ["exit_number"], 0, -1);
  bound(comp, ["exit_number"], 13, 1.5);
  bound(comp, ["usage", "wall_seconds"], Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1);
  bound(comp, ["usage", "cpu_seconds"], 0, -1);
  bound(comp, ["launcher_failure_code"], "time_limit", "runner_lost");
  bound(comp, ["launcher_detail"], "entry_failed", "Entry Failed");
  bound(comp, ["launcher_detail"], null, "");
  bound(comp, ["lease_id"], LEASE_ID, LEASE_ID.toUpperCase());
  bound(comp, ["job_id"], JOB_ID, `${JOB_ID}\n`);
  bound(token, ["access_token"], ACCESS, ACCESS.slice(0, -1));
  bound(token, ["access_token"], ACCESS, `${ACCESS}0`);
  bound(token, ["access_token"], ACCESS, SECRET);
  bound(secretShape, ["secret"], SECRET, SECRET.slice(0, -1));
  bound(secretShape, ["secret"], SECRET, SECRET.toUpperCase());
  bound(secretShape, ["runner_id"], RUNNER_ID, "rnr_0123");
  bound(answer, ["min_runner_version"], "0.0.1", "0.0");
  bound(answer, ["jobs", 0, "cores"], 256, 257);
  bound(answer, ["jobs", 0, "gpus"], 8, 9);
  bound(answer, ["jobs", 0, "minutes"], 1, 0);
  bound(answer, ["jobs", 0, "memory_mb"], null, 0);
  bound(
    answer,
    ["jobs", 0, "launch_spec_env"],
    "A".repeat(LAUNCH_SPEC_ENV_MAX_CHARS),
    "A".repeat(LAUNCH_SPEC_ENV_MAX_CHARS + 1),
  );
  bound(answer, ["jobs", 0, "launch_spec_env"], "abc_-", "ab=c");
  bound(answer, ["jobs", 0, "image", "sif"], `${HEX64}.sif`, `${HEX64}.SIF`);
  bound(answer, ["jobs", 0, "image", "digest"], `sha256:${HEX64}`, `sha256:${HEX64.toUpperCase()}`);
  bound(answer, ["jobs", 0, "lease_expires_at"], NOW, "2026-11-13 12:00:00");
  bound(
    answer,
    ["jobs"],
    Array.from({ length: RUNNER_MAX_FREE_SLOTS }, claimedJob),
    Array.from({ length: RUNNER_MAX_FREE_SLOTS + 1 }, claimedJob),
  );
  return cases;
}

describe("zod and the JSON Schema agree", () => {
  const cases = generate();

  test("the corpus is at least 40 instances, and holds both verdicts for every shape", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const s of SHAPES) {
      const mine = cases.filter(([, shape]) => shape === s);
      expect(
        mine.some(([, , , valid]) => valid),
        s.name,
      ).toBe(true);
      expect(
        mine.some(([, , , valid]) => !valid),
        s.name,
      ).toBe(true);
    }
  });

  test("each instance gets the verdict the corpus names, from zod and from Ajv alike", () => {
    for (const [label, shape, doc, valid] of cases) {
      const viaZod = shape.schema.safeParse(doc).success;
      const viaAjv = validatorFor(shape.name)(doc) as boolean;
      expect(viaZod, `zod: ${label}`).toBe(valid);
      expect(viaAjv, `JSON Schema: ${label}`).toBe(valid);
    }
  });
});
