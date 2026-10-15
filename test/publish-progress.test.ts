/**
 * Publication progress reporting tests (issue #284).
 *
 * Two surfaces covered:
 *  1. `stepIndexFor` — pure helper that maps a step name to its 1-based
 *     position in the canonical orchestrator step list. Falls back to
 *     `stepsCompleted.length + 1` when the step name isn't recognised so
 *     newer server-side steps degrade gracefully on older CLIs.
 *  2. `approvePublication` — emits `onProgress` events on step
 *     transitions and on every s3_lock batch with running locked/total
 *     counters threaded back to the server so it doesn't have to re-count.
 *
 * Backend interaction uses a real Bun.serve fake (no mocks, per project
 * policy) so the request/response contract is exercised end-to-end.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./setup";
import {
  PUBLICATION_STEPS,
  type PublicationReviewOverride,
  type PublishProgressInfo,
  approvePublication,
  stepIndexFor,
} from "../src/lib/api/publish";
import { setConfig } from "../src/lib/config";

// --------------------------------------------------------------------------
// stepIndexFor — pure helper
// --------------------------------------------------------------------------

describe("stepIndexFor", () => {
  test("returns 1-based index for a known step", () => {
    expect(stepIndexFor("ci_check")).toBe(1);
    expect(stepIndexFor("s3_lock")).toBe(14);
    expect(stepIndexFor("notify_user")).toBe(PUBLICATION_STEPS.length);
  });

  test("falls back to stepsCompleted.length + 1 when step name is unknown", () => {
    // Server might add a step the CLI doesn't know about yet; fall back
    // to where the orchestrator says it is rather than failing.
    expect(stepIndexFor("brand_new_step", ["ci_check", "enrichment_check"])).toBe(3);
  });

  test("falls back to stepsCompleted.length + 1 when step is undefined", () => {
    expect(stepIndexFor(undefined, ["ci_check"])).toBe(2);
    expect(stepIndexFor(undefined, [])).toBe(1);
  });

  test("clamps fallback to step total so out-of-range completion doesn't overflow", () => {
    // If something writes 99 step names to steps_completed (corrupted
    // resume payload), don't render "Step 100/17".
    const overlong = new Array(99).fill("ci_check");
    expect(stepIndexFor(undefined, overlong)).toBe(PUBLICATION_STEPS.length);
  });

  test("PUBLICATION_STEPS list is the expected 16 backend steps", () => {
    // Locks in the contract. Since #904 the CLI and the backend orchestrator
    // both import shared/publication-steps.ts, so this pins the single source
    // itself — in the TRUE execution order (s3_public_read runs before
    // repo_public since epic #736; the old hand-mirrored CLI copy had them
    // swapped).
    expect(PUBLICATION_STEPS).toEqual([
      "ci_check",
      "enrichment_check",
      "s3_public_read",
      "repo_public",
      "tag_protect",
      "doi_create",
      "update_metadata",
      "update_readme",
      "create_tag",
      "create_release",
      "upload_to_zenodo",
      "publish_doi",
      "version_doi",
      "s3_lock",
      "sync_nemar",
      "notify_user",
    ]);
  });
});

// --------------------------------------------------------------------------
// approvePublication onProgress — real Bun.serve fake backend
// --------------------------------------------------------------------------

interface FakeApproveCall {
  body: {
    resume?: boolean;
    sandbox?: boolean;
    s3_lock_continuation_token?: string;
    s3_lock_total?: number;
    skip_ci_check?: boolean;
    acknowledge_identifier_screen?: string;
    override_publication_review?: { review_id: number | null; reasons: string[] };
    request_id?: number;
  };
}

interface FakeApproveServer {
  url: string;
  port: number;
  calls: FakeApproveCall[];
  stop: () => Promise<void>;
}

/**
 * Bring up a tiny HTTP server that records every approve call and
 * responds with a scripted sequence. Mirrors the response contract produced
 * by `backend/src/services/publication-orchestrator.ts` (#904) so the real
 * request/response shape is exercised, not a hand-rolled mock.
 */
function startFakeApproveServer(
  datasetId: string,
  responses: Array<Record<string, unknown>>,
): FakeApproveServer {
  const calls: FakeApproveCall[] = [];
  let respIdx = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== `/admin/publish/${datasetId}/approve` || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as FakeApproveCall["body"];
      calls.push({ body });
      const resp = responses[Math.min(respIdx, responses.length - 1)];
      respIdx++;
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    calls,
    stop: async () => {
      server.stop(true);
    },
  };
}

const DATASET = "nm099284";
let fake: FakeApproveServer | null = null;
const originalTestApiUrl = process.env.TEST_API_URL;
// Isolate config writes to a throwaway dir. setConfig() persists to disk, and
// without this it would clobber the developer's real ~/.config/nemar/config.json
// apiKey (this actually happened: it overwrote a live admin key mid-run).
const originalConfigDir = process.env.NEMAR_CONFIG_DIR;
let tmpConfigDir: string | null = null;

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "nemar-test-config-"));
  process.env.NEMAR_CONFIG_DIR = tmpConfigDir;
  // Set an apiKey so request(..., authenticated=true) won't bail before
  // making the call. The fake doesn't validate the token.
  setConfig("apiKey", "test-token-284");
});

beforeEach(() => {
  if (fake) {
    void fake.stop();
    fake = null;
  }
});

afterEach(async () => {
  if (fake) {
    await fake.stop();
    fake = null;
  }
  // Clean up the env var so it doesn't leak into other suites.
  if (originalTestApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = originalTestApiUrl;
});

afterAll(() => {
  if (originalTestApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = originalTestApiUrl;
  // Restore the real config dir and remove the throwaway one.
  if (originalConfigDir === undefined) delete process.env.NEMAR_CONFIG_DIR;
  else process.env.NEMAR_CONFIG_DIR = originalConfigDir;
  if (tmpConfigDir) {
    rmSync(tmpConfigDir, { recursive: true, force: true });
    tmpConfigDir = null;
  }
});

describe("approvePublication onProgress", () => {
  test("emits a progress event on completion with the final step", async () => {
    fake = startFakeApproveServer(DATASET, [
      {
        message: "Published",
        dataset_id: DATASET,
        status: "published",
        step_results: [
          { step: "ci_check", status: "completed", attempts: 1, duration_ms: 10 },
          { step: "enrichment_check", status: "completed", attempts: 1, duration_ms: 5 },
          { step: "s3_lock", status: "completed", attempts: 1, duration_ms: 100 },
          { step: "notify_user", status: "completed", attempts: 1, duration_ms: 8 },
        ],
        steps_completed: ["ci_check", "enrichment_check", "s3_lock", "notify_user"],
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    const events: PublishProgressInfo[] = [];
    await approvePublication(DATASET, false, false, false, undefined, (info) => {
      events.push(info);
    });

    // The "step" on a non-hasMore response is the *last* completed step,
    // so we see at least one event. The contract is "no progress lost on
    // success"; the final emit must reference the final step.
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.step).toBe("notify_user");
    expect(last.stepIndex).toBe(PUBLICATION_STEPS.length);
    expect(last.stepTotal).toBe(PUBLICATION_STEPS.length);
  });

  test("emits s3_lock progress with running locked/total across pages", async () => {
    // Three-page s3_lock stream: 40 + 40 + 20 locked of 100 total.
    //
    // The final (non-hasMore) response MUST include s3_lock_total and
    // s3_lock_batch_count — the backend always returns them on every
    // s3_lock response including the last. Without them the CLI's running
    // counter would read 80/100 at "complete" instead of 100/100. (#284)
    fake = startFakeApproveServer(DATASET, [
      {
        message: "S3 lock in progress: 40 locked in this batch",
        step: "s3_lock",
        steps_completed: ["ci_check", "enrichment_check"],
        step_results: [],
        s3_lock_continuation_token: "tok-page-2",
        s3_lock_total: 100,
        s3_lock_batch_count: 40,
        hasMore: true,
      },
      {
        message: "S3 lock in progress: 40 locked in this batch",
        step: "s3_lock",
        steps_completed: ["ci_check", "enrichment_check"],
        step_results: [],
        s3_lock_continuation_token: "tok-page-3",
        s3_lock_total: 100,
        s3_lock_batch_count: 40,
        hasMore: true,
      },
      // Final response: no hasMore, no step field (falls through to overall
      // success). Backend MUST return s3_lock_total and s3_lock_batch_count
      // here so the CLI accumulates the last batch. This is the contract
      // fixed by #284 — a fixture without these fields would hide the bug.
      {
        message: "Published",
        dataset_id: DATASET,
        status: "published",
        step_results: [{ step: "s3_lock", status: "completed", attempts: 1, duration_ms: 300 }],
        steps_completed: [...PUBLICATION_STEPS],
        s3_lock_total: 100,
        s3_lock_batch_count: 20,
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    const events: PublishProgressInfo[] = [];
    await approvePublication(DATASET, false, false, false, undefined, (info) => {
      events.push(info);
    });

    const s3Events = events.filter((e) => e.step === "s3_lock");
    // One event per page response with cumulative locked counters.
    expect(s3Events.length).toBe(3);
    expect(s3Events[0].s3LockLocked).toBe(40);
    expect(s3Events[0].s3LockTotal).toBe(100);
    expect(s3Events[1].s3LockLocked).toBe(80);
    expect(s3Events[2].s3LockLocked).toBe(100);
    // stepIndex stays anchored on the s3_lock position (14/16) the whole
    // time so the spinner doesn't jump backwards as completed steps fall
    // off the steps_completed window.
    for (const e of s3Events) {
      expect(e.stepIndex).toBe(14);
      expect(e.stepTotal).toBe(PUBLICATION_STEPS.length);
    }
  });

  test("threads s3_lock_total back to the server so it doesn't re-count per page", async () => {
    // Server returns total once (on the first response); CLI must echo
    // it on every follow-up request so the orchestrator can skip the
    // counting LIST sweep on subsequent invocations.
    fake = startFakeApproveServer(DATASET, [
      {
        message: "batch 1",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_continuation_token: "tok-2",
        s3_lock_total: 4963,
        s3_lock_batch_count: 100,
        hasMore: true,
      },
      {
        message: "batch 2",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_total: 4963,
        s3_lock_batch_count: 100,
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    await approvePublication(DATASET, true);

    expect(fake.calls.length).toBe(2);
    // First call: CLI hasn't been told the total yet.
    expect(fake.calls[0].body.s3_lock_total).toBeUndefined();
    expect(fake.calls[0].body.s3_lock_continuation_token).toBeUndefined();
    // Second call: total threaded back so server can skip the count sweep.
    expect(fake.calls[1].body.s3_lock_total).toBe(4963);
    expect(fake.calls[1].body.s3_lock_continuation_token).toBe("tok-2");
  });

  test("the review override rides on every call of a paged run, beside the acknowledgment (ADR 0102)", async () => {
    // The stand-in answers a paged run with the shape the real route does. The real route cannot
    // be made to page without an S3 bucket, so the paging loop is read here, and what the real
    // router receives is pinned by publication-review-client.test.ts.
    const paged = () => [
      {
        message: "batch 1",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_continuation_token: "tok-2",
        s3_lock_total: 200,
        s3_lock_batch_count: 100,
        hasMore: true,
      },
      {
        message: "batch 2",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_total: 200,
        s3_lock_batch_count: 100,
      },
    ];
    const override: PublicationReviewOverride = {
      review_id: 41,
      reasons: ["question_failed", "text_withheld"],
    };
    fake = startFakeApproveServer(DATASET, paged());
    process.env.TEST_API_URL = fake.url;
    await approvePublication(
      DATASET,
      false,
      false,
      false,
      undefined,
      undefined,
      "a recorded reason",
      override,
    );
    expect(fake.calls.length).toBe(2);
    for (const call of fake.calls) {
      expect(call.body.override_publication_review).toEqual(override);
      expect(call.body.acknowledge_identifier_screen).toBe("a recorded reason");
    }
    // The paging call always resumes; the override is no reason to change that.
    expect(fake.calls[0].body.resume).toBe(false);
    expect(fake.calls[1].body.resume).toBe(true);

    // Not given: on no call.
    await fake.stop();
    fake = startFakeApproveServer(DATASET, paged());
    process.env.TEST_API_URL = fake.url;
    await approvePublication(DATASET, false);
    expect(fake.calls.length).toBe(2);
    for (const call of fake.calls) {
      expect("override_publication_review" in call.body).toBe(false);
      expect("acknowledge_identifier_screen" in call.body).toBe(false);
    }
  });

  test("the request id rides on every call of a paged run, and on none when it is not given (#1579)", async () => {
    // Same stand-in as the override's: the real route cannot be made to page without a bucket, so
    // the paging loop is read here, and what the real router does with the field is pinned in
    // approve-request-precondition.test.ts and the CLI suites.
    const paged = () => [
      {
        message: "batch 1",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_continuation_token: "tok-2",
        s3_lock_total: 200,
        s3_lock_batch_count: 100,
        hasMore: true,
      },
      {
        message: "batch 2",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_continuation_token: "tok-3",
        s3_lock_total: 200,
        s3_lock_batch_count: 50,
        hasMore: true,
      },
      {
        message: "batch 3",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_total: 200,
        s3_lock_batch_count: 50,
      },
    ];
    fake = startFakeApproveServer(DATASET, paged());
    process.env.TEST_API_URL = fake.url;
    await approvePublication(
      DATASET,
      false,
      false,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      { requestId: 41 },
    );
    expect(fake.calls.length).toBe(3);
    for (const call of fake.calls) expect(call.body.request_id).toBe(41);

    // Not given: on no call, as the bodies of every caller before it.
    await fake.stop();
    fake = startFakeApproveServer(DATASET, paged());
    process.env.TEST_API_URL = fake.url;
    await approvePublication(DATASET, false);
    expect(fake.calls.length).toBe(3);
    for (const call of fake.calls) expect("request_id" in call.body).toBe(false);
  });

  test("calls without onProgress don't throw and still drive pagination", async () => {
    fake = startFakeApproveServer(DATASET, [
      {
        message: "batch 1",
        step: "s3_lock",
        steps_completed: [],
        step_results: [],
        s3_lock_continuation_token: "tok-x",
        s3_lock_total: 50,
        s3_lock_batch_count: 25,
        hasMore: true,
      },
      {
        message: "ok",
        step_results: [],
        s3_lock_total: 50,
        s3_lock_batch_count: 25,
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    // No onProgress argument — must not throw and must still page.
    await approvePublication(DATASET, false);
    expect(fake.calls.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Issue #477: notify_user failure must be non-fatal
  // -------------------------------------------------------------------------

  test("notify_user failure: orchestrator completes and returns warning (non-fatal)", async () => {
    // Simulate a Resend outage: orchestrator completes all steps (including
    // notify_user which recorded a failure) and returns HTTP 200 with a
    // warning field. The notify_user step_result has status="failed".
    const notifyErrMsg = "Resend API returned 503: service unavailable";
    fake = startFakeApproveServer(DATASET, [
      {
        message: "Dataset published successfully",
        dataset_id: DATASET,
        status: "published",
        step_results: [
          { step: "ci_check", status: "completed", attempts: 1, duration_ms: 12 },
          { step: "publish_doi", status: "completed", attempts: 1, duration_ms: 300 },
          {
            step: "notify_user",
            status: "failed",
            attempts: 1,
            duration_ms: 50,
            error: notifyErrMsg,
          },
        ],
        steps_completed: [
          "ci_check",
          "enrichment_check",
          "repo_public",
          "s3_public_read",
          "tag_protect",
          "doi_create",
          "update_metadata",
          "update_readme",
          "create_tag",
          "create_release",
          "upload_to_zenodo",
          "publish_doi",
          "version_doi",
          "s3_lock",
          "sync_nemar",
          // notify_user is NOT in steps_completed because it failed
        ],
        warning: `Notification email failed: ${notifyErrMsg}`,
      },
    ]);
    process.env.TEST_API_URL = fake.url;

    // 1. Orchestrator must NOT throw — resolves despite notify_user failing.
    const result = await approvePublication(DATASET, false);

    // 2. Final status is "published" — publication completed.
    expect(result.status).toBe("published");

    // 3. notify_user step_result reflects the failure.
    const notifyResult = result.step_results?.find((sr) => sr.step === "notify_user");
    expect(notifyResult).toBeDefined();
    expect(notifyResult?.status).toBe("failed");
    expect(notifyResult?.error).toContain("Resend API");

    // 4. Response includes the warning for operator visibility.
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("Notification email failed");
  });
});
