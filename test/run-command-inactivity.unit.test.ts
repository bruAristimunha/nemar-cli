import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { INACTIVITY_WARNING_AFTER_MS, runCommand } from "../src/lib/git-annex/run-command";

setDefaultTimeout(20_000);

describe("runCommand inactivity warnings (real child process)", () => {
  test("warns once per quiet period, resets on either stream, and lets the child finish", async () => {
    expect(INACTIVITY_WARNING_AFTER_MS).toBe(120_000);

    const warnings: number[] = [];
    const script = [
      'process.stdout.write("started\\n")',
      'setTimeout(() => process.stderr.write("middle\\n"), 150)',
      'setTimeout(() => process.stdout.write("finished\\n"), 300)',
      "setTimeout(() => process.exit(0), 450)",
    ].join(";");
    const result = await runCommand([process.execPath, "-e", script], {
      inactivityWarningAfterMs: 60,
      onInactivityWarning: (idleMs) => warnings.push(idleMs),
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("started\nfinished\n");
    expect(result.stderr).toBe("middle\n");
    // One warning for each of the three output-free intervals, plus at most one
    // if process startup itself exceeds the threshold. The child exits normally.
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings.length).toBeLessThanOrEqual(4);
    expect(warnings.every((idleMs) => idleMs >= 50)).toBe(true);
  });

  test("logs a fallback if the warning callback throws without changing the child result", async () => {
    const moduleUrl = new URL("../src/lib/git-annex/run-command.ts", import.meta.url).href;
    const script = `
      const { runCommand } = await import(${JSON.stringify(moduleUrl)});
      const result = await runCommand(
        [process.execPath, "-e", "setTimeout(() => process.exit(0), 80)"],
        {
          inactivityWarningAfterMs: 5,
          onInactivityWarning: () => { throw new Error("the warning renderer failed"); },
        },
      );
      if (result.exitCode !== 0 || result.timedOut) process.exit(1);
    `;
    const result = await runCommand([process.execPath, "-e", script]);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("Could not display subprocess inactivity warning");
  });
});
