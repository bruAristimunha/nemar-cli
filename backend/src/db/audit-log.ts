// Canonical audit_log insert, shared by every route that writes an audit row.
// Before #903 the codebase carried several hand-rolled INSERT shapes (5-column
// and a drifted 3-column `(action, user_id, details)` variant); this module is
// the single shape call sites converge on as they move during the #902 split.
// resource_type / resource_id / details are nullable in the schema (migration
// 0001), so a null-filled 5-column insert is row-identical to the legacy
// 3-column one.

export interface AuditLogEntry {
  /** Acting user's id; null for system-initiated actions with no user. */
  userId: number | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Free-form context, conventionally a JSON string. */
  details?: string | null;
}

export const AUDIT_LOG_INSERT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
   VALUES (?, ?, ?, ?, ?)`;

/**
 * Upper bound, in UTF-8 bytes, on an audit row's `details` payload (#1189).
 *
 * The D1 backup renders each row as one INSERT statement, and D1 refuses to
 * execute a statement over ~100 KB on restore (SQLITE_TOOBIG, #1188) -- so an
 * unbounded `details` column is a row that can be written but never restored.
 * 16 KB leaves a wide margin under that limit even after the backup's SQL
 * quote-escaping (worst case doubles the payload), while being far above any
 * legitimate summary payload: an audit row carries flags, counts, and a
 * pointer to the artifact that owns the detail, not the detail itself.
 */
export const AUDIT_DETAILS_MAX_BYTES = 16_384;

/** Characters of an oversized payload kept in the truncation marker -- enough
 *  to expose a JSON payload's leading summary fields for identification. */
const AUDIT_DETAILS_HEAD_CHARS = 2_000;

/**
 * Bound a `details` payload to {@link AUDIT_DETAILS_MAX_BYTES}: a payload at
 * or under the limit passes through untouched; an oversized one is replaced
 * by a small JSON marker recording that it was dropped, its original size,
 * and its head. This is deliberately lossy -- by the time a payload is this
 * large it is per-file detail that belongs in the artifact that owns it
 * (see #1189), and preserving it here is what made the backup unrestorable.
 */
export function boundAuditDetails(details: string | null): string | null {
  if (details === null) return null;
  const bytes = new TextEncoder().encode(details).byteLength;
  if (bytes <= AUDIT_DETAILS_MAX_BYTES) return details;
  return JSON.stringify({
    audit_details_truncated: true,
    original_bytes: bytes,
    head: details.slice(0, AUDIT_DETAILS_HEAD_CHARS),
  });
}

/**
 * Positional params for AUDIT_LOG_INSERT_SQL. Exported separately so the
 * behavioral test can run the production SQL + marshaling against bun:sqlite
 * (same approach as user-tombstone.ts, whose test uses a different driver API
 * than D1).
 *
 * `details` is bounded here, in the shared marshaling, rather than at call
 * sites: every write through auditLogStatement inherits the bound, so the
 * next unbounded payload shape cannot silently recreate #1188.
 */
export function auditLogParams(
  entry: AuditLogEntry,
): [number | null, string, string | null, string | null, string | null] {
  return [
    entry.userId,
    entry.action,
    entry.resourceType ?? null,
    entry.resourceId ?? null,
    boundAuditDetails(entry.details ?? null),
  ];
}

/**
 * The audit insert as a bound D1 statement. Wrapping it hides the positional
 * bind order so a call site can't transpose columns (the pre-#903 drift).
 * Returns the statement without running it: call sites keep their own
 * execution semantics (`await .run()`, `executionCtx.waitUntil`, or batch).
 */
export function auditLogStatement(db: D1Database, entry: AuditLogEntry): D1PreparedStatement {
  return db.prepare(AUDIT_LOG_INSERT_SQL).bind(...auditLogParams(entry));
}

/**
 * The audit insert that only happens if the statement before it changed a row.
 * `changes()` reads the previous statement's effect inside the same batch, so an
 * UPDATE that matched nothing (the account was deleted after it was read)
 * leaves no audit row claiming an edit that did not happen.
 */
export const AUDIT_IF_PREVIOUS_CHANGED_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
   SELECT ?, ?, ?, ?, ? WHERE changes() > 0`;

/**
 * Run `update` and, only if it changed a row, its audit row, as one batch.
 * Returns whether the update applied. Exported so the "matched nothing" case,
 * which a request cannot reach on a single-writer test engine, is tested on the
 * exact statements the route runs.
 */
export async function applyEditWithAudit(
  db: D1Database,
  update: D1PreparedStatement,
  audit: AuditLogEntry,
): Promise<boolean> {
  const results = await db.batch([
    update,
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(...auditLogParams(audit)),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}
