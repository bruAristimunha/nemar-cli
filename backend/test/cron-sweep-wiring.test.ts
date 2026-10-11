/**
 * Cron wiring pin for the sweep services (#1164).
 *
 * A sweep service is only half a feature. The other half is the recurring
 * driver that drains it, and nothing in this repo asserted the two were ever
 * connected. Epic #1144 Phase 2b shipped `runSignalDefaultsSweep` with a
 * service, an admin endpoint and its own tests, and never added it to
 * `scheduled()`. Its Phase 2 sibling `runRecordingStatsSweep` WAS wired, so the
 * omission looked like nothing: the sweep's `signal_defaults_at` stamp simply
 * never advanced outside a manual admin call, so the batch never converged.
 *
 * WHAT THIS TEST DOES AND DOES NOT PROVE. It reads the production source and
 * checks that each sweep has a call site in the region it is declared to belong
 * to. It does NOT prove the sweep runs. Three regressions pass every assertion
 * here and were each demonstrated against this file during review:
 *   - `prodOnlyJobs` being computed with the wrong polarity, which would run the
 *     prod-only jobs ONLY outside production (partly covered now, see the
 *     polarity test below, but only for this one spelling)
 *   - the `AUTO_IMPORT_CRON` branch above returning unconditionally, so no daily
 *     job runs at all
 *   - a throw in an earlier statement aborting `scheduled()` before the call
 * Closing those needs a behavioural test that invokes `scheduled()` itself, or
 * an internal `isNonProductionEnv` guard in each sweep of the kind
 * `archive-retry.ts`, `manifest-sweep.ts`, `doi-reconcile.ts` and
 * `import-retry.ts` already carry and `cron-dev-safety.test.ts` probes at
 * runtime.
 *
 * The three sweeps with admin backfill endpoints (`runAvailabilityReportSweep`,
 * `runRecordingStatsSweep`, `runSignalDefaultsSweep`) deliberately do NOT
 * self-guard, because the same exported function serves the admin route that
 * staging needs for manual backfill (issue #1166, Option 2). Instead each has
 * a same-module `<name>Cron` wrapper that carries the `isNonProductionEnv`
 * guard, and it is the WRAPPER that `scheduled()` calls -- see
 * `runAvailabilityReportSweepCron` and friends. The "cron-wrapped" kind below
 * enforces the asymmetry from this side (the raw sweep must never be called
 * directly from `scheduled()`, and its wrapper must be the one wired
 * prod-only); `cron-dev-safety.test.ts`-style tests enforce it from the
 * runtime side (the wrapper never reaches D1 outside production, the raw
 * sweep still does).
 *
 * An earlier version of this file claimed to match the
 * `admin-route-inventory` / `api-export-surface` convention. It does not, and
 * the claim is removed rather than repaired: both of those import the real
 * module and assert on live runtime objects (`adminRoutes.routes`,
 * `Object.keys(m)`), which is strictly stronger than reading text. There is no
 * runtime object to introspect for "which functions does this handler call"
 * without invoking the handler, which is why this is textual, but borrowing
 * their credibility for a weaker technique was wrong.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SERVICES_DIR = join(import.meta.dir, "../src/services");
const INDEX_PATH = join(import.meta.dir, "../src/index.ts");

/**
 * Where each sweep-shaped export is expected to be driven from. A new sweep
 * with no entry fails the declaration test below, which is the #1164 class:
 * the point is that adding a service without deciding how it recurs is the
 * error, not merely forgetting one particular call.
 *
 *  - `prod-only`    driven from the `if (prodOnlyJobs)` block in `scheduled()`
 *  - `all-envs`     driven unconditionally (scoped internally instead; see
 *                   `sweepBlockedBidsValidationRequests`, which narrows to the
 *                   dev id range rather than skipping, per cron-dev-safety)
 *  - `cron-wrapped` NOT called directly from `scheduled()` at all (issue
 *                   #1166, Option 2): the exported sweep stays unguarded so
 *                   the admin backfill route can still call it on staging,
 *                   and a same-module `<name>Cron` wrapper -- itself declared
 *                   `prod-only` above -- carries the guard and is what
 *                   `scheduled()` actually calls.
 *  - `helper`       not a sweep at all: a SQL/query builder, or an output
 *                   formatter for a sweep's result, that happens to carry the
 *                   word in its name
 *  - `tick-prod-only` driven from the 30-minute `AUTO_IMPORT_CRON` branch of
 *                   `scheduled()` (which returns before the daily block), inside
 *                   that branch's own `if (!isNonProductionEnv(env)) {` guard: a
 *                   production-only job whose cadence the daily tick cannot meet
 */
const SWEEP_WIRING: Record<
  string,
  "prod-only" | "all-envs" | "cron-wrapped" | "helper" | "tick-prod-only"
> = {
  archiveRetrySweep: "prod-only",
  manifestIntegritySweep: "prod-only",
  sweepImportRetries: "prod-only",
  runAvailabilityReportSweep: "cron-wrapped",
  runAvailabilityReportSweepCron: "prod-only",
  runRecordingStatsSweep: "cron-wrapped",
  runRecordingStatsSweepCron: "prod-only",
  runSignalDefaultsSweep: "cron-wrapped",
  runSignalDefaultsSweepCron: "prod-only",
  runZarrFidelitySweep: "all-envs",
  // #1409: mints a GitHub App token against the shared nemarDatasets org
  // to read PRIVATE dataset repositories, and emails a real depositor when
  // it finds something. Either disqualifies it from the dev tick.
  runAnonymitySweep: "cron-wrapped",
  runAnonymitySweepCron: "prod-only",
  runImportIssueSweep: "cron-wrapped",
  runImportIssueSweepCron: "prod-only",
  runImportCoverageSweep: "cron-wrapped",
  runImportCoverageSweepCron: "prod-only",
  runWeeklyImportSummaryCron: "prod-only",
  // Epic #1586 phase 4 (ADR 0084): the Neurobagel artifact reconcile reads dataset
  // repositories through the shared nemarDatasets org and writes the store, so it is
  // production-only by default and absent from DEV_CRON_ALLOWLIST.
  runNeurobagelReconcileCron: "prod-only",
  // Epic #1586 phase 6 (ADR 0067's amendment): the verification sweep reads the store, a node
  // and the public federation and writes only its heartbeat. Production-only by default and
  // absent from DEV_CRON_ALLOWLIST; the raw sweep stays unguarded for the admin route.
  runNeurobagelVerificationSweep: "cron-wrapped",
  runNeurobagelVerificationSweepCron: "prod-only",
  // ADR 0092: the pull-request review watchdog. Its deadline is 30 minutes, so it rides
  // the 30-minute tick; it writes check-runs and comments to the shared nemarDatasets org,
  // so it is production-only there and absent from DEV_CRON_ALLOWLIST. It also refuses
  // outside production on its own. It deliberately ignores PR_REVIEW_ENABLED, so switching the
  // review off does not strand the checks of reviews already in flight.
  sweepStalePrReviews: "tick-prod-only",
  sweepBlockedBidsValidationRequests: "all-envs",
  // Epic #1610 phase 4: the identifier-screen watchdog. Its deadline is 50
  // minutes, so it rides the 30-minute tick; it mails admins, so it is
  // production-only there and absent from DEV_CRON_ALLOWLIST.
  sweepIdentifierScreens: "tick-prod-only",
  // Epic #1610 phase 5 (ADR 0088): the scheduled identifier sweep and its weekly
  // report. Both ride the 30-minute tick: the sweep's deadline is the screen's 50
  // minutes, and the report retries on a later tick when a send reached nobody. The
  // sweep dispatches against the shared nemarDatasets org and the report mails
  // admins, so both are production-only there and absent from DEV_CRON_ALLOWLIST;
  // each also refuses outside production on its own.
  runIdentifierSweepTick: "tick-prod-only",
  sendIdentifierSweepWeeklyReport: "tick-prod-only",
  // The sweep callback's store, called by POST /webhooks/identifier-sweep-result;
  // not a cron entry point.
  storeSweepResult: "helper",
  // The sweep's mail body sender and its callback token's pair; called by the weekly
  // report, the tick and the callback route, never cron entry points themselves.
  sendIdentifierSweepReportEmail: "helper",
  signIdentifierSweepCallbackToken: "helper",
  verifyIdentifierSweepCallbackToken: "helper",
  // #1440: the non-production scope clause for sweepBlockedBidsValidationRequests,
  // exported so the test imports the REAL clause rather than retyping it. Pure,
  // driven only by the sweep above, and never a cron entry point of its own.
  blockedSweepScope: "helper",
  // #1514: a pure decision function (S3 size + row totals -> ready/skip/
  // absent) that the admin archive-sweep ROUTE calls; not a cron entry point
  // of its own, same shape as blockedSweepScope.
  decideArchiveSweepOutcome: "helper",
  importIssueSweepLogLines: "helper",
  importCoverageSweepSummary: "helper",
  availabilityReportSweepWhere: "helper",
  availabilityReportSweepCandidateQuery: "helper",
  availabilityReportSweepRemainingQuery: "helper",
};

/**
 * Every sweep-shaped export in `src/services`. Matches on the word "sweep"
 * anywhere in the name rather than a `run<X>Sweep` prefix: the first version of
 * this test used the narrow pattern and silently missed `archiveRetrySweep`,
 * `sweepImportRetries`, `manifestIntegritySweep` and
 * `sweepBlockedBidsValidationRequests` -- four wired, production-critical
 * sweeps, one of which exists to prevent recurrence of the nm000225 incident.
 * Deleting any of their call sites left the suite green.
 */
/**
 * Every service file, RECURSIVELY.
 *
 * The scan used to be one `readdirSync` of `services/`, so
 * `backend/src/services/github/*.ts` -- a directory this epic edits -- was invisible
 * to both the discovery above and the wiring check below. A `*Cron` export placed in
 * a subdirectory left the whole suite green.
 */
function serviceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".ts")) out.push(join(dir, e.name));
    }
  };
  walk(SERVICES_DIR);
  return out;
}

function discoverSweepExports(): string[] {
  const names = new Set<string>();
  const patterns = [
    /^export\s+(?:async\s+)?function\s+(\w*[Ss]weep\w*)\s*\(/gm,
    /^export\s+const\s+(\w*[Ss]weep\w*)\s*=/gm,
    // ...and anything named *Cron, which by construction IS a cron entry point.
    // Added for #1312, whose job is a weekly REPORT rather than a sweep and so
    // carries no "sweep" in any of its names -- exactly the #1164 shape this test
    // exists to catch, arriving from a different direction. Deliberately narrower
    // than matching "Summary", which would pull in buildApiKeySummary,
    // integrityAuditSummary, probeSummary and loadSummary: four unrelated exports
    // to declare as helpers, which is the dilution that makes a trip-wire stop
    // being read.
    /^export\s+(?:async\s+)?function\s+(\w*Cron)\s*\(/gm,
    // The `export const` counterpart, which the two sweep patterns have and this one
    // did not: `export const newThingCron = async (env) => ...` was invisible, so the
    // trip-wire could be walked past by choosing an arrow function.
    /^export\s+const\s+(\w*Cron)\s*=/gm,
  ];
  for (const file of serviceFiles()) {
    const src = readFileSync(file, "utf-8");
    for (const re of patterns) {
      for (const m of src.matchAll(re)) names.add(m[1]);
    }
  }
  return [...names].sort();
}

/**
 * Drop whole comment lines. Deliberately line-based, matching
 * `cron-dev-safety.test.ts`'s `line.startsWith("//")` filter rather than a
 * regex over the whole text: an earlier version stripped from the first `//`
 * to end of line, which ate the real call when a `https://` URL appeared
 * earlier on the same line and failed a correctly-wired sweep. A trailing
 * comment on a line that also holds code is left intact, which is the
 * accepted residual: it can only cause a false PASS if someone writes a call
 * site verbatim in a trailing comment, which is far less likely than a URL.
 */
function codeLines(lines: string[]): string[] {
  return lines.filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

/**
 * The `if (prodOnlyJobs) { ... }` body, delimited by INDENTATION rather than by
 * brace counting. The first version counted braces over raw text; a single
 * regex literal containing `{` elsewhere in the guard silently swallowed the
 * rest of `scheduled()` into the "guarded" region, and stacking that with a
 * genuine "call moved out of the guard" regression turned three caught
 * failures into a clean pass. Biome enforces the formatting this relies on.
 */
function prodOnlyBlockLines(lines: string[]): string[] {
  const start = lines.findIndex((l) => l.trim() === "if (prodOnlyJobs) {");
  if (start === -1) throw new Error("prod-only cron block not found in index.ts");
  const indent = " ".repeat(lines[start].length - lines[start].trimStart().length);
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  if (end === -1) throw new Error("prod-only cron block has no closing brace at its indent");
  return lines.slice(start + 1, end);
}

/**
 * The lines of the block that opens with `opener` (trimmed), delimited by
 * indentation the same way {@link prodOnlyBlockLines} is, searching from
 * `from`. Returns the body lines and the index of the opener.
 */
function blockAfter(lines: string[], opener: string, from = 0): { body: string[]; start: number } {
  const start = lines.findIndex((l, i) => i >= from && l.trim() === opener);
  if (start === -1) throw new Error(`block "${opener}" not found in index.ts`);
  const indent = " ".repeat(lines[start].length - lines[start].trimStart().length);
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  if (end === -1) throw new Error(`block "${opener}" has no closing brace at its indent`);
  return { body: lines.slice(start + 1, end), start };
}

/**
 * The production-only guard INSIDE the 30-minute tick's branch. The branch
 * returns before `prodOnlyJobs` is computed, so a production-only job on this
 * tick needs a guard of its own, and this is the region that guard encloses.
 */
function tickProdOnlyBlockLines(lines: string[]): string[] {
  const branch = blockAfter(lines, "if (event.cron === AUTO_IMPORT_CRON) {");
  return blockAfter(branch.body, "if (!isNonProductionEnv(env)) {").body;
}

const indexLines = readFileSync(INDEX_PATH, "utf-8").split("\n");
const allCode = codeLines(indexLines).join("\n");
const prodOnlyCode = codeLines(prodOnlyBlockLines(indexLines)).join("\n");
const tickProdOnlyCode = codeLines(tickProdOnlyBlockLines(indexLines)).join("\n");

/** A call that is actually scheduled: `ctx.waitUntil(` wrapping it, possibly
 *  across a line break. An async call in `scheduled()` that is NOT handed to
 *  `ctx.waitUntil` can be cancelled when the handler returns, so a bare
 *  statement is not a wired sweep even though the name is present. */
function isScheduled(code: string, name: string): boolean {
  return new RegExp(`ctx\\.waitUntil\\(\\s*${name}\\(env[),]`).test(code);
}

/**
 * Calls of the form `name(env)` or `name(env, ...)`. The trailing delimiter is
 * matched rather than a bare `(env)` so a sweep that takes options -- as
 * `runImportIssueSweep(env, { apply: true })` does -- still counts. `env` must
 * still be the first argument, so this is no weaker: it cannot match a
 * same-named call on some other value.
 */
function callCount(code: string, name: string): number {
  return [...code.matchAll(new RegExp(`\\b${name}\\(env[),]`, "g"))].length;
}

/**
 * The non-comment source lines of whichever `src/services/*.ts` file
 * declares `export function <exportName>(` or `export const <exportName> =`,
 * or null if none does. Used to check that a `<name>Cron` wrapper's own
 * defining file actually calls the raw sweep it is supposed to wrap --
 * declaring the wrapper `prod-only` above proves nothing about whether it
 * delegates to anything.
 */
function serviceFileCodeLinesDefining(exportName: string): string[] | null {
  const patterns = [
    new RegExp(`^export\\s+(?:async\\s+)?function\\s+${exportName}\\s*\\(`),
    new RegExp(`^export\\s+const\\s+${exportName}\\s*=`),
  ];
  for (const file of serviceFiles()) {
    const lines = readFileSync(file, "utf-8").split("\n");
    if (lines.some((l) => patterns.some((re) => re.test(l.trim())))) {
      return codeLines(lines);
    }
  }
  return null;
}

describe("every sweep service is declared and driven", () => {
  const sweeps = discoverSweepExports();

  test("discovery finds every sweep-shaped export, so nothing passes vacuously", () => {
    // A trip-wire, not a buffer: if the patterns stop matching, "every sweep is
    // wired" becomes trivially true over an empty list.
    expect(sweeps).toEqual(Object.keys(SWEEP_WIRING).sort());
  });

  for (const name of discoverSweepExports()) {
    test(`${name} declares where it is driven from`, () => {
      expect(SWEEP_WIRING[name]).toBeDefined();
    });
  }

  for (const [name, kind] of Object.entries(SWEEP_WIRING)) {
    if (kind === "helper" || kind === "cron-wrapped") continue;

    test(`${name} is actually called in scheduled()`, () => {
      expect(callCount(allCode, name)).toBeGreaterThanOrEqual(1);
    });

    if (kind === "tick-prod-only") {
      test(`${name} is wrapped in ctx.waitUntil inside the 30-minute tick's production guard`, () => {
        expect(isScheduled(tickProdOnlyCode, name)).toBe(true);
      });

      test(`${name} is called ONLY inside the 30-minute tick's production guard`, () => {
        // Anywhere else it would either run on the dev worker's tick or, in the
        // daily block, miss the deadline it exists to meet.
        expect(callCount(allCode, name)).toBe(callCount(tickProdOnlyCode, name));
      });

      test(`${name} is NOT in DEV_CRON_ALLOWLIST`, () => {
        const allowlist = /DEV_CRON_ALLOWLIST[^;]*;/s.exec(allCode)?.[0] ?? "";
        expect(allowlist).not.toContain(name);
      });
    }

    if (kind === "prod-only") {
      test(`${name} is wrapped in ctx.waitUntil inside the prod-only block`, () => {
        expect(isScheduled(prodOnlyCode, name)).toBe(true);
      });

      test(`${name} is called ONLY inside the prod-only block`, () => {
        // MOST of these reach the shared, hardcoded `nemarDatasets` org
        // (ORG_NAME in services/github/shared.ts is not environment-scoped) or
        // the prod EZID shoulder, so a call site outside the guard would run
        // them from the dev worker against that same shared org. The D1 and S3
        // halves are NOT the risk anywhere: S3_BUCKET is env-scoped to
        // nemar-dev, and per AGENTS.md the dev catalog was purged to fixtures
        // and is no longer a production mirror.
        //
        // `runRecordingStatsSweepCron` is the exception and this assertion is
        // weaker for it: that sweep touches ONLY S3 and D1 (index.ts says so
        // where it is wired), so it has no shared-org exposure to fence. It is
        // held to the same rule for consistency and because the prod-only
        // default in AGENTS.md applies regardless, not because an escape would
        // be dangerous. Do not read this comment as evidence that it would.
        // #1167 review, finding 3.
        expect(callCount(allCode, name)).toBe(callCount(prodOnlyCode, name));
      });
    }
  }

  for (const [name, kind] of Object.entries(SWEEP_WIRING)) {
    if (kind !== "cron-wrapped") continue;
    const cronName = `${name}Cron`;

    test(`${name} is never called directly in scheduled() (bypasses its wrapper's guard)`, () => {
      // The raw sweep has no internal isNonProductionEnv guard, by design --
      // the admin backfill route needs it callable on staging (issue #1166,
      // Option 2). A direct call here would run it from the dev/staging
      // worker unguarded, defeating the entire reason the wrapper exists.
      expect(callCount(allCode, name)).toBe(0);
    });

    test(`${name} declares a cron wrapper that is itself wired prod-only`, () => {
      expect(SWEEP_WIRING[cronName]).toBe("prod-only");
    });

    test(`${cronName} actually delegates to ${name}`, () => {
      // Declaring the wrapper prod-only proves it is CALLED from the right
      // place; it proves nothing about whether it calls the sweep it is
      // named after. A wrapper that only logs and returns would pass every
      // other assertion in this file.
      const code = serviceFileCodeLinesDefining(cronName)?.join("\n") ?? null;
      expect(code).not.toBeNull();
      // `callCount` rather than a literal `name(env)` substring, so a wrapper
      // that passes options through -- the cron's `apply` flag, say -- still
      // counts as delegating.
      expect(callCount(code ?? "", name)).toBeGreaterThanOrEqual(1);
    });
  }
});

describe("the prod-only gate keeps its polarity", () => {
  test("the 30-minute tick's production guard is the negation of isNonProductionEnv", () => {
    // `tickProdOnlyBlockLines` finds the guard by this exact text, so an
    // inverted guard (`if (isNonProductionEnv(env))`) is not found at all and
    // fails the whole file loudly; this states the expectation by name.
    const branch = blockAfter(indexLines, "if (event.cron === AUTO_IMPORT_CRON) {");
    expect(branch.body.map((l) => l.trim())).toContain("if (!isNonProductionEnv(env)) {");
  });

  test("prodOnlyJobs is the negation of isNonProductionEnv", () => {
    // Inverting this runs every prod-only job ONLY outside production, which
    // no call-site assertion can see. `isNonProductionEnv` is itself an
    // allow-list that fails closed, so the negation is what makes an unset or
    // typo'd ENVIRONMENT behave as production.
    expect(allCode).toContain("const prodOnlyJobs = !isNonProductionEnv(env);");
  });
});

/**
 * `publishZarrCatalog` (#1062, epic #1181 phase 2; PR #1201 review, item 6)
 * is not sweep-shaped -- its name carries no "sweep" substring, so it falls
 * outside `discoverSweepExports()`'s pattern and outside `SWEEP_WIRING`'s
 * declared-vs-discovered symmetry check above by design (that machinery is
 * documented, in this file's own header, as sweep-specific -- forcing an
 * unrelated export through it would make the "every sweep is wired"
 * trip-wire test spuriously fail for a change to `discoverSweepExports()`'s
 * regex having nothing to do with sweeps). It gets its own targeted
 * assertions instead, over the same `allCode`/`prodOnlyCode`/`isScheduled`/
 * `callCount` machinery every sweep above is checked with.
 */
describe("publishZarrCatalog is wired into the daily cron (outside the sweep framework)", () => {
  const NAME = "publishZarrCatalog";

  test("is declared in the DEV_CRON_ALLOWLIST named constant in index.ts", () => {
    // The constant is the greppable, human-visible form of the dev-cron
    // decision (PR #1201 review, item 6); this pins that the decision was
    // actually recorded, not just made in someone's head.
    expect(allCode).toContain("DEV_CRON_ALLOWLIST");
    expect(allCode).toContain(`"${NAME}"`);
  });

  test("is called at least once in scheduled()", () => {
    expect(callCount(allCode, NAME)).toBeGreaterThanOrEqual(1);
  });

  test("is wrapped in ctx.waitUntil", () => {
    expect(isScheduled(allCode, NAME)).toBe(true);
  });

  test("is called OUTSIDE the prod-only block -- it also runs on the dev cron", () => {
    expect(callCount(prodOnlyCode, NAME)).toBe(0);
    expect(callCount(allCode, NAME)).toBeGreaterThan(callCount(prodOnlyCode, NAME));
  });

  test("its ctx.waitUntil chain includes a .catch (a rejection must never crash scheduled())", () => {
    const idx = allCode.indexOf(`${NAME}(env)`);
    expect(idx).toBeGreaterThanOrEqual(0);
    // A generous window: the real call chains `.then(...).catch(...)` across
    // several lines, but this is not meant to prove exact adjacency, only
    // that a .catch exists for THIS call and not some unrelated one --
    // `NAME` appears nowhere else in index.ts (the declaration test above
    // already pins that as a side effect of checking the allowlist quote).
    const window = allCode.slice(idx, idx + 400);
    expect(window).toContain(".catch(");
  });
});

/**
 * `runZarrFidelitySweep` (issue #1068, epic #1181 phase 8) mirrors
 * `publishZarrCatalog`'s dev-safe shape immediately above -- it is
 * sweep-shaped (so `discoverSweepExports()` finds it and `SWEEP_WIRING`
 * declares it "all-envs" above), but it ALSO belongs in `DEV_CRON_ALLOWLIST`
 * (it runs unconditionally, not narrowed internally like
 * `sweepBlockedBidsValidationRequests`), so it gets the same dedicated,
 * stronger checks `publishZarrCatalog` gets rather than only the generic
 * "all-envs" callCount>=1 check above.
 */
describe("runZarrFidelitySweep is wired into the daily cron (outside the sweep framework)", () => {
  const NAME = "runZarrFidelitySweep";

  test("is declared in the DEV_CRON_ALLOWLIST named constant in index.ts", () => {
    expect(allCode).toContain("DEV_CRON_ALLOWLIST");
    expect(allCode).toContain(`"${NAME}"`);
  });

  test("is called at least once in scheduled()", () => {
    expect(callCount(allCode, NAME)).toBeGreaterThanOrEqual(1);
  });

  test("is wrapped in ctx.waitUntil", () => {
    expect(isScheduled(allCode, NAME)).toBe(true);
  });

  test("is called OUTSIDE the prod-only block -- it also runs on the dev cron", () => {
    expect(callCount(prodOnlyCode, NAME)).toBe(0);
    expect(callCount(allCode, NAME)).toBeGreaterThan(callCount(prodOnlyCode, NAME));
  });

  test("its ctx.waitUntil chain includes a .catch (a rejection must never crash scheduled())", () => {
    const idx = allCode.indexOf(`${NAME}(env)`);
    expect(idx).toBeGreaterThanOrEqual(0);
    // A wider window than publishZarrCatalog's: this call's `.then()` builds
    // a summary line with the failed-dataset ids, so there is
    // more code between the call and its `.catch(`.
    const window = allCode.slice(idx, idx + 2000);
    expect(window).toContain(".catch(");
  });
});

describe("the weekly summary's UNGUARDED entry point is never called from scheduled()", () => {
  /**
   * `runWeeklyImportSummary` has the same shape as every raw sweep -- unguarded, with
   * the `isNonProductionEnv` fence living in its `*Cron` wrapper -- but its name is
   * neither sweep-shaped nor `*Cron`-suffixed, so `SWEEP_WIRING`'s symmetry check
   * cannot declare it and the "cron-wrapped" assertion never reaches it.
   *
   * Review proved the consequence: adding `ctx.waitUntil(runWeeklyImportSummary(env,
   * { apply: true }))` OUTSIDE the prod-only guard left all 2832 tests green. That is
   * a change which would make the dev worker file and close real issues on the shared
   * nemarDatasets org every day, invisible to the entire suite.
   *
   * Declaring it in SWEEP_WIRING would break the discovery trip-wire, so this uses the
   * same standalone form as the publishZarrCatalog and runZarrFidelitySweep blocks
   * above.
   */
  test("only the guarded wrapper is called", () => {
    // callCount matches `name(` exactly, so the wrapper's own calls do not count
    // toward the raw name -- verified by the second assertion below being non-zero
    // while this one is zero.
    expect(callCount(allCode, "runWeeklyImportSummary")).toBe(0);
    expect(callCount(allCode, "runWeeklyImportSummaryCron")).toBeGreaterThanOrEqual(1);
  });

  test("the wrapper is inside the prod-only block, not merely in the file", () => {
    // It files and closes real issues on an org dev shares with production, so it
    // must never ride the non-prod daily tick.
    expect(callCount(prodOnlyCode, "runWeeklyImportSummaryCron")).toBeGreaterThanOrEqual(1);
  });

  test("it is NOT in DEV_CRON_ALLOWLIST", () => {
    const allowlist = /DEV_CRON_ALLOWLIST[^;]*;/s.exec(allCode)?.[0] ?? "";
    expect(allowlist).not.toContain("WeeklyImportSummary");
  });

  /**
   * The day guard is the ONLY thing making this weekly rather than daily -- the
   * service's own gate is week-based and would happily allow Tue-Sun -- and nothing
   * pinned it at the call site. Rewriting `if (shouldRunWeeklySummary(new Date()))`
   * to `if (true)` left the whole suite green, which would file a report every day
   * until the gate row caught up.
   */
  test("the call is guarded by shouldRunWeeklySummary at the call site", () => {
    const idx = allCode.indexOf("runWeeklyImportSummaryCron(");
    expect(idx).toBeGreaterThanOrEqual(0);
    // Look backwards from the call to the enclosing condition.
    const before = allCode.slice(Math.max(0, idx - 600), idx);
    expect(before).toContain("shouldRunWeeklySummary(");
  });
});

/**
 * `fetchAndSyncDataPapers` (ADR 0077) pulls the citations dashboard's
 * data-papers manifest into `datasets.data_papers`. It is not sweep-shaped
 * either, so it gets the same targeted assertions `publishZarrCatalog` gets.
 * It is allowed on the dev cron because it only GETs a public manifest and
 * writes the calling env's own D1.
 */
describe("fetchAndSyncDataPapers is wired into the daily cron (outside the sweep framework)", () => {
  const NAME = "fetchAndSyncDataPapers";

  test("is declared in the DEV_CRON_ALLOWLIST named constant in index.ts", () => {
    const allowlist = /DEV_CRON_ALLOWLIST[^;]*;/s.exec(allCode)?.[0] ?? "";
    expect(allowlist).toContain(`"${NAME}"`);
  });

  test("is called at least once in scheduled()", () => {
    expect(callCount(allCode, NAME)).toBeGreaterThanOrEqual(1);
  });

  test("is wrapped in ctx.waitUntil", () => {
    expect(isScheduled(allCode, NAME)).toBe(true);
  });

  test("is called OUTSIDE the prod-only block, so it also runs on the dev cron", () => {
    expect(callCount(prodOnlyCode, NAME)).toBe(0);
    expect(callCount(allCode, NAME)).toBeGreaterThan(callCount(prodOnlyCode, NAME));
  });

  test("its own ctx.waitUntil call contains its own .catch, so a rejection can neither crash nor block the counts sync", () => {
    const body = waitUntilBody(allCode, `${NAME}(env)`);
    expect(body).toContain(`${NAME}(env)`);
    // Inside THIS call: the next job's .catch sits just past its closing paren
    // and must not be able to satisfy this.
    expect(body).toContain(".catch(");
  });

  test("the counts sync and this one are separate scheduled calls", () => {
    // One waitUntil each: a shared chain would let one failure skip the other.
    const counts = waitUntilBody(allCode, "fetchAndSyncCitationCounts(env.DB)");
    const papers = waitUntilBody(allCode, `${NAME}(env)`);
    expect(counts).not.toContain(NAME);
    expect(papers).not.toContain("fetchAndSyncCitationCounts");
    expect(counts).toContain(".catch(");
  });
});

/**
 * The text inside the `ctx.waitUntil( ... )` call that directly wraps `call`,
 * found by matching parentheses (string and template literals skipped), so an
 * assertion about a chain cannot be satisfied by code that belongs to the next
 * job. Throws if `call` is not the direct argument of a `ctx.waitUntil(`.
 */
function waitUntilBody(code: string, call: string): string {
  const idx = code.indexOf(call);
  if (idx < 0) throw new Error(`${call} not found`);
  const opener = "ctx.waitUntil(";
  const start = code.lastIndexOf(opener, idx);
  if (start < 0 || code.slice(start + opener.length, idx).trim() !== "") {
    throw new Error(`${call} is not the direct argument of ctx.waitUntil(`);
  }
  const open = start + opener.length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  throw new Error(`unbalanced parentheses after ${call}`);
}
