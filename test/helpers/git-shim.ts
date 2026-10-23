/**
 * A pass-through wrapper for the real Git executable. Tests may add environment
 * variables to one matching call, record its arguments, its environment or its standard
 * input, or delay it, from its first matching call or from a later one; it never changes
 * Git's input, output or exit status.
 *
 * `env` lets a test steer one child process (for example point git-annex's HTTP client
 * at a dead local proxy) without writing to `process.env`: Bun keeps a proxy variable
 * set in-process for later `fetch` calls even after the variable is restored.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ShimRule {
  /** A substring of the space-joined arguments, for example `annex initremote`. */
  match: string;
  /** Export variables for this call, then run the real Git executable. */
  env?: Record<string, string>;
  /** Append the call's arguments, one line per call, then run the real Git executable. */
  log?: string;
  /**
   * Append the environment the call was started with, then run the real Git executable: a line
   * `== <arguments>`, then the output of `env`, one `NAME=value` per line. For a test that says what
   * a child process was handed, and what it was not.
   */
  envLog?: string;
  /**
   * Append the call's standard input, then run the real Git executable on that same input: what a
   * batch call such as `cat-file --batch-check` was asked about.
   */
  stdinLog?: string;
  /**
   * Wait this many seconds before running the real Git executable: a fetch that stalls. The wait
   * holds none of the call's pipes, so a caller that kills the call on a timeout is not kept
   * waiting for it, and it ends with the call, so no sleep is left running after a test.
   */
  sleepSeconds?: number;
  /**
   * Act only from this matching call on, counting from 1: the earlier matches run the real Git
   * executable untouched (and are not logged). Counted in a file beside the wrapper, so a test can
   * stall the third read of a kind and not the first two. Unset, the rule acts on every match.
   */
  fromCall?: number;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * One call recorded by a rule's `envLog`: its arguments, space-joined with a space at each end (the
 * form a rule's `match` is tested against), and the environment it was started with.
 */
export interface RecordedEnv {
  args: string;
  env: Record<string, string>;
}

/** The calls a rule's `envLog` recorded, in order. A value that spans lines is cut at its first. */
export function readEnvLog(path: string): RecordedEnv[] {
  const calls: RecordedEnv[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("== ")) {
      calls.push({ args: line.slice(3), env: {} });
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    const call = calls[calls.length - 1];
    if (m?.[1] !== undefined && call !== undefined) call.env[m[1]] = m[2] ?? "";
  }
  return calls;
}

/**
 * Put the pass-through wrapper first on PATH for the current process and return
 * the function that removes it. Always call the restorer in a `finally`.
 */
export function installGitShim(root: string, rules: ShimRule[]): () => void {
  const real = Bun.which("git");
  if (!real) throw new Error("git not found");
  const dir = join(root, `git-wrapper-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const blocks = rules.map((rule, index) => {
    const lines: string[] = Object.entries(rule.env ?? {}).map(
      ([k, v]) => `  export ${k}=${quote(v)}`,
    );
    if (rule.log !== undefined) lines.push(`  printf '%s\\n' "$args" >> ${quote(rule.log)}`);
    if (rule.envLog !== undefined) {
      lines.push(`  { printf '== %s\\n' "$args"; env; } >> ${quote(rule.envLog)}`);
    }
    if (rule.stdinLog !== undefined) {
      // A copy of the input, appended to the log and then made the input of the real call.
      lines.push(
        `  stdin_copy=$(mktemp ${quote(join(dir, "stdin.XXXXXX"))})`,
        '  cat > "$stdin_copy"',
        `  cat "$stdin_copy" >> ${quote(rule.stdinLog)}`,
        '  exec < "$stdin_copy"',
      );
    }
    if (rule.sleepSeconds !== undefined) {
      // In the background and waited for, so a signal that ends the call reaches the trap at once,
      // which ends the sleep with it: a sleep in the foreground outlives a killed call as an orphan.
      lines.push(
        `  sleep ${Number(rule.sleepSeconds)} </dev/null >/dev/null 2>&1 &`,
        "  sleeper=$!",
        `  trap 'kill "$sleeper" 2>/dev/null; exit 143' HUP INT TERM`,
        '  wait "$sleeper"',
        "  trap - HUP INT TERM",
      );
    }
    if (rule.fromCall !== undefined) {
      const counter = quote(join(dir, `calls-${index}`));
      return [
        `case "$args" in *${quote(rule.match)}*)`,
        `  n=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))`,
        `  echo "$n" > ${counter}`,
        `  if [ "$n" -ge ${Number(rule.fromCall)} ]; then`,
        ...lines.map((line) => `  ${line}`),
        "  fi",
        "  ;;",
        "esac",
      ].join("\n");
    }
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
