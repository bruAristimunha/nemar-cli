---
name: router-decodes-path-before-matching
description: Hono matches routes on a decodeURI'd path, so a guard that tests the raw path is bypassable; test the path the router matches on, and decode the raw pathname yourself when reserved escapes matter
metadata:
  type: project
  recorded: 2026-11-04
  verified: 2026-11-13 (Hono 4.11.4)
  revalidate_after: 2027-02-04
---

A guard written as a prefix or equality test on the raw request path (for example on `new URL(request.url).pathname`) sees the encoded form of a request, while the router decodes the path before it matches a route.
A request that spells a guarded segment with percent-encoded characters is therefore not caught by the guard and is still routed to the guarded handler.
Found during the compute program (2026-11).

**Why it matters:** an authorization or refusal guard that can be skipped by re-spelling the URL is not a guard, and a test that only sends the canonical spelling cannot show it.

**What to do:**

- Test the same path the router matches on: use the router's own path accessor, not a hand-parsed URL.
- Put the guard where the router has already resolved the route (a middleware on the matched route, or the handler itself) rather than in front of the router.
- For every guard on a path, add a test that sends the percent-encoded spelling of the guarded segment and asserts the guard still applies.
- Which accessor decodes, and how far, depends on the router version: verify it on the version in use before relying on a recollection, and update this entry with the date.
- Verified on Hono 4.11.4 (2026-11-13): `c.req.path` applies only `decodeURI`, so unreserved escapes (`%2E`) decode but reserved ones (`%2B`, `%23`, `%26`, `%2F`) stay encoded. Route params are fully decoded. The URL parser collapses `%2E%2E` and `..` segments before routing.
- Exception: a handler that needs the fully decoded path (file and QA routes) may read `new URL(c.req.url).pathname` and decode it per segment (`bidsPathAfterMount`), provided the result then goes through `normalizeBidsPath`. Compare route params against decoded segments, never `indexOf` an escaped pathname.
