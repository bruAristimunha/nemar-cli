/**
 * Runner registrations, their credentials, and what ending one does (portable compute, card DM-05;
 * decisions D4 and D5; AGENTS.md, "Revocation cascades, always").
 *
 * A RUNNER is `nemar-runner` on a workstation or a cluster. An owner registers it and is shown a SECRET
 * (`nmr_` and 64 hex) once; only its SHA-256 is stored. The secret buys, and does nothing else but buy,
 * an ACCESS TOKEN (`nmra_` and 64 hex, 900 seconds, hashed at rest) that the runner's own routes accept.
 * Both prefixes are refused by every other path before any lookup (`middleware/auth.ts`), and the access
 * token is accepted only by `runnerAccess` (`routes/compute-runners.ts`), so a runner credential can
 * never act as an API key, an OpenID Connect token or a job token.
 *
 * THE CASCADE. Ending a registration has to end everything minted from it: its tokens, and its work.
 * {@link runnerRevokeStatements} does that for one registration and {@link runnerEndStatements} for every
 * live registration an owner made, as statements for the caller to run in the SAME batch as its own
 * credential revocations (the shape of `computeReleaseStatements` and `oidcEndStatements`). In this order,
 * and the order is load-bearing:
 *  1. DELETE the runner's access tokens: a token stops working at once, not at its expiry;
 *  2. RELEASE its unstarted claims: a `created` job with `runner_claimed_at` set, `started_at` NULL and NO
 *     cancel recorded has the claim, the runner and the lease cleared and waits to be claimed by another
 *     runner. A claim that was already counted stays counted (`claim_attempts` is not touched), as an
 *     expired lease's does. A claim whose cancel was already recorded is NOT released (a waiting job with a
 *     cancel on it would be live forever, holding a slot, with nothing to end it): it goes down step 3;
 *  3. UNREPORT its started jobs: a live job with `started_at` set, past `created` (a slurm job waiting in
 *     its scheduler's queue has no `started_at` yet and is not a claim to give away) or with a cancel
 *     recorded has its lease cleared and moves to `unreported`, keeping `runner_id` and `runner_claimed_at`
 *     (and so a NULL `lease_expires_at`), so the sweep keys on the state and the runner's revoked flag, never
 *     on a lease's expiry, and can name the revocation (`runner_revoked`). With
 *     no lease, neither the lease header nor the job token of the dead runner can land outputs any more;
 *     the job then follows the lease rules of D4 (verified if its outputs completed, else lost);
 *  4. REVOKE the registration (`revoked_at`, `revoke_reason`), LAST, because the owner-keyed statements
 *     above select the owner's registrations by `revoked_at IS NULL`: written first, it would leave them
 *     nothing to select. A single-runner revoke keeps the same order.
 * A job that already ended, another runner's job and another owner's registration are untouched. Nothing
 * here calls a runner or the network; a runner learns it was revoked when its next call is refused.
 *
 * EVERY STATEMENT ENDS IN A WHERE CLAUSE and uses plain `?` placeholders only, because
 * `tombstoneUserCascade` called with `onlyIfEmail` appends ` AND EXISTS (SELECT 1 FROM users WHERE id = ?
 * AND email = ?)` to each statement's text and its two binds after the statement's own: a statement that
 * ended in anything else would not take the guard. REPLAYABLE: a second run changes nothing.
 *
 * THREE CALLERS of {@link runnerEndStatements}, and the count is the point: `finalizeRevocation`
 * (`routes/admin/users.ts`: admin revoke, by username and by id), `tombstoneUserCascade`
 * (`db/user-tombstone.ts`: the owner-only soft delete and the scheduled sweep of the live tests' accounts,
 * which run the same function, so it counts once) and the role demotion handler
 * (`routes/admin/users.ts#POST /users/:username/role`: registering a runner is an OWNER's act, so an owner
 * demoted has their registrations ended with the rest of what only an owner holds; unlike compute, which
 * a demotion leaves alone, because a demoted person keeps their jobs and pool). The list is
 * {@link RUNNER_END_CALLERS}, and `backend/test/compute-runner-end-callers.test.ts` holds it to the code on
 * the syntax tree, and holds every function that revokes all of an account's keys and sessions to either
 * running the set or being named in {@link RUNNER_END_EXCEPTIONS}.
 *
 * DELIBERATELY NOT CALLED, and a later reader should not "fix" either: an API key revocation (the owner's,
 * a person's own, the emailed regeneration) and a sign-out. A runner's secret is not minted from an API
 * key, so ending the key ends nothing the runner holds, and an owner who loses a key still owns the
 * runner. To end a runner, revoke its registration.
 *
 * THE STOLEN-KEY RESIDUAL, and the incident step it needs: a stolen owner key can register a runner and
 * the registration then outlives the key's revocation (the exception above, ADR 0121). The registering key
 * is recorded in the `compute.runner.registered` audit row (`key_id`). So after revoking a leaked owner key,
 * run `nemar admin compute runners list` and revoke every registration you do not recognize.
 *
 * AND THE OWNER MUST STILL STAND. A registration is written only `FROM users` of an approved, undeleted
 * OWNER, and a secret's exchange and an access token's use join `users` for the same standing, so a request
 * that was already past authentication when the cascade committed cannot leave a live registration behind
 * (`registerRunner`, `findRunnerBySecret`, `exchangeRunnerSecret`, `resolveRunnerAccess`).
 *
 * The one admin route that revokes ONE registration is `POST /admin/compute/runners/:id/revoke`, which
 * runs {@link runnerRevokeStatements}.
 */

import type { ComputeAccounting, RunnerBackend } from "../../../shared/compute-state.js";
import {
  RUNNER_ACCESS_PREFIX,
  RUNNER_ACCESS_TOKEN_SECONDS,
  RUNNER_ID_RE,
  RUNNER_SECRET_PREFIX,
  type RunnerArch,
  type RunnerRegisterRequest,
  type RunnerTrust,
} from "../../../shared/contract/compute-runner.js";
import type { ComputePool } from "../../../shared/contract/compute.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import { LIVE_STATES_SQL } from "./compute-state-sql.js";
import { hashApiKey } from "./token.js";

/** One statement of the cascade: bind `binds` to `sql`, left to right, and add it to a batch. */
export interface RunnerEndStatement {
  sql: string;
  binds: unknown[];
}

/**
 * Why a registration ended, recorded as `revoke_reason` (a fixed word, checked by shape): the owner's
 * own revoke, and the three account-level causes of {@link RUNNER_END_CALLERS}.
 */
export const RUNNER_REVOKE_REASONS = [
  "owner_revoked",
  "account_revoked",
  "account_deleted",
  "role_demoted",
] as const;
export type RunnerRevokeReason = (typeof RUNNER_REVOKE_REASONS)[number];

// --- The cascade -----------------------------------------------------------------------------------

/** Which registration a statement selects: the one named by `?`, or every live one of an owner (`?`). */
const BY_RUNNER = "= ?";

/**
 * The standing a registration's owner must keep, over `users` as `u`: an approved, undeleted OWNER. Part of
 * every statement that writes or honours a registration, so a request that was past authentication when the
 * owner's cascade committed cannot leave a usable one behind.
 */
export const OWNER_STANDING_SQL =
  "u.role = 'owner' AND u.status = 'approved' AND u.deleted_at IS NULL";
const BY_OWNER =
  "IN (SELECT id FROM compute_runners WHERE registered_by = ? AND revoked_at IS NULL)";

const tokensSql = (r: string) => `DELETE FROM compute_runner_tokens WHERE runner_id ${r}`;

const releaseSql = (r: string) => `UPDATE compute_jobs SET
    runner_claimed_at = NULL, runner_id = NULL, lease_id = NULL, lease_expires_at = NULL
  WHERE runner_id ${r} AND state = 'created' AND runner_claimed_at IS NOT NULL
    AND started_at IS NULL AND cancel_requested_at IS NULL`;

const unreportSql = (r: string) => `UPDATE compute_jobs SET
    lease_id = NULL, lease_expires_at = NULL, state = 'unreported'
  WHERE runner_id ${r} AND state IN (${LIVE_STATES_SQL}) AND (started_at IS NOT NULL OR state <> 'created' OR cancel_requested_at IS NOT NULL)`;

/**
 * 1. A single registration's access tokens (`?` the runner id). ONE CALLER: {@link runnerRevokeStatements}
 * and, through it, `POST /admin/compute/runners/:id/revoke`.
 */
export const RUNNER_REVOKE_TOKENS_SQL = tokensSql(BY_RUNNER);
/** 2. Its unstarted claims (`?` the runner id). ONE CALLER: {@link runnerRevokeStatements}. */
export const RUNNER_REVOKE_RELEASE_SQL = releaseSql(BY_RUNNER);
/** 3. Its started live jobs (`?` the runner id). ONE CALLER: {@link runnerRevokeStatements}. */
export const RUNNER_REVOKE_UNREPORT_SQL = unreportSql(BY_RUNNER);
/** 4. The registration itself (`?` the reason, then the runner id). ONE CALLER: {@link runnerRevokeStatements}. */
export const RUNNER_REVOKE_SQL = `UPDATE compute_runners SET
    revoked_at = datetime('now'), revoke_reason = ?
  WHERE id = ? AND revoked_at IS NULL`;

/**
 * 1. The access tokens of every live registration of an owner (`?` the owner's account id).
 *
 * THREE CALLERS, through {@link runnerEndStatements}: the same three as {@link RUNNER_END_CALLERS}, which
 * a test holds to the code. A fourth path that ends a credential for good needs these statements too.
 */
export const RUNNER_END_TOKENS_SQL = tokensSql(BY_OWNER);
/** 2. Their unstarted claims (`?` the owner). THREE CALLERS: the same three. */
export const RUNNER_END_RELEASE_SQL = releaseSql(BY_OWNER);
/** 3. Their started live jobs (`?` the owner). THREE CALLERS: the same three. */
export const RUNNER_END_UNREPORT_SQL = unreportSql(BY_OWNER);
/** 4. The registrations themselves, LAST (`?` the reason, then the owner). THREE CALLERS: the same three. */
export const RUNNER_END_SQL = `UPDATE compute_runners SET
    revoked_at = datetime('now'), revoke_reason = ?
  WHERE registered_by = ? AND revoked_at IS NULL`;

function checkReason(reason: string): void {
  if (!(RUNNER_REVOKE_REASONS as readonly string[]).includes(reason)) {
    throw new RangeError("reason is not a runner revoke reason");
  }
}

/**
 * The statements that end ONE registration and its work, for the caller's own batch (see the header for
 * the order and the rules every statement keeps). Pure: builds text and binds, touches no database.
 * Throws a `RangeError` for an id or reason that is not one, before building anything.
 */
export function runnerRevokeStatements(
  runnerId: string,
  reason: RunnerRevokeReason,
): RunnerEndStatement[] {
  if (!RUNNER_ID_RE.test(runnerId)) throw new RangeError("runnerId is not a runner id");
  checkReason(reason);
  return [
    { sql: RUNNER_REVOKE_TOKENS_SQL, binds: [runnerId] },
    { sql: RUNNER_REVOKE_RELEASE_SQL, binds: [runnerId] },
    { sql: RUNNER_REVOKE_UNREPORT_SQL, binds: [runnerId] },
    { sql: RUNNER_REVOKE_SQL, binds: [reason, runnerId] },
  ];
}

/**
 * The statements that end EVERY live registration an owner made, and their work: the same four steps as
 * {@link runnerRevokeStatements}, selected by `registered_by` (see the header for the three callers).
 * Pure. Throws a `RangeError` for an account id or reason that is not one.
 */
export function runnerEndStatements(
  userId: number,
  reason: RunnerRevokeReason,
): RunnerEndStatement[] {
  if (!Number.isSafeInteger(userId) || userId < 1) {
    throw new RangeError("userId is not an account id");
  }
  checkReason(reason);
  return [
    { sql: RUNNER_END_TOKENS_SQL, binds: [userId] },
    { sql: RUNNER_END_RELEASE_SQL, binds: [userId] },
    { sql: RUNNER_END_UNREPORT_SQL, binds: [userId] },
    { sql: RUNNER_END_SQL, binds: [reason, userId] },
  ];
}

/**
 * THE DOCUMENTED LIST of the functions that run {@link runnerEndStatements}, as `file#function` under
 * `backend/src` (a route callback is `file#METHOD /path`), in the form of `COMPUTE_END_CALLERS`. THREE:
 * the two paths that end every credential an account holds, and the role demotion. The test holds this
 * list to the code on the syntax tree, in both directions.
 */
export const RUNNER_END_CALLERS = [
  "db/user-tombstone.ts#tombstoneUserCascade",
  "routes/admin/users.ts#POST /users/:username/role",
  "routes/admin/users.ts#finalizeRevocation",
] as const;

/**
 * The functions that revoke ALL of an account's API keys and its sessions and deliberately do NOT end its
 * runner registrations, each with its reason. A new entry is a decision that a registration survives the
 * revocation, made in a reviewed change.
 */
export const RUNNER_END_EXCEPTIONS: Readonly<Record<string, string>> = {
  "routes/auth.ts#GET /confirm-key-regeneration":
    "The emailed key regeneration revokes every API key and the docs credential and mints a new key in the same request: the person keeps the account and the runner's secret was never minted from a key, so no registration ends.",
};

// --- Registration ----------------------------------------------------------------------------------

/** A runner's id: `rnr_` and 24 lowercase hex digits. */
export function newRunnerId(): string {
  return `rnr_${randomHex(12)}`;
}

/** `bytes` random bytes as lowercase hex, from the platform's cryptographic generator. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A secret or an access token: the prefix and 32 random bytes as 64 hex digits. */
export const newRunnerCredential = (prefix: string): string => `${prefix}${randomHex(32)}`;

/** The hash a credential is stored and looked up by (SHA-256, lowercase hex). */
export const hashRunnerCredential = hashApiKey;

export interface RunnerRow {
  id: string;
  name: string;
  pool: ComputePool;
  cores: number;
  memory_mb: number;
  gpus: number;
  scratch_gb: number;
  backend: RunnerBackend;
  runtimes: string;
  arch: RunnerArch;
  accounting: ComputeAccounting;
  site: string;
  trust: RunnerTrust;
  registered_by: number;
  registered_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  last_seen_at: string | null;
  runner_version: string | null;
}

/** Every column a view may show: never `secret_hash`. */
const VIEW_COLUMNS = `id, name, pool, cores, memory_mb, gpus, scratch_gb, backend, runtimes, arch,
  accounting, site, trust, registered_by, registered_at, revoked_at, revoke_reason, last_seen_at,
  runner_version`;

/** What a runner's own routes know of it once an access token is accepted: its id and its capacity. */
export interface RunnerPrincipal {
  id: string;
  name: string;
  pool: ComputePool;
  cores: number;
  memory_mb: number;
  gpus: number;
  scratch_gb: number;
  backend: RunnerBackend;
  runtimes: string[];
  arch: RunnerArch;
  accounting: ComputeAccounting;
  site: string;
  trust: RunnerTrust;
}

/** The registration was refused because a live registration already has the name. */
export class RunnerNameTaken extends Error {
  constructor() {
    super("a live runner registration already has that name");
    this.name = "RunnerNameTaken";
  }
}

/** The registration was refused because its owner is no longer an approved, undeleted owner. */
export class RunnerOwnerNotStanding extends Error {
  constructor() {
    super("the registering account is not an approved owner");
    this.name = "RunnerOwnerNotStanding";
  }
}

/**
 * Register a runner (the owner's act; the route checks the role) and its audit row, in ONE batch, and
 * return the id and the SECRET, which this call is the only time anything holds in the clear. The row is
 * written `FROM users` of an approved, undeleted owner: when the owner's cascade committed after the route
 * authenticated the request, nothing is written and {@link RunnerOwnerNotStanding} is thrown. Throws
 * {@link RunnerNameTaken} when a live registration has the name (the partial unique index decides, so two
 * racing registrations cannot both win). `keyId` is the id of the API key the request used, or null for a
 * session: it is recorded in the audit row, for the stolen-key incident step in the header.
 */
export async function registerRunner(
  db: D1Database,
  ownerId: number,
  body: RunnerRegisterRequest,
  keyId: number | null = null,
): Promise<{ runnerId: string; secret: string }> {
  const runnerId = newRunnerId();
  const secret = newRunnerCredential(RUNNER_SECRET_PREFIX);
  const secretHash = await hashRunnerCredential(secret);
  let results: Awaited<ReturnType<D1Database["batch"]>>;
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO compute_runners
             (id, name, pool, cores, memory_mb, gpus, scratch_gb, backend, runtimes, arch, accounting,
              site, trust, secret_hash, registered_by)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, u.id
             FROM users u WHERE u.id = ? AND ${OWNER_STANDING_SQL}`,
        )
        .bind(
          runnerId,
          body.name,
          body.pool,
          body.cores,
          body.memory_mb,
          body.gpus,
          body.scratch_gb,
          body.backend,
          JSON.stringify(body.runtimes),
          body.arch,
          body.accounting,
          body.site,
          body.trust,
          secretHash,
          ownerId,
        ),
      // The shape of the event and the key that made it: never the secret, its hash, the name or the site.
      // Written only if the row was (`changes() > 0`).
      db
        .prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL)
        .bind(
          ...auditLogParams({
            userId: ownerId,
            action: "compute.runner.registered",
            resourceType: "compute_runner",
            resourceId: runnerId,
            details: JSON.stringify({
              pool: body.pool,
              backend: body.backend,
              accounting: body.accounting,
              trust: body.trust,
              key_id: keyId,
            }),
          }),
        ),
    ]);
  } catch (err) {
    if (
      /UNIQUE constraint failed: compute_runners\.name|compute_runners_live_name/.test(String(err))
    ) {
      throw new RunnerNameTaken();
    }
    throw err;
  }
  if ((results[0]?.meta?.changes ?? 0) === 0) throw new RunnerOwnerNotStanding();
  return { runnerId, secret };
}

/** The registrations, newest first, without a hash. At most `limit`. */
export async function listRunners(db: D1Database, limit = 200): Promise<RunnerRow[]> {
  const res = await db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM compute_runners ORDER BY registered_at DESC, id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<RunnerRow>();
  return res.results;
}

/** One registration without its hash, revoked or not; null when there is none. */
export async function getRunner(db: D1Database, id: string): Promise<RunnerRow | null> {
  if (!RUNNER_ID_RE.test(id)) return null;
  return db
    .prepare(`SELECT ${VIEW_COLUMNS} FROM compute_runners WHERE id = ?`)
    .bind(id)
    .first<RunnerRow>();
}

// --- Exchange and access ---------------------------------------------------------------------------

/** The live registration a secret belongs to, or null for an unknown or revoked secret (one answer). */
export async function findRunnerBySecret(
  db: D1Database,
  secret: string,
): Promise<{ id: string } | null> {
  return db
    .prepare(
      `SELECT r.id FROM compute_runners r JOIN users u ON u.id = r.registered_by
        WHERE r.secret_hash = ? AND r.revoked_at IS NULL AND ${OWNER_STANDING_SQL}`,
    )
    .bind(await hashRunnerCredential(secret))
    .first<{ id: string }>();
}

/** SQLite's text form of a timestamp as the protocol's UTC form: `2026-11-13 12:00:00` to `...T12:00:00Z`. */
export const toProtocolTimestamp = (sqlite: string): string => `${sqlite.replace(" ", "T")}Z`;

/**
 * Buy an access token with a runner's secret: ONE token row, valid for `RUNNER_ACCESS_TOKEN_SECONDS` on
 * D1's clock, then the runner's expired tokens are dropped and `last_seen_at` and `runner_version` are
 * written. All in one batch, and the token is inserted only `FROM` a registration that is still live, so a
 * revoke, or an owner's cascade, that lands between the lookup and this batch leaves no token (null: the
 * same answer as an unknown secret). The token is returned once and only its hash is stored.
 */
export async function exchangeRunnerSecret(
  db: D1Database,
  runnerId: string,
  runnerVersion: string,
): Promise<{ accessToken: string; expiresAt: string } | null> {
  const accessToken = newRunnerCredential(RUNNER_ACCESS_PREFIX);
  const hash = await hashRunnerCredential(accessToken);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO compute_runner_tokens (token_hash, runner_id, expires_at)
         SELECT ?, r.id, datetime('now', '+${RUNNER_ACCESS_TOKEN_SECONDS} seconds')
           FROM compute_runners r JOIN users u ON u.id = r.registered_by
          WHERE r.id = ? AND r.revoked_at IS NULL AND ${OWNER_STANDING_SQL}`,
      )
      .bind(hash, runnerId),
    db
      .prepare(
        "DELETE FROM compute_runner_tokens WHERE runner_id = ? AND expires_at <= datetime('now')",
      )
      .bind(runnerId),
    db
      .prepare(
        `UPDATE compute_runners SET last_seen_at = datetime('now'), runner_version = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(runnerVersion, runnerId),
    db.prepare("SELECT expires_at FROM compute_runner_tokens WHERE token_hash = ?").bind(hash),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return null;
  const expires = (results[3]?.results?.[0] as { expires_at?: string } | undefined)?.expires_at;
  if (typeof expires !== "string") return null;
  return { accessToken, expiresAt: toProtocolTimestamp(expires) };
}

export type RunnerAccess =
  | { kind: "ok"; runner: RunnerPrincipal }
  | { kind: "unknown" }
  | { kind: "expired" };

/** The columns {@link resolveRunnerAccess} selects, and no others. */
type AccessRow = Pick<
  RunnerRow,
  | "id"
  | "name"
  | "pool"
  | "cores"
  | "memory_mb"
  | "gpus"
  | "scratch_gb"
  | "backend"
  | "runtimes"
  | "arch"
  | "accounting"
  | "site"
  | "trust"
  | "revoked_at"
> & { live: number };

/**
 * What an access token is: the principal of an unexpired token of an unrevoked registration whose owner
 * still stands, `expired` for a token past its end, and `unknown` for everything else (never issued, deleted
 * by a revoke, a token whose registration is revoked, or an owner who is no longer an approved, undeleted
 * owner). Judged on D1's clock, in the lookup's own statement.
 */
export async function resolveRunnerAccess(db: D1Database, token: string): Promise<RunnerAccess> {
  const row = await db
    .prepare(
      `SELECT r.id, r.name, r.pool, r.cores, r.memory_mb, r.gpus, r.scratch_gb, r.backend, r.runtimes,
              r.arch, r.accounting, r.site, r.trust, r.revoked_at,
              (t.expires_at > datetime('now')) AS live
         FROM compute_runner_tokens t
         JOIN compute_runners r ON r.id = t.runner_id
         JOIN users u ON u.id = r.registered_by
        WHERE t.token_hash = ? AND ${OWNER_STANDING_SQL}`,
    )
    .bind(await hashRunnerCredential(token))
    .first<AccessRow>();
  if (!row || row.revoked_at !== null) return { kind: "unknown" };
  if (row.live !== 1) return { kind: "expired" };
  return {
    kind: "ok",
    runner: {
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
    },
  };
}
