/**
 * The oracle of set B: what the review must be given of a hostile pull request, decided from the
 * bytes the case wrote and nothing else (design `.context/plans/pr-review-change-summary.md`,
 * sections 6.2 and 12.4). It imports nothing from the code under test: no parser, no diff, no
 * class rule. It reads lines as text, tables as lines split on tabs, and JSON with `JSON.parse`,
 * and it is deliberately cruder than the summary, so it can only ask for less than the summary
 * proves, never more: every rule below is a NECESSARY condition of "no loss is hidden".
 *
 * Ground truth, per modified or removed file the review reads (a `.tsv` or `.json`, or a root README
 * or CHANGES, outside `sourcedata/`, `derivatives/` and `code/`):
 *  - `lost`: the base lines minus the head lines, as multisets; `gained` the other way round;
 *  - kept rows: a lost line found verbatim, among the lines a pull request adds to the file at
 *    exactly `sourcedata/<one segment>/<the file's path>`, whose head header line equals the file's
 *    base header line, each copy used once;
 *  - `lostCols`: base header names missing from the head header, of columns with a value that is
 *    neither empty nor `n/a`;
 *  - `lostLeaves`: JSON leaves of the base (after `JSON.parse` and a short flatten) whose path the
 *    head does not have, less the "missing" values (`""`, `n/a`, `null`, `[]`, `{}`) and less the
 *    ones kept: the same path and value new in the one changed JSON file that applies to the file
 *    by inheritance (when exactly one does).
 *
 * The rules, each a violation when it fails:
 *  - **O-D**: a file shown in full shows every lost line as a `-` line of its diff.
 *  - **O1**: a file accounted for by the summary and not shown in full, that lost more rows than it
 *    gained (after the kept ones) or lost a column with values, or lost more leaves than it gained
 *    (after the kept ones), is in a class of a loss kind, and there is a platform finding. And over
 *    every table the summary diffed, the rows it counted removed are at least the rows the counts
 *    force: a table that lost `l` rows (after the kept ones) and gained `g` removed at least `l - g`,
 *    since a relabel, an edit and a move each take one row of each side, and only a verbatim copy
 *    at the one corresponding path is a move.
 *  - **O-R**: a file neither shown in full nor accounted for, with a lost line and not cosmetic,
 *    leaves the content incomplete (`readIncomplete`).
 *  - **O2**: after the real fence, a pair line of the summary whose two quoted tokens may LOOK alike
 *    carries a `(first difference ...)` note. They may when (a) the two tokens are equal; (b) read
 *    back as strings, they first differ at a code point at or above U+0080 (a Cyrillic letter for a
 *    Latin one, a no-break space for a space); or (c) they are equal once every `\u{...}` escape
 *    is deleted from both (a delete character, U+007F, that only the escape shows).
 *  - **O3**: one `<facts>` and one `</facts>`; as many fence opens as closes; no line outside a
 *    fence starts like a class line (`C<n> | `); as many class lines in the summary block as the
 *    facts say were shown.
 */

/** A tree as the case wrote it: path to bytes. */
export type Bytes = ReadonlyMap<string, Uint8Array>;

/** What the review was given, as the code under test produced it: read here, never recomputed. */
export interface Observed {
  patches: readonly { path: string; text: string; truncated: boolean; same: readonly string[] }[];
  readIncomplete: boolean;
  accounted: ReadonlySet<string>;
  /** The summary's classes: their kind and their files. */
  classes: readonly { kind: string; files: ReadonlySet<string> }[];
  /** The files the summary parsed and diffed (refused by no rule), and the rows it counted removed. */
  summarized: ReadonlySet<string>;
  rowsRemoved: number;
  /** How many platform findings the summary made. */
  findings: number;
  /** The review's user message, and the nonce its fences carry. */
  prompt: string;
  nonce: string;
}

export interface Violation {
  rule: "O-D" | "O1" | "O-R" | "O2" | "O3";
  path: string | null;
  detail: string;
}

export interface Verdict {
  violations: Violation[];
  /** Lost lines, columns and leaves over every file checked: zero means the case tests nothing. */
  lostUnits: number;
  /**
   * The pair lines of the summary whose tokens may look alike (O2's (a), (b) or (c)), noted or not:
   * zero means O2 had nothing to check.
   */
  lookAlikes: number;
  /** The files checked: modified or removed, in the areas the review reads. */
  checked: string[];
}

/** The kinds whose class is a loss, by the design's table (section 7.2). */
const LOSS_KINDS: ReadonlySet<string> = new Set([
  "row_removed",
  "column_removed",
  "json_key_removed",
]);

const decoder = new TextDecoder("utf-8");
const text = (b: Uint8Array): string => decoder.decode(b);

/** The lines of a text, without the empty string a final newline leaves. */
function linesOf(t: string): string[] {
  const lines = t.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A multiset of strings. */
function bag(items: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

/** `a` minus `b`, as multisets. */
function minus(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, n] of a) {
    const left = n - (b.get(k) ?? 0);
    if (left > 0) out.set(k, left);
  }
  return out;
}

const size = (m: Map<string, number>): number => [...m.values()].reduce((x, y) => x + y, 0);

/** Whether the review reads the file: the oracle's own reading of the areas, for set B's paths. */
function readArea(path: string): boolean {
  if (/^(sourcedata|derivatives|code)\//.test(path)) return false;
  if (!path.includes("/") && /^(readme|changes)(\.[A-Za-z0-9]+)?$/i.test(path)) return true;
  return /\.(tsv|json)$/.test(path);
}

const isMissingCell = (v: string): boolean => v === "" || v === "n/a";

/** The same once the whitespace a cosmetic change may touch is removed (design section 2.1). */
function cosmetic(path: string, a: string, b: string): boolean {
  if (path.endsWith(".json")) {
    try {
      JSON.parse(a);
      JSON.parse(b);
    } catch {
      return false;
    }
    const squeeze = (t: string): string => {
      let out = "";
      let inString = false;
      let escaped = false;
      for (const c of t) {
        if (inString) {
          out += c;
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
        } else if (c === '"') {
          inString = true;
          out += c;
        } else if (!" \t\n\r".includes(c)) out += c;
      }
      return out;
    };
    return squeeze(a) === squeeze(b);
  }
  if (path.endsWith(".tsv")) {
    const trim = (t: string) =>
      t
        .split("\n")
        .map((l) => l.replace(/(?<!\t)[ \r]+$/, ""))
        .join("\n");
    return trim(a) === trim(b);
  }
  return false;
}

/**
 * JSON leaves as `[path, value]`, the path a JSON array of keys and indices, the value its JSON. An
 * array of scalars is one leaf (a list that lost an element is a changed value, not a lost one),
 * which asks less than splitting it would.
 */
function leaves(doc: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const container = (x: unknown): boolean => x !== null && typeof x === "object";
  const walk = (v: unknown, path: (string | number)[]): void => {
    if (Array.isArray(v) && v.some(container)) {
      v.forEach((x, i) => walk(x, [...path, i]));
    } else if (v !== null && typeof v === "object" && Object.keys(v).length > 0) {
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
    } else {
      out.set(JSON.stringify(path), JSON.stringify(v));
    }
  };
  walk(doc, []);
  return out;
}

const missingJson = (value: string): boolean => ["null", '""', '"n/a"', "[]", "{}"].includes(value);

/** The directory, the suffix-and-extension and the entities of a BIDS file name. */
function bidsName(path: string): { dir: string; tail: string; entities: string[] } {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash);
  const name = path.slice(slash + 1);
  const dot = name.indexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const parts = stem.split("_");
  const suffix = parts.at(-1) ?? "";
  return {
    dir,
    tail: `${suffix}${dot < 0 ? "" : name.slice(dot)}`,
    entities: parts.slice(0, -1),
  };
}

/** Whether the sidecar `s` applies to the file `f` under BIDS inheritance. */
function applies(s: string, f: string): boolean {
  const a = bidsName(s);
  const b = bidsName(f);
  const ancestor = a.dir === "" || a.dir === b.dir || b.dir.startsWith(`${a.dir}/`);
  return ancestor && a.tail === b.tail && a.entities.every((e) => b.entities.includes(e));
}

/** The diff lines of a patch that remove a line, without their `-`. */
function removedLines(patch: string): Map<string, number> {
  const lines = patch.split("\n");
  const hunk = lines.findIndex((l) => l.startsWith("@@ "));
  if (hunk < 0) return new Map();
  return bag(
    lines
      .slice(hunk)
      .filter((l) => l.startsWith("-"))
      .map((l) => l.slice(1)),
  );
}

/** The tokens of a pair line of the summary block: two quoted values and the note, or null. */
function pairOf(line: string): { a: string; b: string; note: boolean } | null {
  const token = /^"(?:[^"\\]|\\.)*"(?:\.\.\.\(cut\))?/;
  if (!line.startsWith('    "')) return null;
  const rest = line.slice(4);
  const first = token.exec(rest)?.[0];
  if (first === undefined) return null;
  const after = rest.slice(first.length);
  if (!after.startsWith(" -> ")) return null;
  const second = token.exec(after.slice(4))?.[0];
  if (second === undefined) return null;
  const tail = after.slice(4 + second.length);
  const m = /^ x\d+( \(first difference at character \d+: \S+ to \S+\))?$/.exec(tail);
  if (m === null) return null;
  return { a: first, b: second, note: m[1] !== undefined };
}

/** Check one run of the review on a case: see the rules in the module's comment. */
export function check(base: Bytes, head: Bytes, seen: Observed): Verdict {
  const violations: Violation[] = [];
  let lostUnits = 0;
  const changedJson = [...head.keys()].filter(
    (p) => p.endsWith(".json") && !sameBytes(base.get(p), head.get(p)),
  );
  const shownIn = (path: string) =>
    seen.patches.find((p) => !p.truncated && (p.path === path || p.same.includes(path)));

  let forcedRows = 0;
  const checked = [...base.keys()]
    .filter((p) => readArea(p) && !sameBytes(base.get(p), head.get(p)))
    .sort();
  for (const path of checked) {
    const b = text(base.get(path) as Uint8Array);
    const h = head.has(path) ? text(head.get(path) as Uint8Array) : null;
    const bLines = linesOf(b);
    const hLines = h === null ? [] : linesOf(h);
    const lost = minus(bag(bLines), bag(hLines));
    const gained = minus(bag(hLines), bag(bLines));

    // Rows kept verbatim in the one place that keeps them.
    const keptRows = new Map<string, number>();
    const header = bLines[0];
    for (const [copy, bytes] of head) {
      const m = /^sourcedata\/([^/]+)\/(.+)$/.exec(copy);
      if (m === null || m[2] !== path) continue;
      const copyLines = linesOf(text(bytes));
      if (copyLines[0] !== header) continue;
      const before = base.has(copy) ? linesOf(text(base.get(copy) as Uint8Array)) : [];
      for (const [line, n] of minus(bag(copyLines.slice(1)), bag(before.slice(1)))) {
        keptRows.set(line, (keptRows.get(line) ?? 0) + n);
      }
    }
    const lostRows = minus(lost, keptRows);
    lostRows.delete(header ?? "");
    const gainedRows = new Map(gained);
    gainedRows.delete(hLines[0] ?? "");

    // Columns lost with a value.
    const lostCols: string[] = [];
    if (path.endsWith(".tsv") && h !== null) {
      const bHead = (bLines[0] ?? "").split("\t");
      const hHead = new Set((hLines[0] ?? "").split("\t"));
      for (const [i, name] of bHead.entries()) {
        if (hHead.has(name)) continue;
        if (bLines.slice(1).some((l) => !isMissingCell(l.split("\t")[i] ?? "")))
          lostCols.push(name);
      }
    }

    // Leaves lost with a value, and not kept in the one applying sidecar that gained them.
    let lostLeaves = 0;
    let gainedLeaves = 0;
    if (path.endsWith(".json") && h !== null) {
      let bl: Map<string, string> | null = null;
      let hl: Map<string, string> | null = null;
      try {
        bl = leaves(JSON.parse(b));
        hl = leaves(JSON.parse(h));
      } catch {
        bl = null;
      }
      if (bl !== null && hl !== null) {
        for (const [p, v] of bl) {
          if (hl.has(p) || missingJson(v)) continue;
          const homes = changedJson.filter((s) => {
            if (s === path || !applies(s, path)) return false;
            const after = safeLeaves(head.get(s));
            const before = base.has(s) ? safeLeaves(base.get(s)) : new Map<string, string>();
            return after?.get(p) === v && before?.get(p) !== v;
          });
          if (homes.length !== 1) lostLeaves++;
        }
        for (const p of hl.keys()) if (!bl.has(p)) gainedLeaves++;
      }
    }
    lostUnits += size(lost) + lostCols.length + lostLeaves;
    if (path.endsWith(".tsv") && seen.summarized.has(path)) {
      forcedRows += Math.max(0, size(lostRows) - size(gainedRows));
    }

    const shown = shownIn(path);
    const accounted = seen.accounted.has(path);
    if (shown !== undefined) {
      // O-D: every lost line is a `-` line of the diff shown.
      const removed = removedLines(shown.text);
      for (const [line, n] of lost) {
        if ((removed.get(line) ?? 0) < n) {
          violations.push({ rule: "O-D", path, detail: "a lost line is not in the diff shown" });
          break;
        }
      }
    } else if (accounted) {
      // O1: a removal the counts force is a loss class and a finding.
      const forced =
        size(lostRows) > size(gainedRows) || lostCols.length > 0 || lostLeaves > gainedLeaves;
      if (forced) {
        const inLoss = seen.classes.some((c) => LOSS_KINDS.has(c.kind) && c.files.has(path));
        if (!inLoss || seen.findings === 0) {
          violations.push({
            rule: "O1",
            path,
            detail: inLoss ? "no platform finding" : "in no class of a loss kind",
          });
        }
      }
    } else if (size(lost) > 0 && (h === null || !cosmetic(path, b, h)) && !seen.readIncomplete) {
      // O-R: what was neither shown nor accounted for leaves the content incomplete.
      violations.push({ rule: "O-R", path, detail: "unread, and the content is called complete" });
    }
  }

  if (seen.rowsRemoved < forcedRows) {
    violations.push({ rule: "O1", path: null, detail: "fewer rows counted removed than forced" });
  }
  const prompt = readPrompt(seen);
  violations.push(...prompt.violations);
  return { violations, lostUnits, lookAlikes: prompt.lookAlikes, checked };
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Buffer.from(a).equals(Buffer.from(b));
}

function safeLeaves(bytes: Uint8Array | undefined): Map<string, string> | null {
  if (bytes === undefined) return null;
  try {
    return leaves(JSON.parse(text(bytes)));
  } catch {
    return null;
  }
}

/** The marker the summary writes after a quoted token that was cut. */
const CUT = "...(cut)";

/** The JSON escapes of one character, as `JSON.stringify` writes them. */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * One quoted token of a pair line, read back as the string it stands for: `chars` with every escape
 * decoded, `shown` the same without the characters written as `\u{...}` (the ones that render as
 * nothing), and whether the token was cut. Read left to right, so a backslash the value held (written
 * `\\`) is never taken for the start of an escape. Null for a token that is not one this grammar
 * writes.
 */
function readToken(token: string): { chars: string; shown: string; cut: boolean } | null {
  const cut = token.endsWith(`"${CUT}`);
  const quoted = cut ? token.slice(0, -CUT.length) : token;
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return null;
  const body = quoted.slice(1, -1);
  let chars = "";
  let shown = "";
  for (let i = 0; i < body.length; ) {
    const c = body[i] as string;
    if (c !== "\\") {
      chars += c;
      shown += c;
      i++;
      continue;
    }
    const e = body[i + 1];
    if (e === "u" && body[i + 2] === "{") {
      const end = body.indexOf("}", i + 3);
      const hex = body.slice(i + 3, end);
      if (end < 0 || !/^[0-9A-F]{1,6}$/.test(hex)) return null;
      chars += String.fromCodePoint(Number.parseInt(hex, 16));
      i = end + 1;
      continue;
    }
    if (e === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      const ch = String.fromCharCode(Number.parseInt(hex, 16));
      chars += ch;
      shown += ch;
      i += 6;
      continue;
    }
    const simple = e === undefined ? undefined : SIMPLE_ESCAPES[e];
    if (simple === undefined) return null;
    chars += simple;
    shown += simple;
    i += 2;
  }
  return { chars, shown, cut };
}

/**
 * Which of O2's conditions makes the two tokens of a pair line look alike, or null for none: (a)
 * equal tokens; (b) a first difference, read back as strings, at a code point at or above U+0080;
 * (c) equal once every `\u{...}` escape is deleted from both. For (b), a first difference where a
 * cut token's text ends says nothing, since the value goes on past the cut.
 */
function lookAlike(a: string, b: string): "a" | "b" | "c" | null {
  if (a === b) return "a";
  const x = readToken(a);
  const y = readToken(b);
  if (x === null || y === null) return null;
  const xs = [...x.chars];
  const ys = [...y.chars];
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === ys[i]) continue;
    const ended = (xs[i] === undefined && x.cut) || (ys[i] === undefined && y.cut);
    const points = [xs[i], ys[i]].flatMap((ch) => (ch === undefined ? [] : [ch.codePointAt(0)]));
    if (!ended && points.some((p) => (p ?? 0) >= 0x80)) return "b";
    break;
  }
  if (x.shown === y.shown && x.cut === y.cut) return "c";
  return null;
}

/** O2 and O3, on the review's user message. */
export function checkPrompt(seen: Observed): Violation[] {
  return readPrompt(seen).violations;
}

/** O2 and O3, and how many pair lines O2 found that may look alike. */
function readPrompt(seen: Observed): { violations: Violation[]; lookAlikes: number } {
  const out: Violation[] = [];
  let lookAlikes = 0;
  const { prompt, nonce } = seen;
  const count = (re: RegExp) => (prompt.match(re) ?? []).length;
  if (count(/<facts>/g) !== 1 || count(/<\/facts>/g) !== 1) {
    out.push({ rule: "O3", path: null, detail: "not exactly one facts block" });
  }
  const open = `<untrusted-${nonce} kind="`;
  const close = `</untrusted-${nonce}>`;
  const lines = prompt.split("\n");
  if (lines.filter((l) => l.startsWith(open)).length !== lines.filter((l) => l === close).length) {
    out.push({ rule: "O3", path: null, detail: "fence opens and closes do not match" });
  }
  let kind: string | null = null;
  let classLines = 0;
  for (const line of lines) {
    if (kind === null && line.startsWith(open)) {
      kind = line.slice(open.length);
      continue;
    }
    if (kind !== null && line === close) {
      kind = null;
      continue;
    }
    if (kind === null) {
      if (/^C\d+ \| /.test(line)) {
        out.push({ rule: "O3", path: null, detail: "a class line outside every fence" });
      }
      continue;
    }
    if (!kind.startsWith("changed-metadata-summary")) continue;
    if (/^C\d+ \| /.test(line)) classLines++;
    const pair = pairOf(line);
    const alike = pair === null ? null : lookAlike(pair.a, pair.b);
    if (alike !== null) {
      lookAlikes++;
      if (!pair?.note) {
        const why = {
          a: "a pair reads as one value",
          b: "a pair first differs outside ASCII",
          c: "a pair differs only in escaped characters",
        }[alike];
        out.push({ rule: "O2", path: null, detail: `${why}, with no note` });
      }
    }
  }
  const factsText = prompt.slice(prompt.indexOf("<facts>\n") + 8, prompt.indexOf("\n</facts>"));
  let shown = -1;
  try {
    shown = (JSON.parse(factsText) as { change_summary: { classes_shown: number } }).change_summary
      .classes_shown;
  } catch {
    shown = -1;
  }
  if (shown !== classLines) {
    out.push({ rule: "O3", path: null, detail: "class lines and classes_shown differ" });
  }
  return { violations: out, lookAlikes };
}
