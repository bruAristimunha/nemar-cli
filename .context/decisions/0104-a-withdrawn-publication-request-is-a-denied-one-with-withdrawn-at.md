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
3. The owner withdraws with `POST /datasets/:id/publish/withdraw`, one conditional UPDATE. It is allowed only while nothing has started acting on the request, and that is three conditions on the row: the status is `requested` or `blocked`, no approval is in flight, and publishing has not started. Publishing has started when `steps_completed` holds a step outside the validation-only ones (`hasStartedPublishing`) or `current_step` names one (a run cut off inside its first public step has recorded nothing yet and may still have changed the data). A request keeps its steps when a run is walked back to `blocked` or `requested`, so the status alone does not say whether the data is public. The answer to any of the three is 409 `withdraw_too_late`. The UPDATE carries all three conditions again, and an `updated_at` guard against a lost race, so a withdrawal and an approval or a denial that race cannot both succeed, and the loser sends nothing (what each loser is told, and what the withdrawal clears, is in the 2026-10-15 amendment below). The other writers that end or start a request are guarded the same way (the administrator's deny, the orchestrator's mark-approving write).
4. A writer that ends a request must guard on the request still being active and check the number of rows changed.
5. A withdrawal writes one `audit_log` row in the same batch as the status write: `publication_request_withdrawn`, resource type `dataset`, the dataset id as the resource, the owner as the user, and the request id in the details. The row is written only if the UPDATE changed a row, so a refused or lost withdrawal leaves none.
6. Only the dataset owner may withdraw, although an administrator may file a publication request on someone else's dataset. This is deliberate and unchanged: the withdrawal is the depositor taking back their own act, and an administrator ends a request with `deny`, which records who and why. The route answers 403 and says so, and so does the CLI help.

## Consequences

- A withdrawal is invisible to every reader that only knows `denied`; the administrator's list and the depositor's status say "withdrawn" from `withdrawn_at`.
- Administrators are not mailed on a withdrawal. A request simply leaves the active list. The audit row is the record.
- The dataset's staleness clock treats a withdrawn request like a denied one: there is no pending request.
- A request that has started publishing cannot be withdrawn by its owner at any status; an administrator decides what happens to it.
- A future writer of `status` on this table must keep the guard in 4.

## Amendment 2026-10-15 (#1726): what the integrated epic found in decision 3

Three reviews of the epic branch read decision 3 against the built routes.
Decision 3's sentence about the loser was written before the deny route and the approval route had their own refusals,
and the withdrawal's write grew a clause.
The text above was corrected in place only where it named the loser; this amendment states what is true now.
Where the two differ, this is the later text.

1. **The loser of a race with a withdrawal is told by its own route, and the word is not always 409.**
   - A withdrawal that loses (an approval is in flight, publishing has started, or another writer moved the request) is 409 `withdraw_too_late`, as decision 3 says.
   - An approval that loses to a withdrawal is 409 `request_changed`, because its conditional mark finds a request that is no longer active.
     The sentence of that refusal names a withdrawal beside a denial and a block (`REQUEST_CHANGED_MESSAGE`); it used to say only "denied or blocked", which read as a fault of the administrators' own making.
   - A denial that loses to a withdrawal is 404 `No active publication request found`, not 409.
     The deny route reads the request again after a lost write and answers by what it finds, and a withdrawn request is a denied one that is no longer active (decision 1), so the answer is the one for no active request.
     No denier and no reason are recorded on a withdrawn row, and a test holds that.
2. **A withdrawal clears a lapsed claim.**
   The withdrawal's UPDATE sets `APPROVAL_CLAIM_CLEAR_SQL`, as every statement that ends a request does.
   Decision 3 allows a withdrawal only when no approval is in flight, but a claim whose lease has lapsed is still on the row, and it would otherwise stay on a request that has ended.
   A token that verified for that claim then fails on the next call (ADR 0105, decision 1: clearing the claim is the revocation).
3. **The two statements of "publishing has started" are held together by a test.**
   Decision 3 states the rule once as `publishingHasStarted` and once as terms of the UPDATE (`NO_PUBLISHING_STARTED_SQL`).
   They agree on every well-formed row.
   On a `steps_completed` that is valid JSON but not an array of strings, the SQL counts the request as started and the function does not, so the statement only ever refuses where the function would allow.
   It is not aligned the other way, because `hasStartedPublishing` also decides which gates a resumed run may skip, and counting an unreadable row as started there would widen an exemption.
