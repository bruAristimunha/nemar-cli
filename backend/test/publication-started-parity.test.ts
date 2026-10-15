/**
 * The two statements of "publishing has started" must agree (ADR 0102, ADR 0104 decision 3).
 *
 * `publishingHasStarted` (shared/publication-steps.ts) is the rule the administrator's denial and
 * the depositor's withdrawal both read from a row; `NO_PUBLISHING_STARTED_SQL` is the same rule as
 * terms of the withdrawal's conditional UPDATE, so the write re-reads the row it ends. They are
 * two spellings of one rule and nothing but this file keeps them together. Run on a real SQLite
 * engine over a row of every step name, every `current_step` and every malformed shape.
 *
 * What is pinned: on every well-formed row they give the same answer; on valid JSON that is not an
 * array of strings the SQL refuses (counts as started) where the function would allow, except JSON
 * null and null elements, where both say not started, and never the other way, which is the
 * direction a refusal may err in.
 *
 * CI TIER: unit-pure. A bun:sqlite engine in memory, nothing else.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PUBLICATION_STEPS, publishingHasStarted } from "../../shared/publication-steps";
import { NO_PUBLISHING_STARTED_SQL } from "../src/routes/datasets/publication";

const db = new Database(":memory:");

/** The SQL's answer for one row: true when it says publishing has STARTED. */
function sqlSaysStarted(steps: string | null, current: string | null): boolean {
  const row = db
    .query<{ ok: number }, [string | null, string | null]>(
      `SELECT ${NO_PUBLISHING_STARTED_SQL} AS ok
         FROM (SELECT ? AS steps_completed, ? AS current_step)`,
    )
    .get(steps, current);
  return row?.ok !== 1;
}

const fnSaysStarted = (steps: string | null, current: string | null) =>
  publishingHasStarted({ steps_completed: steps, current_step: current });

const CURRENT: (string | null)[] = [null, "", ...PUBLICATION_STEPS];

const WELL_FORMED: (string | null)[] = [
  null,
  "",
  "[]",
  ...PUBLICATION_STEPS.map((step) => JSON.stringify([step])),
  JSON.stringify(PUBLICATION_STEPS.slice(0, 3)),
  JSON.stringify(PUBLICATION_STEPS),
  JSON.stringify(["a_step_nobody_declared"]),
  // Not JSON at all: both read it as no steps.
  "{",
  "ci_check",
  "[ci_check]",
];

/** Valid JSON that is not an array of strings: the one place the two are allowed to differ. */
const NOT_AN_ARRAY_OF_STRINGS: string[] = [
  "null",
  '"s3_public_read"',
  "42",
  '{"s3_public_read":true}',
  "[1]",
  "[null]",
  '[["s3_public_read"]]',
  '[{"step":"s3_public_read"}]',
];

describe("publishingHasStarted and NO_PUBLISHING_STARTED_SQL", () => {
  test("agree on every step name, every current_step and every malformed shape", () => {
    for (const steps of WELL_FORMED) {
      for (const current of CURRENT) {
        expect(sqlSaysStarted(steps, current), `${steps} / ${current}`).toBe(
          fnSaysStarted(steps, current),
        );
      }
    }
  });

  test("the cases cover a started step, a validation step and the current step", () => {
    // Guards the loops above against a fixture that stopped reaching the boundary: some rows must
    // say started and some must not, by steps and by current_step alone.
    expect(fnSaysStarted(JSON.stringify([PUBLICATION_STEPS[0]]), null)).toBe(false);
    expect(fnSaysStarted(JSON.stringify(["s3_public_read"]), null)).toBe(true);
    expect(fnSaysStarted("[]", "s3_public_read")).toBe(true);
    expect(fnSaysStarted("[]", PUBLICATION_STEPS[0])).toBe(false);
    expect(sqlSaysStarted("[]", "s3_public_read")).toBe(true);
    expect(sqlSaysStarted(JSON.stringify(["s3_public_read"]), null)).toBe(true);
  });

  test("on valid JSON that is not an array of strings the SQL refuses wherever the function would allow", () => {
    for (const steps of NOT_AN_ARRAY_OF_STRINGS) {
      for (const current of CURRENT) {
        // Never more permissive than the function: wherever the function says started, so does
        // the SQL. (The reverse is the allowed difference, so it is not asserted.)
        if (fnSaysStarted(steps, current)) {
          expect(sqlSaysStarted(steps, current), `${steps} / ${current}`).toBe(true);
        }
      }
    }
    // And where it is stricter, it is stricter on purpose: a scalar, an object's value, a nested
    // array or a number is read as a started step, which the function ignores.
    for (const steps of [
      '"s3_public_read"',
      "42",
      '{"s3_public_read":true}',
      "[1]",
      '[["s3_public_read"]]',
      '[{"step":"s3_public_read"}]',
    ]) {
      expect(sqlSaysStarted(steps, null), steps).toBe(true);
      expect(fnSaysStarted(steps, null), steps).toBe(false);
    }
  });

  test("JSON null and a null element are NOT started in either: json_each yields NULL, and NULL NOT IN (...) is not true", () => {
    // The exact outcome, not the one-way implication above: the two agree here, and the SQL is
    // not stricter, so the comment that says what the SQL counts as started must not list these.
    for (const steps of ["null", "[null]", '[null, "ci_check"]']) {
      expect(sqlSaysStarted(steps, null), steps).toBe(false);
      expect(fnSaysStarted(steps, null), steps).toBe(false);
    }
    // A null beside a step that has started is still started: the null changes nothing.
    expect(sqlSaysStarted('[null, "s3_public_read"]', null)).toBe(true);
    expect(fnSaysStarted('[null, "s3_public_read"]', null)).toBe(true);
  });
});
