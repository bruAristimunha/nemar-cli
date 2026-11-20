/**
 * Upload step 9 renewing its S3 upload credentials, driven through `copyAnnexedToRemote`
 * against real git-annex and a real `directory` special remote named `nemar-s3`.
 *
 * Production renews through `renewLease`, which calls `POST /datasets/:id/upload-credentials`.
 * A transient server error on that call cannot be produced by a real NEMAR instance on demand,
 * so these tests give `copyAnnexedToRemote` a `renewLease` that answers the way the API client
 * does (it throws `ApiError` with the HTTP status) and check what the step then does with real
 * git-annex: before the fix, ONE HTTP 500 ended the whole upload (observed on a 30 TB private
 * upload, where it cost six multi-hour attempts in a row).
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { ApiError } from "../src/lib/api/errors";
import { type CredentialLease, RENEW_ATTEMPTS } from "../src/lib/upload/s3-copy-session";
import { copyAnnexedToRemote, listAnnexedPaths, trackDataFiles } from "../src/lib/upload/transfer";
import {
  initDirectoryRemote,
  makeScratch,
  newDatasetRepo,
  run,
  writeFile,
} from "./helpers/annex-repo";

setDefaultTimeout(60_000);

const REMOTE = "nemar-s3";
const scratch = makeScratch("nemar-renew-retry");
const credentials = { accessKeyId: "unused-by-directory-remote", secretAccessKey: "unused" };

beforeAll(async () => {
  const probe = await run(["git", "annex", "version"]);
  if (probe.exitCode !== 0) throw new Error("git-annex is required for this test file");
  // The waits between renewal tries shrink to 0 ms; the default is 5 s, doubling.
  process.env.NEMAR_RENEW_RETRY_DELAY_MS = "0";
});
afterAll(() => {
  Reflect.deleteProperty(process.env, "NEMAR_RENEW_RETRY_DELAY_MS");
  scratch.cleanup();
});

/** A tracked dataset whose lease is already inside the refresh margin, so step 9 renews first. */
async function datasetNeedingRenewal(name: string) {
  const dir = await newDatasetRepo(scratch.root, name);
  const targets = ["sub-01/eeg/a.edf", "sub-02/eeg/b.edf"].map((path) => {
    writeFile(dir, path, `${path}:`.padEnd(3_000, "x"));
    return { path, size: 3_000, type: "data" as const };
  });
  await initDirectoryRemote(scratch.root, dir, REMOTE);
  expect(
    (
      await trackDataFiles(
        dir,
        targets.map((t) => t.path),
      )
    ).success,
  ).toBe(true);
  return { dir, targets };
}

/** `renewLease` answering with the given HTTP statuses in turn (200 = a fresh 2 h lease). */
function renewAnswering(statuses: number[]) {
  const calls: number[] = [];
  const renewLease = async (): Promise<CredentialLease> => {
    const status = statuses[Math.min(calls.length, statuses.length - 1)];
    calls.push(status);
    if (status !== 200)
      throw new ApiError(status, status >= 500 ? "Internal Server Error" : "Forbidden");
    return { credentials, expiresAtMs: Date.now() + 2 * 60 * 60 * 1000 };
  };
  return { renewLease, calls };
}

async function step(
  dir: string,
  targets: Array<{ path: string; size: number; type: "data" }>,
  renewLease: () => Promise<CredentialLease>,
) {
  const renewed: string[] = [];
  const outcome = await copyAnnexedToRemote({
    absolutePath: dir,
    remote: REMOTE,
    addTargets: targets,
    dataFiles: targets,
    jobs: 2,
    credentials,
    lease: { credentials, expiresAtMs: Date.now() },
    renewLease,
    onCredentialsRenewed: (count, reason) => renewed.push(`${count}:${reason}`),
  });
  return { outcome, renewed };
}

describe("copyAnnexedToRemote: renewing upload credentials", () => {
  test("a renewal that gets HTTP 500 twice is tried again and the upload completes", async () => {
    const { dir, targets } = await datasetNeedingRenewal("renew-500-then-ok");
    const { renewLease, calls } = renewAnswering([500, 500, 200]);

    const { outcome, renewed } = await step(dir, targets, renewLease);

    expect(calls).toEqual([500, 500, 200]);
    expect(renewed).toHaveLength(1);
    expect(outcome.status).toBe("ok");
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set(targets.map((t) => t.path)));
  });

  test("a renewal refused with HTTP 403 is not tried again and nothing is copied", async () => {
    const { dir, targets } = await datasetNeedingRenewal("renew-403");
    const { renewLease, calls } = renewAnswering([403]);

    const { outcome, renewed } = await step(dir, targets, renewLease);

    expect(calls).toEqual([403]);
    expect(renewed).toHaveLength(0);
    expect(outcome.status).toBe("copy_failed");
    if (outcome.status !== "copy_failed") throw new Error("unreachable");
    expect(outcome.error).toBe("Could not renew upload credentials (close to expiry): Forbidden");
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set());
  });

  test("a renewal that keeps getting HTTP 500 stops after RENEW_ATTEMPTS tries and says so", async () => {
    const { dir, targets } = await datasetNeedingRenewal("renew-500-always");
    const { renewLease, calls } = renewAnswering([500]);

    const { outcome } = await step(dir, targets, renewLease);

    expect(calls).toHaveLength(RENEW_ATTEMPTS);
    expect(outcome.status).toBe("copy_failed");
    if (outcome.status !== "copy_failed") throw new Error("unreachable");
    expect(outcome.error).toBe(
      `Could not renew upload credentials (close to expiry) after ${RENEW_ATTEMPTS} tries: Internal Server Error`,
    );
    expect(await listAnnexedPaths(dir, REMOTE)).toEqual(new Set());
  });
});
