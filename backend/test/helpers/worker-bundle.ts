// The API Worker as it would be deployed, for the tests that run it in workerd
// through Miniflare (`private-site-rpc-entry.test.ts`, `site-binding-identity.test.ts`).
//
// Moved out of the first of those when the second needed the same two functions;
// it is the bundler a real deploy uses, so a test that runs the result is
// testing the Worker rather than a stand-in for it.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BACKEND = join(import.meta.dir, "../..");

/** The compatibility settings the deployed Worker runs under, read from its
 *  own config so a test cannot drift onto different ones. */
export function wranglerCompatibility(): { date: string; flags: string[] } {
  const toml = readFileSync(join(BACKEND, "wrangler-sccn.toml"), "utf-8");
  const date = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const flags = /^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1];
  if (!date || flags === undefined)
    throw new Error("wrangler-sccn.toml: no compatibility settings");
  return { date, flags: [...flags.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string) };
}

/**
 * The Worker as it would be deployed: `wrangler deploy --dry-run --outdir`
 * bundles `main` from `wrangler-sccn.toml` with the same bundler and settings
 * a real deploy uses, and stops before uploading. No credentials are needed.
 */
export function bundleWorker(): string {
  const outdir = mkdtempSync(join(tmpdir(), "nemar-worker-bundle-"));
  try {
    const run = Bun.spawnSync(
      [
        join(BACKEND, "node_modules/.bin/wrangler"),
        "deploy",
        "--dry-run",
        "-c",
        "wrangler-sccn.toml",
        "--outdir",
        outdir,
      ],
      { cwd: BACKEND, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } },
    );
    if (run.exitCode !== 0) {
      throw new Error(`wrangler dry-run failed: ${run.stderr.toString()}${run.stdout.toString()}`);
    }
    return readFileSync(join(outdir, "worker.js"), "utf-8");
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}
