# ADR 0105: A web approval is attributed by a per-claim dispatch token, and a terminal approval takes the claim over

**Status:** proposed
**Date:** 2026-10-13
**Owner:** Seyed Yahya Shirazi

Epic #1726, Phase 3 (#1730).
Partially supersedes decision 5 of Architecture Decision Record (ADR) 0080 (the web approval executor):
its fork of the approver on the lease, and the acceptance of that fork's cost.
Also corrects decisions 2, 3 and 6 of ADR 0080, whose text is amended to match.
Amends ADR 0102 (the publication review) in its section 9, its section 10 and its "Before it is switched on" list;
ADR 0102 carries the corrections in place and a dated amendment.
Builds on ADR 0080 (the claim, the lease and the dispatch),
ADR 0102 (the approval gate, and the stop-gap this ADR retires),
ADR 0048 (account kinds, which the rejected alternative would have read),
and ADR 0020 (a change to a shared workflow reaches every environment at once).
The analysis behind the choices is in [`.context/publication-review-design.md`](../publication-review-design.md); this ADR is the verdict.

## Context

A click on Approve in the website does not run an approval.
It claims the request (`approval_requested_by`, `approval_dispatched_at`) and dispatches an executor, a workflow that runs `nemar admin publish approve` on a runner under its own administrator key (ADR 0080).
So the Worker sees an administrator key, and nothing in the call says whether it belongs to a web click.
ADR 0080 decision 5 settled that by time: while the claim's lease is live, whoever calls is recorded as the clicker.
It named the cost and accepted it: a person who runs `/approve` at a terminal inside a web run's lease is recorded as the clicker (#1604).

ADR 0102 made that cost larger.
An override of the publication review, and the identifier screen's acknowledgment, are recorded under the approver of record and satisfy a later run only when that run is attributed to the same administrator.
So a terminal approval inside a live web lease could ride on the clicker's recorded decision, and be recorded as the clicker's own act.
Phase 2 added a stop-gap, a refusal of any override sent inside a web approval (`override_inside_web_approval`), so that no override was ever recorded under another administrator's name.
The ride on the clicker's own recorded override stayed, and production was not to be lit until it was fixed.

Five facts, each checked against the code on 2026-10-13, shape the answer.

- **The lease is time, not proof.**
  It says that something is associated with the request, not that this call is the dispatched run.
  A person's terminal inside the lease cannot be told from the executor (#1604),
  and a runner that starts after the lease has lapsed is recorded under its own key, not as the click it was started for.
- **A shared secret and a derivable claim already exist.**
  The Worker holds one callback secret that signs its other callback tokens (the manifest's, the pre-screen's, the identifier screen's and its sweep's, and the two reviews'), each under its own domain tag.
  The claim's own columns (the clicker, the instant) are written by the click and cleared by the statements that end a claim,
  with one exception that the Consequences name,
  so a token derived from them is revoked by the events that clear the claim.
- **The executor is a workflow in the central workflow repository, which this repository does not hold.**
  Whatever the Worker comes to expect, the workflow must be changed to send it, and only the maintainer changes it, in a repository that every environment shares (ADR 0080 decision 3, ADR 0020).
  The change has a rollout, and the rollout has a window.
- **The approval path had five neighbouring faults that the same work touches.**
  A run could act on a request that was denied and filed again since the caller read it (#1579).
  A dispatch for an id the workflow would refuse claimed the lease and held it for fifteen minutes on a run that could not start (#1583).
  A workflow that failed before it called `/approve` held the lease the same way, with nothing to say why (#1582).
  A cookie request with no `Origin` check could approve or deny, and `/deny` was not gated by the lease (#1603, #1584).
  The write that ends an approval did not look at the request's status.
- **Persisting the Object Lock continuation token (#1580) is a different kind of change.**
  It would speed a resumed run, by an amount nobody has measured, at the price of a property a restart from page 1 has today (decision 13).

## Decision

**A web click's claim gets a token that is derived from the claim and proves, on every `/approve` call of its run, that the call belongs to that claim.
The clicker is the approver only for a call that presents a valid token, and every other caller is recorded as themselves.
A terminal approval takes any live claim over.
A token that is stale or expired is refused, never quietly downgraded.**

1. **The token is a keyed hash of the claim's own columns, and the Worker stores none of it.**
   It is a hash-based message authentication code (HMAC) built on the Secure Hash Algorithm 256 (SHA-256) hash,
   signed with the callback secret the Worker already holds (`PRESCREEN_CALLBACK_SECRET`).
   The signed message is five lines: the domain tag `approval-dispatch`, the dataset id, the request id, the clicker's id and the claim's own stored `approval_dispatched_at`.
   The tag keeps it from standing for any other kind of callback token, and no other kind's message can begin with it.
   A field that holds a line break is refused by the signer and fails the verifier, because the message is split by lines.
   There is no stored nonce, no column and no migration.
   Releasing, replacing, denying or taking over the claim changes or removes what the token is checked against, and that is its whole revocation, apart from the one writer that the Consequences name.
   The claim is one conditional write that returns the instant it stored, and the token is signed over that value, never over a recomputed clock.
   A Worker with no secret to sign with answers 502 `dispatch_unconfigured` before it claims anything.
2. **The token is a bearer credential for attribution, and for nothing else.**
   Any administrator key that presents it is recorded as the clicker, and rides on the clicker's recorded override and acknowledgment, for as long as the claim stands and its lease is live.
   It authorizes nothing by itself: the call must still authenticate as an administrator and pass every gate.
   It joins no revocation list, because `resolveApprover` re-checks the clicker's role and status at each use.
   The Worker never logs, stores, audits, lists or returns it:
   the dispatch error text has any copy of it removed,
   the audit rows carry ids and words only,
   and the command-line interface (CLI) redacts its header in the `--debug` log.
   The copies outside the Worker are the dispatch event that carries it to the executor and the event file of the run that receives it (decision 3).
3. **It travels in the dispatch payload and in one header.**
   The click mints it and puts it in the payload as `dispatch_token`, which now has five keys: `dataset_id`, `request_id`, `resume`, `environment` and `dispatch_token`.
   The executor presents it as `X-Approval-Dispatch-Token` on every `/approve` call of the run, one per batch and one per retry, so it cannot be single-use.
   The CLI reads it only from the environment variable `NEMAR_APPROVAL_DISPATCH_TOKEN`, only in `approve` and never in `next`, so a token left in a person's shell cannot turn their walk into an executor's run.
   A blank value is no token.
   The two ends of any other value are trimmed, as the Worker trims the header, so a token exported with a trailing line break still works.
   What is left must be what a header can carry: printable American Standard Code for Information Interchange (ASCII) characters, with no whitespace inside it.
   Otherwise `approve` refuses it before it sends anything, with a sentence that names the problem and never the value.
   Left to the client library, such a value throws, and the command would report a network failure and retry it for a while.
   With the variable set, `approve` refuses `--force`, `--acknowledge-identifier-screen` and `--skip-ci-check` before it sends anything (decision 5),
   and says on standard error that the run presents a token.
4. **The approver forks on the proof, in this order, in the prelude of `runPublicationApproval`.**
   A call that carries no token, or an empty or blank header, is its caller's own act whatever claim is on the row and whatever its lease says: the caller is the approver.
   A call whose token verifies, on a request that is `requested` or `approving` whose time-only lease is live (read in the same statement as the request, before this call's own heartbeat), is the click's run:
   the clicker is the approver if they are still an active administrator, and the caller stands in if they are not (the question this ADR leaves open, below).
   A call whose token does not verify is refused and changes nothing:
   409 `dispatch_superseded` when there is no claim, no secret, a mismatch, or a claim that was replaced, released or taken over,
   and 409 `dispatch_expired` when the token is genuine and the lease has lapsed, so a click made long ago is not honored for work done now.
   The lease is asked only after the digest, so a stranger learns nothing about a lease.
   The checks of `/approve` run in this order:
   the outdated-client refusal, the request read (404), `request_mismatch`, `request_blocked`, the token, the approver, `decision_with_dispatch_token`,
   then, for a run whose steps are all complete, the all-steps-done branch of decision 12 (the closed-request refusal, the tail jobs and the closing write), which runs neither gate and records no override;
   for any other run, the identifier screen's gate, the review's gate, the recording of the override, and the conditional mark.
5. **A call that carries a valid token carries no decision.**
   An override of the review, an acknowledgment of the identifier screen or a skipped continuous integration (CI) check (`skip_ci_check`) in the body of such a call is refused, 409 `decision_with_dispatch_token`, and nothing is recorded under anybody.
   The override and the acknowledgment were recorded at the click, under the clicker's id, and the gates read them there.
   A skipped CI check was never part of the click: it is a decision of its own, and it would be recorded under the approver, which for a token call is the clicker, who skipped nothing.
   Only `skip_ci_check: true` is a decision: an explicit `false` is allowed, because the CLI sends it on every call.
   The executor workflow sends none of the three, and the CLI refuses all three flags locally while the variable is set (decision 3).
   The CLI's refusal of `--skip-ci-check` has a sentence of its own:
   a run the website started never skips the CI check, because the click has no such option,
   where the other two flags are refused because the click already made that decision.
   This retires the Phase 2 stop-gap `override_inside_web_approval`, which is removed from the contract.
   Its guarantee is now structural, and stronger:
   an override, an acknowledgment or a skipped CI check is recorded only under the credential that sent it, and the first two also at the clicker's own dispatch.
6. **A terminal approval takes the claim over.**
   The mark that moves a request to `approving` clears `approval_requested_by` and `approval_dispatched_at` in the same statement, for a call that carried no token.
   It is the last write before any work, so a call that is refused earlier leaves the claim standing.
   The executor the click dispatched then finds no claim, and its next call is 409 `dispatch_superseded`.
   A call that carried a token marks only while `approval_dispatched_at` is still the instant it verified, which closes the gap between the check and the mark;
   zero changes are answered `dispatch_superseded` if the claim moved, and `request_changed` if the request moved under a claim that stands.
   The read that tells the two apart can itself fail, and then the answer is a retryable 500 (`CLAIM_READ_FAILED_MESSAGE`), never `dispatch_superseded`:
   nothing was marked and nothing proved that the claim was replaced, and the CLI does not retry a 409, so a transient database error must not end a live web run with a sentence that is false.
   A call already past its mark when the takeover lands finishes, which is the old hazard of two drivers narrowed to one call.
   The CLI's help says it in those terms: once a terminal approval has passed the gates it takes the claim over, and the website's run is refused at its next call.
   It does not say that the run is refused at once, because a call refused at a gate leaves the claim standing and a web call already past its mark finishes.
   An executor whose workflow sends no token takes over its own claim the same way.
7. **A run may name the request it is for.**
   `/approve`, `approve-dispatch` and `/deny` take an optional `request_id`, and answer 409 `request_mismatch` when it is not the newest active request,
   right after the request is read and before any gate, any approver resolution or any write, so nothing is recorded for a request nobody looked at (#1579).
   The CLI sends, on every `approve` call, the id of the request the administrator was looking at:
   `approve` sends the id of the detail it read, and `next`'s `y` sends the id of the list row it showed.
   The second is the safer of the two, because it is the request the administrator chose from the list, and the Worker refuses the call if another request has become the newest since.
   `--request-id` names it for a script, and the CLI refuses locally, before it sends any approval, when the two disagree.
   A call that carries a token binds the request by the token as well.
   The CLI's `deny` does not send it today, and the website's calls are Phase 4's (#1731).
8. **The dispatch route checks the dataset id for its environment before it claims.**
   The ids are `nm` or `on` and six digits on production, and also `xx` anywhere else (`APPROVAL_DISPATCH_ID_RE` in `shared/publication-limits.ts`).
   Anything else is 400 `invalid_dataset_id`, before the body is read, before any read of the request and before the claim (#1583).
   The workflow cannot import the constant, and it already states the same rule in its own validate step, as case patterns that were checked read-only against the public workflow on 2026-10-13 and match.
   The shared constant's comment names the workflow, and says that the executor mirrors these shapes and, once the edit of the Rollout is applied, cites the constant,
   so that it does not go stale when the edit lands.
   The workflow's comment citing the constant is added by that edit, so the two sides are changed together by hand.
9. **A failing executor releases its own claim.**
   `POST /webhooks/approval-release` takes `{ dataset_id, request_id, reason }` and the header, and the token alone authenticates (#1582).
   The reason is one of six closed words (`workflow_failed`, `workflow_cancelled`, `secret_missing`, `install_failed`, `input_rejected`, `preflight_failed`), and an unknown word reads as the first.
   The sentence of the word is stored, never a string the workflow wrote.
   One conditional write, bound to the claim's instant and its clicker, clears the claim and sets `last_error` unless a specific one is already there.
   It leaves `updated_at` alone, because the failed-run grace counts from it.
   It writes the audit row `approval_dispatch_released` (no user, the request id and the reason) and answers 200;
   a failure to write that row is logged with its cause and never turns the release into a failure.
   Every refusal of the credential, whatever the cause, is one 401 with the same bytes, so an answer never tells a caller which requests have a live claim.
   The route does not check the lease: a token releases its own claim for as long as that claim stands.
   It reads a body of at most 1 KiB, which is three scalars: a longer one is 413 and one that cannot be read as an object is 400, both before the credential is looked at, because the door is open until then.
   The five exits of `/approve` that come after the request is marked and before its step loop now also record why in `last_error`, best effort:
   dataset not found, sandbox, no repository, invalid repository, and a failure to mint the GitHub token for the dataset repositories.
   The four answers write their own sentence, with their bodies and statuses unchanged.
   The failed mint writes a fixed sentence and rethrows, so it answers as it always did, and the request stays `approving`.
   None of the five exits clears a claim.
   A call without a token has already taken the claim over at the mark, and a web run's claim is left standing for the executor's release step to end.
10. **One Origin rule covers every cookie write on the admin router.**
    `cookieOriginGuard` runs after authentication and the role check.
    A read passes (`GET`, `HEAD`, `OPTIONS`); any other method that is not authenticated by a bearer key needs a NEMAR `Origin`, or it is 403 `origin_not_allowed` (#1603, #1584).
    The rule is phrased as "not a key", so a request whose method of authentication nothing set fails closed.
    It replaces four per-route copies (the dispatch, the screen re-run, the review start and the comment).
    Its refusal body is `{ error: "origin_not_allowed", code: "origin_not_allowed", message }`.
    That is an exception to the rule of the comment and review-start routes, where `error` is the sentence and `code` the word:
    here the word is in `error` as well, so a caller that reads an approval refusal from `error` finds it, and the sentence is in `message`.
    The website's calls are Phase 4's (#1731), and it must show `message`, not `error`, for this one refusal.
    `/approve`'s own stricter rule, that an override is accepted only with an administrator key, stays.
11. **`/deny` is gated by the lease and is one conditional write.**
    It reads the newest active request and refuses, in this order and before any write: 404 for none, 409 `request_mismatch`,
    409 `deny_after_publishing` when publishing has started, and 409 `approval_in_flight` when an approval is running (the lease with its failed-run grace).
    Publishing has started when a step beyond the validation-only ones (`ci_check` and `enrichment_check`) is among the request's completed steps or is marked as its current step.
    The current step counts because a step is marked current before it runs and stays marked when it fails or is interrupted:
    the first mutation, `s3_public_read`, may have applied the bucket policy without the Worker having recorded it, and the dataset may then be public.
    So a request whose first mutation failed stays undeniable until it is retried to completion or repaired by hand,
    and a request interrupted only in validation steps stays deniable.
    The current-step rule rests on a best-effort write, and that is a known limit.
    The write that marks a step current is allowed to fail without failing the run, so that a progress record cannot fail a publication.
    The trigger is a failure of that write for the first mutation, followed by a cut-off before the step's own result is recorded:
    two faults in the one step.
    The effect is a request with no completed step and no current step beyond validation, which `/deny` then denies although the bucket policy may have been applied.
    It is accepted because it needs both faults in the same step.
    The approval gate's `publishingStanding` still reads the completed steps only, on purpose:
    widening what a gate exempts from its checks would be the dangerous direction.
    The `deny_after_publishing` refusal ignores the request's status on purpose:
    a request filed again keeps its `steps_completed` (follow-up #1766), a request's own completed steps are its own irreversible acts, and the dataset may already be public, so the depositor must not be told it was denied.
    The refusal's sentence tells the administrator to check the dataset first and promises no remedy:
    a blocked request waits for its depositor to fix what blocked it, and for any other the administrator is to check whether approving it again can finish it, or repair it by hand.
    No remedy is promised because `/approve` refuses a request that was filed again and carries every step as closed (`approval_closed_during_run`).
    The write is conditional on the lease and on the `updated_at` that was read, so a request that was published, claimed or touched in between is not overwritten.
    A lost write is read again and answered by the true reason.
    The write also clears a lapsed claim.
    The depositor's mail goes only after the write has changed a row.
    A stalled run that has not started publishing, in the sense above, can still be denied: nothing is public and nothing is writing.
12. **The write that ends an approval requires that the request is still `approving`, and in the all-steps-done branch a refusal comes before any write.**
    A request closed while its run ran (denied once its lease had lapsed, or blocked again by a late result) is not marked published.
    The run answers 409 `approval_closed_during_run`, a word of its own because `request_changed` means that nothing ran and here the steps have run and cannot be taken back,
    and writes one audit row, `approval_finished_on_closed_request`, of ids and words.
    A request that is already `published` was finished by a concurrent call of the same run, and counts as finished.
    A call writes the `dataset_published` audit row only when its own write changed the row, in the same batch as that write (one statement guarded on `changes()`), so a publication has one row, whichever call finished it, and a published request always has its row:
    the step loop's closing path follows the same rule, so a terminal resume that finished the request leaves no second row when the executor's loop then finds it `published`.
    The branch for a resumed run whose steps are all done follows the same rule, in this order.
    - A request that is not `approving` is refused with `approval_closed_during_run` before any tail job runs.
      The tail jobs write (the Zarr re-request stamp) and can publish a reserved version identifier, which cannot be taken back,
      so a refusal that reads as "nothing happened" must not come after them.
      This branch used to answer `published` and write nothing, whatever the status.
      A `requested` or `blocked` request that carries the steps of an earlier life (follow-up #1766) is refused here too.
    - The tail jobs run.
      When one of them warns, the request is left `approving`, because the warning's remedy is to approve again, and a request already marked `published` would answer that with a 404.
    - When none warned, the same call marks the request `published` with the guarded write.
      Only when that write changed the row does it write the `dataset_published` audit row, once, by the helper the step loop's last write uses, with the approver of record as its user and the flag `finished_by_resume` in its details.
      The approver of record is the caller, or the clicker for a call under a token, with `executed_by` then naming the caller.
      A concurrent finisher whose write changed nothing writes no second row.
      The mark leaves `approved_by` as it was, so the audit row, not that column, names who finished the run.
    - The audit row records the review gate's state, which this branch has not read, so the helper reads the `datasets` row itself.
      A read that fails, and a read that finds no row, are both a warning in the answer and no audit row, never a row with a guessed state.
      A failed audit write fails the batch, so neither write takes effect: the request stays `approving`, the answer is a 500, and the retry (every step is done) closes it and writes the row.
      The warning above is only for a row that cannot be built.
    - The answer carries its warnings under the singular key `warning`, joined with ` | ` as the step loop's answer joins its own:
      the tail jobs' warnings, then the audit warning.
      Its `status` is `approving` when the request was left so, and `published` when this call or a concurrent one marked it.
      The CLI reads only the singular key, and prints it, so the warning that tells an operator to approve again reaches them.
      A plural key would never be read, and the CLI would report a success without the warning.
    - The step loop's own end has the same dead end after a warning, and it is not changed here.
      It marks the request `published` and then answers with the tail jobs' warnings, which still say to approve again, and that finds no active request (404).
      This is a known limit, and the follow-up is to leave the request `approving` there too, as the all-steps-done branch now does, or to change the warning text.
    - A tail-job warning that approving again cannot clear leaves the request `approving` for good, and that is a known limit.
      The trigger is a formerly anonymous dataset with more than ten versions recorded before its first publication (`MAX_CONCEALED_ERA_VERSION_DOIS`):
      only the oldest ten are ever attempted, and the warning that says so recurs on every call, even after those ten are public.
      The effect is that the request stays `approving`, because approving it again repeats the warning and never closes it.
      It stays visible in the queue, so it is not silent.
      It is accepted because this branch left the request `approving` before Phase 3 as well,
      because the other tail-job warnings (a missing concept identifier, a missing repository) are cured by a repair and then by approving again, so `approving` is the right state for them,
      and because closing the request on a warning would turn the remedy into a 404.
      The cap is the only permanent warning today.
      The follow-up is to classify a tail-job warning as retryable or final and close the request on a final one, or to raise or paginate the cap.
    - The all-steps-done branch has no write that settles the claim, and that is a known limit.
      A call without a token does not take a live claim over here, because there is no mark, and the closing write is bound to `status = 'approving'` and to nothing about the claim.
      The trigger is a lease that lapses while the tail jobs run, so that another click replaces the claim, and then the first run closes the request.
      The effect is that the `dataset_published` row names the first run's approver of record, the first click's administrator for a call under a token.
      The second click's run then finds no active request and is answered 404.
      It is accepted because every step is done and the data is already public, so closing is correct whichever run closes,
      and because that administrator did click approve for this request.
13. **#1580 is deferred.**
    A resumed run restarts the lock listing at page 1, so objects added under `objects/` while the run was stopped are locked too, and `s3_lock` is never run again once complete.
    A saved continuation token would skip whatever was listed before it, which weakens a property the restart has today, and it would need a migration and a new resumability contract.
    The benefit is not measured, which is the first task of the issue when it is taken up.

### Left open, for the maintainer

With a valid token whose clicker is no longer an active administrator (demoted, revoked or deleted),
`resolveApprover` falls back to the caller, as ADR 0080 decided, and a test pins it.
The gate then reads the executor's own decisions, so the click publishes only where it needs none of the clicker's: a review that passes (or is off), a screen that is clear, or a run that has started publishing.
It is recorded as the executor, and the dispatch's own audit row names the clicker by id.
The revocation-cascade rule of AGENTS.md argues for refusing such a click unless the run has already started publishing, because ending a credential has to end what was minted from it.
The maintainer has not decided.
Nothing in this ADR decides it, and the code keeps ADR 0080's behavior until it is decided.

The same question has a second form, which this ADR settles as a deliberate exclusion from that rule.
A clicker whose browser session or API key ends while the run is under way does not end the token:
it stays valid until the claim is cleared or its lease lapses, fifteen minutes at most.
There are four reasons.
The token authorizes one request's one executor run, for at most the lease.
It is not minted from a session or an API key: it is derived from the claim, which records the click, so ending a session or a key leaves nothing for it to be revoked with.
A demotion or a deletion of the clicker does reach the run, because the approver's resolution re-checks the clicker's role and status at each call and falls back to the caller.
And whether a click made by someone who is no longer entitled to make it should publish at all is the open decision above, which settles this case too.

## Rollout

The Worker and the workflow are changed by different people in different repositories, so the order matters.
The workflow is the central workflow repository's `approve-publication.yml`.
The maintainer changes it, and a merge there takes effect for both environments at once.

| Step | What | Why here |
|---|---|---|
| 0 | The callback secret is set on both Workers (the names were checked read-only on 2026-10-13, and no values were read). | Without it, `approve-dispatch` answers 502 `dispatch_unconfigured` and no click can be dispatched. |
| 1 | The maintainer applies the workflow edit before Phase 3 reaches `dev`. | Against today's Worker it does nothing: no token is in the payload, so nothing is exported and the release step does nothing. It must be there before the first click that carries a token. |
| 2 | Merge to `dev`, then verify on staging that a web approval is recorded as the clicker, that an acknowledged screen is carried by the token, that a forced early failure is released, and that the audit query joins `approval_dispatched` audit rows to `publication_requests.approved_by`. | This is the verification of ADR 0102's "Before it is switched on", item 7. Any published request whose `approved_by` is not the user of its `approval_dispatched` row (matched on the request id in the row's details) is a candidate to read, not a violation: a deliberate terminal takeover and a re-dispatch by another administrator are meant to differ. |
| 3 | Production release: the npm `latest` publication should precede the production Worker deploy. | The pipeline does not enforce the order. Hold the deploy until npm shows the version, or accept a window of a few minutes in which production attributes a web approval to the executor. |

The edit the workflow needs:

- A first step, with no `env:` block, masks the token read from the event file.
  The token must not go into the job-level environment, where the payload's fields land.
- The approve step reads the token from the event file inside its own shell and exports `NEMAR_APPROVAL_DISPATCH_TOKEN` for the CLI process alone.
  It does not write the token to `GITHUB_ENV`, which is where the workflow puts the administrator key for every later step, so the token is in the environment of the approve step's process and of no later step.
- The install matches the environment: `nemar-cli@dev` for the staging backend and `latest` for production.
  Dev builds are published under the `dev` tag and the runner installs unpinned, so without this a staging run would carry the older CLI, which ignores the variable.
- A step that runs on failure or cancellation calls the release endpoint, reading the token from the event file.
  It does nothing when the event carries no token, which is the case for a manual run and for an event sent by an older Worker.
  A 401 answer means there is nothing to release.
- The token goes through the environment variable and nowhere else.
  The workflow never passes `--force`, `--acknowledge-identifier-screen` or `--skip-ci-check`, which the CLI refuses with a token set.
  It needs no `--request-id`: the token binds the request, and its preflight already checks the newest request.
- The workflow's validate step already carries the id rule of decision 8 as case patterns, so the edit to it is a comment only, with no logic.
  The comment cites `APPROVAL_DISPATCH_ID_RE` in `shared/publication-limits.ts` as the other side of the rule.

What each combination does:

| Worker | Workflow | CLI on the runner | Result |
|---|---|---|---|
| old | any | any | Today's behavior. No token is in the payload. |
| new | old | any | No token is sent. The executor is recorded as itself and takes over its own claim. The clicker's recorded override and screen acknowledgment are not honored, so an approval that needed either is refused: the acknowledgment is read whatever the review's flag says, and the override only when the review is lit. A failure is never released, and the lease lapses. |
| new | new | old | As the row above, except that the release step runs. The old CLI ignores the variable. |
| new | new | new | The full design. |

A manual `workflow_dispatch` run of the workflow is the executor's own act: it carries no token and takes over any live claim.
Rolling back the Worker alone is safe in every combination.

## Consequences

- **A transition window exists, and it is visible.**
  The workflow edit goes first (Rollout, step 1), so what remains is the lag of the npm `latest` publication behind the production Worker deploy:
  until the runner can install a CLI that reads the token variable, a web approval is recorded under the executor's account, which is what ADR 0080 exists to prevent.
  Nothing is published wrongly, and nothing is lost: the approval is attributed to the wrong administrator, and the audit query of step 2 lists the cases to read.
  In the same window the gate refuses an approval that needed the clicker's recorded screen acknowledgment, and one that needed the clicker's override when the review is lit.
- **The executor needs the workflow edit, and nothing in this repository can make it.**
  The Worker does not refuse a call that carries no token, because a person at a terminal carries none.
  An executor that never learns to send it is recorded as itself, and a run that needed the clicker's recorded decision is refused: attribution degrades, and nothing is published wrongly.
- **A web run that sat quiet longer than its lease is now refused,** where ADR 0080 accepted recording it under the executing key.
  A runner queued for more than fifteen minutes fails with `dispatch_expired`, and the page shows a stalled request to click again.
- **The token is a bearer credential, and what it carries is attribution.**
  Any administrator key that holds it can make its call be recorded as the clicker for as long as the claim stands, and can ride on the clicker's recorded decision.
  An administrator who could approve openly gains a way to approve under another administrator's name, not a way to approve what they could not.
  The token sits in the event file of the run, which every step of the workflow can read, in a repository whose logs are public:
  the workflow's first step has to mask it, and a workflow that does not turns the log into a place a token can be read.
- **A leaked token can cancel one run.**
  The release endpoint does not check the lease, so whoever holds a token can release its claim for as long as the claim stands, with no administrator key.
  The cost is one click wasted: the run is refused at its next call, a fixed sentence lands in `last_error`, and nothing is published or lost.
- **The token's resolution is one second, and a stored nonce was not chosen for it.**
  `approval_dispatched_at` is `datetime('now')`, so a claim released and then claimed again by the same administrator in the same second would give a token equal to the first.
  A re-claim is refused while a run is in flight, so it needs the earlier claim released, or stalled after its failure grace of a minute, or lapsed after fifteen.
  Only a release can put two claims in one second, and a release by the dispatch route means the event was never sent.
  What remains is an executor's own release followed within the second by the same administrator's click, and the consequence is two runs holding one valid token, which the takeover and the mark's condition already bound.
- **A demoted clicker's click can still publish** where it needs none of their decisions, recorded as the executor (the open question above).
- **A request that has started publishing can no longer be denied,** and a queued web approval cannot be cancelled by deny.
  A request whose first mutation failed or was interrupted counts as started, because the bucket policy may have been applied without a record, so it stays undeniable until it is retried to completion or repaired by hand.
  A way to withdraw a half-published run, and an administrator's cancel of a queued web approval, are follow-ups.
- **A resumed lock restarts at page 1** until #1580 is taken up with its measurement.
- **Every cookie write on the admin router now needs a NEMAR `Origin`.**
  A server-side caller that sends the session cookie to an unsafe admin route without the header is refused, which is the cost #1584 names, and the website's calls are Phase 4's to check.
  `isAllowedOrigin` admits any NEMAR subdomain and local addresses, so a sibling subdomain would pass: defense in depth, and narrowing it for the admin router is a follow-up.
- **None of this is behind `PUBLICATION_REVIEW_ENABLED`.**
  The token, the takeover, `request_id`, the id rule, the release endpoint, the Origin guard, the deny rules and the guarded final write reach production with the first release after finalization, whatever the flag says.
  The release notes say so.
- **One writer of a blocked request does not clear a live claim, and that is a follow-up.**
  The identifier screen's block of a `requested` row (`blockForFindings`, ADR 0086) moves it to `blocked` without clearing the claim,
  so after the depositor files again, a token that verifies for that claim's columns verifies again until its lease lapses.
  The effect needs a retained or leaked token and a re-request inside the lease, and the token carries attribution only (decision 2).
  Clearing the claim in that statement is the follow-up.
  It is not in this change because the writer belongs to the identifier screen, outside this phase's scope.
- **ADR 0080 decision 5 holds in part, and decision 6 stands.**
  The clicker's re-check, the time-only lease and the claim cleared by the owner-name walk-back (decision 5) stand, and so does the rule for an unconfirmed dispatch (decision 6).

## Alternatives considered

- **Fork on the caller's account kind (ADR 0048).**
  Honor the clicker only when the caller is a service account.
  It fails silently if the executor's key is not marked as a service account, because every web approval is then recorded under the executor and the clicker's override can no longer carry a run.
  It still mis-attributes a person who uses a service key, it does not bind a run to its request, and the stop-gap refusal would have to stay for service callers, so the hole stays.
- **A stored nonce on the claim.**
  A column, a migration, a place to clear it in every statement that ends a claim, and a strip in the list route.
  It buys exactness only for a same-second re-claim, which the claim's refusal during a run and the takeover already bound, so it was not worth a schema change.
- **A temporary Worker lever for the old fork, to close the transition window.**
  A variable that keeps the lease-based attribution on until the workflow sends the token.
  The window is zero, but a terminal approval inside a lease is mis-attributed for as long as it is on, it has to be set in two files and removed in a later release, and the window it closes is minutes when the order of the Rollout is followed.
- **The administrator key and the token for the release.**
  Stronger, but a missing administrator key is one of the failures the release has to be able to report, and the route would sit under `/admin` where the method of authentication must be a key.
  The token alone is limited to ending one claim early, which is the whole of what it can do.
- **Honor an expired token while its claim stands.**
  A runner delayed by an incident would later publish under a stale click, which is the case ADR 0080's principle, that a click is honored only while its run is live, exists to refuse.
- **Let a terminal approval and the executor coexist.**
  Attribution would flap between two drivers on one request.
  Refusing a terminal approval inside a claim removes the escape for an administrator in a hurry that ADR 0080 keeps.
- **Let `/deny` withdraw a half-published run.**
  The dataset may be public and the depositor would be told it was denied.
- **Keep the per-route Origin checks.**
  Four copies of a rule that every other unsafe route lacked.

## Receipts

- Epic #1726 and this phase, #1730.
  The approval issues #1579, #1580, #1582, #1583, #1584, #1603 and #1604.
  The earlier phases, pull requests #1735, #1762 and #1767.
  Phase 3's own pull request is #1772; its commits are on the branch `feature/issue-1730-phase3-approval-robustness`.
- ADR 0080 (decisions 2, 3, 5 and 6 and its consequences, corrected in place, with a note of partial supersession under its header and an amendment), ADR 0102 (sections 9 and 10, "Before it is switched on", and the Phase 2 amendment, with a Phase 3 amendment),
  ADR 0048 (account kinds), ADR 0020 (workflow edits reach every environment).
- The token: `backend/src/services/github/callback-tokens.ts`, `backend/src/services/approval-dispatch.ts` (`checkApprovalDispatchToken`, `resolveApprover`),
  `backend/src/services/github/dispatch.ts`, `shared/contract/publication.ts`.
- The routes: `backend/src/routes/admin/publish.ts` (approve, approve-dispatch, deny), `backend/src/services/publication-orchestrator.ts` (`runPublicationApproval`),
  `backend/src/routes/callbacks/approval-release.ts`, `backend/src/middleware/auth.ts` (`cookieOriginGuard`), `shared/publication-limits.ts`.
- The CLI: `src/commands/admin-publish-approve.ts`, `src/lib/api/publish.ts`, `src/lib/debug-log.ts`.
- The tests: `backend/test/approval-attribution.test.ts`, `backend/test/approve-dispatch-route.test.ts`, `backend/test/publication-review-gate.test.ts`,
  `test/admin-publish-approve-token-cli.test.ts`.
