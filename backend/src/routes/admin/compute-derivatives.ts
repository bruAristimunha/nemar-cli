/**
 * An administrator's commands on the derivative store (portable compute, card V1b; ADR 0123 as amended
 * 2026-11-16; plan D14):
 *
 *   GET  /admin/compute/derivatives?dataset=<id>        admin   a dataset's derivatives (or every one), newest first
 *   GET  /admin/compute/derivatives/:key                admin   one derivative: its row and its description
 *   POST /admin/compute/derivatives/sync                admin   run one bounded pass of the store, answer its counts
 *   POST /admin/compute/derivatives/:key/retention      admin   `{"class": "catalog"}`; the OWNER for `{"class": "published"}`
 *
 * They are mounted on the admin router, so they sit behind its authentication, its admin check and its
 * cookie-origin guard. THE OWNER RULE for `published` is the service's (`promoteDerivative`), checked before
 * any row is read and in no second place: a route cannot forget it. No route lowers a class, deletes a
 * derivative, writes a DOI or returns an object's bytes; the only thing read back from the bucket is a
 * stored derivative's own description. With the store dark (the binding or its bucket name absent) every
 * route answers `derivatives_unavailable` (503) and writes nothing. Every refusal is
 * `{ error: <sentence>, code: <word> }`; an invalid body names its fields and never echoes a value. The sync
 * is audited as counts only (`compute.derivatives.sync`) and a promotion in the same batch as the change
 * (`compute.derivative.promoted`). Nothing here mails anyone or calls GitHub.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { COMPUTE_DATASET_ID_RE } from "../../../../shared/contract/compute.js";
import { auditLogStatement } from "../../db/audit-log.js";
import {
  DERIVATIVE_LIST_MAX,
  DERIVATIVE_MAX_OBJECTS,
  DERIVATIVE_SYNC_AUDIT_ACTION,
  derivativesBound,
  getDerivativeView,
  listDerivatives,
  promoteDerivative,
  syncDerivatives,
} from "../../services/compute-derivatives.js";
import { issuesOf } from "../../services/compute-policy.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import { fail, invalidBody, readJson, refuse } from "./compute.js";
import type { AdminRouter } from "./shared.js";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

/** The words of this store's routes, each with its status and sentence; the shared words (`owner_only`, `invalid_body`) are the compute routes'. */
const REFUSALS = {
  derivatives_unavailable: {
    status: 503,
    error: "The derivative store is not configured, so nothing was read or written.",
  },
  derivative_not_found: { status: 404, error: "There is no such derivative." },
  not_promotable: {
    status: 409,
    error:
      "That derivative cannot be raised to that class: a canary goes to catalog and a catalog to published, and only a stored one is raised.",
  },
} as const;

type DerivativeRefusal = keyof typeof REFUSALS;

function refuseDerivative(c: Ctx, code: DerivativeRefusal) {
  const r = REFUSALS[code];
  return c.json({ error: r.error, code }, r.status as ContentfulStatusCode);
}

const KEY_RE = /^[0-9a-f]{64}$/;

const listQuery = z.object({
  dataset: z.string().regex(COMPUTE_DATASET_ID_RE).optional(),
  limit: z.coerce.number().int().min(1).max(DERIVATIVE_LIST_MAX).default(50),
});

/** The body of a retention change: one class, nothing else. */
const retentionBody = z.object({ class: z.enum(["catalog", "published"]) }).strict();

/** The body of a sync: nothing, or how many objects it may copy or delete. */
const syncBody = z
  .object({ max_objects: z.number().int().min(1).max(DERIVATIVE_MAX_OBJECTS).optional() })
  .strict();

export function registerComputeDerivativeAdminRoutes(admin: AdminRouter): void {
  admin.get("/compute/derivatives", async (c) => {
    if (!derivativesBound(c.env)) return refuseDerivative(c, "derivatives_unavailable");
    const query = listQuery.safeParse({
      dataset: c.req.query("dataset"),
      limit: c.req.query("limit"),
    });
    if (!query.success) return refuse(c, "invalid_query");
    try {
      const rows = await listDerivatives(c.env.DB, query.data);
      return c.json({ derivatives: rows });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/derivatives/:key", async (c) => {
    if (!derivativesBound(c.env)) return refuseDerivative(c, "derivatives_unavailable");
    const key = c.req.param("key");
    if (!KEY_RE.test(key)) return refuseDerivative(c, "derivative_not_found");
    try {
      const view = await getDerivativeView(c.env, key);
      if (view === null) return refuseDerivative(c, "derivative_not_found");
      return c.json({ derivative: view.row, description: view.description });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/derivatives/sync", async (c) => {
    if (!derivativesBound(c.env)) return refuseDerivative(c, "derivatives_unavailable");
    // An EMPTY body is a sync with the default budget; any other body is checked, and a body that is not
    // JSON is refused (it is never read as an empty one).
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        return invalidBody(c, [{ path: "body", code: "invalid_json" }]);
      }
    }
    const body = syncBody.safeParse(raw);
    if (!body.success) return invalidBody(c, issuesOf(body.error));
    try {
      const result = await syncDerivatives(c.env, { maxObjects: body.data.max_objects });
      if (!result.available) return refuseDerivative(c, "derivatives_unavailable");
      const { available: _available, ...counts } = result;
      // Counts only: what a sync did, never a key or a path.
      await auditLogStatement(c.env.DB, {
        userId: c.get("user").id,
        action: DERIVATIVE_SYNC_AUDIT_ACTION,
        resourceType: "compute_derivatives",
        details: JSON.stringify(counts),
      }).run();
      return c.json({ ok: true, ...counts });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/derivatives/:key/retention", async (c) => {
    if (!derivativesBound(c.env)) return refuseDerivative(c, "derivatives_unavailable");
    const key = c.req.param("key");
    const body = retentionBody.safeParse(await readJson(c));
    if (!body.success) return invalidBody(c, issuesOf(body.error));
    if (!KEY_RE.test(key)) return refuseDerivative(c, "derivative_not_found");
    try {
      const user = c.get("user");
      const result = await promoteDerivative(c.env, {
        key,
        to: body.data.class,
        userId: user.id,
        role: user.role,
      });
      if (!result.ok) {
        if (result.code === "owner_only") return refuse(c, "owner_only");
        return refuseDerivative(c, result.code);
      }
      return c.json({ ok: true, derivative: result.row });
    } catch (err) {
      return fail(c, err);
    }
  });
}
