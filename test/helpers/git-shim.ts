/**
 * A pass-through wrapper for the real Git executable. Tests may add environment
 * variables to one matching call or record its arguments; it never changes Git's
 * output or exit status.
 *
 * `env` lets a test steer one child process (for example point git-annex's HTTP client
 * at a dead local proxy) without writing to `process.env`: Bun keeps a proxy variable
 * set in-process for later `fetch` calls even after the variable is restored.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ShimRule {
  /** A substring of the space-joined arguments, for example `annex initremote`. */
  match: string;
  /** Export variables for this call, then run the real Git executable. */
  env?: Record<string, string>;
  /** Append the call's arguments, one line per call, then run the real Git executable. */
  log?: string;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Put the pass-through wrapper first on PATH for the current process and return
 * the function that removes it. Always call the restorer in a `finally`.
 */
export function installGitShim(root: string, rules: ShimRule[]): () => void {
  const real = Bun.which("git");
  if (!real) throw new Error("git not found");
  const dir = join(root, `git-wrapper-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const blocks = rules.map((rule) => {
    const lines: string[] = Object.entries(rule.env ?? {}).map(
      ([k, v]) => `  export ${k}=${quote(v)}`,
    );
    if (rule.log !== undefined) lines.push(`  printf '%s\\n' "$args" >> ${quote(rule.log)}`);
    return [`case "$args" in *${quote(rule.match)}*)`, ...lines, "  ;;", "esac"].join("\n");
  });
  const script = [
    "#!/bin/sh",
    `real=${quote(real)}`,
    'args=" $* "',
    ...blocks,
    'exec "$real" "$@"',
    "",
  ].join("\n");
  writeFileSync(join(dir, "git"), script);
  chmodSync(join(dir, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ""}`;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = previous;
  };
}
