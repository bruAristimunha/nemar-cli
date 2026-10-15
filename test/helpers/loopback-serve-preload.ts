/**
 * Preloaded for every `bun test` run (bunfig.toml): a `Bun.serve()` that names no interface
 * listens on loopback only.
 *
 * Why. The fake registrars, mail servers and S3 stand-ins in these suites call
 * `Bun.serve({ port: 0 })` and are reached at 127.0.0.1. Bun's default is a wildcard bind,
 * and on macOS a wildcard bind succeeds on a port some other process already holds on
 * 127.0.0.1 specifically (workerd, node, a VPN agent). The kernel sends 127.0.0.1 traffic to
 * the more specific listener, so the request is answered by a stranger: a 200 "ok", a 404, a
 * 401 "auth required", a 500, and the fake records no call. Measured on a developer machine
 * with other sessions running: 8 of 6,000 fetches to a fresh `port: 0` server were answered by
 * a foreign listener, every one on a port another process held, and 0 of 6,000 once the
 * server bound 127.0.0.1 explicitly. That is how a test such as email-delivery-fence's
 * "production bypasses the allow-list" fails once in a few dozen runs under load and then
 * passes on the rerun. A CI runner has no foreign listeners, so the same suites never show it.
 *
 * Binding the loopback address means the kernel refuses a port that is taken there, which
 * is the collision the wildcard bind hid. A caller that names `hostname` (or `unix`) keeps
 * what it asked for.
 */

const serve = Bun.serve.bind(Bun) as (...args: unknown[]) => unknown;

// `hostname: undefined` names nothing, so it gets the loopback default too. A call with no
// options at all is passed through untouched, so Bun's own error is what the caller sees.
(Bun as { serve: unknown }).serve = (...args: unknown[]) => {
  const options = args[0];
  if (typeof options !== "object" || options === null) return serve(...args);
  const given = options as Record<string, unknown>;
  if (given.hostname !== undefined || given.unix !== undefined) return serve(...args);
  return serve({ ...given, hostname: "127.0.0.1" }, ...args.slice(1));
};
