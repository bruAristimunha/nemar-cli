/**
 * The NEMAR API as the publication review's end-to-end suite needs it: the REAL admin, dataset and
 * webhook routers behind their real auth middleware and token checks, so a chain can run from a
 * screen result through the review job's own claim and report to the administrator's list and the
 * depositor's status, with nothing between them replaced.
 *
 * Lives in backend/test/helpers so `hono` resolves from the backend's own dependencies; the root
 * test imports this, not Hono (the pattern of `pr-queue-app.ts`).
 *
 * `waitUntil` is kept, not dropped: the callbacks answer first and finish the admin mail and the
 * review's start after the answer, which is the Workers runtime's `waitUntil`. A test awaits
 * `settled()` before it counts what was sent, so "no mail yet" and "exactly one mail" are both
 * read after all of the work a request deferred has run.
 */

import { Hono } from "hono";
import { adminRoutes } from "../../src/routes/admin";
import { datasetRoutes } from "../../src/routes/datasets";
import webhooks from "../../src/routes/webhooks";
import type { Bindings, Variables } from "../../src/types/bindings";

export interface PublicationReviewApp {
  /** Answer a request as the Worker would, with an execution context that keeps deferred work. */
  handle(req: Request, env: Bindings): Response | Promise<Response>;
  /** Wait for everything deferred so far, including work that deferred more work. */
  settled(): Promise<void>;
}

export function makePublicationReviewApp(): PublicationReviewApp {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/datasets", datasetRoutes);
  app.route("/webhooks", webhooks);
  let pending: Promise<unknown>[] = [];
  return {
    handle: (req, env) =>
      app.fetch(req, env, {
        waitUntil: (task: Promise<unknown>) => void pending.push(task),
        passThroughOnException: () => {},
      } as unknown as ExecutionContext),
    async settled() {
      while (pending.length > 0) {
        const batch = pending;
        pending = [];
        await Promise.allSettled(batch);
      }
    },
  };
}
