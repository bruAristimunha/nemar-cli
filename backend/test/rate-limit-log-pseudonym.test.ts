/**
 * The observe-only warning names its caller by a keyed pseudonym (#1713).
 *
 * It used to log `ipHash` as a plain SHA-256 of the bucket key, which anyone can
 * reverse for an IPv4 address by hashing all 2^32 of them. It is now an HMAC-SHA-256
 * under a key derived from ENCRYPTION_KEY with HKDF-SHA-256 (`services/log-pseudonym.ts`),
 * and with no key the field is left out.
 *
 * Real WebCrypto throughout. The expected values were computed outside this code, with
 * Python's `hmac` and `hashlib` implementing RFC 5869 HKDF (empty salt, info
 * `nemar/log-pseudonym/v1`, 32 bytes) and then HMAC-SHA-256 of the key:
 *
 *   k = hkdf(b"log-pseudonym-test-key-not-a-real-secret", b"", b"nemar/log-pseudonym/v1")
 *   hmac.new(k, b"203.0.113.7", hashlib.sha256).hexdigest()
 *
 * so a test that passes says the Worker derives the standard construction, not merely
 * that it agrees with itself.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { __limits } from "../src/middleware/rateLimit";
import { LOG_PSEUDONYM_INFO, logPseudonym } from "../src/services/log-pseudonym";
import { hashIp } from "../src/services/web-session";
import type { Bindings } from "../src/types/bindings";
import {
  PROD_ENV,
  T0,
  buildApp,
  edge,
  hit,
  useRateLimitHarness,
  viaBinding,
} from "./helpers/rate-limit-harness";

const h = useRateLimitHarness();

const KEY = "log-pseudonym-test-key-not-a-real-secret";
const OTHER_KEY = "another-key-for-the-same-test";
const ADDRESS = "203.0.113.7";

/** Computed with Python, independently of this code; see the file comment. */
const EXPECTED = {
  edge: "17d3117026e7a4710621f292b361feb64bf58d52278d08f54f972070b4d20e7d",
  site: "6508820ede55478575b7a30d00a37808251bfd1716a61bce203a673fdedfaf67",
  otherKey: "72e10a5f9c700076a2b6705cd15baa51f1f97c47e6350e47b57e2144a5a6dcd3",
  /** What the line used to carry: SHA-256 of the address, reversible by enumeration. */
  plainSha256: "fec52565aa0cf18f57d7cf5b3ac728503b8992d2d6f7d46da1d1201090902b02",
  /** HMAC under the secret itself, which the derivation exists to avoid. */
  rawSecretHmac: "56f79fb4b703c4d643fb222f7c404bcfd7eeaacd058d9a6fc2d80ba7f46b8dbb",
};

const TRIPPED = "[rate-limit] observe-only bucket would have tripped";
const tripped = () => h.warn.mock.calls.filter((c) => c[0] === TRIPPED);

const withKey = (secret: string | undefined) =>
  ({ ...PROD_ENV, ENCRYPTION_KEY: secret }) as Bindings;

/** Put a bucket at its cap, so the next observe-only request is the one that warns. */
function atCap(bucketKey: string, cap: number): Promise<void> {
  return h.seed(bucketKey, { count: cap, warned: false, windowEnd: T0 + 30_000 });
}

async function warnFor(headers: Record<string, string>, env: Bindings) {
  const res = await hit(buildApp({ observeOnly: true }), headers, "/datasets", env);
  expect(res.status).toBe(200);
  expect(tripped().length).toBe(1);
  return tripped()[0]?.[1] as Record<string, unknown>;
}

describe("the observe-only warning", () => {
  test("names a public caller by the keyed pseudonym of its address", async () => {
    await atCap(`ip:${ADDRESS}`, __limits.MAX_REQUESTS);
    const line = await warnFor(edge(ADDRESS), withKey(KEY));
    expect(line.ipHash).toBe(EXPECTED.edge);
    // Not what it used to be, and not an HMAC under the bare secret.
    expect(line.ipHash).not.toBe(await hashIp(ADDRESS));
    expect(EXPECTED.plainSha256).toBe((await hashIp(ADDRESS)) as string);
    expect(line.ipHash).not.toBe(EXPECTED.rawSecretHmac);
    expect(JSON.stringify(line)).not.toContain(ADDRESS);
    // The rest of the line is as it was.
    expect(line).toMatchObject({ path: "/datasets", count: __limits.MAX_REQUESTS + 1 });
  });

  test("names a forwarded visitor by the pseudonym of its `site:` key", async () => {
    await atCap(`site-ip:site:${ADDRESS}`, __limits.SITE_IP_MAX_REQUESTS);
    const line = await warnFor(viaBinding(ADDRESS), withKey(KEY));
    expect(line.ipHash).toBe(EXPECTED.site);
    expect(JSON.stringify(line)).not.toContain(ADDRESS);
  });

  test("gives a different pseudonym under a different key, so a reader without the key cannot recompute it", async () => {
    await atCap(`ip:${ADDRESS}`, __limits.MAX_REQUESTS);
    const line = await warnFor(edge(ADDRESS), withKey(OTHER_KEY));
    expect(line.ipHash).toBe(EXPECTED.otherKey);
    expect(line.ipHash).not.toBe(EXPECTED.edge);
  });

  test.each([
    ["no ENCRYPTION_KEY", undefined],
    ["an empty ENCRYPTION_KEY", ""],
  ])("leaves the field out with %s, rather than log an unkeyed hash", async (_label, secret) => {
    await atCap(`ip:${ADDRESS}`, __limits.MAX_REQUESTS);
    const line = await warnFor(edge(ADDRESS), withKey(secret));
    expect("ipHash" in line).toBe(false);
    expect(JSON.stringify(line)).not.toContain(EXPECTED.plainSha256);
    expect(line).toMatchObject({ path: "/datasets", count: __limits.MAX_REQUESTS + 1 });
    // The count was still recorded: a missing key costs the log field, not the count.
    expect((await h.stored(`ip:${ADDRESS}`))?.count).toBe(__limits.MAX_REQUESTS + 1);
  });
});

describe("logPseudonym", () => {
  test("is the standard HKDF and HMAC construction under its own label", async () => {
    expect(LOG_PSEUDONYM_INFO).toBe("nemar/log-pseudonym/v1");
    expect(await logPseudonym(KEY, ADDRESS)).toBe(EXPECTED.edge);
    expect(await logPseudonym(KEY, `site:${ADDRESS}`)).toBe(EXPECTED.site);
    expect(await logPseudonym(undefined, ADDRESS)).toBeNull();
  });

  test("forgets a derivation that failed, so one platform fault does not last the isolate's life", async () => {
    // A key no earlier test derived, so this call has to derive it.
    const fresh = "a-key-derived-for-the-first-time-here";
    const importKey = spyOn(crypto.subtle, "importKey").mockImplementationOnce(() =>
      Promise.reject(new TypeError("importKey is unavailable")),
    );
    try {
      await expect(logPseudonym(fresh, ADDRESS)).rejects.toThrow("importKey is unavailable");
    } finally {
      importKey.mockRestore();
    }
    const again = await logPseudonym(fresh, ADDRESS);
    expect(again).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toBe(await logPseudonym(fresh, ADDRESS));
  });
});
