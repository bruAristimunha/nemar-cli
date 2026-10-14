# ADR 0080: A web approval is dispatched to an executor; the backend route is the contract, and the approver is whoever clicked

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Seyed Yahya Shirazi

Partially superseded by [ADR 0103](0103-a-web-approval-is-attributed-by-a-per-claim-dispatch-token-and-a-terminal-approval-takes-the-claim-over.md),
proposed with epic #1726 Phase 3 (#1730).
It replaces the fork of decision 5, under which the approver was the clicker for any call that arrived inside the claim's lease, a person's terminal included,
with a per-claim dispatch token that the executor presents on every `/approve` call.
With it, the cost that decision 5 accepted is replaced (a terminal approval inside a live lease recorded as the clicker, #1604),
and so is the consequence that a web run quiet past its lease is recorded under the executing key: it is now refused.
Decisions 2 (the Origin rule), 3 (the payload) and 6 (the list of failures that are definitely not sent) are corrected in place to match,
and four of the consequences are rewritten.
The verdict of decision 6 stands: a dispatch whose answer is lost keeps the lease.

**The rest of decision 5 is NOT superseded and still governs:**
the time-only lease read for attribution, the re-check of the clicker's role and status at each use,
and the claim cleared when the owner-name gate walks the request back to `blocked`.
Decisions 1 and 4 are untouched.
The replaced wording of decision 5 and of the accepted cost is kept, verbatim, in the dated amendment at the end,
so that the earlier verdict stays findable.

## Context

Approving a publication is not one request.
`POST /admin/publish/:id/approve` runs the sixteen-step orchestrator,
and its S3 Object Lock step (step 14, after the irreversible `publish_doi`)
works in batches of 100 objects: each call locks one page and returns `hasMore`
with a continuation token that the CALLER must send back.
The CLI drives that loop, with retries across fresh Worker invocations and `--resume`.
That is deliberate: running the whole loop inside Cloudflare Workers would cost more
than the platform should spend on it, so the work lives with the caller.

The website's Approve button sent one `{}` and reloaded.
For any dataset over 100 files that stops at `approving`, after the DOI is public:
the repository is public and the DOI published, but nothing is locked,
the catalog is not synced and the owner is not told,
and an `approving` row offers no button to continue from.
(Until the list page was fixed it also crashed on any row, so the button could not be reached.
Fixing the page is what made this reachable.)
"Do not close the page" would not have been a fix: the page is not what finishes the run.

Web approvals are going to matter more, so they need a stable pipeline of their own.
Two constraints shape it.
The backend route has to stay the contract, so that no single executor becomes a dependency of the platform.
And a web click and a terminal approval must both be recorded truthfully,
which a service-key executor would otherwise erase: it would be the "approver" of every web approval.

## Decision

The website does not run an approval. It asks the backend to dispatch one.

1. **`/approve` stays the contract, and the loop stays on the caller's side.**
   An executor is anything that drives `/approve` to completion: a person's terminal,
   or a runner. Its request and response contract is unchanged.
   (The orchestrator now reads `approval_requested_by` from the request it acts on,
   and starts each attempt by clearing `last_error`; neither is visible to a caller.)
2. **`POST /admin/publish/:id/approve-dispatch` is the web entry.**
   It claims the request with one conditional UPDATE, records the clicking admin,
   dispatches `repository_dispatch[approve-publication]` to `nemarDatasets/.github`,
   and answers 202.
   Today the one executor behind it is a workflow in that repository that runs
   `nemar admin publish approve` on a GitHub runner, the same pattern as `onboard-openneuro.yml`.
   `nemaring.ucsd.edu` is not an executor: it hosts other services and stays that way.
   The only code that knows GitHub is `triggerApprovePublication`; the route, the claim and the
   lease are executor-agnostic, so a second executor changes the dispatch and nothing else.
   A cookie request needs a NEMAR `Origin` (`origin_not_allowed`), because the route launches an
   irreversible publication; a bearer key, which a terminal and the workflow use, is not asked for one.
   Since ADR 0103 this is not the route's own check: one guard on the admin router applies the same
   rule to every unsafe admin route.
3. **The payload names an environment, never a URL, and carries no credential that authorizes anything.**
   `{ dataset_id, request_id, resume, environment, dispatch_token }`, where `environment` is `production`
   only for the production Worker and `dev` for everything else, including an unset value.
   The `dispatch_token` is the claim's attribution token (decision 5, ADR 0103): it proves that a call
   belongs to this click and authorizes nothing alone.
   The central repository is shared by every environment, so the workflow maps the name to an API
   origin and a secret from a table of its own, and an admin key cannot be steered to a host the payload chose.
4. **A lease keeps it to one run at a time.**
   A request is in flight when it can still run (`requested` or `approving`) and either it was
   dispatched within 15 minutes, or it is `approving` with an `updated_at` within 15 minutes.
   The second clause is what lets a person's terminal run block a web launch,
   since a terminal approval never sets `approval_dispatched_at`.
   One SQL expression (`approvalInFlightSql`) is both the claim's WHERE clause and the list route's
   `approval_in_flight` field, so a page never offers a button the route would refuse
   and no client hard-codes the minutes.
   **A run that failed stalls after a grace window, not at once.**
   The orchestrator records a failed step in `last_error`; the run then counts as in flight for 60 seconds
   and as stalled after that, so the page can offer Resume without waiting out the lease.
   Not at once, because the CLI retries a failed step after 10 seconds (up to five times), and an executor
   launched in that wait would run beside the retry about to start; a test holds the grace above the CLI's
   exported retry delay. The dispatch claim and the start of every `/approve` attempt clear `last_error`
   (the previous attempt's error is history), so a restart or a fresh dispatch is in flight again at once,
   and a dispatch that is not sent puts the error back.
5. **Attribution forks, and a click is honored only while its run is live.**
   The orchestrator reads `approval_requested_by` from the request it acts on.
   For a call that presents the claim's dispatch token (decision 3, ADR 0103) while the lease is live
   (the time-only lease, read at the top of `/approve`, before that call's own heartbeat bump), that admin is the approver:
   `approved_by`, the `dataset_published` audit row and the `notify_user_failed` audit row name them,
   and the executing account is kept as `executed_by` in the details.
   Otherwise, which includes every terminal approval whatever lease is live, the caller is the approver
   and the audit row is byte-identical to what it was.
   The column is never cleared on a lapse, and the lease is what keeps a click made long ago from being honored for work done now:
   a token whose lease has lapsed is refused (409 `dispatch_expired`).
   Attribution reads the time-only lease rather than the failure-aware predicate above,
   so a failure does not strip the clicker from the retry that finishes the run.
   **The fork is on the proof, not on the lease and not on who calls.**
   A person who runs `/approve` at a terminal inside a web run's live lease presents no token, so they are recorded as themselves,
   and once the approval has passed every gate it takes the claim over:
   the claim is cleared in the statement that marks the request `approving`,
   and the web run's executor is refused at its next call (409 `dispatch_superseded`).
   A token that is stale or expired is refused, never quietly recorded as the caller.
   Telling a service key from a person would need the caller's account kind (ADR 0048),
   and an executor whose key is not marked as a service account would then lose web attribution entirely, so the fork does not read it.
   A clicker who has since been demoted below admin, revoked or deleted is not recorded either:
   the caller stands in, because the run carries on after that person's access has ended
   (whether such a click should publish at all is left open in ADR 0103).
   The claim itself is cleared when the owner-name gate walks the request back to `blocked`,
   because that run is over and a claim left on the row would read as live again once the owner re-requests.
6. **A dispatch whose answer is lost keeps the lease.**
   GitHub may have accepted the event and lost only the reply,
   and releasing the claim then would let the next click start a second run.
   The claim is released only for a failure that is definitely not sent:
   no credential (`dispatch_unconfigured`, and retrying will not help),
   a GitHub token that cannot be minted,
   a dispatch token that cannot be signed (ADR 0103: a Worker with no secret to sign with refuses before it claims anything),
   or GitHub refusing the request with a 4xx (`dispatch_failed`).
   A dropped connection, the 10 second timeout or a 5xx answer is `dispatch_unconfirmed`, and the lease stands until it lapses.
   GitHub's edge can answer 502, 503 or 504 after the event was already queued, which is the same lost answer as a dropped connection.
   Every unconfirmed answer writes an `approval_dispatch_unconfirmed` audit row (the HTTP status, never GitHub's body),
   because a run may exist that the lease alone would not explain.
   The release restores the error the claim cleared only while `updated_at` still holds the value read before the claim,
   so a run that began in between (a person's terminal) is not made to read as failed.

## Consequences

Closing the page no longer matters: the state is in `publication_requests`,
and `current_step` / `last_error` already say where a run is.
The Worker spends one GitHub call per approval; the loop's cost is on the runner.
The CLI's behavior is unchanged.

Harder, and honest about it:

- **A web run that sat quiet longer than the lease before its first `/approve` call is refused.**
  A runner queued for more than 15 minutes, or a dispatch that only starts after a long outage, does not
  run under a click made that long ago: its token's lease has lapsed, `/approve` answers 409
  `dispatch_expired` and changes nothing, and a fresh click starts a new run (ADR 0103). The dispatch's
  own `approval_dispatched` audit row still names the clicker by id.
- **A refusal before the step loop is recorded as a failure.**
  The gates after the request flips to `approving` behave differently, and only some leave a trace:
  an owner with no real name walks the row back to `blocked` with a `block_reason` and clears the web claim;
  the sandbox, no-repository, dataset-not-found and invalid-repository answers (400, 404, 500) return with the row left at `approving` and a fresh `updated_at`,
  and the answer's own sentence is written to `last_error` (ADR 0103),
  as is a fixed sentence when the GitHub token for the dataset repositories cannot be minted, an exit that is then rethrown;
  so the row reads as failed and the page offers a retry once the 60 second grace has passed,
  where before it read "running" for the lease although nothing was running.
  Every answer that comes ahead of the mark (the 426 outdated-client answer, the 404 for no request, a request that is not the one named, a blocked request, a refused token and the gates) leaves the row untouched.
  A web run's claim stands through the early exits above, for the workflow's release step to end, except where the owner-name walk-back clears it;
  a call with no token cleared the claim at the mark.
  The reason is also in the workflow's log.
- **A workflow failure the backend cannot see is reported by the workflow.** A missing secret or an install
  failure means `/approve` is never called, so it writes nothing. Since ADR 0103 the workflow's failure step
  reports through `POST /webhooks/approval-release`, authenticated by the dispatch token alone, the way the
  pre-screen workflow reports through a callback token: the claim is cleared and a fixed sentence is
  recorded as `last_error`. A workflow that does not report (an older one, or a run killed before its
  failure step) leaves the lease to lapse on its own.
- **A dispatch that GitHub never confirmed holds the lease for up to 15 minutes**, so a retry is a 409 until
  it lapses, even when the event was in fact never created. A terminal approval is not gated by the lease,
  so an admin in a hurry uses that, and it takes the claim over: the executor of the web run it displaces
  is refused at its next call (ADR 0103).
- **The web path depends on GitHub being able to start a workflow.**
  A dispatch GitHub refuses with a 4xx releases the claim and answers 502, and the terminal path is the fallback.

## Alternatives considered

- **Run the loop in the Worker** (a longer request, or `waitUntil`). Rejected on cost, which is why the
  loop is on the caller in the first place, and because a single invocation's subrequest budget is exactly
  what the batching exists to respect.
- **A queue or a Durable Object.** New infrastructure on the same platform, with the cost and lock-in
  the decision is trying to avoid.
- **The browser drives the loop**, as the CLI does. It would need the page open for the whole run, which is
  the dependency this removes, and a reload mid-run would be a second driver racing the first.
- **A pull model**, where executors claim queued approvals themselves. It would make executors fully
  interchangeable, and the claim columns would support it unchanged; it is not built because there is one
  executor and a push dispatch already exists in this repository. Revisit when there is a second.
- **Record the executor as the approver.** Simplest, and wrong: every web approval would be attributed to a bot.

## Receipts

- nemarOrg/website#200, "Approve blocks on a 16-step orchestrator; make it non-blocking".
- `shared/publication-steps.ts` for the step order; `backend/src/services/publication-orchestrator.ts` for
  the s3_lock `hasMore` return; `src/lib/api/publish.ts` (`approvePublication`) for the caller's loop.
- `nemarDatasets/.github/.github/workflows/onboard-openneuro.yml`, the precedent for running the CLI on a runner.
- Migration `0090_approval_dispatch.sql`; `backend/src/services/approval-dispatch.ts`.

## Amendment 2026-10-13 (#1730): Phase 3, a web approval is attributed by a dispatch token

[ADR 0103](0103-a-web-approval-is-attributed-by-a-per-claim-dispatch-token-and-a-terminal-approval-takes-the-claim-over.md) records the decision;
this amendment says what it changed here.
The text above was corrected in place where the built behavior made a sentence false
(decision 2's Origin sentence, decision 3's payload, decision 5's fork and its accepted cost, decision 6's list of failures that are not sent,
and four of the consequences);
where the two differ, this is the later text.

1. **Decision 5's fork on the lease is superseded; the rest of decision 5 stands.**
   The approver was the clicker for any call that arrived while the claim's lease was live, a person's terminal included,
   and the cost of that was accepted (#1604).
   The approver is now the clicker only for a call that presents the claim's dispatch token while the lease is live,
   and a call with no token is recorded as its caller, whatever the lease says.
   What stands of decision 5: the time-only lease for attribution, the re-check of the clicker's role and status at each use, and the claim cleared by the owner-name walk-back.
   Decision 6 stands too: the lease is kept for an unconfirmed dispatch.
   Its list of failures that are definitely not sent gained one, a dispatch token that cannot be signed.
2. **The token is derived from the claim, and the Worker stores nothing of it.**
   It is a keyed hash of the dataset, the request, the clicker and the claim's own `approval_dispatched_at`,
   signed with the callback secret under the domain tag `approval-dispatch`.
   Releasing, replacing, denying or taking over the claim is what revokes it.
3. **A terminal approval takes a live claim over.**
   The decision's earlier text let it run beside the web run's lease and be recorded as the clicker.
   Now it is recorded as itself, and once it has passed every gate the same statement that marks the request `approving` clears the claim.
   The web run's executor is refused at its next call.
4. **A run that sat quiet past its lease is refused, not recorded under the executing key.**
   The consequence that accepted this cost is rewritten; a fresh click starts a new run.
5. **A workflow failure the backend cannot see now has a way to report, and the five early exits now say why.**
   `POST /webhooks/approval-release`, authenticated by the token alone, clears the claim and records a fixed sentence as `last_error`.
   The sandbox, no-repository, dataset-not-found and invalid-repository answers write their own sentence to `last_error`,
   and so does a failure to mint the GitHub token for the dataset repositories, which is then rethrown.
6. **The route checks its dataset id for the environment before it claims,** and refuses a body that names a request other than the one in force.
7. **Every unsafe admin route has the Origin rule,** by one guard on the admin router instead of a check in each route.
8. **Open:** whether a valid token whose clicker is no longer an active administrator should publish at all.
   This ADR's behavior (the caller stands in) is unchanged and is pinned by a test; ADR 0103 records the question and that it is not decided.

### Replaced wording, kept so that the earlier verdict stays findable

What this ADR said before Phase 3, for the two places where the verdict changed.
The words are the earlier ones, reflowed onto semantic lines.
Nothing here is in force.

**Decision 5, the fork on the lease (replaced by the dispatch token).**

> While the lease is live (the time-only lease, read at the top of `/approve`, before that call's own heartbeat bump), that admin is the approver:
> `approved_by`, the `dataset_published` audit row and the `notify_user_failed` audit row name them,
> and the executing account is kept as `executed_by` in the details.
> Otherwise, which includes a terminal approval outside a live web lease, the caller is the approver and the audit row is byte-identical to what it was.
> The column is never cleared on a lapse, so without the lease a run that lapsed and was resumed by a different admin at a terminal would be recorded as the original clicker's.
> Attribution reads the time-only lease rather than the failure-aware predicate above, so a failure does not strip the clicker from the retry that finishes the run.
>
> **The fork is on the lease, not on who calls.**
> A person who runs `/approve` at a terminal inside a web run's live lease is recorded as that run's clicker, with themselves kept as `executed_by`.
> Telling a service key from a person would need the caller's account kind (ADR 0048),
> and an executor whose key is not marked as a service account would then lose web attribution entirely,
> so the cost is accepted and stated here.

**The consequence that accepted a run quiet past its lease (replaced: such a run is now refused with `dispatch_expired`).**

> **A web run that sat quiet longer than the lease before its first `/approve` call is recorded under the executing key.**
> A runner queued for more than 15 minutes, or a dispatch that only starts after a long outage, loses the clicker: attribution is honored only while the lease is live.
> `executed_by` is then absent because there is nothing to fork, and the dispatch's own `approval_dispatched` audit row still names the clicker by id.

Three other consequences described limits that Phase 3 closed, so they were rewritten rather than superseded.
A refusal before the step loop used to leave no `last_error`, so the page read "running" for the lease although nothing was running.
A workflow failure the backend could not see used to be a follow-up that needed a release endpoint, and the lease lapsed on its own.
A terminal approval used as the way out of an unconfirmed dispatch's lease did not displace the web run, and now it takes the claim over.
Decision 3 said that the payload names an environment, "never a URL or a credential", and now says that it carries no credential that authorizes anything.
