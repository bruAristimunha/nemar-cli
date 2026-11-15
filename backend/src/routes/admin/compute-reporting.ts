/**
 * The compute gateway's reporting, legal-hold, observer and ACCESS-report routes for administrators and
 * the owner (epic #2005 phase A7, #2012; ADR 0118; design section 9). Mounted on the admin router, so
 * the router's middleware (authentication, the admin role, the cookie-origin guard) is the gate; the
 * owner-only routes check the role HERE, before the body is read, and say so (403 `owner_only`).
 *
 *   GET    /compute/jobs                          admin  jobs by flag, state, account, executor,
 *                                                       accounting and runner; `unmatched=1` lists
 *                                                       Expanse's rows that no job claims
 *   GET    /compute/records/:ref                  admin  one job (NEMAR id, Tapis uuid or Slurm id):
 *                                                       index row, ledger entries, provenance, manifest
 *                                                       summary. No identity.
 *   POST   /compute/records/:ref/read             owner  one record, with a stated reason, audited first
 *                                                       (the identity snapshot or the specification)
 *   GET    /compute/report                        admin  one account's jobs and charge in a date range;
 *                                                       runner jobs are totaled apart, never in SU
 *   GET    /compute/reports/runners               admin  every runner registration's usage in a date
 *                                                       range, in the runner's own figures, never in SU
 *   GET    /compute/access-report                 admin  a quarter's distinct gateway users and jobs
 *   GET    /compute/holds                         admin  the active legal holds
 *   POST   /compute/holds                         owner  place a hold on `job:<id>` or `account:<id>`
 *   DELETE /compute/holds/:id                     owner  release one
 *   GET    /compute/access-reports                admin  ACCESS report rows in a state, `failed` by word
 *   POST   /compute/access-reports/:jobId/requeue owner  put a failed report back, on the explicit
 *                                                       acknowledgement that ACCESS did NOT record it
 *   POST   /compute/observer-runs                 admin  mint the observer's one-hour token (audited)
 *
 * NO VIEW HERE CARRIES IDENTITY. A job is shown by its number and fixed words; the identity snapshot and
 * the specification are reached only by the owner's reasoned, audited read. Every refusal is
 * `{ error, code }` with the words of `shared/contract/compute-admin.ts`; a body or query that is not
 * valid names the fields and never echoes a value.
 */

import { z } from "zod";
import {
  COMPUTE_ACCESS_REPORT_STATES,
  COMPUTE_ACCOUNTING,
  COMPUTE_EXECUTORS,
  COMPUTE_HOLD_SCOPES,
  COMPUTE_JOB_FLAGS,
  COMPUTE_STATES,
  COMPUTE_WORD_RE,
} from "../../../../shared/compute-state";
import { COMPUTE_JOB_ID_RE } from "../../../../shared/contract/compute";
import {
  COMPUTE_REPORT_PAGE_MAX,
  COMPUTE_RUNNER_REPORT_DAYS_MAX,
} from "../../../../shared/contract/compute-admin";
import { RUNNER_ID_RE } from "../../../../shared/contract/compute-runner";
import { listActiveHolds, placeHold, releaseHold } from "../../services/compute-legal-holds";
import { mintObserverRun } from "../../services/compute-observer";
import { fieldPath } from "../../services/compute-policy";
import { readRecordObject } from "../../services/compute-records";
import {
  accessReport,
  accountReport,
  listAccessReports,
  listJobRows,
  listUnmatchedSacct,
  quarterBounds,
  recordSummary,
  reportRangeDays,
  reportedJobView,
  requeueAccessReport,
  resolveJobRef,
  runnersUsageReport,
} from "../../services/compute-reporting";
import { type Ctx, fail, invalidBody, readJson, refuse, requireOwner } from "./compute";
import type { AdminRouter } from "./shared";

const issues = (error: z.ZodError) =>
  error.issues.slice(0, 5).map((i) => ({ path: fieldPath(i.path), code: i.code }));

const bool = z.enum(["1", "true", "0", "false"]).transform((v) => v === "1" || v === "true");

const jobsQuery = z.object({
  flag: z.enum(COMPUTE_JOB_FLAGS).optional(),
  state: z.enum(COMPUTE_STATES).optional(),
  account: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  executor: z.enum(COMPUTE_EXECUTORS).optional(),
  accounting: z.enum(COMPUTE_ACCOUNTING).optional(),
  runner: z.string().regex(RUNNER_ID_RE).optional(),
  limit: z.coerce.number().int().min(1).max(COMPUTE_REPORT_PAGE_MAX).default(50),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  unmatched: bool.optional(),
});

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const reportQuery = z.object({
  account: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
});

const runnersReportQuery = z.object({
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
});

const holdBody = z
  .object({
    scope: z.enum(COMPUTE_HOLD_SCOPES),
    ref: z.string().min(1).max(40),
    reason: z.string().regex(COMPUTE_WORD_RE),
  })
  .strict();

const holdsQuery = z.object({
  scope: z.enum(COMPUTE_HOLD_SCOPES).optional(),
  ref: z.string().min(1).max(40).optional(),
});

const reportsQuery = z.object({
  state: z.enum(COMPUTE_ACCESS_REPORT_STATES).default("failed"),
  limit: z.coerce.number().int().min(1).max(COMPUTE_REPORT_PAGE_MAX).default(50),
  after: z.string().regex(COMPUTE_JOB_ID_RE).optional(),
});

const requeueBody = z.object({ confirmed_not_recorded: z.literal(true) }).strict();

const readBody = z.object({ name: z.string().min(1).max(300), reason: z.string() }).strict();

function badQuery(c: Ctx, error: z.ZodError) {
  const named = issues(error).map((f) => `${f.path || "query"}: ${f.code}`);
  return refuse(c, "invalid_query", `The query is not valid: ${named.join("; ")}`);
}

export function registerComputeReportingRoutes(admin: AdminRouter): void {
  admin.get("/compute/jobs", async (c) => {
    const query = jobsQuery.safeParse(c.req.query());
    if (!query.success) return badQuery(c, query.error);
    try {
      if (query.data.unmatched === true) {
        return c.json(await listUnmatchedSacct(c.env.DB, query.data.limit));
      }
      const page = await listJobRows(c.env.DB, {
        flag: query.data.flag,
        state: query.data.state,
        account: query.data.account,
        executor: query.data.executor,
        accounting: query.data.accounting,
        runner: query.data.runner,
        limit: query.data.limit,
        after: query.data.after,
      });
      return c.json({ jobs: page.jobs.map(reportedJobView), next_after: page.next_after });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/records/:ref", async (c) => {
    try {
      const job = await resolveJobRef(c.env.DB, c.req.param("ref"));
      if (job === null) return refuse(c, "job_not_found");
      return c.json(await recordSummary(c.env, job));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/records/:ref/read", requireOwner, async (c) => {
    const parsed = readBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, issues(parsed.error));
    try {
      const job = await resolveJobRef(c.env.DB, c.req.param("ref"));
      if (job === null) return refuse(c, "job_not_found");
      const user = c.get("user");
      const result = await readRecordObject(c.env, c.env.DB, {
        actor: { id: user.id, role: user.role },
        jobId: job.id,
        name: parsed.data.name,
        reason: parsed.data.reason,
      });
      if (!result.ok) {
        switch (result.code) {
          case "not_owner":
            return refuse(c, "owner_only");
          case "invalid_reason":
            return refuse(c, "invalid_reason");
          case "invalid_record":
            return invalidBody(c, [{ path: "name", code: "invalid_string" }]);
          case "record_missing":
            return refuse(c, "record_missing");
          case "compute_disabled":
            return refuse(c, "compute_disabled");
          default:
            return refuse(c, "audit_failed");
        }
      }
      if (result.kind === "url") {
        return c.json({
          job_id: job.id,
          name: result.name,
          kind: "url",
          url: result.url,
          expires_at: result.expires_at,
        });
      }
      const text = new TextDecoder().decode(result.bytes);
      let content: unknown = text;
      try {
        content = JSON.parse(text);
      } catch {
        // Not JSON: the text itself.
      }
      return c.json({ job_id: job.id, name: result.name, kind: "bytes", content });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/report", async (c) => {
    const query = reportQuery.safeParse(c.req.query());
    if (!query.success) return badQuery(c, query.error);
    try {
      return c.json(await accountReport(c.env.DB, query.data));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/reports/runners", async (c) => {
    const query = runnersReportQuery.safeParse(c.req.query());
    if (!query.success) return badQuery(c, query.error);
    const days = reportRangeDays(query.data.from, query.data.to);
    if (days === null) {
      return refuse(
        c,
        "invalid_query",
        "The query is not valid: from and to are real dates, YYYY-MM-DD.",
      );
    }
    if (days < 1) {
      return refuse(c, "invalid_query", "The query is not valid: from is after to.");
    }
    if (days > COMPUTE_RUNNER_REPORT_DAYS_MAX) {
      return refuse(
        c,
        "invalid_query",
        `The query is not valid: a range is at most ${COMPUTE_RUNNER_REPORT_DAYS_MAX} days.`,
      );
    }
    try {
      return c.json(await runnersUsageReport(c.env.DB, query.data));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/access-report", async (c) => {
    const quarter = c.req.query("quarter") ?? "";
    if (quarterBounds(quarter) === null) {
      return refuse(
        c,
        "invalid_query",
        "The query is not valid: quarter is yyyyQn, for example 2026Q4.",
      );
    }
    try {
      const report = await accessReport(c.env.DB, quarter);
      return c.json(report);
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/holds", async (c) => {
    const query = holdsQuery.safeParse(c.req.query());
    if (!query.success) return badQuery(c, query.error);
    try {
      return c.json(await listActiveHolds(c.env.DB, query.data));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/holds", requireOwner, async (c) => {
    const parsed = holdBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, issues(parsed.error));
    const body = parsed.data;
    const refOk =
      body.scope === "job" ? COMPUTE_JOB_ID_RE.test(body.ref) : /^[1-9]\d{0,14}$/.test(body.ref);
    if (!refOk) return invalidBody(c, [{ path: "ref", code: "invalid_string" }]);
    try {
      const result = await placeHold(c.env.DB, { ...body, ownerId: c.get("user").id });
      if (!result.ok) {
        return refuse(c, result.code === "not_owner" ? "owner_only" : result.code);
      }
      return c.json({ hold: result.hold }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.delete("/compute/holds/:id", requireOwner, async (c) => {
    const raw = c.req.param("id");
    if (!/^[1-9]\d{0,14}$/.test(raw)) return refuse(c, "hold_not_found");
    try {
      const result = await releaseHold(c.env.DB, { id: Number(raw), ownerId: c.get("user").id });
      if (!result.ok) return refuse(c, result.code === "not_owner" ? "owner_only" : result.code);
      return c.json({ hold: result.hold });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/access-reports", async (c) => {
    const query = reportsQuery.safeParse(c.req.query());
    if (!query.success) return badQuery(c, query.error);
    try {
      const page = await listAccessReports(c.env.DB, query.data);
      return c.json({
        rows: page.rows,
        failed_by_word: page.counts,
        next_after: page.next_after,
      });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/access-reports/:jobId/requeue", requireOwner, async (c) => {
    const jobId = c.req.param("jobId");
    const parsed = requeueBody.safeParse(await readJson(c));
    // A missing or false acknowledgement is its own word, so the CLI can say what to do.
    if (!parsed.success) return refuse(c, "acknowledgement_required");
    if (!COMPUTE_JOB_ID_RE.test(jobId)) return refuse(c, "report_not_found");
    try {
      const result = await requeueAccessReport(c.env.DB, {
        jobId,
        ownerId: c.get("user").id,
      });
      if (!result.ok) return refuse(c, result.code === "not_owner" ? "owner_only" : result.code);
      return c.json({ ok: true, job_id: jobId, previous: result.previous });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/observer-runs", async (c) => {
    try {
      const minted = await mintObserverRun(c.env, c.get("user").id);
      if (!minted.ok) return refuse(c, "compute_disabled");
      return c.json(
        { run_id: minted.runId, token: minted.token, expires_in_minutes: minted.expiresInMinutes },
        201,
      );
    } catch (err) {
      return fail(c, err);
    }
  });
}
