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
   That holds only for a request that also carries neither address header, as the two real callers' requests do:
   one that carries a usable `CF-Connecting-IP` or `X-Forwarded-For` is counted as that address, marked or not.
   The exemption is those two buckets' alone.
   On any other bucket the mark changes nothing: the request is counted in whatever bucket it would reach unmarked,
   a strict, anonymous or Neurobagel bucket by its address (or the pooled bucket and its warning when it has none), a token bucket by its bearer, the private-grant budget by its account,
   so a request marked by mistake cannot skip those limits.
   A marked request refused on a bucket other than the data plane's, which the two current callers cannot produce, would not be told apart from a broken website forward in the refusal line, since both read as `unattributed`, and the MCP index reader would report only `index.json fetch answered HTTP 429`.
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
  So the property that must be shown, not assumed, is that **the count for one visitor falls across calls over the binding**.
  The first reading is the cap minus one (1999), and across six or more calls spaced one to two seconds apart the reading falls overall, with an occasional repeat or small rise, because the count is kept per data center and is not strictly monotonic.
  A check that insists on a strict fall from the second call to the third would fail a healthy counter.
  Measured on production, on the anonymous bucket through `/health` when its cap was 500: five calls 1.5 seconds apart read 499, 498, 499, 497, 498, and twelve calls read 499, 499, 496, 495, 494, 493, 492, 491, 490, 498, 489, 488.
  A bare "remaining must fall" is not enough either: a mis-forward that put every visitor under one `site:<address>` key would pass it.
  So the gate is also that **two different visitors each read `X-RateLimit-Bucket: site-ip` and `X-RateLimit-Caller: site`, and each starts at the cap minus one (1999)**, one per visitor.
  That cannot be observed from the website as it ships, so it is observed from a throwaway Worker, before the website is promoted:
  deploy a Worker in the same Cloudflare account with `[[services]]`, `binding = "API"` and `service = "nemar-api"` and no `entrypoint`, so that the binding reaches the default entrypoint this decision is about;
  have it call a cheap anonymous read such as `/health` over the binding with `X-Forwarded-For` set to a reserved documentation address, 203.0.113.201 for one visitor and 203.0.113.202 for the other, and return the `X-RateLimit-Bucket`, `X-RateLimit-Remaining` and `X-RateLimit-Caller` values from each answer;
  expect `site-ip`, `site`, and a first remaining of 1999 for each visitor that falls overall across six or more calls a second or two apart;
  then delete the Worker.
  A service binding has no URL, so there is nothing to call by hand, and the API never logs `remaining`.
  The website's `reportBucket` logs `remaining` once per bucket kind per isolate, so it cannot show a fall either.
  The only automated check is the website's own stuck-counter warning, `the API's rate-limit count did not fall over 4 calls for one visitor`, which one isolate raises once when three comparisons in a row, between calls one to ten seconds apart, show no fall (website pull request #450).
  It detects that one failure and no other, and "no log means fine" is not evidence.
  Website pull request #450, already merged to staging, is a prerequisite of the deploy and not a nicety:
  it is the only detector for "put resolves but nothing persists" and for a binding call that carries a `CF-Connecting-IP` after all.
  The development Worker bypasses the limiter, so the site-identity rule, the fixed windows (ADR 0099) and the stall breaker (the amendment below) have never run on a deployed Worker.
  When the release reaches production, tail the API Worker from `backend/`:
  `bunx cfman wrangler --account sccn tail nemar-api --search "[rate-limit]"`, and keep watching it while a few website pages load.
  A line `counting a request without CF-Connecting-IP by its forwarded visitor` (once per isolate per window for each source, bucket and reason, with no repeats, and never for a token bucket) means the hypothesis about the missing header holds.
  A warning `request with neither` means the website is not forwarding a usable visitor, and says why;
  its responses carry `X-RateLimit-Caller: unattributed`.
  No such line, with the website working, means a binding call carries a `CF-Connecting-IP` after all:
  its requests are in `ip`, nothing has regressed and nothing has improved, and this ADR needs an amendment.
  After the deploy that carries the stall breaker (amendment of 2026-10-12), watch the same tail for `[rate-limit] the cache keeps stalling`, and for the fault line with `error: "CacheSkippedError"`.
  How often the production Cache API stalls is not known; the breaker's three constants (three stalls, a 60-second window, a 10-second cool-down) are the knob if that line shows it opening on blips or staying open.
- **What an absent header means, and what it does not.**
  The `X-RateLimit-*` headers are set on the finished response, so a handler that builds its own `Response` keeps them.
  An answer without them was not announced as counted: the development Worker, a bypass, a cache fault (which is logged, once per window per bucket kind and again at the milestones described below), or an observe-only count.
  That last is the zarr redirect path, which counts a request against the shared bucket and never announces it, so "no headers" does not mean "not counted" there.
  They are not proof of a count either: the data plane hands its write to `waitUntil`, so its answer states a count whether or not the write lands, and a failing `put` there leaves `X-RateLimit-Remaining` unchanged while the line is logged.
  The overall fall in `X-RateLimit-Remaining` described above is the evidence; the header's presence alone is not.
- **The limiter reports its own faults and does not wait on the cache for ever.**
  A repaired counter record, a damaged admin-flag record found (which is then read again from the database and replaced if the database and the write allow), a refusal, and a cache fault are each logged once per window per bucket kind (refusals and identities also per caller source, a fault, and the admin-flag lookup's, also per phase and error class, so a transient stall in a write cannot hide a persistent bug of another class in the same phase; a class not on a short list counts as `other`, which bounds the key space), by name and never with an address or a message.
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
  That is now built as a breaker with a probe rather than a latch to the window's end: see the amendment of 2026-10-12 below.
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

## Open follow-ups, and where the verification gate stands (2026-10-12)

The change that carries this decision filed these follow-ups, none built:

- **#1712: downgrade the site-caller identity line** to a counter, or remove it, once production keying is confirmed.
  Its done-when is that "How to verify after the first deploy" above says the gate was passed, and when.
- **#1716: a Worker-side canary** that logs when a counted site request did not persist.
  Today the only detector of a counter that does not persist is on the website side (pull request #450).
- **#1717: send forwarded non-public addresses to the unattributed bucket.**
  Decision 2 refuses only the placeholders and loopback, so an RFC 1918, CGNAT, link-local or unique local address still becomes a `site:` key and would pool the visitors behind it.
- **#1718: a coarse counter for the whole class of site callers,** so that a forward that minted unlimited fresh `site:` keys would trip a visible limit.
  It is an owner decision, filed and not built, and its cap is a judgment about the website's headroom.

#1713 and #1715, filed with them, are settled by the two amendments below.

**The verification gate has not been run.**
The check in "How to verify after the first deploy" (the count falling across calls for one visitor, and two visitors that each read `site-ip` and start at 1999) needs the change released to production and the website promoted to call the binding, and neither has happened.
Until it is run, that a service-binding call carries no `CF-Connecting-IP`, and that the counter persists for one, are the hypotheses this ADR says they are.
The gate closes with #1712, after the release and the website promotion, and this ADR then says it was passed and when.

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

## Amendment 2026-10-12 (#1715): a cache that keeps stalling is skipped, not waited on

The verdict stands: every limiter call to the Cache API is bounded at 500 ms, and a call that does not answer fails open.
What changes is the cost of a stall that lasts.
The bound remembered nothing, so while the cache stayed stalled every request paid it in each place it used the cache.

1. **Each isolate keeps a breaker in front of every limiter call to the Cache API** (`cacheCall` in `backend/src/middleware/rateLimit.ts`):
   the counter's lookup, read and write, the admin flag's lookup, read and write, and the miss and private-grant budgets, deferred writes included.
2. **Three stalls within 60 seconds open it.**
   Only a call that hit the 500 ms bound counts; a call that fails fast cost no time and stays the fault line's business.
   One stall never opens it, so a single slow call cannot switch counting off.
3. **An open breaker skips the cache at once for 10 seconds.**
   Nothing but a probe that stalls extends that, so traffic cannot hold it open.
4. **Then one call is the probe.**
   The calls behind it keep skipping until it reports, so a recovering cache is not met by a crowd of waits.
   A probe that answers, with a value or with a fast error, closes the breaker and forgets the stalls; one that stalls opens it for another 10 seconds.
   A probe that never reports is replaced after one cool-down.
5. **Fail-open is unchanged for a fault and is new for a stall.**
   A call that throws failed open before this release: the request was served and not counted.
   A call that never answered did not: the counter's lookup was awaited without a bound, so the request waited on the stall.
   Now every call is bounded at 500 ms and then fails open, and an open breaker skips the cache at once.
   So while a stall lasts every bucket fails open, and counting is off on the isolate for 10 seconds at a time.
   A skipped call is treated exactly as a stalled call was, without the wait:
   the request is served and not counted, with the headers a stalled call would have left it (see "What an absent header means" above),
   the admin-flag lookup answers "not an admin", and the miss and private-grant budgets allow.
   The breaker never refuses a request and never counts one.
   The price is that counting stays off on an isolate for up to 10 seconds after the cache recovers.
   **That includes the strict `auth-ip` bucket,** ten a window per address on the `AUTH_PATHS` family, whose purpose is to bound email and GitHub spend.
   A caller can see it happen, because the responses lack the `X-RateLimit-*` headers while it lasts.
   What bounds that spend meanwhile is what each handler enforces, and not every strict path has a bound:
   - The emailed-code requests count `auth_codes` rows per email (`PER_MINUTE_LIMIT` of 1 and `PER_HOUR_LIMIT` of 5 in `services/auth-code.ts`), with a per-account count on the two session-bound ones (the header of `routes/auth-web.ts`).
   - A wrong code is counted per code: the fifth wrong guess consumes it (`MAX_CODE_ATTEMPTS`, `recordFailedAttempt` in `routes/auth-web.ts`).
   - `POST /auth/request-key-regeneration` has no limit of its own: each call mails the address and replaces the stored token.
   - `POST /users/me/upload-access/request` has none this amendment could verify.
     An attempt that is refused after the GitHub lookup writes nothing, so it is replayable, which is why `AUTH_PATHS` lists it.
     Once a request is stored and the admins have been told, a repeat is answered without mailing or looking anything up.

   Whether the strict buckets should fail closed during a stall instead was considered and is not decided here.
   The options (keep failing open and record the compensating limits, fail the strict buckets closed while the breaker is open, or fail closed only on the routes that spend money or send email) are tracked in #1745.
   No production stall has been recorded, so the risk is unmeasured.
6. **The state is one record per isolate:** at most three timestamps and an end time, never per caller or per bucket, because a stall is a property of the platform.
   Isolates and data centers do not share it, as they do not share the counters.
   An evicted isolate's replacement starts closed and pays its own stalls before it opens,
   so a stall that lasts costs each isolate three bounded waits to open and then one probe every 10 seconds, instead of a wait on every request.
7. **It reports itself without flooding the log.**
   Opening (`[rate-limit] the cache keeps stalling; skipping it and failing open`, with `trigger: stalls | probe`) and closing (`the cache answered again`) are each one line per window per isolate, with the milestone repeats every limiter log has.
   Every skipped call goes to the fault line of its bucket kind and phase with `error: "CacheSkippedError"`, so the skipped requests are counted there by `suppressed`.

Why these numbers.
Three, because a token request makes two cache calls before it fails open (the admin flag and the counter), so three stalls means at least two requests met the stall.
A window of 60 seconds, so a stall that lasts is caught at a few requests a minute too; three isolated slow calls inside one minute on one isolate is itself a cache in trouble, and the cost of treating it as one is 10 seconds uncounted.
A cool-down of 10 seconds rather than the rest of the window, so counting resumes soon after a recovery while a stall that lasts costs one probe every 10 seconds.

Receipts: `backend/test/rate-limit-cache-breaker.test.ts` drives the real limiter with the harness's cache made to stall.
It fails when the breaker never opens, never closes, opens on one stall, keeps its state per caller key, keeps an unbounded list, lets a skipped call or a late stall extend the cool-down, holds it open for longer than one cool-down after the clock went backwards, counts a fast failure as a stall, ignores the 60-second window, closes on a probe that stalls or reopens without saying so, lets more than one probe through, keeps the old stalls after recovering, refuses instead of failing open, stops reporting a skipped call, or logs every opening;
and it fails when any one of the limiter's cache calls is taken out from behind the breaker: the lookups, the record reads and the writes of the counter, the admin flag and the miss budget, the data plane's and the miss budget's writes handed to `waitUntil` and their no-`waitUntil` fallbacks.
Nothing here was observed on the deployed Worker; no production stall has been recorded.

## Amendment 2026-10-12 (#1713): the observe-only line names its caller by a keyed pseudonym

The limiter's lines say a bucket's name and never an address (above).
One line did carry one in effect: the observe-only warning, `[rate-limit] observe-only bucket would have tripped`, logged `ipHash` as a plain SHA-256 of the bucket key.
An IPv4 address hashed that way is recovered by hashing all 2^32 of them, and a `site:<address>` key from decision 3 is no harder.

1. **`ipHash` is now an HMAC-SHA-256 of the bucket key under a key derived for this purpose alone** (`backend/src/services/log-pseudonym.ts`).
   The key is derived from `ENCRYPTION_KEY`, an existing Worker secret, with HKDF-SHA-256 (RFC 5869, empty salt, info `nemar/log-pseudonym/v1`).
   No new secret is needed.
   The derivation keeps this use apart from the secret's others (the sign-in code hashes, the ORCID state and pending-signup signatures, the stored-credential encryption):
   nothing they compute is a pseudonym, and no pseudonym is anything they would accept.
2. **The same caller gets the same pseudonym** for as long as the secret is unchanged, so lines about one caller can still be put together.
   Someone holding the secret can still enumerate addresses; the secret is the boundary, as it is for the code hashes.
3. **With no `ENCRYPTION_KEY` the field is left out.**
   An unkeyed hash in its place would be the reversible value this removes, under a name that suggests otherwise.
4. **The field keeps its name, `ipHash`,** although the value is a pseudonym and the key can be `site:<address>`, so a log query written for it still finds it.

Not changed here, and a decision of its own, tracked in issue #1733: `hashIp` (`backend/src/services/web-session.ts`) is still a plain SHA-256,
and its other callers store that value with web, docs and private-site sessions and in the device sign-in audit details.
Nothing reads those columns back to compare them, so moving them to a keyed value would break no lookup, but it changes what stored rows mean and is outside the limiter.
Existing rows cannot be rekeyed, since the address is not stored; a label of its own (for example `nemar/session-ip/v1`) would reuse the same module.

The construction is the convention for any further purpose-specific key taken from `ENCRYPTION_KEY`: HKDF-SHA-256 with a label of the form `nemar/<purpose>/v<n>`, one label per purpose, never reused.

Receipts: `backend/test/rate-limit-log-pseudonym.test.ts` checks the logged value against values computed independently in Python's `hmac` and `hashlib`,
and fails when the value is an unkeyed SHA-256, an HMAC under the bare secret, derived without the label, the raw key, present without a secret, or when a failed derivation is kept for the isolate's life.
