/**
 * The compute gateway's contract (epic #2005 phase A1, #2006; ADR 0118): the job specification
 * every front door submits, the partition and rate tables that turn resources and time into
 * service units, the owner policy the gateway reads, and the shapes of the files the launcher
 * leaves on the node. Authored in zod, importing only zod and `../compute-state.js`, so the Worker,
 * the CLI and the tests read one declaration.
 *
 * MONEY IS INTEGER THOUSANDTHS OF AN EXPANSE SERVICE UNIT (SU). One SU is one core-hour with up to
 * 2 GB of memory per core, or one GPU-hour. Every `*Milli` figure and every `*_milli` column is
 * such an integer; nothing here is, or may become, a floating-point amount.
 *
 * THESE SCHEMAS ARE STRICT ON PURPOSE (`.strict()`, exempted by name in
 * `test/contract-schemas.test.ts`): a job specification, an owner policy and the launcher's files
 * are validated as they come in, or written by the Worker, and a mistyped key must be refused, not
 * stripped. NEVER PARSE A RESPONSE WITH THEM AND NEVER BUILD ONE FROM THEM (`.extend()`, `.pick()`,
 * `.partial()`): a released CLI or a running launcher would fail on a newer server's extra key.
 * A response schema is lenient and lives in its own file; `./compute-launch.ts` shows the two
 * responses the launcher reads, which are `.passthrough()`.
 *
 * NOTHING HERE WAS MEASURED AGAINST THE TENANT YET. The rate table, the `debug` ceilings and the
 * preempt basis below are the design's, unconfirmed with SDSC (design section 12, question 5);
 * each is marked where it is declared and stays marked until the first charge is compared with
 * Expanse's own record.
 */

import { z } from "zod";
import {
  COMPUTE_WORD_RE,
  LAUNCHER_EXIT_OK,
  LAUNCHER_FAILURE_CODES,
  launcherExitNumber,
} from "../compute-state.js";

// --- Shared patterns ---------------------------------------------------------------------------

/** The characters no path or pattern may hold: control characters and DEL, written as escapes. */
const CONTROL_CHARS = "\\u0000-\\u001f\\u007f";

/**
 * A path segment, as a regular-expression source: one or more characters that are not a slash, a
 * backslash, a control character or DEL. Every path grammar in the contract is built from this
 * one string, here and in `./compute-launch.ts`.
 */
export const COMPUTE_PATH_SEGMENT = `[^/\\\\${CONTROL_CHARS}]+`;
const SEGMENT = COMPUTE_PATH_SEGMENT;

/** A relative path of non-empty segments; `.` and `..` segments are refused separately. */
export const COMPUTE_PATH_RE = new RegExp(`^(?:${SEGMENT}/)*${SEGMENT}$`);

/** A `.` or `..` segment anywhere in a path. */
export const COMPUTE_DOT_SEGMENT_RE = /(?:^|\/)\.\.?(?:\/|$)/;

/** A glob holds no backslash, control character or DEL... */
const COMPUTE_GLOB_CHARS_RE = new RegExp(`^[^\\\\${CONTROL_CHARS}]+$`);

/** ...and stays inside its dataset: no absolute start and no `..` segment. */
const COMPUTE_GLOB_ESCAPES_RE = /^\/|(?:^|\/)\.\.(?:\/|$)/;

/** A relative path with no empty, `.` or `..` segment, no backslash and no control character. */
export function isSafeComputePath(path: string, maxLength = 512): boolean {
  return (
    typeof path === "string" &&
    path.length >= 1 &&
    path.length <= maxLength &&
    COMPUTE_PATH_RE.test(path) &&
    !COMPUTE_DOT_SEGMENT_RE.test(path)
  );
}

/**
 * The most files one job lists: the outputs of a result manifest and of an outputs request. The
 * owner's `resultLimits.maxFiles` may be lower, never higher; the launcher files are counted
 * apart (`LAUNCHER_FILE_NAMES.length` more upload addresses).
 */
export const COMPUTE_MAX_OUTPUT_FILES = 100_000;

/** A NEMAR job id: `job_` and 24 lowercase hex digits. */
export const COMPUTE_JOB_ID_RE = /^job_[0-9a-f]{24}$/;

export const COMPUTE_SHA256_RE = /^[0-9a-f]{64}$/;
export const COMPUTE_IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Two lowercase letters and six digits: `nm000104`, `on000001`, `xx099900`, `ds002718`. */
export const COMPUTE_DATASET_ID_RE = /^[a-z]{2}[0-9]{6}$/;
/**
 * A dataset version as a job names it (loose, so `1.0.2`, `v1.0.2` and `latest` all pass) and as the
 * launcher's provenance records it (`staging[].version`: the data-plane tag it fetched, so every tag
 * {@link dataTagForVersion} returns must fit this, at most 64 characters). The launch specification
 * carries the data-plane tag instead of the loose form: see {@link dataTagForVersion}.
 */
export const COMPUTE_DATASET_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/**
 * The data plane's name for a dataset version: `latest`, or `v<major>.<minor>.<patch>` (the data
 * plane accepts exactly these; see `VERSION_TAG_RE` in `backend/src/services/data-router.ts`, which
 * a test holds this to). It is the form the launch specification carries, where the user-facing job
 * specification (which keeps accepting `1.0.2`) names a version more loosely.
 */
export const COMPUTE_DATA_TAG_RE = /^(?:latest|v[0-9]+\.[0-9]+\.[0-9]+)$/;

/**
 * The longest data-plane tag, 64 characters: what a provenance `staging[].version` may hold
 * ({@link COMPUTE_DATASET_VERSION_RE}), because the launcher records the tag it fetched there and
 * the Worker parses that file strictly. A bare job version can therefore be at most 63 characters.
 */
export const COMPUTE_DATA_TAG_MAX = 64;

/**
 * The data-plane tag for a dataset version as a job names it: `1.0.2` gives `v1.0.2`; `v1.0.2` and
 * `latest` are already tags and come back unchanged; anything else has no tag and is null, as is a
 * tag longer than {@link COMPUTE_DATA_TAG_MAX}. The Worker's launch-specification builder uses it
 * and refuses a job whose dataset version has none. Pure.
 */
export function dataTagForVersion(version: string): string | null {
  if (typeof version !== "string") return null;
  // A version that starts with a digit is bare; the whole is checked once it has its v.
  const tag = /^[0-9]/.test(version) ? `v${version}` : version;
  return tag.length <= COMPUTE_DATA_TAG_MAX && COMPUTE_DATA_TAG_RE.test(tag) ? tag : null;
}

/**
 * The path of the first dataset whose version has no data-plane tag, as `datasets.<i>.version`, or
 * null when every one has a tag (or there are none). A job specification may carry such a version
 * (it is valid for a job), so a Worker or a CLI that finds one refuses with `invalid_spec` and names
 * this field, before the hold. Pure.
 */
export function datasetVersionWithoutTag(
  datasets: ReadonlyArray<{ version: string }>,
): string | null {
  const index = datasets.findIndex((d) => dataTagForVersion(d.version) === null);
  return index < 0 ? null : `datasets.${index}.version`;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** A whole number in [min, max], never beyond what a double holds exactly. */
export const computeSafeInt = (min: number, max: number = MAX_SAFE) =>
  z.number().int().min(min).max(max);
const safeInt = computeSafeInt;

const jobIdSchema = z.string().regex(COMPUTE_JOB_ID_RE);
const sha256Schema = z.string().regex(COMPUTE_SHA256_RE);

/**
 * A safe relative path of at most `maxLength` characters, as `isSafeComputePath` judges it. It is
 * never empty: the segment grammar needs at least one character, so there is no separate minimum.
 */
export function computePathSchema(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .regex(COMPUTE_PATH_RE)
    .refine((p) => !COMPUTE_DOT_SEGMENT_RE.test(p), {
      message: "a path may not hold . or .. segments",
    });
}
const relativePath = computePathSchema;

/**
 * A dataset include pattern: 1 to 256 characters (the character class needs one) that never leave
 * the dataset. Its dialect, and what a matcher owes, is {@link COMPUTE_INCLUDE_DESCRIPTION}.
 */
export const computeGlobSchema = z
  .string()
  .max(256)
  .regex(COMPUTE_GLOB_CHARS_RE)
  .refine((g) => !COMPUTE_GLOB_ESCAPES_RE.test(g), {
    message: "a pattern may not leave the dataset",
  });

/** A freezing helper, so a default shared by every caller cannot be changed by one of them. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// --- Pools, partitions and the rate table ------------------------------------------------------

/** Expanse CPU and Expanse GPU are separate ACCESS resources, so each person has one pool each. */
export const COMPUTE_POOLS = ["cpu", "gpu"] as const;

export type ComputePool = (typeof COMPUTE_POOLS)[number];

export const PARTITION_NAMES = [
  "shared",
  "compute",
  "debug",
  "large-shared",
  "preempt",
  "gpu-shared",
  "gpu",
  "gpu-debug",
  "gpu-preempt",
] as const;

export type PartitionName = (typeof PARTITION_NAMES)[number];

/** What one job may ask of a partition. Whole numbers; `maxGpusPerNode` 0 means no GPU. */
export const ComputeCeilingSchema = z
  .object({
    maxNodes: safeInt(1, 64),
    maxCoresPerNode: safeInt(0, 256),
    maxGpusPerNode: safeInt(0, 8),
    maxMinutes: safeInt(1, 10080),
  })
  .strict();

export type ComputeCeiling = z.infer<typeof ComputeCeilingSchema>;

/**
 * How a partition is charged, from the design's table:
 * `core_or_memory`: per node, the larger of cores and memory over 2 GB, in core-units;
 * `whole_cpu_node`: 128 core-units per node whatever was asked for;
 * `gpu_or_memory`: per node, the larger of GPUs and memory over 92 GB, in GPU-units;
 * `whole_gpu_node`: 4 GPU-units per node whatever was asked for.
 */
export type ComputeRateKind =
  | "core_or_memory"
  | "whole_cpu_node"
  | "gpu_or_memory"
  | "whole_gpu_node";

export interface ComputePartition {
  pool: ComputePool;
  rate: ComputeRateKind;
  /** Preempt partitions are charged at 800/1000 of the rate and Expanse does not refund a preemption. */
  preempt: boolean;
  /**
   * The default per-job ceiling when the partition is offered to people, or null when it is not:
   * `large-shared` and the preempt partitions are NEMAR's pipelines only, with limits set per
   * pipeline. The owner's policy decides what is offered; a partition with a ceiling there is.
   */
  ceiling: ComputeCeiling | null;
}

/** 48 hours, the ceiling for people on every partition that is not a debug partition. */
const FORTY_EIGHT_HOURS = 2880;

/**
 * UNCONFIRMED (design section 12, question 5): the `debug` and `gpu-debug` ceilings are what the
 * design calls "as Expanse allows", 30 minutes, with node counts from Expanse's public guide; the
 * 40 cores of a GPU node are its public description. Until SDSC confirms, the owner adjusts them
 * with `policy set` and nothing depends on them being exact.
 */
export const PARTITIONS: Readonly<Record<PartitionName, ComputePartition>> = deepFreeze({
  shared: {
    pool: "cpu",
    rate: "core_or_memory",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 64, maxGpusPerNode: 0, maxMinutes: FORTY_EIGHT_HOURS },
  },
  compute: {
    pool: "cpu",
    rate: "whole_cpu_node",
    preempt: false,
    ceiling: {
      maxNodes: 2,
      maxCoresPerNode: 128,
      maxGpusPerNode: 0,
      maxMinutes: FORTY_EIGHT_HOURS,
    },
  },
  debug: {
    pool: "cpu",
    rate: "core_or_memory",
    preempt: false,
    ceiling: { maxNodes: 2, maxCoresPerNode: 128, maxGpusPerNode: 0, maxMinutes: 30 },
  },
  "large-shared": { pool: "cpu", rate: "core_or_memory", preempt: false, ceiling: null },
  preempt: { pool: "cpu", rate: "core_or_memory", preempt: true, ceiling: null },
  "gpu-shared": {
    pool: "gpu",
    rate: "gpu_or_memory",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 3, maxMinutes: FORTY_EIGHT_HOURS },
  },
  gpu: {
    pool: "gpu",
    rate: "whole_gpu_node",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: FORTY_EIGHT_HOURS },
  },
  "gpu-debug": {
    pool: "gpu",
    rate: "gpu_or_memory",
    preempt: false,
    ceiling: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: 30 },
  },
  "gpu-preempt": { pool: "gpu", rate: "gpu_or_memory", preempt: true, ceiling: null },
} satisfies Record<PartitionName, ComputePartition>);

/**
 * The rate table, version 1, in milli-SU. UNCONFIRMED with SDSC before the first charge (design
 * section 12, question 5): the 2048 MB per core-unit and the 94208 MB (92 GB) per GPU-unit are the
 * design's reading of Expanse's published definition, the 800/1000 preempt factor is Expanse's
 * published 0.8, and the minimum of one SU per job is Expanse's charge on reservation. The order
 * is the design's reading: the exact amount times 800/1000, rounded up once, then the minimum.
 */
export const RATE_TABLE_V1 = {
  version: 1,
  milliPerSu: 1000,
  /** Core-units a whole `compute` node is charged per hour. */
  cpuNodeCores: 128,
  /** GPU-units a whole `gpu` node is charged per hour. */
  gpuNodeGpus: 4,
  memoryMbPerCoreUnit: 2048,
  memoryMbPerGpuUnit: 94208,
  preemptNumerator: 800,
  preemptDenominator: 1000,
  minChargeMilli: 1000,
} as const;

/** What a job reserves, per node, as Tapis and the job specification both say it. */
export interface ComputeResources {
  nodes: number;
  cores?: number;
  memory_mb?: number;
  gpus?: number;
}

function wholeNumber(name: string, value: unknown, min: number): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a whole number of at least ${min}`);
  }
  return BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * What a run of `seconds` costs in milli-SU on `partition` with `resources`, in three steps:
 * (1) the exact amount, the rate per hour times the seconds over 3600, times 800/1000 on a preempt
 * partition; (2) that amount rounded up to a whole milli-SU, ONCE; (3) raised to the 1000 minimum if
 * it is smaller. The minimum is applied AFTER the 800/1000 factor, so a preempt charge is also at
 * least 1000. Exact integer arithmetic throughout.
 *
 * Throws RangeError for a partition that is not one, a resource or a time that is not a whole
 * non-negative number (`nodes` at least 1), an amount too large to hold exactly, and a rate with no
 * driver: a per-core or per-GPU partition asked with neither cores (or GPUs) nor memory would
 * otherwise price the 1000 minimum for a job that names nothing to charge. A caller that has
 * Tapis's times rounds the seconds up first.
 */
export function suMilliFor(
  partition: PartitionName,
  resources: ComputeResources,
  seconds: number,
): number {
  if (!Object.hasOwn(PARTITIONS, partition)) throw new RangeError("not a partition");
  const info = PARTITIONS[partition];
  const nodes = wholeNumber("nodes", resources.nodes, 1);
  const cores = wholeNumber("cores", resources.cores ?? 0, 0);
  const memoryMb = wholeNumber("memory_mb", resources.memory_mb ?? 0, 0);
  const gpus = wholeNumber("gpus", resources.gpus ?? 0, 0);
  const secs = wholeNumber("seconds", seconds, 0);
  const t = RATE_TABLE_V1;
  const unit = BigInt(t.milliPerSu);

  let perNode: bigint;
  switch (info.rate) {
    case "core_or_memory": {
      if (cores === 0n && memoryMb === 0n) throw new RangeError("a rate needs cores or memory");
      const byCores = cores * unit;
      const byMemory = ceilDiv(memoryMb * unit, BigInt(t.memoryMbPerCoreUnit));
      perNode = byCores > byMemory ? byCores : byMemory;
      break;
    }
    case "whole_cpu_node":
      perNode = BigInt(t.cpuNodeCores) * unit;
      break;
    case "gpu_or_memory": {
      if (gpus === 0n && memoryMb === 0n) throw new RangeError("a rate needs GPUs or memory");
      const byGpus = gpus * unit;
      const byMemory = ceilDiv(memoryMb * unit, BigInt(t.memoryMbPerGpuUnit));
      perNode = byGpus > byMemory ? byGpus : byMemory;
      break;
    }
    case "whole_gpu_node":
      perNode = BigInt(t.gpuNodeGpus) * unit;
      break;
  }

  const ratePerHour = perNode * nodes;
  const numerator = info.preempt ? BigInt(t.preemptNumerator) : 1n;
  const denominator = info.preempt ? BigInt(t.preemptDenominator) : 1n;
  const amount = ceilDiv(ratePerHour * secs * numerator, 3600n * denominator);
  const minimum = BigInt(t.minChargeMilli);
  const charged = amount < minimum ? minimum : amount;
  if (charged > BigInt(MAX_SAFE)) throw new RangeError("amount too large to hold exactly");
  return Number(charged);
}

/**
 * The memory per node, in MB, a Tapis submit must ASK FOR on `partition` (phase A5, #2010; round 1 of the
 * review). Tapis always passes a memory to the scheduler, and its own defaults are 100 MB and 10
 * minutes, so a job that names none is LIMITED to 100 MB however much the hold charged it for: a
 * whole-node job would pay for a node and be given a hundred megabytes. This is the memory the CHARGE
 * already pays for, from the rate table, so the request and the price cannot disagree:
 *
 *  - a whole `compute` node: `cpuNodeCores` core-units of `memoryMbPerCoreUnit` (262,144 MB);
 *  - a whole `gpu` node: `gpuNodeGpus` GPU-units of `memoryMbPerGpuUnit` (376,832 MB);
 *  - a per-core partition: the job's own `memory_mb` when it names one, else its cores' share
 *    (`cores` x `memoryMbPerCoreUnit`, which is what `core_or_memory` charges for);
 *  - a per-GPU partition: the job's own `memory_mb` when it names one, else its GPUs' share
 *    (`gpus` x `memoryMbPerGpuUnit`).
 *
 * The partition table has NO per-node memory field of its own, so a whole node's memory is derived
 * from the rate table; the figures are the design's reading of Expanse's published node sizes and are
 * UNCONFIRMED with SDSC (design section 12, question 5) like the rates. A row's own `memory_mb` on a
 * whole-node partition is not used: the node is charged and given whole. Throws RangeError for a
 * partition that is not one and for a per-resource job that names neither memory nor the resource.
 */
export function submitMemoryMb(
  partition: PartitionName,
  resources: { cores?: number; memory_mb?: number | null; gpus?: number },
): number {
  if (!Object.hasOwn(PARTITIONS, partition)) throw new RangeError("not a partition");
  const t = RATE_TABLE_V1;
  const own = resources.memory_mb ?? null;
  switch (PARTITIONS[partition].rate) {
    case "whole_cpu_node":
      return t.cpuNodeCores * t.memoryMbPerCoreUnit;
    case "whole_gpu_node":
      return t.gpuNodeGpus * t.memoryMbPerGpuUnit;
    case "core_or_memory": {
      const memory = own ?? (resources.cores ?? 0) * t.memoryMbPerCoreUnit;
      if (!Number.isSafeInteger(memory) || memory < 1) throw new RangeError("no memory to ask for");
      return memory;
    }
    case "gpu_or_memory": {
      const memory = own ?? (resources.gpus ?? 0) * t.memoryMbPerGpuUnit;
      if (!Number.isSafeInteger(memory) || memory < 1) throw new RangeError("no memory to ask for");
      return memory;
    }
  }
}

/** The hold for a job: what it would cost if it ran for every minute it asked for. */
export function estimateSuMilli(
  spec: ComputeResources & { partition: PartitionName; minutes: number },
): number {
  const minutes = wholeNumber("minutes", spec.minutes, 0);
  return suMilliFor(spec.partition, spec, Number(minutes * 60n));
}

const SU_DECIMAL_RE = /^([0-9]+)(?:\.([0-9]{1,3}))?$/;

/**
 * Parses an amount of SU written as a plain decimal into whole milli-SU: `12.5` is 12500. At most
 * three decimals, no sign, no exponent, no separators, no spaces; anything else, and anything too
 * large to hold exactly, is null.
 */
export function parseSuToMilli(text: string): number | null {
  if (typeof text !== "string") return null;
  const match = SU_DECIMAL_RE.exec(text);
  if (!match) return null;
  const milli = BigInt(match[1]) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0"));
  if (milli > BigInt(MAX_SAFE)) return null;
  return Number(milli);
}

/** The shortest exact decimal for whole milli-SU: 12500 is `12.5`, 12000 is `12`, -500 is `-0.5`. */
export function formatSu(milli: number): string {
  if (!Number.isSafeInteger(milli)) throw new RangeError("an amount is a whole number of milli-SU");
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const fraction = abs % 1000;
  const decimals = fraction === 0 ? "" : `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
  return `${milli < 0 ? "-" : ""}${whole}${decimals}`;
}

// --- Results and the launcher's world ----------------------------------------------------------

/**
 * The largest single result file, 5 GB, until presigned multipart `UploadPart` is verified on R2.
 * Decimal gigabytes, so it sits under the 5 GiB one presigned PUT accepts.
 */
export const RESULT_MAX_FILE_BYTES = 5_000_000_000;

/** The Tapis owner, and the pseudonymous gateway user, of every NEMAR pipeline job. */
export const PIPELINES_TAPIS_OWNER = "nemar-pipelines";

/** On the node, under Tapis's output directory: the container's one writable mount. */
export const LAUNCHER_WORK_DIR = "work";

/** Where the entry writes its results, inside the work directory. */
export const LAUNCHER_OUTPUTS_DIR = "work/outputs";

/** The directory the container never has mounted; only the launcher writes here. */
export const LAUNCHER_DIR = "launcher";

/** The four files of the launcher directory, and of `jobs/<id>/launcher/` in the results bucket. */
export const LAUNCHER_FILES = {
  result: "result.json",
  provenance: "provenance.json",
  manifest: "manifest.json",
  log: "launcher.log",
} as const;

/**
 * The records bucket keeps the launcher's `manifest.json` under this name,
 * `records/<id>/result-manifest.json`; phase A3 builds the key. In the results bucket and on the
 * node the file is still `manifest.json`.
 */
export const RECORDS_RESULT_MANIFEST_FILE = "result-manifest.json";

export const LAUNCHER_FILE_NAMES = [
  "result.json",
  "provenance.json",
  "manifest.json",
  "launcher.log",
] as const;

export type LauncherFileName = (typeof LAUNCHER_FILE_NAMES)[number];

/** The environment variables the launcher reads or sets. None is ever a job's own to set. */
export const LAUNCHER_ENV = {
  /**
   * The launch specification: its ASCII-only JSON text in base64url, no padding (A1c, #2043; see
   * `shared/contract/compute-launch.ts`, `encodeLaunchSpecEnv` and `decodeLaunchSpecEnv`).
   */
  SPEC: "NEMAR_LAUNCH_SPEC",
  /** Where the entry writes its outputs, set inside the container. */
  OUT: "NEMAR_OUT",
  /** An optional root of NEMAR's own copy of datasets on the node. */
  LOCAL_DATASETS_ROOT: "NEMAR_LOCAL_DATASETS_ROOT",
  /** An optional override of the host Python that runs the launcher. */
  HOST_PYTHON: "NEMAR_HOST_PYTHON",
  /**
   * The directory on the node that holds the Singularity image files, set by the Tapis application
   * definition. The launch specification's `image.sif` is a basename relative to it. REQUIRED: the
   * launcher has no fallback, and ends `image_missing` when it is unset.
   */
  SIF_ROOT: "NEMAR_SIF_ROOT",
} as const;

/**
 * The environment names a job may set: thread counts and determinism, never a path, a loader or
 * anything the launcher reads. The first release's list, chosen in phase A1 for the owner to
 * confirm; widening it changes `compute-launch.schema.json`, which `nemar-process` copies.
 */
export const JOB_ENV_ALLOWLIST = [
  "OMP_NUM_THREADS",
  "MKL_NUM_THREADS",
  "OPENBLAS_NUM_THREADS",
  "NUMEXPR_NUM_THREADS",
  "PYTHONHASHSEED",
  "MPLBACKEND",
] as const;

export type JobEnvName = (typeof JOB_ENV_ALLOWLIST)[number];

/** Printable ASCII, so a value cannot carry a newline or a control character into a script. */
const ENV_VALUE_RE = /^[ -~]*$/;

export const computeEnvValueSchema = z.string().max(256).regex(ENV_VALUE_RE);

/** The environment a job asks for: names from the allowlist only, each a short printable value. */
export const computeJobEnvSchema = z.record(z.enum(JOB_ENV_ALLOWLIST), computeEnvValueSchema);

// --- The job specification ---------------------------------------------------------------------

// --- What an entry, a command, args and an include pattern mean ---------------------------------

/**
 * How the launcher runs the code a job names. These four texts are the contract, stated once: zod
 * carries them as the `description` of the fields of both the job specification and the launch
 * specification, and `compute-launch.schema.json` carries the same words, which a test holds to
 * these. Widening any of them is a change to what the launcher does, and so to the shared schema.
 */
export const COMPUTE_ENTRY_DESCRIPTION =
  "A path inside the bundle. With runtime python the launcher runs python /code/<entry> followed by args; with runtime image and an entry it runs /code/<entry> directly, followed by args, which needs the executable bit that the bundle packer must preserve. The runtime image must provide python on its PATH for the python runtime. A bundle archive's member names may carry a leading ./; absolute names, .. segments, links, devices and FIFOs are refused by the launcher.";

export const COMPUTE_COMMAND_DESCRIPTION = "An argument vector, run as given, with args appended.";

export const COMPUTE_ARGS_DESCRIPTION =
  "Arguments, each as one argument: after python /code/<entry> (runtime python with an entry), after /code/<entry> (runtime image with an entry) or after the command.";

/**
 * The `include` dialect of a dataset reference. No cap on the number of wildcards: the bound is the
 * matcher's, which must not backtrack.
 */
export const COMPUTE_INCLUDE_DESCRIPTION =
  "Patterns that select the dataset's files, matched against manifest paths relative to the dataset root; every file when there are none. The dialect: **/ matches zero or more directories (so a/**/b matches a/b); ** elsewhere matches any run of characters including /; * and ? stay inside one path segment; [abc], [a-c] and [!abc] are character classes; a character class never matches /, so like * and ? it stays inside one path segment, and a negated class [!a] matches any single character except a and /; an unterminated [ is a literal [; an empty class [] and an inverted range such as [z-a] are refused, and bad_include is exactly the set of patterns this dialect refuses; matching is case-sensitive; there are no escapes. A matcher MUST run in time linear in the pattern's length times the path's length (no backtracking).";

/**
 * Why an `include` pattern is refused, or null if the dialect accepts it ({@link
 * COMPUTE_INCLUDE_DESCRIPTION}): `empty_class` for a `[` (or `[!`) with a `]` straight after it, and
 * `inverted_range` for a class holding a range whose end is before its start (`[z-a]`), compared by
 * code point. A `[` with no `]` after it is a literal. The first problem from the left is the one
 * named. This is exactly the set the launcher refuses as `bad_include`, so `JobSpecSchema` applies
 * it and a job with such a pattern is refused at submit. Pure.
 */
export function includePatternProblem(pattern: string): "empty_class" | "inverted_range" | null {
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] !== "[") {
      i++;
      continue;
    }
    const start = pattern[i + 1] === "!" ? i + 2 : i + 1;
    const end = pattern.indexOf("]", start);
    // Unterminated: a literal [, and so is any later one, since no ] follows any of them.
    if (end === -1) return null;
    if (end === start) return "empty_class";
    const body = Array.from(pattern.slice(start, end), (c) => c.codePointAt(0) as number);
    for (let p = 0; p < body.length; ) {
      if (p + 2 < body.length && body[p + 1] === 0x2d) {
        if (body[p] > body[p + 2]) return "inverted_range";
        p += 3;
      } else {
        p++;
      }
    }
    i = end + 1;
  }
  return null;
}

export const JOB_RUNTIMES = ["python", "matlab", "image"] as const;

export type JobRuntime = (typeof JOB_RUNTIMES)[number];

const JOB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const RECIPE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * An image pinned by digest: `[docker://]registry[:port]/path@sha256:<64 hex>`, lowercase. A tag
 * is not a pin, and the registry must also be one the owner's policy allows (a route's check).
 */
export const COMPUTE_IMAGE_REF_RE =
  /^(?:docker:\/\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;

/**
 * Whether `text` is well-formed UTF-16: every surrogate is half of a high-then-low pair. A lone
 * surrogate is a valid JavaScript string and a valid JSON escape (`\ud800`) but it is not text, and
 * no process argument can carry it. The same answer as `String.prototype.isWellFormed`, written as
 * a loop because that method is newer than the ES2022 this tree builds for.
 */
export function computeIsWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // NaN at the end, which is no low surrogate
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * A string that reaches the launch specification and from it a process: the entry, a command item,
 * an argument or an include pattern. It must be well-formed, so a job never fails after its hold
 * exists on text the node cannot pass on. An environment value needs no such check: it is printable
 * ASCII, which holds no surrogate.
 */
const processText = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine(computeIsWellFormed, {
    message: "a lone surrogate is not text a process argument can carry",
  });

/** A refinement for one include pattern: a pattern the dialect refuses is refused here, by its word. */
function refuseBadInclude(pattern: string, ctx: z.RefinementCtx): void {
  const problem = includePatternProblem(pattern);
  if (problem !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `an include pattern the dialect refuses: ${problem}`,
    });
  }
}

const bundleRefSchema = z.object({ size: safeInt(1), sha256: sha256Schema }).strict();

const datasetRefSchema = z
  .object({
    id: z.string().regex(COMPUTE_DATASET_ID_RE),
    version: z.string().regex(COMPUTE_DATASET_VERSION_RE),
    include: z
      .array(processText(computeGlobSchema).superRefine(refuseBadInclude))
      .max(64)
      .optional()
      .describe(COMPUTE_INCLUDE_DESCRIPTION),
  })
  .strict();

const argSchema = processText(z.string().max(1024));

/**
 * The bytes a string takes as a JSON string value in the launch specification, which is ASCII-only
 * JSON (see `encodeLaunchSpec`): its two quotes, two bytes for a quote, a backslash, \b, \t, \n,
 * \f or \r, six for any other control character and for every UTF-16 unit from U+007F up (a
 * character outside the Basic Multilingual Plane is two units, so twelve), one for the rest.
 */
export function launchStringBytes(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d)
      bytes += 2;
    else if (unit < 0x20 || unit >= 0x7f) bytes += 6;
    else bytes += 1;
  }
  return bytes;
}

/**
 * What the job's own variable-size fields take in the launch specification: the entry, the command,
 * the arguments, every dataset include pattern and the environment, each element counted with its
 * quotes and one separator. Everything else in the document is bounded by its own field cap and is
 * the fixed part: see {@link LAUNCH_VARIABLE_BYTES_MAX}.
 */
export function launchVariableBytes(spec: {
  entry?: string;
  command?: readonly string[];
  args?: readonly string[];
  datasets?: ReadonlyArray<{ include?: readonly string[] }>;
  env?: Readonly<Record<string, string | undefined>>;
}): number {
  let bytes = 0;
  if (spec.entry !== undefined) bytes += launchStringBytes(spec.entry) + 1;
  for (const part of spec.command ?? []) bytes += launchStringBytes(part) + 1;
  for (const arg of spec.args ?? []) bytes += launchStringBytes(arg) + 1;
  for (const dataset of spec.datasets ?? []) {
    for (const pattern of dataset.include ?? []) bytes += launchStringBytes(pattern) + 1;
  }
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    if (value !== undefined) bytes += launchStringBytes(name) + launchStringBytes(value) + 2;
  }
  return bytes;
}

/**
 * A valid job specification always fits the 64 KiB launch specification, by a bound inside
 * {@link JobSpecSchema} rather than by per-field caps: a non-ASCII character costs six bytes once
 * escaped, so no per-field cap that is generous for ASCII could also be safe for any mix. The
 * variable part may take 48 KiB; the rest of the document, at its own worst case (a 512-character
 * `api_base` and image reference, a 256-character token, the 68-character image file name, twenty
 * datasets of 64-character tags, the keys and brackets), is under 4 KiB, which `launchSpecFits`
 * and a test check; the bound leaves the rest of the 64 KiB as slack for a field that grows. This
 * is about size only: whether a dataset version has a tag is {@link datasetVersionWithoutTag}'s.
 */
export const LAUNCH_VARIABLE_BYTES_MAX = 49_152;

/**
 * One job as every front door states it and the record keeps it. Resources are per node. A script
 * or folder job names an `entry` and the bundle that holds it; an image job names a digest-pinned
 * `image` and a `command` (and may carry a bundle); a recipe job names a `recipe` and needs none
 * of those. Unknown keys are refused, so a typo is never silently dropped from the record.
 *
 * The output directory is `outputs`, which the launcher's layout fixes (`work/outputs/`). `matlab`
 * is a valid specification; a route refuses it as `runtime_unavailable` until it is licensed.
 *
 * How the code runs, which is the contract the launcher keeps (its texts are
 * {@link COMPUTE_ENTRY_DESCRIPTION}, {@link COMPUTE_COMMAND_DESCRIPTION} and
 * {@link COMPUTE_ARGS_DESCRIPTION}): `runtime: python` with an `entry` runs `python /code/<entry>`
 * followed by `args`; a `command` runs as given with `args` appended; `runtime: image` with an
 * `entry` is allowed and runs `/code/<entry>` directly, which needs the executable bit that the
 * bundle packer must preserve; the runtime image must provide `python` on its PATH for the python
 * runtime. A bundle archive's member names may carry a leading `./`; absolute names, `..`, links,
 * devices and FIFOs are refused by the launcher.
 *
 * A dataset's `include` patterns are matched against manifest paths relative to the dataset root
 * ({@link COMPUTE_INCLUDE_DESCRIPTION}): `**` followed by `/` matches zero or more directories; `**`
 * elsewhere matches any run of characters including `/`; `*` and `?` stay inside one path segment;
 * `[abc]`, `[a-c]` and `[!abc]` are classes; a character class never matches `/`, so like `*` and `?`
 * it stays inside one path segment, and a negated class `[!a]` matches any single character except
 * `a` and `/`; an unterminated `[` is a literal `[`; an empty class
 * `[]` and an inverted range such as `[z-a]` are refused (`includePatternProblem`, which this
 * schema applies, so the launcher's `bad_include` is exactly the set of patterns the dialect
 * refuses); matching is case-sensitive; there are no escapes; and a matcher must run in time linear
 * in the pattern length times the path length (no backtracking).
 * There is no cap on how many wildcards a pattern holds. A dataset's `version` is what a person
 * writes (`1.0.2`); the Worker writes the data-plane tag for the launch specification
 * (`dataTagForVersion`).
 *
 * A valid job specification always fits the 64 KiB launch specification (see
 * {@link LAUNCH_VARIABLE_BYTES_MAX}) and is well formed: every string that reaches a process is
 * well-formed UTF-16 (see {@link computeIsWellFormed}), each refused here, with the field named by
 * its path, rather than after the hold exists; the dataset version tag is the one launch rule
 * JobSpecSchema does not enforce: a version such as `1.0`, `abc`, `V1.0.2` or `2.0.0-rc.1` is valid
 * for a job and has no data-plane tag, so the Worker and the CLI must run `launchSpecFits` (and
 * refuse with `invalid_spec`, naming the field {@link datasetVersionWithoutTag} finds) BEFORE the
 * hold.
 *
 * Two digests are named apart. `spec_digest` is the JOB ROW's digest of this document: the SHA-256,
 * in lowercase hex, of the exact bytes of `records/<id>/spec.json` (set by phase A3). It is not a
 * launcher key. The launcher's own is `launch_spec_digest` in `provenance.json` (see
 * {@link LauncherProvenanceSchema}).
 */
export const JobSpecSchema = z
  .object({
    name: z.string().regex(JOB_NAME_RE),
    runtime: z.enum(JOB_RUNTIMES),
    entry: processText(relativePath(240)).optional().describe(COMPUTE_ENTRY_DESCRIPTION),
    command: z
      .array(processText(z.string().min(1).max(1024)))
      .min(1)
      .max(64)
      .optional()
      .describe(COMPUTE_COMMAND_DESCRIPTION),
    args: z.array(argSchema).max(64).default([]).describe(COMPUTE_ARGS_DESCRIPTION),
    bundle: bundleRefSchema.optional(),
    datasets: z.array(datasetRefSchema).max(20).default([]),
    partition: z.enum(PARTITION_NAMES),
    nodes: safeInt(1, 64).default(1),
    cores: safeInt(1, 256).default(1),
    memory_mb: safeInt(1, 16_777_216).optional(),
    gpus: safeInt(0, 8).default(0),
    minutes: safeInt(1, 10080),
    output_dir: z.literal("outputs").default("outputs"),
    env: computeJobEnvSchema.default({}),
    recipe: z.string().regex(RECIPE_NAME_RE).optional(),
    image: z.string().max(512).regex(COMPUTE_IMAGE_REF_RE).optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const refuse = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (spec.entry !== undefined && spec.command !== undefined) {
      refuse("command", "an entry and a command are one or the other");
    }
    if (spec.runtime === "image" && spec.image === undefined) {
      refuse("image", "an image job names a digest-pinned image");
    }
    if (spec.runtime !== "image" && spec.image !== undefined) {
      refuse("image", "only an image job names an image");
    }
    if (spec.recipe === undefined && spec.entry === undefined && spec.command === undefined) {
      refuse("entry", "a job with no recipe names an entry or a command");
    }
    if (spec.entry !== undefined && spec.bundle === undefined) {
      refuse("bundle", "an entry needs the bundle that holds it");
    }
    if (launchVariableBytes(spec) > LAUNCH_VARIABLE_BYTES_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "the entry, command, arguments, patterns and environment are too large to launch",
      });
    }
    const pool = PARTITIONS[spec.partition].pool;
    if (pool === "gpu" && spec.gpus < 1) refuse("gpus", "a GPU partition needs at least one GPU");
    if (pool === "cpu" && spec.gpus !== 0) refuse("gpus", "a CPU partition takes no GPU");
  });

export type JobSpec = z.infer<typeof JobSpecSchema>;

// --- The owner policy --------------------------------------------------------------------------

const CLIENT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A registry host with an optional port and path, lowercase, no scheme: `ghcr.io/team`. */
const REGISTRY_RE =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

const ceilingsShape = Object.fromEntries(
  PARTITION_NAMES.map((name) => [name, ComputeCeilingSchema.optional()]),
) as { [K in PartitionName]: z.ZodOptional<typeof ComputeCeilingSchema> };

/** A partner client's own caps, whole numbers. Epic B registers the client; the owner sets these. */
export const ComputeClientCapsSchema = z
  .object({ maxOpenReservations: safeInt(0, 100_000), maxReservedMilliPerDay: safeInt(0) })
  .strict();

/**
 * NEMAR's tenant-wide ceiling on live jobs and the floors it keeps for each class of occupant (issue
 * #2121, phase P2). `maxLiveJobs` is the most jobs NEMAR holds on the cluster account at once, below the
 * account's own slots so there is headroom for occupants NEMAR cannot see yet; 0 admits nothing. A floor
 * is a number of slots kept for a class that no other class may use, so the three must fit under the
 * ceiling. The classes are people (`cli` and `web`), pipelines (`pipeline`) and partner (`partner`).
 */
export const ComputeTenantPolicySchema = z
  .object({
    maxLiveJobs: safeInt(0, 1000),
    reserved: z
      .object({
        people: safeInt(0, 1000),
        pipelines: safeInt(0, 1000),
        partner: safeInt(0, 1000),
      })
      .strict(),
  })
  .strict()
  .refine((t) => t.reserved.people + t.reserved.pipelines + t.reserved.partner <= t.maxLiveJobs, {
    message: "the floors reserved for the classes add up to more than the ceiling",
    path: ["reserved"],
  });

export type ComputeTenantPolicy = z.infer<typeof ComputeTenantPolicySchema>;

/**
 * What the owner lets runners hold at once (portable compute, ADR 0121 decision 6): the most live
 * `accounting = 'none'` runner jobs of each pool. Not exported as a schema, only through
 * {@link ComputePolicy}: an absent key reads {@link RUNNERS_POLICY_DEFAULT}, never "unlimited".
 */
const ComputeRunnersPolicySchema = z
  .object({ maxLiveJobs: z.object({ cpu: safeInt(0, 1000), gpu: safeInt(0, 1000) }).strict() })
  .strict();

export type ComputeRunnersPolicy = z.infer<typeof ComputeRunnersPolicySchema>;

/**
 * Everything the owner sets without a deploy, validated strictly on every write
 * (`nemar admin compute policy set`, owner only, audited). A partition that has a ceiling here is
 * offered to people; one without is for NEMAR's pipelines only. Grants and caps are whole numbers
 * of milli-SU, bytes, jobs, days or minutes.
 */
export const ComputePolicySchema = z
  .object({
    /** What approval opens, per pool, and whether and how often it renews. */
    defaultGrantMilli: z.object({ cpu: safeInt(0), gpu: safeInt(0) }).strict(),
    renewal: z
      .object({ enabled: z.boolean(), everyDays: safeInt(1, 366).nullable() })
      .strict()
      .refine((r) => !r.enabled || r.everyDays !== null, {
        message: "renewal that is on says how often",
        path: ["everyDays"],
      }),
    ceilings: z.object(ceilingsShape).strict(),
    /** Running and queued jobs one person may have at once. */
    maxLiveJobsPerPerson: safeInt(0, 1000),
    /** NEMAR's own pipelines: jobs a day, and the share of Expanse's concurrency they may hold. */
    pipelines: z
      .object({
        dailyJobCap: safeInt(0, 100_000),
        maxLiveJobs: z.object({ cpu: safeInt(0, 1000), gpu: safeInt(0, 1000) }).strict(),
      })
      .strict(),
    clients: z.record(z.string().regex(CLIENT_ID_RE), ComputeClientCapsSchema),
    /**
     * The tenant-wide ceiling and floors (phase P2 of #2121). OPTIONAL so a stored policy without it
     * still parses; a missing key is never "unlimited": see {@link tenantPolicyOf}.
     */
    tenant: ComputeTenantPolicySchema.optional(),
    /**
     * The runners' live cap per pool (ADR 0121). OPTIONAL like `tenant`, so a stored policy without it
     * still parses; see {@link runnersPolicyOf}. A Worker from before ADR 0121 reads a stored policy that
     * has this key as unreadable (the schema is strict), which is the rollback hazard the ADR names.
     */
    runners: ComputeRunnersPolicySchema.optional(),
    /** Minutes a reservation may wait for its Tapis job before NEMAR searches and releases. */
    reservationWaitMinutes: safeInt(1, 1440),
    retention: z
      .object({
        recordsYears: safeInt(1, 30),
        logsDays: safeInt(1, 3650),
        /** Design section 1: results are "kept 30 days and never fewer than 14". */
        resultsDays: safeInt(14, 365),
      })
      .strict(),
    resultLimits: z
      .object({
        maxJobBytes: safeInt(1),
        maxFiles: safeInt(1, COMPUTE_MAX_OUTPUT_FILES),
        maxStoredBytesPerPerson: safeInt(1),
        maxStoredBytesTotal: safeInt(1),
      })
      .strict(),
    /** A final charge within this of the provisional one is routine; a larger one is reported. */
    settle: z.object({ toleranceMilli: safeInt(0), tolerancePercent: safeInt(0, 100) }).strict(),
    /** Registries a container image may come from. */
    registries: z.array(z.string().max(255).regex(REGISTRY_RE)).max(64),
    bundleLimits: z
      .object({
        maxTotalBytes: safeInt(1),
        maxFiles: safeInt(1, 100_000),
        maxFileBytes: safeInt(1),
      })
      .strict(),
  })
  .strict();

export type ComputePolicy = z.infer<typeof ComputePolicySchema>;

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * The tenant ceiling and floors in force when a stored policy has no `tenant` key, and the value the
 * shipped default carries. Declared once: `DEFAULT_COMPUTE_POLICY.tenant` is this object, so the two
 * cannot differ. The ceiling of 20 sits below the cluster account's own limit, which leaves headroom for
 * occupants NEMAR cannot see yet; the floors keep 8 slots for people and 2 for the pipelines, and none for
 * the partner.
 */
export const TENANT_POLICY_DEFAULT: ComputeTenantPolicy = deepFreeze({
  maxLiveJobs: 20,
  reserved: { people: 8, pipelines: 2, partner: 0 },
});

/** The policy's tenant ceiling, or the default when a stored policy predates the key: never unlimited. */
export const tenantPolicyOf = (policy: ComputePolicy): ComputeTenantPolicy =>
  policy.tenant ?? TENANT_POLICY_DEFAULT;

/** The runners' live cap in force when a stored policy has no `runners` key: 64 on the CPU pool, 8 on the GPU pool. */
export const RUNNERS_POLICY_DEFAULT: ComputeRunnersPolicy = deepFreeze({
  maxLiveJobs: { cpu: 64, gpu: 8 },
});

/** The policy's runners cap, or the default when a stored policy predates the key: never unlimited. */
export const runnersPolicyOf = (policy: ComputePolicy): ComputeRunnersPolicy =>
  policy.runners ?? RUNNERS_POLICY_DEFAULT;

/**
 * The policy in force when no version has been set. Closed by default: no grant, no registry, no
 * partner client, renewal off, and small caps. The values the design and the phase issue fix are
 * 0 grants, 30 minutes, 7 years, 365 days, 30 days and the result limits; the rest (live jobs,
 * pipeline caps, settle tolerance, bundle limits) are initial values the owner adjusts.
 */
export const DEFAULT_COMPUTE_POLICY: ComputePolicy = deepFreeze({
  defaultGrantMilli: { cpu: 0, gpu: 0 },
  renewal: { enabled: false, everyDays: null },
  ceilings: Object.fromEntries(
    PARTITION_NAMES.flatMap((name) => {
      const ceiling = PARTITIONS[name].ceiling;
      return ceiling ? [[name, { ...ceiling }]] : [];
    }),
  ) as ComputePolicy["ceilings"],
  maxLiveJobsPerPerson: 4,
  pipelines: { dailyJobCap: 50, maxLiveJobs: { cpu: 8, gpu: 4 } },
  clients: {},
  tenant: TENANT_POLICY_DEFAULT,
  reservationWaitMinutes: 30,
  retention: { recordsYears: 7, logsDays: 365, resultsDays: 30 },
  resultLimits: {
    maxJobBytes: 20 * GIB,
    maxFiles: 5000,
    maxStoredBytesPerPerson: 50 * GIB,
    maxStoredBytesTotal: 1024 * GIB,
  },
  settle: { toleranceMilli: 1000, tolerancePercent: 5 },
  registries: [],
  bundleLimits: { maxTotalBytes: 100 * MIB, maxFiles: 2000, maxFileBytes: 25 * MIB },
});

// --- The launcher's own documents --------------------------------------------------------------

const manifestFileSchema = z
  .object({ path: relativePath(512), size: safeInt(0), sha256: sha256Schema })
  .strict();

/** `launcher/manifest.json`: every output's path, size and checksum, hashed by the launcher. */
export const ResultManifestSchema = z
  .object({
    job_id: jobIdSchema,
    files: z.array(manifestFileSchema).max(COMPUTE_MAX_OUTPUT_FILES),
  })
  .strict();

const entryExitCodeSchema = z.number().int().min(-255).max(255).nullable();

/**
 * `launcher/result.json`: the one fixed failure code (or null), the exit number the launcher ends
 * with, and the entry's own exit code. The exit number is 0 for no failure and otherwise the one
 * `launcherExitNumber` gives that code, so the two cannot disagree.
 */
export const LauncherResultSchema = z
  .object({
    job_id: jobIdSchema,
    failure_code: z.enum(LAUNCHER_FAILURE_CODES).nullable(),
    detail: z.string().regex(COMPUTE_WORD_RE).nullable(),
    exit_number: z.number().int(),
    entry_exit_code: entryExitCodeSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    const expected =
      result.failure_code === null ? LAUNCHER_EXIT_OK : launcherExitNumber(result.failure_code);
    if (result.exit_number !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exit_number"],
        message: "the exit number is the one the failure code gives",
      });
    }
  });

const stagingRecordSchema = z
  .object({
    id: z.string().regex(COMPUTE_DATASET_ID_RE),
    version: z.string().regex(COMPUTE_DATASET_VERSION_RE),
    mode: z.enum(["bind", "download"]),
    files: safeInt(0),
    bytes: safeInt(0),
  })
  .strict();

/**
 * `launcher/provenance.json`, written from outside the container: what ran and how. Nothing the
 * container wrote is in it.
 *
 * `launch_spec_digest` is the SHA-256, in lowercase hex, of the exact bytes of the launch
 * specification's JSON TEXT: what the `NEMAR_LAUNCH_SPEC` environment value (base64url, see
 * `decodeLaunchSpecEnv`) decodes to, hashed by the launcher BEFORE it parses it. It is never the digest
 * of the encoded value (A1c, #2043). It is the launcher's digest and phase A5 stores it on the job row.
 * It is not the job row's `spec_digest`, which is the digest of `records/<id>/spec.json` (see
 * {@link JobSpecSchema}).
 */
export const LauncherProvenanceSchema = z
  .object({
    job_id: jobIdSchema,
    launch_spec_digest: sha256Schema,
    bundle_digest: sha256Schema.nullable(),
    image: z
      .object({
        uri: z.string().regex(/^[^\s]{1,512}$/),
        digest: z.string().regex(COMPUTE_IMAGE_DIGEST_RE),
      })
      .strict(),
    runtime_version: z.string().regex(new RegExp(`^[^${CONTROL_CHARS}]{1,128}$`)),
    staging: z.array(stagingRecordSchema).max(20),
    /** Seconds per phase, keyed by a fixed word such as `code_fetch`, `staging`, `run`, `upload`. */
    timings: z
      .record(z.string().regex(COMPUTE_WORD_RE), z.number().finite().min(0))
      .refine((t) => Object.keys(t).length <= 16, { message: "at most 16 phases" }),
    slurm_job_id: z
      .string()
      .regex(/^[0-9A-Za-z_+.-]{1,64}$/)
      .nullable(),
    entry_exit_code: entryExitCodeSchema,
  })
  .strict();
