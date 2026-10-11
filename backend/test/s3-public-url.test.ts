/**
 * `buildPublicObjectUrl` (#1522): a low-level direct-S3 URL helper retained
 * for operational callers and path-compatibility checks. The manifest
 * contract uses stable data-plane URLs under ADR 0095.
 *
 * Two claims this pins, each checked for real rather than by inspection:
 *  - it builds the key's PATH the same way `generatePresignedGetUrl` does,
 *    so the object a client reaches is the exact one a presigned URL for the
 *    same key would have reached, just without the signature;
 *  - the URL it builds actually serves the object -- GET and Range -- against
 *    a real HTTP server standing in for S3 through the same `endpointUrl`
 *    override `fetchManifestObject` already uses.
 */

import { describe, expect, test } from "bun:test";
import { buildPublicAccessPolicy } from "../src/services/bucket-policy";
import {
  type PresignedUrlOptions,
  buildPublicObjectUrl,
  generatePresignedGetUrl,
  getBucketPolicy,
} from "../src/services/s3";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

function options(overrides: Partial<PresignedUrlOptions> = {}): PresignedUrlOptions {
  return {
    bucket: "nemar",
    region: "us-east-2",
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
    ...overrides,
  };
}

describe("buildPublicObjectUrl", () => {
  test("no query string, ever", () => {
    const url = buildPublicObjectUrl(options(), "nm000132/objects/SHA256E-s10--abcd.set");
    expect(url).toBe(
      "https://nemar.s3.us-east-2.amazonaws.com/nm000132/objects/SHA256E-s10--abcd.set",
    );
    expect(url).not.toContain("?");
  });

  test("rejects the same malformed keys generatePresignedGetUrl rejects, with the same message", async () => {
    for (const bad of ["../etc/passwd", "/absolute", "a\\b", "nm000132/objects/..%2f..%2fetc"]) {
      let publicErr: unknown;
      try {
        buildPublicObjectUrl(options(), bad);
      } catch (err) {
        publicErr = err;
      }
      let presignedErr: unknown;
      try {
        await generatePresignedGetUrl(options(), bad);
      } catch (err) {
        presignedErr = err;
      }
      expect(publicErr).toBeInstanceOf(Error);
      expect(presignedErr).toBeInstanceOf(Error);
      expect((publicErr as Error).message).toBe((presignedErr as Error).message);
    }
  });

  test("the same PATH the presigner builds, for keys with reserved and non-ASCII characters", async () => {
    const keys = [
      "nm000132/objects/SHA256E-s10--abcd1234.set",
      "nm000132/objects/MD5E-s5--with space.txt",
      "nm000132/objects/SHA256E-s5--pct%25encoded.tsv",
      "nm000132/objects/SHA256E-s5--unicode-éè.tsv",
      "nm000132/objects/SHA256E-s5--quote'paren(1).tsv",
    ];
    for (const key of keys) {
      const publicUrl = new URL(buildPublicObjectUrl(options(), key));
      const presigned = new URL(await generatePresignedGetUrl(options(), key, 3600, undefined));
      expect(publicUrl.pathname).toBe(presigned.pathname);
      expect(publicUrl.host).toBe(presigned.host);
    }
  });

  test("honors endpointUrl like fetchManifestObject does, unlike generatePresignedGetUrl", async () => {
    const key = "nm000132/objects/SHA256E-s10--abcd.set";
    const withEndpoint = buildPublicObjectUrl(options({ endpointUrl: "http://127.0.0.1:9" }), key);
    expect(withEndpoint).toBe(`http://127.0.0.1:9/${key}`);
    const withoutEndpoint = buildPublicObjectUrl(options(), key);
    expect(withoutEndpoint).toBe(`https://nemar.s3.us-east-2.amazonaws.com/${key}`);
  });
});

describe("buildPublicObjectUrl serves the object for real", () => {
  test("GET returns the full body and Range returns a slice, from a real server", async () => {
    const s3: S3ManifestStandin = startS3ManifestStandin();
    try {
      const key = "nm000132/objects/SHA256E-s24--abcd1234.set";
      const bytes = new TextEncoder().encode("0123456789abcdefghijklmn");
      s3.put(`/${key}`, bytes);

      const url = buildPublicObjectUrl(options({ endpointUrl: s3.url }), key);
      expect(url).toBe(`${s3.url}/${key}`);

      const full = await fetch(url);
      expect(full.status).toBe(200);
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

      const ranged = await fetch(url, { headers: { Range: "bytes=5-9" } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("Content-Range")).toBe(`bytes 5-9/${bytes.length}`);
      expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(5, 10));

      const suffix = await fetch(url, { headers: { Range: "bytes=-4" } });
      expect(suffix.status).toBe(206);
      expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-4));
    } finally {
      s3.stop();
    }
  });
});

describe("getBucketPolicy honors endpointUrl (#1522)", () => {
  test("reads the policy from the local stand-in, not the real AWS host", async () => {
    const s3: S3ManifestStandin = startS3ManifestStandin();
    try {
      s3.setBucketPolicy(buildPublicAccessPolicy("nemar", ["nm000111"]));
      const policy = await getBucketPolicy(options({ endpointUrl: s3.url }));
      expect(policy).toEqual(buildPublicAccessPolicy("nemar", ["nm000111"]));
    } finally {
      s3.stop();
    }
  });

  test("no policy set answers null, like a bucket with no policy attached", async () => {
    const s3: S3ManifestStandin = startS3ManifestStandin();
    try {
      const policy = await getBucketPolicy(options({ endpointUrl: s3.url }));
      expect(policy).toBeNull();
    } finally {
      s3.stop();
    }
  });
});
