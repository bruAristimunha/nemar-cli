/**
 * Unit tests for the bucket-selector portion of the rate-limit middleware.
 * The admin bypass itself depends on D1 + caches.default and is covered by
 * post-deploy assertion (an admin token must succeed at >500/60s and a
 * non-admin token must 429 at the 501st call); structural tests here pin
 * the selector logic that decides which bucket a request lands in.
 */

import { describe, expect, test } from "bun:test";
import {
  __limits,
  __readBearerTokenFromHeader,
  __selectBucket,
} from "../backend/src/middleware/rateLimit";

const VALID_TOKEN = "n".repeat(40);

describe("__readBearerTokenFromHeader", () => {
  test("returns the token when prefix + length are valid", () => {
    expect(__readBearerTokenFromHeader(`Bearer ${VALID_TOKEN}`)).toBe(VALID_TOKEN);
  });

  test("returns null for missing header / wrong scheme / too short", () => {
    expect(__readBearerTokenFromHeader(undefined)).toBeNull();
    expect(__readBearerTokenFromHeader("Basic abc")).toBeNull();
    expect(__readBearerTokenFromHeader("Bearer ")).toBeNull();
    expect(__readBearerTokenFromHeader("Bearer abc")).toBeNull();
    expect(__readBearerTokenFromHeader("Bearer 0123456789")).toBeNull();
  });
});

describe("__selectBucket", () => {
  test("auth endpoints use the stricter ip-keyed bucket regardless of bearer", () => {
    const r = __selectBucket("/auth/login", `Bearer ${VALID_TOKEN}`, "1.2.3.4");
    expect(r.keyKind).toBe("auth-ip");
    expect(r.maxRequests).toBe(10);
    expect(r.rawKey).toBe("1.2.3.4");
  });

  test("authenticated non-auth endpoints get the token bucket at 1000/60s", () => {
    const r = __selectBucket("/datasets", `Bearer ${VALID_TOKEN}`, "1.2.3.4");
    expect(r.keyKind).toBe("token");
    // Tracks TOKEN_MAX_REQUESTS_AUTHED in rateLimit.ts (bumped 500 → 1000
    // in #639 to absorb Worker-egress IP pooling on the website SSR path).
    expect(r.maxRequests).toBe(1000);
    expect(r.rawKey).toBe(VALID_TOKEN);
  });

  test("unauthenticated non-auth endpoints fall back to the ip bucket at 1000/60s", () => {
    const r = __selectBucket("/datasets", undefined, "1.2.3.4");
    expect(r.keyKind).toBe("ip");
    // Tracks MAX_REQUESTS in rateLimit.ts (bumped 100 → 500 in #639, 500 → 1000 in #1709).
    expect(r.maxRequests).toBe(1000);
    expect(r.rawKey).toBe("1.2.3.4");
  });

  test("syntactically-bad bearer falls through to ip bucket (no false escalation)", () => {
    const r = __selectBucket("/admin/datasets", "Bearer short", "1.2.3.4");
    expect(r.keyKind).toBe("ip");
    expect(r.maxRequests).toBe(1000);
  });

  test("public data-plane paths get the generous data-ip bucket, IP-keyed", () => {
    // data.nemar.org/<id>/<v>/<path> is rewritten to /data/<...> in index.ts.
    for (const path of [
      "/data",
      "/data/",
      "/data/nm000132",
      "/data/nm000132/1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf",
      "/data/nm000132/metadata.json",
      "/nemar/data/nm000132/1.0.0/manifest.json",
    ]) {
      const r = __selectBucket(path, undefined, "1.2.3.4");
      expect(r.keyKind).toBe("data-ip");
      expect(r.maxRequests).toBe(__limits.DATA_MAX_REQUESTS);
      expect(r.rawKey).toBe("1.2.3.4");
    }
  });

  test("data-plane bucket wins even when a valid bearer is present (public read)", () => {
    const r = __selectBucket("/data/nm000132/1.0.0/x.edf", `Bearer ${VALID_TOKEN}`, "1.2.3.4");
    expect(r.keyKind).toBe("data-ip");
    expect(r.rawKey).toBe("1.2.3.4");
  });

  test("the management API at /datasets is NOT mistaken for the data plane", () => {
    // Anchored regex must not let /datasets/* leak into the generous bucket.
    const anon = __selectBucket("/datasets", undefined, "1.2.3.4");
    expect(anon.keyKind).toBe("ip");
    expect(anon.maxRequests).toBe(1000);
    const authed = __selectBucket("/datasets/nm000132", `Bearer ${VALID_TOKEN}`, "1.2.3.4");
    expect(authed.keyKind).toBe("token");
  });
});
