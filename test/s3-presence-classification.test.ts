/**
 * Telling "the object is not there" from "the question did not get asked" (#1380, #1392).
 *
 * This classification is the entire reason `headS3Objects` and `probeS3PrefixAccess`
 * exist rather than a bare exit-code check. `s3://nemar` denies anonymous
 * ListBucket, so S3 answers a missing key with 403 as readily as it answers an
 * expired session or a signature with no session token -- and a migration that
 * reads those alike either strands content or refuses a healthy dataset.
 *
 * Driven against a real `aws` executable on PATH: a shim that prints the strings
 * the AWS CLI actually prints. No library is stubbed and no return value is
 * replaced; the code under test shells out exactly as it does in production.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headS3Objects, probeS3PrefixAccess } from "../src/lib/aws-cli";

const CREDENTIALS = {
  access_key_id: "ASIAEXAMPLE",
  secret_access_key: "secret",
  session_token: "token",
};

let shimDir: string;
let realPath: string | undefined;
const scratch: string[] = [];

/**
 * Install an `aws` on PATH whose behavior is chosen per key by `script`.
 * `--version` always succeeds, because `isAwsCliAvailable` asks that first.
 */
function installAwsShim(body: string): void {
  writeFileSync(
    join(shimDir, "aws"),
    `#!/bin/sh
case "$1" in
  --version) echo "aws-cli/2.0.0 shim"; exit 0 ;;
esac
${body}
`,
  );
  chmodSync(join(shimDir, "aws"), 0o755);
}

beforeEach(() => {
  shimDir = mkdtempSync(join(tmpdir(), "nemar-aws-shim-"));
  scratch.push(shimDir);
  realPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${realPath ?? ""}`;
});

afterEach(() => {
  // Reflect.deleteProperty, not `= undefined`: Bun would store the STRING "undefined" as PATH.
  if (realPath === undefined) Reflect.deleteProperty(process.env, "PATH");
  else process.env.PATH = realPath;
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("headS3Objects", () => {
  test("a 404 is absent and a 403 is unconfirmed, from the same command", async () => {
    // The distinction the whole module rests on. Both are non-zero exits; only the
    // message separates an answer from a refusal to answer.
    installAwsShim(`
case "$*" in
  *missing-key*) echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254 ;;
  *forbidden-key*) echo "An error occurred (403) when calling the HeadObject operation: Forbidden" >&2; exit 254 ;;
  *) echo '{"ContentLength": 10}'; exit 0 ;;
esac`);

    const seen = await headS3Objects({
      credentials: CREDENTIALS,
      bucket: "nemar",
      region: "us-east-2",
      prefix: "on007788/objects",
      keys: ["good-key", "missing-key", "forbidden-key"],
    });

    expect(seen.find((k) => k.key === "good-key")?.outcome).toBe("present");
    expect(seen.find((k) => k.key === "missing-key")?.outcome).toBe("absent");
    const forbidden = seen.find((k) => k.key === "forbidden-key");
    expect(forbidden?.outcome).toBe("unknown");
    expect(forbidden?.detail).toContain("403");
  }, 60_000);

  test("a key with no aws CLI at all is unknown, never absent", async () => {
    // A machine that cannot ask has not learned that the content is missing.
    process.env.PATH = shimDir; // nothing on PATH, not even the shim
    const seen = await headS3Objects({
      credentials: CREDENTIALS,
      bucket: "nemar",
      region: "us-east-2",
      prefix: "on007788/objects",
      keys: ["some-key"],
    });
    expect(seen[0].outcome).toBe("unknown");
    // Whatever the message is, it names the tool and does NOT claim the object is
    // missing: the machine could not ask.
    expect(seen[0].detail).toContain("aws");
    expect(seen[0].outcome).not.toBe("absent");
  }, 60_000);

  test("an empty key list asks nothing", async () => {
    expect(
      await headS3Objects({
        credentials: CREDENTIALS,
        bucket: "nemar",
        region: "us-east-2",
        prefix: "on007788/objects",
        keys: [],
      }),
    ).toEqual([]);
  }, 60_000);
});

describe("probeS3PrefixAccess", () => {
  test("an AccessDenied is refused", async () => {
    installAwsShim(`
echo "An error occurred (AccessDenied) when calling the ListObjectsV2 operation: Access Denied" >&2
exit 254`);
    const probe = await probeS3PrefixAccess({
      credentials: CREDENTIALS,
      bucket: "nemar",
      region: "us-east-2",
      prefix: "on007788/objects",
    });
    expect(probe.outcome).toBe("refused");
  }, 60_000);

  test("a network failure is inconclusive, not refused", async () => {
    // Reporting this as `refused` sent the operator to `credential-check` for what
    // was a dropped connection, and aborted the migration before it started.
    installAwsShim(`
echo "Could not connect to the endpoint URL: \\"https://nemar.s3.us-east-2.amazonaws.com/\\"" >&2
exit 255`);
    const probe = await probeS3PrefixAccess({
      credentials: CREDENTIALS,
      bucket: "nemar",
      region: "us-east-2",
      prefix: "on007788/objects",
    });
    expect(probe.outcome).toBe("inconclusive");
    expect(probe.detail).toContain("Could not connect");
  }, 60_000);

  test("an empty prefix is its own outcome, not a refusal", async () => {
    installAwsShim(`echo "None"; exit 0`);
    const probe = await probeS3PrefixAccess({
      credentials: CREDENTIALS,
      bucket: "nemar",
      region: "us-east-2",
      prefix: "on007788/objects",
    });
    expect(probe.outcome).toBe("empty-prefix");
  }, 60_000);

  test("listing then reading an object is reachable", async () => {
    installAwsShim(`
case "$2" in
  list-objects-v2) echo "on007788/objects/KEY1"; exit 0 ;;
  head-object) echo '{"ContentLength": 10}'; exit 0 ;;
esac
exit 1`);
    const probe = await probeS3PrefixAccess({
      credentials: CREDENTIALS,
      bucket: "nemar",
      region: "us-east-2",
      prefix: "on007788/objects",
    });
    expect(probe.outcome).toBe("reachable");
    expect(probe.object).toBe("on007788/objects/KEY1");
  }, 60_000);
});
