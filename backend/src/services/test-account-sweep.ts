/**
 * Daily sweep of the accounts the live integration tests leave behind (#1789).
 *
 * The live-backend suites (`test/auth-device-cli-live.test.ts`, `test/auth-device-flow.test.ts`,
 * `test/auth-passwordless.test.ts`) seed a NEW account per run with a generated address and
 * nothing removes it, so the staging users page filled with hundreds of them and buried the
 * real ones. This sweep tombstones them, with the SAME statements as the owner-only
 * `DELETE /admin/users/by-id/:id` (`tombstoneUserCascade`): the PII mask, the `deleted_at`
 * stamp, every key, session and grant ended.
 *
 * WHY THIS IS SAFE TO RUN ON A DATABASE THAT SHARES REAL PEOPLE (AGENTS.md, "Dev D1 shares
 * production users"). An account is swept only when ALL of these hold at the candidate read:
 *   - the address is exactly one of the generated shapes ({@link GENERATED_TEST_ACCOUNT_EMAIL}:
 *     anchored, case-sensitive, a closed character set): the three `<prefix>-<label>-<clock>-
 *     <random>` shapes at the reserved `@nemar.test` domain, and the one `pl-gate-<clock>-
 *     <random>` shape the passwordless suite seeds at `@example.com`. Both domains are
 *     reserved by the IANA (RFC 2606), so neither can be a real person's mailbox, and the
 *     seeded fixtures (`test-user@nemar.test` and the rest) match no shape;
 *   - `signup_source = 'web'` (the live tests seed web accounts), `account_kind` is not
 *     `service`, `role` is `member`, no legacy IAM user;
 *   - not already tombstoned, and created more than {@link TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS} days ago;
 *   - it owns nothing: no dataset, no collaboration, no publication request, no pending access
 *     request, no open upload-access request and no granted upload access. An account that
 *     asked for or holds anything somebody might still act on is left for a human.
 *
 * WHAT IS RE-CHECKED BEFORE THE WRITE, exactly. The regular expression is re-run in code on the
 * row's own address, and the write itself is conditional: the mask requires the row to still
 * carry that same address and to be not yet tombstoned, and every other statement of the
 * cascade requires the mask to have applied to the row (`tombstoneUserCascade`'s `onlyIfEmail`).
 * The other terms above are evaluated once, in the candidate SELECT, a few statements before
 * the write, and are not repeated; a row that changed in that window in any way but its
 * address is still tombstoned. A row the write did not change is counted as `skipped`.
 *
 * THE DISCRIMINATOR IS NOT `account_kind = 'test'`. The issue proposed it, but the live tests
 * seed through `POST /admin/test-fixtures/seed-web-user` WITHOUT a `kind`, so these accounts are
 * `person` (the column default), and they cannot be `test`: the device flow they exercise
 * refuses every non-`person` account (`services/device-auth.ts`). The address shape is what is
 * true of them and of no real account; `service` is excluded so an operational account can
 * never match, and `person` and `test` both pass so a later change to how the suites seed does
 * not silently stop the sweep.
 *
 * NO NETWORK. The route also removes GitHub collaborators and revokes legacy IAM keys; the
 * `nemarDatasets` org is shared between production and dev, so this sweep does neither. It
 * does not need to: the predicate excludes an account with an IAM user or any collaboration,
 * which leaves nothing for those two steps to do.
 *
 * PRODUCTION: never. The guard is repeated here (fail-closed, so an unset or mistyped
 * `ENVIRONMENT` counts as production) and at the call site in `scheduledCleanup`.
 *
 * BOUNDED. At most {@link TEST_ACCOUNT_SWEEP_BATCH} accounts per run, oldest first, so a backlog
 * clears over several daily runs rather than in one long Worker invocation. Failed tombstones
 * count toward that bound. Two ceilings follow, both visible in the audit row (`examined` at
 * {@link TEST_ACCOUNT_SWEEP_SCAN_CAP} or `errors` at the batch size, with `tombstoned` at zero,
 * means a stalled sweep): a run reads at most the scan cap of candidate rows, and every run
 * starts from the lowest id again, so more look-alike rows that pass the SQL prefilter but fail
 * the regex than the cap, or as many persistently failing rows as the batch, at the lowest ids
 * would stop progress until someone clears them. Neither occurs today; a persisted cursor was
 * judged more machinery than the case deserves.
 *
 * AUDIT. One aggregate tally per run, in the `scheduled_cleanup` row; no per-account row.
 * That was a decision, not an omission: the tombstone erases the address, the ids are
 * unremarkable, and a per-account row for hundreds of test accounts would bury the audit log
 * the way these accounts buried the users page. It logs counts only, never an address.
 */

import { tombstoneUserCascade } from "../db/user-tombstone.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";

/** Accounts one run may tombstone. Oldest first; the rest wait for the next daily run. */
export const TEST_ACCOUNT_SWEEP_BATCH = 100;

/** An account younger than this is left alone, so a run in progress is never cut from under. */
export const TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS = 7;

/**
 * Candidate rows one run may READ in total, whatever the pattern does with them, so the
 * scan cannot run without end. Look-alike rows (prefilter yes, pattern no) occupy this
 * window; see the BOUNDED paragraph of the module comment for the ceiling that implies.
 */
export const TEST_ACCOUNT_SWEEP_SCAN_CAP = TEST_ACCOUNT_SWEEP_BATCH * 10;

/**
 * The generated shapes. The live suites build
 * `<prefix>-<label>-<Date.now()>-<Math.random().toString(36).slice(2, 8)>@nemar.test`
 * (prefix `dcli`, `df` or `pl`; a label of lower-case letters and digits joined by hyphens; a
 * 13-digit millisecond clock; one to six base-36 characters), and the passwordless suite's
 * "non-allowlisted member" test seeds `pl-gate-<clock>-<random>@example.com` the same way
 * with a fixed label. Anchored at both ends, no `i` and no `m` flag: an upper-case rendering,
 * a trailing newline or a longer domain does not match.
 *
 * Not matched, on purpose: `mask-<clock>@example.test` and `ec-real-<clock36>@example.com`
 * in the same suite are only ever REQUESTED, never seeded (no users row exists), so there
 * is nothing to sweep.
 */
export const GENERATED_TEST_ACCOUNT_EMAIL =
  /^(?:(?:dcli|df|pl)-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{13}-[a-z0-9]{1,6}@nemar\.test|pl-gate-[0-9]{13}-[a-z0-9]{1,6}@example\.com)$/;

/**
 * Candidate accounts after `id > ?`, oldest first (ids are AUTOINCREMENT, so id order is
 * creation order). The two GLOB pairs narrow the scan to a generator prefix and a generator
 * domain; they are NOT the decision, the regular expression is, and it runs on every row
 * returned.
 *
 * EVERY LIKE AND GLOB PATTERN HERE IS A SHORT LITERAL, ON PURPOSE. D1 refuses a pattern over
 * 50 bytes (`LIKE or GLOB pattern too complex`) and bun:sqlite does not. The first version
 * spelled each whole shape as one GLOB (83 to 87 bytes, a character class per clock digit):
 * every bun:sqlite test passed and on D1 the candidate read threw, so the sweep never
 * tombstoned anything. The patterns are literals rather than bound values so that
 * `test-account-sweep.test.ts` can read their lengths out of this text, and
 * `test-account-sweep-d1.test.ts` runs the query on D1's own engine.
 *
 * The cost of the short patterns is a weaker prefilter: any `dcli-`, `df-` or `pl-` local part
 * at either domain reaches the regex, not only the right clock shape. Those look-alikes
 * (the fixed `pl-profile-patch@nemar.test` and the like) are skipped in code, counted in
 * `skipped`, and occupy the scan window described in the BOUNDED paragraph above; there are
 * a handful, against a window of {@link TEST_ACCOUNT_SWEEP_SCAN_CAP} rows.
 */
export const TEST_ACCOUNT_SWEEP_CANDIDATES_SQL = `SELECT id, email FROM users
  WHERE id > ?
    AND deleted_at IS NULL
    AND (email GLOB 'dcli-*' OR email GLOB 'df-*' OR email GLOB 'pl-*')
    AND (email GLOB '*@nemar.test' OR email GLOB '*@example.com')
    AND signup_source = 'web'
    AND account_kind IN ('person', 'test')
    AND COALESCE(role, 'member') = 'member'
    AND aws_iam_username IS NULL
    AND aws_access_key_id_encrypted IS NULL
    AND service_access = 0
    AND upload_access_requested_at IS NULL
    AND created_at < datetime('now', ?)
    AND NOT EXISTS (SELECT 1 FROM datasets d WHERE d.owner_user_id = users.id)
    AND NOT EXISTS (SELECT 1 FROM dataset_collaborators c WHERE c.user_id = users.id)
    AND NOT EXISTS (SELECT 1 FROM publication_requests r WHERE r.requested_by = users.id)
    AND NOT EXISTS (
      SELECT 1 FROM access_requests a WHERE a.user_id = users.id AND a.status = 'pending'
    )
  ORDER BY id
  LIMIT ?`;

export interface TestAccountSweepResult {
  /** False when the production guard refused the run; nothing was read or written. */
  ran: boolean;
  /** Candidate rows read. */
  examined: number;
  tombstoned: number;
  /** Candidates left whole: the pattern rejected them, or the write found the row changed. */
  skipped: number;
  /** Tombstones or candidate reads that failed (a failed row is left whole and retried). */
  errors: number;
}

/** The tally of a run that did not happen. Spread it; do not share the object. */
export const TEST_ACCOUNT_SWEEP_NOT_RUN: Readonly<TestAccountSweepResult> = Object.freeze({
  ran: false,
  examined: 0,
  tombstoned: 0,
  skipped: 0,
  errors: 0,
});

/**
 * Tombstone up to {@link TEST_ACCOUNT_SWEEP_BATCH} of the live tests' accounts. See the module
 * comment for the predicate and why it cannot reach a real address. Does nothing outside a
 * recognized non-production environment. Never throws: a failed candidate read ends the run
 * with `errors` set and the tally of what was already done kept.
 */
export async function sweepCiTestAccounts(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
): Promise<TestAccountSweepResult> {
  // Repeated from the call site on purpose: the guarantee must not depend on who calls this.
  if (!isNonProductionEnv(env)) return { ...TEST_ACCOUNT_SWEEP_NOT_RUN };

  const db = env.DB;
  const result: TestAccountSweepResult = { ...TEST_ACCOUNT_SWEEP_NOT_RUN, ran: true };
  const age = `-${TEST_ACCOUNT_SWEEP_MIN_AGE_DAYS} days`;
  const spent = () => result.tombstoned + result.errors;
  let afterId = 0;

  try {
    while (spent() < TEST_ACCOUNT_SWEEP_BATCH && result.examined < TEST_ACCOUNT_SWEEP_SCAN_CAP) {
      const page = await db
        .prepare(TEST_ACCOUNT_SWEEP_CANDIDATES_SQL)
        .bind(afterId, age, TEST_ACCOUNT_SWEEP_BATCH)
        .all<{ id: number; email: string }>();
      const rows = page.results ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        if (spent() >= TEST_ACCOUNT_SWEEP_BATCH) break;
        afterId = row.id;
        result.examined++;
        // The decision. Re-verified here, on the row's own address, immediately before the write.
        if (!GENERATED_TEST_ACCOUNT_EMAIL.test(row.email)) {
          result.skipped++;
          continue;
        }
        try {
          // The write is conditional on the same address (see the module comment).
          const done = await tombstoneUserCascade(db, row.id, row.email, row.email);
          if (done.tombstoned) result.tombstoned++;
          else result.skipped++;
        } catch (err) {
          result.errors++;
          // The id is a non-PII integer; the address is never logged.
          console.error(
            `[test-account-sweep] tombstone failed for id=${row.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  } catch (err) {
    // A candidate read failed. Keep what the run already did and say it failed.
    result.errors++;
    console.error(
      "[test-account-sweep] candidate read failed:",
      err instanceof Error ? err.message : err,
    );
  }

  console.log(
    `[test-account-sweep] examined=${result.examined} tombstoned=${result.tombstoned} skipped=${result.skipped} errors=${result.errors}`,
  );
  return result;
}

/**
 * The cleanup job's section for this sweep: the whole of what `scheduledCleanup` does with it,
 * extracted so it can be run for real. Returns the tally the audit row carries as
 * `testAccountSweep`: the sweep's own tally, or "did not run" in production. The environment
 * guard is here as well as at the call site, as it is in the sweep.
 */
export async function cleanUpLiveTestAccounts(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
): Promise<TestAccountSweepResult> {
  if (!isNonProductionEnv(env)) return { ...TEST_ACCOUNT_SWEEP_NOT_RUN };
  return sweepCiTestAccounts(env);
}
