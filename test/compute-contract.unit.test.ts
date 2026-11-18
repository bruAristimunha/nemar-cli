/**
 * The compute contract (epic #2005, phase A1 #2006; ADR 0118): the job specification, the
 * partition and rate tables, the owner policy, the launcher's file shapes, and the launch
 * specification with its JSON Schema.
 *
 * Money is integer thousandths of an Expanse service unit (SU) everywhere, so the arithmetic below
 * is asserted on whole numbers, and each rule the issue names (the 128, the minimum, the round-up,
 * the 800) has a case that fails if that one number changes.
 *
 * The JSON Schema `shared/contract/compute-launch.schema.json` is shared byte for byte with
 * `nemarOrg/nemar-process`, so it is held to the zod schema two ways: structurally (its keys,
 * required lists and enumerations are read back against the constants they mirror) and by a
 * differential corpus (every document is judged by Ajv and by zod, each with its expected verdict
 * written beside it, so two schemas that agree on a wrong answer still fail).
 *
 * Nothing here has been recorded from a real tenant: the rate table, the `debug` ceilings and the
 * preempt basis are the design's, unconfirmed with SDSC (design section 12, question 5).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import type { z } from "zod";
import { LAUNCHER_FAILURE_CODES } from "../shared/compute-state";
import {
  COMPUTE_ARGS_DESCRIPTION,
  COMPUTE_COMMAND_DESCRIPTION,
  COMPUTE_DATASET_VERSION_RE,
  COMPUTE_DATA_TAG_MAX,
  COMPUTE_DATA_TAG_RE,
  COMPUTE_ENTRY_DESCRIPTION,
  COMPUTE_INCLUDE_DESCRIPTION,
  COMPUTE_JOB_ID_RE,
  COMPUTE_MAX_OUTPUT_FILES,
  COMPUTE_PATH_SEGMENT,
  COMPUTE_POOLS,
  ComputeCeilingSchema,
  ComputeClientCapsSchema,
  ComputePolicySchema,
  DEFAULT_COMPUTE_POLICY,
  JOB_ENV_ALLOWLIST,
  JOB_RUNTIMES,
  type JobSpec,
  JobSpecSchema,
  LAUNCHER_DIR,
  LAUNCHER_ENV,
  LAUNCHER_FILES,
  LAUNCHER_FILE_NAMES,
  LAUNCHER_OUTPUTS_DIR,
  LAUNCHER_WORK_DIR,
  LAUNCH_VARIABLE_BYTES_MAX,
  LauncherProvenanceSchema,
  LauncherResultSchema,
  PARTITIONS,
  PARTITION_NAMES,
  PIPELINES_TAPIS_OWNER,
  type PartitionName,
  RATE_TABLE_V1,
  RECORDS_RESULT_MANIFEST_FILE,
  RESULT_MAX_FILE_BYTES,
  ResultManifestSchema,
  computeIsWellFormed,
  dataTagForVersion,
  datasetVersionWithoutTag,
  estimateSuMilli,
  formatSu,
  includePatternProblem,
  isSafeComputePath,
  launchStringBytes,
  launchVariableBytes,
  parseSuToMilli,
  suMilliFor,
  submitMemoryMb,
} from "../shared/contract/compute";
import {
  BundleResponseSchema,
  LAUNCH_RUNTIMES,
  LAUNCH_SPEC_ENV_MAX_CHARS,
  LAUNCH_SPEC_ENV_REFUSALS,
  LAUNCH_SPEC_MAX_BYTES,
  LAUNCH_SPEC_VERSION,
  LaunchSpecSchema,
  OutputsRequestSchema,
  OutputsResponseSchema,
  SHELL_INERT_ENV_ALPHABET,
  decodeLaunchSpecEnv,
  encodeLaunchSpec,
  encodeLaunchSpecEnv,
  isShellInertEnvValue,
  launchSpecFits,
  resultsLauncherKey,
  resultsOutputKey,
  sifFileNameForDigest,
} from "../shared/contract/compute-launch";
import launchSchema from "../shared/contract/compute-launch.schema.json";
import * as contractIndex from "../shared/contract/index";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const JOB_ID = "job_0123456789abcdef01234567";

// --- Money -------------------------------------------------------------------------------------

describe("the rate table", () => {
  test("the constants the design names are pinned", () => {
    // A change to any of these is a change to what NEMAR charges; it fails here first.
    expect(RATE_TABLE_V1).toEqual({
      version: 1,
      milliPerSu: 1000,
      cpuNodeCores: 128,
      gpuNodeGpus: 4,
      memoryMbPerCoreUnit: 2048,
      memoryMbPerGpuUnit: 94208,
      preemptNumerator: 800,
      preemptDenominator: 1000,
      minChargeMilli: 1000,
    });
  });

  test("nine partitions, in two pools", () => {
    expect([...PARTITION_NAMES].sort() as string[]).toEqual(
      [
        "shared",
        "compute",
        "debug",
        "large-shared",
        "preempt",
        "gpu-shared",
        "gpu",
        "gpu-debug",
        "gpu-preempt",
      ].sort(),
    );
    expect([...COMPUTE_POOLS]).toEqual(["cpu", "gpu"]);
    const cpu = PARTITION_NAMES.filter((p) => PARTITIONS[p].pool === "cpu").sort();
    const gpu = PARTITION_NAMES.filter((p) => PARTITIONS[p].pool === "gpu").sort();
    expect(cpu).toEqual(["compute", "debug", "large-shared", "preempt", "shared"]);
    expect(gpu).toEqual(["gpu", "gpu-debug", "gpu-preempt", "gpu-shared"]);
  });
});

describe("estimateSuMilli and suMilliFor", () => {
  test("one whole compute node for an hour is 128000", () => {
    expect(estimateSuMilli({ partition: "compute", nodes: 1, minutes: 60 })).toBe(128000);
    expect(suMilliFor("compute", { nodes: 1 }, 3600)).toBe(128000);
  });

  test("whole nodes multiply, and cores and memory do not matter on a whole-node partition", () => {
    expect(suMilliFor("compute", { nodes: 2 }, 3600)).toBe(256000);
    expect(suMilliFor("compute", { nodes: 1, cores: 1, memory_mb: 1 }, 3600)).toBe(128000);
  });

  test("a 30-second shared job is the 1000 minimum", () => {
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 30)).toBe(1000);
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 1)).toBe(1000);
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 0)).toBe(1000);
  });

  test("a job that costs more than the minimum is not raised to it", () => {
    expect(suMilliFor("shared", { nodes: 1, cores: 64 }, 3600)).toBe(64000);
    expect(estimateSuMilli({ partition: "shared", nodes: 1, cores: 8, minutes: 120 })).toBe(16000);
  });

  test("a charge rounds up to the next thousandth", () => {
    // 1000 milli-SU an hour for 3601 seconds is 1000.277...: the next whole thousandth is 1001.
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 3600)).toBe(1000);
    expect(suMilliFor("shared", { nodes: 1, cores: 1 }, 3601)).toBe(1001);
    // 8000 milli-SU an hour for 1 second over an hour: 8002.22 rounds to 8003.
    expect(suMilliFor("shared", { nodes: 1, cores: 8 }, 3601)).toBe(8003);
  });

  test("a gpu node for 2 hours is 8000, whatever GPUs were asked for", () => {
    expect(estimateSuMilli({ partition: "gpu", nodes: 1, gpus: 4, minutes: 120 })).toBe(8000);
    expect(estimateSuMilli({ partition: "gpu", nodes: 1, gpus: 1, minutes: 120 })).toBe(8000);
  });

  test("shared takes the larger of cores and memory over 2 GB", () => {
    // 1 core with 16 GB: memory is 8 core-units, so 8000 an hour, not 1000.
    expect(suMilliFor("shared", { nodes: 1, cores: 1, memory_mb: 16384 }, 3600)).toBe(8000);
    // 8 cores with 8 GB: cores win.
    expect(suMilliFor("shared", { nodes: 1, cores: 8, memory_mb: 8192 }, 3600)).toBe(8000);
    // A memory request that is not a whole unit rounds the unit up: 2049 MB is 2 units.
    expect(suMilliFor("shared", { nodes: 1, cores: 1, memory_mb: 2049 }, 3600)).toBe(1001);
    expect(suMilliFor("shared", { nodes: 1, cores: 1, memory_mb: 2048 }, 3600)).toBe(1000);
  });

  test("debug and large-shared use the shared formula", () => {
    for (const p of ["debug", "large-shared"] as const) {
      expect(suMilliFor(p, { nodes: 1, cores: 8 }, 3600), p).toBe(8000);
      expect(suMilliFor(p, { nodes: 1, cores: 1, memory_mb: 16384 }, 3600), p).toBe(8000);
    }
  });

  test("gpu-shared takes the larger of GPUs and memory over 92 GB", () => {
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 1 }, 3600)).toBe(1000);
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 3 }, 3600)).toBe(3000);
    // 184 GB is two 92 GB units, so two GPUs' worth for one GPU.
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 1, memory_mb: 188416 }, 3600)).toBe(2000);
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 1, memory_mb: 94209 }, 3600)).toBe(1001);
    expect(suMilliFor("gpu-debug", { nodes: 1, gpus: 2 }, 1800)).toBe(1000);
  });

  test("per-node rates multiply by nodes", () => {
    expect(suMilliFor("shared", { nodes: 2, cores: 4 }, 3600)).toBe(8000);
    expect(suMilliFor("gpu-shared", { nodes: 2, gpus: 2 }, 3600)).toBe(4000);
  });

  test("preempt partitions multiply the final amount by 0.8 once", () => {
    expect(suMilliFor("preempt", { nodes: 1, cores: 100 }, 3600)).toBe(80000);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 4 }, 3600)).toBe(3200);
    // Not 0.64: applied once, not in the rate and again in the amount.
    expect(suMilliFor("preempt", { nodes: 1, cores: 128 }, 3600)).toBe(102400);
  });

  test("a preempt charge is rounded up once, not once for the base and again for the 0.8", () => {
    // 1 core for 4504 s: 1251.11 milli-SU, times 0.8 is 1000.89, which rounds up to 1001.
    // Rounding the base first (1252) and then the 0.8 (1001.6) would give 1002.
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4504)).toBe(1001);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4508)).toBe(1002);
  });

  test("a preempt charge still never falls under the 1000 minimum", () => {
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 60)).toBe(1000);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 1)).toBe(1000);
  });

  test("estimateSuMilli is suMilliFor over the requested minutes", () => {
    const spec = { partition: "gpu-shared", nodes: 1, gpus: 2, minutes: 90 } as const;
    expect(estimateSuMilli(spec)).toBe(suMilliFor("gpu-shared", spec, 90 * 60));
    expect(estimateSuMilli(spec)).toBe(3000);
  });

  test("a whole compute pass: 2 whole nodes for the 48-hour ceiling", () => {
    expect(estimateSuMilli({ partition: "compute", nodes: 2, minutes: 2880 })).toBe(12_288_000);
  });

  test("the answer is always a safe integer", () => {
    const v = suMilliFor("compute", { nodes: 64 }, 7 * 24 * 3600);
    expect(Number.isSafeInteger(v)).toBe(true);
    expect(v).toBe(64 * 128000 * 7 * 24);
  });

  test("an amount too large to hold exactly is refused, not rounded by a double", () => {
    // 2^40 nodes for 2^30 seconds is far past 2^53 milli-SU.
    expect(() => suMilliFor("compute", { nodes: 2 ** 40 }, 2 ** 30)).toThrow(RangeError);
  });

  test("an input that is not a whole count is refused, not rounded", () => {
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1 }, -1)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1 }, 1.5)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1 }, Number.NaN)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 0, cores: 1 }, 10)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 1.5 }, 10)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: -1 }, 10)).toThrow(RangeError);
    expect(() => suMilliFor("gpu", { nodes: 1, gpus: 0.5 }, 10)).toThrow(RangeError);
    expect(() =>
      suMilliFor("shared", { nodes: 1, memory_mb: Number.POSITIVE_INFINITY }, 10),
    ).toThrow(RangeError);
    expect(() => suMilliFor("nonsense" as "shared", { nodes: 1, cores: 1 }, 10)).toThrow(
      RangeError,
    );
  });
});

describe("submitMemoryMb: the memory a submit must ask for is the memory the charge pays for", () => {
  test("a whole compute node is 128 core-units of 2048 MB, and a whole gpu node 4 GPU-units of 94208 MB, whatever the row says", () => {
    expect(submitMemoryMb("compute", {})).toBe(262144);
    expect(submitMemoryMb("compute", { cores: 1, memory_mb: 1 })).toBe(262144);
    expect(submitMemoryMb("gpu", {})).toBe(376832);
    expect(submitMemoryMb("gpu", { gpus: 1, memory_mb: 5 })).toBe(376832);
  });

  test("a per-core partition asks for the job's own memory, else its cores' share", () => {
    for (const partition of ["shared", "debug", "large-shared", "preempt"] as const) {
      expect(submitMemoryMb(partition, { cores: 4 })).toBe(8192);
      expect(submitMemoryMb(partition, { cores: 4, memory_mb: null })).toBe(8192);
      expect(submitMemoryMb(partition, { cores: 4, memory_mb: 20000 })).toBe(20000);
      expect(submitMemoryMb(partition, { memory_mb: 512 })).toBe(512);
    }
  });

  test("a per-GPU partition asks for the job's own memory, else its GPUs' share", () => {
    for (const partition of ["gpu-shared", "gpu-debug", "gpu-preempt"] as const) {
      expect(submitMemoryMb(partition, { gpus: 2 })).toBe(188416);
      expect(submitMemoryMb(partition, { gpus: 2, memory_mb: 30000 })).toBe(30000);
    }
  });

  test("nothing to ask for, or a partition that is not one, is a RangeError", () => {
    expect(() => submitMemoryMb("shared", {})).toThrow(RangeError);
    expect(() => submitMemoryMb("shared", { cores: 0 })).toThrow(RangeError);
    expect(() => submitMemoryMb("gpu-shared", { gpus: 0 })).toThrow(RangeError);
    expect(() => submitMemoryMb("toString" as never, { cores: 1 })).toThrow(RangeError);
  });

  test("it never asks for less than the rate table's own figure, on every partition", () => {
    // The memory the charge pays for per node: priced back through the rate, it is the same charge.
    expect(
      suMilliFor("shared", { nodes: 1, memory_mb: submitMemoryMb("shared", { cores: 4 }) }, 3600),
    ).toBe(4000);
    expect(
      suMilliFor(
        "gpu-shared",
        { nodes: 1, memory_mb: submitMemoryMb("gpu-shared", { gpus: 2 }) },
        3600,
      ),
    ).toBe(2000);
  });
});

describe("preempt rounding: one exact round-up, then the minimum", () => {
  test("4501, 9001 and 13501 seconds on one preempt core", () => {
    // 1000 milli-SU an hour times 0.8: 4501 s is 1000.2222..., 9001 s is 2000.2222..., 13501 s is
    // 3000.2222.... Each rounds UP to 1001, 2001, 3001. Rounding the base first (1251) and then
    // truncating the 0.8 gives 1000 for the first: the mutant this case exists to catch.
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4501)).toBe(1001);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 9001)).toBe(2001);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 13501)).toBe(3001);
  });

  test("the same on one GPU of gpu-preempt", () => {
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 4501)).toBe(1001);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 9001)).toBe(2001);
    expect(suMilliFor("gpu-preempt", { nodes: 1, gpus: 1 }, 13501)).toBe(3001);
    expect(suMilliFor("gpu-preempt", { nodes: 2, gpus: 2 }, 4501)).toBe(
      suMilliFor("preempt", { nodes: 2, cores: 2 }, 4501),
    );
  });

  test("the minimum is applied after the factor: a short preempt job costs 1000, not 800", () => {
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 3600)).toBe(1000);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 1)).toBe(1000);
    // 3600 s at 800/1000 of 1000 is exactly 800, under the minimum; 4500 s is exactly 1000.
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4500)).toBe(1000);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4499)).toBe(1000);
    expect(suMilliFor("preempt", { nodes: 1, cores: 1 }, 4502)).toBe(1001);
  });

  /** ceil(rate * seconds * num / (3600 * den)), then the 1000 floor, by long division. */
  function exact(ratePerHour: number, seconds: number, num: number, den: number): number {
    const n = BigInt(ratePerHour) * BigInt(seconds) * BigInt(num);
    const d = 3600n * BigInt(den);
    const q = n / d;
    const amount = n % d === 0n ? q : q + 1n;
    return Number(amount < 1000n ? 1000n : amount);
  }

  test("every second from 0 to 20000, against an exact rational computed separately", () => {
    for (const [partition, resources, rate] of [
      ["preempt", { nodes: 1, cores: 1 }, 1000],
      ["preempt", { nodes: 1, cores: 3 }, 3000],
      ["preempt", { nodes: 2, cores: 7 }, 14000],
      ["gpu-preempt", { nodes: 1, gpus: 1 }, 1000],
      ["gpu-preempt", { nodes: 2, gpus: 3 }, 6000],
    ] as const) {
      for (let s = 0; s <= 20000; s++) {
        const got = suMilliFor(partition, resources, s);
        const want = exact(rate, s, 800, 1000);
        if (got !== want)
          throw new Error(`${partition} ${JSON.stringify(resources)} ${s}s: ${got} !== ${want}`);
      }
    }
  });

  test("a non-preempt partition is the same loop with the factor 1", () => {
    for (let s = 0; s <= 8000; s += 7) {
      expect(suMilliFor("shared", { nodes: 1, cores: 5 }, s), String(s)).toBe(exact(5000, s, 1, 1));
    }
  });
});

describe("a rate needs something to charge", () => {
  test("a per-core partition with neither cores nor memory is refused, not priced at the minimum", () => {
    expect(() => suMilliFor("shared", { nodes: 1 }, 7200)).toThrow(RangeError);
    expect(() => suMilliFor("shared", { nodes: 1, cores: 0, memory_mb: 0 }, 7200)).toThrow(
      RangeError,
    );
    expect(() => suMilliFor("debug", { nodes: 1 }, 600)).toThrow(RangeError);
    expect(() => suMilliFor("large-shared", { nodes: 1 }, 600)).toThrow(RangeError);
    expect(() => suMilliFor("preempt", { nodes: 1 }, 600)).toThrow(RangeError);
  });

  test("a per-GPU partition with neither GPUs nor memory is refused", () => {
    expect(() => estimateSuMilli({ partition: "gpu-shared", nodes: 1, minutes: 2880 })).toThrow(
      RangeError,
    );
    expect(() => suMilliFor("gpu-debug", { nodes: 1, gpus: 0, memory_mb: 0 }, 60)).toThrow(
      RangeError,
    );
    expect(() => suMilliFor("gpu-preempt", { nodes: 1 }, 60)).toThrow(RangeError);
  });

  test("either driver alone is enough", () => {
    expect(suMilliFor("shared", { nodes: 1, memory_mb: 4096 }, 3600)).toBe(2000);
    expect(suMilliFor("shared", { nodes: 1, cores: 2 }, 3600)).toBe(2000);
    expect(suMilliFor("gpu-shared", { nodes: 1, memory_mb: 94208 }, 3600)).toBe(1000);
    expect(suMilliFor("gpu-shared", { nodes: 1, gpus: 2 }, 3600)).toBe(2000);
  });

  test("a whole-node partition needs no driver, because the node is the charge", () => {
    expect(suMilliFor("compute", { nodes: 1 }, 3600)).toBe(128000);
    expect(suMilliFor("gpu", { nodes: 1 }, 3600)).toBe(4000);
  });
});

describe("a partition name is an own key, not anything on Object.prototype", () => {
  test("suMilliFor refuses a name that is not a partition, including inherited ones", () => {
    for (const name of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf", ""]) {
      expect(() => suMilliFor(name as never, { nodes: 1, cores: 1 }, 10), name).toThrow(RangeError);
    }
    expect(() =>
      estimateSuMilli({ partition: "toString" as never, nodes: 1, cores: 1, minutes: 1 }),
    ).toThrow(RangeError);
  });
});

describe("parseSuToMilli and formatSu", () => {
  test("a value that is not text is refused, not coerced", () => {
    // A number 12 would match the pattern as the string "12" if it were not guarded.
    for (const value of [12, 12.5, 0, null, undefined, {}, [], ["12"], true]) {
      expect(parseSuToMilli(value as never), String(value)).toBeNull();
    }
  });

  test("12.5 SU is 12500", () => {
    expect(parseSuToMilli("12.5")).toBe(12500);
  });

  test("whole numbers, up to three decimals, and zero", () => {
    expect(parseSuToMilli("12")).toBe(12000);
    expect(parseSuToMilli("0")).toBe(0);
    expect(parseSuToMilli("0.001")).toBe(1);
    expect(parseSuToMilli("12.345")).toBe(12345);
    expect(parseSuToMilli("1000000")).toBe(1_000_000_000);
    expect(parseSuToMilli("007.50")).toBe(7500);
  });

  test("four decimals are refused, even when the last is zero", () => {
    expect(parseSuToMilli("1.2345")).toBeNull();
    expect(parseSuToMilli("12.5000")).toBeNull();
    expect(parseSuToMilli("0.0001")).toBeNull();
  });

  test("negatives and signs are refused", () => {
    expect(parseSuToMilli("-1")).toBeNull();
    expect(parseSuToMilli("-0.5")).toBeNull();
    expect(parseSuToMilli("-0")).toBeNull();
    expect(parseSuToMilli("+1")).toBeNull();
  });

  test("anything that is not a plain decimal is refused", () => {
    for (const bad of [
      "",
      ".",
      ".5",
      "5.",
      "1e3",
      "1,5",
      " 1",
      "1 ",
      "1\n",
      "0x10",
      "NaN",
      "Infinity",
      "1_000",
      "twelve",
    ]) {
      expect(parseSuToMilli(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test("a value too large to hold exactly is refused", () => {
    expect(parseSuToMilli("9007199254740")).toBe(9_007_199_254_740_000);
    expect(parseSuToMilli("9007199254741")).toBeNull();
    expect(parseSuToMilli("99999999999999999999")).toBeNull();
  });

  test("formatSu writes the shortest exact decimal", () => {
    expect(formatSu(12500)).toBe("12.5");
    expect(formatSu(12000)).toBe("12");
    expect(formatSu(1)).toBe("0.001");
    expect(formatSu(0)).toBe("0");
    expect(formatSu(123456)).toBe("123.456");
    expect(formatSu(10)).toBe("0.01");
    expect(formatSu(-500)).toBe("-0.5");
    expect(formatSu(-1234)).toBe("-1.234");
  });

  test("the two agree on every figure that parses", () => {
    for (const milli of [0, 1, 9, 10, 99, 100, 999, 1000, 1001, 12500, 123456, 987654321]) {
      expect(parseSuToMilli(formatSu(milli)), String(milli)).toBe(milli);
    }
  });

  test("formatSu refuses a figure that is not a whole number of thousandths", () => {
    expect(() => formatSu(1.5)).toThrow(RangeError);
    expect(() => formatSu(Number.NaN)).toThrow(RangeError);
    expect(() => formatSu(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// --- Partitions and policy ---------------------------------------------------------------------

/**
 * The six partitions offered to people and their default per-job ceilings (design section 5):
 * 1 node of up to 64 cores in `shared`, 2 whole nodes in `compute`, 1 node of up to 3 GPUs in
 * `gpu-shared`, 1 whole node of 4 GPUs in `gpu`, 48 hours (2880 minutes) for each of those four
 * and 30 minutes for the two debug partitions. The `debug` node count and the 40 cores of a GPU
 * node are unconfirmed (design section 12, question 5).
 */
const LITERAL_CEILINGS = {
  shared: { maxNodes: 1, maxCoresPerNode: 64, maxGpusPerNode: 0, maxMinutes: 2880 },
  compute: { maxNodes: 2, maxCoresPerNode: 128, maxGpusPerNode: 0, maxMinutes: 2880 },
  debug: { maxNodes: 2, maxCoresPerNode: 128, maxGpusPerNode: 0, maxMinutes: 30 },
  "gpu-shared": { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 3, maxMinutes: 2880 },
  gpu: { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: 2880 },
  "gpu-debug": { maxNodes: 1, maxCoresPerNode: 40, maxGpusPerNode: 4, maxMinutes: 30 },
} as const;

describe("partitions and their default ceilings (design section 5)", () => {
  test("the four partitions offered with a 48-hour ceiling", () => {
    expect(PARTITIONS.shared.ceiling).toEqual({
      maxNodes: 1,
      maxCoresPerNode: 64,
      maxGpusPerNode: 0,
      maxMinutes: 2880,
    });
    expect(PARTITIONS.compute.ceiling).toMatchObject({ maxNodes: 2, maxMinutes: 2880 });
    expect(PARTITIONS["gpu-shared"].ceiling).toMatchObject({
      maxNodes: 1,
      maxGpusPerNode: 3,
      maxMinutes: 2880,
    });
    expect(PARTITIONS.gpu.ceiling).toMatchObject({
      maxNodes: 1,
      maxGpusPerNode: 4,
      maxMinutes: 2880,
    });
  });

  test("debug partitions are offered for 30 minutes", () => {
    expect(PARTITIONS.debug.ceiling?.maxMinutes).toBe(30);
    expect(PARTITIONS["gpu-debug"].ceiling?.maxMinutes).toBe(30);
  });

  test("large-shared and the preempt partitions are not offered to people", () => {
    for (const p of ["large-shared", "preempt", "gpu-preempt"] as const) {
      expect(PARTITIONS[p].ceiling, p).toBeNull();
    }
  });

  test("a CPU partition never offers a GPU and a GPU partition always does", () => {
    for (const p of PARTITION_NAMES) {
      const c = PARTITIONS[p].ceiling;
      if (!c) continue;
      if (PARTITIONS[p].pool === "cpu") expect(c.maxGpusPerNode, p).toBe(0);
      else expect(c.maxGpusPerNode, p).toBeGreaterThan(0);
    }
  });

  test("every default ceiling field of the six offered partitions, against literals", () => {
    // Written out, not read from PARTITIONS: a changed number must change this test too.
    expect(Object.keys(LITERAL_CEILINGS).sort()).toEqual([
      "compute",
      "debug",
      "gpu",
      "gpu-debug",
      "gpu-shared",
      "shared",
    ]);
    for (const [name, ceiling] of Object.entries(LITERAL_CEILINGS)) {
      expect(PARTITIONS[name as PartitionName].ceiling as unknown, name).toEqual(ceiling);
    }
    for (const name of ["large-shared", "preempt", "gpu-preempt"] as const) {
      expect(PARTITIONS[name].ceiling, name).toBeNull();
    }
  });

  test("the default policy offers exactly those six, with those ceilings", () => {
    expect(DEFAULT_COMPUTE_POLICY.ceilings as unknown).toEqual(LITERAL_CEILINGS);
  });
});

describe("the whole default policy, against literals", () => {
  test("every field of DEFAULT_COMPUTE_POLICY", () => {
    expect(DEFAULT_COMPUTE_POLICY as unknown).toEqual({
      defaultGrantMilli: { cpu: 0, gpu: 0 },
      renewal: { enabled: false, everyDays: null },
      ceilings: LITERAL_CEILINGS,
      maxLiveJobsPerPerson: 4,
      pipelines: { dailyJobCap: 50, maxLiveJobs: { cpu: 8, gpu: 4 } },
      clients: {},
      tenant: { maxLiveJobs: 20, reserved: { people: 8, pipelines: 2, partner: 0 } },
      reservationWaitMinutes: 30,
      retention: { recordsYears: 7, logsDays: 365, resultsDays: 30 },
      resultLimits: {
        maxJobBytes: 21474836480,
        maxFiles: 5000,
        maxStoredBytesPerPerson: 53687091200,
        maxStoredBytesTotal: 1099511627776,
      },
      settle: { toleranceMilli: 1000, tolerancePercent: 5 },
      registries: [],
      bundleLimits: { maxTotalBytes: 104857600, maxFiles: 2000, maxFileBytes: 26214400 },
    });
  });
});

describe("the owner policy", () => {
  test("DEFAULT_COMPUTE_POLICY parses under its own schema, unchanged", () => {
    const parsed = ComputePolicySchema.parse(DEFAULT_COMPUTE_POLICY);
    expect(parsed).toEqual(DEFAULT_COMPUTE_POLICY);
    expect(ComputePolicySchema.parse(JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)))).toEqual(
      DEFAULT_COMPUTE_POLICY,
    );
  });

  test("the values the design and the phase issue fix", () => {
    expect(DEFAULT_COMPUTE_POLICY.defaultGrantMilli).toEqual({ cpu: 0, gpu: 0 });
    expect(DEFAULT_COMPUTE_POLICY.reservationWaitMinutes).toBe(30);
    expect(DEFAULT_COMPUTE_POLICY.retention).toEqual({
      recordsYears: 7,
      logsDays: 365,
      resultsDays: 30,
    });
    expect(DEFAULT_COMPUTE_POLICY.resultLimits).toEqual({
      maxJobBytes: 20 * 1024 ** 3,
      maxFiles: 5000,
      maxStoredBytesPerPerson: 50 * 1024 ** 3,
      maxStoredBytesTotal: 1024 ** 4,
    });
  });

  test("the defaults the phase issue names but does not give a number for", () => {
    // Initial values chosen in phase A1; the owner adjusts them with `policy set`. Everything that
    // lets work start is closed or small: no grant, no registry, no client, a few jobs.
    expect(DEFAULT_COMPUTE_POLICY.renewal).toEqual({ enabled: false, everyDays: null });
    expect(DEFAULT_COMPUTE_POLICY.maxLiveJobsPerPerson).toBe(4);
    expect(DEFAULT_COMPUTE_POLICY.pipelines).toEqual({
      dailyJobCap: 50,
      maxLiveJobs: { cpu: 8, gpu: 4 },
    });
    expect(DEFAULT_COMPUTE_POLICY.clients).toEqual({});
    expect(DEFAULT_COMPUTE_POLICY.registries).toEqual([]);
    expect(DEFAULT_COMPUTE_POLICY.settle).toEqual({ toleranceMilli: 1000, tolerancePercent: 5 });
    expect(DEFAULT_COMPUTE_POLICY.bundleLimits).toEqual({
      maxTotalBytes: 100 * 1024 ** 2,
      maxFiles: 2000,
      maxFileBytes: 25 * 1024 ** 2,
    });
  });

  test("RESULT_MAX_FILE_BYTES is 5 GB, under what one presigned PUT accepts", () => {
    expect(RESULT_MAX_FILE_BYTES).toBe(5_000_000_000);
    expect(RESULT_MAX_FILE_BYTES).toBeLessThan(5 * 1024 ** 3);
  });

  test("the default is frozen, so no caller can change it for everyone", () => {
    const mutate = () => {
      (DEFAULT_COMPUTE_POLICY as { maxLiveJobsPerPerson: number }).maxLiveJobsPerPerson = 99;
    };
    expect(mutate).toThrow();
    expect(() => {
      (DEFAULT_COMPUTE_POLICY.retention as { resultsDays: number }).resultsDays = 1;
    }).toThrow();
    expect(() => {
      (DEFAULT_COMPUTE_POLICY.ceilings.shared as { maxNodes: number }).maxNodes = 9;
    }).toThrow();
    expect(DEFAULT_COMPUTE_POLICY.maxLiveJobsPerPerson).toBe(4);
  });

  const policyClone = () =>
    // biome-ignore lint/suspicious/noExplicitAny: a test document is walked by path
    JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)) as Record<string, any>;
  const refused = (p: unknown) => ComputePolicySchema.safeParse(p).success === false;

  test("an unknown key is refused at the top and at every level", () => {
    const top = policyClone();
    top.surprise = 1;
    expect(refused(top)).toBe(true);
    for (const key of [
      "defaultGrantMilli",
      "renewal",
      "pipelines",
      "retention",
      "resultLimits",
      "settle",
      "bundleLimits",
    ]) {
      const p = policyClone();
      p[key].surprise = 1;
      expect(refused(p), key).toBe(true);
    }
    const p = policyClone();
    p.pipelines.maxLiveJobs.surprise = 1;
    expect(refused(p)).toBe(true);
    const q = policyClone();
    q.ceilings.shared.surprise = 1;
    expect(refused(q)).toBe(true);
  });

  test("every key is required, except the tenant ceiling, which stored policies from before it lack", () => {
    for (const key of Object.keys(DEFAULT_COMPUTE_POLICY)) {
      const p = policyClone();
      delete p[key];
      expect(refused(p), key).toBe(key !== "tenant");
    }
  });

  test("the tenant ceiling: whole numbers in range, the floors fit under it, nothing unknown", () => {
    const withTenant = (tenant: unknown) => ({ ...policyClone(), tenant });
    const ok = (maxLiveJobs: number, people: number, pipelines: number, partner: number) =>
      withTenant({ maxLiveJobs, reserved: { people, pipelines, partner } });
    expect(refused(ok(20, 8, 2, 0))).toBe(false);
    // Floors equal to the ceiling are allowed (nothing is left for other classes); one more is not.
    expect(refused(ok(10, 5, 3, 2))).toBe(false);
    expect(refused(ok(9, 5, 3, 2))).toBe(true);
    // A ceiling of 0 pauses all admissions, and then no floor fits.
    expect(refused(ok(0, 0, 0, 0))).toBe(false);
    expect(refused(ok(0, 1, 0, 0))).toBe(true);
    expect(refused(ok(1001, 0, 0, 0))).toBe(true);
    expect(refused(ok(-1, 0, 0, 0))).toBe(true);
    expect(refused(ok(5, 1.5, 0, 0))).toBe(true);
    expect(refused(withTenant({ maxLiveJobs: 5 }))).toBe(true);
    expect(refused(withTenant({ maxLiveJobs: 5, reserved: { people: 1, pipelines: 1 } }))).toBe(
      true,
    );
    expect(
      refused(
        withTenant({ maxLiveJobs: 5, reserved: { people: 0, pipelines: 0, partner: 0 }, x: 1 }),
      ),
    ).toBe(true);
    expect(
      refused(
        withTenant({ maxLiveJobs: 5, reserved: { people: 0, pipelines: 0, partner: 0, x: 1 } }),
      ),
    ).toBe(true);
    // The issue names the floors, so the route can say where.
    const bad = ComputePolicySchema.safeParse(ok(9, 5, 3, 2));
    expect(bad.success ? [] : bad.error.issues.map((i) => i.path.join("."))).toEqual([
      "tenant.reserved",
    ]);
  });

  test("results are kept at least 14 days", () => {
    const ok = policyClone();
    ok.retention.resultsDays = 14;
    expect(refused(ok)).toBe(false);
    const bad = policyClone();
    bad.retention.resultsDays = 13;
    expect(refused(bad)).toBe(true);
  });

  test("a figure must be a whole non-negative number", () => {
    for (const [path, value] of [
      ["defaultGrantMilli.cpu", -1],
      ["defaultGrantMilli.gpu", 1.5],
      ["maxLiveJobsPerPerson", -1],
      ["maxLiveJobsPerPerson", 2.5],
      ["pipelines.dailyJobCap", -1],
      ["pipelines.maxLiveJobs.gpu", 0.5],
      ["reservationWaitMinutes", 0],
      ["retention.recordsYears", 0],
      ["retention.logsDays", -1],
      ["resultLimits.maxFiles", 0],
      ["resultLimits.maxJobBytes", 1e30],
      ["settle.tolerancePercent", 101],
      ["settle.toleranceMilli", -1],
      ["bundleLimits.maxFiles", 0],
    ] as const) {
      const p = policyClone();
      const parts = path.split(".");
      let cur = p;
      for (const part of parts.slice(0, -1)) cur = cur[part];
      cur[parts[parts.length - 1]] = value;
      expect(refused(p), `${path}=${value}`).toBe(true);
    }
  });

  test("a ceiling is whole, positive where it must be, and only for a known partition", () => {
    const p = policyClone();
    p.ceilings.shared.maxNodes = 0;
    expect(refused(p)).toBe(true);
    const q = policyClone();
    q.ceilings.shared.maxMinutes = 0;
    expect(refused(q)).toBe(true);
    const r = policyClone();
    r.ceilings.nonsense = { maxNodes: 1, maxCoresPerNode: 1, maxGpusPerNode: 0, maxMinutes: 1 };
    expect(refused(r)).toBe(true);
    // A partition NEMAR does not offer by default can be offered by adding a ceiling.
    const s = policyClone();
    s.ceilings["large-shared"] = {
      maxNodes: 1,
      maxCoresPerNode: 128,
      maxGpusPerNode: 0,
      maxMinutes: 1440,
    };
    expect(refused(s)).toBe(false);
    // Dropping one withdraws it.
    const t = policyClone();
    // biome-ignore lint/performance/noDelete: absence of the key is the case under test
    delete t.ceilings.compute;
    expect(refused(t)).toBe(false);
  });

  test("renewal that is on must say how often", () => {
    const on = policyClone();
    on.renewal = { enabled: true, everyDays: 90 };
    expect(refused(on)).toBe(false);
    const bad = policyClone();
    bad.renewal = { enabled: true, everyDays: null };
    expect(refused(bad)).toBe(true);
    const zero = policyClone();
    zero.renewal = { enabled: true, everyDays: 0 };
    expect(refused(zero)).toBe(true);
  });

  test("clients are keyed by a plain client id and carry whole caps", () => {
    const ok = policyClone();
    ok.clients = { partner_site: { maxOpenReservations: 10, maxReservedMilliPerDay: 500000 } };
    expect(refused(ok)).toBe(false);
    const badKey = policyClone();
    badKey.clients = { "has space": { maxOpenReservations: 1, maxReservedMilliPerDay: 1 } };
    expect(refused(badKey)).toBe(true);
    const badCap = policyClone();
    badCap.clients = { c: { maxOpenReservations: -1, maxReservedMilliPerDay: 1 } };
    expect(refused(badCap)).toBe(true);
    const extra = policyClone();
    extra.clients = { c: { maxOpenReservations: 1, maxReservedMilliPerDay: 1, more: 1 } };
    expect(refused(extra)).toBe(true);
  });

  test("a registry is a host with an optional port and path", () => {
    const ok = policyClone();
    ok.registries = ["ghcr.io", "registry.example.test:5000/team"];
    expect(refused(ok)).toBe(false);
    for (const bad of ["", "https://ghcr.io", "ghcr.io/Team", "a b", "ghcr.io/../x"]) {
      const p = policyClone();
      p.registries = [bad];
      expect(refused(p), bad).toBe(true);
    }
  });
});

// --- The job specification ---------------------------------------------------------------------

const SPEC = {
  name: "eeg-floor",
  runtime: "python",
  entry: "run.py",
  bundle: { size: 1234, sha256: HEX_A },
  datasets: [{ id: "nm000104", version: "1.0.2" }],
  partition: "shared",
  minutes: 120,
} as const;

const specRefused = (s: unknown) => JobSpecSchema.safeParse(s).success === false;
const specWith = (patch: Record<string, unknown>) => ({ ...SPEC, ...patch });
const specWithout = (key: string) => {
  const { [key]: _drop, ...rest } = SPEC as Record<string, unknown>;
  return rest;
};

describe("the job specification", () => {
  test("a minimal Python job parses, with every default written out", () => {
    expect(JobSpecSchema.parse(SPEC)).toEqual({
      name: "eeg-floor",
      runtime: "python",
      entry: "run.py",
      args: [],
      bundle: { size: 1234, sha256: HEX_A },
      datasets: [{ id: "nm000104", version: "1.0.2" }],
      partition: "shared",
      nodes: 1,
      cores: 1,
      gpus: 0,
      minutes: 120,
      output_dir: "outputs",
      env: {},
    });
  });

  test("the three runtimes", () => {
    expect([...JOB_RUNTIMES]).toEqual(["python", "matlab", "image"]);
    // MATLAB is a valid specification; a route refuses it as `runtime_unavailable` until it is licensed.
    expect(specRefused(specWith({ runtime: "matlab" }))).toBe(false);
    expect(specRefused(specWith({ runtime: "julia" }))).toBe(true);
  });

  test("an unknown key is refused", () => {
    expect(specRefused(specWith({ surprise: 1 }))).toBe(true);
    expect(
      specRefused(specWith({ bundle: { size: 1, sha256: HEX_A, url: "https://x.test" } })),
    ).toBe(true);
    expect(specRefused(specWith({ datasets: [{ id: "nm000104", version: "1", x: 1 }] }))).toBe(
      true,
    );
  });

  test("an environment name off the allowlist is refused", () => {
    for (const name of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "PATH",
      "HOME",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "NEMAR_LAUNCH_SPEC",
      "NEMAR_OUT",
      "omp_num_threads",
      "",
    ]) {
      expect(specRefused(specWith({ env: { [name]: "1" } })), name).toBe(true);
    }
  });

  test("every allowlisted environment name is accepted", () => {
    for (const name of JOB_ENV_ALLOWLIST) {
      expect(specRefused(specWith({ env: { [name]: "4" } })), name).toBe(false);
    }
    expect(JobSpecSchema.parse(specWith({ env: { OMP_NUM_THREADS: "4" } })).env).toEqual({
      OMP_NUM_THREADS: "4",
    });
  });

  test("the allowlist is thread counts and determinism, never a path or a loader", () => {
    expect([...JOB_ENV_ALLOWLIST]).toEqual([
      "OMP_NUM_THREADS",
      "MKL_NUM_THREADS",
      "OPENBLAS_NUM_THREADS",
      "NUMEXPR_NUM_THREADS",
      "PYTHONHASHSEED",
      "MPLBACKEND",
    ]);
    for (const name of JOB_ENV_ALLOWLIST) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  test("an environment value is short printable text", () => {
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: "4\n5" } }))).toBe(true);
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: "x".repeat(257) } }))).toBe(true);
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: "x".repeat(256) } }))).toBe(false);
    expect(specRefused(specWith({ env: { OMP_NUM_THREADS: 4 } }))).toBe(true);
    expect(specRefused(specWith({ env: { MPLBACKEND: "Agg" } }))).toBe(false);
  });

  test("an entry is a relative path inside the bundle", () => {
    for (const bad of [
      "/run.py",
      "../run.py",
      "a/../run.py",
      "a//b.py",
      "a\\b.py",
      "",
      "./run.py",
      "a/.",
    ]) {
      expect(specRefused(specWith({ entry: bad })), bad).toBe(true);
    }
    expect(specRefused(specWith({ entry: "src/analysis/run.py" }))).toBe(false);
    expect(specRefused(specWith({ entry: `${"a/".repeat(120)}x.py` }))).toBe(true);
  });

  test("an entry and a command are one or the other", () => {
    expect(specRefused(specWith({ command: ["python", "run.py"] }))).toBe(true);
    // Neither, and no recipe: nothing to run.
    expect(specRefused(specWithout("entry"))).toBe(true);
  });

  describe("a lone surrogate is refused, in every string that reaches the launch specification", () => {
    // A lone surrogate is a valid JavaScript string and encodes as `\ud800`, but it is not text:
    // no process argument can carry it, so the job would fail only after the hold exists.
    const HIGH = "\ud800";
    const LOW = "\udc00";
    const PAIR = "\ud83d\ude00";
    /** The lone-surrogate strings, each in a spot of its own: start, middle, end, doubled. */
    const LONE: Array<[string, string]> = [
      ["a lone high surrogate", `a${HIGH}b`],
      ["a lone low surrogate", `a${LOW}b`],
      ["a reversed pair", `a${LOW}${HIGH}b`],
      ["a lone high surrogate at the end", `ab${HIGH}`],
      ["a lone low surrogate at the start", `${LOW}ab`],
      ["two high surrogates", `a${HIGH}${HIGH}b`],
      ["two low surrogates", `a${LOW}${LOW}b`],
      ["a lone high surrogate before a valid pair", `a${HIGH}${PAIR}`],
      ["a lone low surrogate after a valid pair", `a${PAIR}${LOW}`],
      ["the first unit of the high range alone", "\ud800"],
      ["the last unit of the high range alone", "\udbff"],
      ["the first unit of the low range alone", "\udc00"],
      ["the last unit of the low range alone", "\udfff"],
      ["a high surrogate before U+E000, the first unit above the range", `a${HIGH}\ue000`],
      ["a low surrogate after U+D7FF, the last unit below the range", `\ud7ff${LOW}`],
      ["a high surrogate before a high surrogate", `a\udbff${HIGH}b`],
    ];
    /** Text that is well-formed, the units either side of the surrogate range among it. */
    const WELL_FORMED = [
      PAIR,
      `a${PAIR}b${PAIR}`,
      "caf\u00e9",
      "\u65e5\u672c",
      "\uffff",
      "ab",
      "\ud7ff",
      "\ue000",
      "\ud7ff\ue000",
      "\udbff\udfff",
      "\ud800\udc00",
    ];
    /** Where such a string goes: the field, how a job puts it there, and the issue path. */
    const FIELDS: Array<[string, (s: string) => Record<string, unknown>, Array<string | number>]> =
      [
        ["entry", (s) => specWith({ entry: `d/${s}.py` }), ["entry"]],
        [
          "a command item",
          (s) => ({
            name: "t",
            runtime: "image",
            image: `ghcr.io/e/t@sha256:${HEX_B}`,
            command: ["ok", s],
            partition: "shared",
            minutes: 5,
          }),
          ["command", 1],
        ],
        ["an argument", (s) => specWith({ args: ["ok", s] }), ["args", 1]],
        [
          "an include pattern",
          (s) =>
            specWith({ datasets: [{ id: "nm000104", version: "1", include: ["ok", `${s}/*`] }] }),
          ["datasets", 0, "include", 1],
        ],
      ];

    for (const [field, build, path] of FIELDS) {
      for (const [label, text] of LONE) {
        test(`${label} in ${field} is refused, naming the field`, () => {
          const refused = JobSpecSchema.safeParse(build(text));
          expect(refused.success).toBe(false);
          if (refused.success) return;
          expect(refused.error.issues).toHaveLength(1);
          expect(refused.error.issues[0].path).toEqual(path);
          // The message names the problem and never carries the value.
          expect(refused.error.issues[0].message).toBe(
            "a lone surrogate is not text a process argument can carry",
          );
        });
      }

      test(`a valid surrogate pair, and any other non-ASCII text, is accepted in ${field}`, () => {
        for (const text of WELL_FORMED) {
          expect(specRefused(build(text)), JSON.stringify(text)).toBe(false);
        }
      });
    }

    test("an environment value cannot carry one: it is printable ASCII only", () => {
      for (const [label, text] of LONE) {
        const refused = JobSpecSchema.safeParse(specWith({ env: { OMP_NUM_THREADS: text } }));
        expect(refused.success, label).toBe(false);
        if (refused.success) continue;
        expect(refused.error.issues, label).toHaveLength(1);
        expect(refused.error.issues[0].path, label).toEqual(["env", "OMP_NUM_THREADS"]);
      }
      // A valid pair is no better there: the value is ASCII, so it is refused as well.
      expect(specRefused(specWith({ env: { OMP_NUM_THREADS: PAIR } }))).toBe(true);
    });

    test("every lone-surrogate string really is one, and every accepted one really is not", () => {
      // Guards the table against the engine: String.prototype.isWellFormed is the reference.
      const wellFormed = (s: string) => (s as string & { isWellFormed(): boolean }).isWellFormed();
      for (const [label, text] of LONE) expect(wellFormed(text), label).toBe(false);
      for (const text of WELL_FORMED) expect(wellFormed(text), JSON.stringify(text)).toBe(true);
    });

    test("computeIsWellFormed agrees with String.prototype.isWellFormed on every shape", () => {
      const reference = (s: string) => (s as string & { isWellFormed(): boolean }).isWellFormed();
      // Every one of the 2048 surrogate units alone, at the start, middle and end of a string.
      for (let unit = 0xd800; unit <= 0xdfff; unit++) {
        const c = String.fromCharCode(unit);
        for (const text of [c, `a${c}`, `${c}a`, `a${c}b`, `${c}${c}`]) {
          expect(computeIsWellFormed(text), unit.toString(16)).toBe(reference(text));
        }
      }
      // Pairs, high then low and low then high, on a stride that still reaches both ends.
      for (let high = 0xd800; high <= 0xdbff; high += high < 0xd840 || high > 0xdbc0 ? 1 : 37) {
        for (let low = 0xdc00; low <= 0xdfff; low += low < 0xdc40 || low > 0xdfc0 ? 1 : 41) {
          const h = String.fromCharCode(high);
          const l = String.fromCharCode(low);
          expect(computeIsWellFormed(`${h}${l}`), `${high.toString(16)} ${low.toString(16)}`).toBe(
            true,
          );
          expect(computeIsWellFormed(`${l}${h}`)).toBe(false);
        }
      }
      // A seeded fuzz over the units that matter, so the run is the same every time.
      const alphabet = ["a", "\ud7ff", "\ud800", "\udbff", "\udc00", "\udfff", "\ue000", "\u00e9"];
      let seed = 12345;
      const next = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed;
      };
      for (let i = 0; i < 20000; i++) {
        const length = next() % 7;
        let text = "";
        for (let j = 0; j < length; j++) text += alphabet[next() % alphabet.length];
        expect(computeIsWellFormed(text), JSON.stringify(text)).toBe(reference(text));
      }
      expect(computeIsWellFormed("")).toBe(true);
    });
  });

  test("an entry needs the bundle that holds it", () => {
    expect(specRefused(specWithout("bundle"))).toBe(true);
  });

  test("an image job names a digest-pinned image and a command", () => {
    const image = `docker://ghcr.io/example/tool@sha256:${HEX_B}`;
    const job = {
      name: "tool",
      runtime: "image",
      image,
      command: ["tool", "--in", "/data"],
      partition: "shared",
      minutes: 30,
    };
    expect(specRefused(job)).toBe(false);
    // A tag is not a pin.
    expect(specRefused({ ...job, image: "docker://ghcr.io/example/tool:latest" })).toBe(true);
    expect(specRefused({ ...job, image: `ghcr.io/example/tool@sha256:${"c".repeat(63)}` })).toBe(
      true,
    );
    expect(specRefused({ ...job, image: `ghcr.io/example/tool@sha256:${HEX_B}` })).toBe(false);
    // The runtime and the image go together.
    const { image: _i, ...noImage } = job;
    expect(specRefused(noImage)).toBe(true);
    expect(specRefused(specWith({ image }))).toBe(true);
    // A command may travel with a bundle or without one.
    expect(specRefused({ ...job, bundle: { size: 9, sha256: HEX_A } })).toBe(false);
  });

  test("at most 20 datasets", () => {
    const some = (n: number) =>
      Array.from({ length: n }, () => ({ id: "nm000104", version: "1.0.2" }));
    expect(specRefused(specWith({ datasets: some(20) }))).toBe(false);
    expect(specRefused(specWith({ datasets: some(21) }))).toBe(true);
  });

  test("an image reference with no digest at all is not a pin", () => {
    const job = {
      name: "tool",
      runtime: "image",
      command: ["tool"],
      partition: "shared",
      minutes: 30,
    };
    expect(specRefused({ ...job, image: "docker://ghcr.io/example/tool" })).toBe(true);
    expect(specRefused({ ...job, image: "ghcr.io/example/tool@sha256:" })).toBe(true);
    expect(specRefused({ ...job, image: `ghcr.io/example/tool@sha256:${"B".repeat(64)}` })).toBe(
      true,
    );
  });

  test("a recipe job needs no entry, command or bundle", () => {
    const recipe = {
      name: "floor-nm000104",
      runtime: "python",
      recipe: "nemar-floor",
      datasets: [{ id: "nm000104", version: "1.0.2" }],
      partition: "shared",
      minutes: 60,
    };
    expect(specRefused(recipe)).toBe(false);
    expect(specRefused({ ...recipe, recipe: "Nemar Floor" })).toBe(true);
    expect(specRefused({ ...recipe, recipe: "" })).toBe(true);
  });

  test("a dataset is an id, a version and optional include patterns", () => {
    for (const bad of [
      { id: "nm00010", version: "1" },
      { id: "NM000104", version: "1" },
      { id: "nm000104", version: "" },
      { id: "nm000104", version: "../1" },
      { id: "nm000104" },
      { version: "1" },
    ]) {
      expect(specRefused(specWith({ datasets: [bad] })), JSON.stringify(bad)).toBe(true);
    }
    expect(specRefused(specWith({ datasets: [{ id: "ds002718", version: "1.0.5" }] }))).toBe(false);
    expect(
      specRefused(
        specWith({
          datasets: [{ id: "nm000104", version: "1.0.2", include: ["sub-01/**/*.set"] }],
        }),
      ),
    ).toBe(false);
  });

  test("an include pattern never leaves the dataset", () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "a\\b", "", "a\nb"]) {
      const datasets = [{ id: "nm000104", version: "1.0.2", include: [bad] }];
      expect(specRefused(specWith({ datasets })), JSON.stringify(bad)).toBe(true);
    }
  });

  test("resources are whole numbers inside sane bounds", () => {
    for (const patch of [
      { partition: "nonsense" },
      { minutes: 0 },
      { minutes: 1.5 },
      { minutes: 10081 },
      { nodes: 0 },
      { cores: 0 },
      { cores: 8.5 },
      { gpus: -1 },
      { memory_mb: 0 },
      { memory_mb: -5 },
    ]) {
      expect(specRefused(specWith(patch)), JSON.stringify(patch)).toBe(true);
    }
    expect(specRefused(specWith({ memory_mb: 16384, cores: 8, nodes: 2, gpus: 0 }))).toBe(false);
  });

  test("a GPU partition needs at least one GPU and a CPU partition takes none", () => {
    for (const partition of ["gpu-shared", "gpu", "gpu-debug", "gpu-preempt"]) {
      expect(specRefused(specWith({ partition })), `${partition} with the default 0 GPUs`).toBe(
        true,
      );
      expect(specRefused(specWith({ partition, gpus: 0 })), partition).toBe(true);
      expect(specRefused(specWith({ partition, gpus: 1 })), `${partition} with 1`).toBe(false);
      expect(specRefused(specWith({ partition, gpus: 4 })), `${partition} with 4`).toBe(false);
    }
    for (const partition of ["shared", "compute", "debug", "large-shared", "preempt"]) {
      expect(specRefused(specWith({ partition })), `${partition} with the default`).toBe(false);
      expect(specRefused(specWith({ partition, gpus: 1 })), `${partition} with 1 GPU`).toBe(true);
    }
    const issue = JobSpecSchema.safeParse(specWith({ partition: "gpu-shared" }));
    expect(issue.success).toBe(false);
    if (!issue.success) expect(issue.error.issues.map((i) => i.path.join("."))).toEqual(["gpus"]);
  });

  test("a partition name that is only an inherited key is refused", () => {
    for (const partition of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(specRefused(specWith({ partition })), partition).toBe(true);
    }
  });

  test("memory is at most 16777216 MB (16 TiB)", () => {
    expect(specRefused(specWith({ memory_mb: 16_777_216 }))).toBe(false);
    expect(specRefused(specWith({ memory_mb: 16_777_217 }))).toBe(true);
    expect(specRefused(specWith({ memory_mb: 1 }))).toBe(false);
  });

  test("the output directory is `outputs`, which the launcher's layout fixes", () => {
    expect(JobSpecSchema.parse(SPEC).output_dir).toBe("outputs");
    expect(specRefused(specWith({ output_dir: "results" }))).toBe(true);
  });

  test("a name is short and plain", () => {
    for (const bad of ["", " lead", "x".repeat(81), "a\nb", "a/b", "a;b"]) {
      expect(specRefused(specWith({ name: bad })), JSON.stringify(bad)).toBe(true);
    }
    expect(specRefused(specWith({ name: "EEG floor, run 1.2" }))).toBe(true);
    expect(specRefused(specWith({ name: "EEG floor run 1.2" }))).toBe(false);
  });

  test("arguments are bounded strings", () => {
    expect(specRefused(specWith({ args: ["--fast", "x".repeat(1024)] }))).toBe(false);
    expect(specRefused(specWith({ args: ["x".repeat(1025)] }))).toBe(true);
    expect(specRefused(specWith({ args: Array.from({ length: 65 }, () => "a") }))).toBe(true);
    expect(specRefused(specWith({ args: [1] }))).toBe(true);
  });

  test("a bundle digest is lowercase hex and its size is positive", () => {
    expect(specRefused(specWith({ bundle: { size: 1, sha256: "A".repeat(64) } }))).toBe(true);
    expect(specRefused(specWith({ bundle: { size: 1, sha256: "a".repeat(63) } }))).toBe(true);
    expect(specRefused(specWith({ bundle: { size: 0, sha256: HEX_A } }))).toBe(true);
    expect(specRefused(specWith({ bundle: { sha256: HEX_A } }))).toBe(true);
  });

  test("a specification survives a JSON round trip unchanged", () => {
    const once = JobSpecSchema.parse(SPEC);
    expect(JobSpecSchema.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe("the data-plane tag of a dataset version", () => {
  test("a bare version gains a v, a tag and latest stay as they are", () => {
    expect(dataTagForVersion("1.0.2")).toBe("v1.0.2");
    expect(dataTagForVersion("v1.0.2")).toBe("v1.0.2");
    expect(dataTagForVersion("latest")).toBe("latest");
    expect(dataTagForVersion("0.0.0")).toBe("v0.0.0");
    expect(dataTagForVersion("10.200.3000")).toBe("v10.200.3000");
    expect(dataTagForVersion("v10.200.3000")).toBe("v10.200.3000");
    expect(dataTagForVersion("01.02.03")).toBe("v01.02.03");
    expect(dataTagForVersion("v01.02.03")).toBe("v01.02.03");
  });

  test("anything else has no tag", () => {
    for (const bad of [
      "",
      "1",
      "1.0",
      "v1",
      "v1.0",
      "1.0.2.3",
      "v1.0.2.3",
      "V1.0.2",
      "Latest",
      "LATEST",
      "latest ",
      " latest",
      "latest\n",
      "latest1",
      "vlatest",
      "1.0.2\n",
      "v1.0.2\n",
      " 1.0.2",
      "1.0.2 ",
      "1.0.2-rc1",
      "v1.0.2-rc1",
      "1.0.2+b",
      "vv1.0.2",
      "1.0.a",
      "1x0.2",
      "1.0x2",
      "v1x0.2",
      "v1.0x2",
      "1..2",
      "1.0.",
      ".1.2",
      "v",
      "main",
      "abc",
      "../1.0.2",
      "1.0.2/x",
      "١.٠.٢",
      "v١.٠.٢",
    ]) {
      expect(dataTagForVersion(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [5, null, undefined, {}, ["1.0.2"], { toString: () => "1.0.2" }]) {
      expect(dataTagForVersion(bad as never), String(bad)).toBeNull();
    }
  });

  test("the longest tag is 64 characters, and one more is no tag", () => {
    const sixtyFour = `v${"9".repeat(59)}.0.0`;
    expect(sixtyFour.length).toBe(64);
    expect(dataTagForVersion(sixtyFour)).toBe(sixtyFour);
    // A bare version of 63 characters gains the v and is 64; one of 64 would be 65, which is no tag.
    const bare = `${"9".repeat(59)}.0.0`;
    expect(bare.length).toBe(63);
    expect(dataTagForVersion(bare)).toBe(sixtyFour);
    const bareSixtyFour = `${"9".repeat(60)}.0.0`;
    expect(bareSixtyFour.length).toBe(64);
    expect(dataTagForVersion(bareSixtyFour)).toBeNull();
    expect(dataTagForVersion(`${sixtyFour}0`)).toBeNull();
    expect(dataTagForVersion(`v${"9".repeat(60)}.0.0`)).toBeNull();
    // Such a job version is valid for a job, and is the tag helper's null: see datasetVersionWithoutTag.
    expect(specRefused(specWith({ datasets: [{ id: "nm000104", version: bareSixtyFour }] }))).toBe(
      false,
    );
    expect(COMPUTE_DATA_TAG_MAX).toBe(64);
  });

  test("every tag the helper can return is a version the provenance staging record accepts", () => {
    // The launcher records the tag it fetched in staging[].version, which the Worker parses strictly:
    // a tag longer than that field allows would make a good run's provenance a refused file.
    const staged = (version: string) => ({
      ...PROVENANCE_BASE,
      staging: [{ ...STAGING, version }],
    });
    const tags = new Set<string>(["latest", "v0.0.0", "v1.0.2", "v01.02.03", "v10.200.3000"]);
    // Every length a tag of the form v<digits>.0.0 can have, from its shortest to its longest, as a
    // bare job version and as the tag a job may name itself.
    for (let n = 1; n <= 80; n++) {
      for (const version of [
        `${"9".repeat(n)}.0.0`,
        `v${"9".repeat(n)}.0.0`,
        `${"9".repeat(n)}.${"8".repeat(n)}.7`,
      ]) {
        const tag = dataTagForVersion(version);
        if (tag !== null) tags.add(tag);
      }
    }
    expect(tags.size).toBeGreaterThan(80);
    let longest = 0;
    for (const tag of tags) {
      expect(tag.length, tag).toBeLessThanOrEqual(COMPUTE_DATA_TAG_MAX);
      expect(COMPUTE_DATASET_VERSION_RE.test(tag), `pattern: ${tag}`).toBe(true);
      expect(ajvFor("provenance")(staged(tag)), `JSON Schema: ${tag}`).toBe(true);
      expect(zodFor.provenance(staged(tag)), `zod: ${tag}`).toBe(true);
      longest = Math.max(longest, tag.length);
    }
    expect(longest).toBe(COMPUTE_DATA_TAG_MAX);
    // And the field really does stop where the tag does: one character more is refused there.
    const tooLong = `v${"9".repeat(60)}.0.0`;
    expect(tooLong.length).toBe(COMPUTE_DATA_TAG_MAX + 1);
    expect(ajvFor("provenance")(staged(tooLong))).toBe(false);
    expect(zodFor.provenance(staged(tooLong))).toBe(false);
  });

  test("it is idempotent: the tag of a tag is the tag", () => {
    for (const v of ["1.0.2", "v1.0.2", "latest", "0.0.0", "12.0.1"]) {
      const tag = dataTagForVersion(v);
      expect(tag, v).not.toBeNull();
      expect(dataTagForVersion(tag as string), v).toBe(tag);
    }
  });

  test("a tag is exactly what the launch specification accepts, in both engines", () => {
    const versions = [
      "1.0.2",
      "v1.0.2",
      "latest",
      "0.0.0",
      "1",
      "1.0",
      "v1",
      "V1.0.2",
      "1.0.2-rc1",
      "latest1",
      "",
      "abc",
      `${"9".repeat(59)}.0.0`,
      `${"9".repeat(60)}.0.0`,
      `v${"9".repeat(59)}.0.0`,
      `v${"9".repeat(60)}.0.0`,
      "1.0.2\n",
    ];
    const withVersion = (version: string) => set(LAUNCH, "datasets", [{ id: "nm000104", version }]);
    for (const version of versions) {
      const tag = dataTagForVersion(version);
      if (tag !== null) {
        expect(validateRoot(withVersion(tag)), `JSON Schema: ${version}`).toBe(true);
        expect(LaunchSpecSchema.safeParse(withVersion(tag)).success, `zod: ${version}`).toBe(true);
      } else {
        // No tag: the version as it stands is no launch version either.
        expect(validateRoot(withVersion(version)), `JSON Schema: ${version}`).toBe(false);
        expect(LaunchSpecSchema.safeParse(withVersion(version)).success, `zod: ${version}`).toBe(
          false,
        );
      }
    }
  });

  test("the tag grammar is the data plane's own: latest, or what VERSION_TAG_RE accepts", () => {
    // Read from the data plane's source, so a change there fails here. `\\d` is ASCII digits only.
    const source = readFileSync(
      join(import.meta.dir, "..", "backend", "src", "services", "data-router.ts"),
      "utf8",
    );
    const found = /export const VERSION_TAG_RE = \/(.+)\/;/.exec(source);
    expect(found, "VERSION_TAG_RE is still declared in data-router.ts").not.toBeNull();
    const dataPlane = new RegExp((found as RegExpExecArray)[1]);
    const corpus = [
      "v1.0.2",
      "v0.0.0",
      "v10.200.3000",
      "v01.02.03",
      "latest",
      "1.0.2",
      "v1",
      "v1.0",
      "v1.0.2.3",
      "V1.0.2",
      "v1.0.2\n",
      "v1.0.2-rc1",
      " v1.0.2",
      "v\u0661.\u0660.\u0662",
      "",
      "main",
      `v${"9".repeat(60)}.0.0`,
    ];
    for (const version of corpus) {
      // The data plane resolves `latest` before it applies the pattern, so it is the one extra word.
      const dataPlaneAccepts = version === "latest" || dataPlane.test(version);
      expect(COMPUTE_DATA_TAG_RE.test(version), JSON.stringify(version)).toBe(dataPlaneAccepts);
    }
    expect(COMPUTE_DATA_TAG_MAX).toBe(64);
  });

  test("a job keeps accepting every version form it accepted before", () => {
    for (const version of ["1.0.2", "v1.0.2", "latest", "1", "1.0", "2.0.0-rc.1", "abc", "V1"]) {
      expect(specRefused(specWith({ datasets: [{ id: "nm000104", version }] })), version).toBe(
        false,
      );
    }
  });
});

describe("the one launch rule a job specification does not enforce: the dataset version tag", () => {
  // A valid job specification always fits the 64 KiB and is well formed. A dataset version with no
  // data-plane tag is valid for a job and has no tag, so the Worker and the CLI run launchSpecFits
  // before the hold and refuse with invalid_spec, naming the field datasetVersionWithoutTag finds.
  const UNTAGGED = ["1", "1.0", "abc", "V1.0.2", "2.0.0-rc.1", "1.0.2-rc1", "v1", "1.x.2"];

  test("every such version is a valid job and has no tag", () => {
    for (const version of UNTAGGED) {
      const job = specWith({ datasets: [{ id: "nm000104", version }] });
      expect(specRefused(job), `job: ${version}`).toBe(false);
      expect(dataTagForVersion(version), `tag: ${version}`).toBeNull();
      expect(launchSpecFits(JobSpecSchema.parse(job)), `fits: ${version}`).toBe(false);
    }
  });

  test("datasetVersionWithoutTag names the first dataset whose version has no tag", () => {
    const at = (versions: string[]) =>
      datasetVersionWithoutTag(versions.map((version) => ({ id: "nm000104", version })));
    expect(at(["1"])).toBe("datasets.0.version");
    expect(at(["1.0.2", "abc"])).toBe("datasets.1.version");
    expect(at(["v1.0.2", "latest", "1.0.2", "1.0"])).toBe("datasets.3.version");
    // The first, when there are several.
    expect(at(["1.0.2", "x", "y", "z"])).toBe("datasets.1.version");
    expect(at(["x", "y"])).toBe("datasets.0.version");
    for (const version of UNTAGGED)
      expect(at(["1.0.2", version]), version).toBe("datasets.1.version");
  });

  test("it is null when every version has a tag, and when there are no datasets", () => {
    expect(datasetVersionWithoutTag([])).toBeNull();
    expect(datasetVersionWithoutTag([{ version: "1.0.2" }])).toBeNull();
    expect(
      datasetVersionWithoutTag([
        { version: "v1.0.2" },
        { version: "latest" },
        { version: "0.0.0" },
      ]),
    ).toBeNull();
  });

  test("it is the same answer as launchSpecFits gives, for the tag", () => {
    for (const version of ["1.0.2", "v1.0.2", "latest", ...UNTAGGED]) {
      const job = JobSpecSchema.parse(specWith({ datasets: [{ id: "nm000104", version }] }));
      expect(datasetVersionWithoutTag(job.datasets) === null, version).toBe(launchSpecFits(job));
    }
  });

  test("the invariant is stated the same way, and no sentence claims a valid job always becomes a launch specification", () => {
    const read = (...parts: string[]) =>
      readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
        .replace(/\n\s*\*\s?/g, " ")
        .replace(/\s+/g, " ");
    const statement =
      "the dataset version tag is the one launch rule JobSpecSchema does not enforce";
    for (const text of [
      read("shared", "contract", "compute.ts"),
      read("shared", "contract", "compute-launch.ts"),
      read(".context", "compute-program", "implementation-notes.md"),
    ]) {
      expect(text).toContain(statement);
      expect(text).toContain("must run `launchSpecFits`");
      expect(text).toContain("BEFORE the hold");
      expect(text).not.toContain("A valid specification always becomes a launch specification");
      expect(text).not.toContain("a valid job specification always fits.");
    }
  });
});

describe("the include dialect's refused patterns", () => {
  test("includePatternProblem accepts every pattern the dialect accepts, edges included", () => {
    for (const ok of [
      "",
      "*",
      "**",
      "?",
      "**/x",
      "a/**/b",
      "**/*.set",
      "sub-*/eeg/*.set",
      "*.set",
      // An unterminated [ is a literal [.
      "[",
      "a[",
      "[abc",
      "[!",
      "[!abc",
      "x[y",
      "a/[b",
      // Classes, and the hyphen at either end or after a range as a literal.
      "[abc]",
      "[a-c]",
      "[!abc]",
      "[!a-c]",
      "[0-9a-f]x",
      "[a-]",
      "[-a]",
      "[a-a]",
      "[--/]",
      "[a-c-e]",
      "[a-c-a]",
      "[cba]",
      "[zyx]",
      "[[]",
      "[a[b]",
      "[ab]]",
      // Code points, not UTF-16 units: an astral range is a range.
      "[\u{1F600}-\u{1F603}]",
      "[\u{1F600}-\u{1F600}]",
      "[é-ÿ]",
    ]) {
      expect(includePatternProblem(ok), JSON.stringify(ok)).toBeNull();
    }
  });

  test("an empty class is refused as empty_class, a [ or [! with a ] straight after it", () => {
    for (const bad of ["[]", "[!]", "a[]b", "x/[]/y", "[]]", "[]a]", "[!]a]", "*[]", "[a][]"]) {
      expect(includePatternProblem(bad), JSON.stringify(bad)).toBe("empty_class");
    }
  });

  test("an inverted range is refused as inverted_range", () => {
    for (const bad of [
      "[z-a]",
      "[b-a]",
      "[9-0]",
      "[!z-a]",
      "x[a-c][z-a]",
      "[a-cz-a]",
      "[xb-a]",
      "[a-!]",
      "[\u{1F603}-\u{1F600}]",
      "[ÿ-é]",
      "[~- ]",
    ]) {
      expect(includePatternProblem(bad), JSON.stringify(bad)).toBe("inverted_range");
    }
  });

  test("the first problem found, left to right, is the one named", () => {
    expect(includePatternProblem("[][z-a]")).toBe("empty_class");
    expect(includePatternProblem("[z-a][]")).toBe("inverted_range");
  });

  test("a class ends at the first ], so what follows is a literal or another class", () => {
    expect(includePatternProblem("[a-c][z-a")).toBeNull(); // the second [ is unterminated
    expect(includePatternProblem("[a]z-a]")).toBeNull(); // z-a] is outside any class
    expect(includePatternProblem("[a-c]]")).toBeNull();
    expect(includePatternProblem("[a-c][b-a]")).toBe("inverted_range");
  });

  test("a job refuses such a pattern at submit, naming datasets.<i>.include.<j> and never the pattern", () => {
    const withInclude = (include: string[]) =>
      specWith({
        datasets: [
          { id: "nm000104", version: "1.0.2" },
          { id: "nm000105", version: "1.0.2", include },
        ],
      });
    const refusal = (include: string[]) => {
      const refused = JobSpecSchema.safeParse(withInclude(include));
      return refused.success ? [] : refused.error.issues;
    };
    const [empty] = refusal(["ok/*", "x", "ab[]cd"]);
    expect(refusal(["ok/*", "x", "ab[]cd"])).toHaveLength(1);
    expect(empty.path).toEqual(["datasets", 1, "include", 2]);
    expect(empty.message).toContain("empty_class");
    expect(empty.message).not.toContain("ab[]cd");
    const [inverted] = refusal(["[z-a]"]);
    expect(refusal(["[z-a]"])).toHaveLength(1);
    expect(inverted.path).toEqual(["datasets", 1, "include", 0]);
    expect(inverted.message).toContain("inverted_range");
    // Each bad pattern gets its own issue, at its own place.
    expect(refusal(["[]", "fine", "[z-a]"]).map((i) => i.path.join("."))).toEqual([
      "datasets.1.include.0",
      "datasets.1.include.2",
    ]);
    for (const ok of ["**/x", "a/**/b", "[", "[!", "[a-]", "[abc", "**"]) {
      expect(specRefused(withInclude([ok])), ok).toBe(false);
    }
  });

  test("the launch specification is as permissive: the launcher alone refuses these, as bad_include", () => {
    const launch = set(LAUNCH, "datasets", [
      { id: "nm000104", version: "v1.0.2", include: ["[]", "[z-a]"] },
    ]);
    expect(validateRoot(launch)).toBe(true);
    expect(LaunchSpecSchema.safeParse(launch).success).toBe(true);
  });
});

describe("isSafeComputePath", () => {
  test("accepts ordinary relative paths and refuses every escape", () => {
    for (const ok of ["a", "a/b", "a b/c.d", "sub-01/eeg/x.set", "..a", "a..b", ".hidden"]) {
      expect(isSafeComputePath(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "/a",
      "a/",
      "a//b",
      ".",
      "..",
      "../a",
      "a/..",
      "a/../b",
      "./a",
      "a/./b",
      "a\\b",
      "a\u0000b",
      "a\nb",
      "a\u007fb",
    ]) {
      expect(isSafeComputePath(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isSafeComputePath("a".repeat(512))).toBe(true);
    expect(isSafeComputePath("a".repeat(513))).toBe(false);
    expect(isSafeComputePath("a".repeat(11), 10)).toBe(false);
  });
});

// --- The launcher's files ----------------------------------------------------------------------

describe("the launcher contract", () => {
  test("the records bucket keeps the launcher's manifest under its own name", () => {
    expect(RECORDS_RESULT_MANIFEST_FILE).toBe("result-manifest.json");
    expect(LAUNCHER_FILES.manifest).toBe("manifest.json");
    // The launcher's failure code lives in result.json; there is no separate failure file.
    expect((LAUNCHER_FILE_NAMES as readonly string[]).includes(RECORDS_RESULT_MANIFEST_FILE)).toBe(
      false,
    );
    for (const rel of [
      "../shared/compute-state.ts",
      "../shared/contract/compute.ts",
      "../shared/contract/compute-launch.ts",
      "../shared/contract/compute-launch.schema.json",
    ]) {
      expect(readFileSync(join(import.meta.dir, rel), "utf8").includes("failure.json"), rel).toBe(
        false,
      );
    }
  });

  test("one path-segment grammar and one output-file bound serve the whole contract", () => {
    expect(COMPUTE_MAX_OUTPUT_FILES).toBe(100_000);
    const segment = new RegExp(`^${COMPUTE_PATH_SEGMENT}$`);
    for (const ok of ["a", "a b", "..a", "é"]) expect(segment.test(ok), ok).toBe(true);
    for (const bad of ["", "a/b", "a\\b", "a\u0001", "a\u007f", "a\n"]) {
      expect(segment.test(bad), JSON.stringify(bad)).toBe(false);
    }
    // A path built from the segment grammar is exactly isSafeComputePath's.
    const built = new RegExp(`^(?:${COMPUTE_PATH_SEGMENT}/)*${COMPUTE_PATH_SEGMENT}$`);
    for (const p of ["a", "a/b", "a//b", "/a", "a/", "a\\b", ""]) {
      expect(built.test(p), JSON.stringify(p)).toBe(isSafeComputePath(p));
    }
  });

  test("names and layout the launcher and the Worker agree on", () => {
    expect(PIPELINES_TAPIS_OWNER).toBe("nemar-pipelines");
    expect(LAUNCHER_WORK_DIR).toBe("work");
    expect(LAUNCHER_OUTPUTS_DIR).toBe("work/outputs");
    expect(LAUNCHER_DIR).toBe("launcher");
    expect(LAUNCHER_FILES).toEqual({
      result: "result.json",
      provenance: "provenance.json",
      manifest: "manifest.json",
      log: "launcher.log",
    });
    expect([...LAUNCHER_FILE_NAMES]).toEqual([
      "result.json",
      "provenance.json",
      "manifest.json",
      "launcher.log",
    ]);
    expect(LAUNCHER_ENV).toEqual({
      SPEC: "NEMAR_LAUNCH_SPEC",
      OUT: "NEMAR_OUT",
      LOCAL_DATASETS_ROOT: "NEMAR_LOCAL_DATASETS_ROOT",
      HOST_PYTHON: "NEMAR_HOST_PYTHON",
      SIF_ROOT: "NEMAR_SIF_ROOT",
    });
  });

  test("the launcher's environment names are never on the allowlist for a job", () => {
    for (const name of Object.values(LAUNCHER_ENV)) {
      expect((JOB_ENV_ALLOWLIST as readonly string[]).includes(name), name).toBe(false);
    }
  });

  test("a job id is job_ and 24 lowercase hex", () => {
    expect(COMPUTE_JOB_ID_RE.test(JOB_ID)).toBe(true);
    for (const bad of [
      "",
      "job_",
      "job_0123456789abcdef0123456",
      "job_0123456789abcdef012345678",
      "job_0123456789ABCDEF01234567",
      "Job_0123456789abcdef01234567",
      "job-0123456789abcdef01234567",
      "job_0123456789abcdef01234567\n",
      "../job_0123456789abcdef01234567",
    ]) {
      expect(COMPUTE_JOB_ID_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("result.json: the failure code and its exit number go together", () => {
    const ok = {
      job_id: JOB_ID,
      failure_code: null,
      detail: null,
      exit_number: 0,
      entry_exit_code: 0,
    };
    expect(LauncherResultSchema.safeParse(ok).success).toBe(true);
    LAUNCHER_FAILURE_CODES.forEach((code, i) => {
      const doc = {
        job_id: JOB_ID,
        failure_code: code,
        detail: null,
        exit_number: 10 + i,
        entry_exit_code: code === "runtime_error" ? 3 : null,
      };
      expect(LauncherResultSchema.safeParse(doc).success, code).toBe(true);
      expect(
        LauncherResultSchema.safeParse({ ...doc, exit_number: 10 + ((i + 1) % 7) }).success,
        code,
      ).toBe(false);
      expect(LauncherResultSchema.safeParse({ ...doc, exit_number: 0 }).success, code).toBe(false);
    });
    expect(LauncherResultSchema.safeParse({ ...ok, exit_number: 10 }).success).toBe(false);
    expect(LauncherResultSchema.safeParse({ ...ok, failure_code: "tapis_error" }).success).toBe(
      false,
    );
    expect(LauncherResultSchema.safeParse({ ...ok, detail: "Bad Detail" }).success).toBe(false);
    expect(LauncherResultSchema.safeParse({ ...ok, detail: "unsupported_runtime" }).success).toBe(
      true,
    );
    expect(LauncherResultSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  test("manifest.json lists every output with its size and sha256", () => {
    const doc = {
      job_id: JOB_ID,
      files: [
        { path: "a.txt", size: 0, sha256: HEX_A },
        { path: "sub/b.bin", size: 12, sha256: HEX_B },
      ],
    };
    expect(ResultManifestSchema.safeParse(doc).success).toBe(true);
    expect(ResultManifestSchema.safeParse({ ...doc, files: [] }).success).toBe(true);
    for (const bad of [
      { path: "../a", size: 1, sha256: HEX_A },
      { path: "/a", size: 1, sha256: HEX_A },
      { path: "a", size: -1, sha256: HEX_A },
      { path: "a", size: 1.5, sha256: HEX_A },
      { path: "a", size: 1, sha256: "A".repeat(64) },
      { path: "a", size: 1 },
      { path: "a", size: 1, sha256: HEX_A, extra: 1 },
    ]) {
      expect(
        ResultManifestSchema.safeParse({ ...doc, files: [bad] }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  test("provenance.json carries what the launcher recorded, from outside the container", () => {
    const doc = {
      job_id: JOB_ID,
      launch_spec_digest: HEX_A,
      bundle_digest: HEX_B,
      image: { uri: "docker://ghcr.io/example/runtime", digest: `sha256:${HEX_B}` },
      runtime_version: "3.12.3",
      staging: [{ id: "nm000104", version: "1.0.2", mode: "download", files: 12, bytes: 3456 }],
      timings: { code_fetch: 1.5, staging: 30, run: 600.25, upload: 4 },
      slurm_job_id: "1234567",
      entry_exit_code: 0,
    };
    expect(LauncherProvenanceSchema.safeParse(doc).success).toBe(true);
    expect(
      LauncherProvenanceSchema.safeParse({
        ...doc,
        bundle_digest: null,
        slurm_job_id: null,
        entry_exit_code: null,
      }).success,
    ).toBe(true);
    for (const patch of [
      { launch_spec_digest: "short" },
      { image: { uri: "x", digest: HEX_B } },
      { staging: [{ id: "nm000104", version: "1", mode: "magic", files: 1, bytes: 1 }] },
      { timings: { "Bad Phase": 1 } },
      { timings: { run: -1 } },
      { extra: 1 },
    ]) {
      expect(
        LauncherProvenanceSchema.safeParse({ ...doc, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

describe("the contract index", () => {
  test("re-exports the compute contract", () => {
    expect(contractIndex.JobSpecSchema).toBe(JobSpecSchema);
    expect(contractIndex.ComputePolicySchema).toBe(ComputePolicySchema);
    expect(contractIndex.suMilliFor).toBe(suMilliFor);
  });
});

// --- The launch specification and its JSON Schema ----------------------------------------------

const LAUNCH = {
  job_id: JOB_ID,
  runtime: "python",
  entry: "run.py",
  args: ["--fast"],
  bundle: { sha256: HEX_A, size: 1234 },
  datasets: [{ id: "nm000104", version: "v1.0.2" }],
  api_base: "https://api.example.test",
  image: {
    uri: `docker://ghcr.io/example/runtime@sha256:${HEX_B}`,
    digest: `sha256:${HEX_B}`,
    sif: `${HEX_B}.sif`,
  },
  env: { OMP_NUM_THREADS: "4" },
  resources: { gpus: 0 },
  limits: { max_files: 38000, max_total_bytes: 1073741824 },
  job_token: "t".repeat(43),
};

// biome-ignore lint/suspicious/noExplicitAny: a test document is walked by path
type Doc = Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** A copy of `base` with the value at `path` replaced, or removed when `value` is undefined. */
function set(base: Doc, path: string, value: unknown): Doc {
  const doc = clone(base);
  const parts = path.split(".");
  let cur = doc;
  for (const part of parts.slice(0, -1)) cur = cur[part];
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return doc;
}

// Strict, so a mistyped keyword in the schema throws when it compiles instead of being ignored.
// `strictRequired` stays off: the schema's `required` lists name properties declared in a branch.
const AJV_OPTIONS = { strict: true, strictRequired: false, allErrors: true } as const;
const ajv = new Ajv2020(AJV_OPTIONS);
ajv.addSchema(launchSchema);
const SCHEMA_ID = (launchSchema as { $id: string }).$id;
const validateRoot = ajv.getSchema(SCHEMA_ID);
if (!validateRoot) throw new Error("the launch schema did not compile");
function defValidator(name: string) {
  const validate = ajv.getSchema(`${SCHEMA_ID}#/$defs/${name}`);
  if (!validate) throw new Error(`no $defs/${name} in the launch schema`);
  return validate;
}

/** One document, judged by the JSON Schema and by zod, with the verdict it must get from both. */
type Case = readonly [label: string, doc: unknown, valid: boolean];

function agree(
  cases: readonly Case[],
  ajvValidate: (d: unknown) => boolean,
  zodValidate: (d: unknown) => boolean,
) {
  expect(cases.some(([, , valid]) => valid)).toBe(true);
  expect(cases.some(([, , valid]) => !valid)).toBe(true);
  for (const [label, doc, valid] of cases) {
    expect(ajvValidate(doc), `JSON Schema: ${label}`).toBe(valid);
    expect(zodValidate(doc), `zod: ${label}`).toBe(valid);
  }
}

const LAUNCH_CASES: readonly Case[] = [
  ["the base document", LAUNCH, true],
  [
    "a command with no bundle",
    {
      ...set(set(LAUNCH, "entry", undefined), "bundle", undefined),
      command: ["tool", "--in", "/data"],
    },
    true,
  ],
  ["a command with a bundle", { ...set(LAUNCH, "entry", undefined), command: ["tool"] }, true],
  ["runtime image", set(LAUNCH, "runtime", "image"), true],
  ["no datasets", set(LAUNCH, "datasets", []), true],
  ["no args", set(LAUNCH, "args", []), true],
  ["no env", set(LAUNCH, "env", {}), true],
  [
    "an include pattern",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2", include: ["sub-01/**/*.set"] }]),
    true,
  ],
  ["gpus 4", set(LAUNCH, "resources.gpus", 4), true],
  ["http api_base", set(LAUNCH, "api_base", "http://127.0.0.1:8787"), true],
  ["api_base with a path", set(LAUNCH, "api_base", "https://api.example.test/nemar"), true],
  ["a hex job token", set(LAUNCH, "job_token", "ab".repeat(32)), true],
  ["a nested entry", set(LAUNCH, "entry", "src/analysis/run.py"), true],
  ["an entry of 240 characters", set(LAUNCH, "entry", `${"a".repeat(237)}.py`), true],

  ["an unknown top-level key", { ...LAUNCH, upload: {} }, false],
  // A trailing newline is the one input `$` lets Python's `re` accept and JavaScript's refuse; the
  // schema ends its patterns with `(?![\s\S])` so every engine agrees.
  ["an entry with a trailing newline", set(LAUNCH, "entry", "run.py\n"), false],
  ["an env value with a trailing newline", set(LAUNCH, "env", { OMP_NUM_THREADS: "4\n" }), false],
  ["a job token with a trailing newline", set(LAUNCH, "job_token", `${"t".repeat(43)}\n`), false],
  ["a job id with a trailing newline", set(LAUNCH, "job_id", `${JOB_ID}\n`), false],
  ["a bundle digest with a trailing newline", set(LAUNCH, "bundle.sha256", `${HEX_A}\n`), false],
  [
    "an api_base with a trailing newline",
    set(LAUNCH, "api_base", "https://api.example.test\n"),
    false,
  ],
  [
    "a dataset id with a trailing newline",
    set(LAUNCH, "datasets", [{ id: "nm000104\n", version: "v1.0.2" }]),
    false,
  ],
  ["a bundle url", set(LAUNCH, "bundle.url", "https://x.test/b.tar.gz"), false],
  ["an unknown image key", set(LAUNCH, "image.extra", 1), false],
  ["an unknown limits key", set(LAUNCH, "limits.extra", 1), false],
  ["an unknown resources key", set(LAUNCH, "resources.cores", 4), false],
  [
    "an unknown dataset key",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2", x: 1 }]),
    false,
  ],
  ["runtime matlab", set(LAUNCH, "runtime", "matlab"), false],
  ["runtime unknown", set(LAUNCH, "runtime", "julia"), false],
  ["both entry and command", { ...LAUNCH, command: ["tool"] }, false],
  ["neither entry nor command", set(set(LAUNCH, "entry", undefined), "bundle", undefined), false],
  ["an entry without a bundle", set(LAUNCH, "bundle", undefined), false],
  [
    "an empty command",
    { ...set(set(LAUNCH, "entry", undefined), "bundle", undefined), command: [] },
    false,
  ],
  ["an entry that climbs", set(LAUNCH, "entry", "../run.py"), false],
  ["an absolute entry", set(LAUNCH, "entry", "/run.py"), false],
  ["an entry with a backslash", set(LAUNCH, "entry", "a\\b.py"), false],
  ["an entry with a dot segment", set(LAUNCH, "entry", "a/./b.py"), false],
  ["an empty entry", set(LAUNCH, "entry", ""), false],
  ["an entry of 241 characters", set(LAUNCH, "entry", `${"a".repeat(238)}.py`), false],
  ["a bundle digest in capitals", set(LAUNCH, "bundle.sha256", "A".repeat(64)), false],
  ["a short bundle digest", set(LAUNCH, "bundle.sha256", "a".repeat(63)), false],
  ["a zero-size bundle", set(LAUNCH, "bundle.size", 0), false],
  ["a fractional bundle size", set(LAUNCH, "bundle.size", 1.5), false],
  ["a job id with no prefix", set(LAUNCH, "job_id", "0123456789abcdef01234567"), false],
  ["a job id with capitals", set(LAUNCH, "job_id", "job_0123456789ABCDEF01234567"), false],
  ["an env name off the allowlist", set(LAUNCH, "env", { LD_PRELOAD: "x" }), false],
  ["an env name in lower case", set(LAUNCH, "env", { omp_num_threads: "4" }), false],
  ["an env value with a newline", set(LAUNCH, "env", { OMP_NUM_THREADS: "4\n5" }), false],
  [
    "an env value of 257 characters",
    set(LAUNCH, "env", { OMP_NUM_THREADS: "x".repeat(257) }),
    false,
  ],
  ["an env value that is a number", set(LAUNCH, "env", { OMP_NUM_THREADS: 4 }), false],
  ["negative gpus", set(LAUNCH, "resources.gpus", -1), false],
  ["fractional gpus", set(LAUNCH, "resources.gpus", 1.5), false],
  ["too many gpus", set(LAUNCH, "resources.gpus", 9), false],
  ["zero max_files", set(LAUNCH, "limits.max_files", 0), false],
  ["zero max_total_bytes", set(LAUNCH, "limits.max_total_bytes", 0), false],
  ["no limits", set(LAUNCH, "limits", undefined), false],
  ["no job token", set(LAUNCH, "job_token", undefined), false],
  ["a short job token", set(LAUNCH, "job_token", "short"), false],
  [
    "a job token with a space",
    set(LAUNCH, "job_token", `${"t".repeat(20)} ${"t".repeat(20)}`),
    false,
  ],
  ["an api_base that is not http", set(LAUNCH, "api_base", "ftp://api.example.test"), false],
  ["an api_base with a query", set(LAUNCH, "api_base", "https://api.example.test/?a=1"), false],
  ["an api_base with a space", set(LAUNCH, "api_base", "https://api.example.test/a b"), false],
  ["no api_base", set(LAUNCH, "api_base", undefined), false],
  ["no image", set(LAUNCH, "image", undefined), false],
  ["an unpinned image digest", set(LAUNCH, "image.digest", HEX_B), false],
  ["an image uri with a space", set(LAUNCH, "image.uri", "docker://a b"), false],
  [
    "an image uri with no prefix",
    set(
      LAUNCH,
      "image.uri",
      "ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    true,
  ],
  [
    "an image uri with a port",
    set(
      LAUNCH,
      "image.uri",
      "registry.example.test:5000/team/tool@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    true,
  ],
  [
    "an image uri with a dotted, dashed path",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/a-b/c_d.e@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    true,
  ],
  [
    "an image uri with a leading dash",
    set(
      LAUNCH,
      "image.uri",
      "-docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  ["an image uri that is an option", set(LAUNCH, "image.uri", "--rm"), false],
  [
    "an image uri with a leading dash in the host",
    set(
      LAUNCH,
      "image.uri",
      "docker://-ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a tag and no digest",
    set(LAUNCH, "image.uri", "docker://ghcr.io/example/runtime:latest"),
    false,
  ],
  [
    "an image uri with no digest",
    set(LAUNCH, "image.uri", "docker://ghcr.io/example/runtime"),
    false,
  ],
  [
    "an image uri with a short digest",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a capital in the path",
    set(LAUNCH, "image.uri", `docker://ghcr.io/Example/runtime@sha256:${"b".repeat(64)}`),
    false,
  ],
  [
    "an image uri in capitals",
    set(
      LAUNCH,
      "image.uri",
      "docker://GHCR.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a control character",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/exam\u0001ple/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a newline in it",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/exam\nple/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a trailing newline",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
    ),
    false,
  ],
  [
    "an image uri that is only a host",
    set(
      LAUNCH,
      "image.uri",
      "ghcr.io@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  [
    "an image uri with a query",
    set(
      LAUNCH,
      "image.uri",
      "docker://ghcr.io/example/runtime?x=1@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    false,
  ],
  // The image file is exactly `<64 lowercase hex>.sif`, a basename relative to NEMAR_SIF_ROOT.
  [
    "an image of another digest, with its own sif",
    set(
      set(set(LAUNCH, "image.digest", `sha256:${HEX_A}`), "image.sif", `${HEX_A}.sif`),
      "image.uri",
      `docker://ghcr.io/example/runtime@sha256:${HEX_A}`,
    ),
    true,
  ],
  ["the old fixed sif name", set(LAUNCH, "image.sif", "runtime.sif"), false],
  ["a sif in a directory", set(LAUNCH, "image.sif", `images/${HEX_B}.sif`), false],
  ["a sif with capitals in the hash", set(LAUNCH, "image.sif", `${"B".repeat(64)}.sif`), false],
  ["a sif of 63 hex digits", set(LAUNCH, "image.sif", `${"b".repeat(63)}.sif`), false],
  ["a sif of 65 hex digits", set(LAUNCH, "image.sif", `${"b".repeat(65)}.sif`), false],
  ["a sif with a non-hex digit", set(LAUNCH, "image.sif", `g${"b".repeat(63)}.sif`), false],
  ["a sif that is only the hash", set(LAUNCH, "image.sif", HEX_B), false],
  ["a sif with a capital suffix", set(LAUNCH, "image.sif", `${HEX_B}.SIF`), false],
  ["a sif with a doubled suffix", set(LAUNCH, "image.sif", `${HEX_B}.sif.sif`), false],
  ["a sif with a longer suffix", set(LAUNCH, "image.sif", `${HEX_B}.sifx`), false],
  ["a sif whose dot is another character", set(LAUNCH, "image.sif", `${HEX_B}xsif`), false],
  ["a sif whose dot is a dash", set(LAUNCH, "image.sif", `${HEX_B}-sif`), false],
  ["a sif with a leading dash", set(LAUNCH, "image.sif", `-${HEX_B}.sif`), false],
  ["a sif that is only a suffix", set(LAUNCH, "image.sif", ".sif"), false],
  ["a sif with a trailing newline", set(LAUNCH, "image.sif", `${HEX_B}.sif\n`), false],
  [
    "a sif with a newline in the hash",
    set(LAUNCH, "image.sif", `${"b".repeat(32)}\n${"b".repeat(31)}.sif`),
    false,
  ],
  ["an absolute sif", set(LAUNCH, "image.sif", `/${HEX_B}.sif`), false],
  ["a sif that climbs", set(LAUNCH, "image.sif", `../${HEX_B}.sif`), false],
  ["a sif with a backslash", set(LAUNCH, "image.sif", `a\\${"b".repeat(62)}.sif`), false],
  [
    "a sif with a control character",
    set(LAUNCH, "image.sif", `\u0001${"b".repeat(63)}.sif`),
    false,
  ],
  ["a sif with non-ASCII", set(LAUNCH, "image.sif", `${"b".repeat(63)}é.sif`), false],
  ["an empty sif", set(LAUNCH, "image.sif", ""), false],
  ["a sif that is a number", set(LAUNCH, "image.sif", 5), false],
  ["no sif", set(LAUNCH, "image.sif", undefined), false],
  ["no args key", set(LAUNCH, "args", undefined), false],
  ["no datasets key", set(LAUNCH, "datasets", undefined), false],
  ["no env key", set(LAUNCH, "env", undefined), false],
  ["no resources key", set(LAUNCH, "resources", undefined), false],
  [
    "a dataset id in capitals",
    set(LAUNCH, "datasets", [{ id: "NM000104", version: "v1.0.2" }]),
    false,
  ],
  // The data-plane tag: `latest` or `v<major>.<minor>.<patch>`, exactly what the data plane accepts.
  ["the version latest", set(LAUNCH, "datasets", [{ id: "nm000104", version: "latest" }]), true],
  [
    "a version with large numbers",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v10.200.3000" }]),
    true,
  ],
  ["a version of zeros", set(LAUNCH, "datasets", [{ id: "nm000104", version: "v0.0.0" }]), true],
  [
    "a version with leading zeros",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v01.02.03" }]),
    true,
  ],
  [
    "a bare version with no v",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "1.0.2" }]),
    false,
  ],
  ["a one-number version", set(LAUNCH, "datasets", [{ id: "nm000104", version: "1" }]), false],
  ["a v and one number", set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1" }]), false],
  ["a v and two numbers", set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0" }]), false],
  [
    "a v and four numbers",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2.3" }]),
    false,
  ],
  ["a capital V", set(LAUNCH, "datasets", [{ id: "nm000104", version: "V1.0.2" }]), false],
  ["Latest in capitals", set(LAUNCH, "datasets", [{ id: "nm000104", version: "Latest" }]), false],
  [
    "latest with a suffix",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "latest1" }]),
    false,
  ],
  [
    "latest with a trailing newline",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "latest\n" }]),
    false,
  ],
  [
    "a tag with a trailing newline",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2\n" }]),
    false,
  ],
  [
    "a tag with a leading space",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: " v1.0.2" }]),
    false,
  ],
  [
    "a tag with a prerelease",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2-rc1" }]),
    false,
  ],
  [
    "a tag with build metadata",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2+b" }]),
    false,
  ],
  ["a doubled v", set(LAUNCH, "datasets", [{ id: "nm000104", version: "vv1.0.2" }]), false],
  [
    "a tag with a letter in a number",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.a" }]),
    false,
  ],
  [
    "a tag with an empty number",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1..2" }]),
    false,
  ],
  [
    "a tag with a trailing dot",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0." }]),
    false,
  ],
  [
    "a tag with a leading dot",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v.1.2" }]),
    false,
  ],
  ["only a v", set(LAUNCH, "datasets", [{ id: "nm000104", version: "v" }]), false],
  [
    "a tag with a letter for the first dot",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1x0.2" }]),
    false,
  ],
  [
    "a tag with a letter for the second dot",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0x2" }]),
    false,
  ],
  ["an empty version", set(LAUNCH, "datasets", [{ id: "nm000104", version: "" }]), false],
  ["a branch name", set(LAUNCH, "datasets", [{ id: "nm000104", version: "main" }]), false],
  ["a version that is a number", set(LAUNCH, "datasets", [{ id: "nm000104", version: 1 }]), false],
  [
    "a tag in non-ASCII digits",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v١.٠.٢" }]),
    false,
  ],
  ["a dataset with no version", set(LAUNCH, "datasets", [{ id: "nm000104" }]), false],
  [
    "an include that climbs",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2", include: ["../x"] }]),
    false,
  ],
  [
    "an absolute include",
    set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2", include: ["/x"] }]),
    false,
  ],
  [
    "more than 20 datasets",
    set(
      LAUNCH,
      "datasets",
      Array.from({ length: 21 }, () => ({ id: "nm000104", version: "v1.0.2" })),
    ),
    false,
  ],
  [
    "more than 64 args",
    set(
      LAUNCH,
      "args",
      Array.from({ length: 65 }, () => "a"),
    ),
    false,
  ],
  ["an arg over 1024 characters", set(LAUNCH, "args", ["x".repeat(1025)]), false],
  ["not an object", [LAUNCH], false],
  ["null", null, false],
];

/**
 * What only zod enforces: a document the JSON Schema accepts and zod refuses, because the rule
 * compares two fields and a JSON Schema cannot. Listed here on purpose, so that a difference between
 * the two engines is always a row in this table and never a surprise: `agree` above holds every other
 * document to one verdict. Each row says which key the zod issue names.
 */
const ZOD_ONLY_LAUNCH_CASES: ReadonlyArray<
  readonly [label: string, doc: unknown, keys: readonly string[]]
> = [
  [
    "a sif named for another image's digest",
    set(LAUNCH, "image.sif", `${HEX_A}.sif`),
    ["image.sif"],
  ],
  [
    "a digest that is neither the one the sif is named for nor the one the uri is pinned to",
    set(LAUNCH, "image.digest", `sha256:${HEX_A}`),
    ["image.sif", "image.uri"],
  ],
  [
    "a sif that differs from the digest in its last hex digit",
    set(LAUNCH, "image.sif", `${"b".repeat(63)}c.sif`),
    ["image.sif"],
  ],
  [
    "a sif that differs from the digest in its first hex digit",
    set(LAUNCH, "image.sif", `c${"b".repeat(63)}.sif`),
    ["image.sif"],
  ],
  [
    "an image uri pinned to another digest than image.digest",
    set(LAUNCH, "image.uri", `docker://ghcr.io/example/runtime@sha256:${HEX_A}`),
    ["image.uri"],
  ],
  [
    "an image uri with no prefix pinned to another digest",
    set(LAUNCH, "image.uri", `ghcr.io/example/runtime@sha256:${HEX_A}`),
    ["image.uri"],
  ],
  [
    "an image uri that differs from the digest in its last hex digit",
    set(LAUNCH, "image.uri", `docker://ghcr.io/example/runtime@sha256:${"b".repeat(63)}c`),
    ["image.uri"],
  ],
  [
    "an image uri that differs from the digest in its first hex digit",
    set(LAUNCH, "image.uri", `docker://ghcr.io/example/runtime@sha256:c${"b".repeat(63)}`),
    ["image.uri"],
  ],
];

describe("the launcher's job-token header is a wire contract", () => {
  test("its spelling is pinned here, written out", async () => {
    const { COMPUTE_JOB_TOKEN_HEADER } = await import("../shared/contract/compute-launch");
    expect(COMPUTE_JOB_TOKEN_HEADER).toBe("X-Compute-Job-Token");
  });
});

describe("the launch specification", () => {
  test("the version is nemar.launch-spec.v1 and the runtimes are python and image", () => {
    expect(LAUNCH_SPEC_VERSION).toBe("nemar.launch-spec.v1");
    expect([...LAUNCH_RUNTIMES]).toEqual(["python", "image"]);
    expect(LAUNCH_SPEC_MAX_BYTES).toBe(64 * 1024);
    // The value on the wire is the text in base64url: 87,382 characters for 65,536 bytes (A1c).
    expect(LAUNCH_SPEC_ENV_MAX_CHARS).toBe(87_382);
    expect(LAUNCHER_ENV.SPEC).toBe("NEMAR_LAUNCH_SPEC");
  });

  test("zod and the JSON Schema give every document the same, expected, verdict", () => {
    agree(
      LAUNCH_CASES,
      (d) => validateRoot(d) as boolean,
      (d) => LaunchSpecSchema.safeParse(d).success,
    );
  });

  test("the rules only zod enforces are listed, and each is one the JSON Schema accepts", () => {
    expect(ZOD_ONLY_LAUNCH_CASES.length).toBeGreaterThanOrEqual(8);
    for (const [label, doc, keys] of ZOD_ONLY_LAUNCH_CASES) {
      expect(validateRoot(doc), `JSON Schema: ${label}`).toBe(true);
      const refused = LaunchSpecSchema.safeParse(doc);
      expect(refused.success, `zod: ${label}`).toBe(false);
      if (refused.success) continue;
      // One issue for each field the rule names, in order, and never a digest in a message.
      expect(
        refused.error.issues.map((i) => i.path.join(".")),
        label,
      ).toEqual([...keys]);
      for (const issue of refused.error.issues) {
        expect(issue.message, label).not.toContain(HEX_A);
        expect(issue.message, label).not.toContain(HEX_B);
      }
    }
  });

  test("sifFileNameForDigest is the digest's hex plus .sif, and null for anything else", () => {
    expect(sifFileNameForDigest(`sha256:${HEX_B}`)).toBe(`${HEX_B}.sif`);
    expect(sifFileNameForDigest(`sha256:${HEX_A}`)).toBe(`${HEX_A}.sif`);
    expect(sifFileNameForDigest(`sha256:${"0123456789abcdef".repeat(4)}`)).toBe(
      `${"0123456789abcdef".repeat(4)}.sif`,
    );
    for (const bad of [
      "",
      HEX_B,
      `sha256:${"b".repeat(63)}`,
      `sha256:${"b".repeat(65)}`,
      `sha256:${"B".repeat(64)}`,
      `sha256:${HEX_B}\n`,
      `\nsha256:${HEX_B}`,
      `sha512:${HEX_B}`,
      `SHA256:${HEX_B}`,
      `sha256:g${"b".repeat(63)}`,
      `sha256: ${HEX_B}`,
      `docker://x@sha256:${HEX_B}`,
    ]) {
      expect(sifFileNameForDigest(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(sifFileNameForDigest(5 as never)).toBeNull();
    // Not a string, though it reads as one: an object, an array of the digest.
    expect(sifFileNameForDigest({ toString: () => `sha256:${HEX_B}` } as never)).toBeNull();
    expect(sifFileNameForDigest([`sha256:${HEX_B}`] as never)).toBeNull();
    expect(sifFileNameForDigest(null as never)).toBeNull();
    expect(sifFileNameForDigest(undefined as never)).toBeNull();
  });

  test("the zod rule is the helper: a document is accepted exactly when its sif is the helper's", () => {
    for (const hex of [HEX_A, HEX_B, "0123456789abcdef".repeat(4)]) {
      const named = sifFileNameForDigest(`sha256:${hex}`);
      const doc = set(
        set(set(LAUNCH, "image.digest", `sha256:${hex}`), "image.sif", named),
        "image.uri",
        `docker://ghcr.io/example/runtime@sha256:${hex}`,
      );
      expect(LaunchSpecSchema.safeParse(doc).success, hex).toBe(true);
    }
  });

  test("a bad digest or a bad sif is named once, by its own issue, and not again by the cross rule", () => {
    const paths = (doc: unknown) => {
      const refused = LaunchSpecSchema.safeParse(doc);
      return refused.success ? [] : refused.error.issues.map((i) => i.path.join("."));
    };
    expect(paths(set(LAUNCH, "image.digest", HEX_B))).toEqual(["image.digest"]);
    expect(paths(set(LAUNCH, "image.sif", "runtime.sif"))).toEqual(["image.sif"]);
    expect(paths(set(LAUNCH, "image.sif", `${HEX_B}.sif\n`))).toEqual(["image.sif"]);
    expect(paths(set(LAUNCH, "image.sif", `${HEX_A}.sif`))).toEqual(["image.sif"]);
    expect(paths(LAUNCH)).toEqual([]);
  });

  test("a malformed sif and a well-formed sif of another digest are refused for their own reasons", () => {
    const FORM = "the image file is not <64 lowercase hex>.sif";
    const NAMED = "the image file is not the one named for the image digest";
    const messages = (sif: unknown) => {
      const refused = LaunchSpecSchema.safeParse(set(LAUNCH, "image.sif", sif));
      return refused.success ? [] : refused.error.issues.map((i) => i.message);
    };
    for (const bad of [
      "runtime.sif",
      `images/${HEX_B}.sif`,
      `${"B".repeat(64)}.sif`,
      `${"b".repeat(63)}.sif`,
      `${"b".repeat(65)}.sif`,
      `g${"b".repeat(63)}.sif`,
      HEX_B,
      `${HEX_B}.SIF`,
      `${HEX_B}.sif.sif`,
      `${HEX_B}.sifx`,
      `${HEX_B}xsif`,
      `${HEX_B}-sif`,
      `-${HEX_B}.sif`,
      `${HEX_B}.sif\n`,
      `../${HEX_B}.sif`,
      ".sif",
      "",
    ]) {
      expect(messages(bad), JSON.stringify(bad)).toEqual([FORM]);
    }
    for (const other of [`${HEX_A}.sif`, `${"b".repeat(63)}c.sif`, `c${"b".repeat(63)}.sif`]) {
      expect(messages(other), other).toEqual([NAMED]);
    }
  });

  test("an image uri that is not pinned to image.digest is refused for its own reason, once", () => {
    const messages = (uri: unknown) => {
      const refused = LaunchSpecSchema.safeParse(set(LAUNCH, "image.uri", uri));
      return refused.success ? [] : refused.error.issues.map((i) => i.message);
    };
    const FORM = "the image reference is not a digest-pinned reference";
    const NAMED = "the image reference is not pinned to the image digest";
    // A well-formed reference of another digest: only the cross rule speaks.
    for (const other of [
      `docker://ghcr.io/example/runtime@sha256:${HEX_A}`,
      `ghcr.io/example/runtime@sha256:${"b".repeat(63)}c`,
    ]) {
      expect(messages(other), other).toEqual([NAMED]);
    }
    // A malformed one: the field's own rule speaks, and the cross rule keeps quiet.
    for (const bad of ["docker://ghcr.io/example/runtime", "--rm", `ghcr.io@sha256:${HEX_B}`, ""]) {
      expect(messages(bad), bad).toEqual([FORM]);
    }
    // And a bad digest is named once, by the digest's own rule, whatever the uri ends with.
    for (const digest of [
      HEX_B,
      "sha256:zzz",
      "nope",
      "",
      `sha256:${HEX_B}\n`,
      `sha256:${"b".repeat(63)}`,
    ]) {
      const refused = LaunchSpecSchema.safeParse(set(LAUNCH, "image.digest", digest));
      expect(
        refused.success ? [] : refused.error.issues.map((i) => i.path.join(".")),
        JSON.stringify(digest),
      ).toEqual(["image.digest"]);
    }
  });

  test("the shared descriptions of version, sif and uri state the contract and carry no Worker narrative", () => {
    const image = (launchSchema as Doc).properties.image.properties;
    const version = (launchSchema as Doc).properties.datasets.items.properties.version;
    for (const [name, text] of [
      ["version", version.description],
      ["sif", image.sif.description],
      ["uri", image.uri.description],
    ] as const) {
      expect(typeof text, name).toBe("string");
      for (const narrative of [
        "Worker",
        "encoder",
        "NEMAR enforces",
        "writes the tag",
        "1.0.2 becomes",
      ]) {
        expect(text, `${name}: ${narrative}`).not.toContain(narrative);
      }
    }
    expect(version.description).toContain("latest, or v<major>.<minor>.<patch>");
    expect(version.description).toContain("exactly what the data plane accepts");
    // The two cross-field rules are named as rules only zod enforces.
    expect(image.sif.description).toContain("zod-only");
    expect(image.uri.description).toContain("zod-only");
    expect(image.uri.description).toContain("cannot express");
    expect(image.uri.description).toContain("image.digest");
  });

  test("the schema says plainly which rule it cannot express", () => {
    const sif = (launchSchema as Doc).properties.image.properties.sif;
    expect(sif.description).toContain("NEMAR_SIF_ROOT");
    expect(sif.description).toContain("image.digest");
    expect(sif.description).toContain("cannot express");
    expect(sif.description).toContain("does not verify");
    expect(sif.description).toContain("image_missing");
    // The rule is zod's, and a Worker's, so the schema keeps no cross-field keyword for it.
    expect(JSON.stringify(sif)).not.toContain("$data");
  });

  test("encodeLaunchSpec refuses a sif that is not the digest's, and never echoes either", () => {
    let message = "";
    try {
      encodeLaunchSpec(set(LAUNCH, "image.sif", `${HEX_A}.sif`));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("image.sif");
    expect(message).not.toContain(HEX_A);
  });

  test("encodeLaunchSpec writes JSON the schema accepts, within 64 KiB", () => {
    const text = encodeLaunchSpec(LAUNCH);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(LAUNCH_SPEC_MAX_BYTES);
    expect(validateRoot(JSON.parse(text))).toBe(true);
    expect(LaunchSpecSchema.parse(JSON.parse(text)) as unknown).toEqual(LAUNCH);
  });

  test("encodeLaunchSpec refuses a document that is not valid", () => {
    expect(() => encodeLaunchSpec({ ...LAUNCH, upload: {} })).toThrow();
    expect(() => encodeLaunchSpec(set(LAUNCH, "runtime", "matlab"))).toThrow();
  });

  test("encodeLaunchSpec names the failing key and never echoes a value or the token", () => {
    const token = "SECRETTOKENVALUE0123456789";
    const bad = { ...set(LAUNCH, "runtime", "matlab"), job_token: token };
    let message = "";
    try {
      encodeLaunchSpec(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("runtime");
    expect(message).not.toContain(token);
    expect(message).not.toContain("matlab");
  });

  test("encodeLaunchSpec writes ASCII-only JSON: every unit from U+007F up is a lowercase escape", () => {
    const tricky = [
      "caf\u00e9",
      "\u007f",
      "\u0080",
      "\u00ff",
      "\u2028\u2029",
      "\uffff",
      "\ud83d\ude00",
      "\ud800",
      'tab\there "quoted" back\\slash \u0001',
      "plain ~ tilde",
    ];
    const text = encodeLaunchSpec(set(LAUNCH, "args", tricky));
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    // Lowercase hex, four digits, a surrogate pair as two escapes, DEL as an escape too.
    expect(text).toContain("caf\\u00e9");
    expect(text).toContain("\\u007f");
    expect(text).toContain("\\ud83d\\ude00");
    expect(text).toContain("\\u2028\\u2029");
    expect(text).toContain("\\uffff");
    expect(/\\u[0-9a-f]{0,3}[A-F]/.test(text)).toBe(false);
    // Nothing is lost: the text parses back to the same arguments.
    expect(JSON.parse(text).args).toEqual(tricky);
  });

  test("the 64 KiB cap is checked after escaping, because a non-ASCII character costs six bytes", () => {
    // 12 arguments of 1024 e-acute are about 12 K characters (24 KiB as UTF-8) and 72 KiB once
    // escaped. A check on the raw text would let it through.
    const wide = set(
      LAUNCH,
      "args",
      Array.from({ length: 12 }, () => "\u00e9".repeat(1024)),
    );
    expect(LaunchSpecSchema.safeParse(wide).success).toBe(true);
    expect(JSON.stringify(wide).length).toBeLessThan(LAUNCH_SPEC_MAX_BYTES);
    expect(() => encodeLaunchSpec(wide)).toThrow(RangeError);
    const plain = set(
      LAUNCH,
      "args",
      Array.from({ length: 12 }, () => "e".repeat(1024)),
    );
    expect(encodeLaunchSpec(plain).length).toBeLessThan(LAUNCH_SPEC_MAX_BYTES);
  });

  test("a document of exactly 65536 bytes is accepted and one byte more is refused", () => {
    const withTail = (m: number) =>
      set(LAUNCH, "args", [...Array.from({ length: 63 }, () => "x".repeat(1024)), "x".repeat(m)]);
    const m = LAUNCH_SPEC_MAX_BYTES - encodeLaunchSpec(withTail(0)).length;
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1024);
    expect(encodeLaunchSpec(withTail(m)).length).toBe(LAUNCH_SPEC_MAX_BYTES);
    expect(() => encodeLaunchSpec(withTail(m + 1))).toThrow(RangeError);
  });

  test("encodeLaunchSpec refuses a document over 64 KiB", () => {
    // 64 arguments of 1024 characters are 64 KiB before any other key is counted.
    const big = set(
      LAUNCH,
      "args",
      Array.from({ length: 64 }, () => "x".repeat(1024)),
    );
    expect(LaunchSpecSchema.safeParse(big).success).toBe(true);
    expect(() => encodeLaunchSpec(big)).toThrow(RangeError);
  });
});

describe("a valid job specification always fits the 64 KiB launch specification and is well formed", () => {
  const E = "\u00e9";
  const baseJob = (extra: Record<string, unknown>) => ({ ...SPEC, ...extra });

  test("launchStringBytes is exactly what encodeLaunchSpec spends on a string", () => {
    const empty = encodeLaunchSpec(set(LAUNCH, "args", [])).length;
    const strings = [
      "",
      "plain",
      '"',
      "\\",
      "\b\t\n\f\r",
      "\u0000\u0001\u001f",
      "\u007f",
      E,
      "\u{1F600}",
      "\ud800",
      "\udc00",
      `a${E}"\\\n~`,
      E.repeat(50),
    ];
    for (let c = 0; c < 0x100; c++) strings.push(String.fromCharCode(c));
    for (const text of strings) {
      const spent = encodeLaunchSpec(set(LAUNCH, "args", [text])).length - empty;
      expect(launchStringBytes(text), JSON.stringify(text)).toBe(spent);
    }
  });

  test("launchVariableBytes counts the entry, command, arguments, patterns and environment", () => {
    expect(launchVariableBytes({})).toBe(0);
    expect(launchVariableBytes({ entry: "run.py" })).toBe(8 + 1);
    expect(launchVariableBytes({ command: ["a", "bc"] })).toBe(3 + 1 + 4 + 1);
    expect(launchVariableBytes({ args: ["x"] })).toBe(3 + 1);
    expect(
      launchVariableBytes({ datasets: [{ include: ["a/*"] }, {}, { include: ["b", "c"] }] }),
    ).toBe(5 + 1 + 3 + 1 + 3 + 1);
    expect(launchVariableBytes({ env: { OMP_NUM_THREADS: "4", MPLBACKEND: undefined } })).toBe(
      17 + 3 + 2,
    );
    expect(launchVariableBytes({ args: [E] })).toBe(2 + 6 + 1);
  });

  test("the bound sits exactly at 48 KiB: one byte over is refused with an issue on the document", () => {
    expect(LAUNCH_VARIABLE_BYTES_MAX).toBe(49_152);
    const full = Array.from({ length: 47 }, () => "x".repeat(1024));
    const tailFor = (bytes: number) => {
      const used = launchVariableBytes({ entry: "run.py", args: full });
      return "x".repeat(bytes - used - 3);
    };
    const at = baseJob({ args: [...full, tailFor(LAUNCH_VARIABLE_BYTES_MAX)] });
    expect(launchVariableBytes(at as never)).toBe(LAUNCH_VARIABLE_BYTES_MAX);
    expect(JobSpecSchema.safeParse(at).success).toBe(true);
    const over = baseJob({ args: [...full, tailFor(LAUNCH_VARIABLE_BYTES_MAX + 1)] });
    expect(launchVariableBytes(over as never)).toBe(LAUNCH_VARIABLE_BYTES_MAX + 1);
    const refused = JobSpecSchema.safeParse(over);
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues).toHaveLength(1);
      expect(refused.error.issues[0].path).toEqual([]);
      expect(refused.error.issues[0].message).not.toContain("xxxx");
    }
  });

  test("an escape-heavy specification is over the bound long before it is long", () => {
    // 6000 characters of e-acute are 36 KB; 9000 are 54 KB and are refused, though under 10 KB raw.
    const some = Array.from({ length: 6 }, () => E.repeat(1000));
    expect(specRefused(baseJob({ args: some }))).toBe(false);
    const more = Array.from({ length: 9 }, () => E.repeat(1000));
    expect(specRefused(baseJob({ args: more }))).toBe(true);
    // The same 9000 plain characters are well inside it.
    expect(specRefused(baseJob({ args: Array.from({ length: 9 }, () => "e".repeat(1000)) }))).toBe(
      false,
    );
  });

  /** The largest n for which build(n) is a valid job specification, by bisection. */
  function largest(
    build: (n: number) => Record<string, unknown>,
    hi: number,
  ): Record<string, unknown> {
    let lo = 0;
    let top = hi;
    if (JobSpecSchema.safeParse(build(top)).success) return build(top);
    while (top - lo > 1) {
      const mid = Math.floor((lo + top) / 2);
      if (JobSpecSchema.safeParse(build(mid)).success) lo = mid;
      else top = mid;
    }
    return build(lo);
  }
  /** n e-acute characters over elements of at most `per` characters. */
  const spread = (n: number, per: number): string[] => {
    const out: string[] = [];
    for (let left = n; left > 0; left -= per) out.push(E.repeat(Math.min(per, left)));
    return out;
  };

  /** What a Worker would send, at its worst, written here apart from launchSpecFits. */
  function workerWorstDoc(job: JobSpec): Record<string, unknown> {
    const hex = "f".repeat(64);
    const ref = `docker://ghcr.io/${"a".repeat(423)}@sha256:${hex}`;
    expect(ref.length).toBe(512);
    return {
      job_id: `job_${"f".repeat(24)}`,
      runtime: job.runtime === "image" ? "image" : "python",
      ...(job.entry !== undefined ? { entry: job.entry } : { command: job.command ?? ["x"] }),
      args: job.args,
      bundle: { sha256: hex, size: Number.MAX_SAFE_INTEGER },
      datasets: job.datasets.map((d) => ({
        ...d,
        // The Worker writes the data-plane tag: v<version> unless it already is one.
        version: d.version === "latest" || d.version.startsWith("v") ? d.version : `v${d.version}`,
      })),
      api_base: `https://${"a".repeat(504)}`,
      image: { uri: ref, digest: `sha256:${hex}`, sif: `${hex}.sif` },
      env: job.env,
      resources: { gpus: job.gpus },
      limits: { max_files: 1_000_000, max_total_bytes: Number.MAX_SAFE_INTEGER },
      job_token: "t".repeat(256),
    };
  }
  const workerWorstCase = (job: JobSpec): string => encodeLaunchSpec(workerWorstDoc(job));

  const twentyDatasets = Array.from({ length: 20 }, (_, i) => ({
    id: `nm0001${String(i).padStart(2, "0")}`,
    version: `${"9".repeat(59)}.0.0`,
  }));
  const imageRef = `docker://ghcr.io/${"a".repeat(423)}@sha256:${"b".repeat(64)}`;

  const WORST: Array<[string, Record<string, unknown>]> = [
    [
      "the arguments, full of e-acute",
      largest((n) => baseJob({ args: spread(n, 1024) }), 64 * 1024),
    ],
    [
      "the arguments, full of quotes",
      largest(
        (n) =>
          baseJob({
            args: Array.from({ length: Math.ceil(n / 1024) }, () => '"'.repeat(1024)).slice(0, 64),
          }),
        64 * 1024,
      ),
    ],
    [
      "the command of an image job",
      largest(
        (n) => ({
          name: "tool",
          runtime: "image",
          image: imageRef,
          command: spread(n, 1024).slice(0, 64),
          partition: "shared",
          minutes: 30,
        }),
        64 * 1024,
      ),
    ],
    [
      "the include patterns of twenty datasets",
      largest(
        (n) =>
          baseJob({
            datasets: twentyDatasets.map((d, i) => ({
              ...d,
              include: i === 0 ? spread(n, 256).slice(0, 64) : [],
            })),
          }),
        64 * 256,
      ),
    ],
    [
      "twenty datasets, every one with a full set of patterns",
      largest(
        (n) =>
          baseJob({
            datasets: twentyDatasets.map((d) => ({ ...d, include: spread(n, 256).slice(0, 64) })),
          }),
        64 * 256,
      ),
    ],
    ["the entry", baseJob({ entry: E.repeat(240), datasets: twentyDatasets })],
    [
      "every environment value, of quotes",
      baseJob({
        datasets: twentyDatasets,
        env: Object.fromEntries(JOB_ENV_ALLOWLIST.map((k) => [k, '"'.repeat(256)])),
      }),
    ],
    [
      "a bit of everything at once",
      largest(
        (n) =>
          baseJob({
            entry: E.repeat(240),
            datasets: twentyDatasets.map((d, i) => ({
              ...d,
              include: i < 3 ? spread(n, 256).slice(0, 64) : [],
            })),
            args: spread(n, 1024).slice(0, 64),
            env: Object.fromEntries(JOB_ENV_ALLOWLIST.map((k) => [k, '"'.repeat(256)])),
          }),
        64 * 256,
      ),
    ],
  ];

  test("each worst-case valid specification fits, with a kilobyte to spare", () => {
    expect(WORST.length).toBe(8);
    for (const [label, doc] of WORST) {
      const parsed = JobSpecSchema.parse(doc);
      expect(launchVariableBytes(parsed), label).toBeLessThanOrEqual(LAUNCH_VARIABLE_BYTES_MAX);
      expect(launchSpecFits(parsed), label).toBe(true);
      const size = workerWorstCase(parsed).length;
      expect(size, label).toBeLessThanOrEqual(LAUNCH_SPEC_MAX_BYTES - 1024);
    }
  });

  test("the bisected ones really are at the edge, so the worst case is the worst case", () => {
    for (const [label, doc] of WORST) {
      if (!label.includes("full of") && !label.includes("command") && !label.includes("patterns"))
        continue;
      const parsed = JobSpecSchema.parse(doc);
      expect(launchVariableBytes(parsed), label).toBeGreaterThan(LAUNCH_VARIABLE_BYTES_MAX - 6200);
    }
  });

  test("launchSpecFits is false for a specification that skipped the schema and is too large", () => {
    const parsed = JobSpecSchema.parse(SPEC);
    expect(launchSpecFits(parsed)).toBe(true);
    const big = { ...parsed, args: Array.from({ length: 64 }, () => "x".repeat(1024)) };
    expect(launchSpecFits(big)).toBe(false);
    const wide = { ...parsed, args: Array.from({ length: 12 }, () => E.repeat(1024)) };
    expect(launchSpecFits(wide)).toBe(false);
    // A dataset version with no data-plane tag cannot be launched, whatever its size.
    const withVersion = (version: string) => ({
      ...parsed,
      datasets: [{ id: "nm000104", version }],
    });
    for (const ok of ["1.0.2", "v1.0.2", "latest"]) {
      expect(launchSpecFits(withVersion(ok)), ok).toBe(true);
    }
    for (const bad of ["1", "1.0", "abc", "", "v1", "1.0.2-rc1"]) {
      expect(launchSpecFits(withVersion(bad)), bad).toBe(false);
    }
    // Anything the launch specification would refuse is also a no.
    expect(launchSpecFits({ ...parsed, gpus: 99 })).toBe(false);
    expect(launchSpecFits({ ...parsed, entry: "../x" })).toBe(false);
  });

  describe("launchSpecFits takes every Worker field at its worst case and counts every job field, to the byte", () => {
    // A job that carries something in every field launchSpecFits reads, of each of the three shapes
    // a launch specification has: an entry, a command, and neither (a recipe, which gets a one-word
    // command).
    const jobs: Array<[label: string, job: JobSpec, bytes: number]> = [
      [
        "a python job with an entry, an environment and include patterns",
        JobSpecSchema.parse({
          ...SPEC,
          entry: "analysis/main_pipeline_with_a_long_name.py",
          env: { OMP_NUM_THREADS: "4" },
          datasets: [
            { id: "nm000104", version: "1.0.2", include: ["sub-01/**/*.set", "sub-02/*"] },
          ],
        }),
        1932,
      ],
      [
        "an image job with a command and a GPU",
        JobSpecSchema.parse({
          name: "tool",
          runtime: "image",
          image: `ghcr.io/e/t@sha256:${HEX_B}`,
          command: ["tool", "--fast", "--out=outputs"],
          partition: "gpu-shared",
          gpus: 2,
          minutes: 30,
        }),
        1824,
      ],
      [
        "a recipe job, which names neither an entry nor a command",
        JobSpecSchema.parse({
          name: "r",
          runtime: "python",
          recipe: "nemar-floor",
          datasets: [{ id: "nm000104", version: "1.0.0" }],
          partition: "shared",
          minutes: 5,
        }),
        1833,
      ],
    ];

    /** The worst-case document's size in bytes; every character in it is ASCII, so this is its length. */
    const worstBytes = (job: JobSpec) => JSON.stringify(workerWorstDoc(job)).length;

    /** Arguments of plain characters that bring the worst-case document to exactly `target` bytes. */
    function argsReaching(job: JobSpec, target: number): string[] {
      const empty = worstBytes({ ...job, args: [] });
      // k arguments of C characters in all add C + 3k - 1 bytes to the empty array's two.
      for (let k = 1; k <= 64; k++) {
        const chars = target - empty - 3 * k + 1;
        if (chars > (k - 1) * 1024 && chars <= k * 1024) {
          const args = Array.from({ length: k }, (_, i) =>
            "x".repeat(i < k - 1 ? 1024 : chars - (k - 1) * 1024),
          );
          expect(worstBytes({ ...job, args })).toBe(target);
          return args;
        }
      }
      throw new Error(`no arguments reach ${target}`);
    }

    for (const [label, job, bytes] of jobs) {
      test(`${label}: the worst-case document is ${bytes} bytes with no arguments`, () => {
        // The literal pins every field of the worst case, the Worker's and the job's: shrinking or
        // dropping any one of them changes it. launchSpecFits is held to the same document below.
        expect(workerWorstCase({ ...job, args: [] }).length).toBe(bytes);
        expect(launchSpecFits({ ...job, args: [] })).toBe(true);
      });

      test(`${label}: launchSpecFits flips at exactly ${LAUNCH_SPEC_MAX_BYTES} bytes`, () => {
        // To the byte, so a Worker field that launchSpecFits shrinks by even one byte, or drops,
        // makes the document one over the cap fit, and one it grows makes the one at the cap not.
        expect(launchSpecFits({ ...job, args: argsReaching(job, LAUNCH_SPEC_MAX_BYTES) })).toBe(
          true,
        );
        // The document at the cap is the value at its bound, shell-inert, and it decodes back (A1c).
        const atCap = workerWorstCase({ ...job, args: argsReaching(job, LAUNCH_SPEC_MAX_BYTES) });
        const value = encodeLaunchSpecEnv(atCap);
        expect(value.length).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
        expect(isShellInertEnvValue(value)).toBe(true);
        expect(decodeLaunchSpecEnv(value)).toEqual({ ok: true, text: atCap });
        expect(launchSpecFits({ ...job, args: argsReaching(job, LAUNCH_SPEC_MAX_BYTES - 1) })).toBe(
          true,
        );
        expect(launchSpecFits({ ...job, args: argsReaching(job, LAUNCH_SPEC_MAX_BYTES + 1) })).toBe(
          false,
        );
      });
    }

    test("each Worker field of the worst case is the largest the launch specification allows", () => {
      const [, job] = jobs[0];
      const worst = workerWorstDoc({ ...job, args: [] }) as Record<string, unknown> & {
        bundle: Record<string, unknown>;
        image: Record<string, unknown>;
        limits: Record<string, unknown>;
      };
      expect(LaunchSpecSchema.safeParse(worst).success).toBe(true);
      const hex = "f".repeat(64);
      const bigger: Array<[string, Record<string, unknown>]> = [
        ["api_base", { ...worst, api_base: `https://${"a".repeat(505)}` }],
        [
          "image.uri",
          {
            ...worst,
            image: { ...worst.image, uri: `docker://ghcr.io/${"a".repeat(424)}@sha256:${hex}` },
          },
        ],
        ["image.sif", { ...worst, image: { ...worst.image, sif: `${"f".repeat(65)}.sif` } }],
        ["job_token", { ...worst, job_token: "t".repeat(257) }],
        [
          "bundle.size",
          { ...worst, bundle: { ...worst.bundle, size: Number.MAX_SAFE_INTEGER + 1 } },
        ],
        ["limits.max_files", { ...worst, limits: { ...worst.limits, max_files: 1_000_001 } }],
        [
          "limits.max_total_bytes",
          { ...worst, limits: { ...worst.limits, max_total_bytes: Number.MAX_SAFE_INTEGER + 1 } },
        ],
      ];
      for (const [field, doc] of bigger) {
        expect(LaunchSpecSchema.safeParse(doc).success, `${field} one past its largest`).toBe(
          false,
        );
      }
    });
  });

  test("launchSpecFits copes with every shape of job: entry, command, recipe, matlab and image", () => {
    const hex = "b".repeat(64);
    const jobs = [
      SPEC,
      {
        name: "t",
        runtime: "image",
        image: `ghcr.io/e/t@sha256:${hex}`,
        command: ["t"],
        partition: "shared",
        minutes: 5,
      },
      {
        name: "r",
        runtime: "python",
        recipe: "nemar-floor",
        datasets: [{ id: "nm000104", version: "1.0.0" }],
        partition: "shared",
        minutes: 5,
      },
      { ...SPEC, runtime: "matlab" },
    ];
    for (const job of jobs)
      expect(launchSpecFits(JobSpecSchema.parse(job)), String(job.runtime)).toBe(true);
  });
});

describe("what an entry, a command, args and an include pattern mean is part of the contract", () => {
  const props = (launchSchema as Doc).properties;
  const includeSchema = props.datasets.items.properties.include;
  const LAUNCH_ONE = " Exactly one of entry and command is present.";
  /** The zod object of each schema, behind the refinement that wraps it. */
  const jobShape = (JobSpecSchema as unknown as { _def: { schema: z.AnyZodObject } })._def.schema
    .shape;
  const launchShape = (LaunchSpecSchema as unknown as { _def: { schema: z.AnyZodObject } })._def
    .schema.shape;

  test("the entry: python /code/<entry>, or /code/<entry> directly for an image", () => {
    const text = COMPUTE_ENTRY_DESCRIPTION;
    expect(text).toContain("python /code/<entry>");
    expect(text).toContain("followed by args");
    expect(text).toContain("runtime image");
    expect(text).toContain("/code/<entry> directly");
    expect(text).toContain("executable bit");
    expect(text).toContain("bundle packer must preserve");
    expect(text).toContain("python on its PATH");
    expect(text).toContain("leading ./");
    for (const refused of ["absolute names", ".. segments", "links", "devices", "FIFOs"]) {
      expect(text, refused).toContain(refused);
    }
    expect(text).toContain("refused by the launcher");
  });

  test("the command runs as given with args appended", () => {
    expect(COMPUTE_COMMAND_DESCRIPTION).toContain("run as given");
    expect(COMPUTE_COMMAND_DESCRIPTION).toContain("args appended");
  });

  test("the args follow the entry or the command, each as one argument", () => {
    const text = COMPUTE_ARGS_DESCRIPTION;
    expect(text).toContain("python /code/<entry>");
    expect(text).toContain("after /code/<entry>");
    expect(text).toContain("after the command");
    expect(text).toContain("each as one argument");
  });

  test("the include dialect: manifest paths, **, * and ?, classes, case, no escapes, linear time", () => {
    const text = COMPUTE_INCLUDE_DESCRIPTION;
    expect(text).toContain("manifest paths relative to the dataset root");
    expect(text).toContain("**/ matches zero or more directories (so a/**/b matches a/b)");
    expect(text).toContain("** elsewhere matches any run of characters including /");
    expect(text).toContain("* and ? stay inside one path segment");
    expect(text).toContain("[abc], [a-c] and [!abc]");
    expect(text).toContain(
      "a character class never matches /, so like * and ? it stays inside one path segment",
    );
    expect(text).toContain("a negated class [!a] matches any single character except a and /");
    expect(text).toContain("an unterminated [ is a literal [");
    expect(text).toContain("an empty class [] and an inverted range such as [z-a] are refused");
    expect(text).toContain("bad_include is exactly the set of patterns this dialect refuses");
    expect(text).toContain("case-sensitive");
    expect(text).toContain("no escapes");
    expect(text).toContain("MUST run in time linear");
    expect(text).toContain("pattern's length times the path's length");
    expect(text).toContain("no backtracking");
    // And nothing about a limit on wildcards: there is none.
    expect(text).not.toContain("at most");
  });

  test("the schema's descriptions are these texts, word for word", () => {
    expect(props.entry.description).toBe(COMPUTE_ENTRY_DESCRIPTION + LAUNCH_ONE);
    expect(props.command.description).toBe(COMPUTE_COMMAND_DESCRIPTION + LAUNCH_ONE);
    expect(props.args.description).toBe(COMPUTE_ARGS_DESCRIPTION);
    expect(includeSchema.description).toBe(COMPUTE_INCLUDE_DESCRIPTION);
  });

  test("zod carries the same texts, on the launch specification and on the job specification", () => {
    expect(launchShape.entry.description).toBe(COMPUTE_ENTRY_DESCRIPTION + LAUNCH_ONE);
    expect(launchShape.command.description).toBe(COMPUTE_COMMAND_DESCRIPTION + LAUNCH_ONE);
    expect(launchShape.args.description).toBe(COMPUTE_ARGS_DESCRIPTION);
    expect(jobShape.entry.description).toBe(COMPUTE_ENTRY_DESCRIPTION);
    expect(jobShape.command.description).toBe(COMPUTE_COMMAND_DESCRIPTION);
    expect(jobShape.args.description).toBe(COMPUTE_ARGS_DESCRIPTION);
    // The element of `datasets`, through the default a job gives it.
    const include = (shape: z.AnyZodObject["shape"]) => {
      // biome-ignore lint/suspicious/noExplicitAny: zod's definitions are walked by key
      let field: any = shape.datasets;
      while (field._def.innerType) field = field._def.innerType;
      return field._def.type.shape.include.description;
    };
    expect(include(launchShape)).toBe(COMPUTE_INCLUDE_DESCRIPTION);
    expect(include(jobShape)).toBe(COMPUTE_INCLUDE_DESCRIPTION);
  });

  test("the job specification's docblock states the same semantics", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "shared", "contract", "compute.ts"),
      "utf8",
    );
    const end = source.indexOf("export const JobSpecSchema = z");
    expect(end).toBeGreaterThan(0);
    // The comment's line breaks and asterisks are not part of what it says.
    const docblock = source
      .slice(source.lastIndexOf("/**", end), end)
      .replace(/\n\s*\*\s?/g, " ")
      .replace(/\s+/g, " ");
    for (const phrase of [
      "`runtime: python` with an `entry` runs `python /code/<entry>` followed by `args`",
      "a `command` runs as given with `args` appended",
      "`runtime: image` with an `entry` is allowed and runs `/code/<entry>` directly",
      "executable bit that the bundle packer must preserve",
      "must provide `python` on its PATH",
      "may carry a leading `./`",
      "links, devices and FIFOs are refused by the launcher",
      "matched against manifest paths relative to the dataset root",
      "`**` followed by `/` matches zero or more directories",
      "`**` elsewhere matches any run of characters including `/`",
      "`*` and `?` stay inside one path segment",
      "`[abc]`, `[a-c]` and `[!abc]`",
      "a character class never matches `/`",
      "a negated class `[!a]` matches any single character except `a` and `/`",
      "an unterminated `[` is a literal `[`",
      "an empty class `[]` and an inverted range such as `[z-a]` are refused",
      "`bad_include` is exactly the set of patterns the dialect refuses",
      "`includePatternProblem`",
      "case-sensitive",
      "no escapes",
      "linear in the pattern length times the path length",
      "`dataTagForVersion`",
    ]) {
      expect(docblock, phrase).toContain(phrase);
    }
  });

  test("an image job may name an entry: it is a valid job and a valid launch specification", () => {
    const job = {
      name: "tool",
      runtime: "image",
      image: `ghcr.io/e/t@sha256:${HEX_B}`,
      entry: "bin/run",
      bundle: { size: 10, sha256: HEX_A },
      partition: "shared",
      minutes: 5,
    };
    expect(specRefused(job)).toBe(false);
    expect(LaunchSpecSchema.safeParse(set(LAUNCH, "runtime", "image")).success).toBe(true);
    // It still needs the bundle that holds it.
    expect(specRefused({ ...job, bundle: undefined })).toBe(true);
  });
});

describe("the golden vector nemar-process checks its launcher against", () => {
  // One fixed launch specification with a non-ASCII character, a double quote and a space in its
  // arguments, the exact text encodeLaunchSpec writes for it and the SHA-256 of that text, all as
  // literals. The environment value is that text in base64url (see the encoded vectors below), and
  // the launcher decodes it and hashes the DECODED text before it parses it, so it must report
  // GOLDEN_SHA256 for GOLDEN_TEXT and parse the text back to GOLDEN_SPEC.
  const GOLDEN_SPEC = {
    job_id: "job_0123456789abcdef01234567",
    runtime: "python",
    entry: "run.py",
    args: ["--label", 'caf\u00e9 "q" \u{1F600}'],
    bundle: { sha256: "a".repeat(64), size: 1234 },
    datasets: [{ id: "nm000104", version: "v1.0.2" }],
    api_base: "https://api.example.test",
    image: {
      uri: `docker://ghcr.io/example/runtime@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
      sif: `${"b".repeat(64)}.sif`,
    },
    env: { OMP_NUM_THREADS: "4" },
    resources: { gpus: 0 },
    limits: { max_files: 38000, max_total_bytes: 1073741824 },
    job_token: "t".repeat(43),
  };
  const GOLDEN_TEXT = String.raw`{"job_id":"job_0123456789abcdef01234567","runtime":"python","entry":"run.py","args":["--label","caf\u00e9 \"q\" \ud83d\ude00"],"bundle":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1234},"datasets":[{"id":"nm000104","version":"v1.0.2"}],"api_base":"https://api.example.test","image":{"uri":"docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sif":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.sif"},"env":{"OMP_NUM_THREADS":"4"},"resources":{"gpus":0},"limits":{"max_files":38000,"max_total_bytes":1073741824},"job_token":"ttttttttttttttttttttttttttttttttttttttttttt"}`;
  const GOLDEN_SHA256 = "88fcf9a4d6e63ae7bbedc9be536989fd7f2c263bb2b1c2fb6cfd706f49efe857";

  test("encodeLaunchSpec writes exactly the golden text", () => {
    expect(encodeLaunchSpec(GOLDEN_SPEC)).toBe(GOLDEN_TEXT);
    expect(GOLDEN_TEXT.length).toBe(766);
  });

  test("the golden text hashes to the golden digest, and parses back to the specification", () => {
    expect(createHash("sha256").update(GOLDEN_TEXT, "ascii").digest("hex")).toBe(GOLDEN_SHA256);
    expect(JSON.parse(GOLDEN_TEXT)).toEqual(GOLDEN_SPEC);
    expect(/^[\x20-\x7e]*$/.test(GOLDEN_TEXT)).toBe(true);
    expect(validateRoot(JSON.parse(GOLDEN_TEXT))).toBe(true);
  });

  test("the text carries the three awkward characters as the schema says", () => {
    expect(GOLDEN_TEXT).toContain(String.raw`caf\u00e9 \"q\" \ud83d\ude00`);
  });

  // THE ENCODED VECTORS (A1c, #2043): the value `NEMAR_LAUNCH_SPEC` carries for a text, as literals,
  // with its length and the SHA-256 of the value's own ASCII bytes. The launcher's decoder is held
  // to the same strings in nemar-process. The digests above stay over the TEXT: `spec` digests are
  // never over a value, and GOLDEN_ENV_SHA256 is a different number from GOLDEN_SHA256 on purpose.
  const GOLDEN_ENV =
    "eyJqb2JfaWQiOiJqb2JfMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3IiwicnVudGltZSI6InB5dGhvbiIsImVudHJ5IjoicnVuLnB5IiwiYXJncyI6WyItLWxhYmVsIiwiY2FmXHUwMGU5IFwicVwiIFx1ZDgzZFx1ZGUwMCJdLCJidW5kbGUiOnsic2hhMjU2IjoiYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsInNpemUiOjEyMzR9LCJkYXRhc2V0cyI6W3siaWQiOiJubTAwMDEwNCIsInZlcnNpb24iOiJ2MS4wLjIifV0sImFwaV9iYXNlIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS50ZXN0IiwiaW1hZ2UiOnsidXJpIjoiZG9ja2VyOi8vZ2hjci5pby9leGFtcGxlL3J1bnRpbWVAc2hhMjU2OmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIiLCJkaWdlc3QiOiJzaGEyNTY6YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsInNpZiI6ImJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIuc2lmIn0sImVudiI6eyJPTVBfTlVNX1RIUkVBRFMiOiI0In0sInJlc291cmNlcyI6eyJncHVzIjowfSwibGltaXRzIjp7Im1heF9maWxlcyI6MzgwMDAsIm1heF90b3RhbF9ieXRlcyI6MTA3Mzc0MTgyNH0sImpvYl90b2tlbiI6InR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHQifQ";
  const GOLDEN_ENV_LENGTH = 1022;
  const GOLDEN_ENV_SHA256 = "b20fae0dfbe428d0b8f37b52741abc52567b99674cd1b531ee53d9b6e8e36e26";

  test("the encoded golden value is the golden text in base64url, to the byte", () => {
    expect(encodeLaunchSpecEnv(GOLDEN_TEXT)).toBe(GOLDEN_ENV);
    expect(encodeLaunchSpecEnv(encodeLaunchSpec(GOLDEN_SPEC))).toBe(GOLDEN_ENV);
    expect(GOLDEN_ENV.length).toBe(GOLDEN_ENV_LENGTH);
    // 766 bytes is 255 groups of three and one byte left over: 1020 characters plus two, no padding.
    expect(GOLDEN_ENV_LENGTH).toBe(Math.ceil((GOLDEN_TEXT.length * 4) / 3));
    expect(createHash("sha256").update(GOLDEN_ENV, "ascii").digest("hex")).toBe(GOLDEN_ENV_SHA256);
    // An independent oracle for the same bytes (Node's own base64url, which writes no padding).
    expect(Buffer.from(GOLDEN_TEXT, "ascii").toString("base64url")).toBe(GOLDEN_ENV);
  });

  test("the encoded golden value is shell-inert, and the digest of the value is not the digest of the text", () => {
    expect(isShellInertEnvValue(GOLDEN_ENV)).toBe(true);
    expect(GOLDEN_ENV.length).toBeLessThanOrEqual(LAUNCH_SPEC_ENV_MAX_CHARS);
    expect(GOLDEN_ENV_SHA256).not.toBe(GOLDEN_SHA256);
  });

  test("the launcher's route back: the value decodes to the golden text, which hashes to the golden digest and parses to the specification", () => {
    const decoded = decodeLaunchSpecEnv(GOLDEN_ENV);
    expect(decoded).toEqual({ ok: true, text: GOLDEN_TEXT });
    const text = decoded.ok ? decoded.text : "";
    expect(createHash("sha256").update(text, "ascii").digest("hex")).toBe(GOLDEN_SHA256);
    expect(JSON.parse(text)).toEqual(GOLDEN_SPEC);
  });

  // The first vector's value happens to hold neither `-` nor `_`, the two characters base64url
  // writes where base64 writes `+` and `/`. This one is chosen so that it holds both, and its
  // arguments carry what a shell treats as special: it pins the substitution, not only the rest.
  const URLSAFE_SPEC = {
    job_id: "job_0123456789abcdef01234567",
    runtime: "python",
    command: ["python3", "-c"],
    args: ["print($(id))", "`x`;&|<>", "a\\b", "\n\t", ">>>???~~~"],
    datasets: [],
    api_base: "https://api.example.test",
    image: {
      uri: `docker://ghcr.io/example/runtime@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
      sif: `${"b".repeat(64)}.sif`,
    },
    env: {},
    resources: { gpus: 0 },
    limits: { max_files: 38000, max_total_bytes: 1073741824 },
    job_token: "t".repeat(43),
  };
  // Written as a single-quoted string: the JSON text holds double quotes, backslashes and a backtick,
  // and no apostrophe, so each is one escape level away from the text itself.
  const URLSAFE_TEXT =
    '{"job_id":"job_0123456789abcdef01234567","runtime":"python","command":["python3","-c"],"args":["print($(id))","`x`;&|<>","a\\\\b","\\n\\t",">>>???~~~"],"datasets":[],"api_base":"https://api.example.test","image":{"uri":"docker://ghcr.io/example/runtime@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sif":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.sif"},"env":{},"resources":{"gpus":0},"limits":{"max_files":38000,"max_total_bytes":1073741824},"job_token":"ttttttttttttttttttttttttttttttttttttttttttt"}';
  const URLSAFE_SHA256 = "501b92700038336d2579133ce14f3664bca06827f120be07d079ace09722f91e";
  const URLSAFE_ENV =
    "eyJqb2JfaWQiOiJqb2JfMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3IiwicnVudGltZSI6InB5dGhvbiIsImNvbW1hbmQiOlsicHl0aG9uMyIsIi1jIl0sImFyZ3MiOlsicHJpbnQoJChpZCkpIiwiYHhgOyZ8PD4iLCJhXFxiIiwiXG5cdCIsIj4-Pj8_P35-fiJdLCJkYXRhc2V0cyI6W10sImFwaV9iYXNlIjoiaHR0cHM6Ly9hcGkuZXhhbXBsZS50ZXN0IiwiaW1hZ2UiOnsidXJpIjoiZG9ja2VyOi8vZ2hjci5pby9leGFtcGxlL3J1bnRpbWVAc2hhMjU2OmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIiLCJkaWdlc3QiOiJzaGEyNTY6YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsInNpZiI6ImJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIuc2lmIn0sImVudiI6e30sInJlc291cmNlcyI6eyJncHVzIjowfSwibGltaXRzIjp7Im1heF9maWxlcyI6MzgwMDAsIm1heF90b3RhbF9ieXRlcyI6MTA3Mzc0MTgyNH0sImpvYl90b2tlbiI6InR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHQifQ";
  const URLSAFE_ENV_SHA256 = "073876511ad06a09f389b7207311fc906ca0c78e05397414bb2d32f31c85273e";

  test("a second vector holds both url-safe characters, and the standard alphabet's two never appear", () => {
    expect(encodeLaunchSpec(URLSAFE_SPEC)).toBe(URLSAFE_TEXT);
    expect(URLSAFE_TEXT.length).toBe(631);
    expect(createHash("sha256").update(URLSAFE_TEXT, "ascii").digest("hex")).toBe(URLSAFE_SHA256);
    expect(encodeLaunchSpecEnv(URLSAFE_TEXT)).toBe(URLSAFE_ENV);
    expect(URLSAFE_ENV.length).toBe(842);
    expect(createHash("sha256").update(URLSAFE_ENV, "ascii").digest("hex")).toBe(
      URLSAFE_ENV_SHA256,
    );
    expect(URLSAFE_ENV).toContain("-");
    expect(URLSAFE_ENV).toContain("_");
    expect(URLSAFE_ENV).not.toMatch(/[+/=]/);
    // The same bytes in the standard alphabet DO hold `+` and `/`: the substitution is what is pinned.
    const standard = Buffer.from(URLSAFE_TEXT, "ascii").toString("base64");
    expect(standard).toMatch(/\+/);
    expect(standard).toContain("/");
    expect(standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")).toBe(URLSAFE_ENV);
    expect(decodeLaunchSpecEnv(URLSAFE_ENV)).toEqual({ ok: true, text: URLSAFE_TEXT });
    expect(JSON.parse(URLSAFE_TEXT)).toEqual(URLSAFE_SPEC);
    expect(isShellInertEnvValue(URLSAFE_ENV)).toBe(true);
  });
});

// --- The launch specification on the wire (A1c, #2043) ---------------------------------------

describe("the launch specification on the wire: base64url in the shell-inert alphabet", () => {
  // The base64url alphabet of Request for Comments (RFC) 4648 section 5, in its order. Written out
  // here, apart from the constant it checks.
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  /** Node's own base64url, an oracle the code under test does not share a line with. */
  const oracle = (text: string) => Buffer.from(text, "latin1").toString("base64url");
  /** The same pseudo-random sequence on every run, so a failure can be repeated. */
  function sequence(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
  }
  /** `bytes` printable ASCII characters, any of 0x20 to 0x7e: the only text the encoder takes. */
  function printableText(next: () => number, bytes: number): string {
    return Array.from({ length: bytes }, () => String.fromCharCode(0x20 + (next() % 95))).join("");
  }

  test("the bound is ceil(65536 * 4 / 3), 87382, and the alphabet is the 64 base64url characters", () => {
    expect(LAUNCH_SPEC_ENV_MAX_CHARS).toBe(Math.ceil((LAUNCH_SPEC_MAX_BYTES * 4) / 3));
    expect(LAUNCH_SPEC_ENV_MAX_CHARS).toBe(87_382);
    expect(SHELL_INERT_ENV_ALPHABET).toBe(ALPHABET);
    expect(new Set(SHELL_INERT_ENV_ALPHABET).size).toBe(64);
    // The alphabet leaves out every character of base64's own padding and of its two unsafe digits.
    for (const left of ["=", "+", "/"]) expect(SHELL_INERT_ENV_ALPHABET).not.toContain(left);
  });

  test("isShellInertEnvValue is true for exactly the alphabet, and never for the empty value", () => {
    for (let code = 0; code < 0x300; code++) {
      const ch = String.fromCharCode(code);
      expect(isShellInertEnvValue(ch), `U+${code.toString(16).padStart(4, "0")}`).toBe(
        ALPHABET.includes(ch),
      );
    }
    expect(isShellInertEnvValue(ALPHABET)).toBe(true);
    expect(isShellInertEnvValue(`${ALPHABET}${ALPHABET}`)).toBe(true);
    expect(isShellInertEnvValue("-")).toBe(true);
    expect(isShellInertEnvValue("")).toBe(false);
    // Each of these is one character of the alphabet plus one that is not, in each position.
    for (const bad of [
      "a=",
      "=a",
      "a b",
      " a",
      "a ",
      "a\n",
      "\na",
      "a\r",
      "a\0",
      "aé",
      "a+b",
      "a\u{1F600}",
      "\ud800",
    ]) {
      expect(isShellInertEnvValue(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const notText of [undefined, null, 7, {}, [], ["a"], true]) {
      expect(isShellInertEnvValue(notText as unknown), String(notText)).toBe(false);
    }
  });

  test("the old wire value, the JSON text itself, is not shell-inert", () => {
    expect(isShellInertEnvValue(encodeLaunchSpec(LAUNCH))).toBe(false);
    // Not even a document with no space in it, which a scheduler that quotes conditionally leaves bare.
    expect(isShellInertEnvValue('{"a":1}')).toBe(false);
  });

  test("encodeLaunchSpecEnv is base64url without padding, equal to an independent oracle", () => {
    const next = sequence(0x9e3779b9);
    const texts = [
      // Each of the 95 printable characters alone: 0x20 (space) to 0x7e (tilde).
      ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)),
      ...Array.from({ length: 200 }, (_, i) => printableText(next, 1 + (i % 40))),
      ...Array.from({ length: 60 }, () => printableText(next, 1 + (next() % 3000))),
    ];
    for (const text of texts) {
      const value = encodeLaunchSpecEnv(text);
      expect(value, JSON.stringify(text)).toBe(oracle(text));
      expect(isShellInertEnvValue(value), JSON.stringify(text)).toBe(true);
      // ceil(n * 4 / 3): the length is a function of the byte count alone.
      expect(value.length).toBe(Math.ceil((text.length * 4) / 3));
      // Canonical: the unused trailing bits are zero, so Node writes back the same characters.
      expect(Buffer.from(value, "base64url").toString("base64url")).toBe(value);
    }
  });

  test("the bound is the cap's arithmetic: every length within 64 KiB encodes within 87382, and 65537 would not", () => {
    // No second check in the encoder, so this is what stands in for one: ceil(n * 4 / 3) only grows,
    // it is exactly the bound at the cap, and one byte over the cap is over the bound.
    let previous = 0;
    for (let bytes = 1; bytes <= LAUNCH_SPEC_MAX_BYTES; bytes++) {
      const chars = Math.ceil((bytes * 4) / 3);
      if (chars < previous || chars > LAUNCH_SPEC_ENV_MAX_CHARS) throw new Error(`at ${bytes}`);
      previous = chars;
    }
    expect(previous).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
    expect(Math.ceil(((LAUNCH_SPEC_MAX_BYTES + 1) * 4) / 3)).toBe(LAUNCH_SPEC_ENV_MAX_CHARS + 1);
    // The encoder agrees with the arithmetic where it matters: the lengths around the cap.
    for (const bytes of [65_530, 65_531, 65_532, 65_533, 65_534, 65_535, 65_536]) {
      expect(encodeLaunchSpecEnv("a".repeat(bytes)).length, `${bytes} bytes`).toBe(
        Math.ceil((bytes * 4) / 3),
      );
    }
  });

  test("a text of exactly 65536 bytes is 87382 characters and 65537 is refused by the text cap", () => {
    const next = sequence(7);
    const fits = printableText(next, LAUNCH_SPEC_MAX_BYTES);
    const value = encodeLaunchSpecEnv(fits);
    expect(value.length).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
    expect(value).toBe(oracle(fits));
    // One byte over is refused by the text cap, with the cap's own message, never by a second check.
    expect(() => encodeLaunchSpecEnv(`${fits}a`)).toThrow(RangeError);
    expect(() => encodeLaunchSpecEnv(`${fits}a`)).toThrow(
      "the launch specification is over 64 KiB",
    );
  });

  test("the largest launch specification, 65536 bytes of JSON, travels as 87382 characters and comes back as the same text", () => {
    const withTail = (m: number) =>
      set(LAUNCH, "args", [...Array.from({ length: 63 }, () => "x".repeat(1024)), "x".repeat(m)]);
    const m = LAUNCH_SPEC_MAX_BYTES - encodeLaunchSpec(withTail(0)).length;
    const text = encodeLaunchSpec(withTail(m));
    expect(text.length).toBe(LAUNCH_SPEC_MAX_BYTES);
    const value = encodeLaunchSpecEnv(text);
    expect(value.length).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
    expect(isShellInertEnvValue(value)).toBe(true);
    expect(decodeLaunchSpecEnv(value)).toEqual({ ok: true, text });
    // One byte of JSON more is refused where the text is made, before it is ever encoded.
    expect(() => encodeLaunchSpec(withTail(m + 1))).toThrow(RangeError);
  });

  test("encodeLaunchSpecEnv refuses every byte outside 0x20 to 0x7e with a TypeError, and accepts both ends", () => {
    // The rule is on the unit (the text is ASCII-only JSON, so a unit is a byte): a control byte, DEL,
    // and everything from 0x80 up, alone and inside an otherwise good text.
    for (let unit = 0; unit < 0x300; unit++) {
      const ch = String.fromCharCode(unit);
      const printable = unit >= 0x20 && unit <= 0x7e;
      for (const text of [ch, `ab${ch}cd`, `${ch}abc`, `abc${ch}`]) {
        const label = `U+${unit.toString(16).padStart(4, "0")} in ${JSON.stringify(text)}`;
        if (printable) expect(encodeLaunchSpecEnv(text), label).toBe(oracle(text));
        else expect(() => encodeLaunchSpecEnv(text), label).toThrow(TypeError);
      }
    }
    expect(() => encodeLaunchSpecEnv("a\u{1F600}")).toThrow(TypeError);
    // The ends of the range: the space and the tilde.
    expect(encodeLaunchSpecEnv(" ")).toBe("IA");
    expect(encodeLaunchSpecEnv("~")).toBe("fg");
    // DEL, the byte just above the range, is refused (the decoder refuses it too: see below).
    expect(() => encodeLaunchSpecEnv("\u007f")).toThrow(TypeError);
    // Not text at all.
    expect(() => encodeLaunchSpecEnv("")).toThrow(TypeError);
    expect(() => encodeLaunchSpecEnv(undefined as unknown as string)).toThrow(TypeError);
    expect(() => encodeLaunchSpecEnv(7 as unknown as string)).toThrow(TypeError);
  });

  test("no refusal of the encoder holds any part of the text, which holds a token", () => {
    const secret = "SECRETTOKEN0123456789";
    const refused: Array<[string, unknown]> = [
      ["a control byte", `${secret}\u0000`],
      ["DEL", `${secret}\u007f`],
      ["a character from 0x80 up", `${secret}\u00e9`],
      ["a character outside the Basic Multilingual Plane", `${secret}\u{1F600}`],
      ["over the cap", secret.repeat(LAUNCH_SPEC_MAX_BYTES)],
      ["not a string", { toString: () => secret }],
    ];
    for (const [label, text] of refused) {
      let error: unknown;
      try {
        encodeLaunchSpecEnv(text as string);
      } catch (caught) {
        error = caught;
      }
      expect(error, label).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message, label).not.toContain("SECRET");
      expect(message, label).not.toContain("0123456789");
    }
  });

  test("decodeLaunchSpecEnv is the inverse of encodeLaunchSpecEnv, and agrees with the oracle", () => {
    const next = sequence(0x1234abcd);
    for (let i = 0; i < 300; i++) {
      const text = printableText(next, 1 + (i % 50) + (i % 7 === 0 ? next() % 2000 : 0));
      const value = oracle(text);
      expect(decodeLaunchSpecEnv(value), JSON.stringify(text)).toEqual({ ok: true, text });
      expect(decodeLaunchSpecEnv(encodeLaunchSpecEnv(text))).toEqual({ ok: true, text });
    }
    const real = encodeLaunchSpec(LAUNCH);
    expect(decodeLaunchSpecEnv(encodeLaunchSpecEnv(real))).toEqual({ ok: true, text: real });
    expect(LaunchSpecSchema.parse(JSON.parse(real) as unknown)).toEqual(LAUNCH);
  });

  describe("the decoder is strict: every refusal is a fixed word", () => {
    const refusal = (value: string) => {
      const out = decodeLaunchSpecEnv(value);
      return out.ok ? "ok" : out.reason;
    };

    test("an empty value", () => {
      expect(refusal("")).toBe("empty");
    });

    test("a value over 87382 characters, though every character is in the alphabet", () => {
      expect(refusal("A".repeat(LAUNCH_SPEC_ENV_MAX_CHARS + 1))).toBe("too_long");
      expect(refusal("A".repeat(LAUNCH_SPEC_ENV_MAX_CHARS + 2))).toBe("too_long");
      expect(refusal("A".repeat(LAUNCH_SPEC_ENV_MAX_CHARS + 5))).toBe("too_long");
      // The longest accepted value is the encoding of the largest text, 64 KiB of printable ASCII.
      const text = printableText(sequence(3), LAUNCH_SPEC_MAX_BYTES);
      const longest = oracle(text);
      expect(longest.length).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
      expect(decodeLaunchSpecEnv(longest)).toEqual({ ok: true, text });
    });

    test("the unit of the length bound: an over-length ASCII value is too_long, and an over-length value with a non-ASCII character is refused with too_long or not_base64url", () => {
      const max = LAUNCH_SPEC_ENV_MAX_CHARS;
      // ASCII: one answer, whatever the unit, so the word is pinned. A character the alphabet lacks
      // does not change it, because the length is checked first (it bounds the work).
      for (const value of ["A".repeat(max + 1), "{".repeat(max + 1), `${"A".repeat(max)}=`]) {
        expect(refusal(value), `${value.length} ASCII characters`).toBe("too_long");
      }
      // Non-ASCII: neither word can be told apart as the right one, because languages count a length
      // in different units. The reference counts UTF-16 code units; a launcher may count code points
      // or bytes. What must hold is that the value is refused, with one of the two words. Each row is
      // over the bound in one unit and not in another, so the pair of units a launcher might use is
      // covered: code units over and code points not (an astral character), code units not over and
      // bytes over (a two-byte character), and over in all three.
      const rows: Array<[string, string]> = [
        [
          "over in code units, not in code points (an astral character)",
          `${"A".repeat(max - 1)}\u{1F600}`,
        ],
        [
          "not over in code units, over in bytes (an e with an acute accent)",
          `${"A".repeat(max - 1)}\u00e9`,
        ],
        ["over in every unit, with one accented character", `${"A".repeat(max)}\u00e9`],
        ["over in every unit, all non-ASCII", "\u00e9".repeat(max + 1)],
        ["all astral characters", "\u{1F600}".repeat(max)],
        ["a non-ASCII character first", `\u00e9${"A".repeat(max)}`],
      ];
      for (const [label, value] of rows) {
        const out = decodeLaunchSpecEnv(value);
        expect(out.ok, label).toBe(false);
        expect(["too_long", "not_base64url"], label).toContain(out.ok ? "ok" : out.reason);
      }
      // And a non-ASCII value that is within the bound in every unit can only be not_base64url.
      expect(refusal("QQ\u00e9")).toBe("not_base64url");
      expect(refusal("\u00e9".repeat(1000))).toBe("not_base64url");
    });

    test("a character outside the alphabet: padding, the standard alphabet's two, whitespace, a line break, non-ASCII", () => {
      const cases = [
        "QQ==",
        "QQ=",
        "QUI=",
        "====",
        "ab+/",
        "ab+d",
        "ab/d",
        "ab cd",
        " abcd",
        "abcd ",
        "abcd\n",
        // A canonical value with a line break or a blank after it: not the value, whatever it decodes to.
        "QQ\n",
        "QQ\r\n",
        "QQ ",
        "QQ\t",
        "QUI\n",
        "\nabcd",
        "ab\ncd",
        "abcd\r\n",
        "ab\tcd",
        "abéd",
        "abcd\u0000",
        "ab.cd",
        "ab,cd",
        "ab:cd",
        "ab$cd",
        'ab"cd',
        "ab'cd",
        "ab\\cd",
        "ab`cd",
      ];
      for (const value of cases)
        expect(refusal(value), JSON.stringify(value)).toBe("not_base64url");
      // Every other single character is outside it too, whatever the length rule says of one character.
      for (let code = 0; code < 0x300; code++) {
        const ch = String.fromCharCode(code);
        if (ALPHABET.includes(ch)) continue;
        expect(refusal(ch), `U+${code.toString(16).padStart(4, "0")}`).toBe("not_base64url");
        expect(refusal(`QUJD${ch}`), `U+${code.toString(16).padStart(4, "0")}`).toBe(
          "not_base64url",
        );
      }
    });

    test("a raw JSON value, the old wire format, is refused: nothing is registered, so there is no legacy format", () => {
      const raw = encodeLaunchSpec(LAUNCH);
      expect(raw.startsWith("{")).toBe(true);
      expect(refusal(raw)).toBe("not_base64url");
      expect(refusal("{}")).toBe("not_base64url");
      expect(refusal("{")).toBe("not_base64url");
      // Even a JSON document short enough, and plain enough, that it has no space in it.
      expect(refusal('{"a":1}')).toBe("not_base64url");
    });

    test("a length that is 1 modulo 4 can be no whole number of bytes", () => {
      for (const length of [1, 5, 9, 13, 101, 4001]) {
        expect(refusal("A".repeat(length)), `length ${length}`).toBe("bad_length");
      }
      // The other three residues are fine: 0, 2 and 3 characters left over, for texts of 3n, 3n+1
      // and 3n+2 bytes. (`AAAA` is a good length and a bad value: it is three NUL bytes.)
      for (const bytes of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        const value = oracle("abcdefghijkl".slice(0, bytes));
        expect(refusal(value), `${bytes} bytes, ${value.length} characters`).toBe("ok");
      }
    });

    test("the padding is added back by length before decoding: two signs for 2 modulo 4, one for 3 modulo 4, none for 0", () => {
      // The oracle is Node's base64 decoder, given the value with its padding written out by the rule.
      const signsFor = (length: number) => ({ 0: 0, 2: 2, 3: 1 })[(length % 4) as 0 | 2 | 3];
      const decodeWithPadding = (value: string) =>
        Buffer.from(
          value.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat(signsFor(value.length) as number),
          "base64",
        ).toString("latin1");
      for (let bytes = 1; bytes <= 30; bytes++) {
        const text = "abcdefghijklmnopqrstuvwxyz0123".slice(0, bytes);
        const value = oracle(text);
        expect(signsFor(value.length), `${bytes} bytes`).toBe(
          value.length % 4 === 0 ? 0 : value.length % 4 === 2 ? 2 : 1,
        );
        expect(decodeWithPadding(value), `${bytes} bytes`).toBe(text);
        expect(decodeLaunchSpecEnv(value), `${bytes} bytes`).toEqual({ ok: true, text });
      }
      // The three residues as fixed vectors (the golden vectors are both 2 modulo 4).
      expect(decodeLaunchSpecEnv("QUJD")).toEqual({ ok: true, text: "ABC" }); // 0: no sign
      expect(decodeLaunchSpecEnv("QUI")).toEqual({ ok: true, text: "AB" }); // 3: one sign
      expect(decodeLaunchSpecEnv("QQ")).toEqual({ ok: true, text: "A" }); // 2: two signs
      // The sender never writes the padding: a value that carries it is not a value.
      for (const withSigns of ["QUI=", "QQ==", "QQ=", "QUJD=", "QUJD===="]) {
        expect(refusal(withSigns), withSigns).toBe("not_base64url");
      }
      // A length of 1 modulo 4 is refused before the padding step, whatever follows it.
      for (const value of ["Q", "QUJDQ", "QUJDQUJDQ"])
        expect(refusal(value), value).toBe("bad_length");
    });

    test("a decoded byte outside 0x20 to 0x7e is refused as not printable, whichever byte it is", () => {
      // All 256 byte values alone, each as the encoder-canonical value of that byte: only 0x20 to 0x7e
      // (space to tilde) are text. NUL, the other control bytes and DEL (0x7f) are not, and nothing
      // from 0x80 up is.
      for (let byte = 0; byte < 0x100; byte++) {
        const value = Buffer.from([byte]).toString("base64url");
        const printable = byte >= 0x20 && byte <= 0x7e;
        expect(refusal(value), `byte 0x${byte.toString(16).padStart(2, "0")}`).toBe(
          printable ? "ok" : "not_printable",
        );
      }
      expect(decodeLaunchSpecEnv("fg")).toEqual({ ok: true, text: "~" });
      expect(decodeLaunchSpecEnv("IA")).toEqual({ ok: true, text: " " });
      expect(refusal("fw")).toBe("not_printable"); // DEL, 0x7f
      expect(refusal("AA")).toBe("not_printable"); // NUL
      expect(refusal("gA")).toBe("not_printable"); // 0x80
      expect(refusal("w6k")).toBe("not_printable"); // an e with an acute accent, as two UTF-8 bytes
      expect(refusal(Buffer.from([0x41, 0xff, 0x42]).toString("base64url"))).toBe("not_printable");
      // One bad byte at the start, the middle and the end of a long, otherwise printable, value.
      for (const bad of [0x00, 0x0a, 0x1f, 0x7f, 0x80, 0xff]) {
        for (const at of [0, 1499, 2999]) {
          const bytes = Buffer.alloc(3000, 0x61);
          bytes[at] = bad;
          expect(refusal(bytes.toString("base64url")), `0x${bad.toString(16)} at ${at}`).toBe(
            "not_printable",
          );
        }
      }
    });

    test("an unset environment variable is a non-string: refused with not_base64url, and anything else that is not a string is too", () => {
      // `undefined` is what reading an unset variable gives (a launcher's `None` or missing key is the same).
      expect(refusal(undefined as unknown as string)).toBe("not_base64url");
      for (const notText of [undefined, null, 7, {}, [], ["QUJD"], true]) {
        expect(refusal(notText as unknown as string), String(notText)).toBe("not_base64url");
      }
    });

    test("the words are a closed list of five, each reached, and a refusal holds no part of the value", () => {
      expect([...LAUNCH_SPEC_ENV_REFUSALS]).toEqual([
        "empty",
        "too_long",
        "not_base64url",
        "bad_length",
        "not_printable",
      ]);
      // One value per word, each made of the secret where the rule lets it be: the refusal is the
      // word and nothing else, so none of the value can be in it.
      const rows: Array<[string, string]> = [
        ["", "empty"],
        ["SECRET".repeat(20_000), "too_long"],
        ["SECRETSECRET{", "not_base64url"],
        ["SECRETSECRETS", "bad_length"],
        ["SECRETSECRET", "not_printable"],
      ];
      for (const [value, reason] of rows) {
        const out = decodeLaunchSpecEnv(value);
        expect(out, reason).toEqual({ ok: false, reason });
        expect(JSON.stringify(out), reason).not.toContain("SECRET");
        expect(Object.keys(out).sort(), reason).toEqual(["ok", "reason"]);
      }
      expect(new Set(rows.map(([, reason]) => reason))).toEqual(new Set(LAUNCH_SPEC_ENV_REFUSALS));
      const ok = decodeLaunchSpecEnv("QUJD");
      expect(Object.keys(ok).sort()).toEqual(["ok", "text"]);
    });

    test("only the canonical value of a text is accepted: the unused trailing bits are zero", () => {
      // "A" is the byte 0x41, two characters, and the last of them has four bits to spare. The
      // canonical value is QQ; QR decodes to the same byte and is not the value the encoder writes.
      expect(decodeLaunchSpecEnv("QQ")).toEqual({ ok: true, text: "A" });
      expect(refusal("QR")).toBe("not_base64url");
      // The same for a text of two bytes (three characters, two spare bits): QUI is canonical.
      expect(decodeLaunchSpecEnv("QUI")).toEqual({ ok: true, text: "AB" });
      expect(refusal("QUJ")).toBe("not_base64url");
      // Every value of every one-byte and two-byte printable text: the spare bits of the last
      // character take each of their values, and exactly the zero one is the encoder's. The other
      // characters, and so the decoded bytes, do not change, so nothing but canonicity is tested.
      const at = (ch: string) => ALPHABET.indexOf(ch);
      const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i));
      const texts = [...printable, ...printable.flatMap((a) => printable.map((b) => `${a}${b}`))];
      for (const text of texts) {
        const canonical = oracle(text);
        const spare = text.length === 1 ? 16 : 4; // 2^4 values in two characters, 2^2 in three
        const last = canonical.slice(-1);
        expect(at(last) % spare, JSON.stringify(text)).toBe(0);
        for (let bits = 0; bits < spare; bits++) {
          const value = canonical.slice(0, -1) + ALPHABET[at(last) + bits];
          expect(refusal(value), `${JSON.stringify(text)} with spare bits ${bits}`).toBe(
            bits === 0 ? "ok" : "not_base64url",
          );
        }
      }
    });

    test("the order of the checks is fixed: a value that breaks two rules gets the word of the earlier", () => {
      const rows: Array<[string, string, string]> = [
        [
          "over the bound and not in the alphabet",
          "{".repeat(LAUNCH_SPEC_ENV_MAX_CHARS + 1),
          "too_long",
        ],
        ["not in the alphabet and 1 modulo 4 long", "A{{{{", "not_base64url"],
        ["empty is empty, not a bad value", "", "empty"],
        ["1 modulo 4 long", "AAAAA", "bad_length"],
        ["not printable and not canonical: AB is NUL with spare bits", "AB", "not_printable"],
        ["printable and not canonical: QR is A with spare bits", "QR", "not_base64url"],
      ];
      for (const [label, value, reason] of rows) expect(refusal(value), label).toBe(reason);
    });
  });

  describe("the JSON Schema, shared byte for byte with nemar-process, names the transport", () => {
    // The root description says what the document is and that it travels as base64url, with the two
    // numbers of this contract. It claims NOTHING about the scheduler, the shell or the locale: those
    // are systems this contract does not own (an earlier sentence promised that the bytes survive
    // them, and the review showed it false). Its words are not pinned beyond what a reader needs.
    test("the root description names the variable, the encoding and both bounds", () => {
      const root = launchSchema.description;
      expect(root).toContain("NEMAR_LAUNCH_SPEC");
      expect(root).toContain("base64url");
      expect(root).toContain(String(LAUNCH_SPEC_MAX_BYTES));
      expect(root).toContain(String(LAUNCH_SPEC_ENV_MAX_CHARS));
    });

    test("only the descriptions of the file changed with the wire form: its structure is the launcher phase's", () => {
      // Everything but the text annotations, hashed. The SHA-256 is of the file as it stood before the
      // wire form was added, so a change to a key, a type, a pattern or a bound shows here, and a change
      // to a sentence does not. A structural change is nemar-process's to copy too: update this with it.
      const strip = (node: unknown): unknown =>
        Array.isArray(node)
          ? node.map(strip)
          : node && typeof node === "object"
            ? Object.fromEntries(
                Object.entries(node)
                  .filter(([key, value]) => !(key === "description" && typeof value === "string"))
                  .map(([key, value]) => [key, strip(value)]),
              )
            : node;
      expect(
        createHash("sha256")
          .update(JSON.stringify(strip(launchSchema)))
          .digest("hex"),
      ).toBe("684334303372be174ae9b2fd60f36ad57dde5d7fa6f870979e093136c54947af");
    });
  });
});

describe("the results bucket layout", () => {
  test("outputs and launcher files live under jobs/<id>/", () => {
    expect(resultsOutputKey(JOB_ID, "a/b.txt")).toBe(`jobs/${JOB_ID}/outputs/a/b.txt`);
    for (const name of LAUNCHER_FILE_NAMES) {
      expect(resultsLauncherKey(JOB_ID, name)).toBe(`jobs/${JOB_ID}/launcher/${name}`);
    }
  });

  test("a key is never built from a path that escapes or a job id that is not one", () => {
    expect(() => resultsOutputKey(JOB_ID, "../x")).toThrow();
    expect(() => resultsOutputKey(JOB_ID, "/x")).toThrow();
    expect(() => resultsOutputKey("job_x", "a")).toThrow();
    expect(() => resultsOutputKey("../job_0123456789abcdef01234567", "a")).toThrow();
    expect(() => resultsLauncherKey(JOB_ID, "other.json" as "result.json")).toThrow();
    expect(() => resultsLauncherKey("nope", "result.json")).toThrow();
  });
});

describe("the route shapes in the schema's $defs", () => {
  const BUNDLE_CASES: readonly Case[] = [
    [
      "a bundle response",
      { url: "https://r2.example.test/b?X-Sig=1", expires_at: "2026-11-03T12:00:00Z" },
      true,
    ],
    [
      "fractional seconds",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00.250Z" },
      true,
    ],
    ["no url", { expires_at: "2026-11-03T12:00:00Z" }, false],
    ["no expiry", { url: "https://r2.example.test/b" }, false],
    [
      "a url that is not http",
      { url: "file:///etc/passwd", expires_at: "2026-11-03T12:00:00Z" },
      false,
    ],
    [
      "an expiry that is not UTC",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00+01:00" },
      false,
    ],
    [
      "an expiry that is a date",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03" },
      false,
    ],
    // A response is open: a launcher that runs for 48 hours must survive the Worker adding a key.
    [
      "an extra key",
      { url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00Z", x: 1 },
      true,
    ],
    [
      "an extra key of any shape",
      {
        url: "https://r2.example.test/b",
        expires_at: "2026-11-03T12:00:00Z",
        retry_after: { seconds: 5 },
        notes: ["a"],
      },
      true,
    ],
  ];

  const LAUNCHER_LIST = LAUNCHER_FILE_NAMES.map((name) => ({ name, size: 10 }));
  const OUTPUTS_REQUEST = {
    outputs: [{ path: "a/b.txt", size: 3, sha256: HEX_A }],
    launcher: LAUNCHER_LIST,
  };
  const REQUEST_CASES: readonly Case[] = [
    ["an outputs request", OUTPUTS_REQUEST, true],
    ["no outputs", { ...OUTPUTS_REQUEST, outputs: [] }, true],
    [
      "an output that climbs",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "../a", size: 1, sha256: HEX_A }]),
      false,
    ],
    [
      "an absolute output",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "/a", size: 1, sha256: HEX_A }]),
      false,
    ],
    [
      "a negative size",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "a", size: -1, sha256: HEX_A }]),
      false,
    ],
    [
      "a bad digest",
      set(OUTPUTS_REQUEST, "outputs", [{ path: "a", size: 1, sha256: "Z".repeat(64) }]),
      false,
    ],
    ["an output key left out", set(OUTPUTS_REQUEST, "outputs", [{ path: "a", size: 1 }]), false],
    ["three launcher files", { ...OUTPUTS_REQUEST, launcher: LAUNCHER_LIST.slice(0, 3) }, false],
    [
      "a repeated launcher file",
      { ...OUTPUTS_REQUEST, launcher: [...LAUNCHER_LIST.slice(0, 3), LAUNCHER_LIST[0]] },
      false,
    ],
    // Four entries that leave out exactly one of the four names, whichever it is.
    ...LAUNCHER_LIST.map(
      (left, i): Case => [
        `four launcher entries that leave out ${left.name}`,
        {
          ...OUTPUTS_REQUEST,
          launcher: LAUNCHER_LIST.filter((_, j) => j !== i).concat(LAUNCHER_LIST[(i + 1) % 4]),
        },
        false,
      ],
    ),
    [
      "the four launcher files in another order",
      { ...OUTPUTS_REQUEST, launcher: [...LAUNCHER_LIST].reverse() },
      true,
    ],
    [
      "an unknown launcher file",
      {
        ...OUTPUTS_REQUEST,
        launcher: [...LAUNCHER_LIST.slice(0, 3), { name: "other.json", size: 1 }],
      },
      false,
    ],
    [
      "a negative launcher size",
      {
        ...OUTPUTS_REQUEST,
        launcher: [...LAUNCHER_LIST.slice(0, 3), { name: "launcher.log", size: -1 }],
      },
      false,
    ],
    ["no launcher list", { outputs: [] }, false],
    ["an extra key", { ...OUTPUTS_REQUEST, extra: 1 }, false],
    [
      "five launcher files, one repeated",
      { ...OUTPUTS_REQUEST, launcher: [...LAUNCHER_LIST, LAUNCHER_LIST[0]] },
      false,
    ],
    [
      "100000 outputs",
      {
        ...OUTPUTS_REQUEST,
        outputs: Array.from({ length: 100_000 }, () => ({ path: "f", size: 1, sha256: HEX_A })),
      },
      true,
    ],
    [
      "100001 outputs",
      {
        ...OUTPUTS_REQUEST,
        outputs: Array.from({ length: 100_001 }, () => ({ path: "f", size: 1, sha256: HEX_A })),
      },
      false,
    ],
  ];

  const RESPONSE_CASES: readonly Case[] = [
    [
      "an outputs response",
      {
        uploads: [
          { path: "outputs/a/b.txt", url: "https://r2.example.test/o" },
          { path: "launcher/result.json", url: "https://r2.example.test/r" },
          { path: "launcher/launcher.log", url: "https://r2.example.test/l" },
        ],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    ["no uploads", { uploads: [], expires_at: "2026-11-03T13:00:00Z" }, true],
    [
      "an extra key at the top",
      { uploads: [], expires_at: "2026-11-03T13:00:00Z", request_id: "r1" },
      true,
    ],
    [
      "an extra key in an upload",
      {
        uploads: [{ path: "outputs/a", url: "https://r2.example.test/o", headers: { a: "b" } }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    [
      "an upload that lacks a required key, whatever else it has",
      { uploads: [{ path: "outputs/a", note: 1 }], expires_at: "2026-11-03T13:00:00Z" },
      false,
    ],
    [
      "a path under neither directory",
      {
        uploads: [{ path: "other/a", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      false,
    ],
    [
      "a path that climbs",
      {
        uploads: [{ path: "outputs/../a", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      false,
    ],
    ...[
      ["a control character in an output path", "outputs/a\u0001b"],
      ["a newline in an output path", "outputs/a\nb"],
      ["a DEL in an output path", "outputs/a\u007fb"],
      ["a backslash in an output path", "outputs/a\\b"],
      ["a trailing newline on an output path", "outputs/a\n"],
      ["an empty segment in an output path", "outputs/a//b"],
      ["a dot segment in an output path", "outputs/a/./b"],
      ["a trailing slash on an output path", "outputs/a/"],
      ["no file after outputs/", "outputs/"],
      ["a control character in a launcher path", "launcher/res\u0000ult.json"],
      ["a trailing newline on a launcher path", "launcher/result.json\n"],
      ["a launcher file in a sub-directory", "launcher/sub/result.json"],
      ["a launcher file with a different dot", "launcher/resultxjson"],
    ].map(
      ([label, path]): Case => [
        label,
        {
          uploads: [{ path, url: "https://r2.example.test/o" }],
          expires_at: "2026-11-03T13:00:00Z",
        },
        false,
      ],
    ),
    [
      "a non-ASCII output path",
      {
        uploads: [{ path: "outputs/caf\u00e9/a", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    [
      "a dotted file name that is not a dot segment",
      {
        uploads: [{ path: "outputs/..a/b..", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      true,
    ],
    [
      "an unknown launcher file",
      {
        uploads: [{ path: "launcher/other.json", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      },
      false,
    ],
    [
      "a url that is not http",
      { uploads: [{ path: "outputs/a", url: "gopher://x" }], expires_at: "2026-11-03T13:00:00Z" },
      false,
    ],
    ["no expiry", { uploads: [] }, false],
  ];

  test("the bundle response", () => {
    agree(
      BUNDLE_CASES,
      (d) => defValidator("bundle_response")(d) as boolean,
      (d) => BundleResponseSchema.safeParse(d).success,
    );
  });

  test("the outputs request", () => {
    agree(
      REQUEST_CASES,
      (d) => defValidator("outputs_request")(d) as boolean,
      (d) => OutputsRequestSchema.safeParse(d).success,
    );
  });

  test("the outputs response", () => {
    agree(
      RESPONSE_CASES,
      (d) => defValidator("outputs_response")(d) as boolean,
      (d) => OutputsResponseSchema.safeParse(d).success,
    );
  });
});

describe("the launcher's own documents in the schema's $defs", () => {
  const RESULT_OK = {
    job_id: JOB_ID,
    failure_code: null,
    detail: null,
    exit_number: 0,
    entry_exit_code: 0,
  };
  const RESULT_CASES: Case[] = [
    ["success", RESULT_OK, true],
    [
      "a runtime error with the entry's own exit code",
      { ...RESULT_OK, failure_code: "runtime_error", exit_number: 13, entry_exit_code: 3 },
      true,
    ],
    [
      "a code with a detail",
      { ...RESULT_OK, failure_code: "runtime_error", detail: "terminated", exit_number: 13 },
      true,
    ],
    ["a success that exits 10", { ...RESULT_OK, exit_number: 10 }, false],
    ["a failure that exits 0", { ...RESULT_OK, failure_code: "time_limit" }, false],
    [
      "a code with another code's exit number",
      { ...RESULT_OK, failure_code: "time_limit", exit_number: 14 },
      false,
    ],
    [
      "a platform code the launcher never writes",
      { ...RESULT_OK, failure_code: "tapis_error", exit_number: 10 },
      false,
    ],
    ["a detail that is not a word", { ...RESULT_OK, detail: "Not A Word" }, false],
    ["an extra key", { ...RESULT_OK, extra: 1 }, false],
    ["the largest entry exit code", { ...RESULT_OK, entry_exit_code: 255 }, true],
    ["a signal-style entry exit code", { ...RESULT_OK, entry_exit_code: -9 }, true],
    ["an entry exit code of 256", { ...RESULT_OK, entry_exit_code: 256 }, false],
    ["an entry exit code of -256", { ...RESULT_OK, entry_exit_code: -256 }, false],
    ["a fractional entry exit code", { ...RESULT_OK, entry_exit_code: 1.5 }, false],
    [
      "a missing detail",
      { job_id: JOB_ID, failure_code: null, exit_number: 0, entry_exit_code: 0 },
      false,
    ],
  ];
  for (const [i, code] of LAUNCHER_FAILURE_CODES.entries()) {
    RESULT_CASES.push([
      `${code} exits ${10 + i}`,
      { ...RESULT_OK, failure_code: code, exit_number: 10 + i },
      true,
    ]);
    RESULT_CASES.push([
      `${code} does not exit ${10 + ((i + 1) % LAUNCHER_FAILURE_CODES.length)}`,
      {
        ...RESULT_OK,
        failure_code: code,
        exit_number: 10 + ((i + 1) % LAUNCHER_FAILURE_CODES.length),
      },
      false,
    ]);
  }

  const MANIFEST_CASES: readonly Case[] = [
    ["a manifest", { job_id: JOB_ID, files: [{ path: "a", size: 1, sha256: HEX_A }] }, true],
    ["an empty manifest", { job_id: JOB_ID, files: [] }, true],
    [
      "a path that climbs",
      { job_id: JOB_ID, files: [{ path: "../a", size: 1, sha256: HEX_A }] },
      false,
    ],
    ["no job id", { files: [] }, false],
    [
      "an extra file key",
      { job_id: JOB_ID, files: [{ path: "a", size: 1, sha256: HEX_A, x: 1 }] },
      false,
    ],
  ];

  const PROVENANCE = {
    job_id: JOB_ID,
    launch_spec_digest: HEX_A,
    bundle_digest: null,
    image: { uri: "docker://ghcr.io/example/runtime", digest: `sha256:${HEX_B}` },
    runtime_version: "3.12.3",
    staging: [{ id: "nm000104", version: "1.0.2", mode: "bind", files: 12, bytes: 3456 }],
    timings: { run: 600.25 },
    slurm_job_id: "1234567",
    entry_exit_code: 0,
  };
  const PROVENANCE_CASES: readonly Case[] = [
    ["provenance", PROVENANCE, true],
    ["a bundle digest", set(PROVENANCE, "bundle_digest", HEX_B), true],
    ["no slurm id", set(PROVENANCE, "slurm_job_id", null), true],
    ["no launch spec digest", set(PROVENANCE, "launch_spec_digest", undefined), false],
    ["a short launch spec digest", set(PROVENANCE, "launch_spec_digest", "abc"), false],
    ["an image digest with no algorithm", set(PROVENANCE, "image.digest", HEX_B), false],
    [
      "an unknown staging mode",
      set(PROVENANCE, "staging", [
        { id: "nm000104", version: "1", mode: "magic", files: 1, bytes: 1 },
      ]),
      false,
    ],
    ["a negative timing", set(PROVENANCE, "timings", { run: -1 }), false],
    [
      "16 phases",
      set(
        PROVENANCE,
        "timings",
        Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`phase_${i}`, 1])),
      ),
      true,
    ],
    [
      "17 phases",
      set(
        PROVENANCE,
        "timings",
        Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`phase_${i}`, 1])),
      ),
      false,
    ],
    ["a timing named with a space", set(PROVENANCE, "timings", { "a b": 1 }), false],
    ["an extra key", { ...PROVENANCE, extra: 1 }, false],
  ];

  test("result.json", () => {
    agree(
      RESULT_CASES,
      (d) => defValidator("result")(d) as boolean,
      (d) => LauncherResultSchema.safeParse(d).success,
    );
  });

  test("manifest.json", () => {
    agree(
      MANIFEST_CASES,
      (d) => defValidator("manifest")(d) as boolean,
      (d) => ResultManifestSchema.safeParse(d).success,
    );
  });

  test("provenance.json", () => {
    agree(
      PROVENANCE_CASES,
      (d) => defValidator("provenance")(d) as boolean,
      (d) => LauncherProvenanceSchema.safeParse(d).success,
    );
  });
});

// --- Every bound, from one table ---------------------------------------------------------------

type BoundTarget =
  | "root"
  | "bundle_response"
  | "outputs_request"
  | "outputs_response"
  | "result"
  | "manifest"
  | "provenance";

interface Bound {
  label: string;
  target: BoundTarget;
  /** A "max" is valid at `at` and invalid at `at + 1`; a "min" is valid at `at` and invalid at `at - 1`. */
  kind: "max" | "min";
  at: number;
  /** A document in which the quantity under test is `n` and everything else is valid. */
  build: (n: number) => unknown;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HASH = "a".repeat(64);
const TS = "2026-11-03T13:00:00Z";
const UPLOAD = { path: "outputs/a", url: "https://r2.example.test/o" };
const OUTPUT = { path: "a", size: 1, sha256: HASH };
const STAGING = { id: "nm000104", version: "1.0.2", mode: "bind", files: 1, bytes: 1 };
const REQUEST_BASE = {
  outputs: [OUTPUT],
  launcher: LAUNCHER_FILE_NAMES.map((name) => ({ name, size: 1 })),
};
const RESULT_BASE = {
  job_id: JOB_ID,
  failure_code: null,
  detail: null,
  exit_number: 0,
  entry_exit_code: 0,
};
const MANIFEST_BASE = { job_id: JOB_ID, files: [OUTPUT] };
const PROVENANCE_BASE = {
  job_id: JOB_ID,
  launch_spec_digest: HASH,
  bundle_digest: null,
  image: { uri: "docker://ghcr.io/example/runtime", digest: `sha256:${HASH}` },
  runtime_version: "3.12.3",
  staging: [STAGING],
  timings: { run: 1 },
  slurm_job_id: null,
  entry_exit_code: null,
};
/** A command-only launch specification: no entry and no bundle, so `command` can be varied. */
const COMMAND_BASE = {
  ...set(set(LAUNCH, "entry", undefined), "bundle", undefined),
  command: ["c"],
};
/** A digest-pinned image reference of exactly `n` characters. */
// Pinned to the launch specification's own image digest, as the cross rule requires.
const imageRef = (n: number) => `docker://ghcr.io/${"a".repeat(n - 89)}@sha256:${HEX_B}`;

/**
 * The one table of every numeric and length bound in the launch schema, as literals. The corpus
 * below is generated from it and judged by Ajv (on the byte-shared JSON Schema) and by zod, so a
 * bound that drifts in either one, or in both, fails here on the very pair that straddles it.
 */
const MAIN_BOUNDS: readonly Bound[] = [
  // The launch specification
  {
    label: "entry length",
    target: "root",
    kind: "max",
    at: 240,
    build: (n) => set(LAUNCH, "entry", `${"a".repeat(n - 3)}.py`),
  },
  {
    label: "command items",
    target: "root",
    kind: "max",
    at: 64,
    build: (n) => ({ ...COMMAND_BASE, command: Array(n).fill("c") }),
  },
  {
    label: "command items, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => ({ ...COMMAND_BASE, command: Array(n).fill("c") }),
  },
  {
    label: "command item length",
    target: "root",
    kind: "max",
    at: 1024,
    build: (n) => ({ ...COMMAND_BASE, command: ["c".repeat(n)] }),
  },
  {
    label: "command item length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => ({ ...COMMAND_BASE, command: ["c".repeat(n)] }),
  },
  {
    label: "arguments",
    target: "root",
    kind: "max",
    at: 64,
    build: (n) => set(LAUNCH, "args", Array(n).fill("a")),
  },
  {
    label: "argument length",
    target: "root",
    kind: "max",
    at: 1024,
    build: (n) => set(LAUNCH, "args", ["a".repeat(n)]),
  },
  {
    label: "datasets",
    target: "root",
    kind: "max",
    at: 20,
    build: (n) => set(LAUNCH, "datasets", Array(n).fill({ id: "nm000104", version: "v1.0.2" })),
  },
  {
    label: "include patterns",
    target: "root",
    kind: "max",
    at: 64,
    build: (n) =>
      set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2", include: Array(n).fill("a") }]),
  },
  {
    label: "include pattern length",
    target: "root",
    kind: "max",
    at: 256,
    build: (n) =>
      set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2", include: ["a".repeat(n)] }]),
  },
  {
    label: "include pattern length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) =>
      set(LAUNCH, "datasets", [{ id: "nm000104", version: "v1.0.2", include: ["a".repeat(n)] }]),
  },
  {
    label: "dataset version length",
    target: "root",
    kind: "max",
    at: 64,
    // v<digits>.0.0: the tag grows by one digit at a time.
    build: (n) =>
      set(LAUNCH, "datasets", [{ id: "nm000104", version: `v${"9".repeat(n - 5)}.0.0` }]),
  },
  {
    label: "api_base length",
    target: "root",
    kind: "max",
    at: 512,
    build: (n) => set(LAUNCH, "api_base", `https://${"a".repeat(n - 8)}`),
  },
  {
    label: "job_token length, at least",
    target: "root",
    kind: "min",
    at: 16,
    build: (n) => set(LAUNCH, "job_token", "t".repeat(n)),
  },
  {
    label: "job_token length",
    target: "root",
    kind: "max",
    at: 256,
    build: (n) => set(LAUNCH, "job_token", "t".repeat(n)),
  },
  {
    label: "image uri length",
    target: "root",
    kind: "max",
    at: 512,
    build: (n) => set(LAUNCH, "image.uri", imageRef(n)),
  },
  {
    label: "env value length",
    target: "root",
    kind: "max",
    at: 256,
    build: (n) => set(LAUNCH, "env", { OMP_NUM_THREADS: "x".repeat(n) }),
  },
  {
    label: "gpus",
    target: "root",
    kind: "max",
    at: 8,
    build: (n) => set(LAUNCH, "resources.gpus", n),
  },
  {
    label: "gpus, at least",
    target: "root",
    kind: "min",
    at: 0,
    build: (n) => set(LAUNCH, "resources.gpus", n),
  },
  {
    label: "max_files",
    target: "root",
    kind: "max",
    at: 1_000_000,
    build: (n) => set(LAUNCH, "limits.max_files", n),
  },
  {
    label: "max_files, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "limits.max_files", n),
  },
  {
    label: "max_total_bytes",
    target: "root",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => set(LAUNCH, "limits.max_total_bytes", n),
  },
  {
    label: "max_total_bytes, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "limits.max_total_bytes", n),
  },
  {
    label: "bundle size",
    target: "root",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => set(LAUNCH, "bundle.size", n),
  },
  {
    label: "bundle size, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "bundle.size", n),
  },
  // The bundle response
  {
    label: "bundle url length",
    target: "bundle_response",
    kind: "max",
    at: 4096,
    build: (n) => ({ url: `https://${"a".repeat(n - 8)}`, expires_at: TS }),
  },
  // The outputs request
  {
    label: "outputs listed",
    target: "outputs_request",
    kind: "max",
    at: 100_000,
    build: (n) => ({ ...REQUEST_BASE, outputs: Array(n).fill(OUTPUT) }),
  },
  {
    label: "output path length",
    target: "outputs_request",
    kind: "max",
    at: 512,
    build: (n) => ({ ...REQUEST_BASE, outputs: [{ ...OUTPUT, path: "a".repeat(n) }] }),
  },
  {
    label: "output size",
    target: "outputs_request",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...REQUEST_BASE, outputs: [{ ...OUTPUT, size: n }] }),
  },
  {
    label: "output size, at least",
    target: "outputs_request",
    kind: "min",
    at: 0,
    build: (n) => ({ ...REQUEST_BASE, outputs: [{ ...OUTPUT, size: n }] }),
  },
  {
    label: "launcher file size",
    target: "outputs_request",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({
      ...REQUEST_BASE,
      launcher: REQUEST_BASE.launcher.map((f, i) => (i === 0 ? { ...f, size: n } : f)),
    }),
  },
  // The outputs response
  {
    label: "uploads",
    target: "outputs_response",
    kind: "max",
    at: 100_004,
    build: (n) => ({ uploads: Array(n).fill(UPLOAD), expires_at: TS }),
  },
  {
    label: "upload path length",
    target: "outputs_response",
    kind: "max",
    at: 600,
    build: (n) => ({
      uploads: [{ ...UPLOAD, path: `outputs/${"a".repeat(n - 8)}` }],
      expires_at: TS,
    }),
  },
  {
    label: "upload url length",
    target: "outputs_response",
    kind: "max",
    at: 4096,
    build: (n) => ({
      uploads: [{ ...UPLOAD, url: `https://${"a".repeat(n - 8)}` }],
      expires_at: TS,
    }),
  },
  // result.json
  {
    label: "result detail length",
    target: "result",
    kind: "max",
    at: 64,
    build: (n) => ({ ...RESULT_BASE, detail: "a".repeat(n) }),
  },
  {
    label: "result detail length, at least",
    target: "result",
    kind: "min",
    at: 1,
    build: (n) => ({ ...RESULT_BASE, detail: "a".repeat(n) }),
  },
  {
    label: "entry exit code",
    target: "result",
    kind: "max",
    at: 255,
    build: (n) => ({ ...RESULT_BASE, entry_exit_code: n }),
  },
  {
    label: "entry exit code, at least",
    target: "result",
    kind: "min",
    at: -255,
    build: (n) => ({ ...RESULT_BASE, entry_exit_code: n }),
  },
  // manifest.json
  {
    label: "manifest files",
    target: "manifest",
    kind: "max",
    at: 100_000,
    build: (n) => ({ ...MANIFEST_BASE, files: Array(n).fill(OUTPUT) }),
  },
  {
    label: "manifest path length",
    target: "manifest",
    kind: "max",
    at: 512,
    build: (n) => ({ ...MANIFEST_BASE, files: [{ ...OUTPUT, path: "a".repeat(n) }] }),
  },
  {
    label: "manifest size",
    target: "manifest",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...MANIFEST_BASE, files: [{ ...OUTPUT, size: n }] }),
  },
  // provenance.json
  {
    label: "staging records",
    target: "provenance",
    kind: "max",
    at: 20,
    build: (n) => ({ ...PROVENANCE_BASE, staging: Array(n).fill(STAGING) }),
  },
  {
    label: "staging files",
    target: "provenance",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, files: n }] }),
  },
  {
    label: "staging bytes",
    target: "provenance",
    kind: "max",
    at: MAX_SAFE,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, bytes: n }] }),
  },
  {
    label: "staging version length",
    target: "provenance",
    kind: "max",
    at: 64,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, version: "1".repeat(n) }] }),
  },
  {
    label: "timings",
    target: "provenance",
    kind: "max",
    at: 16,
    build: (n) => ({
      ...PROVENANCE_BASE,
      timings: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, 1])),
    }),
  },
  {
    label: "timing key length",
    target: "provenance",
    kind: "max",
    at: 64,
    build: (n) => ({ ...PROVENANCE_BASE, timings: { [`k${"a".repeat(n - 1)}`]: 1 } }),
  },
  {
    label: "slurm_job_id length",
    target: "provenance",
    kind: "max",
    at: 64,
    build: (n) => ({ ...PROVENANCE_BASE, slurm_job_id: "1".repeat(n) }),
  },
  {
    label: "slurm_job_id length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, slurm_job_id: "1".repeat(n) }),
  },
  {
    label: "runtime_version length",
    target: "provenance",
    kind: "max",
    at: 128,
    build: (n) => ({ ...PROVENANCE_BASE, runtime_version: "v".repeat(n) }),
  },
  {
    label: "runtime_version length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, runtime_version: "v".repeat(n) }),
  },
  {
    label: "provenance image uri length",
    target: "provenance",
    kind: "max",
    at: 512,
    build: (n) => ({ ...PROVENANCE_BASE, image: { ...PROVENANCE_BASE.image, uri: "u".repeat(n) } }),
  },
  {
    label: "provenance entry exit code",
    target: "provenance",
    kind: "max",
    at: 255,
    build: (n) => ({ ...PROVENANCE_BASE, entry_exit_code: n }),
  },
  {
    label: "provenance entry exit code, at least",
    target: "provenance",
    kind: "min",
    at: -255,
    build: (n) => ({ ...PROVENANCE_BASE, entry_exit_code: n }),
  },
];

/** The bounds a mutation of each quantifier or keyword in the schema turned out to need. */
const EXTRA_BOUNDS: readonly Bound[] = [
  {
    label: "entry length, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) => set(LAUNCH, "entry", "a".repeat(n)),
  },
  // Every allowlisted environment name has its own entry in the schema, so each one is a bound.
  ...JOB_ENV_ALLOWLIST.map(
    (name): Bound => ({
      label: `env value length (${name})`,
      target: "root",
      kind: "max",
      at: 256,
      build: (n) => set(LAUNCH, "env", { [name]: "x".repeat(n) }),
    }),
  ),
  {
    label: "image uri port digits",
    target: "root",
    kind: "max",
    at: 5,
    build: (n) =>
      set(LAUNCH, "image.uri", `registry.example.test:${"1".repeat(n)}/team/tool@sha256:${HEX_B}`),
  },
  {
    label: "image uri port digits, at least",
    target: "root",
    kind: "min",
    at: 1,
    build: (n) =>
      set(LAUNCH, "image.uri", `registry.example.test:${"1".repeat(n)}/team/tool@sha256:${HEX_B}`),
  },
  {
    label: "launcher file size, at least",
    target: "outputs_request",
    kind: "min",
    at: 0,
    build: (n) => ({
      ...REQUEST_BASE,
      launcher: REQUEST_BASE.launcher.map((f, i) => (i === 0 ? { ...f, size: n } : f)),
    }),
  },
  {
    label: "manifest size, at least",
    target: "manifest",
    kind: "min",
    at: 0,
    build: (n) => ({ ...MANIFEST_BASE, files: [{ ...OUTPUT, size: n }] }),
  },
  {
    label: "staging files, at least",
    target: "provenance",
    kind: "min",
    at: 0,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, files: n }] }),
  },
  {
    label: "staging bytes, at least",
    target: "provenance",
    kind: "min",
    at: 0,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, bytes: n }] }),
  },
  {
    label: "staging version length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, staging: [{ ...STAGING, version: "1".repeat(n) }] }),
  },
  {
    label: "timing seconds, at least",
    target: "provenance",
    kind: "min",
    at: 0,
    build: (n) => ({ ...PROVENANCE_BASE, timings: { run: n } }),
  },
  {
    label: "timing key length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, timings: { ["k".repeat(n)]: 1 } }),
  },
  {
    label: "provenance image uri length, at least",
    target: "provenance",
    kind: "min",
    at: 1,
    build: (n) => ({ ...PROVENANCE_BASE, image: { ...PROVENANCE_BASE.image, uri: "u".repeat(n) } }),
  },
];

const BOUNDS: readonly Bound[] = [...MAIN_BOUNDS, ...EXTRA_BOUNDS];

const zodFor: Record<BoundTarget, (doc: unknown) => boolean> = {
  root: (d) => LaunchSpecSchema.safeParse(d).success,
  bundle_response: (d) => BundleResponseSchema.safeParse(d).success,
  outputs_request: (d) => OutputsRequestSchema.safeParse(d).success,
  outputs_response: (d) => OutputsResponseSchema.safeParse(d).success,
  result: (d) => LauncherResultSchema.safeParse(d).success,
  manifest: (d) => ResultManifestSchema.safeParse(d).success,
  provenance: (d) => LauncherProvenanceSchema.safeParse(d).success,
};
const ajvFor = (target: BoundTarget): ((doc: unknown) => boolean) =>
  target === "root" ? (d) => validateRoot(d) as boolean : (d) => defValidator(target)(d) as boolean;

describe("every numeric and length bound, from one table, on both sides of its edge", () => {
  test("the table covers every kind of document and is not small", () => {
    expect(BOUNDS.length).toBeGreaterThanOrEqual(70);
    expect(new Set(BOUNDS.map((b) => b.target))).toEqual(
      new Set([
        "root",
        "bundle_response",
        "outputs_request",
        "outputs_response",
        "result",
        "manifest",
        "provenance",
      ]),
    );
    expect(new Set(BOUNDS.map((b) => b.label)).size).toBe(BOUNDS.length);
    expect(BOUNDS.filter((b) => b.kind === "min").length).toBeGreaterThanOrEqual(15);
  });

  test("the base documents the builders vary are themselves valid", () => {
    expect(validateRoot(COMMAND_BASE)).toBe(true);
    expect(LaunchSpecSchema.safeParse(COMMAND_BASE).success).toBe(true);
    for (const [target, doc] of [
      ["outputs_request", REQUEST_BASE],
      ["result", RESULT_BASE],
      ["manifest", MANIFEST_BASE],
      ["provenance", PROVENANCE_BASE],
    ] as const) {
      expect(ajvFor(target)(doc), target).toBe(true);
      expect(zodFor[target](doc), target).toBe(true);
    }
  });

  for (const bound of BOUNDS) {
    test(`${bound.target}: ${bound.label} is ${bound.at} ${bound.kind === "max" ? "at most" : "at least"}`, () => {
      const inside = bound.build(bound.at);
      const outside = bound.build(bound.kind === "max" ? bound.at + 1 : bound.at - 1);
      expect(ajvFor(bound.target)(inside), "JSON Schema, at the limit").toBe(true);
      expect(zodFor[bound.target](inside), "zod, at the limit").toBe(true);
      expect(ajvFor(bound.target)(outside), "JSON Schema, one past").toBe(false);
      expect(zodFor[bound.target](outside), "zod, one past").toBe(false);
    });
  }
});

// --- The same, for what only zod holds: the job specification and the owner policy ----------------

interface ZodBound {
  label: string;
  kind: "max" | "min";
  at: number;
  ok: (doc: unknown) => boolean;
  build: (n: number) => unknown;
}

/** The rows for one number that may be bounded below and above, both ends from one place. */
function numeric(
  label: string,
  ok: (doc: unknown) => boolean,
  build: (n: number) => unknown,
  min: number | null,
  max: number | null,
): ZodBound[] {
  const rows: ZodBound[] = [];
  if (min !== null) rows.push({ label: `${label}, at least`, kind: "min", at: min, ok, build });
  if (max !== null) rows.push({ label, kind: "max", at: max, ok, build });
  return rows;
}

const jobOk = (d: unknown) => JobSpecSchema.safeParse(d).success;
const policyOk = (d: unknown) => ComputePolicySchema.safeParse(d).success;
const POLICY = JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)) as Doc;
const policyWith = (path: string, value: unknown) => set(POLICY, path, value);
const imageJob = (extra: Record<string, unknown>) => ({
  name: "tool",
  runtime: "image",
  command: ["tool"],
  partition: "shared",
  minutes: 30,
  ...extra,
});
const recipeJob = (recipe: string) => ({
  name: "floor",
  runtime: "python",
  recipe,
  datasets: [{ id: "nm000104", version: "1" }],
  partition: "shared",
  minutes: 60,
});
const ceilingOk = (d: unknown) => ComputeCeilingSchema.safeParse(d).success;
const CEILING = { maxNodes: 1, maxCoresPerNode: 1, maxGpusPerNode: 0, maxMinutes: 1 };
const capsOk = (d: unknown) => ComputeClientCapsSchema.safeParse(d).success;

const ZOD_BOUNDS: readonly ZodBound[] = [
  // The job specification
  ...numeric("name length", jobOk, (n) => specWith({ name: "a".repeat(n) }), 1, 80),
  ...numeric("nodes", jobOk, (n) => specWith({ nodes: n }), 1, 64),
  ...numeric("cores", jobOk, (n) => specWith({ cores: n }), 1, 256),
  ...numeric("gpus on a CPU partition", jobOk, (n) => specWith({ gpus: n }), 0, null),
  ...numeric(
    "gpus on a GPU partition",
    jobOk,
    (n) => specWith({ partition: "gpu", gpus: n }),
    1,
    8,
  ),
  ...numeric("minutes", jobOk, (n) => specWith({ minutes: n }), 1, 10080),
  ...numeric("memory_mb", jobOk, (n) => specWith({ memory_mb: n }), 1, 16_777_216),
  ...numeric("entry length", jobOk, (n) => specWith({ entry: "a".repeat(n) }), 1, null),
  ...numeric(
    "entry length, with a suffix",
    jobOk,
    (n) => specWith({ entry: `${"a".repeat(n - 3)}.py` }),
    null,
    240,
  ),
  ...numeric(
    "bundle size",
    jobOk,
    (n) => specWith({ bundle: { size: n, sha256: HEX_A } }),
    1,
    MAX_SAFE,
  ),
  ...numeric("arguments", jobOk, (n) => specWith({ args: Array(n).fill("a") }), null, 64),
  ...numeric("argument length", jobOk, (n) => specWith({ args: ["a".repeat(n)] }), null, 1024),
  ...numeric(
    "command items",
    jobOk,
    (n) => imageJob({ image: imageRef(512), command: Array(n).fill("c") }),
    1,
    64,
  ),
  ...numeric(
    "command item length",
    jobOk,
    (n) => imageJob({ image: imageRef(512), command: ["c".repeat(n)] }),
    1,
    1024,
  ),
  ...numeric("image length", jobOk, (n) => imageJob({ image: imageRef(n) }), null, 512),
  ...numeric("recipe length", jobOk, (n) => recipeJob("a".repeat(n)), 1, 64),
  ...numeric(
    "datasets",
    jobOk,
    (n) => specWith({ datasets: Array(n).fill({ id: "nm000104", version: "1" }) }),
    null,
    20,
  ),
  ...numeric(
    "dataset version length",
    jobOk,
    (n) => specWith({ datasets: [{ id: "nm000104", version: "1".repeat(n) }] }),
    1,
    64,
  ),
  ...numeric(
    "include patterns",
    jobOk,
    (n) => specWith({ datasets: [{ id: "nm000104", version: "1", include: Array(n).fill("a") }] }),
    null,
    64,
  ),
  ...numeric(
    "include pattern length",
    jobOk,
    (n) => specWith({ datasets: [{ id: "nm000104", version: "1", include: ["a".repeat(n)] }] }),
    1,
    256,
  ),
  ...JOB_ENV_ALLOWLIST.flatMap((name) =>
    numeric(
      `env value length (${name})`,
      jobOk,
      (n) => specWith({ env: { [name]: "x".repeat(n) } }),
      null,
      256,
    ),
  ),
  // A ceiling and a client's caps
  ...numeric("ceiling maxNodes", ceilingOk, (n) => ({ ...CEILING, maxNodes: n }), 1, 64),
  ...numeric(
    "ceiling maxCoresPerNode",
    ceilingOk,
    (n) => ({ ...CEILING, maxCoresPerNode: n }),
    0,
    256,
  ),
  ...numeric("ceiling maxGpusPerNode", ceilingOk, (n) => ({ ...CEILING, maxGpusPerNode: n }), 0, 8),
  ...numeric("ceiling maxMinutes", ceilingOk, (n) => ({ ...CEILING, maxMinutes: n }), 1, 10080),
  ...numeric(
    "client maxOpenReservations",
    capsOk,
    (n) => ({ maxOpenReservations: n, maxReservedMilliPerDay: 1 }),
    0,
    100_000,
  ),
  ...numeric(
    "client maxReservedMilliPerDay",
    capsOk,
    (n) => ({ maxOpenReservations: 1, maxReservedMilliPerDay: n }),
    0,
    MAX_SAFE,
  ),
  // The owner policy
  ...numeric(
    "default grant, cpu",
    policyOk,
    (n) => policyWith("defaultGrantMilli.cpu", n),
    0,
    MAX_SAFE,
  ),
  ...numeric(
    "default grant, gpu",
    policyOk,
    (n) => policyWith("defaultGrantMilli.gpu", n),
    0,
    MAX_SAFE,
  ),
  ...numeric(
    "renewal every days",
    policyOk,
    (n) => policyWith("renewal", { enabled: true, everyDays: n }),
    1,
    366,
  ),
  ...numeric(
    "maxLiveJobsPerPerson",
    policyOk,
    (n) => policyWith("maxLiveJobsPerPerson", n),
    0,
    1000,
  ),
  ...numeric(
    "pipelines dailyJobCap",
    policyOk,
    (n) => policyWith("pipelines.dailyJobCap", n),
    0,
    100_000,
  ),
  ...numeric(
    "pipelines live cpu",
    policyOk,
    (n) => policyWith("pipelines.maxLiveJobs.cpu", n),
    0,
    1000,
  ),
  ...numeric(
    "pipelines live gpu",
    policyOk,
    (n) => policyWith("pipelines.maxLiveJobs.gpu", n),
    0,
    1000,
  ),
  ...numeric(
    "reservationWaitMinutes",
    policyOk,
    (n) => policyWith("reservationWaitMinutes", n),
    1,
    1440,
  ),
  ...numeric(
    "retention recordsYears",
    policyOk,
    (n) => policyWith("retention.recordsYears", n),
    1,
    30,
  ),
  ...numeric("retention logsDays", policyOk, (n) => policyWith("retention.logsDays", n), 1, 3650),
  ...numeric(
    "retention resultsDays",
    policyOk,
    (n) => policyWith("retention.resultsDays", n),
    14,
    365,
  ),
  ...numeric(
    "resultLimits maxJobBytes",
    policyOk,
    (n) => policyWith("resultLimits.maxJobBytes", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "resultLimits maxFiles",
    policyOk,
    (n) => policyWith("resultLimits.maxFiles", n),
    1,
    100_000,
  ),
  ...numeric(
    "resultLimits maxStoredBytesPerPerson",
    policyOk,
    (n) => policyWith("resultLimits.maxStoredBytesPerPerson", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "resultLimits maxStoredBytesTotal",
    policyOk,
    (n) => policyWith("resultLimits.maxStoredBytesTotal", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "settle toleranceMilli",
    policyOk,
    (n) => policyWith("settle.toleranceMilli", n),
    0,
    MAX_SAFE,
  ),
  ...numeric(
    "settle tolerancePercent",
    policyOk,
    (n) => policyWith("settle.tolerancePercent", n),
    0,
    100,
  ),
  ...numeric(
    "bundleLimits maxTotalBytes",
    policyOk,
    (n) => policyWith("bundleLimits.maxTotalBytes", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "bundleLimits maxFiles",
    policyOk,
    (n) => policyWith("bundleLimits.maxFiles", n),
    1,
    100_000,
  ),
  ...numeric(
    "bundleLimits maxFileBytes",
    policyOk,
    (n) => policyWith("bundleLimits.maxFileBytes", n),
    1,
    MAX_SAFE,
  ),
  ...numeric(
    "registries",
    policyOk,
    (n) => policyWith("registries", Array(n).fill("ghcr.io")),
    null,
    64,
  ),
  ...numeric("registry length", policyOk, (n) => policyWith("registries", ["a".repeat(n)]), 1, 255),
  ...numeric(
    "registry port digits",
    policyOk,
    (n) => policyWith("registries", [`ghcr.io:${"1".repeat(n)}`]),
    1,
    5,
  ),
  ...numeric(
    "client id length",
    policyOk,
    (n) =>
      policyWith("clients", {
        ["c".repeat(n)]: { maxOpenReservations: 1, maxReservedMilliPerDay: 1 },
      }),
    1,
    64,
  ),
];

describe("every bound of the job specification and the owner policy, from one table", () => {
  test("the table is large and its builders produce valid documents at the base", () => {
    expect(ZOD_BOUNDS.length).toBeGreaterThanOrEqual(95);
    expect(new Set(ZOD_BOUNDS.map((b) => b.label)).size).toBe(ZOD_BOUNDS.length);
    expect(jobOk(SPEC)).toBe(true);
    expect(policyOk(POLICY)).toBe(true);
    expect(ceilingOk(CEILING)).toBe(true);
    expect(capsOk({ maxOpenReservations: 1, maxReservedMilliPerDay: 1 })).toBe(true);
  });

  for (const bound of ZOD_BOUNDS) {
    test(`${bound.label} is ${bound.at} ${bound.kind === "max" ? "at most" : "at least"}`, () => {
      expect(bound.ok(bound.build(bound.at)), "at the limit").toBe(true);
      expect(
        bound.ok(bound.build(bound.kind === "max" ? bound.at + 1 : bound.at - 1)),
        "one past",
      ).toBe(false);
    });
  }
});

describe("the schema compiles strictly, so a mistyped keyword cannot hide", () => {
  test("a mistyped keyword makes strict compilation throw", () => {
    const broken = JSON.parse(JSON.stringify(launchSchema));
    broken.$id = "https://example.test/broken.json";
    broken.properties.entry.maxLenght = 240;
    expect(() => new Ajv2020(AJV_OPTIONS).compile(broken)).toThrow(/unknown keyword/);
    // The real schema, compiled afresh the same way, does not.
    const again = JSON.parse(JSON.stringify(launchSchema));
    expect(() => new Ajv2020(AJV_OPTIONS).compile(again)).not.toThrow();
  });

  test("the default (non-strict) options would have let it through", () => {
    const broken = JSON.parse(JSON.stringify(launchSchema));
    broken.$id = "https://example.test/broken-lenient.json";
    broken.properties.entry.maxLenght = 240;
    expect(() => new Ajv2020({ strict: false }).compile(broken)).not.toThrow();
  });
});

describe("the JSON Schema file read back against the constants it mirrors", () => {
  const schema = launchSchema as Doc;

  test("it is draft 2020-12, named for the version, and self-contained", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe(LAUNCH_SPEC_VERSION);
    expect(typeof schema.$id).toBe("string");
    // The API serves a schema only under its own name (`backend/src/routes/schemas.ts`). An id on
    // the API host that is not served would be an address that resolves to nothing, so this one
    // follows the form of the repository's schemas that are not served: the file's GitHub address.
    const served = [
      ...readFileSync(join(import.meta.dir, "../backend/src/routes/schemas.ts"), "utf8").matchAll(
        /^\s+"([a-z0-9.-]+\.json)":/gm,
      ),
    ].map((m) => m[1]);
    expect(served.length).toBeGreaterThan(0);
    const id = new URL(schema.$id);
    if (id.hostname === "api.nemar.org") {
      expect(served).toContain(id.pathname.replace("/schemas/", ""));
    }
    expect(schema.$id).toBe(
      "https://github.com/nemarOrg/nemar-cli/shared/contract/compute-launch.schema.json",
    );
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "$ref") refs.push(String(v));
          else walk(v);
        }
      }
    };
    walk(schema);
    for (const ref of refs) expect(ref.startsWith("#/$defs/"), ref).toBe(true);
    for (const ref of refs) expect(schema.$defs[ref.slice("#/$defs/".length)], ref).toBeDefined();
  });

  test("its keys and required list are the launch specification's", () => {
    const keys = [
      "job_id",
      "runtime",
      "entry",
      "command",
      "args",
      "bundle",
      "datasets",
      "api_base",
      "image",
      "env",
      "resources",
      "limits",
      "job_token",
    ];
    expect(Object.keys(schema.properties).sort()).toEqual([...keys].sort());
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      keys.filter((k) => !["entry", "command", "bundle"].includes(k)).sort(),
    );
    expect(Object.keys(LaunchSpecSchema.innerType().shape).sort()).toEqual([...keys].sort());
  });

  test("its enumerations are the constants'", () => {
    expect(schema.properties.runtime.enum).toEqual([...LAUNCH_RUNTIMES]);
    expect(Object.keys(schema.properties.env.properties)).toEqual([...JOB_ENV_ALLOWLIST]);
    expect(schema.properties.env.additionalProperties).toBe(false);
    const result = schema.$defs.result;
    expect(result.properties.failure_code.enum).toEqual([...LAUNCHER_FAILURE_CODES, null]);
    expect(result.properties.exit_number.enum).toEqual([0, 10, 11, 12, 13, 14, 15, 16]);
    expect(schema.$defs.outputs_request.properties.launcher.items.properties.name.enum).toEqual([
      ...LAUNCHER_FILE_NAMES,
    ]);
    expect(Object.keys(schema.$defs).sort()).toEqual(
      [
        "bundle_response",
        "manifest",
        "outputs_request",
        "outputs_response",
        "provenance",
        "result",
      ].sort(),
    );
  });

  test("no pattern that must match ends in `$`, which Python lets match before a trailing newline", () => {
    // A pattern under `not` only ever refuses more with `$`, so only the positive ones matter.
    const open: string[] = [];
    const walk = (node: unknown, where: string, underNot: boolean) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`, underNot));
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "pattern" && typeof v === "string") {
            if (!underNot && !v.endsWith("(?![\\s\\S])")) open.push(`${where}.pattern`);
          } else {
            walk(v, `${where}.${k}`, underNot || k === "not");
          }
        }
      }
    };
    walk(schema, "$", false);
    expect(open).toEqual([]);
    // A guard against a vacuous pass: the walk did reach patterns.
    expect(JSON.stringify(schema).split('"pattern"').length).toBeGreaterThan(30);
  });

  // The three objects a launcher only ever READS: the two responses and each upload in the second.
  const OPEN_BY_DESIGN = [
    "$.$defs.bundle_response",
    "$.$defs.outputs_response",
    "$.$defs.outputs_response.properties.uploads.items",
  ];

  test("every object in it is closed, except the three a launcher only reads", () => {
    const open: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
      if (node && typeof node === "object") {
        const n = node as Doc;
        if (n.type === "object" && n.properties && n.additionalProperties !== false)
          open.push(where);
        // A `contains`, `if`, `then` or `not` subschema is a test applied to a document, not an
        // object a document is made of.
        for (const [k, v] of Object.entries(n)) {
          if (["contains", "if", "then", "not"].includes(k)) continue;
          walk(v, `${where}.${k}`);
        }
      }
    };
    walk(schema, "$");
    expect(open.sort()).toEqual([...OPEN_BY_DESIGN].sort());
  });

  test("the three open objects say so, and none of them forbids an unknown key", () => {
    const at = (path: string): Doc =>
      path
        .split(".")
        .slice(1)
        .reduce<Doc>((node, key) => node[key], schema);
    for (const path of OPEN_BY_DESIGN) {
      const node = at(path);
      expect(node.additionalProperties, path).toBeUndefined();
      expect(String(node.description), path).toMatch(/ignores unknown keys/);
    }
    // And no closed definition is among them: the requests and documents stay strict.
    for (const name of ["outputs_request", "result", "manifest", "provenance"]) {
      expect(schema.$defs[name].additionalProperties, name).toBe(false);
    }
  });
});

describe("the contract records what the launcher owes it", () => {
  test("the clean environment requirement is written where the contract is", () => {
    const text = readFileSync(
      join(import.meta.dir, "../shared/contract/compute-launch.ts"),
      "utf8",
    );
    expect(text).toContain("CLEAN ENVIRONMENT");
    expect(text).toContain("--cleanenv");
    expect(text).toContain("NEMAR_LAUNCH_SPEC");
    expect(text).toContain("job_token");
  });
});

describe("the modules' imports", () => {
  const importsOf = (rel: string): string[] => {
    const src = readFileSync(join(import.meta.dir, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const found = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/^\s*import\s+["']/m);
    return found.sort();
  };

  test("the contract imports only zod and the state module", () => {
    expect(importsOf("../shared/contract/compute.ts")).toEqual(["../compute-state.js", "zod"]);
  });

  test("the launch contract adds only the contract itself", () => {
    expect(importsOf("../shared/contract/compute-launch.ts")).toEqual(["./compute.js", "zod"]);
  });
});
