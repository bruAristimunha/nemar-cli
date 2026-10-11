# ADR 0097: Password sign-in is retired and its stored hashes are cleared

**Status:** accepted
**Date:** 2026-10-09
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR once registered CLI accounts with a username, an email address and a
password, and handed out the first API key against that password. ADR 0047
(epic #1272) replaced both with browser sign-in: ORCID creates the account and
the device authorization grant mints a key named for the machine. It kept two
password-era commands "for this release", each printing a sentence saying
password sign-in would be removed in the next one.

The maintainer has now confirmed that no password is used any more (2026-10-09).
API keys are very much in use, so this decision is about what takes a password
and nothing else.

What was left, checked on 2026-10-09:

- `POST /auth/signup` registered an account with a password, a typed ORCID iD and
  a GitHub handle. The CLI stopped calling it in epic #1272 phase 3; the client
  function was still exported but had no caller.
- `POST /auth/retrieve-key` checked a password with bcrypt and, for an account
  that had no key yet, minted one.
- `backend/src/services/password.ts` (bcrypt, cost 10, and a strength rule) and
  the `bcryptjs` dependency in both packages, used by those two routes and by one
  script.
- `users.password_hash`: written only by signup, read only by retrieve-key, and
  the first column ADR 0096 had to stop admins reading out of `users`.
- Mail and pages that told a person to run `nemar auth retrieve-key`.

`nemarOrg/website` and `nemarOrg/nemar-py` were searched for both routes and for
the CLI command; neither calls them. The private `nemarOrg/docs` repository was
not readable from the session that made this change, so any page there that still
names `retrieve-key` is a follow-up (see Consequences).

## Decision

**Remove every route, command and helper that needed a password.**

- `POST /auth/signup` and `POST /auth/retrieve-key` keep a path and lose their
  behaviour. Each answers 410 with `{ error: "Password sign-in was removed. Run
  \`nemar auth login\` to sign in with your browser.", code:
  "password_sign_in_retired" }`, reads no body and touches no table. An unrouted
  path would answer 404 `Not Found`, which an already-installed CLI renders as
  "This NEMAR backend does not support this command yet": it blames the server and
  never names the command that works. The sentence is in `error` because that is
  the field the client prints for a code it does not know. A test dispatches both
  through the worker entry point, with a positive control, so a route added to
  another router or mounted under another prefix cannot satisfy it.
- `nemar auth retrieve-key` stays only as a hidden stub. The mail sent when an
  account verified its email, and pages outside this repository, told people to
  run it, so it prints that password sign-in is gone, names `nemar auth login` and
  exits 1, without prompting or calling the API. It is not listed in `--help`.
  `nemar auth regenerate-key` stays (it uses an emailed link, not a password) and
  loses its deprecation sentence.
- `services/password.ts`, the `signup` and `retrieveKey` client functions and
  `bcryptjs` are deleted.
- Every message that named `retrieve-key` now names `nemar auth login`, which is
  where a key comes from: the verification mail, the "already verified" and
  success pages, and the admin approve command's hints.

**Clear the stored hashes (migration 0093) and keep the column.** The migration
sets every non-NULL `password_hash` to NULL. A hash of a password nobody can use
is credential material with no purpose, and clearing it ends the live exposure
that ADR 0096 only stopped admins reading. The migration is not reversible, and
that is the point, with one qualification: copies taken before it ran live on as
D1 Time Travel history (up to 30 days, see migration 0089) and in any
`wrangler d1 export` (migration 0031 describes the runbook), and keep the hashes
until they age out or are deleted.
The column stays, nullable, and stays classified `secret` in `USER_COLUMN_ROLES`:
dropping it means rebuilding `users` and every table that references it (migration
0026 shows the cost), for no extra safety once every value is NULL. The tombstone
still sets it to NULL, harmlessly. The dev seed no longer inserts a hash.

**What does not change.** API keys, their hashing, revocation and the cascade that
ends everything minted from a key. `POST /auth/login` (it validates an API key,
despite the name), email verification and resend, the emailed key regeneration
pair, the device flow, the passwordless web code flow, and the `check-username`,
`check-github` and `orcid-name` helper routes.

## Consequences

- A `person` account with no key signs in with `nemar auth login`. That includes
  a legacy `verified` account that never fetched a key, which `retrieve-key` used
  to serve. The device flow is narrower than `retrieve-key` was: it refuses a
  non-person account (`service_account`) and an account with `identity_conflict`
  set. Those have two other routes. `nemar auth regenerate-key` checks only that
  the account is active, so it still mints for them. A service or test account's
  key is minted by an owner with `nemar admin keys create`. A key minted before
  the device flow keeps working; the CLI still labels it a password-era key
  because it has no `keySource`.
- A person who lost a key and has no signed-in machine uses `nemar auth
  regenerate-key` (an emailed link). It revokes the key on every machine, as it
  always did. It is now the only such route, so its follow-up instruction was
  corrected: the new key is used with `nemar auth login -k <key>`, because a bare
  `nemar auth login` starts the browser flow and ignores a pasted key. The
  command also exits non-zero when the request fails.
- The `key_retrieved` audit action is no longer written. Historical rows stay.
- **The hourly backup keeps the hashes.** [ADR 0004](0004-d1-backup-to-a-private-repo-hourly.md) stores
  plaintext dumps in the private `nemarOrg/nemar-db-backup` repository and uses its git history as the
  recovery timeline, and those dumps contain the hashes. Every snapshot taken before migration 0093 keeps
  them for as long as that history does, which is longer than Time Travel's 30 days. Restoring one would
  put hashes back, and a restore that recreates `users` would also lose migration 0094's trigger.
  Whether to rewrite that history is the maintainer's decision and is not made here.
- Rolling this back does not restore the live data: the hashes are gone from the
  table. Restoring password sign-in would be a new decision with a new way to set
  a password.
- Migrations run before the Worker deploy, so the previous Worker can briefly
  serve the old CLI signup route after 0093 clears existing hashes. Migration
  0094 clears any hash written in that interval, then installs a database trigger
  matching the old route's pending, unverified CLI-signup shape so it cannot
  write another hash before the new Worker returns 410. The trigger remains as a
  guard against that retired path being reintroduced.
- Follow-ups, not decided here. Pages on `docs.nemar.org` that name `retrieve-key`
  need the same edit (the repository is private; an admin can read it with
  `nemar admin docs`). The client functions `checkUsername`, `checkGitHubUsername`
  and `checkOrcidName` have no caller in the CLI (the signup form that used them
  went in phase 3) and are pinned only by the export-surface test; their routes
  may be dead too. `users.verification_token` is still stored in plaintext. None of
  these needs a password and none is changed by this decision.

## Alternatives considered

- **Keep the commands until the next release, as ADR 0047 planned.** That plan
  assumed some accounts still signed in with a password. The maintainer says none
  do, and a command that prompts for a password nobody has only produces a
  confusing failure.
- **Drop `users.password_hash`.** A table rebuild across every referencing table,
  with the failure modes migration 0026 documents, to remove a column that holds
  only NULL. It can be done later if it ever matters.
- **Leave the stored hashes in place.** They would be readable by anyone who ever
  regains a whole-row read of `users`, and they protect nothing.
- **Retire the emailed key regeneration and email verification too.** They are the
  recovery path for API keys, which are in use, and neither takes a password.

## Receipts

- `backend/src/routes/auth.ts`, `backend/src/db/migrations/0093_clear_password_hashes.sql`,
  `backend/src/db/migrations/0094_guard_retired_password_signup.sql`,
  `src/commands/auth.ts`, `src/lib/api/auth.ts`.
- `backend/test/password-hashes-cleared-migration.test.ts` (every status and role
  carries a hash; keys and `updated_at` are untouched),
  `backend/test/password-routes-retired.test.ts` (the 410s through the worker
  entry point, and the regenerate-key page), `backend/test/tier-emails.test.ts`,
  `test/auth-device-cli.test.ts`.
- Coverage that lived in `signup-real-name.test.ts` and
  `identity-refusals-route.test.ts` and is kept:
  `backend/test/orcid-name-route.test.ts`,
  `backend/test/identity-normalizers.unit.test.ts`, and the soft-deleted cases in
  `identity-refusals-route.test.ts` (now driven through ORCID finalize).
- ADR 0047 (amended in place). ADR 0040's phase 2 record still lists `POST
  /auth/retrieve-key` among the routes that accepted `verified`; that is history
  and is left as written. ADR 0096.
