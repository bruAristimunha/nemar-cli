/**
 * Mail provider selection (epic #1893, ADR 0110): the staging Worker sends through the Cloudflare
 * Email Service `send_email` binding, production stays on Resend.
 *
 * Driven through the real exported senders (`sendRevocationEmail`, `sendAdminNotificationEmail`),
 * so the fence, the `[DEV]` wrap and the provider switch run exactly as production runs them.
 *
 * The one thing replaced is the external boundary: `recordingBinding` stands in for the
 * `env.EMAIL` binding, the way `withFakeResend` redirects `api.resend.com` to a local server. It
 * exists because the binding's failures carry a Cloudflare `.code` that the Miniflare simulator
 * never raises; `email-send-binding.test.ts` drives the same code against Miniflare's real
 * `send_email` binding for the parts the simulator does implement.
 */

import { describe, expect, test } from "bun:test";
import {
  type CloudflareSendEmail,
  DevEmailFenceError,
  type EmailDeliveryEnv,
  EmailProviderConfigError,
  EmailRejectedError,
  isCertainNonDelivery,
  parseMailbox,
  redactAddressIn,
  resolveEmailProvider,
  sendAdminNotificationEmail,
  sendEmail,
  sendRevocationEmail,
} from "../src/services/email";
import { bindingError, recordingBinding } from "./helpers/cloudflare-email";
import { withFakeResend } from "./helpers/resend";

const FROM = "NEMAR Staging <noreply@staging.nemar.test>";
const REPLY_TO = "support@staging.nemar.test";
const ALLOWED = "tester@nemar.test";

function stagingEnv(binding: CloudflareSendEmail | undefined): EmailDeliveryEnv {
  return {
    ENVIRONMENT: "development",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding,
  };
}

const revoke = (env: EmailDeliveryEnv, to = ALLOWED) =>
  sendRevocationEmail(to, "tester", "unused-resend-key", FROM, REPLY_TO, true, env);

describe("resolveEmailProvider", () => {
  const { binding } = recordingBinding();

  test("unset, empty and resend are Resend", () => {
    expect(resolveEmailProvider(undefined)).toEqual({ provider: "resend" });
    expect(resolveEmailProvider({})).toEqual({ provider: "resend" });
    expect(resolveEmailProvider({ EMAIL_PROVIDER: "" })).toEqual({ provider: "resend" });
    expect(resolveEmailProvider({ EMAIL_PROVIDER: "  " })).toEqual({ provider: "resend" });
    expect(resolveEmailProvider({ EMAIL_PROVIDER: " Resend " })).toEqual({ provider: "resend" });
  });

  test("a binding alone does not switch the provider", () => {
    expect(resolveEmailProvider({ EMAIL: binding })).toEqual({ provider: "resend" });
  });

  test("cloudflare carries its binding, read trimmed and case-insensitively", () => {
    expect(resolveEmailProvider({ EMAIL_PROVIDER: "cloudflare", EMAIL: binding })).toEqual({
      provider: "cloudflare",
      binding,
    });
    expect(resolveEmailProvider({ EMAIL_PROVIDER: "  Cloudflare ", EMAIL: binding })).toEqual({
      provider: "cloudflare",
      binding,
    });
  });

  test("cloudflare without the binding throws rather than falling back to Resend", () => {
    expect(() => resolveEmailProvider({ EMAIL_PROVIDER: "cloudflare" })).toThrow(
      EmailProviderConfigError,
    );
  });

  for (const typo of ["cloudfare", "ses", "cloud flare", "true"]) {
    test(`an unknown value (${JSON.stringify(typo)}) throws and never means Resend`, () => {
      expect(() => resolveEmailProvider({ EMAIL_PROVIDER: typo, EMAIL: binding })).toThrow(
        EmailProviderConfigError,
      );
    });
  }
});

describe("parseMailbox", () => {
  test("a display name and an address", () => {
    expect(parseMailbox("NEMAR Staging <noreply@test.nemar.org>")).toEqual({
      email: "noreply@test.nemar.org",
      name: "NEMAR Staging",
    });
  });

  // The runtime refuses `{ email }` without a string `name` (staging, 2026-10-23), so a
  // bare address must reach the binding as a string, never as an object.
  test("a bare address is passed as a string", () => {
    expect(parseMailbox("support@test.nemar.org")).toBe("support@test.nemar.org");
    expect(parseMailbox("  support@test.nemar.org  ")).toBe("support@test.nemar.org");
    expect(parseMailbox("<support@test.nemar.org>")).toBe("support@test.nemar.org");
    expect(parseMailbox("  <support@test.nemar.org>")).toBe("support@test.nemar.org");
  });

  test("a quoted name loses its quotes and keeps a comma", () => {
    expect(parseMailbox('"NEMAR, Archive" <noreply@nemar.test>')).toEqual({
      email: "noreply@nemar.test",
      name: "NEMAR, Archive",
    });
  });
});

describe("a send through the Cloudflare binding", () => {
  test("reaches the binding with the parsed sender, the parsed reply-to and the [DEV] wrap", async () => {
    const { binding, sent } = recordingBinding();
    await withFakeResend(async (calls) => {
      await revoke(stagingEnv(binding));
      expect(calls.length).toBe(0); // Resend is never called
    });
    expect(sent.length).toBe(1);
    const message = sent[0];
    expect(message.from).toEqual({ email: "noreply@staging.nemar.test", name: "NEMAR Staging" });
    expect(message.to).toBe(ALLOWED);
    expect(message.replyTo).toBe(REPLY_TO);
    expect(message.subject.startsWith("[DEV] ")).toBe(true);
    expect(message.html).toContain("DEV BACKEND - NOT PRODUCTION");
  });

  test("no reply-to configured means none is sent", async () => {
    const { binding, sent } = recordingBinding();
    await sendRevocationEmail(ALLOWED, "tester", "k", FROM, undefined, true, stagingEnv(binding));
    expect(sent.length).toBe(1);
    expect("replyTo" in sent[0]).toBe(false);
  });

  test("the fence still refuses a recipient off the allow-list before the binding is called", async () => {
    const { binding, sent } = recordingBinding();
    await withFakeResend(async (calls) => {
      await expect(revoke(stagingEnv(binding), "someone@example.org")).rejects.toBeInstanceOf(
        DevEmailFenceError,
      );
      expect(calls.length).toBe(0);
    });
    expect(sent.length).toBe(0);
  });

  test("a missing binding throws a configuration error and Resend is not reached", async () => {
    await withFakeResend(async (calls) => {
      const error = await revoke(stagingEnv(undefined)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EmailProviderConfigError);
      // Nothing was sent, so a caller that reports to a person may say so.
      expect(isCertainNonDelivery(error)).toBe(true);
      expect(calls.length).toBe(0);
    });
  });

  test("a mistyped EMAIL_PROVIDER throws through a real wrapper and sends nothing", async () => {
    const { binding, sent } = recordingBinding();
    await withFakeResend(async (calls) => {
      const error = await revoke({ ...stagingEnv(binding), EMAIL_PROVIDER: "cloudfare" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(EmailProviderConfigError);
      expect(isCertainNonDelivery(error)).toBe(true);
      expect(calls.length).toBe(0);
    });
    expect(sent.length).toBe(0);
  });

  test("without EMAIL_PROVIDER the same env still goes to Resend (production is unchanged)", async () => {
    const { binding, sent } = recordingBinding();
    await withFakeResend(async (calls) => {
      await revoke({ ...stagingEnv(binding), EMAIL_PROVIDER: undefined });
      expect(calls.length).toBe(1);
      expect(calls[0].path).toBe("/emails");
    });
    expect(sent.length).toBe(0);
  });

  test("production with the binding present and no provider setting uses Resend", async () => {
    const { binding, sent } = recordingBinding();
    await withFakeResend(async (calls) => {
      await sendRevocationEmail("real@example.org", "u", "k", FROM, REPLY_TO, false, {
        ENVIRONMENT: "production",
        EMAIL: binding,
      });
      expect(calls.length).toBe(1);
    });
    expect(sent.length).toBe(0);
  });
});

describe("a binding failure", () => {
  const DEFINITE = [
    "E_VALIDATION_ERROR",
    "E_FIELD_MISSING",
    "E_TOO_MANY_RECIPIENTS",
    "E_TOO_MANY_ATTACHMENTS",
    "E_SENDER_NOT_VERIFIED",
    "E_RECIPIENT_NOT_ALLOWED",
    "E_RECIPIENT_SUPPRESSED",
    "E_ACCOUNT_SUSPENDED",
    "E_SENDER_DOMAIN_NOT_AVAILABLE",
    "E_CONTENT_TOO_LARGE",
    "E_DELIVERY_FAILED",
    "E_RATE_LIMIT_EXCEEDED",
    "E_DAILY_LIMIT_EXCEEDED",
    "E_HEADER_NAME_INVALID",
    "E_HEADER_VALUE_INVALID",
    "E_HEADERS_TOO_LARGE",
  ];

  for (const code of DEFINITE) {
    test(`${code} is a certain non-delivery`, async () => {
      const { binding } = recordingBinding(() => bindingError(code));
      const error = await revoke(stagingEnv(binding)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(EmailRejectedError);
      const rejected = error as EmailRejectedError;
      expect(rejected.code).toBe(code);
      expect(rejected.httpStatus).toBe(code.endsWith("_LIMIT_EXCEEDED") ? 429 : 422);
      expect(isCertainNonDelivery(error)).toBe(true);
    });
  }

  const UNCERTAIN: Array<[string, () => unknown]> = [
    ["E_INTERNAL_SERVER_ERROR", () => bindingError("E_INTERNAL_SERVER_ERROR")],
    ["an unknown code", () => bindingError("E_SOMETHING_NEW")],
    ["no code", () => bindingError(undefined)],
    ["a thrown string", () => "boom"],
  ];

  for (const [label, failure] of UNCERTAIN) {
    test(`${label} stays a plain Error, since the message may have been accepted`, async () => {
      const { binding } = recordingBinding(failure);
      const error = await revoke(stagingEnv(binding)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EmailRejectedError);
      expect(isCertainNonDelivery(error)).toBe(false);
    });
  }

  test("the message names the sender and recipient and carries the binding's words", async () => {
    const { binding } = recordingBinding(() =>
      bindingError("E_SENDER_NOT_VERIFIED", "not verified"),
    );
    const error = (await revoke(stagingEnv(binding)).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe(`Failed to send email from ${FROM} to ${ALLOWED}: not verified`);
    // The existing redaction applies to it unchanged.
    expect(redactAddressIn(error.message, ALLOWED).toLowerCase()).not.toContain(ALLOWED);
  });

  test("a failed admin notice logs no address in full", async () => {
    const { binding } = recordingBinding(() => bindingError("E_RECIPIENT_NOT_ALLOWED", "refused"));
    const lines: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(
        args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "),
      );
    };
    try {
      await sendAdminNotificationEmail(
        [ALLOWED],
        { username: "u", email: "u@example.org", github_username: null, description: "d" },
        "unused",
        FROM,
        REPLY_TO,
        true,
        stagingEnv(binding),
      );
    } finally {
      console.error = real;
    }
    const text = lines.join("\n");
    expect(text).toContain("Failed to send admin notification to t***@nemar.test");
    expect(text.toLowerCase()).not.toContain(ALLOWED);
  });
});

describe("the bound on a Cloudflare send (timeoutMs)", () => {
  const env = { ...stagingEnv(undefined), EMAIL: undefined } as EmailDeliveryEnv;

  test("a binding that never answers ends in a plain Error at the bound", async () => {
    const hung: CloudflareSendEmail = { send: () => new Promise(() => {}) };
    const error = await sendEmail(
      ALLOWED,
      "s",
      "<p>h</p>",
      "unused",
      FROM,
      undefined,
      true,
      { ...env, EMAIL: hung },
      25,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EmailRejectedError);
    expect((error as Error).message).toContain("timed out after 25ms");
    expect(isCertainNonDelivery(error)).toBe(false);
  });

  test("a binding that answers in time is not timed out", async () => {
    const { binding, sent } = recordingBinding();
    await sendEmail(
      ALLOWED,
      "s",
      "<p>h</p>",
      "unused",
      FROM,
      undefined,
      true,
      { ...env, EMAIL: binding },
      5_000,
    );
    expect(sent.length).toBe(1);
  });
});
