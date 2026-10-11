# ADR 0047: CLI sign-in is the device authorization grant

**Status:** accepted
**Date:** 2026-09-06
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1272 makes ORCID the single identity root for NEMAR.
After epic #1250 the web already creates accounts only through ORCID OAuth,
but the CLI still creates them with a password and a typed, unverified ORCID iD.
Two creation paths with two different identity roots produced the null-username and duplicate-account problems that epic #1250 cleaned up.

A terminal cannot receive an OAuth redirect,
and nobody should type an ORCID password into a CLI prompt.
`nemar auth login` therefore needs a way to authenticate that starts in the terminal and finishes in a browser the person already trusts.
`gh auth login` solves the identical problem with the device authorization grant (RFC 8628), a pattern built for exactly this shape:
a CLI mints a short code, a person authorizes it in a browser,
and the CLI polls for the credential once authorization lands.

Phase 1 (#1281) builds the backend half of this flow.
It never talks to ORCID itself:
`lookup`/`confirm`/`deny` sit behind the existing web session and ORCID routes,
so every ORCID lesson already in the tree (ADR 0022, 0043, 0044) applies unchanged.

## Decision

CLI sign-in is the device authorization grant,
layered on top of the existing web ORCID session rather than a new identity path.
The API key is minted only when the CLI collects it at `/auth/device/token`,
never when the browser confirms at `/auth/device/confirm`:
confirm records `user_id` and `status = 'confirmed'` only,
so no plaintext key is ever at rest between the two steps.
Every key is a named row for one machine (`tokens.name` holds the machine name the CLI or the paste-key form supplied),
and a new sign-in never revokes another machine's key --
a laptop and a compute cluster can both hold a live key for the same account at the same time.
The polling secret itself is never stored in the clear:
`device_codes.device_code_hash` holds only its SHA-256 hash, the same function `tokens.api_key_hash` uses,
so a read of the table cannot be turned into a working code.

## Consequences

`POST /auth/device/token` sits OUTSIDE the strict per-IP auth bucket (`AUTH_PATHS`, 10 requests/minute) and rides the generic bucket instead --
in practice `ip` (500/min), since the CLI holds no bearer until it has collected a key --
because the CLI polls it roughly every 5 seconds while waiting, up to ~120 polls across one 10-minute code.
At that cadence 10 polls fit inside the strict bucket's 60-second window and the 11th would trip it, about 50 seconds in.
The route gets its own per-row floor instead:
a poll sooner than 5 seconds after the last STAMPED poll answers `slow_down` without resetting the timer,
so a jittery client is never starved and can never restart its own countdown.

`verification_uri_complete` pre-fills the user code in the URL.
This is the RFC 8628 section 5.4 phishing trade-off, accepted deliberately:
NEMAR's users are researchers, not security engineers,
and the easiest, most reliable flow wins (the epic's guiding principle).
The mitigation is that phase 2's confirm page names the account and the machine before asking anyone to press Authorize --
a person who did not just run `nemar auth login` sees exactly that, and closes the tab.

Confirm extends a near-expiry code by 120 seconds (`expires_at = MAX(expires_at, datetime('now', '+120 seconds'))`),
so a person who authorizes in the closing seconds of the 10-minute window is not told "expired" by the CLI's very next poll.
This is safe because the code is already bound to one account by that point,
and the CLI still has to hold the device secret to collect the key.

`account_revoked` is unreachable at `lookup`/`confirm`/`deny`:
`findSessionByCookieId` already filters revoked accounts out of session resolution,
so a revoked person carries no web session and gets a 401, never this refusal.
It IS reachable at `/auth/device/token`,
for the case where an admin revokes the account between confirm and collect.

`POST /auth/device/deny` records no `user_id` on the `device_codes` row itself:
any signed-in account may deny a pending code,
and the denier is named only on the audit row, not on the table a later confirm/token read would see.

A brand-new ORCID account's `username` is `null` in `/auth/device/token`'s success response:
`refreshNameThenAssignUsername` runs after finalize, behind the response, not before it,
so a CLI collecting a key moments after sign-up may see the field still unset.
Phase 3 must not key config or first-run behavior on `username` alone.

`identity_conflict` refuses a NEW sign-in -- device confirm and the paste-key mint (`POST /auth/keys`) both check it --
while a key minted before the flag was set keeps authenticating.
The account has to clear the conflict (Settings) before it can add another key,
but nothing already issued stops working the moment the flag is set.

The polling endpoint's error body carries two different fields for "why":
`error` is the RFC 8628 code the CLI's retry loop switches on (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`, `invalid_grant`),
and `reason` -- present only on a terminal answer, never on the two "keep polling" ones --
is the more specific refusal code (`account_pending`, `too_many_keys`, ...) a person-facing message reads from.
They disagree on purpose, which is why `reason` is not spelled `code` like every other refusal on this wire.

Every device-flow timestamp is written and compared in SQL (`datetime('now', '+N seconds')`, `julianday` for `expires_in`),
never in JavaScript.
A JS `toISOString()` value compares greater than a same-day SQL `datetime('now')` value at index 10 (`'T' > ' '`),
so mixing the two silently breaks expiry.
This is a pre-existing bug in `auth_codes`, `web_sessions`, and `orcid_link_intents`;
fixing those is out of scope here and gets its own issue after this phase lands.

`confirm-key-regeneration` (the existing settings flow `regenerate-key` sends its email link through) is UNCHANGED by phase 3
and still revokes every key on the account, machine-named or not:
it is a password-era flow being retired, not the phase's own key-management surface, and phase 3 does not extend it.
`nemar auth login`'s device flow and `nemar auth logout` are the scoped replacement --
logout's default only ever revokes the ACTIVE machine's own key, and only when that key's `keySource` is `"device"`;
a pasted or password-era key may be shared with other machines and is kept, not silently killed by a different machine's logout.
`retrieve-key` and `regenerate-key` survive this release, each printing a deprecation sentence before its first prompt,
pointing at `nemar auth login` as the replacement for both.
*Amendment 2026-10-09 (ADR 0097):* that release has passed. `retrieve-key` and `POST /auth/signup` no longer do anything (the routes answer 410, the CLI command is a hidden stub that points at `nemar auth login`), and the stored password hashes are cleared.
`regenerate-key` and `confirm-key-regeneration` stay: they take no password, and with `retrieve-key` gone they are the way to replace a lost key without a signed-in machine, so the remark above that the flow is "being retired" no longer applies.

Phase 3's local config keys an account by `accountKeyFor(user) = username?.trim() || email`,
since a brand-new ORCID account's `username` is `null` at collection time (this decision's own point above).
`upsertAccount` merges a re-login into whatever entry it finds by that key OR by email,
so an account that was stored under its email (no username yet) is found and renamed rather than duplicated the moment the server starts reporting a username --
`dismissedNoticeIds`, `profileGaps`, `orcidVerified`, and `serviceAccess` all survive the merge intact.
A re-login on the SAME machine also mints a new device key every time
(the token endpoint keeps no memory of "this machine already has one"),
so phase 3 best-effort revokes the machine's OWN previous key with the newly collected bearer, after the local config write lands --
never a pasted or password-era key, which by definition is not this machine's alone to kill.
The revoke is attempted even when the preflight probe already found the OLD key dead --
a repeat revoke of an already-gone row is harmless and caught the same way any other failure is --
what that foreknowledge skips is only the "(replaced this machine's previous key)" confirmation line,
since nothing was meaningfully replaced by revoking a key that was already dead.
Left unbounded, a script that re-runs `nemar auth login` would otherwise mint a fresh row per invocation until the `MAX_LIVE_API_KEYS` cap (25).

The CLI's config file now always holds a live API key rather than a password hash on every account it stores,
so `getStore()` writes it `configFileMode: 0o600` (honored by `conf` 13's `atomically` writer regardless of umask)
and migrates an existing file an older build left at `conf`'s default file mode (0o666, unrelated to the conf version) to 0600 on first use, non-Windows only.

## Alternatives considered

- **Mint the key at confirm, encrypted at rest.**
  An encrypted key is plaintext-equivalent the moment it needs to be read back for the CLI to collect,
  and it adds a second secret (the encryption key) to rotate and protect.
  Minting at collect removes the "at rest between steps" window entirely rather than encrypting it.
- **HMAC-signed device state, no table.**
  Works for the ORCID CLI-link intent (migration 0078) because that flow is single-use and needs no server-side rate floor.
  The device grant needs both: single use (confirm must not be replayable)
  and a per-code poll floor (`slow_down`),
  neither of which a stateless signed token can enforce on its own.
  0078 chose a table for the same reason this phase does.
- **Keep password login for the CLI.**
  Rejected by the epic itself:
  two identity roots (password + typed ORCID iD vs. verified ORCID OAuth)
  is the problem epic #1250 already cleaned up once.

## Receipts

- Epic #1272, issue #1281 (phase 1 backend).
- RFC 8628 (OAuth 2.0 Device Authorization Grant), section 3.5 (error codes)
  and section 5.4 (phishing considerations).
- ADR 0022 -- ORCID relink intent is minted only by an authenticated same-origin POST.
- ADR 0040 -- admin approval is the single writer of upload access;
  `verified` is the base tier.
- ADR 0043 -- one person, one account.
- ADR 0044 -- identity self-service reaches the CLI, and ORCID does it through the browser.
- Migration 0078 (`orcid_link_intents`) -- the precedent for a short-lived,
  single-use table over a stateless signed token.
- Migration 0081 (`device_codes`).
