/**
 * The compute gateway's job commands for an administrator (epic #2005 phase A5, #2010; ADR 0118):
 *
 *   POST /admin/compute/jobs/:id/cancel    cancel a job (at Tapis, and release its hold if it never started)
 *   POST /admin/compute/jobs/:id/advance   one step: submit a `created` job, or read the job back from
 *                                          Tapis and apply it, and repair what a finished job is owed; a
 *                                          runner job is refused `invalid_body` naming `executor`
 *
 * `advance` is the way a job advances in development, where no compute cron runs. Both are the same
 * code the webhook, the 30-minute tick and a person's own cancel run (`advanceComputeJob`,
 * `requestComputeCancel`): an administrator has no second path to a job's state.
 *
 * What an administrator is shown is `jobView` (the cancel answer adds a runner job's partial-usage mark, as
 * every report does): fixed words, numbers and times, `platform_failure` (an
 * INFORMATION flag, so a NEMAR-caused failure can be compensated by a manual grant: nothing is ever
 * refunded automatically) and the four flags. No identity, no specification, no token, no address and
 * no log. Every refusal is `{ error, code }` with the words of `shared/compute-state.ts`. The routes
 * sit behind the admin router's middleware (authentication, the admin role, the cookie-origin guard).
 */

import {
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
} from "../../../../shared/compute-state.js";
import { COMPUTE_ADMIN_ERROR_STATUS } from "../../../../shared/contract/compute-admin.js";
import { COMPUTE_JOB_ID_RE } from "../../../../shared/contract/compute.js";
import { getJob } from "../../services/compute-jobs.js";
import {
  advanceComputeJob,
  jobView,
  requestComputeCancel,
} from "../../services/compute-lifecycle.js";
import { reportedJobView, withUsageMark } from "../../services/compute-reporting.js";
import type { AdminRouter } from "./shared.js";

export function registerComputeJobAdminRoutes(admin: AdminRouter): void {
  admin.post("/compute/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!COMPUTE_JOB_ID_RE.test(id)) {
      return c.json(
        { error: COMPUTE_ROUTE_SENTENCES.job_not_found, code: "job_not_found" },
        COMPUTE_REFUSAL_STATUS.job_not_found,
      );
    }
    const result = await requestComputeCancel(c.env, id, "admin");
    if (!result.ok) {
      const code = result.outcome === "job_not_found" ? "job_not_found" : "bad_state";
      return c.json(
        {
          error:
            code === "bad_state"
              ? "The job has already ended."
              : COMPUTE_ROUTE_SENTENCES.job_not_found,
          code,
        },
        COMPUTE_REFUSAL_STATUS[code],
      );
    }
    // A runner job that already ended carries the usage its runner reported, and with it the mark that says
    // whether that usage is whole: the answer is the report view, not the bare one (`getJob` does not select it).
    const job = await getJob(c.env.DB, id);
    return c.json({
      ok: true,
      outcome: result.outcome,
      job: job ? reportedJobView(await withUsageMark(c.env.DB, job)) : null,
    });
  });

  admin.post("/compute/jobs/:id/advance", async (c) => {
    const id = c.req.param("id");
    if (!COMPUTE_JOB_ID_RE.test(id)) {
      return c.json(
        { error: COMPUTE_ROUTE_SENTENCES.job_not_found, code: "job_not_found" },
        COMPUTE_REFUSAL_STATUS.job_not_found,
      );
    }
    // A runner job is pulled by its runner, never advanced from here (ADR 0121): refused, naming the field.
    const existing = await getJob(c.env.DB, id);
    if (existing !== null && existing.executor !== "tapis") {
      return c.json(
        {
          error: "The request is not valid: executor: a runner job is not advanced from here.",
          code: "invalid_body",
        },
        COMPUTE_ADMIN_ERROR_STATUS.invalid_body,
      );
    }
    const result = await advanceComputeJob(c.env, id);
    if (result.job === null) {
      return c.json(
        { error: COMPUTE_ROUTE_SENTENCES.job_not_found, code: "job_not_found" },
        COMPUTE_REFUSAL_STATUS.job_not_found,
      );
    }
    return c.json({
      ok: true,
      outcome: result.outcome,
      ...(result.submit === undefined ? {} : { submit: result.submit }),
      job: jobView(result.job),
    });
  });
}
