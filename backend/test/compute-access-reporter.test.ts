/**
 * The ACCESS reporter (epic #2005 phase A8, #2013; ADR 0118 decision 9; design section 9): it sends each
 * Slurm job's gateway attributes to ACCESS ONCE, under the stored pseudonym, from the 30-minute tick.
 * The rows it works on are made by the lifecycle (`compute-access-reports.test.ts`); here the jobs are
 * driven through the real lifecycle over the Tapis stand-in (a real HTTP server built from Tapis's
 * published specifications; NO RESPONSE IN IT WAS RECORDED FROM A REAL TENANT), and the ACCESS endpoint
 * is a real HTTP server too (`helpers/access-standin.ts`; NO RESPONSE IN IT WAS RECORDED FROM THE REAL
 * SERVICE). THE KEY HEADER NAME AND THE SPELLING OF THE BODY ARE UNVERIFIED: a test that pins a
 * spelling pins what the phase issue wrote, and says so; the owner confirms them against the real
 * interface when the key is issued.
 *
 * THE GUARANTEE, and what it is not. Towards ACCESS the reporter is AT MOST ONCE per job for every
 * outcome it cannot judge, and retries only what ACCESS visibly did not record:
 *  - the row is CLAIMED by one conditional UPDATE (`pending` to `attempting`, a lease stamp, the attempt
 *    counted) BEFORE the POST, so two overlapping runs cannot both send (MUTATION: send without the
 *    claim: the stand-in sees two requests);
 *  - an answer of 2xx is `sent`; a status that refuses or defers (3xx, 4xx, 408, 429, 5xx) means ACCESS
 *    did not record it, so the row is `pending` again with an exponential delay and `failed` only when
 *    the attempts run out;
 *  - NO ANSWER (a timeout, a lost connection, a refused connection) may mean the request was recorded:
 *    the row is `failed` with `outcome_unknown` and code never sends it again (MUTATION: retry it: the
 *    stand-in sees a second request); a sender that died holding its lease is the same, once the lease
 *    ends (a reaper, MUTATION: remove it and the row stays `attempting` for ever);
 *  - a sender writes its outcome only under its own lease stamp, so a reaped sender cannot overwrite the
 *    truth (MUTATION: drop the stamp from the outcome statements).
 * What is NOT guaranteed: that every job is reported. A report that may have been recorded and is not
 * known to have been is LOST, never doubled, and is `failed` with a fixed word for a person to resolve.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { COMPUTE_ACCESS_REPORT_ERRORS, COMPUTE_WORD_RE } from "../../shared/compute-state";
import {
  ACCESS_ATTRIBUTES_BASE,
  ACCESS_KEY_HEADER,
  ACCESS_REPORT_LEASE_MINUTES,
  ACCESS_REPORT_MAX_ATTEMPTS,
  ACCESS_REPORT_ROWS_PER_TICK,
  ACCESS_REPORT_TICK_BUDGET_MS,
  ACCESS_REPORT_TIMEOUT_MS,
  accessAttributesUrl,
  accessReportsLogLine,
  accessRetryDelayMinutes,
  accessSubmitTime,
  classifyAnswer,
  reportableGatewayUser,
  runAccessReportCron,
  sendAccessReport,
  throwedBeforeSend,
} from "../src/services/access-attributes";
import { advanceComputeJob, claimStamp, submitComputeJob } from "../src/services/compute-lifecycle";
import type { Bindings } from "../src/types/bindings";
import { type AccessStandin, startAccessStandin } from "./helpers/access-standin";
import {
  type LifecycleFixture,
  type MadeJob,
  makeJob,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundPlatform, roundTripD1, setPolicy } from "./helpers/compute-seed";
import { logged } from "./helpers/logs";

const KEY = "access-test-key-0123456789abcdef0123456789abcdef";
const RESOURCE = "example-resource-name";
const SRC = join(import.meta.dir, "../src");

let fx: LifecycleFixture;
let access: AccessStandin;
let previousUrl: string | undefined;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  access = startAccessStandin();
  previousUrl = (globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string })
    .NEMAR_ACCESS_ATTRIBUTES_URL;
  (globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string }).NEMAR_ACCESS_ATTRIBUTES_URL = access.url;
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  access.reset();
});

afterAll(async () => {
  (globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string }).NEMAR_ACCESS_ATTRIBUTES_URL =
    previousUrl;
  access?.stop();
  await fx?.dispose();
}, 30_000);

// --- Helpers -------------------------------------------------------------------------------------

interface ReportRow {
  job_id: string;
  state: string;
  attempts: number;
  next_attempt_at: string;
  claimed_at: string | null;
  last_error_code: string | null;
  sent_at: string | null;
}

/** A Worker environment with the ACCESS key and resource name set, production-shaped. */
function env(over: Partial<Bindings> = {}): Bindings {
  return fx.env({
    ACCESS_GATEWAY_ATTRIBUTES_KEY: KEY,
    ACCESS_RESOURCE_NAME: RESOURCE,
    ...over,
  });
}

async function report(e: Bindings, jobId: string): Promise<ReportRow> {
  const row = await e.DB.prepare("SELECT * FROM compute_access_reports WHERE job_id = ?1")
    .bind(jobId)
    .first<ReportRow>();
  if (!row) throw new Error("no report row");
  return row;
}

/** A job through the real lifecycle to QUEUED: its record shows a Slurm id, and its report is pending. */
async function queuedJob(
  over: Parameters<typeof makeJob>[1] = {},
): Promise<{ made: MadeJob; uuid: string }> {
  const made = await makeJob(fx, over);
  expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "submitted" });
  const job = await reread(made.env, made.job.id);
  fx.tapis.advance(job.tapis_uuid as string, "QUEUED");
  await advanceComputeJob(made.env, made.job.id);
  const queued = await reread(made.env, made.job.id);
  expect(queued.slurm_job_id).not.toBeNull();
  return { made: { ...made, job: queued }, uuid: job.tapis_uuid as string };
}

/** Move a report's due time into the past (what waiting does), keeping everything else. */
async function makeDue(e: Bindings, jobId: string): Promise<void> {
  await e.DB.prepare(
    "UPDATE compute_access_reports SET next_attempt_at = datetime('now', '-1 minute') WHERE job_id = ?1 AND state = 'pending'",
  )
    .bind(jobId)
    .run();
}

/** Minutes from now to the row's next attempt, from D1's own clock. */
async function minutesUntilNext(e: Bindings, jobId: string): Promise<number> {
  const row = await e.DB.prepare(
    "SELECT (julianday(next_attempt_at) - julianday('now')) * 1440 AS minutes FROM compute_access_reports WHERE job_id = ?1",
  )
    .bind(jobId)
    .first<{ minutes: number }>();
  return row?.minutes ?? Number.NaN;
}

const near = (value: number, expected: number, slack = 1.5) => Math.abs(value - expected) <= slack;

// --- What is sent --------------------------------------------------------------------------------

describe("what is sent", () => {
  test("one POST per job, with the four fields, the pseudonym and the key; none of a person's name, email or id (the spelling and the header are UNVERIFIED)", async () => {
    const { made } = await queuedJob({
      account: {
        given_name: "Ada",
        family_name: "Lovelace",
        email: "ada.lovelace@example.org",
        orcid: "0000-0002-1825-0097",
        country: "Freedonia",
        affiliation: "Institute of Analytical Engines",
        city: "Sylvania",
        username: "ada-the-analyst",
      },
    });
    const e = env();
    const lines = await logged(async () => {
      expect(await runAccessReportCron(e)).toMatchObject({ examined: 1, sent: 1, errors: [] });
    });

    expect(access.requests).toHaveLength(1);
    const request = access.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/job_attributes");
    expect(request?.headers["content-type"]).toContain("application/json");
    // THE KEY HEADER IS UNVERIFIED: this reads the constant, so the test follows the one place it is named.
    expect(request?.headers[ACCESS_KEY_HEADER.toLowerCase()]).toBe(KEY);
    // THE BODY SPELLING IS UNVERIFIED: these four names are the ones the phase issue wrote, and a change
    // to the one constant that holds them is a change to this expectation.
    expect(request?.body).toEqual({
      jobid: made.job.slurm_job_id,
      submittime: accessSubmitTime(made.job.remote_submitted_at),
      xsederesourcename: RESOURCE,
      gatewayuser: made.job.gateway_user,
    });
    expect(request?.body?.gatewayuser).toMatch(/^gw_[a-z2-7]{20}$/);
    // The raw bytes: no name, email, ORCID iD, country, affiliation, city, username or job id of NEMAR's.
    for (const secret of [
      "Ada",
      "Lovelace",
      "ada.lovelace",
      "0000-0002",
      "Freedonia",
      "Institute",
      "Sylvania",
      "ada-the-analyst",
      made.job.id,
      made.job.tapis_uuid ?? "no-tapis-uuid",
    ]) {
      expect(request?.raw).not.toContain(secret);
    }
    // Sent, once, and the row says so: no error word, no lease left over.
    expect(await report(e, made.job.id)).toMatchObject({
      state: "sent",
      attempts: 1,
      claimed_at: null,
      last_error_code: null,
    });
    expect((await report(e, made.job.id)).sent_at).not.toBeNull();
    // The key is never in the row, and never in a log line.
    expect(JSON.stringify(await report(e, made.job.id))).not.toContain(KEY);
    for (const line of lines) expect(line).not.toContain(KEY);
  });

  test("the submission time is the scheduler's, as ISO 8601 in UTC with a Z; a row with none is not an ISO time", () => {
    expect(accessSubmitTime("2026-11-04 17:30:05")).toBe("2026-11-04T17:30:05Z");
    expect(accessSubmitTime(null)).toBeNull();
    expect(accessSubmitTime("")).toBeNull();
    expect(accessSubmitTime("yesterday")).toBeNull();
  });

  test("a pipeline job is reported as `nemar-pipelines`", async () => {
    await fundPlatform(fx.env().DB, "pipelines", 1_000_000);
    const { made } = await queuedJob({ source: "pipeline" });
    expect(made.job.gateway_user).toBe("nemar-pipelines");
    await runAccessReportCron(env());
    expect(access.requests[0]?.body?.gatewayuser).toBe("nemar-pipelines");
    expect(reportableGatewayUser("nemar-pipelines")).toBe(true);
  });

  test("only a pseudonym or the pipelines' literal is ever reportable: never a name, an email or a subject", () => {
    expect(reportableGatewayUser("gw_abcdefghijklmnopqrst")).toBe(true);
    expect(reportableGatewayUser("gw_abcdefghijklmnopqrs")).toBe(false);
    expect(reportableGatewayUser("gw_ABCDEFGHIJKLMNOPQRST")).toBe(false);
    for (const bad of [
      "Ada Lovelace",
      "ada@example.org",
      "0000-0002-1825-0097",
      "orcid:0000-0002-1825-0097",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(reportableGatewayUser(bad as never)).toBe(false);
    }
  });

  test("the address is the ACCESS one unless the test override is installed", () => {
    const g = globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string };
    expect(accessAttributesUrl()).toBe(`${access.url}/job_attributes`);
    g.NEMAR_ACCESS_ATTRIBUTES_URL = undefined;
    try {
      expect(accessAttributesUrl()).toBe(`${ACCESS_ATTRIBUTES_BASE}/job_attributes`);
      expect(ACCESS_ATTRIBUTES_BASE).toMatch(/^https:\/\/[^/]+\/[^?#]*$/);
    } finally {
      g.NEMAR_ACCESS_ATTRIBUTES_URL = access.url;
    }
  });
});

describe("`debug`", () => {
  test("it is NOT in a production body, and IS in the body of any other environment (MUTATION: always send it, or never)", async () => {
    const { made } = await queuedJob();
    // Outside production the cron does nothing at all (below), so the sender is driven directly.
    expect(await sendAccessReport(env({ ENVIRONMENT: "development" }), made.job.id)).toBe("sent");
    expect(access.requests).toHaveLength(1);
    expect(access.requests[0]?.body).toMatchObject({ debug: true, jobid: made.job.slurm_job_id });

    const second = await queuedJob();
    await runAccessReportCron(env());
    expect(access.requests).toHaveLength(2);
    expect(access.requests[1]?.body).not.toHaveProperty("debug");
    expect(access.requests[1]?.body?.jobid).toBe(second.made.job.slurm_job_id);
  });

  test("the cron does nothing outside exact production, before it reads or sends anything", async () => {
    const { made } = await queuedJob();
    for (const environment of ["development", "staging", "test", "", undefined, "Production"]) {
      expect(
        await runAccessReportCron(env({ ENVIRONMENT: environment as Bindings["ENVIRONMENT"] })),
      ).toBeNull();
    }
    expect(access.requests).toHaveLength(0);
    expect((await report(env(), made.job.id)).state).toBe("pending");
  });
});

// --- Never twice ---------------------------------------------------------------------------------

describe("a report is never sent twice for one job", () => {
  test("a sent report is final: every later tick sends nothing", async () => {
    const { made } = await queuedJob();
    const e = env();
    await runAccessReportCron(e);
    for (let i = 0; i < 3; i++) {
      expect(await runAccessReportCron(e)).toMatchObject({ examined: 0, sent: 0 });
    }
    // Even forced due, a sent row is not taken.
    await e.DB.prepare(
      "UPDATE compute_access_reports SET next_attempt_at = datetime('now', '-1 day')",
    ).run();
    expect(await sendAccessReport(e, made.job.id)).toBe("not_pending");
    expect(access.requests).toHaveLength(1);
  });

  test("overlapping runs make ONE request: the claim is one conditional UPDATE (MUTATION: send without the claim)", async () => {
    const { made } = await queuedJob();
    // Every statement takes a round trip on both sides, so two runs that both read the row pending
    // before either claims it really do overlap.
    const slow = (): Bindings => ({ ...env(), DB: roundTripD1(env().DB) }) as Bindings;
    const outcomes = await Promise.all([
      runAccessReportCron(slow()),
      runAccessReportCron(slow()),
      runAccessReportCron(slow()),
      runAccessReportCron(slow()),
    ]);
    expect(access.requests).toHaveLength(1);
    expect(outcomes.reduce((n, r) => n + (r?.sent ?? 0), 0)).toBe(1);
    const row = await report(env(), made.job.id);
    expect(row).toMatchObject({ state: "sent", attempts: 1 });
  });

  test("two senders of one job answer exactly one `sent` and one `claim_lost`", async () => {
    const { made } = await queuedJob();
    const slow = (): Bindings => ({ ...env(), DB: roundTripD1(env().DB) }) as Bindings;
    const answers = await Promise.all([
      sendAccessReport(slow(), made.job.id),
      sendAccessReport(slow(), made.job.id),
    ]);
    expect(answers.sort()).toEqual(["claim_lost", "sent"]);
    expect(access.requests).toHaveLength(1);
  });

  test("a sender that died holding its lease sends nothing again: the row ends `failed`, `outcome_unknown`, once the lease is over (MUTATION: remove the reaper)", async () => {
    const { made } = await queuedJob();
    const e = env();
    // The state a crash after the claim (or after the POST and before the stamp) leaves: attempting,
    // one attempt counted, a lease stamp. A row cannot say which of the two it was.
    const takeWith = async (stamp: string) =>
      e.DB.prepare(
        "UPDATE compute_access_reports SET state = 'attempting', attempts = 1, claimed_at = ?2 WHERE job_id = ?1",
      )
        .bind(made.job.id, stamp)
        .run();

    // Inside its lease the sender may still be working: nothing is sent, nothing is changed.
    await takeWith(claimStamp(Date.now() - 60_000));
    expect(await runAccessReportCron(e)).toMatchObject({ reaped: 0, sent: 0 });
    expect(await report(e, made.job.id)).toMatchObject({ state: "attempting", attempts: 1 });

    // Past its lease it is dead: the report may or may not have left, so it is never sent by code.
    await takeWith(claimStamp(Date.now() - (ACCESS_REPORT_LEASE_MINUTES + 5) * 60_000));
    expect(await runAccessReportCron(e)).toMatchObject({ reaped: 1, sent: 0 });
    expect(await report(e, made.job.id)).toMatchObject({
      state: "failed",
      last_error_code: "outcome_unknown",
      claimed_at: null,
      attempts: 1,
    });
    expect(access.requests).toHaveLength(0);
    // And it stays: a failed row is final.
    await runAccessReportCron(e);
    expect(access.requests).toHaveLength(0);
  });

  test("an answer that never comes ends the row `failed`, `outcome_unknown`, and the report is NOT sent again (MUTATION: retry an unknown outcome)", async () => {
    const { made } = await queuedJob();
    const e = env();
    access.hang();
    const first = await runAccessReportCron(e, { timeoutMs: 300 });
    expect(first).toMatchObject({ examined: 1, sent: 0, unknown: 1 });
    expect(access.requests).toHaveLength(1);
    expect(await report(e, made.job.id)).toMatchObject({
      state: "failed",
      attempts: 1,
      last_error_code: "outcome_unknown",
      claimed_at: null,
    });
    // Later ticks, even with the delay long past, make no second request.
    await e.DB.prepare(
      "UPDATE compute_access_reports SET next_attempt_at = datetime('now', '-1 day')",
    ).run();
    await runAccessReportCron(e, { timeoutMs: 300 });
    await runAccessReportCron(e, { timeoutMs: 300 });
    expect(access.requests).toHaveLength(1);
  });

  test("a connection that was refused is judged the same way: a runtime cannot tell it from a reset after the request left", async () => {
    const { made } = await queuedJob();
    const e = env();
    access.down();
    expect(await runAccessReportCron(e, { timeoutMs: 1000 })).toMatchObject({
      unknown: 1,
      sent: 0,
    });
    expect(await report(e, made.job.id)).toMatchObject({
      state: "failed",
      last_error_code: "outcome_unknown",
    });
    access.up();
    await runAccessReportCron(e);
    expect(access.requests).toHaveLength(0);
  });

  /** The runtime's refusal of a call before it is made, thrown by `fetch` for the ACCESS address only. */
  async function withSubrequestLimit<T>(body: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).startsWith(access.url)) {
        return Promise.reject(new Error("Too many subrequests by single Worker invocation."));
      }
      return real(input, init);
    }) as typeof fetch;
    try {
      return await body();
    } finally {
      globalThis.fetch = real;
    }
  }

  test("a call the runtime refused BEFORE it was made (the subrequest limit) is retried on a later tick, not ended `outcome_unknown`; the tick stops claiming (MUTATION: treat every throw as unknown)", async () => {
    const first = await queuedJob();
    const second = await queuedJob();
    const e = env();
    const tick = await withSubrequestLimit(() => runAccessReportCron(e, { timeoutMs: 1000 }));
    expect(tick).toMatchObject({ examined: 2, retry: 1, unknown: 0, skipped: 1 });
    expect(access.requests).toHaveLength(0);
    const rows = [await report(e, first.made.job.id), await report(e, second.made.job.id)];
    // One row spent an attempt and waits; the other was never claimed. Neither is final.
    expect(rows.filter((r) => r.state === "pending")).toHaveLength(2);
    expect(rows.some((r) => r.last_error_code === "unavailable")).toBe(true);
    expect(rows.some((r) => r.last_error_code === "outcome_unknown")).toBe(false);
    // The next tick, with the limit gone and the delay passed, sends both.
    await e.DB.prepare(
      "UPDATE compute_access_reports SET next_attempt_at = datetime('now', '-1 minute')",
    ).run();
    expect(await runAccessReportCron(e)).toMatchObject({ sent: 2, unknown: 0 });
    expect(access.requests).toHaveLength(2);
  });

  test("any other throw (a reset, a refused connection) is still unknown: only the runtime's own refusal is known to be unsent", () => {
    expect(throwedBeforeSend(new Error("Too many subrequests by single Worker invocation."))).toBe(
      true,
    );
    for (const err of [
      new TypeError("Network connection lost."),
      new DOMException("The operation timed out.", "TimeoutError"),
      new Error("connect ECONNREFUSED"),
      "Too many subrequests",
      null,
    ]) {
      expect(throwedBeforeSend(err)).toBe(false);
    }
  });

  test("a sender whose lease was reaped while its POST was in flight cannot turn the row into `sent`", async () => {
    const { made } = await queuedJob();
    const e = env();
    // While the POST is in flight the reaper (another tick) judges the row dead: it is `failed`,
    // `outcome_unknown`. The sender's 200 then arrives and must not overwrite that.
    access.beforeAnswer(async () => {
      await e.DB.prepare(
        "UPDATE compute_access_reports SET state = 'failed', claimed_at = NULL, last_error_code = 'outcome_unknown' WHERE job_id = ?1",
      )
        .bind(made.job.id)
        .run();
    });
    expect(await sendAccessReport(e, made.job.id)).toBe("lease_lost");
    expect(access.requests).toHaveLength(1);
    expect(await report(e, made.job.id)).toMatchObject({
      state: "failed",
      last_error_code: "outcome_unknown",
      sent_at: null,
    });
  });

  test("nor can a sender whose lease another sender now holds: its outcome is written only under its own stamp (MUTATION: drop the stamp from the outcome statements)", async () => {
    const { made } = await queuedJob();
    const e = env();
    // The row was reaped and an operator put it back in the line; another sender has claimed it, with
    // a stamp of its own. The first sender's late answers (a 200, a 503, no answer) are not its to write.
    const foreign = claimStamp(Date.now() + 5_000);
    for (const answer of [200, 503, "none"] as const) {
      await e.DB.prepare(
        "UPDATE compute_access_reports SET state = 'pending', attempts = 0, claimed_at = NULL, sent_at = NULL, last_error_code = NULL, next_attempt_at = datetime('now', '-1 minute') WHERE job_id = ?1",
      )
        .bind(made.job.id)
        .run();
      if (answer === "none") access.hang();
      else access.answer(answer);
      access.beforeAnswer(async () => {
        await e.DB.prepare(
          "UPDATE compute_access_reports SET state = 'attempting', claimed_at = ?2 WHERE job_id = ?1",
        )
          .bind(made.job.id, foreign)
          .run();
      });
      expect([answer, await sendAccessReport(e, made.job.id, { timeoutMs: 300 })]).toEqual([
        answer,
        "lease_lost",
      ]);
      expect(await report(e, made.job.id)).toMatchObject({
        state: "attempting",
        claimed_at: foreign,
      });
    }
  });
});

// --- Retry ---------------------------------------------------------------------------------------

describe("what ACCESS refused is tried again, with an exponential delay, and ends `failed` after a bound", () => {
  test("a 503 leaves the row pending with an hour's delay; nothing is sent before it is due; the next attempt succeeds", async () => {
    const { made } = await queuedJob();
    const e = env();
    access.answer(503);
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 1, sent: 0, retry: 1 });
    expect(await report(e, made.job.id)).toMatchObject({
      state: "pending",
      attempts: 1,
      last_error_code: "unavailable",
      claimed_at: null,
      sent_at: null,
    });
    expect(near(await minutesUntilNext(e, made.job.id), 60)).toBe(true);

    // Not due: the same tick again sends nothing.
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 0 });
    expect(access.requests).toHaveLength(1);

    await makeDue(e, made.job.id);
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 1, sent: 1 });
    expect(access.requests).toHaveLength(2);
    // ACCESS recorded ONE of the two (the first was refused): the second is the only accepted report.
    expect(await report(e, made.job.id)).toMatchObject({
      state: "sent",
      attempts: 2,
      last_error_code: null,
    });
  });

  test("the delay doubles from an hour and stops at a day, and the row is `failed` after the bound, with the last word kept", async () => {
    const { made } = await queuedJob();
    const e = env();
    access.answer(503, ACCESS_REPORT_MAX_ATTEMPTS + 3);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= ACCESS_REPORT_MAX_ATTEMPTS; attempt++) {
      await makeDue(e, made.job.id);
      await runAccessReportCron(e);
      const row = await report(e, made.job.id);
      expect(row.attempts).toBe(attempt);
      if (attempt < ACCESS_REPORT_MAX_ATTEMPTS) {
        expect(row.state).toBe("pending");
        delays.push(Math.round(await minutesUntilNext(e, made.job.id)));
      } else {
        expect(row).toMatchObject({
          state: "failed",
          last_error_code: "unavailable",
          claimed_at: null,
        });
      }
    }
    expect(delays.map((d, i) => near(d, accessRetryDelayMinutes(i + 1)))).toEqual(
      delays.map(() => true),
    );
    expect([60, 120, 240, 480, 960, 1440, 1440]).toEqual(
      delays.map((_, i) => accessRetryDelayMinutes(i + 1)),
    );
    expect(access.requests).toHaveLength(ACCESS_REPORT_MAX_ATTEMPTS);
    // Final: nothing more is sent, however long it waits.
    await e.DB.prepare(
      "UPDATE compute_access_reports SET next_attempt_at = datetime('now', '-1 year')",
    ).run();
    await runAccessReportCron(e);
    expect(access.requests).toHaveLength(ACCESS_REPORT_MAX_ATTEMPTS);
  });

  test("the delay is pure: an hour doubled, never above a day", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map(accessRetryDelayMinutes)).toEqual([
      60, 120, 240, 480, 960, 1440, 1440, 1440, 1440, 1440,
    ]);
    expect(accessRetryDelayMinutes(0)).toBe(60);
    expect(accessRetryDelayMinutes(Number.NaN)).toBe(60);
  });

  test("only an answer that shows the request was NOT processed is retried: 4xx other than 409, and 408, 429 and 503, each its own fixed word (MUTATION: move a class boundary)", async () => {
    const e = env();
    const cases: Array<[number, string]> = [
      [400, "refused"],
      [401, "refused"],
      [403, "refused"],
      [404, "refused"],
      [405, "refused"],
      [410, "refused"],
      [422, "refused"],
      [499, "refused"],
      [408, "busy"],
      [429, "busy"],
      [503, "unavailable"],
    ];
    for (const [status, word] of cases) {
      const { made } = await queuedJob();
      access.answer(status);
      await sendAccessReport(e, made.job.id);
      expect([status, await report(e, made.job.id)]).toEqual([
        status,
        expect.objectContaining({ state: "pending", last_error_code: word, attempts: 1 }),
      ]);
    }
    for (const w of COMPUTE_ACCESS_REPORT_ERRORS) expect(COMPUTE_WORD_RE.test(w)).toBe(true);
  });

  test("an answer that may follow a recorded request is NEVER resent: every 3xx, 409, 500, 502 and 504 end the row `failed`, `outcome_unknown` (MUTATION: retry one of them)", async () => {
    // A gateway's 502 or 504 in front of a server that already stored the request, a 500 after the write, a
    // 303 ("created, see other", the usual reply to a POST) and a 409 (which may turn out to mean "already
    // recorded") are each an answer the sender cannot judge, so each is the same as no answer: lost, never
    // doubled. The stand-in answers each with its status; none is followed.
    const e = env();
    for (const status of [300, 301, 302, 303, 307, 308, 409, 500, 501, 502, 504, 505]) {
      const { made } = await queuedJob();
      const before = access.requests.length;
      access.answer(status);
      expect([status, await sendAccessReport(e, made.job.id)]).toEqual([status, "outcome_unknown"]);
      expect([status, await report(e, made.job.id)]).toEqual([
        status,
        expect.objectContaining({
          state: "failed",
          last_error_code: "outcome_unknown",
          attempts: 1,
          claimed_at: null,
        }),
      ]);
      // However long it waits, and whatever the tick does, nothing is sent again.
      await e.DB.prepare(
        "UPDATE compute_access_reports SET next_attempt_at = datetime('now', '-1 year') WHERE job_id = ?1",
      )
        .bind(made.job.id)
        .run();
      await runAccessReportCron(e);
      expect(access.requests.length - before).toBe(1);
    }
  });

  test("classifyAnswer over every status: sent for 2xx, a retry only for the answers that show nothing was processed, and unknown for the rest", () => {
    for (let status = 100; status <= 599; status++) {
      let expected: ReturnType<typeof classifyAnswer>;
      if (status >= 200 && status < 300) expected = { kind: "sent" };
      else if (status === 408 || status === 429) expected = { kind: "retry", word: "busy" };
      else if (status === 503) expected = { kind: "retry", word: "unavailable" };
      else if (status >= 400 && status < 500 && status !== 409) {
        expected = { kind: "retry", word: "refused" };
      } else expected = { kind: "unknown" };
      expect([status, classifyAnswer(status)]).toEqual([status, expected]);
    }
    expect(classifyAnswer(null)).toEqual({ kind: "unknown" });
  });

  test("a redirect is never followed: the key goes only where it was sent, and the row is not resent (MUTATION: follow redirects)", async () => {
    const { made } = await queuedJob();
    access.redirect(`${access.url}/elsewhere`);
    await sendAccessReport(env(), made.job.id);
    // One request, to the address that was asked for. A 3xx may follow a recorded request (303 is the
    // usual answer to a POST that created something), so the row is `failed`, never retried.
    expect(access.requests.map((r) => r.path)).toEqual(["/job_attributes"]);
    expect(await report(env(), made.job.id)).toMatchObject({
      state: "failed",
      last_error_code: "outcome_unknown",
    });
  });
});

// --- Not sendable yet ----------------------------------------------------------------------------

describe("what cannot be sent yet stays pending, and costs no attempt", () => {
  test("no key, or no resource name, or a blank one: the row stays pending with `unconfigured` and nothing is sent", async () => {
    const { made } = await queuedJob();
    for (const over of [
      { ACCESS_GATEWAY_ATTRIBUTES_KEY: undefined },
      { ACCESS_RESOURCE_NAME: undefined },
      { ACCESS_GATEWAY_ATTRIBUTES_KEY: "   " },
      { ACCESS_RESOURCE_NAME: "" },
    ]) {
      const e = env(over as Partial<Bindings>);
      const tick = await runAccessReportCron(e);
      expect(tick).toMatchObject({ unconfigured: 1, sent: 0, errors: [] });
      // Silence while there is work to do is evidence of nothing (ADR 0053): every tick that leaves a
      // row waiting for the key or the resource name says so, at error level, with the count.
      const log = accessReportsLogLine(tick as NonNullable<typeof tick>);
      expect(log).toMatchObject({ level: "error" });
      expect(log?.line).toContain("unconfigured=1");
      expect(log?.line).not.toContain(KEY);
      expect(await report(e, made.job.id)).toMatchObject({
        state: "pending",
        attempts: 0,
        last_error_code: "unconfigured",
        claimed_at: null,
      });
    }
    expect(access.requests).toHaveLength(0);

    // Once configured, the same row is sent and the word is cleared.
    expect(await runAccessReportCron(env())).toMatchObject({ sent: 1 });
    expect(await report(env(), made.job.id)).toMatchObject({
      state: "sent",
      attempts: 1,
      last_error_code: null,
    });
  });

  test("a job with no pseudonym (no account) is `failed` with `no_gateway_user` at once, and nothing is sent", async () => {
    const { made } = await queuedJob();
    const e = env();
    await e.DB.prepare("UPDATE compute_jobs SET gateway_user = NULL WHERE id = ?1")
      .bind(made.job.id)
      .run();
    expect(await runAccessReportCron(e)).toMatchObject({ failed: 1, sent: 0 });
    expect(await report(e, made.job.id)).toMatchObject({
      state: "failed",
      attempts: 0,
      last_error_code: "no_gateway_user",
    });
    expect(access.requests).toHaveLength(0);
  });

  test("a record with no scheduler submission time waits (`no_submit_time`), costs no attempt, and goes to the back of the line", async () => {
    const { made } = await queuedJob();
    const e = env();
    await e.DB.prepare("UPDATE compute_jobs SET remote_submitted_at = NULL WHERE id = ?1")
      .bind(made.job.id)
      .run();
    expect(await runAccessReportCron(e)).toMatchObject({ deferred: 1, sent: 0 });
    expect(await report(e, made.job.id)).toMatchObject({
      state: "pending",
      attempts: 0,
      last_error_code: "no_submit_time",
    });
    expect(near(await minutesUntilNext(e, made.job.id), 60)).toBe(true);
    expect(access.requests).toHaveLength(0);

    // The time arrives (a later read of the record gives it): the row is sent when due.
    await e.DB.prepare(
      "UPDATE compute_jobs SET remote_submitted_at = '2026-11-04 10:00:00' WHERE id = ?1",
    )
      .bind(made.job.id)
      .run();
    await makeDue(e, made.job.id);
    expect(await runAccessReportCron(e)).toMatchObject({ sent: 1 });
    expect(access.requests[0]?.body?.submittime).toBe("2026-11-04T10:00:00Z");
  });
});

describe("a refusal that persists is noticed in hours, not days", () => {
  // A key ACCESS refuses (401, 403) or a wrong base address (404) is retried with a delay doubling from an
  // hour, which is 79 hours of info-level `retry` lines before the eighth attempt fails the row. So any
  // row that has used 3 attempts with a retry class makes EVERY tick log one error-level line.
  test("the third refused attempt turns the tick's line to error level, and it stays so while the row waits (MUTATION: threshold, class filter)", async () => {
    const { made } = await queuedJob();
    const e = env();
    const lines: Array<{ level: string; line: string } | null> = [];
    for (const attempt of [1, 2, 3]) {
      access.answer(401);
      await makeDue(e, made.job.id);
      const tick = await runAccessReportCron(e);
      expect([attempt, tick]).toEqual([attempt, expect.objectContaining({ retry: 1 })]);
      lines.push(accessReportsLogLine(tick as NonNullable<typeof tick>));
    }
    expect(lines[0]).toMatchObject({ level: "info" });
    expect(lines[0]?.line).toContain("persistent=0");
    expect(lines[1]).toMatchObject({ level: "info" });
    expect(lines[2]).toMatchObject({ level: "error" });
    expect(lines[2]?.line).toContain("persistent=1");
    // Nothing is due for hours, and the tick still says so: silence while there is work is evidence of nothing.
    const quiet = await runAccessReportCron(e);
    expect(quiet).toMatchObject({ examined: 0, persistent: 1 });
    const line = accessReportsLogLine(quiet as NonNullable<typeof quiet>);
    expect(line).toMatchObject({ level: "error" });
    // Counts and a fixed word only: no key, address, Slurm id, pseudonym or job id.
    for (const secret of [
      KEY,
      access.url,
      made.job.slurm_job_id ?? "",
      made.job.gateway_user ?? "",
      made.job.id,
    ]) {
      expect(line?.line).not.toContain(secret);
    }
    expect(line?.line).toMatch(/^\[access-report\] .*persistent=1/);
  });

  test("only a PENDING row with a retry class and three attempts counts: not two attempts, not a sent or failed row, not a waiting word", async () => {
    const e = env();
    const rows = {
      twoAttempts: (await queuedJob()).made.job.id,
      sent: (await queuedJob()).made.job.id,
      noTime: (await queuedJob()).made.job.id,
      unconfigured: (await queuedJob()).made.job.id,
      exhausted: (await queuedJob()).made.job.id,
      persistent: (await queuedJob()).made.job.id,
    };
    const set = (id: string, state: string, attempts: number, code: string | null) =>
      e.DB.prepare(
        `UPDATE compute_access_reports SET state = ?2, attempts = ?3, last_error_code = ?4,
           sent_at = CASE WHEN ?2 = 'sent' THEN datetime('now') ELSE NULL END,
           next_attempt_at = datetime('now', '+1 day') WHERE job_id = ?1`,
      )
        .bind(id, state, attempts, code)
        .run();
    await set(rows.twoAttempts, "pending", 2, "refused");
    await set(rows.sent, "sent", 4, null);
    await set(rows.noTime, "pending", 5, "no_submit_time");
    await set(rows.unconfigured, "pending", 3, "unconfigured");
    // A row whose attempts ran out is `failed`, final, and counted by its own line, not as a waiting refusal.
    await set(rows.exhausted, "failed", ACCESS_REPORT_MAX_ATTEMPTS, "unavailable");
    expect(await runAccessReportCron(e)).toMatchObject({ persistent: 0 });
    await set(rows.persistent, "pending", 3, "busy");
    expect(await runAccessReportCron(e)).toMatchObject({ persistent: 1 });
    await set(rows.twoAttempts, "pending", 3, "unavailable");
    expect(await runAccessReportCron(e)).toMatchObject({ persistent: 2 });
  });
});

describe("a record that never gets a scheduler submission time is not looked at for ever", () => {
  /** A job whose record has no submission time, and a report row that first showed `days` ago. */
  async function stuck(days: number) {
    const { made } = await queuedJob();
    const e = env();
    await e.DB.prepare("UPDATE compute_jobs SET remote_submitted_at = NULL WHERE id = ?1")
      .bind(made.job.id)
      .run();
    await e.DB.prepare(
      "UPDATE compute_access_reports SET created_at = datetime('now', ?2), next_attempt_at = datetime('now', '-1 minute') WHERE job_id = ?1",
    )
      .bind(made.job.id, `-${days} days`)
      .run();
    return { made, e };
  }

  test("within a week it waits, and costs no attempt (MUTATION: the bound moves a day later)", async () => {
    const { made, e } = await stuck(6);
    expect(await runAccessReportCron(e)).toMatchObject({ deferred: 1, failed: 0, sent: 0 });
    expect(await report(e, made.job.id)).toMatchObject({
      state: "pending",
      attempts: 0,
      last_error_code: "no_submit_time",
    });
  });

  test("past a week from the first sight of the Slurm id it ends `failed` with `no_submit_time`, so a person is told, and it leaves the due window for good (MUTATION: remove the bound)", async () => {
    const { made, e } = await stuck(8);
    expect(await sendAccessReport(e, made.job.id)).toBe("failed");
    expect(await report(e, made.job.id)).toMatchObject({
      state: "failed",
      attempts: 0,
      last_error_code: "no_submit_time",
      claimed_at: null,
    });
    expect(access.requests).toHaveLength(0);
    // Final: not in the due window, and not sent when the time turns up later.
    await e.DB.prepare(
      "UPDATE compute_jobs SET remote_submitted_at = '2026-11-04 10:00:00' WHERE id = ?1",
    )
      .bind(made.job.id)
      .run();
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 0 });
    expect(access.requests).toHaveLength(0);
  });

  test("the tick counts it `failed` and says so, at error level", async () => {
    const { e } = await stuck(8);
    const tick = await runAccessReportCron(e);
    expect(tick).toMatchObject({ examined: 1, failed: 1, deferred: 0 });
    expect(accessReportsLogLine(tick as NonNullable<typeof tick>)).toMatchObject({
      level: "error",
    });
  });

  test("a stuck row does not delay a new report: after the bound, ten stuck rows are not in the window", async () => {
    const e = env();
    for (let i = 0; i < ACCESS_REPORT_ROWS_PER_TICK; i++) {
      const s = await stuck(30);
      expect(await sendAccessReport(e, s.made.job.id)).toBe("failed");
    }
    const fresh = await queuedJob();
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 1, sent: 1 });
    expect(access.requests.at(-1)?.body?.jobid).toBe(fresh.made.job.slurm_job_id);
  });
});

// --- The tick ------------------------------------------------------------------------------------

describe("the tick", () => {
  test("it reads the database first and does nothing else when nothing is due: no Tapis, no ACCESS", async () => {
    const e = env();
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 0, sent: 0, errors: [] });
    expect(access.requests).toHaveLength(0);
    expect(fx.tapis.log).toHaveLength(0);
  });

  test("ten rows a tick, oldest due first, and the rest on the next tick", async () => {
    const e = env();
    const ids: string[] = [];
    for (let i = 0; i < ACCESS_REPORT_ROWS_PER_TICK + 2; i++) {
      const { made } = await queuedJob();
      ids.push(made.job.id);
      // Spread the due times so "oldest first" is decidable.
      await e.DB.prepare(
        "UPDATE compute_access_reports SET next_attempt_at = datetime('now', ?2) WHERE job_id = ?1",
      )
        .bind(made.job.id, `-${100 - i} minutes`)
        .run();
    }
    expect(await runAccessReportCron(e)).toMatchObject({
      examined: ACCESS_REPORT_ROWS_PER_TICK,
      sent: ACCESS_REPORT_ROWS_PER_TICK,
    });
    const first = access.requests.map((r) => r.body?.jobid);
    const expectedFirst = await Promise.all(
      ids
        .slice(0, ACCESS_REPORT_ROWS_PER_TICK)
        .map(async (id) => (await reread(e, id)).slurm_job_id),
    );
    expect(first).toEqual(expectedFirst);
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 2, sent: 2 });
    expect(access.requests).toHaveLength(ACCESS_REPORT_ROWS_PER_TICK + 2);
    expect(new Set(access.requests.map((r) => r.body?.jobid)).size).toBe(
      ACCESS_REPORT_ROWS_PER_TICK + 2,
    );
  });

  test("a row that a refusal keeps pending does not hold the line: its delay puts it behind the due rows", async () => {
    const e = env();
    const stuck = await queuedJob();
    access.answer(503);
    await runAccessReportCron(e);
    const fresh = await queuedJob();
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 1, sent: 1 });
    expect(access.requests.at(-1)?.body?.jobid).toBe(fresh.made.job.slurm_job_id);
    expect((await report(e, stuck.made.job.id)).state).toBe("pending");
  });

  test("a tick stops CLAIMING new rows once its time budget is spent, so it is not killed mid-POST holding a lease; the rest wait for the next tick (MUTATION: remove the check, or lengthen the budget)", async () => {
    const e = env();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await queuedJob()).made.job.id);
    // A slow ACCESS, played by a clock the test owns: the first POST takes EXACTLY the budget of the
    // tick's time (the boundary: spent means spent), so no second row is claimed.
    let now = 1_000_000;
    access.beforeAnswer(async () => {
      now += ACCESS_REPORT_TICK_BUDGET_MS;
    });
    const first = await runAccessReportCron(e, { now: () => now });
    expect(first).toMatchObject({ examined: 4, sent: 1, skipped: 3, errors: [] });
    expect(access.requests).toHaveLength(1);
    // The rows it did not take were never claimed: still pending, no attempt spent.
    const states = await Promise.all(ids.map(async (id) => (await report(e, id)) as ReportRow));
    expect(states.filter((r) => r.state === "sent")).toHaveLength(1);
    const waiting = states.filter((r) => r.state === "pending");
    expect(waiting).toHaveLength(3);
    for (const r of waiting)
      expect(r).toMatchObject({ attempts: 0, claimed_at: null, last_error_code: null });

    // The next tick, with a clock that does not run away, takes them.
    expect(await runAccessReportCron(e)).toMatchObject({ examined: 3, sent: 3, skipped: 0 });
    expect(access.requests).toHaveLength(4);
    expect(new Set(access.requests.map((r) => r.body?.jobid)).size).toBe(4);
  });

  test("after the FIRST unjudgeable outcome the tick claims no more rows, so a bad minute at ACCESS loses one report and not ten (MUTATION: keep claiming)", async () => {
    // A deploy's 502, a 500, a 301 from a wrong address, a timeout: each is an outcome the sender cannot
    // judge, and a fault that is systematic makes every later row in the tick the same. The rows not
    // claimed stay pending with no attempt spent and no lease, for the next tick.
    // Thirty live jobs in all: more than the default tenant ceiling admits (issue #2121), which is not what
    // this case is about.
    await setPolicy(env().DB, fx.ownerId, {
      tenant: { maxLiveJobs: 1000, reserved: { people: 0, pipelines: 0, partner: 0 } },
    });
    for (const [name, arrange, status] of [
      ["a 502 on every request", () => access.answer(502, 6), 502],
      ["a 500 on every request", () => access.answer(500, 6), 500],
      ["a 308 on every request", () => access.answer(308, 6), 308],
      ["a 409 on every request", () => access.answer(409, 6), 409],
      ["no answer", () => access.hang(6), null],
    ] as const) {
      access.reset();
      const e = env();
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push((await queuedJob()).made.job.id);
      arrange();
      const tick = await runAccessReportCron(e, { timeoutMs: 300 });
      expect([name, tick]).toEqual([
        name,
        expect.objectContaining({ examined: 6, sent: 0, unknown: 1, skipped: 5, errors: [] }),
      ]);
      expect([name, access.requests.length]).toEqual([name, 1]);
      const rows = await Promise.all(ids.map(async (id) => (await report(e, id)) as ReportRow));
      expect([name, rows.filter((r) => r.state === "failed").length]).toEqual([name, 1]);
      const waiting = rows.filter((r) => r.state === "pending");
      expect([name, waiting.length]).toEqual([name, 5]);
      for (const r of waiting) {
        expect([name, r]).toEqual([
          name,
          expect.objectContaining({ attempts: 0, claimed_at: null, last_error_code: null }),
        ]);
      }
      expect(status === null || status >= 300).toBe(true);
      // The next tick, with ACCESS answering, sends the rest: nothing waited for ever.
      access.reset();
      expect(await runAccessReportCron(e)).toMatchObject({ sent: 5, skipped: 0 });
    }
  });

  test("an answer that proves the request was NOT processed does not stop the tick: a 503, a 429 and a 400 are each retried and the next row goes on", async () => {
    for (const [status, word] of [
      [503, "unavailable"],
      [429, "busy"],
      [400, "refused"],
    ] as const) {
      access.reset();
      const e = env();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push((await queuedJob()).made.job.id);
      access.answer(status, 4);
      expect([status, await runAccessReportCron(e)]).toEqual([
        status,
        expect.objectContaining({ examined: 4, retry: 4, unknown: 0, skipped: 0 }),
      ]);
      expect([status, access.requests.length]).toEqual([status, 4]);
      for (const id of ids) {
        expect(await report(e, id)).toMatchObject({
          state: "pending",
          attempts: 1,
          last_error_code: word,
        });
      }
    }
  });

  test("a tick whose budget is not yet spent goes on: a POST that took a millisecond less than the budget does not stop it", async () => {
    const e = env();
    for (let i = 0; i < 3; i++) await queuedJob();
    let now = 1_000_000;
    access.beforeAnswer(async () => {
      now += ACCESS_REPORT_TICK_BUDGET_MS - 1;
    });
    expect(await runAccessReportCron(e, { now: () => now })).toMatchObject({
      examined: 3,
      sent: 3,
      skipped: 0,
    });
  });

  test("the budget is about twenty seconds, well under what a Worker may spend and above one POST's fifteen", () => {
    expect(ACCESS_REPORT_TICK_BUDGET_MS).toBe(20_000);
    expect(ACCESS_REPORT_TICK_BUDGET_MS).toBeGreaterThan(ACCESS_REPORT_TIMEOUT_MS);
  });

  test("its one log line is counts and fixed words: no key, no Slurm id, no address, no pseudonym", async () => {
    const e = env();
    const { made } = await queuedJob();
    access.answer(503);
    let line: { level: string; line: string } | null = null;
    const logs = await logged(async () => {
      const r = await runAccessReportCron(e);
      line = r ? accessReportsLogLine(r) : null;
    });
    expect(line).not.toBeNull();
    const text = (line as unknown as { line: string }).line;
    expect(text).toMatch(/^\[access-report\] examined=1 sent=0 retry=1/);
    for (const secret of [
      KEY,
      made.job.slurm_job_id ?? "",
      access.url,
      made.job.gateway_user ?? "",
      made.job.id,
    ]) {
      expect(text).not.toContain(secret);
      for (const l of logs) expect(l).not.toContain(secret);
    }
    // Nothing to say, nothing said.
    expect(
      accessReportsLogLine({
        examined: 0,
        sent: 0,
        retry: 0,
        failed: 0,
        unknown: 0,
        unconfigured: 0,
        deferred: 0,
        reaped: 0,
        skipped: 0,
        persistent: 0,
        errors: [],
        errorClass: null,
      }),
    ).toBeNull();
  });
});

// --- No network call inside a batch --------------------------------------------------------------

/** The functions of `file` that contain a call matching `inside`, as `name` and the calls found. */
function functionsCalling(
  file: string,
  matches: (call: ts.CallExpression) => boolean,
): Map<string, string[]> {
  const text = readFileSync(join(SRC, file), "utf-8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Map<string, string[]>();
  const nameOf = (node: ts.Node): string | null => {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      return node.name.text;
    }
    return null;
  };
  const visit = (node: ts.Node, enclosing: string | null) => {
    const name = nameOf(node) ?? enclosing;
    if (ts.isCallExpression(node) && name !== null && matches(node)) {
      found.set(name, [...(found.get(name) ?? []), node.expression.getText()]);
    }
    ts.forEachChild(node, (child) => visit(child, name));
  };
  visit(sf, null);
  return found;
}

const isBatch = (c: ts.CallExpression) =>
  ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === "batch";
const NETWORK =
  /^(fetch|cancelJob|getTapisJob|searchJobsByTag|submitJob|subscribeWebhook|sendAccessReport|runAccessReportCron|downloadOutputPrefix)$/;
const isNetwork = (c: ts.CallExpression) =>
  (ts.isIdentifier(c.expression) && NETWORK.test(c.expression.text)) ||
  (ts.isPropertyAccessExpression(c.expression) && /^(fetch)$/.test(c.expression.name.text));

describe("no Tapis or ACCESS call runs inside a database batch", () => {
  test("the scan sees what it is meant to see (it is not vacuous)", () => {
    expect(functionsCalling("services/compute-lifecycle.ts", isBatch).has("commitTerminal")).toBe(
      true,
    );
    expect(functionsCalling("services/compute-lifecycle.ts", isBatch).has("applyOnce")).toBe(true);
    expect(functionsCalling("services/access-attributes.ts", isNetwork).size).toBeGreaterThan(0);
    expect(functionsCalling("services/compute-lifecycle.ts", isNetwork).size).toBeGreaterThan(0);
  });

  test("no function that runs a batch makes a network call: the lifecycle's two batch writers, the reporter and the release statements", () => {
    for (const file of [
      "services/compute-lifecycle.ts",
      "services/access-attributes.ts",
      "services/compute-release.ts",
      "db/user-tombstone.ts",
    ]) {
      const batches = functionsCalling(file, isBatch);
      const network = functionsCalling(file, isNetwork);
      for (const name of batches.keys()) {
        expect([file, name, network.get(name) ?? []]).toEqual([file, name, []]);
      }
    }
  });

  test("the release statements are text and binds: the module neither fetches nor reaches the Tapis client", () => {
    const text = readFileSync(join(SRC, "services/compute-release.ts"), "utf-8");
    const code = text
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/from\s+["']\.\/tapis\//);
  });
});

// --- Words and the secret ------------------------------------------------------------------------

describe("the words and the secret", () => {
  test("every error word the statements write is a declared one", async () => {
    const mod = (await import("../src/services/access-attributes")) as Record<string, unknown>;
    const sqls = Object.entries(mod)
      .filter(([name, value]) => name.endsWith("_SQL") && typeof value === "string")
      .map(([, value]) => value as string);
    const written = new Set(
      sqls.flatMap((sql) =>
        [...sql.matchAll(/last_error_code\s*=\s*'([a-z0-9_]+)'/g)].map((m) => m[1] as string),
      ),
    );
    expect([...written].sort()).toEqual([
      "no_gateway_user",
      "no_submit_time",
      "outcome_unknown",
      "unconfigured",
    ]);
    for (const word of written)
      expect(COMPUTE_ACCESS_REPORT_ERRORS as readonly string[]).toContain(word);
  });

  test("the key is named only in the reporter, the status view (presence) and the binding's type, and no log line names it", async () => {
    const { readdirSync } = await import("node:fs");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(SRC);
    const naming = files
      .filter((f) => readFileSync(f, "utf-8").includes("ACCESS_GATEWAY_ATTRIBUTES_KEY"))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    expect(naming).toEqual([
      "services/access-attributes.ts",
      "services/compute-status.ts",
      "types/bindings.ts",
    ]);
    for (const f of files.filter((name) => naming.includes(name.slice(SRC.length + 1)))) {
      for (const line of readFileSync(f, "utf-8").split("\n")) {
        if (/console\.(log|warn|error|info)/.test(line)) {
          expect(line).not.toMatch(/ACCESS_GATEWAY_ATTRIBUTES_KEY|config\.key|\bkey\b/);
        }
      }
    }
  });
});
