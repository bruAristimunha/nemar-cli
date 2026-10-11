/**
 * The NEMAR API as the pull-request review queue's command-line suite needs it: the REAL admin and
 * user routers (so `/admin/pr-reviews*` and `/users/me`, which `approve` reads to learn the
 * administrator's linked GitHub login) behind their real auth middleware.
 *
 * Lives in backend/test/helpers so `hono` resolves from the backend's own dependencies; the root
 * test imports this, not Hono, which is how the other CLI suites reach the backend.
 */

import { Hono } from "hono";
import { adminRoutes } from "../../src/routes/admin";
import { userRoutes } from "../../src/routes/users";
import type { Bindings, Variables } from "../../src/types/bindings";

export function makePrQueueApp(): (req: Request, env: Bindings) => Response | Promise<Response> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/users", userRoutes);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}
