# ADR 0103: A pending account cannot hold a verified email

**Status:** accepted
**Date:** 2026-10-13
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0040 makes `verified` the base tier: the inbox is proved, and proving it is what moves an account out of `pending`.
The email-change route (`/auth/email/change/verify`) proved the new inbox and stamped `email_verified = 1`, but never moved the status.
A web sign-up that changed its address before verifying was left `pending` with a verified email.
`/auth/email/verify` then answered `already_verified` and no other road left `pending`, so the account could not be promoted by its owner.
Approval accepted such a row because it only checks `email_verified`, which is how an admin got one out by accident.

## Decision

1. The email-change write goes through `applyEmailVerification`, the one transition from `pending` to `verified`, in the same batch as the address update.
2. Migration 0096 promotes every live `pending` row that already has `email_verified = 1` (one `email_verified` audit row each, `via` set to `migration_0096`), and installs a trigger that aborts any UPDATE leaving a live row `pending` with `email_verified = 1`.
3. A new writer of `email_verified` must go through `applyEmailVerification`, or set both columns itself in one statement.
4. An owner can force-verify a `pending` account (`POST /admin/users/by-id/:id/verify`, `nemar admin verify <id>`, owner only). It uses the same transition and grants no upload access; two audit rows record it, the transition (`via: owner_override`) and `email_verified_by_owner`, which names the owner. It exists so that an owner who would otherwise edit the database by hand has a path that cannot leave a half-written row. Approve and revoke remain the only writers of upload access.

## Consequences

- The next route that forgets the transition fails in its own batch with a clear message, not silently days later.
- Between the migration and the Worker deploy, the previous Worker's email-change would abort for a pending account and answer `email_change_incomplete` with the code restored; it succeeds after the deploy.
- The trigger is on UPDATE only; an INSERT of that shape is not a transition and no route writes one.
- Test fixtures that force a row to `pending` must also clear `email_verified`, and the non-production seed endpoint does.
- Upload access is unchanged: `service_access` still has one writer, admin approval.
