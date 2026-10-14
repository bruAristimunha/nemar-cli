/**
 * `triggerApprovePublication` (ADR 0080; ADR 0103 decision 3 for the token): the dispatch that
 * hands a web approval to the central workflow.
 *
 * Real engine: driven against a `Bun.serve()` stand-in for api.github.com, the
 * same pattern as archive-generation-dispatch.test.ts. No mocks: the shape sent
 * is read straight off the request the stand-in received. What matters is the
 * contract the workflow reads (event type and the five payload keys, the last
 * being the claim's dispatch token), that no GitHub credential or URL rides in the
 * payload, that the token is never in an error this raises, and that an
 * environment is only ever a name. The Worker's own secret is never handed to
 * this function (it signs nothing), so that it stays out of every answer and log
 * is held at the route, in approve-dispatch-route.test.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  APPROVE_DISPATCH_TIMEOUT_MS,
  CENTRAL_WORKFLOW_REPO,
  DispatchRejectedError,
  approvalDispatchEnvironment,
  triggerApprovePublication,
} from "../src/services/github/dispatch";

interface Received {
  path: string;
  authorization: string | null;
  body: { event_type: string; client_payload: Record<string, unknown> };
}

let server: Server;
let received: Received[] = [];
let nextStatus = 204;
let nextBody = "";

/** A token shaped as the signer's (64 hex), standing for the claim's dispatch token. */
const TOKEN = "ab".repeat(32);

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      });
      return new Response(nextBody || null, { status: nextStatus });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  received = [];
  nextStatus = 204;
  nextBody = "";
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

describe("triggerApprovePublication", () => {
  test("posts approve-publication to the central repo with exactly the contract payload", async () => {
    await triggerApprovePublication("nm000288", 833, false, "production", "ghp_token", TOKEN);

    expect(received).toHaveLength(1);
    expect(received[0].path).toBe(`/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`);
    expect(received[0].authorization).toBe("Bearer ghp_token");
    expect(received[0].body).toEqual({
      event_type: "approve-publication",
      client_payload: {
        dataset_id: "nm000288",
        request_id: 833,
        resume: false,
        environment: "production",
        dispatch_token: TOKEN,
      },
    });
  });

  test("carries resume and the dev environment through", async () => {
    await triggerApprovePublication("nm099999", 7, true, "dev", "t", TOKEN);
    expect(received[0].body.client_payload).toEqual({
      dataset_id: "nm099999",
      request_id: 7,
      resume: true,
      environment: "dev",
      dispatch_token: TOKEN,
    });
  });

  test("the payload is exactly five keys, and neither the GitHub credential nor a URL rides in it", async () => {
    await triggerApprovePublication(
      "nm000288",
      833,
      false,
      "production",
      "ghp_secret_value",
      TOKEN,
    );
    const sent = JSON.stringify(received[0].body);
    expect(sent).not.toContain("ghp_secret_value");
    expect(sent).not.toMatch(/https?:\/\//);
    expect(Object.keys(received[0].body.client_payload).sort()).toEqual([
      "dataset_id",
      "dispatch_token",
      "environment",
      "request_id",
      "resume",
    ]);
    // What the caller handed over is what is sent: the function signs nothing and invents nothing.
    expect(received[0].body.client_payload.dispatch_token).toBe(TOKEN);
  });

  test("throws on a non-2xx, naming GitHub's status but never the token", async () => {
    nextStatus = 404;
    nextBody = '{"message":"Not Found"}';
    const err = await triggerApprovePublication(
      "nm000288",
      833,
      false,
      "production",
      "ghp_tok",
      TOKEN,
    )
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("HTTP 404");
    expect(err?.message).toContain("Not Found");
    expect(err?.message).not.toContain("ghp_tok");
    expect(err?.message).not.toContain(TOKEN);
  });

  test("an error whose body echoes the payload back does not carry the token out", async () => {
    // The route logs this message. A 4xx that quoted the request it refused would put the token in
    // the Worker's log, so the body's copy of it is removed before the error is built.
    nextStatus = 422;
    nextBody = JSON.stringify({
      message: "Validation Failed",
      echoed: { client_payload: { dispatch_token: TOKEN } },
    });
    const err = await triggerApprovePublication(
      "nm000288",
      833,
      false,
      "production",
      "ghp_tok",
      TOKEN,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchRejectedError);
    expect((err as Error).message).toContain("HTTP 422");
    expect((err as Error).message).toContain("Validation Failed");
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe("how a failed dispatch is classified", () => {
  // The route releases its claim only for a failure that is definitely "not
  // sent". GitHub answering non-2xx is that; a lost answer is not, because GitHub
  // may have accepted the event and dropped only the reply.
  test("a non-2xx is a DispatchRejectedError carrying GitHub's status", async () => {
    nextStatus = 422;
    nextBody = '{"message":"Unprocessable"}';
    const err = await triggerApprovePublication(
      "nm000288",
      833,
      false,
      "production",
      "t",
      TOKEN,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DispatchRejectedError);
    expect((err as DispatchRejectedError).httpStatus).toBe(422);
  });

  test("a GitHub that never answers times out, and a timeout is NOT a rejection", async () => {
    const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    const real = (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL;
    (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
      `http://127.0.0.1:${hung.port}`;
    try {
      const started = Date.now();
      const err = await triggerApprovePublication(
        "nm000288",
        833,
        false,
        "production",
        "t",
        TOKEN,
        50,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("TimeoutError");
      expect(err).not.toBeInstanceOf(DispatchRejectedError);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = real;
      hung.stop(true);
    }
  });

  test("the default deadline is under the website's 15 second deadline on this call", () => {
    expect(APPROVE_DISPATCH_TIMEOUT_MS).toBe(10_000);
    expect(APPROVE_DISPATCH_TIMEOUT_MS).toBeLessThan(15_000);
  });
});

describe("approvalDispatchEnvironment", () => {
  test("production only for the production Worker, exactly", () => {
    expect(approvalDispatchEnvironment({ ENVIRONMENT: "production" })).toBe("production");
  });

  test("every other value is dev, including an unset or misspelled one", () => {
    for (const value of [
      "development",
      "staging",
      "test",
      "Production",
      " production",
      "",
      undefined,
    ]) {
      expect(approvalDispatchEnvironment({ ENVIRONMENT: value })).toBe("dev");
    }
  });
});
