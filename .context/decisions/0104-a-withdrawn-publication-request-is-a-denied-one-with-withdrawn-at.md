# ADR 0104: A withdrawn publication request is a denied one with `withdrawn_at`

**Status:** accepted
**Date:** 2026-10-14
**Owner:** Seyed Yahya Shirazi

## Context

A depositor could not take a publication request back; only an administrator could end it.
`publication_requests.status` is guarded by a CHECK constraint (`requested`, `approving`, `published`, `denied`, `blocked`), and several readers ask whether a request is finished with `status NOT IN ('published', 'denied')` or `status IN ('requested', 'approving', 'blocked')`: the re-request path, the staleness cron, the dataset delete guard and the publication sweep.

## Decision

1. A withdrawal is stored as `status = 'denied'` with a nullable `withdrawn_at` (migration 0097). `denied_by` and `denied_reason` stay NULL. The CHECK is not widened: that would rebuild a table of about thirty columns, and every reader above would have to learn a sixth status.
2. Anything that must tell the two endings apart reads `withdrawn_at` together with `status = 'denied'`. The status route reports `withdrawn` only for a denied row. This is a guard, not a revival path: a later `publish request` matches only active statuses and inserts a NEW row, so a withdrawn row stays withdrawn and no current writer sets `withdrawn_at` on a live row. The status term keeps a future writer that did revive a row from being read as a withdrawal.
3. The owner withdraws with `POST /datasets/:id/publish/withdraw`, one conditional UPDATE. It is allowed only while nothing has started acting on the request, and that is three conditions on the row: the status is `requested` or `blocked`, no approval is in flight, and publishing has not started. Publishing has started when `steps_completed` holds a step outside the validation-only ones (`hasStartedPublishing`) or `current_step` names one (a run cut off inside its first public step has recorded nothing yet and may still have changed the data). A request keeps its steps when a run is walked back to `blocked` or `requested`, so the status alone does not say whether the data is public. The answer to any of the three is 409 `withdraw_too_late`. The UPDATE carries all three conditions again, and an `updated_at` guard against a lost race, so a withdrawal and an approval or a denial that race cannot both succeed: the loser answers 409 and sends nothing. The other writers that end or start a request are guarded the same way (the administrator's deny, the orchestrator's mark-approving write).
4. A writer that ends a request must guard on the request still being active and check the number of rows changed.
5. A withdrawal writes one `audit_log` row in the same batch as the status write: `publication_request_withdrawn`, resource type `dataset`, the dataset id as the resource, the owner as the user, and the request id in the details. The row is written only if the UPDATE changed a row, so a refused or lost withdrawal leaves none.
6. Only the dataset owner may withdraw, although an administrator may file a publication request on someone else's dataset. This is deliberate and unchanged: the withdrawal is the depositor taking back their own act, and an administrator ends a request with `deny`, which records who and why. The route answers 403 and says so, and so does the CLI help.

## Consequences

- A withdrawal is invisible to every reader that only knows `denied`; the administrator's list and the depositor's status say "withdrawn" from `withdrawn_at`.
- Administrators are not mailed on a withdrawal. A request simply leaves the active list. The audit row is the record.
- The dataset's staleness clock treats a withdrawn request like a denied one: there is no pending request.
- A request that has started publishing cannot be withdrawn by its owner at any status; an administrator decides what happens to it.
- A future writer of `status` on this table must keep the guard in 4.
