import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrerequisitesForCommand,
  getInstallInstruction,
  parseVersion,
} from "../src/lib/prerequisites";

describe("getInstallInstruction", () => {
  const tool = {
    installInstructions: {
      macos: "brew install x",
      linux: "apt install x",
      windows: "winget install x",
    },
  };
  test("returns the platform-specific instruction", () => {
    expect(getInstallInstruction(tool, "macos")).toBe("brew install x");
    expect(getInstallInstruction(tool, "linux")).toBe("apt install x");
    expect(getInstallInstruction(tool, "windows")).toBe("winget install x");
  });
});

describe("parseVersion", () => {
  test("extracts a semver-ish version from --version output", () => {
    expect(parseVersion("git version 2.43.0")).toBe("2.43.0");
    expect(parseVersion("deno 1.46.3 (release, aarch64-apple-darwin)")).toBe("1.46.3");
    expect(parseVersion("aws-cli/2.15.0 Python/3.11.4")).toBe("2.15.0");
  });
  test("accepts a two-part version", () => {
    expect(parseVersion("git-annex version: 10.20240")).toBe("10.20240");
  });
  test("returns undefined when there is no version", () => {
    expect(parseVersion("no numbers here")).toBeUndefined();
  });
});

describe("checkPrerequisitesForCommand: a slow (not missing) tool (#1257 item 25)", () => {
  // Review finding: the probe timeout added for the debug bundle (item 5)
  // made this hard-fail upload/download/clone/push/publish/update/release
  // for a tool that is actually installed and merely slow to answer once
  // (cold AV scan, a wedged credential helper, a slow network home) --
  // worse than the hang it replaced. A timed-out probe must warn and let
  // the command proceed, not throw "Missing required tools".
  //
  // Driven through the real entry point (checkPrerequisitesForCommand),
  // not the extracted probe piece: a REAL executable (a shell script) that
  // sleeps past a REAL (test-shortened) timeout shadows `gh` on PATH --
  // "download" needs only `gh` (COMMAND_TOOLS.download), so this exercises
  // the exact warn-vs-throw branch end to end with no mocking of
  // runCommand/probeTool/child_process. TEST_PROBE_TIMEOUT_MS is read
  // fresh per probe (not cached at import) for exactly this kind of
  // override -- see prerequisites.ts's getProbeTimeoutMs.
  test("a required tool that times out warns and does not throw", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "nemar-slow-tool-"));
    const stubPath = join(binDir, "gh");
    // `exec` (not a plain `sleep 2` line) replaces the shell's own process
    // image with `sleep` instead of forking it as a child -- killing a
    // forked child's PARENT shell leaves the orphaned `sleep` holding the
    // stdout/stderr pipes open, so runCommand's `await new
    // Response(proc.stdout).text()` blocks for the full sleep duration
    // regardless of the timeout. `exec` means there is only one process to
    // kill, so its pipes close immediately.
    writeFileSync(stubPath, "#!/bin/sh\nexec sleep 5\n");
    chmodSync(stubPath, 0o755);

    const originalPath = process.env.PATH;
    const originalTimeout = process.env.TEST_PROBE_TIMEOUT_MS;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      process.env.PATH = `${binDir}:${originalPath}`;
      process.env.TEST_PROBE_TIMEOUT_MS = "200";

      await expect(checkPrerequisitesForCommand("download")).resolves.toBeUndefined();
      expect(warnings.some((w) => w.includes("GitHub CLI") && w.includes("time"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      if (originalPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = originalPath;
      // Assigning `undefined` here would coerce to the literal string
      // "undefined" (not delete the key), poisoning getProbeTimeoutMs()'s
      // Number() parse for every later test in this shared bun:test process
      // (#1175 precedent; see test/maintenance-client.test.ts's identical
      // guarded restore).
      // biome-ignore lint/performance/noDelete: see comment above
      if (originalTimeout === undefined) delete process.env.TEST_PROBE_TIMEOUT_MS;
      else process.env.TEST_PROBE_TIMEOUT_MS = originalTimeout;
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
