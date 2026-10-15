/**
 * Keeps the string "undefined" out of `process.env`.
 *
 * CI TIER: unit-pure. Real filesystem, no mocks, no network, and this file deliberately never
 * names the live-tier tokens that `.github/workflows/test.yml` greps for: a file that does moves
 * to the integration tier.
 *
 * In Bun, `process.env.X = undefined` does NOT unset the variable: it stores the nine-character
 * STRING "undefined". `bun test` runs every file in one process, so a test that "restores" an
 * originally-unset variable that way pollutes every later file: `NEMAR_CONFIG_DIR="undefined"`
 * makes the CLI write under a literal `./undefined/` directory in the repository, and
 * `PATH="undefined"` stops every later spawn of `git` or `git-annex` from resolving.
 *
 * The accepted restore for an originally-unset variable is
 * `Reflect.deleteProperty(process.env, "X")` (Biome's `noDelete` flags the `delete` operator);
 * for an originally-set one, assign the saved string back.
 *
 * HOW IT SCANS. Each file is first reduced to its code: comments, string contents, template
 * literal text and regular expression bodies are blanked (each UTF-16 unit becomes one space and
 * newlines stay, so offsets and line numbers hold; the repo is LF, and CRLF is not handled),
 * then the code is searched for a write to the environment object. A line inside a multi-line
 * template literal, a fixture script a test writes to disk, a trailing `// ...` comment and a
 * string such as "process.env.X = undefined" therefore never flag. What it flags, however the
 * object is reached (`process.env`, `Bun.env`, `import.meta.env`, `globalThis.process.env`, a
 * `process . env` spaced out, `process["env"]`, or a name bound straight to it on one line,
 * `const e = process.env;`):
 *   - an assignment (`=`, `??=`, `||=`, `&&=`, with a trailing `!` allowed on the target) to a
 *     member, bracket or nested-bracket key whose right-hand side is `undefined`, `void 0` or
 *     `null` (Bun stores the string "null" as well), or an expression, on one line or spread over
 *     several, with such a branch (`cond ? "a" : undefined`, `cond ? undefined : "a"`,
 *     `x ?? undefined`, `x || undefined`);
 *   - a restore from a variable that was captured from the same key (`const saved =
 *     process.env.X; ... process.env.X = saved;`) and never assigned again in the file, when no
 *     `saved === undefined`, `!== undefined`, `== null`, `??`, `?:`, `&&`, `if (saved)` or
 *     `typeof saved` check appears in the eight lines above the assignment or earlier on its own
 *     line (a heuristic, see the limit below; `if (saved)` is deliberately lenient and any one
 *     within the window counts);
 *   - `Reflect.set(<env>, key, undefined)`;
 *   - `Object.assign(<env>, ...)` where any object literal source, anywhere in the argument list
 *     and however long, gives a property the value `undefined`.
 *
 * WHAT IT SCANS: the git-tracked TypeScript and JavaScript files under `test`, `backend/test`,
 * `src`, `backend/src`, `scripts`, `backend/scripts`, `shared` and `deploy`, listed with
 * `git ls-files` so an untracked scratch file cannot fail the guard locally and pass in CI (it
 * walks the directories instead when the tree is not a git checkout). The whole scan takes about
 * 0.4 seconds (the whole file, measured with bun test) on roughly 1,200 files. A file over 1 MB
 * or with a line over 5,000 characters is named in the failure rather than scanned, because the
 * scan is quadratic on one huge line.
 *
 * NOT FLAGGED, on purpose: an `env: { X: undefined }` option or a local object copy
 * (`const env = { ...process.env }; env.X = undefined`). Those are plain objects, not
 * `process.env`, and the spawn layer drops an undefined value rather than stringifying it.
 *
 * WHAT A TEXT SCAN CANNOT SEE: a restore from a variable that MAY be undefined,
 * `process.env.X = saved`, is the commonest way this bug is written and the scan has no types, so
 * it only catches the narrow shape above (the variable captured from the same key in the same
 * file, with no nearby check). The convention that makes it safe is a guard on the saved value:
 * `if (saved === undefined) Reflect.deleteProperty(process.env, "X"); else process.env.X = saved;`
 * (or the ternary form), and reviewers should insist on it for every restore. A value reaching the
 * write through a map, a loop, a helper or another file's variable is not seen.
 *
 * RESIDUAL GAPS, stated so nobody assumes more than is checked. The scan is text-level, not a
 * type-aware analysis, so it does not read:
 *   - a parenthesised branch: `= cond ? "a" : (undefined)`, `= (cond ? "a" : undefined)`;
 *   - an angle-bracket cast, `<any>undefined`, or `undefined satisfies T`;
 *   - a wrapped fallback, `(saved ?? undefined)!`;
 *   - `Object.defineProperty(process.env, "X", { value: undefined })`;
 *   - an env object passed through a function parameter or returned from a call, or
 *     `(process as any).env`;
 *   - an alias of `process` itself, `const p = process; p.env.X = undefined`;
 *   - an alias that is not a one-line `name = process.env`: `const { env } = process`,
 *     `import { env } from "bun"` and a typed `const e: Env = process.env` are left out on
 *     purpose, because finding them needs scope analysis and without it an unrelated local
 *     `const env = { ... }` in a file that also imports `env` would be flagged. The alias that is
 *     found is matched by name across the whole file;
 *   - a regular expression after `i++ / 2`-style code: a `/` after a word, `)`, `]` or a quote
 *     divides and after anything else starts a regex, so `i++ / 2` reads as a regex; the damage
 *     is bounded to the rest of that line, because a regex body ends at the line's end.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCANNED_ROOTS = [
  "test",
  "backend/test",
  "src",
  "backend/src",
  "scripts",
  "backend/scripts",
  "shared",
  "deploy",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);

const FIX_HINT = [
  'Bun stores the STRING "undefined" or "null" for these writes. Rules:',
  "  unset-value        the value is undefined or null: delete the key instead,",
  '                     Reflect.deleteProperty(process.env, "NAME").',
  "  unchecked-restore  a saved value is written back with no undefined check nearby: use",
  '                     if (saved === undefined) Reflect.deleteProperty(process.env, "NAME");',
  "                     else process.env.NAME = saved;",
].join("\n");

type Rule = "unset-value" | "unchecked-restore";
type EnvUndefinedHit = { line: number; text: string; rule: Rule };

// ---------------------------------------------------------------------------------------------
// Step 1: reduce a source file to its code.
// ---------------------------------------------------------------------------------------------

/** After one of these a `/` starts a regular expression; after anything else word-like it divides. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);
const WORD_CHAR = /[\w$]/;

/**
 * `source` with comments, string contents, template-literal text and regular-expression bodies
 * replaced by spaces. Newlines and every other character keep their offsets, so a match in the
 * result has the same line number in the original. `${ ... }` inside a template is code and is
 * kept. One string content survives on purpose: the bare word `env`, so `process["env"]` can be
 * read; it cannot spell an assignment.
 */
function blankNonCode(source: string): string {
  const out: string[] = [];
  const length = source.length;
  // A frame per open template literal (`template`) or per `${` inside one (`code`, counting braces).
  const stack: Array<{ kind: "template" } | { kind: "code"; depth: number }> = [];
  const blank = (char: string) => out.push(char === "\n" ? "\n" : " ");
  const previousToken = () => {
    let at = out.length - 1;
    while (at >= 0 && /\s/.test(out[at])) at--;
    if (at < 0) return { char: "", word: "" };
    const char = out[at];
    if (!WORD_CHAR.test(char)) return { char, word: "" };
    let start = at;
    while (start > 0 && WORD_CHAR.test(out[start - 1])) start--;
    return { char, word: out.slice(start, at + 1).join("") };
  };

  let i = 0;
  while (i < length) {
    const top = stack[stack.length - 1];
    const char = source[i];

    if (top?.kind === "template") {
      if (char === "\\") {
        blank(char);
        if (i + 1 < length) blank(source[i + 1]);
        i += 2;
      } else if (char === "`") {
        out.push("`");
        stack.pop();
        i++;
      } else if (char === "$" && source[i + 1] === "{") {
        out.push("$", "{");
        stack.push({ kind: "code", depth: 0 });
        i += 2;
      } else {
        blank(char);
        i++;
      }
      continue;
    }

    if (char === "/" && source[i + 1] === "/") {
      while (i < length && source[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const stop = close < 0 ? length : close + 2;
      for (; i < stop; i++) blank(source[i]);
      continue;
    }
    if (char === '"' || char === "'") {
      out.push(char);
      i++;
      const start = i;
      while (i < length && source[i] !== char && source[i] !== "\n")
        i += source[i] === "\\" ? 2 : 1;
      const content = source.slice(start, Math.min(i, length));
      const keep = content === "env";
      for (let k = 0; k < content.length; k++) {
        if (keep) out.push(content[k]);
        else blank(content[k]);
      }
      if (source[i] === char) {
        out.push(char);
        i++;
      }
      continue;
    }
    if (char === "`") {
      out.push("`");
      stack.push({ kind: "template" });
      i++;
      continue;
    }
    if (top?.kind === "code") {
      if (char === "{") top.depth++;
      else if (char === "}") {
        if (top.depth === 0) {
          stack.pop();
          out.push("}");
          i++;
          continue;
        }
        top.depth--;
      }
    }
    if (char === "/") {
      const { char: before, word } = previousToken();
      const divides =
        (WORD_CHAR.test(before) && !REGEX_AFTER_WORD.has(word)) ||
        before === ")" ||
        before === "]" ||
        before === '"' ||
        before === "'" ||
        before === "`";
      if (!divides) {
        out.push("/");
        i++;
        let inClass = false;
        while (i < length && source[i] !== "\n") {
          const c = source[i];
          if (c === "\\") {
            blank(c);
            if (i + 1 < length) blank(source[i + 1]);
            i += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          blank(c);
          i++;
        }
        if (source[i] === "/") {
          out.push("/");
          i++;
        }
        continue;
      }
    }
    out.push(char);
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------------------------
// Step 2: find writes to the environment object in that code.
// ---------------------------------------------------------------------------------------------

/** The environment object itself: `process.env`, `Bun.env`, `import.meta.env`, spaced or computed. */
const ENV_OBJECT =
  "(?:(?:globalThis|global)\\s*\\.\\s*)?(?:process\\s*(?:\\.\\s*env|\\[\\s*[\"'`]env[\"'`]\\s*\\])|Bun\\s*\\.\\s*env|import\\s*\\.\\s*meta\\s*\\.\\s*env)";
const IDENT = "[A-Za-z_$][\\w$]*";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names this file binds directly to the environment object: `const e = process.env;`. */
function envAliases(code: string): string[] {
  const bound = new RegExp(`(?<![\\w$.])(${IDENT})\\s*=\\s*${ENV_OBJECT}\\s*(?:;|,|\\n|$)`, "g");
  return [...new Set([...code.matchAll(bound)].map((m) => m[1]))];
}

/** Index of the bracket that closes the one at `open`, or -1. */
function matchingClose(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The code between `from` and `to` split at top-level commas: trimmed pieces and their offsets. */
function splitTopLevel(
  code: string,
  from: number,
  to: number,
): Array<{ text: string; at: number }> {
  const pieces: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i <= to; i++) {
    const c = i === to ? "," : code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      const raw = code.slice(start, i);
      if (raw.trim() !== "")
        pieces.push({ text: raw.trim(), at: start + raw.length - raw.trimStart().length });
      start = i + 1;
    }
  }
  return pieces;
}

const UNSET = "(?:undefined|null|void\\s+0)";

/**
 * Whether an expression is `undefined`, `void 0` or `null` (Bun stores the string "null" too),
 * however parenthesised or cast, or is a ternary with such a branch, or ends `?? undefined` or
 * `|| undefined`. Line breaks inside the expression do not matter.
 */
function isUnsetValue(expression: string): boolean {
  let e = expression.replace(/\s+/g, " ").trim();
  while (e.startsWith("(") && e.endsWith(")")) e = e.slice(1, -1).trim();
  e = e
    .replace(/ as .*$/, "")
    .replace(/!$/, "")
    .trim();
  if (new RegExp(`^${UNSET}$`).test(e)) return true;
  if (new RegExp(`\\? ?${UNSET} ?:`).test(e)) return true;
  if (e.includes("?") && new RegExp(`: ?${UNSET}(?: as [^:?]*)?$`).test(e)) return true;
  return new RegExp(`(?:\\?\\?|\\|\\|) ?${UNSET}$`).test(e);
}

/**
 * Where the right-hand side that starts at `from` ends: at `;`, at a closing bracket that is not
 * ours, or at a line break unless the expression visibly goes on (the next line starts with `?`,
 * `:`, `|` or `&`, or this one ends with `?`, `:`, `|`, `&`, `+`, `,` or `=`). A blank line ends it.
 */
function valueEnd(code: string, from: number): number {
  let depth = 0;
  for (let end = from; end < code.length; end++) {
    const c = code[end];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth < 0) return end;
    } else if (depth === 0 && c === ";") return end;
    else if (depth === 0 && c === "\n") {
      let before = end - 1;
      while (before > from && /[ \t\r]/.test(code[before])) before--;
      let after = end + 1;
      while (after < code.length && /[ \t\r]/.test(code[after])) after++;
      const goesOn = "?:|&".includes(code[after] ?? "\n") || "?:|&+,=".includes(code[before]);
      if (code[after] === "\n" || !goesOn) return end;
    }
  }
  return code.length;
}

const MAX_FILE_CHARS = 1_000_000;
const MAX_LINE_CHARS = 5_000;

/**
 * Why `source` is too big to scan, or null. The scan is linear on ordinary code but quadratic on
 * a single very long line (a minified bundle took over a minute at 800 KB), so such a file must
 * be seen and decided on rather than hang the suite. The largest source file in the tree today
 * is about 420 KB.
 */
function scanLimitProblem(source: string): string | null {
  if (source.length > MAX_FILE_CHARS) return `larger than ${MAX_FILE_CHARS} characters`;
  let longest = 0;
  for (const line of source.split("\n")) longest = Math.max(longest, line.length);
  return longest > MAX_LINE_CHARS ? `has a line of ${longest} characters` : null;
}

/** Every place `source` writes undefined into the environment object, as 1-based lines. */
function findEnvUndefinedWrites(source: string): EnvUndefinedHit[] {
  if (!/env/.test(source)) return [];
  const code = blankNonCode(source);
  const lines = source.split("\n");
  const lineStarts = [0];
  for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const aliases = envAliases(code);
  const names = [ENV_OBJECT, ...aliases.map(escapeRegExp)].join("|");
  const reference = new RegExp(`(?<![\\w$.])(?:${names})`, "g");
  const isEnvObject = new RegExp(`^(?:${names})$`);
  const flagged = new Map<number, Rule>();

  // Every `<env>.KEY` or `<env>[expr]` reference, with the key it names and where it ends.
  const members: Array<{ index: number; key: string; end: number }> = [];
  for (const ref of code.matchAll(reference)) {
    let at = ref.index + ref[0].length;
    while (/\s/.test(code[at] ?? "")) at++;
    let key: string;
    if (code[at] === ".") {
      at++;
      while (/\s/.test(code[at] ?? "")) at++;
      const name = new RegExp(IDENT, "y");
      name.lastIndex = at;
      const named = name.exec(code);
      if (!named) continue;
      key = named[0];
      at += named[0].length;
    } else if (code[at] === "[") {
      const close = matchingClose(code, at);
      if (close < 0) continue;
      key = code.slice(at, close + 1).replace(/\s+/g, "");
      at = close + 1;
    } else {
      continue;
    }
    members.push({ index: ref.index, key, end: at });
  }

  // Variables that captured a key's value: `const saved = process.env.X;`, `saved = process.env.X;`.
  const captured = new Map<string, { keys: Set<string>; bindings: number }>();
  for (const member of members) {
    if (!/^[ \t]*(?:;|\n|$)/.test(code.slice(member.end, member.end + 40))) continue;
    const before = code.slice(Math.max(0, member.index - 200), member.index);
    const binding = new RegExp(`(?<![\\w$.])(${IDENT})\\s*(?::[^=;]*)?=\\s*$`).exec(before);
    if (!binding) continue;
    const entry = captured.get(binding[1]) ?? { keys: new Set<string>(), bindings: 0 };
    entry.keys.add(member.key);
    entry.bindings++;
    captured.set(binding[1], entry);
  }
  // A variable assigned anywhere else in the file may no longer hold what the key held.
  for (const [name, entry] of captured) {
    const assignment = new RegExp(
      `(?<![\\w$.])${escapeRegExp(name)}\\s*(?::[^=;\\n]*)?(?:\\?\\?|\\|\\||&&|[-+*/])?=(?![=>])`,
      "g",
    );
    if ([...code.matchAll(assignment)].length > entry.bindings) captured.delete(name);
  }
  /** A check on `name` in the eight lines above the write, or earlier on its own line. */
  const isChecked = (name: string, offset: number) => {
    const window = code.slice(lineStarts[Math.max(0, lineAt(offset) - 9)], offset);
    const id = escapeRegExp(name);
    return [
      `\\b${id}\\s*(?:===|!==|==|!=)\\s*(?:undefined|null)`,
      `(?:undefined|null)\\s*(?:===|!==|==|!=)\\s*${id}\\b`,
      `\\b${id}\\s*(?:\\?\\?|\\?|&&)`,
      `\\bif\\s*\\(\\s*!?\\s*${id}\\s*\\)`,
      `\\btypeof\\s+${id}\\b`,
    ].some((pattern) => new RegExp(pattern).test(window));
  };

  // `<env>.KEY = undefined`, `<env>[expr] = undefined`, the logical-assignment forms, and the
  // restore from a captured variable that nothing checked.
  for (const member of members) {
    const operator = /\s*!?\s*(\?\?=|\|\|=|&&=|=(?![=>]))\s*/y;
    operator.lastIndex = member.end;
    if (!operator.exec(code)) continue;
    const value = code.slice(operator.lastIndex, valueEnd(code, operator.lastIndex)).trim();
    if (isUnsetValue(value)) {
      flagged.set(lineAt(member.index), "unset-value");
    } else if (
      new RegExp(`^${IDENT}$`).test(value) &&
      captured.get(value)?.keys.has(member.key) &&
      !isChecked(value, member.index)
    ) {
      flagged.set(lineAt(member.index), "unchecked-restore");
    }
  }

  // `Reflect.set(<env>, key, undefined)` and `Object.assign(<env>, ...sources)`.
  for (const call of code.matchAll(/(?<![\w$.])(Reflect\s*\.\s*set|Object\s*\.\s*assign)\s*\(/g)) {
    const open = call.index + call[0].length - 1;
    const close = matchingClose(code, open);
    if (close < 0) continue;
    const args = splitTopLevel(code, open + 1, close);
    if (args.length === 0 || !isEnvObject.test(args[0].text.trim())) continue;
    if (call[1].startsWith("Reflect")) {
      if (args[2] && isUnsetValue(args[2].text)) flagged.set(lineAt(args[2].at), "unset-value");
      continue;
    }
    for (const source of args.slice(1)) {
      if (!source.text.startsWith("{") || !source.text.endsWith("}")) continue;
      const from = source.at + 1;
      for (const property of splitTopLevel(code, from, from + source.text.length - 2)) {
        const colon = property.text.indexOf(":");
        if (colon >= 0 && isUnsetValue(property.text.slice(colon + 1))) {
          flagged.set(lineAt(property.at), "unset-value");
        }
      }
    }
  }

  return [...flagged]
    .sort((a, b) => a[0] - b[0])
    .map(([line, rule]) => ({ line, text: (lines[line - 1] ?? "").trim(), rule }));
}

/** Every source file under `roots` by walking the directories (used when git cannot answer). */
function walkSourceFiles(base: string, roots: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name));
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
        found.push(join(directory, entry.name));
      }
    }
  };
  for (const root of roots) if (existsSync(join(base, root))) walk(join(base, root));
  return found;
}

/**
 * The source files under `roots` that git tracks, so a scratch file that is not committed cannot
 * fail the guard on one machine and pass in CI. Falls back to walking the directories when `base`
 * is not a git checkout (a source tarball) or git is not installed.
 */
function listSourceFiles(base: string, roots: string[]): string[] {
  try {
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", ...roots], {
      cwd: base,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (listed.exitCode === 0) {
      const tracked = listed.stdout
        .toString()
        .split("\0")
        .filter((file) => file !== "" && SOURCE_EXTENSIONS.has(extname(file)))
        .map((file) => join(base, file))
        .filter((file) => existsSync(file));
      if (tracked.length > 0) return tracked;
    }
  } catch {
    // git is not installed: walk instead.
  }
  return walkSourceFiles(base, roots);
}

describe("the scanner", () => {
  // Each entry: a name, a snippet, and the 1-based lines that must be reported.
  const BAD: Array<[string, string[], number[]]> = [
    ["a member write", ["process.env.A = undefined;"], [1]],
    ["no spaces around the operator", ["process.env.A=undefined;"], [1]],
    ["a string bracket key", ['process.env["A"] = undefined;'], [1]],
    ["an identifier bracket key", ["process.env[name] = undefined"], [1]],
    ["a nested bracket key", ["process.env[keys[0]] = undefined;"], [1]],
    ["Bun.env with a bracket key", ['Bun.env["X"] = undefined;'], [1]],
    ["void 0", ["process.env.A = void 0;"], [1]],
    ["a value on the next line", ["process.env.A =", "  undefined;"], [1]],
    ["undefined with a cast", ["process.env.A = undefined as unknown as string;"], [1]],
    ["a trailing line comment after the write", ["process.env.A = undefined; // restore"], [1]],
    ["??=", ["process.env.A ??= undefined;"], [1]],
    ["||=", ["process.env.A ||= undefined;"], [1]],
    ["a non-null target", ["process.env.A! = undefined;"], [1]],
    ["a spaced-out process . env", ["process . env.A = undefined;"], [1]],
    ["import.meta.env", ["import.meta.env.A = undefined;"], [1]],
    ["globalThis.process.env", ["globalThis.process.env.A = undefined;"], [1]],
    ['process["env"]', ['process["env"].A = undefined;'], [1]],
    [
      "code after a regex literal holding a quote",
      ["const q = /[\"']/;", "process.env.A = undefined;"],
      [2],
    ],
    ["Reflect.set", ['Reflect.set(process.env, "A", undefined);'], [1]],
    ["Reflect.set with a call in the key", ["Reflect.set(process.env, key(), void 0);"], [1]],
    ["an alias const", ["const e = process.env;", "e.A = undefined;"], [2]],
    [
      "an alias through Object.assign",
      ["const e = process.env;", "Object.assign(e, { A: undefined });"],
      [2],
    ],
    ["a ternary with an undefined second branch", ['process.env.A = cond ? "a" : undefined;'], [1]],
    ["a ternary with an undefined first branch", ['process.env.A = cond ? void 0 : "a";'], [1]],
    ["a fallback to undefined", ["process.env.A = maybe ?? undefined;"], [1]],
    [
      "Reflect.set with an undefined ternary branch",
      ['Reflect.set(process.env, "A", c ? "a" : undefined);'],
      [1],
    ],
    [
      "Object.assign with an undefined ternary branch",
      ['Object.assign(process.env, { A: c ? "a" : undefined });'],
      [1],
    ],
    [
      "a restore from a variable captured from the key, with no check",
      ["const saved = process.env.A;", "run();", "process.env.A = saved;"],
      [3],
    ],
    [
      "a restore from a variable assigned from the key earlier",
      ["let saved: string | undefined;", "saved = process.env.A;", "process.env.A = saved;"],
      [3],
    ],
    [
      "a restore of a bracket key",
      ["const prev = process.env[name];", "process.env[name] = prev;"],
      [2],
    ],
    [
      "a restore whose only check is more than eight lines up",
      [
        "const saved = process.env.A;",
        "if (saved === undefined) run();",
        ...Array.from({ length: 8 }, () => "step();"),
        "process.env.A = saved;",
      ],
      [11],
    ],
    [
      "a restore from a variable that was never reassigned",
      ["let saved = process.env.A;", "step();", "process.env.A = saved;"],
      [3],
    ],
    ["null", ["process.env.A = null;"], [1]],
    ["a null fallback", ["process.env.A = maybe ?? null;"], [1]],
    ["Object.assign with a null value", ["Object.assign(process.env, { A: null });"], [1]],
    [
      "a multi-line ternary in Biome's layout",
      ["process.env.A = cond", '  ? "a"', "  : undefined;"],
      [1],
    ],
    [
      "a multi-line ternary with the operators at line ends",
      ["process.env.A = cond ?", '  "a" :', "  undefined;"],
      [1],
    ],
    [
      "a multi-line ternary with an undefined first branch",
      ["process.env.A = cond", "  ? undefined", '  : "a";'],
      [1],
    ],
    [
      "Reflect.set over several lines, reported at the value",
      ["Reflect.set(", "  process.env,", '  "A",', "  undefined,", ");"],
      [4],
    ],
    ["Object.assign on one line", ["Object.assign(process.env, { A: undefined });"], [1]],
    [
      "Object.assign after a call argument",
      ["Object.assign(process.env, a(), { A: undefined });"],
      [1],
    ],
    [
      "Object.assign after a call value",
      ["Object.assign(process.env, { A: foo(), B: undefined });"],
      [1],
    ],
    [
      "Object.assign over several lines",
      ["Object.assign(process.env, {", '  KEPT: "1",', "  DROPPED: undefined,", "});"],
      [3],
    ],
    ["write in a template interpolation", ["const s = `${(process.env.A = undefined)}`;"], [1]],
  ];

  for (const [name, lines, expected] of BAD) {
    test(`flags ${name}`, () => {
      expect(findEnvUndefinedWrites(lines.join("\n")).map((h) => h.line)).toEqual(expected);
    });
  }

  const GOOD: Array<[string, string[]]> = [
    [
      "the accepted restores",
      [
        "const saved = process.env.A;",
        'if (saved === undefined) Reflect.deleteProperty(process.env, "A");',
        "else process.env.A = saved;",
      ],
    ],
    [
      "comparisons with undefined",
      ["if (process.env.A === undefined) run();", "const s = process.env.A == undefined;"],
    ],
    [
      "a local copy of the environment",
      ['const env = { ...process.env, KEPT: "1" };', "env.DROPPED = undefined;"],
    ],
    [
      "an unrelated local named env in a file that also imports env",
      [
        'import { env } from "bun";',
        "function f() {",
        '  const env = { A: "1" };',
        "  env.A = undefined;",
        "}",
      ],
    ],
    ["a spawn env option", ["spawn(cmd, { env: { DROPPED: undefined } });"]],
    ["a PATH built in a template", ['process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;']],
    [
      "assigning a string",
      ['process.env.A = "undefined-ish";', 'Reflect.set(process.env, "A", "1");'],
    ],
    ["Object.assign of strings", ['Object.assign(process.env, { A: "1", B: String(x) });']],
    [
      "Object.assign onto a plain object",
      ["Object.assign(local, { A: undefined });", 'Reflect.set(local, "A", undefined);'],
    ],
    ["a line comment", ["// process.env.A = undefined stores the string"]],
    ["a doc-comment line", [" * `process.env.A = undefined` does not unset anything"]],
    ["a block comment", ["/* process.env.A = undefined", "   process.env.B = undefined */"]],
    ["a trailing comment", ["run(); // process.env.A = undefined stores the string"]],
    [
      "a string literal",
      ['const s = "process.env.A = undefined";', "const t = 'process.env.B = void 0';"],
    ],
    ["a one-line template literal", ["const s = `process.env.A = undefined`;"]],
    [
      "a multi-line template literal, such as a fixture script a test writes",
      [
        "writeFileSync(path, `#!/bin/sh",
        "process.env.A = undefined",
        "Object.assign(process.env, { B: undefined })",
        "`);",
      ],
    ],
    [
      "a multi-line ternary of two strings",
      ["process.env.A = cond", '  ? "a"', '  : "b";', "step();"],
    ],
    [
      "a restore from a variable reassigned before the write",
      ["let saved = process.env.A;", 'saved = "foo";', "process.env.A = saved;"],
    ],
    [
      "a restore whose check is eight lines up",
      [
        "const saved = process.env.A;",
        "if (saved === undefined) run();",
        ...Array.from({ length: 7 }, () => "step();"),
        "process.env.A = saved;",
      ],
    ],
    [
      "a ternary of two strings",
      ['process.env.A = cond ? "a" : "b";', 'Object.assign(process.env, { B: c ? "a" : "b" });'],
    ],
    [
      "a restore guarded on the same line",
      ["const saved = process.env.A;", "if (saved !== undefined) process.env.A = saved;"],
    ],
    [
      "a restore guarded on the line above",
      [
        "const saved = process.env.A;",
        'if (saved === undefined) Reflect.deleteProperty(process.env, "A");',
        "else process.env.A = saved;",
      ],
    ],
    [
      "a restore guarded by a ternary",
      [
        "const saved = process.env.A;",
        'saved === undefined ? Reflect.deleteProperty(process.env, "A") : (process.env.A = saved);',
      ],
    ],
    [
      "a restore guarded by a truthiness check",
      ["const saved = process.env.A;", "if (saved) process.env.A = saved;"],
    ],
    [
      "a variable captured from a different key",
      ["const saved = process.env.A;", "process.env.B = saved;"],
    ],
    ["a variable that was never read from the environment", ["process.env.A = fromElsewhere;"]],
    ["a regular expression literal", ["const re = /process\\.env\\.A = undefined/;"]],
    [
      "division, which is not a regular expression",
      ["const half = total / 2;", 'process.env.A = "x"; const q = total / 4;'],
    ],
  ];

  for (const [name, lines] of GOOD) {
    test(`passes ${name}`, () => {
      expect(findEnvUndefinedWrites(lines.join("\n"))).toEqual([]);
    });
  }

  test("blanking keeps every offset, astral characters and escapes included", () => {
    const source = 'const s = "\u{1F600}\\"x"; const t = `a${b}\u{1F600}`; // \u{1F600}\nrun();';
    expect(blankNonCode(source).length).toBe(source.length);
  });

  test("reports the offending line number and the text of that line", () => {
    const [hit] = findEnvUndefinedWrites("x();\n  process.env.REPORTED = undefined;\n");
    expect(hit).toEqual({
      line: 2,
      text: "process.env.REPORTED = undefined;",
      rule: "unset-value",
    });
    const [restore] = findEnvUndefinedWrites(
      "const saved = process.env.R;\nrun();\nprocess.env.R = saved;\n",
    );
    expect(restore.rule).toBe("unchecked-restore");
  });
});

describe("the size limits", () => {
  test("name a minified-looking line and an oversized file, and accept ordinary code", () => {
    expect(scanLimitProblem("a();\n".repeat(50))).toBeNull();
    expect(scanLimitProblem(`a();\n${"x".repeat(5_001)}\n`)).toBe("has a line of 5001 characters");
    expect(scanLimitProblem("a();\n".repeat(200_001))).toContain("larger than");
  });
});

describe("the file listing", () => {
  test("lists tracked files only inside a git checkout, and walks outside one", () => {
    const base = mkdtempSync(join(tmpdir(), "env-guard-list-"));
    const git = (...args: string[]) => {
      try {
        Bun.spawnSync(["git", ...args], { cwd: base, stdout: "ignore", stderr: "ignore" });
      } catch (error) {
        // The usual cause: an earlier test restored PATH with `= undefined`, the very bug this
        // file guards, so PATH is now the string "undefined" and git cannot be found.
        throw new Error(`cannot run git (PATH=${process.env.PATH}): ${error}`);
      }
    };
    try {
      writeFileSync(join(base, "committed.ts"), "export {};\n");
      writeFileSync(join(base, "scratch.ts"), "export {};\n");
      git("init", "-q");
      git("add", "committed.ts");
      const listed = () =>
        listSourceFiles(base, ["."])
          .map((f) => relative(base, f))
          .sort();
      expect(listed()).toEqual(["committed.ts"]);
      rmSync(join(base, ".git"), { recursive: true, force: true });
      expect(listed()).toEqual(["committed.ts", "scratch.ts"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the repository", () => {
  test("no test, script or source file writes undefined into process.env", () => {
    const offenders: string[] = [];
    const files = listSourceFiles(REPO_ROOT, SCANNED_ROOTS);
    const unscannable: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const problem = scanLimitProblem(source);
      if (problem) {
        unscannable.push(`${relative(REPO_ROOT, file)} ${problem}`);
        continue;
      }
      for (const hit of findEnvUndefinedWrites(source)) {
        offenders.push(`${relative(REPO_ROOT, file)}:${hit.line}: ${hit.text}  [${hit.rule}]`);
      }
    }
    // A file the scan refused is named, never skipped silently: shrink it or raise the limit.
    expect(unscannable.join("\n")).toBe("");
    // A scan that read nothing would pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    // Joined so a failure prints file:line for every hit. Restore an originally-unset variable
    // with Reflect.deleteProperty(process.env, "NAME"), or assign the saved string back.
    expect(offenders.length === 0 ? "" : [...offenders, "", FIX_HINT].join("\n")).toBe("");
  });
});
