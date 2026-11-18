/**
 * The owner's routes for runner registrations (portable compute, card DM-05; decisions D4, D5 and D6;
 * protocol `nemar.runner.v1`):
 *
 *   POST /compute/runners              owner   register a runner; the secret is answered ONCE
 *   GET  /compute/runners              owner   the registrations, newest first, without a hash
 *   POST /compute/runners/:id/revoke   owner   end one registration, its tokens and its work
 *
 * Owner only, on every route, and checked before the body is read: a registration mints a credential,
 * and a revoke ends a machine's work. They are mounted on the admin router, so they sit behind its
 * authentication, its admin check and its cookie-origin guard, and an administrator who is not an owner
 * is answered `owner_only` (403). Refusals are `{ error: <sentence>, code: <word> }` as the rest of
 * `/admin/compute`. The registry's own two words, with their statuses, are declared below and are not
 * part of the runner protocol (no runner ever reads them): `runner_not_found` and `runner_name_taken`.
 *
 * REGISTRATION. The body is `RunnerRegisterRequestSchema` (strict). `accounting: "su"` is refused
 * `runner_accounting_unbuilt` (409, the word of `RUNNER_REFUSALS`) until phase H builds holds, settlement
 * and ACCESS for such a job. The answer is `{ runner_id, secret }` with `Cache-Control: no-store`, and the
 * secret is in no row, no log line and no audit row: only its SHA-256 is stored. One audit row,
 * `compute.runner.registered`, shape only. The switches are not read: an owner may register while runners
 * are off, and the registration is useless until the owner turns them on.
 *
 * REVOKE runs `runnerRevokeStatements` in one batch with its audit row (`compute.runner.revoked`) and
 * answers `{ runner_id, revoked: true, already_revoked }`; a registration that is already revoked is
 * answered the same way, 200, and runs nothing (so a retry after a lost answer is safe).
 *
 * Nothing here mails anyone, calls GitHub or is a cron.
 */

import { RUNNER_REFUSAL_STATUS } from "../../../../shared/compute-state";
import {
  RUNNER_ID_RE,
  RunnerRegisterRequestSchema,
  type RunnerRegisterResponse,
} from "../../../../shared/contract/compute-runner";
import { auditLogStatement } from "../../db/audit-log";
import { issuesOf } from "../../services/compute-policy";
import {
  RunnerNameTaken,
  RunnerOwnerNotStanding,
  type RunnerRow,
  getRunner,
  listRunners,
  registerRunner,
  runnerRevokeStatements,
} from "../../services/compute-runners";
import { hashApiKey } from "../../services/token";
import { type Ctx, fail, invalidBody, readJson, refuse, requireOwner } from "./compute";
import type { AdminRouter } from "./shared";

/** The registry's own refusals: not the protocol's, so declared here with their statuses. */
const REGISTRY_REFUSALS = {
  runner_not_found: { status: 404, error: "There is no such runner." },
  runner_name_taken: { status: 409, error: "A live registration already has that name." },
} as const;

function registryRefusal(c: Ctx, code: keyof typeof REGISTRY_REFUSALS) {
  const r = REGISTRY_REFUSALS[code];
  return c.json({ error: r.error, code }, r.status);
}

/** A registration as the owner reads it: the row with its runtimes as a list, and never a hash. */
function runnerView(row: RunnerRow) {
  return {
    id: row.id,
    name: row.name,
    pool: row.pool,
    cores: row.cores,
    memory_mb: row.memory_mb,
    gpus: row.gpus,
    scratch_gb: row.scratch_gb,
    backend: row.backend,
    runtimes: JSON.parse(row.runtimes) as string[],
    arch: row.arch,
    accounting: row.accounting,
    site: row.site,
    trust: row.trust,
    registered_by: row.registered_by,
    registered_at: row.registered_at,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
    last_seen_at: row.last_seen_at,
    runner_version: row.runner_version,
  };
}

/**
 * The id of the API key this request was made with, for the audit row: null when it came with a session
 * (there is no key) or the key is not found.
 */
async function keyIdOf(c: Ctx): Promise<number | null> {
  if (c.get("authMethod") !== "token") return null;
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const row = await c.env.DB.prepare("SELECT id FROM tokens WHERE api_key_hash = ? AND user_id = ?")
    .bind(await hashApiKey(header.substring(7)), c.get("user").id)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export function registerComputeRunnerAdminRoutes(admin: AdminRouter): void {
  admin.post("/compute/runners", requireOwner, async (c) => {
    const parsed = RunnerRegisterRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, issuesOf(parsed.error));
    if (parsed.data.accounting === "su") {
      return c.json(
        {
          error: "A runner that is accounted in service units is not built yet.",
          code: "runner_accounting_unbuilt",
        },
        RUNNER_REFUSAL_STATUS.runner_accounting_unbuilt,
      );
    }
    try {
      const { runnerId, secret } = await registerRunner(
        c.env.DB,
        c.get("user").id,
        parsed.data,
        await keyIdOf(c),
      );
      c.header("Cache-Control", "no-store");
      const body: RunnerRegisterResponse = { runner_id: runnerId, secret };
      return c.json(body, 201);
    } catch (err) {
      if (err instanceof RunnerNameTaken) return registryRefusal(c, "runner_name_taken");
      // The owner was ended after this request authenticated: the same answer as any non-owner.
      if (err instanceof RunnerOwnerNotStanding) return refuse(c, "owner_only");
      return fail(c, err);
    }
  });

  admin.get("/compute/runners", requireOwner, async (c) => {
    try {
      const rows = await listRunners(c.env.DB);
      return c.json({ runners: rows.map(runnerView) });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/runners/:id/revoke", requireOwner, async (c) => {
    const id = c.req.param("id");
    if (!RUNNER_ID_RE.test(id)) return registryRefusal(c, "runner_not_found");
    try {
      const row = await getRunner(c.env.DB, id);
      if (!row) return registryRefusal(c, "runner_not_found");
      if (row.revoked_at !== null) {
        return c.json({ runner_id: id, revoked: true, already_revoked: true });
      }
      const db = c.env.DB;
      await db.batch([
        ...runnerRevokeStatements(id, "owner_revoked").map((s) =>
          db.prepare(s.sql).bind(...s.binds),
        ),
        auditLogStatement(db, {
          userId: c.get("user").id,
          action: "compute.runner.revoked",
          resourceType: "compute_runner",
          resourceId: id,
          details: JSON.stringify({ reason: "owner_revoked" }),
        }),
      ]);
      return c.json({ runner_id: id, revoked: true, already_revoked: false });
    } catch (err) {
      return fail(c, err);
    }
  });
}
