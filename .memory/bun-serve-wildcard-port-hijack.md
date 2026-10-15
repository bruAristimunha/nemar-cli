---
name: bun-serve-wildcard-port-hijack
description: a test's Bun.serve({ port: 0 }) fake can be answered by ANOTHER process's loopback listener on macOS; the preload binds loopback, and a test that fails once under load should be checked for this before it is retried
metadata:
  type: project
---

Found chasing a flake in `backend/test/email-delivery-fence.test.ts` (2026-10-14). A fetch to a fresh
`Bun.serve({ port: 0 })` fake came back with a status and body the fake never produced: a 200 `ok`, a
404, a 401 `auth required`, a 500 with an internal-error reference, and the fake had recorded no call.

**Cause:** Bun's default bind is a wildcard. On macOS a wildcard bind succeeds on a port that another
process already holds on `127.0.0.1` specifically, and the kernel sends `127.0.0.1` traffic to the more
specific listener. Other sessions' dev servers, or a VPN agent, hold such ports, so the fake and the
stranger share one. Reproduced deterministically: a `Bun.serve({ hostname: "127.0.0.1" })` stranger on
port P, then `Bun.serve({ port: P })`; a fetch to `127.0.0.1:P` is answered by the stranger. Under load,
8 of 6,000 fetches to a fresh `port: 0` server were hijacked, every one on a port another process held;
with `hostname: "127.0.0.1"` it was 0 of 6,000. A CI runner has no foreign listeners, so CI never shows it.

**Fix in the repo:** `test/helpers/loopback-serve-preload.ts`, loaded by `bunfig.toml`, defaults every
`Bun.serve()` under `bun test` to `127.0.0.1`; `test/loopback-serve.unit.test.ts` pins it (a taken
loopback port is refused, not shared). A caller that passes `hostname` or `unix` keeps its choice. The
preload is read from the working directory, so run tests from the repository root.

**How to apply:** a test that fails once under load with a response nobody wrote, or a count of zero
calls on a fake that clearly answered, is this until proven otherwise; do not retry it. A client that
connects to `[::1]` no longer reaches a default fake (it is IPv4 only); `localhost` and `127.0.0.1` do.
