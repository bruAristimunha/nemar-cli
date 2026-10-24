/**
 * `nemar admin notify` on the Cloudflare provider (epic #1893, ADR 0110): one message per
 * allowed recipient through the `send_email` binding, with the same fence and the same result
 * accounting as the Resend batch path (email-delivery-fence.test.ts).
 *
 * Real D1 for the broadcast_emails audit write; the binding is the recorder from
 * helpers/cloudflare-email.ts, the external boundary.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sendBroadcast } from "../src/services/broadcast";
import type { CloudflareSendEmail, EmailDeliveryEnv } from "../src/services/email";
import { bindingError, recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";

const FROM = "NEMAR Staging <noreply@staging.nemar.test>";
const REPLY_TO = "support@staging.nemar.test";

function seedSender(db: Database): number {
  db.prepare(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('broadcastadmin', 'broadcastadmin@nemar.test', 'x', 'approved', 'admin', 1)`,
  ).run();
  const row = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'broadcastadmin'")
    .get();
  if (!row) throw new Error("seed: sender insert failed");
  return row.id;
}

function stagingEnv(binding: EmailDeliveryEnv["EMAIL"]): EmailDeliveryEnv {
  return {
    ENVIRONMENT: "development",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding,
  };
}

function broadcast(db: Database, recipients: string[], env: EmailDeliveryEnv, apiKey = "") {
  return sendBroadcast(
    realD1(db),
    apiKey,
    FROM,
    {
      sentById: seedSender(db),
      group: "admins",
      subject: "Maintenance window",
      bodyMarkdown: "Hello",
      recipients,
    },
    REPLY_TO,
    true,
    env,
  );
}

describe("sendBroadcast on the Cloudflare provider", () => {
  test("sends one message per allowed recipient; fenced recipients never reach the binding", async () => {
    const { binding, sent } = recordingBinding();
    const db = freshDb();
    await withFakeResend(async (calls) => {
      const result = await broadcast(
        db,
        ["a@nemar.test", "outsider@example.org", "b@nemar.test", "other@example.net"],
        stagingEnv(binding),
      );
      expect(calls.length).toBe(0); // no Resend batch, and no key was needed
      expect(result.recipient_count).toBe(2);
      expect(result.failure_count).toBe(0);
      expect(result.failed_recipients).toEqual([]);
      expect(result.suppressed_count).toBe(2);
      expect(result.error).toBeUndefined();
    });

    expect(sent.map((m) => m.to)).toEqual(["a@nemar.test", "b@nemar.test"]);
    for (const message of sent) {
      expect(message.from).toEqual({ email: "noreply@staging.nemar.test", name: "NEMAR Staging" });
      expect(message.replyTo).toEqual({ email: REPLY_TO });
      // The [DEV] wrap is applied once, not twice.
      expect(message.subject).toBe("[DEV] Maintenance window");
      expect(message.html).toContain("DEV BACKEND - NOT PRODUCTION");
      expect(message.html.split("DEV BACKEND - NOT PRODUCTION").length).toBe(2);
    }

    const audit = db
      .query<{ recipient_count: number; failure_count: number }, []>(
        "SELECT recipient_count, failure_count FROM broadcast_emails",
      )
      .get();
    expect(audit).toEqual({ recipient_count: 2, failure_count: 0 });
  });

  test("a failed recipient is counted and listed, and the rest still go", async () => {
    const { binding, sent } = recordingBinding((m) =>
      m.to === "bad@nemar.test" ? bindingError("E_RECIPIENT_SUPPRESSED", "suppressed") : undefined,
    );
    const db = freshDb();
    const lines: string[] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    let result: Awaited<ReturnType<typeof broadcast>>;
    try {
      result = await broadcast(
        db,
        ["a@nemar.test", "bad@nemar.test", "c@nemar.test"],
        stagingEnv(binding),
      );
    } finally {
      console.error = real;
    }

    expect(sent.length).toBe(3);
    expect(result.recipient_count).toBe(2);
    expect(result.failure_count).toBe(1);
    expect(result.failed_recipients).toEqual(["bad@nemar.test"]);
    expect(lines.join("\n")).not.toContain("bad@nemar.test");
    expect(lines.join("\n")).toContain("b***@nemar.test");
  });

  test("a recipient whose send hangs past the bound is failed, not waited on", async () => {
    const sent: unknown[] = [];
    const binding: CloudflareSendEmail = {
      send: (message) => {
        sent.push(message.to);
        return message.to === "slow@nemar.test"
          ? new Promise(() => {})
          : Promise.resolve({ messageId: "<ok@staging.nemar.test>" });
      },
    };
    const db = freshDb();
    const result = await sendBroadcast(
      realD1(db),
      "",
      FROM,
      {
        sentById: seedSender(db),
        group: "admins",
        subject: "Maintenance window",
        bodyMarkdown: "Hello",
        recipients: ["a@nemar.test", "slow@nemar.test", "c@nemar.test"],
      },
      REPLY_TO,
      true,
      stagingEnv(binding),
      25,
    );
    expect(sent).toEqual(["a@nemar.test", "slow@nemar.test", "c@nemar.test"]);
    expect(result.recipient_count).toBe(2);
    expect(result.failed_recipients).toEqual(["slow@nemar.test"]);
    expect(result.failure_count).toBe(1);
  });

  test("a mistyped EMAIL_PROVIDER aborts as unconfigured and sends nothing", async () => {
    const { binding, sent } = recordingBinding();
    const result = await broadcast(
      freshDb(),
      ["a@nemar.test"],
      { ...stagingEnv(binding), EMAIL_PROVIDER: "cloudfare" },
      "re_key_present",
    );
    expect(result.error).toBe("email_service_unconfigured");
    expect(sent.length).toBe(0);
  });

  test("an all-suppressed broadcast calls the binding zero times", async () => {
    const { binding, sent } = recordingBinding();
    const result = await broadcast(
      freshDb(),
      ["x@example.org", "y@example.net"],
      stagingEnv(binding),
    );
    expect(sent.length).toBe(0);
    expect(result.suppressed_count).toBe(2);
    expect(result.recipient_count).toBe(0);
  });

  test("the provider set to cloudflare with no binding aborts as unconfigured and sends nothing", async () => {
    const db = freshDb();
    await withFakeResend(async (calls) => {
      const result = await broadcast(db, ["a@nemar.test"], stagingEnv(undefined), "re_key_present");
      expect(result.error).toBe("email_service_unconfigured");
      expect(result.broadcast_id).toBe(-1);
      expect(calls.length).toBe(0); // a Resend key on hand is not a fallback
    });
  });

  test("without EMAIL_PROVIDER the broadcast stays on the Resend batch path", async () => {
    const { binding, sent } = recordingBinding();
    const db = freshDb();
    await withFakeResend(async (calls) => {
      const result = await broadcast(
        db,
        ["a@nemar.test"],
        { ...stagingEnv(binding), EMAIL_PROVIDER: undefined },
        "re_key",
      );
      expect(result.recipient_count).toBe(1);
      expect(calls.length).toBe(1);
      expect(calls[0].path).toBe("/emails/batch");
    });
    expect(sent.length).toBe(0);
  });
});
