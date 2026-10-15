/**
 * `nemar admin publish deny` names the request it denies (ADR 0105, decision 7; #1579).
 *
 * The Worker's `/deny` takes an optional `request_id` and refuses (409 `request_mismatch`) when it
 * is not the newest active request, but the command used to send none, so a request withdrawn or
 * denied and filed again between the administrator's look and the denial was denied in place of
 * the one they chose, and its depositor was mailed a reason written for another. The command now
 * reads the request in force (as `approve` does), names it in the confirmation, sends its number,
 * and accepts `--request-id` for a script. Real command, real backend app over a real D1
 * (`helpers/admin-publish-cli.ts`); the race is made by writing to the database between the
 * command's read and its denial, so the Worker's refusal is the Worker's.
 *
 * Mutation checks (each turns a named test red): send no `request_id` (the race rows and the body
 * row); skip the local comparison of `--request-id` with the request shown; drop the length check
 * of the reason.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { REQUEST_MISMATCH_MESSAGE } from "../shared/contract/publication";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { DATASET, seedUnstarted } from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const ADMIN_KEY = "deny-request-admin-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  await h.admin("denyrequestadmin", ADMIN_KEY);
});

const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;
const denyArgs = (...extra: string[]) => [
  "admin",
  "publish",
  "deny",
  DATASET,
  "--reason",
  "Please add the participants file",
  "--yes",
  ...extra,
];
const denies = () => h.posted.filter((p) => p.path.endsWith("/deny"));
const row = (id: number) =>
  h.db
    .query<{ status: string; denied_reason: string | null }, [number]>(
      "SELECT status, denied_reason FROM publication_requests WHERE id = ?",
    )
    .get(id);

/** The request is withdrawn by its depositor and filed again: the newest active one is another. */
function withdrawAndRefile(id: number): number {
  h.db.run(
    "UPDATE publication_requests SET status = 'denied', withdrawn_at = datetime('now') WHERE id = ?",
    [id],
  );
  return seedUnstarted(h.db);
}

describe("the request is named", () => {
  test("the confirmation names it and the denial carries its number", async () => {
    const id = seedUnstarted(h.db);

    const r = await h.cli(denyArgs());

    expect(r.exitCode).toBe(0);
    expect(denies()).toHaveLength(1);
    expect(denies()[0]?.body).toEqual({
      reason: "Please add the participants file",
      request_id: id,
    });
    expect(row(id)?.status).toBe("denied");
  });

  test("a request withdrawn and filed again after it was read is not denied in its place", async () => {
    const first = seedUnstarted(h.db);
    let second = 0;
    h.after(`GET /admin/publish/${DATASET}/review`, () => {
      second = withdrawAndRefile(first);
    });

    const r = await h.cli(denyArgs());

    expect(second).toBeGreaterThan(first);
    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(REQUEST_MISMATCH_MESSAGE);
    expect(denies()).toHaveLength(1);
    expect(denies()[0]?.body?.request_id).toBe(first);
    // The new request was not denied and its depositor was not mailed.
    expect(row(second)).toEqual({ status: "requested", denied_reason: null });
    expect(h.mail).toEqual([]);
  });

  test("--request-id for another request than the one in force is refused before anything is sent", async () => {
    const id = seedUnstarted(h.db);

    const r = await h.cli(denyArgs("--request-id", String(id + 5)));

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain(`--request-id names request #${id + 5}`);
    expect(output(r)).toContain(`is #${id}`);
    expect(denies()).toEqual([]);
    expect(row(id)?.status).toBe("requested");
  });

  test("--request-id for the request in force is sent", async () => {
    const id = seedUnstarted(h.db);

    const r = await h.cli(denyArgs("--request-id", String(id)));

    expect(r.exitCode).toBe(0);
    expect(denies()[0]?.body?.request_id).toBe(id);
  });

  test("--request-id that is not a number is refused before anything is read or sent", async () => {
    seedUnstarted(h.db);

    const r = await h.cli(denyArgs("--request-id", "twelve"));

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("--request-id needs a request number");
    expect(h.requests).toEqual([]);
  });
});

describe("the reason is as long as the Worker takes", () => {
  test("a reason of more than 2000 characters is refused here, and nothing is sent", async () => {
    seedUnstarted(h.db);

    const r = await h.cli([
      "admin",
      "publish",
      "deny",
      DATASET,
      "--reason",
      "x".repeat(2001),
      "--yes",
    ]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("at most 2000 characters; this one is 2001");
    expect(denies()).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  test("a reason of exactly 2000 characters is sent", async () => {
    const id = seedUnstarted(h.db);

    const r = await h.cli([
      "admin",
      "publish",
      "deny",
      DATASET,
      "--reason",
      "x".repeat(2000),
      "--yes",
    ]);

    expect(r.exitCode).toBe(0);
    expect(row(id)?.status).toBe("denied");
  });
});
