# ADR 0110: Email moves to the Cloudflare Email Service

**Status:** proposed
**Date:** 2026-10-23
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR sends all of its mail through Resend and receives none: mail to `nemar.org` goes to an external host the platform cannot read.
The maintainer wants one mail system the platform owns end to end, so that incoming mail can become tickets and replies can come from a shared address (epic #1893).
Cloudflare's Email Service sends from a Worker through a `send_email` binding and receives through Email Routing into the Worker's `email()` handler, on the account that already runs everything else.
Email Routing is zone-level, and its catch-all rule exists only at the apex, so a subdomain can be given literal addresses only.
Enabling routing for the staging subdomain required enabling it for the apex, so since 2026-10-23 the apex MX points at Email Routing and its catch-all forwards to the inbox that held the domain's mail before; incoming mail is unchanged, and the cutover phase points the catch-all at the Worker.

## Decision

Mail moves to the Cloudflare Email Service in phases, and Resend is retired after a soak.

- **Sending** goes through the `send_email` binding. `EMAIL_PROVIDER` selects it: `cloudflare` sends through the binding, while unset, empty or `resend` is Resend, so production, which sets nothing, is unchanged until its own phase. Any other value, and `cloudflare` with no binding, is a configuration error that sends nothing and never falls back to Resend; a send refused for that reason counts as a certain non-delivery.
- **One provider switch, one fence.** The provider is chosen inside `sendEmail`, after the non-production delivery fence (`isEmailDeliveryAllowed`, issue #957, unchanged) and the `[DEV]` wrap, so every wrapper and the broadcast path inherit both and neither is repeated. Cloudflare error codes that say nothing was delivered become `EmailRejectedError`; an internal error, an unknown code or no code stays a plain error, because the message may have been accepted.
- **During the soak,** Resend is a fallback only for a Cloudflare refusal that certainly sent nothing and that Resend can answer, such as the rate or daily limit. A timeout, an internal error or an unknown error never falls back, because the message may have been accepted and a second send would duplicate it (maintainer, 2026-10-23). After the soak Resend is removed.
- **Receiving** goes through Email Routing into the Worker, which stores each raw message in a private R2 bucket under `inbound/raw/YYYY/MM/DD/<uuid>.eml` with the envelope as object metadata, and does nothing else in phase 1. A Worker with no `MAIL_INBOUND` binding rejects the message, so production, which has neither the binding nor a routing rule, cannot take mail in by accident.
- **Staging proves it first,** on `test.nemar.org`: the dev Worker's binding is restricted to staging sender addresses (`allowed_sender_addresses`), so it structurally cannot send as `nemar.org`, and it receives literal addresses on the subdomain. Routing rules are created by the operator, not by Wrangler's `addresses` key, which needs a newer Wrangler than the repository pins and would make every CI deploy depend on Email Routing permissions.
- **Direction, not yet decided:** incoming mail becomes tickets. Tags come from the recipient address and its plus-tag, rules route a message to a queue, some queues are restricted, and replies are sent from the shared support address. Phase 3 settles this and amends this record.

## Consequences

One system sends and receives, and the staging Worker can no longer reach Resend with a key it still holds.
The dev `RESEND_API_KEY` stays set until the final phase, because several senders check for the key before calling `sendEmail`; deleting it earlier would silence staging mail.
The Cloudflare path sends a plain-text part derived from the HTML as well, and bounds a call with a timer rather than an abort signal, since the binding takes none; a timed-out send is reported as possibly accepted.
Cloudflare returns no per-recipient batch, so a broadcast on this provider is one send per recipient; that is acceptable for staging and is replaced by a queue when announcements move.
The catch-all exists only at the apex, so its delivery to the Worker is first exercised at the cutover, and staging cannot show what an unrouted address does there.

## Alternatives considered

- **Keep Resend and add inbound elsewhere:** two vendors and two sets of DNS records for one mailbox domain, and incoming mail still not owned by the platform.
- **Email Routing forwarding to personal inboxes:** nothing to build, but no tickets, no record kept by the platform, and the same single points of failure as today.
- **A hosted helpdesk:** fastest to a ticket queue, but a new vendor holding user mail, and the queue rules and restrictions would not be NEMAR's.
- **Switch production directly:** the sending path can be proven on a subdomain, so proving it on staging first costs one phase and risks no outage on the real domain; only moving the apex catch-all to the Worker waits for the cutover.

## Receipts

- Epic #1893 and its phase 1 issue #1894; the epic's working notes are in `.context/epic_email_cloudflare.md`.
- `backend/src/services/email.ts` (`resolveEmailProvider`, `sendEmail`), `backend/src/services/inbound-mail.ts`, `backend/wrangler-sccn.toml` (`[[env.dev.send_email]]`, `MAIL_INBOUND`).
- Tests: `backend/test/email-provider.test.ts`, `email-send-binding.test.ts`, `broadcast-cloudflare.test.ts`, `inbound-mail.test.ts`.
