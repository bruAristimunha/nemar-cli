/**
 * The web approval's dispatch token (ADR 0105 decisions 1 and 4).
 *
 * A web click claims a request and dispatches an executor, which calls `/approve` under its own
 * key. The token is how that call proves it belongs to the claim: an HMAC over the claim's own
 * columns, signed with the callback secret (PRESCREEN_CALLBACK_SECRET) under a domain tag of its
 * own. Nothing is stored, so there is no migration; the claim's columns ARE the nonce.
 *
 * What these tests hold: the token binds every column it is derived from, it is a different
 * message from every other callback kind's (checked in BOTH directions against all six, because
 * one secret signs them all), a field that could pose as its neighbour is refused, and the check
 * that reads the token answers in the order decision 4 gives, so a token is never honored for a
 * call that cannot prove it belongs to the claim.
 *
 * Real crypto.subtle round-trips over the real functions; no mocks per `.rules/testing.md`.
 *
 * CI TIER: unit-pure. Hermetic: pure functions and a real WebCrypto, no server, no database.
 */

import { describe, expect, test } from "bun:test";
import "./setup";
import {
  APPROVAL_CLAIM_CLEAR_SQL,
  checkApprovalDispatchToken,
} from "../backend/src/services/approval-dispatch";
import { isValidDatasetId } from "../backend/src/services/datasetId";
import {
  signApprovalDispatchToken as signFromBarrel,
  verifyApprovalDispatchToken as verifyFromBarrel,
} from "../backend/src/services/github";
import {
  APPROVAL_DISPATCH_TOKEN_DOMAIN,
  type ApprovalDispatchTokenPayload,
  IDENTIFIER_SCREEN_TOKEN_DOMAIN,
  IDENTIFIER_SWEEP_TOKEN_DOMAIN,
  PR_REVIEW_TOKEN_DOMAIN,
  PUBLICATION_REVIEW_TOKEN_DOMAIN,
  signApprovalDispatchToken,
  signIdentifierScreenCallbackToken,
  signIdentifierSweepCallbackToken,
  signManifestCallbackToken,
  signPrReviewCallbackToken,
  signPrescreenCallbackToken,
  signPublicationReviewCallbackToken,
  verifyApprovalDispatchToken,
  verifyIdentifierScreenCallbackToken,
  verifyIdentifierSweepCallbackToken,
  verifyManifestCallbackToken,
  verifyPrReviewCallbackToken,
  verifyPrescreenCallbackToken,
  verifyPublicationReviewCallbackToken,
} from "../backend/src/services/github/callback-tokens";
import { PUBLICATION_DATASET_ID_RE } from "../shared/publication-limits";

const SECRET = "test-secret-do-not-use-in-prod";
const PAYLOAD: ApprovalDispatchTokenPayload = {
  datasetId: "nm099999",
  requestId: 4242,
  clickerId: 17,
  claimedAt: "2026-10-13 17:00:00",
};

describe("signApprovalDispatchToken / verifyApprovalDispatchToken", () => {
  test("round-trips, and is a 64-char hex SHA-256 digest", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyApprovalDispatchToken(token, PAYLOAD, SECRET)).toBe(true);
  });

  test("is deterministic: the same claim always derives the same token, so nothing is stored", async () => {
    expect(await signApprovalDispatchToken(PAYLOAD, SECRET)).toBe(
      await signApprovalDispatchToken({ ...PAYLOAD }, SECRET),
    );
  });

  test("binds every field: another dataset, request, clicker or claim time does not verify", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    for (const other of [
      { ...PAYLOAD, datasetId: "nm000999" },
      { ...PAYLOAD, requestId: 4243 },
      { ...PAYLOAD, clickerId: 18 },
      { ...PAYLOAD, claimedAt: "2026-10-13 17:00:01" },
    ]) {
      expect(await verifyApprovalDispatchToken(token, other, SECRET)).toBe(false);
    }
  });

  test("each field moves the digest, so a field dropped from the signed message is seen", async () => {
    const base = await signApprovalDispatchToken(PAYLOAD, SECRET);
    for (const other of [
      { ...PAYLOAD, datasetId: "nm000999" },
      { ...PAYLOAD, requestId: 4243 },
      { ...PAYLOAD, clickerId: 18 },
      { ...PAYLOAD, claimedAt: "2026-10-13 17:00:01" },
    ]) {
      expect(await signApprovalDispatchToken(other, SECRET)).not.toBe(base);
    }
  });

  test("the wrong secret, an empty token and an empty secret do not verify", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    expect(await verifyApprovalDispatchToken(token, PAYLOAD, "rotated")).toBe(false);
    expect(await verifyApprovalDispatchToken("", PAYLOAD, SECRET)).toBe(false);
    expect(await verifyApprovalDispatchToken(token, PAYLOAD, "")).toBe(false);
  });

  test("one flipped hex character, a truncated token and a longer one do not verify", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    const flipped = `${token.slice(0, 63)}${token.endsWith("0") ? "1" : "0"}`;
    expect(await verifyApprovalDispatchToken(flipped, PAYLOAD, SECRET)).toBe(false);
    expect(await verifyApprovalDispatchToken(token.slice(0, 63), PAYLOAD, SECRET)).toBe(false);
    expect(await verifyApprovalDispatchToken(`${token}0`, PAYLOAD, SECRET)).toBe(false);
  });

  test("signing refuses an empty secret, so a missing Worker secret cannot sign anything", async () => {
    await expect(signApprovalDispatchToken(PAYLOAD, "")).rejects.toThrow(/secret is required/);
  });

  test("a field that holds a line break is refused, so no field can pose as the next one", async () => {
    // The message is five lines. A dataset id of "nm000001\n7" with a clicker of 8 would
    // otherwise sign the same bytes as a dataset id of "nm000001" with a request of 7.
    const smuggled = { ...PAYLOAD, datasetId: `nm000001\n${PAYLOAD.requestId}` };
    await expect(signApprovalDispatchToken(smuggled, SECRET)).rejects.toThrow(/line break/);
    await expect(
      signApprovalDispatchToken({ ...PAYLOAD, claimedAt: "2026-10-13\n17:00:00" }, SECRET),
    ).rejects.toThrow(/line break/);
    expect(await verifyApprovalDispatchToken("a".repeat(64), smuggled, SECRET)).toBe(false);
    // A verifier never throws on what a caller hands it: it answers false.
    const genuine = await signApprovalDispatchToken(PAYLOAD, SECRET);
    expect(
      await verifyApprovalDispatchToken(genuine, { ...PAYLOAD, claimedAt: "x\r\ny" }, SECRET),
    ).toBe(false);
  });

  test("its domain is its own, and it is not a dataset id", () => {
    expect(APPROVAL_DISPATCH_TOKEN_DOMAIN).toBe("approval-dispatch");
    // The other kinds' messages begin with a dataset id (manifest, pre-screen) or with a tag of
    // their own. The tag stays out of the dataset id alphabet, so none of them can begin with it.
    expect(isValidDatasetId(APPROVAL_DISPATCH_TOKEN_DOMAIN)).toBe(false);
    expect(PUBLICATION_DATASET_ID_RE.test(APPROVAL_DISPATCH_TOKEN_DOMAIN)).toBe(false);
    for (const other of [
      IDENTIFIER_SCREEN_TOKEN_DOMAIN,
      IDENTIFIER_SWEEP_TOKEN_DOMAIN,
      PR_REVIEW_TOKEN_DOMAIN,
      PUBLICATION_REVIEW_TOKEN_DOMAIN,
    ]) {
      expect(other).not.toBe(APPROVAL_DISPATCH_TOKEN_DOMAIN);
    }
  });

  test("the services/github barrel re-exports the very functions", () => {
    expect(signFromBarrel).toBe(signApprovalDispatchToken);
    expect(verifyFromBarrel).toBe(verifyApprovalDispatchToken);
  });
});

describe("domain separation from every other callback token (same secret)", () => {
  // Every other kind, fed the dispatch payload's own values wherever its shape allows, in each
  // field position a collision could use. A token that verifies under any of these is a token one
  // workflow could use to answer for another.
  const NONCES = [String(PAYLOAD.clickerId), PAYLOAD.claimedAt, String(PAYLOAD.requestId)];

  async function everyOtherKindsToken(): Promise<string[]> {
    const tokens: string[] = [];
    for (const nonce of NONCES) {
      tokens.push(
        await signManifestCallbackToken(
          { datasetId: PAYLOAD.datasetId, version: String(PAYLOAD.requestId), nonce },
          SECRET,
        ),
        await signPrescreenCallbackToken(
          { datasetId: PAYLOAD.datasetId, requestId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
        await signIdentifierScreenCallbackToken(
          { datasetId: PAYLOAD.datasetId, requestId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
        await signIdentifierSweepCallbackToken({ datasetId: PAYLOAD.datasetId, nonce }, SECRET),
        await signPrReviewCallbackToken(
          { datasetId: PAYLOAD.datasetId, reviewId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
        await signPublicationReviewCallbackToken(
          { datasetId: PAYLOAD.datasetId, reviewId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
      );
    }
    return tokens;
  }

  test("a dispatch token opens no other kind of door", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    // The control: the same token IS valid where it was minted for.
    expect(await verifyApprovalDispatchToken(token, PAYLOAD, SECRET)).toBe(true);
    for (const nonce of NONCES) {
      expect(
        await verifyManifestCallbackToken(
          token,
          { datasetId: PAYLOAD.datasetId, version: String(PAYLOAD.requestId), nonce },
          SECRET,
        ),
      ).toBe(false);
      expect(
        await verifyPrescreenCallbackToken(
          token,
          { datasetId: PAYLOAD.datasetId, requestId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
      ).toBe(false);
      expect(
        await verifyIdentifierScreenCallbackToken(
          token,
          { datasetId: PAYLOAD.datasetId, requestId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
      ).toBe(false);
      expect(
        await verifyIdentifierSweepCallbackToken(
          token,
          { datasetId: PAYLOAD.datasetId, nonce },
          SECRET,
        ),
      ).toBe(false);
      expect(
        await verifyPrReviewCallbackToken(
          token,
          { datasetId: PAYLOAD.datasetId, reviewId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
      ).toBe(false);
      expect(
        await verifyPublicationReviewCallbackToken(
          token,
          { datasetId: PAYLOAD.datasetId, reviewId: PAYLOAD.requestId, nonce },
          SECRET,
        ),
      ).toBe(false);
    }
  });

  test("no other kind's token opens the dispatch door", async () => {
    const others = await everyOtherKindsToken();
    // Six kinds, three nonces each. They are not all distinct from one another (the manifest and
    // pre-screen kinds predate the domain tags and share an encoding), and need not be: what is
    // asserted is that none of them opens THIS door.
    expect(others).toHaveLength(NONCES.length * 6);
    for (const token of others) {
      expect(await verifyApprovalDispatchToken(token, PAYLOAD, SECRET)).toBe(false);
    }
  });

  test("the digest differs from every other kind's for the values they share", async () => {
    const mine = await signApprovalDispatchToken(PAYLOAD, SECRET);
    for (const token of await everyOtherKindsToken()) expect(token).not.toBe(mine);
  });
});

describe("checkApprovalDispatchToken (the rules, in order)", () => {
  /** A row as the orchestrator reads it: the claim's columns and the SQL-computed lease. */
  const row = (over: Partial<Parameters<typeof checkApprovalDispatchToken>[1]> = {}) => ({
    dataset_id: PAYLOAD.datasetId,
    id: PAYLOAD.requestId,
    approval_requested_by: PAYLOAD.clickerId as number | null,
    approval_dispatched_at: PAYLOAD.claimedAt as string | null,
    approval_lease_live: 1,
    ...over,
  });
  const env = { PRESCREEN_CALLBACK_SECRET: SECRET };

  test("a missing, empty or blank header is absent, whatever the row holds", async () => {
    for (const token of [undefined, null, "", "   "]) {
      expect(await checkApprovalDispatchToken(env, row(), token)).toEqual({ kind: "absent" });
    }
    // Absent is decided before anything about the claim is read.
    expect(
      await checkApprovalDispatchToken(
        env,
        row({ approval_requested_by: null, approval_dispatched_at: null, approval_lease_live: 0 }),
        undefined,
      ),
    ).toEqual({ kind: "absent" });
  });

  test("a genuine token on a live claim is valid, and carries the clicker and the instant it was verified against", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    const valid = { kind: "valid", clickerId: PAYLOAD.clickerId, claimedAt: PAYLOAD.claimedAt };
    expect(await checkApprovalDispatchToken(env, row(), token)).toEqual(valid);
    // The header's own padding is not part of the token.
    expect(await checkApprovalDispatchToken(env, row(), ` ${token} `)).toEqual(valid);
  });

  test("no secret on the Worker is superseded, never valid: a token is not honored it cannot check", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    for (const noSecret of [
      {},
      { PRESCREEN_CALLBACK_SECRET: undefined },
      { PRESCREEN_CALLBACK_SECRET: "" },
    ]) {
      expect(await checkApprovalDispatchToken(noSecret, row(), token)).toEqual({
        kind: "refused",
        code: "dispatch_superseded",
      });
    }
  });

  test("a claim that is gone is superseded, so a released or taken-over claim refuses the executor", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    for (const gone of [
      { approval_requested_by: null },
      { approval_dispatched_at: null },
      { approval_requested_by: null, approval_dispatched_at: null },
    ]) {
      expect(await checkApprovalDispatchToken(env, row(gone), token)).toEqual({
        kind: "refused",
        code: "dispatch_superseded",
      });
    }
  });

  test("a MAC that does not match is superseded: another claim, request, clicker, dataset or key", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    for (const other of [
      { approval_dispatched_at: "2026-10-13 17:00:01" },
      { id: PAYLOAD.requestId + 1 },
      { approval_requested_by: PAYLOAD.clickerId + 1 },
      { dataset_id: "nm000999" },
    ]) {
      expect(await checkApprovalDispatchToken(env, row(other), token)).toEqual({
        kind: "refused",
        code: "dispatch_superseded",
      });
    }
    const flipped = `${token.slice(0, 63)}${token.endsWith("0") ? "1" : "0"}`;
    expect(await checkApprovalDispatchToken(env, row(), flipped)).toEqual({
      kind: "refused",
      code: "dispatch_superseded",
    });
    expect(
      await checkApprovalDispatchToken({ PRESCREEN_CALLBACK_SECRET: "rotated" }, row(), token),
    ).toEqual({ kind: "refused", code: "dispatch_superseded" });
  });

  test("a MAC that matches on a lapsed lease is expired, and only then", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    expect(await checkApprovalDispatchToken(env, row({ approval_lease_live: 0 }), token)).toEqual({
      kind: "refused",
      code: "dispatch_expired",
    });
    // The MAC is checked first: a stranger's token on a lapsed lease is superseded, not expired,
    // so the answer does not say whether a lease lapsed to someone who cannot prove a claim.
    expect(
      await checkApprovalDispatchToken(env, row({ approval_lease_live: 0 }), "0".repeat(64)),
    ).toEqual({ kind: "refused", code: "dispatch_superseded" });
  });

  test("only a lease the database reported live as exactly 1 counts", async () => {
    const token = await signApprovalDispatchToken(PAYLOAD, SECRET);
    for (const live of [0, 2, -1]) {
      expect(
        await checkApprovalDispatchToken(env, row({ approval_lease_live: live }), token),
      ).toEqual({
        kind: "refused",
        code: "dispatch_expired",
      });
    }
  });
});

describe("APPROVAL_CLAIM_CLEAR_SQL", () => {
  test("clears both columns of the claim and nothing else, with no trailing comma", () => {
    expect(APPROVAL_CLAIM_CLEAR_SQL).toBe(
      "approval_requested_by = NULL, approval_dispatched_at = NULL",
    );
  });
});
