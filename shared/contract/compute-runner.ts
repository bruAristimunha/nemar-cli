/**
 * The runner contract, protocol `nemar.runner.v1` (portable compute, decisions D1, D2, D4 and D6):
 * every word, prefix, header, number and request and response shape that a runner (`nemar-runner`
 * in `nemarOrg/nemar-process`, on a workstation or a cluster) and NEMAR's Worker exchange, declared
 * once. The words shared with the job model (executors, accounting classes, backends, the runner
 * refusals and `runner_lost`) are in `../compute-state.ts`; this file adds the protocol's own.
 *
 * THE JSON SCHEMA NEXT TO THIS FILE IS SHARED BYTE FOR BYTE with `nemarOrg/nemar-process`, where the
 * runner is written. The runner cannot import this file, so `compute-runner.schema.json` is the
 * contract both sides check against, and `test/compute-runner-contract.unit.test.ts` holds the two
 * to each other: its constants are read back against these, and a generated corpus is judged by both
 * Ajv and zod. Whichever repository merges first writes the file; the other copies it, never edits it.
 *
 * REQUESTS ARE CLOSED, RESPONSES ARE OPEN. A runner can poll for days and must survive the Worker
 * adding a key to an answer, so every response is `.passthrough()`; every request is `.strict()`,
 * because the Worker validates it as it arrives and a mistyped key is a bug to refuse (the refusal
 * is `invalid_body`). Like `./compute.ts` and `./compute-launch.ts`, this file is exempted by name in
 * `test/contract-schemas.test.ts`. Never parse a response with a strict schema, and never build a
 * response schema from a request one.
 *
 * Two rules no schema here can state, so the reader enforces them: a claim answer cannot say that
 * `jobs.length <= free_slots` (it is a rule between the request and the response, so the runner must
 * check it; the schema only caps `jobs` at `RUNNER_MAX_FREE_SLOTS`), and a `launch_spec_env` is checked
 * for its alphabet and length only (the runner decodes it with the rules of `decodeLaunchSpecEnv`).
 *
 * Nothing here reads a clock, a database or a network.
 */

import { z } from "zod";
import {
  COMPUTE_ACCOUNTING,
  COMPUTE_WORD_RE,
  LAUNCHER_FAILURE_CODES,
  RUNNER_BACKENDS,
} from "../compute-state.js";
import { LAUNCH_SPEC_ENV_MAX_CHARS } from "./compute-launch.js";
import {
  COMPUTE_IMAGE_DIGEST_RE,
  COMPUTE_IMAGE_REF_RE,
  COMPUTE_JOB_ID_RE,
  COMPUTE_POOLS,
  computeSafeInt,
} from "./compute.js";

// --- Words --------------------------------------------------------------------------------------

/** The protocol's name, sent by a runner when it exchanges its secret and when it claims. */
export const RUNNER_PROTOCOL = "nemar.runner.v1";

/** What a runner reports with a heartbeat: it began the job, or it is uploading the outputs. */
export const RUNNER_PHASES = ["started", "uploading"] as const;
export type RunnerPhase = (typeof RUNNER_PHASES)[number];

/** The processor architectures a runner declares and a job's image must match. */
export const RUNNER_ARCHES = ["amd64", "arm64"] as const;
export type RunnerArch = (typeof RUNNER_ARCHES)[number];

/** The container runtimes a runner may run an image with. */
export const RUNNER_RUNTIMES = ["apptainer", "docker", "podman"] as const;
export type RunnerRuntime = (typeof RUNNER_RUNTIMES)[number];

/** How far NEMAR trusts the machine: `lab` is a workstation its owner controls, `hpc` a shared cluster. */
export const RUNNER_TRUST = ["lab", "hpc"] as const;
export type RunnerTrust = (typeof RUNNER_TRUST)[number];

// --- Credentials and identifiers -----------------------------------------------------------------

/** A runner's long-lived secret: this prefix and exactly 64 lowercase hex, shown once. */
export const RUNNER_SECRET_PREFIX = "nmr_";

/** A runner's access token, valid for {@link RUNNER_ACCESS_TOKEN_SECONDS}: this prefix and 64 hex. */
export const RUNNER_ACCESS_PREFIX = "nmra_";

const HEX64 = "[0-9a-f]{64}";

/** The whole secret, `nmr_` plus 64 lowercase hex. */
export const RUNNER_SECRET_RE = new RegExp(`^${RUNNER_SECRET_PREFIX}${HEX64}$`);

/** The whole access token, `nmra_` plus 64 lowercase hex. */
export const RUNNER_ACCESS_TOKEN_RE = new RegExp(`^${RUNNER_ACCESS_PREFIX}${HEX64}$`);

/** A runner registration's public id. */
export const RUNNER_ID_RE = /^rnr_[0-9a-f]{24}$/;

/** A lease's id: 32 lowercase hex. */
export const LEASE_ID_RE = /^[0-9a-f]{32}$/;

/** A site name, a fixed word chosen at registration: lowercase letters, digits and underscore. */
export const RUNNER_SITE_RE = /^[a-z0-9_]{1,32}$/;

/** The header carrying the current lease on the bundle, outputs and outputs-complete calls of a runner job. */
export const RUNNER_LEASE_HEADER = "X-Compute-Lease";

/** A runner's `User-Agent` begins with this, followed by its version. */
export const RUNNER_USER_AGENT_PREFIX = "nemar-runner/";

// --- Numbers ------------------------------------------------------------------------------------

/** A claim's lease, in seconds, and what a heartbeat renews it to. */
export const RUNNER_LEASE_SECONDS = 600;

/** How often a runner heartbeats, in seconds. */
export const RUNNER_HEARTBEAT_SECONDS = 60;

/** An access token's lifetime, in seconds. */
export const RUNNER_ACCESS_TOKEN_SECONDS = 900;

/** The most times a job is claimed; a job lost after the last is `runner_lost` `claims_exhausted`. */
export const RUNNER_MAX_CLAIMS = 3;

/** How long an `unreported` runner job waits for its outputs before it is `runner_lost` `lease_expired`, in minutes. */
export const RUNNER_LOST_GIVE_UP_MINUTES = 60;

/** How long past its minutes a started job may run before it is `runner_lost` `deadline_exceeded`, in minutes. */
export const RUNNER_DEADLINE_GRACE_MINUTES = 15;

/** How many runner jobs one sweep of leases looks at. */
export const RUNNER_SWEEP_BATCH = 10;

/** The most jobs one claim asks for, and so the most one answer holds. */
export const RUNNER_MAX_FREE_SLOTS = 32;

// --- Shapes -------------------------------------------------------------------------------------

const safeInt = computeSafeInt;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** UTC, as the presigning calls write it; the shape is checked, not the calendar. */
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/;
const SIF_FILE_RE = /^[0-9a-f]{64}\.sif$/;
/** Semantic Versioning 2.0.0, as a runner and the Worker compare versions. */
export const RUNNER_SEMVER_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** The longest version string a runner sends or the Worker answers. */
export const RUNNER_VERSION_MAX = 32;
/** The alphabet of a launch specification's environment value, as in `compute-launch.ts`. */
const LAUNCH_SPEC_ENV_RE = /^[A-Za-z0-9_-]+$/;

const wordSchema = z.string().regex(COMPUTE_WORD_RE);
const jobIdSchema = z.string().regex(COMPUTE_JOB_ID_RE);
const leaseIdSchema = z.string().regex(LEASE_ID_RE);
const versionSchema = z.string().max(RUNNER_VERSION_MAX).regex(RUNNER_SEMVER_RE);
const timestampSchema = z.string().regex(TIMESTAMP_RE);
const runtimesSchema = z
  .array(z.enum(RUNNER_RUNTIMES))
  .min(1)
  .max(RUNNER_RUNTIMES.length)
  .refine((list) => new Set(list).size === list.length, { message: "each runtime is named once" });

// Requests: closed.

/** `POST /compute/runners`: an owner registers a runner and states its capacity and accounting. */
export const RunnerRegisterRequestSchema = z
  .object({
    name: wordSchema,
    pool: z.enum(COMPUTE_POOLS),
    cores: safeInt(1, 256),
    memory_mb: safeInt(1, 16_777_216),
    gpus: safeInt(0, 8),
    scratch_gb: safeInt(1, 100_000),
    backend: z.enum(RUNNER_BACKENDS),
    runtimes: runtimesSchema,
    arch: z.enum(RUNNER_ARCHES),
    accounting: z.enum(COMPUTE_ACCOUNTING),
    site: z.string().regex(RUNNER_SITE_RE),
    trust: z.enum(RUNNER_TRUST),
  })
  .strict();

/** The secret, sent as a credential, buys an access token for this protocol and this version of the runner. */
export const RunnerTokenRequestSchema = z
  .object({ protocol: z.literal(RUNNER_PROTOCOL), runner_version: versionSchema })
  .strict();

/** A claim: how many jobs the runner has room for, and what it can run them with. */
export const RunnerClaimRequestSchema = z
  .object({
    protocol: z.literal(RUNNER_PROTOCOL),
    free_slots: safeInt(1, RUNNER_MAX_FREE_SLOTS),
    runtimes: runtimesSchema,
    arch: z.enum(RUNNER_ARCHES),
    runner_version: versionSchema,
  })
  .strict();

/** A heartbeat renews the lease of one job and reports the phase it is in. */
export const RunnerHeartbeatRequestSchema = z
  .object({ job_id: jobIdSchema, lease_id: leaseIdSchema, phase: z.enum(RUNNER_PHASES) })
  .strict();

/** What a runner measured, in whole numbers. */
const usageSchema = z
  .object({
    wall_seconds: safeInt(0),
    cpu_seconds: safeInt(0),
    max_rss_mb: safeInt(0),
  })
  .strict();

/** The end of one job on the runner: how it exited, the launcher's own failure word, and the usage. */
export const RunnerCompleteRequestSchema = z
  .object({
    job_id: jobIdSchema,
    lease_id: leaseIdSchema,
    exit_number: safeInt(0, 255),
    launcher_failure_code: z.enum(LAUNCHER_FAILURE_CODES).nullable(),
    launcher_detail: wordSchema.nullable(),
    usage: usageSchema,
    usage_partial: z.boolean(),
    scratch_discarded: z.boolean(),
  })
  .strict();

// Responses: open.

/** The answer to a registration: the id, and the secret, shown once. */
export const RunnerRegisterResponseSchema = z
  .object({ runner_id: z.string().regex(RUNNER_ID_RE), secret: z.string().regex(RUNNER_SECRET_RE) })
  .passthrough();

/** The answer to an exchange: the access token and when it stops being accepted. */
export const RunnerTokenResponseSchema = z
  .object({
    access_token: z.string().regex(RUNNER_ACCESS_TOKEN_RE),
    expires_at: timestampSchema,
  })
  .passthrough();

/** One claimed job: its lease, the launch specification to run, the image and the size to run it at. */
export const RunnerClaimedJobSchema = z
  .object({
    id: jobIdSchema,
    lease_id: leaseIdSchema,
    lease_expires_at: timestampSchema,
    /** The `NEMAR_LAUNCH_SPEC` value, as `decodeLaunchSpecEnv` reads it. */
    launch_spec_env: z.string().max(LAUNCH_SPEC_ENV_MAX_CHARS).regex(LAUNCH_SPEC_ENV_RE),
    image: z
      .object({
        uri: z.string().max(512).regex(COMPUTE_IMAGE_REF_RE),
        digest: z.string().regex(COMPUTE_IMAGE_DIGEST_RE),
        sif: z.string().regex(SIF_FILE_RE),
      })
      .passthrough(),
    cores: safeInt(1, 256),
    memory_mb: safeInt(1, 16_777_216).nullable(),
    gpus: safeInt(0, 8),
    minutes: safeInt(1, MAX_SAFE),
  })
  .passthrough();

/** The answer to a claim: up to `free_slots` jobs, and the oldest runner version the Worker still serves. */
export const RunnerClaimResponseSchema = z
  .object({
    jobs: z.array(RunnerClaimedJobSchema).max(RUNNER_MAX_FREE_SLOTS),
    min_runner_version: versionSchema,
  })
  .passthrough();

/** The answer to a heartbeat: the new end of the lease, and whether the runner is to stop the job. */
export const RunnerHeartbeatResponseSchema = z
  .object({ lease_expires_at: timestampSchema, cancel: z.boolean() })
  .passthrough();

/** The answer to a completion: the state the job is in. */
export const RunnerCompleteResponseSchema = z.object({ state: wordSchema }).passthrough();

export type RunnerRegisterRequest = z.infer<typeof RunnerRegisterRequestSchema>;
export type RunnerTokenRequest = z.infer<typeof RunnerTokenRequestSchema>;
export type RunnerClaimRequest = z.infer<typeof RunnerClaimRequestSchema>;
export type RunnerHeartbeatRequest = z.infer<typeof RunnerHeartbeatRequestSchema>;
export type RunnerCompleteRequest = z.infer<typeof RunnerCompleteRequestSchema>;
export type RunnerRegisterResponse = z.infer<typeof RunnerRegisterResponseSchema>;
export type RunnerTokenResponse = z.infer<typeof RunnerTokenResponseSchema>;
export type RunnerClaimedJob = z.infer<typeof RunnerClaimedJobSchema>;
export type RunnerClaimResponse = z.infer<typeof RunnerClaimResponseSchema>;
export type RunnerHeartbeatResponse = z.infer<typeof RunnerHeartbeatResponseSchema>;
export type RunnerCompleteResponse = z.infer<typeof RunnerCompleteResponseSchema>;
