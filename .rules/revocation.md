# Revocation Cascades

The detail behind the "Revocation cascades, always" hard rule in `AGENTS.md`.
The decisions are ADR 0056 (the docs session), ADR 0078 (the `NemarApiRpc` service-binding entrypoint) and ADR 0079 (the private site).
Where this file and an ADR disagree, the ADR wins.

## [STRICT] Ending a credential has to end everything minted from it

API tokens are tied to a GitHub personal access token and per-user S3 credentials, and an API key can also mint a docs session (`POST /auth/docs/cli-session`).
So every route that revokes keys without ending every session calls `revokeDocsCredentials`.
The three that revoke keys and end the docs credential in their own batch (a role demotion, `finalizeRevocation`, the owner-only soft delete) do not need it.

Two host-scoped session kinds hang off the app session:

- `docs` (ADR 0056).
- `private`, held by the private site (`private.nemar.org`, ADR 0079) and reached only through the `NemarApiRpc` service-binding entrypoint (ADR 0078).

## The caller counts are load-bearing

`services/docs-auth.ts` and `services/private-auth.ts` each name the callers of their revoke and grants-purge statements, and say that a new path that ends a credential needs the lines too.
Those counts are load-bearing: add yourself to them rather than assuming someone else did.
The tests that drive these paths through their real routes are `backend/test/admin-credential-cascade.test.ts`, `backend/test/private-site-cascade.test.ts` and, for the support-ticket release that rides the same paths, `backend/test/mail-ticket-cascades.test.ts`.

## What deliberately does not cascade

A role demotion and an API key revocation deliberately leave `private` sessions alone; `PRIVATE_REVOKE_ALL_SQL` says why.

## Compute follows the same rule

`services/compute-release.ts` does the same for an account's compute: two callers, `finalizeRevocation` and `tombstoneUserCascade`, a role demotion and a key revocation deliberately outside it, and `backend/test/compute-end-callers.test.ts` fails when a new path that revokes all of a user's keys and sessions through the statement shapes it recognises (named in its header) runs neither those statements nor a named exception.

## Runner registrations end with the owner who made them

A runner (portable compute, `nemar-runner` on a workstation or a cluster) holds a secret (`nmr_`) that buys 15-minute access tokens (`nmra_`), and both are refused by every route but the runner's own (`runner_credential_not_accepted`, before any lookup, in `authMiddleware` and `resolveApiKeyUser`).
`runnerRevokeStatements` ends one registration and `runnerEndStatements` every live registration an owner made, in the batch of the path that ends the credential: delete its tokens, release its unstarted claims, make its started jobs `unreported` with the lease cleared, and revoke the registration last.
`runnerEndStatements` has THREE callers, `finalizeRevocation`, `tombstoneUserCascade` and the role demotion (registering a runner is an owner's act), listed in `RUNNER_END_CALLERS` (`services/compute-runners.ts`) and held to the code by `backend/test/compute-runner-end-callers.test.ts`.
A key revocation and a sign-out are deliberately not callers, and the one function that revokes every key without ending the account, the emailed key regeneration, is a named exception.
A registration is written only for an approved, undeleted owner and honored (exchange, token use) only while its owner still stands, so a request already past authentication when the cascade committed leaves nothing usable behind.
The residual of that deliberate key exception: a stolen owner key can register a runner that outlives the key's revocation.
The `compute.runner.registered` audit row records the key id, so after revoking a leaked owner key run `nemar admin compute runners list` and revoke every registration you do not recognize.

## One secret signs every compute token: rotate it only with no job running

`PRESCREEN_CALLBACK_SECRET` signs the prescreen and pull-request review callbacks and all three compute tokens (`services/compute-tokens.ts`): the launcher's `job_token`, the Tapis webhook address and the observer token.
A job's token is written into its launch specification once, at submit, and that text cannot be re-signed.
Rotating the secret therefore ends every running job's uploads (they are refused, and the job ends `result_upload_failed` and is charged), stops the webhook addresses Tapis holds (only the 30-minute poll then sees a job end), and refuses an observer token already minted.
A runner job holds a job token from the moment it is claimed, so the same applies to a `created` runner job with `runner_claimed_at` set.
To rotate: switch compute off, wait until no job is on the cluster (`submitted`, `queued`, `running`, `archiving` or `unreported`, and every `created` runner job with `runner_claimed_at` set; list each with `nemar admin compute jobs list --state <state>`), change the secret on the Worker, mint observer tokens afterwards, switch compute on.
The token expiry never depends on the secret's age, so there is no reason to rotate it on a schedule; rotate it for a suspected leak and accept the cost, in which case end the running jobs first with `nemar admin compute jobs cancel`.

## OpenID Connect grants hang off the account

A third set hangs off the account itself: the grants, tokens and codes of NEMAR's OpenID Connect provider (ADR 0119).
`oidcEndStatements` in `services/oidc-cascade.ts` is added to the batch of every path that ends a credential for good, `OIDC_END_CALLERS` lists them, and a test holds that list to the code.
`finalizeRevocation` and `tombstoneUserCascade` run both sets, compute and OpenID Connect, in their one batch.
A role demotion, an API key revocation and the app session's sign-out leave those grants alone on purpose (rule 12).
A back-channel logout is queued in that batch and sent afterwards, never inside it: a request to a partner's server must not be able to fail a revocation, and no dev or staging Worker may reach a real partner host (rule 15).
