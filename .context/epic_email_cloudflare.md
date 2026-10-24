# Epic: all NEMAR email on the Cloudflare Email Service (#1893)

> **STATUS: CURRENT.** Opened 2026-10-23. Decisions are recorded in [ADR 0110](decisions/0110-email-moves-to-cloudflare-email-service.md); where this document and the ADR disagree, the ADR wins.
> Public repository: host details, account identifiers and personal addresses are recorded in the gated operations documentation, not here.

## Goal

Send and receive every NEMAR email on Cloudflare: sending through the Workers `send_email` binding, receiving through Email Routing into the API Worker, raw messages kept in R2. Retire Resend after a soak. Build a ticket system on top of the inbound path.

## Decided (2026-10-23)

1. One mail system on Cloudflare; Resend is retired after a soak and kept before that only as a fallback for a transport failure (ADR 0110).
2. The provider is chosen by `EMAIL_PROVIDER` inside `sendEmail`, behind the unchanged non-production delivery fence. Unset, empty or `resend` is Resend, so production does not change until its own phase; any other value is a configuration error, never Resend.
3. Staging first, on `test.nemar.org`. The dev Worker's `send_email` binding is restricted to the staging sender addresses. Production does not receive mail in phase 1: it has no `MAIL_INBOUND` binding and no routing rule.
4. Routing rules are created by the operator, not by Wrangler's `addresses` key (needs Wrangler 4.113 or later; the root `package.json` allows `^4.70.0` and `backend/package.json` `^4.85.0`, and the deploy workflow runs `npx wrangler` from `backend/`, so it uses the backend's locked 4.85.0; and it would make every CI deploy depend on Email Routing permissions). Revisit at the cutover.
5. The ticket model is direction only for now: tags from recipient addresses and plus-tags, rules, restricted queues, replies from the support address.

## Phases

| Phase | Content | State |
|---|---|---|
| 1 (#1894) | Staging mail on `test.nemar.org`: provider switch, broadcast path, inbound handler into R2, staging configuration, ADR 0110. | in review |
| 2 | Announcements move from per-recipient sends to a Queue. | open |
| 3 | The ticket model: parsing, tags, rules, restricted queues, replies from the support address; amends ADR 0110. | open |
| 4, 5 | See the epic issue. | open |
| 6 | Production cutover: apex routing and the catch-all, `nemar.org` sending. | open |
| 7 | Retire Resend: remove the key from every Worker and the fallback code. | open |

## Facts that shape the plan (checked 2026-10-23)

- Resend is called only from `backend/src/services/email.ts` (`sendEmail`) and `backend/src/services/broadcast.ts` (`/emails/batch`). Every wrapper passes the Worker env as `deliveryEnv`, so the provider switch needed no signature change across the call sites.
- A catch-all rule is apex-only. A subdomain has literal addresses only, so staging tests a fixed address list, and the catch-all is first exercised at the cutover.
- Email Routing is zone-level and its documented subdomain flow starts from the apex. The apex MX must stay on its current host until phase 6, so enabling routing for the subdomain alone is the riskiest operator step: if the platform requires enabling it on the apex, stop and ask the maintainer.
- The dev Worker deploys only from `dev`, so staging sees this work only after the epic branch reaches `dev`.
- `@cloudflare/workers-types` predates the structured `send_email` form, so `services/email.ts` declares a local minimal interface instead of bumping the package. Miniflare 4.20260424 accepts the structured form, which `backend/test/email-send-binding.test.ts` drives.
- Several senders check `RESEND_API_KEY` before calling `sendEmail`, so the dev secret stays until phase 7.
- The Cloudflare path sends the HTML and a plain-text part derived from it; the Resend request is unchanged.

## Open questions for the owner

- Which addresses beyond the staging list get literal routing rules, and who reads each queue.
- Whether the apex catch-all at the cutover forwards unrouted mail to the current host for a period, or rejects it.
- The retention of raw inbound mail in R2 beyond the 30 days staging uses, once real mail arrives.
