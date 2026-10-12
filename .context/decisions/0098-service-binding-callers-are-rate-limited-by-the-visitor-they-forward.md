# ADR 0098: A request without CF-Connecting-IP is rate limited by the visitor its caller forwards, and the account is the trust boundary

**Status:** accepted
**Date:** 2026-10-12
**Owner:** Seyed Yahya Shirazi

## Context

The website renders its pages on Cloudflare Workers and calls `api.nemar.org` from there.
Every visitor therefore reaches the API from the website Worker's small pool of Cloudflare egress addresses,
and the anonymous per-IP bucket (`backend/src/middleware/rateLimit.ts`) counts that pool as one client.
In a sample of the production log on 2026-10-11, about 40 percent of the `/discover` requests were answered `429` (issue #1709).
Issue #1354 records the same property for the strict `AUTH_PATHS` bucket: ten requests a minute on the sign-in family, shared by every visitor.

The website is going to call this Worker through a service binding instead of the public network.
It binds to the Worker's default entrypoint, whose `fetch` handler runs the whole HTTP app (CORS, the limiter, maintenance mode).
It does not bind to `NemarApiRpc`: ADR 0078 keeps that entrypoint free of HTTP middleware (its rule 3) and gives it no method for catalog reads.
A request that reaches the default entrypoint through a binding does not arrive from the public network.
The working hypothesis, checked in local workerd and not yet in production, is that it carries no `CF-Connecting-IP` unless its caller sets one.
Cloudflare sets that header on the traffic it proxies, which is why the limiter has always been able to key on it.

So the limiter needs a way to count the visitor the website acts for,
without ever letting a public client choose its own bucket.

## Decision

**A request without `CF-Connecting-IP` is counted by the visitor its caller forwards in `X-Forwarded-For`, in buckets of their own.
The Cloudflare account is the trust boundary, as in ADR 0078, and no secret header is added.**

1. **`CF-Connecting-IP` decides whenever it is present, and `X-Forwarded-For` is then never read.**
   It is the only identity a public caller can have,
   so a forged `X-Forwarded-For` cannot choose, share or reset a public caller's bucket.
   Nothing changes for a request that carries it.
2. **Without it, the first entry of `X-Forwarded-For` names the visitor if it is a valid IP literal.**
   IPv4 is matched strictly: four octets up to 255, no leading zeros.
   IPv6 is validated and canonicalized by the URL parser, so one visitor is one key however the address is written.
   A header longer than 512 characters, an entry longer than 45, a host name, a port, brackets, a zone id, `unknown` and an empty value are not addresses.
   Only the first entry is read, and an unreadable first entry is not skipped to reach a later one.
3. **A visitor so named is counted in `site-ip`, keyed `site:<address>`.**
   The prefix is a keyspace of its own: no IP literal starts with `s`,
   so a site key can never equal a public caller's key, and exhausting one never touches the other.
   The cap is 2000 per window, sized to the heaviest page the website renders (eleven API calls: one search and ten hydrations).
   It is never below the anonymous cap `MAX_REQUESTS`,
   because a visitor who reaches the API through the website must not be treated more strictly than one who reaches it directly; a test pins that relation.
   The response carries `X-RateLimit-Bucket: site-ip`.
4. **A request with neither a `CF-Connecting-IP` nor a readable `X-Forwarded-For` shares one bucket per kind.**
   Until now it got a fresh random bucket, which is no bucket at all.
   The public network cannot produce such a request, so it is a caller inside the account that did not say who it acts for.
   On the anonymous path it is counted in `site-unattributed`, capped at 20,000 per window, far above the whole website's rate.
   On the strict, data and Neurobagel paths it shares the bucket of its kind, at that bucket's own cap.
   Pooling rather than leaving it unlimited makes a broken forward visible and bounded:
   the header `X-RateLimit-Bucket: site-unattributed` says so, and the limiter logs one line per window per isolate.
   It also means a sign-in route keeps a floor instead of silently losing it,
   and that a zone setting which stripped `CF-Connecting-IP` from public traffic would pool that traffic rather than switch the limiter off.
5. **Everything else is unchanged.**
   The strict, data, Neurobagel and data-miss buckets keep their caps; only their key differs for a site or unattributed caller,
   so a forwarded visitor gets ten sign-in requests of their own (the address half of #1354).
   The token buckets, the admin and owner bypass, `X-Test-Bypass` and the development bypass are as they were.
6. **The caller must set `X-Forwarded-For`, never pass a visitor's through.**
   The website sets it to the address in its own `CF-Connecting-IP` and replaces whatever the visitor sent.
   The first entry is trusted, so a header copied from the browser would let a visitor choose their bucket.
   A caller with no address to give omits the header and lands in the shared bucket, visibly.
7. **The counter is unchanged, and it is the larger part of the cause.**
   Each allowed request refreshes the counter's expiry, so a cap bounds the requests between two quiet gaps of a window, not the requests in any minute.
   A pool that never goes quiet for 60 seconds is therefore refused for about a minute after every `cap / rate` seconds, whatever the cap.
   Measured in process with the real limiter and an injected clock, a steady 5 requests a second against a cap of 500 is refused 36.5 percent of the time and 8 a second 47.9 percent,
   which matches the 40 percent observed on 2026-10-11.
   Making the window fixed is a separate decision and is not made here.
   It matters more than any cap number, because raising a cap only moves the refusal rate along the same curve.

## Consequences

- The website's visitors are counted one by one: the pool no longer sets the rate, and the strict bucket stops being shared.
  The public path is unchanged, including the refusal to read a forged `X-Forwarded-For`.
- **The rule rests on a property nothing here can prove before production: that a service-binding call carries no `CF-Connecting-IP`.**
  Cloudflare's documentation describes `CF-Connecting-IP` for Worker subrequests (same zone, cross zone, a non-Cloudflare destination) and is silent on service bindings.
  `backend/test/site-binding-identity.test.ts` asks local workerd through Miniflare:
  a call over a binding arrives with no `CF-Connecting-IP`, no `X-Real-IP` and no `cf` object,
  while a request from outside the Worker has `CF-Connecting-IP` injected;
  and a caller that sets the header itself is believed, as it is for any header.
  Local workerd is not the Cloudflare edge, and the development Worker bypasses the limiter entirely (`ENVIRONMENT=development`),
  so the keying can be observed only on the production Worker.
- **How to verify after the first deploy.**
  Tail the production API Worker while a few website pages load:
  `bunx cfman wrangler --account sccn tail nemar-api --search "[rate-limit]"`.
  A line `counting a request without CF-Connecting-IP by its forwarded visitor` (once per isolate per minute) means the hypothesis holds.
  A warning `request with neither` means the website is not forwarding a visitor, and its responses carry `X-RateLimit-Bucket: site-unattributed`.
  No such line, with the website working, means a binding call carries a `CF-Connecting-IP` after all:
  its requests are in `ip`, nothing has regressed and nothing has improved, and this ADR needs an amendment.
  Any website response or log that shows the API's `X-RateLimit-Bucket` should read `site-ip` with a falling `X-RateLimit-Remaining`;
  a call with no such header at all means the Cache API failed for it (the limiter fails open and logs a cache fault).
- Any Worker in the account that binds to the default entrypoint can name any visitor, so it can spend a visitor's `site:` allowances.
  It cannot touch a public caller's buckets, which is why the keyspaces are apart,
  and ADR 0078 rule 4 already makes deploy access to the account access to this surface.
- Counters stay per data center, as before, because they live in the Cache API.
- An IPv6 visitor can rotate within their prefix, one bucket per address, here as in the public `ip` bucket; this does not change that.
- The default entrypoint applies maintenance mode and CORS to the website's calls, as it does to everyone's.

## Alternatives considered

- **A shared secret header from the website.**
  Rejected in ADR 0078 and again here:
  it is a secret to rotate in two Workers, and a leaked value works from anywhere.
  A binding has no URL and so needs none.
- **A new RPC method for catalog reads on `NemarApiRpc`.**
  Rejected.
  It would duplicate the public projections and the disclosure rules of ADR 0065 (an anonymous deposit's authors, repository and DOI)
  and drift from the HTTP responses the website already parses.
  ADR 0078 left dataset facts out until a caller settles them, and the HTTP path already settles them.
- **Raising the anonymous cap as the fix.**
  Rejected as the fix: the cap is a floor against runaway loops, and decision 7 shows a raise only moves along the same curve.
  The same pull request does raise `MAX_REQUESTS` from 500 to 1000, as a separate commit that can be dropped without touching anything above,
  as defense in depth for the callers that still reach the API as one client (a Pages preview, local development, a failed binding assumption, shared CI runners).
  It stops at 1000 because `TOKEN_MAX_REQUESTS_AUTHED` is 1000 and a token holder must not be limited more strictly than an anonymous caller;
  going higher means raising the token cap in a decision of its own.
  `/mcp` shares this bucket, so its ceiling doubles with it.
- **Leaving a request with no address unlimited, as it is today.**
  Rejected: it silently turns the limiter off, for the strict paths too, and would do so for everyone if a zone setting stripped `CF-Connecting-IP`.
- **Forwarding the visitor as `X-Real-IP` over the public network.**
  Cloudflare documents that on a same-zone Worker subrequest `CF-Connecting-IP` reflects `x-real-ip`, which a Worker can set.
  Not used: it keeps the call on the public network, depends on behavior this repository cannot test,
  and gives the API a value it cannot tell from a real edge address.
- **Fixing the window in the same change.**
  Deferred, as decision 7 says: it changes every bucket and deserves its own review.
- **Keying the website's strict buckets on the session cookie (#1354, option 1).**
  Not done: the address is the key everywhere else, and a cookie-derived key needs its own forgery analysis.

## Receipts

- Issue #1709 (the 429s on `/discover`) and #1354 (the strict bucket shared by every visitor).
- ADR 0078 (the binding, rule 3 on middleware, rule 4 on the account as boundary), ADR 0065 (the disclosure rules a new read method would have to repeat).
- `backend/src/middleware/rateLimit.ts`, `backend/test/rate-limit-site-identity.test.ts`, `backend/test/site-binding-identity.test.ts`.
- Cloudflare, "HTTP headers", <https://developers.cloudflare.com/fundamentals/reference/http-headers/>, read 2026-10-12:
  "In same-zone Worker subrequests, the value of `CF-Connecting-IP` reflects the value of `x-real-ip`",
  cross-zone subrequests get a fixed Worker address, and nothing is said of service bindings.
- Cloudflare, "Cache API", <https://developers.cloudflare.com/workers/runtime-apis/cache/>, read 2026-10-12:
  the cache does not replicate outside the originating data center.
- The counter, measured: the real `rateLimiter` driven at a steady rate against a cap of 500 for 30 simulated minutes,
  refused 0 percent of requests at 0.2 a second, 3.2 at 0.5, 9.8 at 1, 16.7 at 2, 36.5 at 5 and 47.9 at 8.
