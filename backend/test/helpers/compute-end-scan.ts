/**
 * A scan of the Worker's source for the two sets that must agree (epic #2005 phase A8, #2013;
 * AGENTS.md, "Revocation cascades, always"): the functions that RUN `computeReleaseStatements`, and the
 * functions that END every credential of an account. It reads the syntax tree the compiler reads, so a
 * rule is about what the code DOES and not how it is spelled, and it takes a `Tree` so a test can lay a
 * planted file over the real ones and show the rule FIRES.
 *
 * A UNIT is the innermost function (a declaration, a variable's arrow, a method, or the callback of a
 * route registration, labelled `POST /path`), or the module's top level; a unit's facts are the strings
 * and names in it OUTSIDE any function nested in it.
 *
 * "RUNS the compute set" is any reference to `computeReleaseStatements`, however it is reached: a named
 * import, an aliased one (`import { computeReleaseStatements as x }`), a namespace import's property
 * (`ns.computeReleaseStatements`, `ns["computeReleaseStatements"]`), a local alias (`const f = ...`,
 * a destructuring of the namespace) and a use that passes the function as a value (`.map(f)`) rather than
 * calling it. What the scan cannot follow it refuses to guess about (`unfollowable`): a dynamic import, a
 * re-export, and a reference at module top level (it could be re-exported under another name).
 *
 * "ENDS every credential" is a unit that revokes all of an account's API keys AND ends its sessions, THROUGH
 * THESE STATEMENT SHAPES and no others, whether the SQL is in the unit or in a constant or function it
 * names (resolved by VALUE, to a fixed point, so a new constant or helper is found by what it does and not
 * by what it is called):
 *   - keys: `UPDATE tokens SET revoked_at ...` whose WHERE clause holds `user_id` equal to a placeholder
 *     (`?`, `?1`), `IN (...)` or a subselect, in either order of its predicates, with the table quoted,
 *     bracketed, schema-qualified or `OR`-prefixed, in any case; a WHERE clause that also names one key
 *     (`id`, `api_key_hash`, `api_key_prefix`) is a one-key revocation and is NOT an end;
 *   - sessions: `UPDATE web_sessions SET revoked_at ...` (of any scope), or `DELETE FROM web_sessions`
 *     whose WHERE clause holds `user_id` (a delete of expired sessions, or of one session by its cookie,
 *     is not an end).
 * A revocation written any other way (SQL built from parts the scan cannot fold, a statement in a template
 * with the table name interpolated, a stored procedure) is NOT recognised: the scan is a tripwire for the
 * shapes the Worker uses, not a proof that no path ends an account.
 *
 * KNOWN LIMIT, stated so nobody over-reads it: a name is resolved to the module that defines it through the
 * file's own imports (named, aliased, namespace) and its own top-level declarations; a name that is neither
 * (a parameter, a local, a property of an object, a re-exported name the scan does not follow) is
 * unresolved and counts for nothing, so a common helper name elsewhere cannot make an unrelated function an
 * "end". A name reached through a barrel file or an object's method is not followed.
 */

import ts from "typescript";
import { SRC, type Tree, foldString, parse, rel, resolveImport } from "./ts-scan";

export const COMPUTE_SET_FUNCTION = "computeReleaseStatements";

/**
 * The statement set a scan looks for: the base name of the module that exports it (no extension) and the
 * exported function. The default is the compute set; `compute-runner-end-callers.test.ts` scans for
 * `runnerEndStatements` of `compute-runners` the same way, so the two sets are held by ONE scan.
 */
export interface ScanTarget {
  module: string;
  fn: string;
}

export const COMPUTE_TARGET: ScanTarget = { module: "compute-release", fn: COMPUTE_SET_FUNCTION };

const TABLE = (name: string) => `(?:["\`\\[]?\\w+["\`\\]]?\\.)?["\`\\[]?${name}["\`\\]]?`;
const UPDATE_TOKENS_RE = new RegExp(
  `\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${TABLE("tokens")}\\s+SET\\s+revoked_at\\b([\\s\\S]*)$`,
  "i",
);
const UPDATE_SESSIONS_RE = new RegExp(
  `\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${TABLE("web_sessions")}\\s+SET\\s+revoked_at\\b`,
  "i",
);
const DELETE_SESSIONS_RE = new RegExp(
  `\\bDELETE\\s+FROM\\s+${TABLE("web_sessions")}\\b([\\s\\S]*)$`,
  "i",
);
/** `user_id` equal to a placeholder or a subselect, or `IN (...)`. */
const USER_PREDICATE_RE = /\buser_id\b\s*(?:=\s*\(?\s*(?:\?\d*|SELECT\b)|IN\s*\()/i;
/** A predicate that names ONE key: `id`, `api_key_hash` or `api_key_prefix` compared (not `user_id`). */
const ONE_KEY_PREDICATE_RE = /(?<![\w])(?:id|api_key_hash|api_key_prefix)\s*(?:=|IN\b)/i;

const whereOf = (rest: string): string | null => {
  const m = /\bWHERE\b([\s\S]*)$/i.exec(rest);
  return m ? (m[1] ?? "") : null;
};

/** Whether `text` holds a statement that revokes ALL of a user's API keys (see the header for the shapes). */
export function revokesAllKeys(text: string): boolean {
  return text.split(";").some((statement) => {
    const m = UPDATE_TOKENS_RE.exec(statement);
    if (!m) return false;
    const where = whereOf(m[1] ?? "");
    return where !== null && USER_PREDICATE_RE.test(where) && !ONE_KEY_PREDICATE_RE.test(where);
  });
}

/** Whether `text` holds a statement that ends sessions: an UPDATE of any scope, or a DELETE of a user's. */
export function endsSessions(text: string): boolean {
  return text.split(";").some((statement) => {
    if (UPDATE_SESSIONS_RE.test(statement)) return true;
    const m = DELETE_SESSIONS_RE.exec(statement);
    if (!m) return false;
    const where = whereOf(m[1] ?? "");
    return where !== null && USER_PREDICATE_RE.test(where);
  });
}

type FnNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

const isFn = (n: ts.Node): n is FnNode =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n) ||
  ts.isConstructorDeclaration(n);

/** The last path segment without extension, so `./compute-release`, `../services/compute-release.js` match alike. */
const moduleBase = (spec: string): string =>
  (spec.split("/").pop() ?? spec).replace(/\.(js|ts)$/, "");

interface Unit {
  /** `file#label`. */
  key: string;
  file: string;
  /** The label alone; a plain function name when it has one. */
  label: string;
  /** Folded strings in the unit outside nested functions. */
  strings: string[];
  /** Identifier names in the unit outside nested functions (declaration names included). */
  names: Set<string>;
  /** `ns.prop` and `ns["prop"]` property names, by namespace local name. */
  nsProps: Map<string, Set<string>>;
}

interface FileFacts {
  file: string;
  sf: ts.SourceFile;
  units: Unit[];
  /** local name to the name it was exported as and the module it came from, for every named import. */
  imports: Map<string, { original: string; file: string | null }>;
  /** local names of namespace imports, with the module's base name. */
  namespaces: Map<string, string>;
  /** local names of namespace imports, with the file the module resolves to (null when it does not). */
  nsFiles: Map<string, string | null>;
  /** names declared at the module's top level (functions, constants, classes). */
  declared: Set<string>;
  /** local names that are the compute set function in this file (imported, aliased, assigned). */
  computeLocals: Set<string>;
  unfollowable: string[];
}

function labelOf(node: FnNode, sf: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name.getText(sf);
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  if (parent && ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
    const path = parent.arguments.find((a) => ts.isStringLiteralLike(a));
    if (path && ts.isStringLiteralLike(path)) {
      const callee = parent.expression;
      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text.toUpperCase()
        : "CALL";
      return `${method} ${path.text}`;
    }
  }
  return `<anonymous@${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}>`;
}

function collectFacts(tree: Tree, file: string, sf: ts.SourceFile, target: ScanTarget): FileFacts {
  const imports = new Map<string, { original: string; file: string | null }>();
  const namespaces = new Map<string, string>();
  const nsFiles = new Map<string, string | null>();
  const declared = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) declared.add(stmt.name.text);
    if (ts.isClassDeclaration(stmt) && stmt.name) declared.add(stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) declared.add(d.name.text);
      }
    }
  }
  const unfollowable: string[] = [];
  const computeLocals = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const base = moduleBase(stmt.moduleSpecifier.text);
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const original = (el.propertyName ?? el.name).text;
          imports.set(el.name.text, {
            original,
            file: resolveImport(tree, file, (stmt.moduleSpecifier as ts.StringLiteral).text),
          });
          if (base === target.module && original === target.fn) {
            computeLocals.add(el.name.text);
          }
        }
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.set(clause.namedBindings.name.text, base);
        nsFiles.set(
          clause.namedBindings.name.text,
          resolveImport(tree, file, (stmt.moduleSpecifier as ts.StringLiteral).text),
        );
      }
    }
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      moduleBase(stmt.moduleSpecifier.text) === target.module
    ) {
      unfollowable.push(`${rel(file)}: re-exports ${target.module}`);
    }
  }

  // Dynamic imports of the target module, anywhere.
  const dynamic = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      moduleBase(n.arguments[0].text) === target.module
    ) {
      unfollowable.push(`${rel(file)}: dynamically imports ${target.module}`);
    }
    ts.forEachChild(n, dynamic);
  };
  dynamic(sf);

  const isComputeProp = (n: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(n)) {
      return (
        ts.isIdentifier(n.expression) &&
        namespaces.get(n.expression.text) === target.module &&
        n.name.text === target.fn
      );
    }
    if (ts.isElementAccessExpression(n)) {
      return (
        ts.isIdentifier(n.expression) &&
        namespaces.get(n.expression.text) === target.module &&
        ts.isStringLiteralLike(n.argumentExpression) &&
        n.argumentExpression.text === target.fn
      );
    }
    return false;
  };

  // Local aliases, to a fixed point: `const f = computeReleaseStatements`, `const f = ns.computeReleaseStatements`,
  // `const { computeReleaseStatements: f } = ns`.
  for (let changed = true; changed; ) {
    changed = false;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = n.initializer;
        const fromSet =
          (ts.isIdentifier(init) && computeLocals.has(init.text)) || isComputeProp(init);
        if (fromSet && ts.isIdentifier(n.name) && !computeLocals.has(n.name.text)) {
          computeLocals.add(n.name.text);
          changed = true;
        }
        if (
          ts.isObjectBindingPattern(n.name) &&
          ts.isIdentifier(init) &&
          namespaces.get(init.text) === target.module
        ) {
          for (const el of n.name.elements) {
            const prop = (el.propertyName ?? el.name).getText(sf);
            if (
              prop === target.fn &&
              ts.isIdentifier(el.name) &&
              !computeLocals.has(el.name.text)
            ) {
              computeLocals.add(el.name.text);
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // Units.
  const units: Unit[] = [];
  const seen = new Map<string, number>();
  const newUnit = (label: string): Unit => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    const unique = count === 1 ? label : `${label}@${count}`;
    const unit: Unit = {
      key: `${rel(file)}#${unique}`,
      file,
      label: unique,
      strings: [],
      names: new Set(),
      nsProps: new Map(),
    };
    units.push(unit);
    return unit;
  };
  const addNs = (unit: Unit, ns: string, prop: string) => {
    const set = unit.nsProps.get(ns) ?? new Set<string>();
    set.add(prop);
    unit.nsProps.set(ns, set);
  };
  const gather = (n: ts.Node, unit: Unit): void => {
    if (isFn(n)) {
      // A function is its own unit, and its facts are not its parent's.
      const inner = newUnit(labelOf(n, sf));
      ts.forEachChild(n, (c) => gather(c, inner));
      return;
    }
    const folded = foldString(n);
    if (folded !== null && !ts.isParenthesizedExpression(n)) {
      unit.strings.push(folded);
      if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) gather(s.expression, unit);
      return;
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      addNs(unit, n.expression.text, n.name.text);
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      ts.isStringLiteralLike(n.argumentExpression)
    ) {
      addNs(unit, n.expression.text, n.argumentExpression.text);
    }
    if (ts.isIdentifier(n)) unit.names.add(n.text);
    ts.forEachChild(n, (c) => gather(c, unit));
  };
  const top = newUnit("<module>");
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) continue;
    gather(stmt, top);
  }
  return { file, sf, units, imports, namespaces, nsFiles, declared, computeLocals, unfollowable };
}

export interface Analysis {
  /** Every unit that references the compute set function, by key. */
  users: string[];
  /** Every unit that ends every credential, by key. */
  ends: string[];
  /** Units that end every credential and neither run the compute set nor delegate to a unit that does. */
  unsatisfied: string[];
  /** What the scan cannot follow. */
  unfollowable: string[];
}

export function analyse(tree: Tree, target: ScanTarget = COMPUTE_TARGET): Analysis {
  const facts = tree
    .walk(SRC)
    .filter((f) => !f.endsWith(`services/${target.module}.ts`))
    .map((f) => collectFacts(tree, f, parse(tree, f), target));
  const unfollowable = facts.flatMap((f) => f.unfollowable);

  // The compute set's users.
  const users = new Set<string>();
  for (const f of facts) {
    for (const u of f.units) {
      const direct =
        [...u.names].some((n) => f.computeLocals.has(n)) ||
        [...u.nsProps].some(
          ([ns, props]) => f.namespaces.get(ns) === target.module && props.has(target.fn),
        );
      if (!direct) continue;
      if (u.label === "<module>") {
        unfollowable.push(`${u.key}: references the compute set at module level`);
      }
      users.add(u.key);
    }
  }

  // What a unit REFERENCES, as `module#name` keys, resolved through the file's own imports (named,
  // aliased, namespace) and top-level declarations. A name that is neither a parameter, a local nor a
  // property resolves to nothing: a common helper name in another module cannot be mistaken for it.
  const refsOf = (f: FileFacts, u: Unit): Set<string> => {
    const out = new Set<string>();
    for (const n of u.names) {
      const imp = f.imports.get(n);
      if (imp) {
        if (imp.file) out.add(`${rel(imp.file)}#${imp.original}`);
      } else if (f.declared.has(n)) out.add(`${rel(f.file)}#${n}`);
    }
    for (const [ns, props] of u.nsProps) {
      const nsFile = f.nsFiles.get(ns);
      if (nsFile) for (const p of props) out.add(`${rel(nsFile)}#${p}`);
    }
    return out;
  };

  // Revokers, by VALUE: module-level constants whose text revokes, and functions whose unit revokes,
  // resolved to a fixed point.
  const tokenRevokers = new Set<string>();
  const sessionRevokers = new Set<string>();
  const resolve = (f: FileFacts, u: Unit): { tokens: boolean; sessions: boolean } => {
    const refs = refsOf(f, u);
    return {
      tokens: u.strings.some(revokesAllKeys) || [...refs].some((r) => tokenRevokers.has(r)),
      sessions: u.strings.some(endsSessions) || [...refs].some((r) => sessionRevokers.has(r)),
    };
  };
  // Module-level constants: `const NAME = "<sql>"`.
  for (const f of facts) {
    for (const stmt of f.sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const text = foldString(d.initializer);
        if (text === null) continue;
        const key = `${rel(f.file)}#${d.name.text}`;
        if (revokesAllKeys(text)) tokenRevokers.add(key);
        if (endsSessions(text)) sessionRevokers.add(key);
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of facts) {
      for (const u of f.units) {
        if (u.label === "<module>" || u.label.startsWith("<anonymous") || /\s/.test(u.label))
          continue;
        const { tokens, sessions } = resolve(f, u);
        if (tokens && !tokenRevokers.has(u.key)) {
          tokenRevokers.add(u.key);
          changed = true;
        }
        if (sessions && !sessionRevokers.has(u.key)) {
          sessionRevokers.add(u.key);
          changed = true;
        }
      }
    }
  }

  // Units that end every credential: they revoke every key AND sessions, themselves.
  const ends: string[] = [];
  const endsFacts: Array<{ f: FileFacts; u: Unit }> = [];
  for (const f of facts) {
    for (const u of f.units) {
      if (u.label === "<module>") continue;
      const { tokens, sessions } = resolve(f, u);
      if (tokens && sessions) {
        ends.push(u.key);
        endsFacts.push({ f, u });
      }
    }
  }

  // A unit is satisfied when it runs the compute set, or references a function that is satisfied (a route
  // that calls `finalizeRevocation`, the sweep that calls `tombstoneUserCascade`, the cleanup that calls
  // the sweep): to a fixed point, so a chain of delegation of any depth is followed.
  const plain = (label: string) => !/\s|^</.test(label);
  const satisfiedKeys = new Set([...users].filter((k) => plain(k.slice(k.indexOf("#") + 1))));
  const satisfied = new Set<string>(users);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { f, u } of endsFacts) {
      if (satisfied.has(u.key)) continue;
      if ([...refsOf(f, u)].some((r) => satisfiedKeys.has(r))) {
        satisfied.add(u.key);
        if (plain(u.label)) satisfiedKeys.add(u.key);
        changed = true;
      }
    }
  }
  const unsatisfied = endsFacts.filter(({ u }) => !satisfied.has(u.key)).map(({ u }) => u.key);

  return {
    users: [...users].sort(),
    ends: ends.sort(),
    unsatisfied: unsatisfied.sort(),
    unfollowable: unfollowable.sort(),
  };
}
