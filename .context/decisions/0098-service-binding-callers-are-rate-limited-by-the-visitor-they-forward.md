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
   IPv6 is validated and canonicalized by the URL parser, so one visitor is one key however the address is written,
   and an IPv4-mapped address is the IPv4 visitor it wraps.
   A header longer than 512 characters, an entry longer than 45, a host name, a port, brackets, a zone id, `unknown` and an empty value are not addresses.
   Neither are the placeholders a caller writes when it has no visitor to name (`0.0.0.0`, `::`, `127.0.0.0/8`, `::1`):
   counting them would put thousands of visitors in one `site:` key, so they are treated as no address at all.
   Only the first entry is read, and an unreadable first entry is not skipped to reach a later one.
3. **A visitor so named is counted in `site-ip`, keyed `site:<address>`.**
   The prefix is a keyspace of its own: no IP literal starts with `s`,
   so a site key can never equal a public caller's key, and exhausting one never touches the other.
   The cap is 2000 per window.
   A default Discover page costs eleven API calls (one search and up to ten hydrations of `GET /datasets/:id`), so 2000 is about 180 such views, three a second from one address.
   The largest page the website can render today, `page_size=100`, hydrates every id in its slice, about 101 calls, and spends the whole allowance in about 19 views:
   a visitor or a crawler that loads such pages faster than one every three seconds reaches the cap inside a window.
   The number stays, because the goal for this traffic is that the data gets found and the bucket is a floor against a runaway loop, not a quota;
   capping what one page hydrates is the website's to decide.
   The arithmetic errs in the safe direction: the counter is a read and then a write, so the parallel hydrations of one page can read the same count and count as fewer calls than they made (the documented race of ADR 0099), and the allowance a page really spends is no more than the figures above.
   It is never below the anonymous cap `MAX_REQUESTS`,
   because a visitor who reaches the API through the website must not be treated more strictly than one who reaches it directly; a test pins that relation.
   The response carries `X-RateLimit-Bucket: site-ip`.
4. **A request with neither a `CF-Connecting-IP` nor a readable `X-Forwarded-For` shares one bucket per kind.**
   When both headers were absent it used to get a fresh random bucket, which is no bucket at all (an unusable `X-Forwarded-For` on its own was keyed on its raw string).
   The public network cannot produce such a request, so it is a caller inside the account that did not say who it acts for.
   On the anonymous path it is counted in `site-unattributed`, capped at 20,000 per window, far above the whole website's rate.
   On the strict, data and Neurobagel paths it shares the bucket of its kind, at that bucket's own cap.
   Pooling rather than leaving it unlimited makes a broken forward visible and bounded.
   Every answer carries `X-RateLimit-Caller: edge | site | unattributed`, the admin-bypass answer included, which says so on every bucket, including the strict, data and Neurobagel buckets whose `X-RateLimit-Bucket` keeps the same name for every source.
   The limiter logs an identity line for each combination of caller source, bucket and reason, once per isolate per window, naming the bucket and its cap.
   A warning for an unattributed caller repeats on the 11th, 101st and 1001st call in the window, like every limiter log below; the `site` line, which is the healthy case, does not, so it is one line a window per bucket at any rate.
   It writes none for a token bucket: that bucket is keyed by the bearer and not by the address, so a line about a forwarded visitor or a shared bucket would be false of it.
   An unattributed line also says why (`absent`, `too-long`, `first-entry-not-an-ip` with a coarse shape, or `unspecified-or-loopback`) and the header's length, never its value.
   Pooling also means a sign-in route keeps a floor instead of silently losing it.
   The Worker's own calls are not callers of the data plane and are not pooled there.
   An MCP tool reading a dataset's `index.json` through the zarr gateway, and the Neurobagel gatherer reading the data plane, hand a bare `Request` to a sub-app in process, with neither header.
   They are marked by object identity (`lib/internal-request.ts`), which nothing a client sends can claim and a copy of the request does not inherit,
   and the data plane's two buckets, `data-ip` and the miss budget, let them through uncounted and unlogged.
   The exemption is those two buckets' alone.
   On any other bucket a marked request is counted by its headers like every other caller, and having none, is pooled and logged,
   so a request marked by mistake cannot skip the strict, token, anonymous, Neurobagel or private-grant limits.
   What the mark leaves uncounted is bounded elsewhere.
   An MCP tool's request was counted where it arrived.
   The scheduled Neurobagel reconcile has no arriving request:
   it examines at most `NEUROBAGEL_RECONCILE_MAX` datasets per tick, and the writer's operations budget (`OP_BUDGET`) bounds each run.
   Without the mark they would share the pooled data-plane bucket and miss budget with any real caller that failed to say who it is, warn on a healthy system, and be refused whenever a public flood filled that pool.
   If a zone setting stripped `CF-Connecting-IP` from public traffic, that traffic would be pooled rather than switch the limiter off, but only if the setting stripped `X-Forwarded-For` as well:
   one that removed only `CF-Connecting-IP` would let a public client's own `X-Forwarded-For` choose its bucket, which is decision 1 failing.
   Nothing in this repository can see such a setting, so it is listed here as a thing to check if the zone's header handling ever changes.
5. **Everything else is unchanged.**
   The strict, data, Neurobagel and data-miss buckets keep their caps; only their key differs for a site or unattributed caller,
   so a forwarded visitor gets ten sign-in requests of their own (the address half of #1354).
   The token buckets, the admin and owner bypass, `X-Test-Bypass` and the development bypass are as they were.
6. **The caller must set `X-Forwarded-For`, never pass a visitor's through.**
   The website sets it to the address in its own `CF-Connecting-IP` and replaces whatever the visitor sent.
   The first entry is trusted, so a header copied from the browser would let a visitor choose their bucket.
   A caller with no address to give omits the header and lands in the shared bucket, visibly.
7. **The counter's window is fixed, and that is the larger part of the cure: ADR 0099, in the same change.**
   The counter used to refresh its expiry on every allowed request, so a cap bounded the requests between two quiet gaps of a window, not the requests in any minute.
   A pool that never went quiet for 60 seconds was refused for about a minute after every `cap / rate` seconds, whatever the cap.
   Measured in process with the real limiter and an injected clock, a steady 5 requests a second against a cap of 500 was refused 36.5 percent of the time and 8 a second 47.9 percent,
   which matches the 40 percent observed on 2026-10-11.
   ADR 0099 makes the window fixed, with its measurements and its cost.
   It matters more than any cap number, because raising a cap only moved the refusal rate along the same curve.

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
- **How to verify after the first deploy, as a gate and not a glance.**
  The Cache API's `put` "resolves to undefined regardless of whether the cache successfully stored the response", and Cloudflare says nothing about a call that arrived over a service binding.
  If the counter silently does not persist there, every answer reads `site-ip` with `X-RateLimit-Remaining` at 1999 for ever and nothing is ever limited, with no log line and no failure.
  So the property that must be shown, not assumed, is that **two sequential calls from one visitor over the binding show `X-RateLimit-Remaining` falling**.
  The website logs `remaining` on its first call and logs one error per isolate, `the API's rate-limit count did not move`, if five calls for a visitor inside one window leave it unchanged (website pull request #450).
  Read that line, or the header by hand, before treating the deploy as done; "no log means fine" is not evidence.
  A bare "remaining must fall" is not enough either: a mis-forward that put every visitor under one `site:<address>` key would pass it.
  So the gate is also that **two different visitors each read `X-RateLimit-Bucket: site-ip` and a first call of 1999**, one per visitor.
  Website pull request #450, already merged to staging, is a prerequisite of the deploy and not a nicety:
  it is the only detector for "put resolves but nothing persists" and for a binding call that carries a `CF-Connecting-IP` after all.
  Then tail the production API Worker while a few website pages load:
  `bunx cfman wrangler --account sccn tail nemar-api --search "[rate-limit]"`.
  A line `counting a request without CF-Connecting-IP by its forwarded visitor` (once per isolate per window for each source, bucket and reason, with no repeats, and never for a token bucket) means the hypothesis about the missing header holds.
  A warning `request with neither` means the website is not forwarding a usable visitor, and says why;
  its responses carry `X-RateLimit-Caller: unattributed`.
  No such line, with the website working, means a binding call carries a `CF-Connecting-IP` after all:
  its requests are in `ip`, nothing has regressed and nothing has improved, and this ADR needs an amendment.
- **What an absent header means, and what it does not.**
  The `X-RateLimit-*` headers are set on the finished response, so a handler that builds its own `Response` keeps them.
  An answer without them was not announced as counted: the development Worker, a bypass, a cache fault (which is logged, once per window per bucket kind and again at the milestones described below), or an observe-only count.
  That last is the zarr redirect path, which counts a request against the shared bucket and never announces it, so "no headers" does not mean "not counted" there.
  They are not proof of a count either: the data plane hands its write to `waitUntil`, so its answer states a count whether or not the write lands, and a failing `put` there leaves `X-RateLimit-Remaining` unchanged while the line is logged.
  The falling `X-RateLimit-Remaining` above is the evidence; the header's presence alone is not.
- **The limiter reports its own faults and does not wait on the cache for ever.**
  A repaired counter record, a replaced admin-flag record, a refusal, and a cache fault are each logged once per window per bucket kind (refusals and identities also per caller source, a fault also per phase), by name and never with an address or a message.
  A line says how many calls for its key were swallowed since the previous line (`suppressed`, which does not count the call that is speaking) and how long ago that previous line was (`sinceMs`, the time since the previous line, not since the window opened).
  A key that keeps firing inside its window speaks again on the 11th, 101st and 1001st call in the window, so the size of a burst is on the log without a line per request, at no more than four lines per key per window.
  The lines and the calls they swallowed add up to the calls made, but the size is exact only to a factor of ten: a burst that ends between milestones shows as the last milestone it passed.
  A fault line says in which phase the work failed (`match`, `read`, `decide` or `put`), so a bug in the limiter is told from the runtime refusing a call.
  `read` is the wait on the record's body and nothing else; the limiter interpreting what it read is `decide`, and a fault there is logged as a `limiter fault` and not as a cache failure.
  A record that cannot be read at all (a stream that errors, one that never finishes) is a cache fault, not a damaged record.
  Every call to the Cache API (the lookup, the read of the record's body, the write) is bounded at 500 ms and then fails open with a logged fault.
  The bound is per call and per place, not per request.
  The counter makes up to three awaited calls (the lookup, the read of the record's body, the write), and on the data plane at most two, because its write is handed to `waitUntil`.
  A bearer's admin flag that is not cached makes two (the lookup, then the write of the database's answer), and three when a cached flag is damaged and so is read and replaced.
  The data plane's miss budget awaits two (the lookup and the read) when `waitUntil` exists, because its write is deferred, and three when it does not.
  The places fail independently, so a cache that hangs costs a request up to 500 ms in each place it uses (the admin flag and the counter for a token request, the counter and the miss budget for a data request), about a second, not 500 ms in all.
  The writes handed to `waitUntil` (the data plane's counter, the miss budget, the private-grant budget) are bounded and logged the same way and are not waited on.
  A latch that skipped a cache known to be stalled until the window's end would cut the cost to one stall (issue #1715).
- Any Worker in the account that binds to the default entrypoint can name any visitor, so it can spend a visitor's `site:` allowances.
  It cannot touch a public caller's buckets, which is why the keyspaces are apart,
  and ADR 0078 rule 4 already makes deploy access to the account access to this surface.
- A call over the service binding reaches the Worker without the zone's edge protections (WAF, rate-limiting rules, bot management), so these counters are the only floor for a site caller.
  The admin and owner bypass removes even that for a site caller carrying an admin token, as it does for a public one: the token is the control there.
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
  Rejected: it silently turns the limiter off, for the strict paths too, and would do so for everyone if a zone setting stripped `CF-Connecting-IP` and `X-Forwarded-For`.
- **Forwarding the visitor as `X-Real-IP` over the public network.**
  Cloudflare documents that on a same-zone Worker subrequest `CF-Connecting-IP` reflects `x-real-ip`, which a Worker can set.
  Not used: it keeps the call on the public network, depends on behavior this repository cannot test,
  and gives the API a value it cannot tell from a real edge address.
- **Fixing the window in the same change.**
  Done, in a commit of its own and with its own ADR (0099), because it changes every bucket and deserves its own review.
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
  the cache does not replicate outside the originating data center, and `put()` "resolves to `undefined` regardless of whether the cache successfully stored the response".
- The counter, measured: the real `rateLimiter` driven at a steady rate against a cap of 500 for 30 simulated minutes,
  refused 0 percent of requests at 0.2 a second, 3.2 at 0.5, 9.8 at 1, 16.7 at 2, 36.5 at 5 and 47.9 at 8.
