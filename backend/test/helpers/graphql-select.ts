/**
 * Answers a GraphQL query with only the fields it ASKED for.
 *
 * The GitHub stand-ins build search nodes with `prNode()`, which has every field the reader could
 * want. Without this, a stand-in answers the same nodes whatever the query selects, so deleting a
 * field from the query (the check suite's App, a state, a base branch) changes nothing in the
 * tests while real GitHub would stop sending it. Projecting the canned answer onto the query's own
 * selection set makes the query part of what is under test. It is a selection-set walker, not a
 * GraphQL implementation: no variables, aliases, directives or named fragments, none of which the
 * queue's query uses.
 */

interface Selection {
  name: string;
  /** `... on Type`: the fields apply only to a node of that type. */
  on?: string;
  children?: Selection[];
}

function tokens(text: string): string[] {
  return text.match(/\.\.\.\s*on\s+\w+|[A-Za-z_]\w*|[{}()]|[^\s{}()A-Za-z_]+/g) ?? [];
}

function parseSelections(t: string[], at: { i: number }): Selection[] {
  const out: Selection[] = [];
  while (at.i < t.length && t[at.i] !== "}") {
    const tok = t[at.i++];
    const frag = tok.match(/^\.\.\.\s*on\s+(\w+)$/);
    const sel: Selection = frag ? { name: "", on: frag[1] } : { name: tok };
    if (t[at.i] === "(") {
      let depth = 0;
      do {
        if (t[at.i] === "(") depth++;
        if (t[at.i] === ")") depth--;
        at.i++;
      } while (depth > 0 && at.i < t.length);
    }
    if (t[at.i] === "{") {
      at.i++;
      sel.children = parseSelections(t, at);
      at.i++; // the closing brace
    }
    out.push(sel);
  }
  return out;
}

/** The selections inside the operation's outermost braces. */
export function selectionsOf(query: string): Selection[] {
  const t = tokens(query);
  let depth = 0;
  let i = 0;
  // Skip the operation's name and its variable list.
  for (; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    else if (t[i] === "{" && depth === 0) break;
  }
  return parseSelections(t, { i: i + 1 });
}

function project(value: unknown, sels: Selection[]): unknown {
  if (Array.isArray(value)) return value.map((v) => project(v, sels));
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const s of sels) {
    if (s.on !== undefined) {
      if (v.__typename === s.on) Object.assign(out, project(v, s.children ?? []));
      continue;
    }
    if (!(s.name in v)) continue;
    out[s.name] = s.children ? project(v[s.name], s.children) : v[s.name];
  }
  return out;
}

/** `data` reduced to the fields `query` selects. */
export function projectOnto(query: string, data: unknown): unknown {
  return project(data, selectionsOf(query));
}
