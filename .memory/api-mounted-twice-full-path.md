---
name: api-mounted-twice-full-path
description: "nemar-cli backend mounts the api sub-app at both / and /nemar, and Hono gives middleware the FULL request path, so any path-matching middleware must strip the prefix or it silently matches nothing for one spelling"
metadata:
  node_type: memory
  type: project
---

`backend/src/index.ts` does **both** `app.route("/nemar", api)` and `app.route("/", api)`.
Hono's `route()` strips the prefix for ROUTING but middleware registered inside `api`
(`api.use("*", ...)`) still sees `c.req.path` as the FULL original path.

So any middleware that matches on a path literal sees `/nemar/auth/login` for one of the two
live spellings and matches nothing.

**Why:** this is how every `AUTH_PATHS` entry in `middleware/rateLimit.ts` sat unthrottled for
anyone who typed the prefix, found reviewing PR #1384 (2026-09-13). The strict 10/min per-IP
floor on `/auth/login`, `/auth/code/request`, `/auth/keys` and the device-flow routes fell to
the anonymous `ip` bucket (500 a minute then; 1000 per fixed 60-second window now, ADR 0098 and
ADR 0099), or with a bearer to the 1000/min token bucket plus the admin bypass in
`isPrivilegedToken`. Owner's calibration: low impact, patch it, do not escalate, because CF
edge ceilings and the per-email code limit still applied and the API is read-only without a key.

**How to apply:** `__normalizeMountPath` in `middleware/rateLimit.ts` is the fix for that one
middleware, and bucket selection now goes through it. It is NOT applied globally, so a NEW
path-matching middleware has the same trap waiting. Verify empirically rather than reasoning
about Hono's semantics: mount a probe sub-app at both paths, log `c.req.path` from inside it,
and assert both spellings. See [[verify-fix-against-known-broken]] and
[[test-entry-point-not-callee]].
