/**
 * The publication review's callback token and dispatch (ADR 0102).
 *
 * The token shares its key with every other callback token (PRESCREEN_CALLBACK_SECRET) and is
 * signed over the same three fields as the pull-request review's, so the one property that keeps
 * the kinds apart is the domain tag at the head of the signed message. These tests hold that line
 * in BOTH directions against every other kind that exists. The dispatch carries the review's
 * coordinates and nothing a dataset wrote.
 *
 * Real crypto.subtle round-trips and a Bun.serve stand-in for api.github.com; no mocks per
 * `.rules/testing.md`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./setup";
import {
  signIdentifierScreenCallbackToken,
  signIdentifierSweepCallbackToken,
  signManifestCallbackToken,
  signPrescreenCallbackToken,
  verifyIdentifierScreenCallbackToken,
  verifyIdentifierSweepCallbackToken,
  verifyManifestCallbackToken,
  verifyPrescreenCallbackToken,
} from "../backend/src/services/github";
import {
  PUBLICATION_REVIEW_TOKEN_DOMAIN,
  signPrReviewCallbackToken,
  signPublicationReviewCallbackToken,
  verifyPrReviewCallbackToken,
  verifyPublicationReviewCallbackToken,
} from "../backend/src/services/github/callback-tokens";
import { triggerPublicationReviewRun } from "../backend/src/services/github/dispatch";
import { type FakeGithubServer, startFakeGithub } from "./helpers/fetch-counter";

const SECRET = "test-secret-do-not-use-in-prod";
const PAYLOAD = {
  datasetId: "nm099999",
  reviewId: 4242,
  nonce: "11111111-2222-3333-4444-555555555555",
};

describe("signPublicationReviewCallbackToken / verifyPublicationReviewCallbackToken", () => {
  test("round-trips, and is a 64-char hex SHA-256 digest", async () => {
    const token = await signPublicationReviewCallbackToken(PAYLOAD, SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPublicationReviewCallbackToken(token, PAYLOAD, SECRET)).toBe(true);
  });

  test("binds every field: another dataset, review or nonce does not verify", async () => {
    const token = await signPublicationReviewCallbackToken(PAYLOAD, SECRET);
    for (const other of [
      { ...PAYLOAD, datasetId: "nm000999" },
      { ...PAYLOAD, reviewId: 4243 },
      { ...PAYLOAD, nonce: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    ]) {
      expect(await verifyPublicationReviewCallbackToken(token, other, SECRET)).toBe(false);
    }
  });

  test("the wrong secret, an empty token and an empty secret do not verify", async () => {
    const token = await signPublicationReviewCallbackToken(PAYLOAD, SECRET);
    expect(await verifyPublicationReviewCallbackToken(token, PAYLOAD, "rotated")).toBe(false);
    expect(await verifyPublicationReviewCallbackToken("", PAYLOAD, SECRET)).toBe(false);
    expect(await verifyPublicationReviewCallbackToken(token, PAYLOAD, "")).toBe(false);
  });

  test("signing refuses an empty secret, so a missing Worker secret cannot sign anything", async () => {
    expect(signPublicationReviewCallbackToken(PAYLOAD, "")).rejects.toThrow(/secret is required/);
  });

  test("its domain is its own", () => {
    expect(PUBLICATION_REVIEW_TOKEN_DOMAIN).toBe("publication-review");
  });
});

describe("domain separation from every other callback token (same secret)", () => {
  const screenShaped = {
    datasetId: PAYLOAD.datasetId,
    requestId: PAYLOAD.reviewId,
    nonce: PAYLOAD.nonce,
  };

  test("a publication-review token opens no other kind of door", async () => {
    const token = await signPublicationReviewCallbackToken(PAYLOAD, SECRET);
    // The control: the same token IS valid where it was minted for.
    expect(await verifyPublicationReviewCallbackToken(token, PAYLOAD, SECRET)).toBe(true);
    expect(await verifyPrReviewCallbackToken(token, PAYLOAD, SECRET)).toBe(false);
    expect(await verifyPrescreenCallbackToken(token, screenShaped, SECRET)).toBe(false);
    expect(await verifyIdentifierScreenCallbackToken(token, screenShaped, SECRET)).toBe(false);
    expect(
      await verifyIdentifierSweepCallbackToken(
        token,
        { datasetId: PAYLOAD.datasetId, nonce: PAYLOAD.nonce },
        SECRET,
      ),
    ).toBe(false);
    expect(
      await verifyManifestCallbackToken(
        token,
        { datasetId: PAYLOAD.datasetId, version: "1.0.0", nonce: PAYLOAD.nonce },
        SECRET,
      ),
    ).toBe(false);
  });

  test("no other kind's token opens the publication-review door", async () => {
    const others = [
      await signPrReviewCallbackToken(PAYLOAD, SECRET),
      await signPrescreenCallbackToken(screenShaped, SECRET),
      await signIdentifierScreenCallbackToken(screenShaped, SECRET),
      await signIdentifierSweepCallbackToken(
        { datasetId: PAYLOAD.datasetId, nonce: PAYLOAD.nonce },
        SECRET,
      ),
      await signManifestCallbackToken(
        { datasetId: PAYLOAD.datasetId, version: String(PAYLOAD.reviewId), nonce: PAYLOAD.nonce },
        SECRET,
      ),
    ];
    for (const token of others) {
      expect(await verifyPublicationReviewCallbackToken(token, PAYLOAD, SECRET)).toBe(false);
    }
  });

  test("the digest differs from the pull-request review's for identical inputs", async () => {
    expect(await signPublicationReviewCallbackToken(PAYLOAD, SECRET)).not.toBe(
      await signPrReviewCallbackToken(PAYLOAD, SECRET),
    );
  });
});

describe("triggerPublicationReviewRun", () => {
  const DISPATCH_PATH = "/repos/nemarDatasets/.github/dispatches";
  let fake: FakeGithubServer;
  let nextResponse: () => Response = () => new Response(null, { status: 204 });

  beforeAll(() => {
    fake = startFakeGithub({ [`POST ${DISPATCH_PATH}`]: () => nextResponse() });
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = fake.url;
  });

  afterAll(() => {
    fake.stop();
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  });

  beforeEach(() => {
    fake.reset();
    nextResponse = () => new Response(null, { status: 204 });
  });

  const dispatch = {
    datasetId: "nm099997",
    requestId: 17,
    reviewId: 4242,
    headSha: "a".repeat(40),
    anonymous: true,
    callbackToken: "deadbeef".repeat(8),
    environment: "dev",
  } as const;

  test("POSTs run-publication-review to the central repo with exactly the seven coordinates", async () => {
    await triggerPublicationReviewRun(dispatch, "test-pat");
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].method).toBe("POST");
    expect(fake.calls[0].path).toBe(DISPATCH_PATH);
    expect(JSON.parse(fake.calls[0].body ?? "{}")).toEqual({
      event_type: "run-publication-review",
      client_payload: {
        dataset_id: "nm099997",
        request_id: 17,
        review_id: 4242,
        head_sha: "a".repeat(40),
        anonymous: true,
        callback_token: "deadbeef".repeat(8),
        environment: "dev",
      },
    });
  });

  test("throws on a non-2xx answer, naming the status and not GitHub's body", async () => {
    nextResponse = () => new Response("secret-ish body", { status: 422 });
    const err = await triggerPublicationReviewRun(dispatch, "test-pat").catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Publication review dispatch rejected: HTTP 422");
  });

  test("a timeout ends a dispatch GitHub never answers", async () => {
    nextResponse = () => new Response(null, { status: 204 });
    const slow = startFakeGithub({
      [`POST ${DISPATCH_PATH}`]: () => new Promise<Response>(() => {}),
    });
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = slow.url;
    try {
      const err = await triggerPublicationReviewRun(dispatch, "test-pat", 50).catch(
        (e: unknown) => e as Error,
      );
      expect((err as Error).name).toMatch(/TimeoutError|AbortError/);
    } finally {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = fake.url;
      slow.stop();
    }
  });
});
