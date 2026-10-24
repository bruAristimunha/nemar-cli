/**
 * The Cloudflare `send_email` binding, as Miniflare simulates it (epic #1893, ADR 0110).
 *
 * email-provider.test.ts records what the sender hands the binding; this file hands it to the
 * simulator the way `wrangler dev` does. The real `sendRevocationEmail` runs in workerd (bundled
 * from helpers/email-send-worker.ts) against a `send_email` binding restricted to one sender, as
 * `[[env.dev.send_email]]` restricts the staging Worker. What it proves that the recorder cannot:
 *   - the simulator accepts the structured form the sender builds (`{ email, name }` for `from` and
 *     `replyTo`, a string `to`), and logs it with the `[DEV]` subject;
 *   - a sender outside `allowed_sender_addresses` is refused by the binding, so the Worker
 *     structurally cannot send as another address.
 * What it cannot show: the simulator raises no `E_*` codes, so the error mapping is covered in
 * email-provider.test.ts, and it sends nothing, so delivery is checked on staging.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Log, LogLevel, Miniflare } from "miniflare";

const ALLOWED_SENDER = "noreply@staging.nemar.test";

/** Every line Miniflare logged, so a test can read what the binding was handed. */
class CapturingLog extends Log {
  readonly lines: string[] = [];
  override logWithLevel(level: LogLevel, message: string): void {
    this.lines.push(message);
    super.logWithLevel(level, message);
  }
}

let mf: Miniflare;
const log = new CapturingLog(LogLevel.INFO);

async function bundleSendWorker(): Promise<string> {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/helpers/email-send-worker.ts`],
    target: "browser",
    format: "esm",
  });
  const [output] = build.outputs;
  if (!build.success || !output) {
    throw new Error(`bundling the send worker failed: ${build.logs.join("\n")}`);
  }
  return output.text();
}

beforeAll(async () => {
  mf = new Miniflare({
    log,
    modules: true,
    script: await bundleSendWorker(),
    compatibilityDate: "2024-12-01",
    email: { send_email: [{ name: "EMAIL", allowed_sender_addresses: [ALLOWED_SENDER] }] },
  });
  await mf.ready;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

async function send(body: { to: string; from: string; replyTo?: string }) {
  const res = await mf.dispatchFetch("http://send.test/", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; name?: string; message?: string };
}

/** Poll the captured log: the binding logs through `waitUntil`, after it has answered. */
async function logged(needle: string): Promise<string | undefined> {
  for (let i = 0; i < 50; i++) {
    const hit = log.lines.find((l) => l.includes(needle));
    if (hit) return hit;
    await Bun.sleep(100);
  }
  return undefined;
}

describe("sendRevocationEmail against Miniflare's send_email binding", () => {
  test("the structured message is accepted and logged with the parsed sender and the [DEV] subject", async () => {
    const result = await send({
      to: "tester@nemar.test",
      from: `NEMAR Staging <${ALLOWED_SENDER}>`,
      replyTo: "support@staging.nemar.test",
    });
    expect(result).toEqual({ ok: true });

    const line = await logged("send_email binding called with MessageBuilder");
    expect(line).toBeDefined();
    expect(line).toContain(`From: "NEMAR Staging" <${ALLOWED_SENDER}>`);
    expect(line).toContain("To: tester@nemar.test");
    expect(line).toContain("Subject: [DEV] NEMAR account access revoked");
  });

  test("a sender outside allowed_sender_addresses is refused by the binding", async () => {
    const result = await send({
      to: "tester@nemar.test",
      from: "NEMAR <noreply@nemar.test>",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("email from noreply@nemar.test not allowed");
    // The simulator raises a plain Error, so the sender leaves it a plain Error: the send may
    // have been accepted as far as the caller can tell.
    expect(result.name).toBe("Error");
  });
});
