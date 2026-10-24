/**
 * Inbound mail (epic #1893 phase 1, ADR 0110): a message Email Routing hands the Worker lands in
 * the `MAIL_INBOUND` bucket untouched, and a Worker with no bucket rejects it.
 *
 * Two layers, both against real R2 (Miniflare's local simulator, the implementation
 * `wrangler dev` runs):
 *   - `handleInboundEmail` called with a message shaped as the platform shapes it (a real
 *     single-use stream, the envelope addresses, the parsed headers), so the stored key, bytes and
 *     metadata are asserted against what the bucket actually holds;
 *   - the Worker as it would be deployed, bundled by the production bundler and driven through
 *     Miniflare's `/cdn-cgi/handler/email`, so the `email()` export itself is exercised. That is
 *     the only way to see that the handler is wired into the default export.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import {
  INBOUND_REJECT_REASON,
  clampUtf8Bytes,
  handleInboundEmail,
} from "../src/services/inbound-mail";
import { bundleWorker, wranglerCompatibility } from "./helpers/worker-bundle";

const KEY_SHAPE = /^inbound\/raw\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.eml$/;

/** A message with a non-ASCII subject and a binary-ish base64 body, CRLF line ends throughout. */
function rawMessage(messageId: string): Uint8Array {
  const text = [
    "From: Ada Tester <ada@sender.test>",
    "To: support@staging.nemar.test",
    "Subject: =?UTF-8?B?w4TDvMOfIHRlc3Q=?=",
    `Message-ID: <${messageId}@sender.test>`,
    "Date: Fri, 23 Oct 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: application/octet-stream",
    "Content-Transfer-Encoding: base64",
    "",
    "AAECAwQFBgcICQoLDA0ODw==",
    "",
  ].join("\r\n");
  return new TextEncoder().encode(text);
}

/** The message as the platform hands it to `email()`. */
function platformMessage(raw: Uint8Array, from: string, to: string, rejects: string[] = []) {
  const headers = new Headers();
  const id = /Message-ID: (<[^>]+>)/.exec(new TextDecoder().decode(raw))?.[1];
  if (id) headers.set("message-id", id);
  return {
    from,
    to,
    headers,
    rawSize: raw.byteLength,
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    setReject: (reason: string) => {
      rejects.push(reason);
    },
  } as unknown as ForwardableEmailMessage;
}

/** Every line Miniflare logged: where the local email handler reports a rejection. */
class CapturingLog extends Log {
  readonly lines: string[] = [];
  override logWithLevel(level: LogLevel, message: string): void {
    this.lines.push(message);
    super.logWithLevel(level, message);
  }
}

let mf: Miniflare;
let bucket: R2Bucket;

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: "export default {}", r2Buckets: ["MAIL_INBOUND"] });
  bucket = (await mf.getR2Bucket("MAIL_INBOUND")) as unknown as R2Bucket;
});

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

async function keys(b: R2Bucket = bucket): Promise<string[]> {
  return (await b.list({ prefix: "inbound/raw/" })).objects.map((o) => o.key);
}

describe("clampUtf8Bytes", () => {
  test("leaves a short value alone and cuts at a character boundary", () => {
    expect(clampUtf8Bytes("abc", 400)).toBe("abc");
    expect(clampUtf8Bytes("abcdef", 3)).toBe("abc");
    expect(clampUtf8Bytes("aé", 2)).toBe("a"); // é is bytes 1-2: a cut at 2 would split it
    expect(clampUtf8Bytes("a€b", 3)).toBe("a"); // € is bytes 1-3
    expect(clampUtf8Bytes("a😀", 4)).toBe("a"); // a four-byte character
    expect(clampUtf8Bytes("a😀", 5)).toBe("a😀");
    expect(clampUtf8Bytes("é", 0)).toBe("");
  });
});

describe("handleInboundEmail", () => {
  test("stores the raw bytes at a dated key with the envelope and message id as metadata", async () => {
    const before = new Set(await keys());
    const raw = rawMessage("one");
    const rejects: string[] = [];
    const startedAt = Date.now();
    await handleInboundEmail(
      platformMessage(raw, "ada@sender.test", "support@staging.nemar.test", rejects),
      { MAIL_INBOUND: bucket },
    );

    const added = (await keys()).filter((k) => !before.has(k));
    expect(added.length).toBe(1);
    const key = added[0];
    expect(key).toMatch(KEY_SHAPE);
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
    expect(key.startsWith(`inbound/raw/${day}/`)).toBe(true);

    const stored = (await bucket.get(key)) as R2ObjectBody;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(raw);
    expect(stored.httpMetadata?.contentType).toBe("message/rfc822");
    expect(stored.customMetadata).toMatchObject({
      envelope_from: "ada@sender.test",
      envelope_to: "support@staging.nemar.test",
      message_id: "<one@sender.test>",
    });
    const receivedAt = Date.parse(stored.customMetadata?.received_at ?? "");
    expect(receivedAt).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(receivedAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(rejects).toEqual([]);
  });

  test("each message gets its own object", async () => {
    const before = new Set(await keys());
    for (const id of ["a", "b"]) {
      await handleInboundEmail(
        platformMessage(rawMessage(id), "ada@sender.test", "support+t1@staging.nemar.test"),
        { MAIL_INBOUND: bucket },
      );
    }
    const added = (await keys()).filter((k) => !before.has(k));
    expect(added.length).toBe(2);
    expect(new Set(added).size).toBe(2);
  });

  test("a message with no Message-ID header is stored with an empty message_id", async () => {
    const before = new Set(await keys());
    const raw = new TextEncoder().encode(
      "From: a@sender.test\r\nTo: b@staging.nemar.test\r\n\r\nhi\r\n",
    );
    await handleInboundEmail(platformMessage(raw, "a@sender.test", "b@staging.nemar.test"), {
      MAIL_INBOUND: bucket,
    });
    const key = (await keys()).find((k) => !before.has(k)) as string;
    const stored = (await bucket.get(key)) as R2ObjectBody;
    expect(stored.customMetadata?.message_id).toBe("");
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(raw);
  });

  test("with no bucket the message is rejected and nothing is stored", async () => {
    const before = await keys();
    const rejects: string[] = [];
    await handleInboundEmail(
      platformMessage(rawMessage("none"), "ada@sender.test", "support@staging.nemar.test", rejects),
      {},
    );
    expect(rejects).toEqual([INBOUND_REJECT_REASON]);
    expect(await keys()).toEqual(before);
  });

  test("metadata is clamped by UTF-8 bytes, without splitting a character, and stays under 2 KiB", async () => {
    const before = new Set(await keys());
    // 300 two-byte characters is 600 bytes but only 300 UTF-16 units, so a unit-based clamp
    // would let it through; a three-byte character straddling the cut must be dropped whole.
    const long = "é".repeat(300);
    const raw = rawMessage("clamp");
    const message = platformMessage(
      raw,
      `${long}@sender.test`,
      `${"€".repeat(200)}@staging.nemar.test`,
    );
    message.headers.set("message-id", `<${long}${long}@sender.test>`);
    await handleInboundEmail(message, { MAIL_INBOUND: bucket });

    const key = (await keys()).find((k) => !before.has(k)) as string;
    const stored = (await bucket.get(key)) as R2ObjectBody;
    const meta = stored.customMetadata ?? {};
    const enc = new TextEncoder();
    for (const field of ["envelope_from", "envelope_to", "message_id"]) {
      expect(enc.encode(meta[field]).byteLength).toBeLessThanOrEqual(400);
      expect(meta[field]).not.toContain("\uFFFD");
      expect(meta[field].length).toBeGreaterThan(0);
    }
    expect(meta.envelope_from).toBe("é".repeat(200));
    expect(meta.envelope_to).toBe("€".repeat(133));
    const total = Object.entries(meta).reduce(
      (n, [k, v]) => n + enc.encode(k).byteLength + enc.encode(v).byteLength,
      0,
    );
    expect(total).toBeLessThan(2048);
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(raw);
  });

  test("a put that fails with metadata is retried without it and the message is kept", async () => {
    const before = new Set(await keys());
    // R2 refusing the metadata, simulated at the boundary: the real bucket takes every other put.
    const refusingMetadata = {
      put: (key: string, value: ArrayBuffer, options?: Parameters<R2Bucket["put"]>[2]) => {
        if (options?.customMetadata) throw new Error("metadata refused");
        return bucket.put(key, value, options);
      },
    } as unknown as R2Bucket;
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    const raw = rawMessage("retry");
    try {
      await handleInboundEmail(
        platformMessage(raw, "ada@sender.test", "support@staging.nemar.test"),
        { MAIL_INBOUND: refusingMetadata },
      );
    } finally {
      console.warn = realWarn;
    }
    const added = (await keys()).filter((k) => !before.has(k));
    expect(added.length).toBe(1);
    const stored = (await bucket.get(added[0])) as R2ObjectBody;
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(raw);
    expect(stored.httpMetadata?.contentType).toBe("message/rfc822");
    expect(stored.customMetadata ?? {}).toEqual({});
    expect(warnings.join("\n")).toContain("retrying without it");
  });

  test("a failed write throws so the delivery is reported as failed, not lost", async () => {
    const failing = {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;
    await expect(
      handleInboundEmail(
        platformMessage(rawMessage("fail"), "ada@sender.test", "support@staging.nemar.test"),
        { MAIL_INBOUND: failing },
      ),
    ).rejects.toThrow("R2 unavailable");
  });
});

describe("the deployed Worker's email() export", () => {
  let bundle: string;
  let withBucket: Miniflare;
  let withoutBucket: Miniflare;
  let deployedBucket: R2Bucket;
  const rejectionLog = new CapturingLog(LogLevel.INFO);

  const worker = (extra: Record<string, unknown>) => {
    const { date, flags } = wranglerCompatibility();
    return new Miniflare({
      modules: [{ type: "ESModule", path: "worker.js", contents: bundle }],
      compatibilityDate: date,
      compatibilityFlags: flags,
      d1Databases: { DB: "nemar-db-inbound-test" },
      // Serves /cdn-cgi/handler/email, the local stand-in for Email Routing.
      unsafeTriggerHandlers: true,
      ...extra,
    });
  };

  const deliver = (m: Miniflare, raw: Uint8Array, from: string, to: string) =>
    m.dispatchFetch(
      `http://inbound.test/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { method: "POST", body: raw },
    );

  beforeAll(async () => {
    bundle = bundleWorker();
    withBucket = worker({ r2Buckets: ["MAIL_INBOUND"] });
    withoutBucket = worker({ log: rejectionLog });
    await Promise.all([withBucket.ready, withoutBucket.ready]);
    deployedBucket = (await withBucket.getR2Bucket("MAIL_INBOUND")) as unknown as R2Bucket;
  }, 120_000);

  afterAll(async () => {
    await Promise.all([withBucket?.dispose(), withoutBucket?.dispose()]);
  }, 30_000);

  test("a message routed to the Worker is stored in the bucket", async () => {
    const raw = rawMessage("deployed");
    const res = await deliver(withBucket, raw, "ada@sender.test", "support@staging.nemar.test");
    expect(res.status).toBe(200);

    const stored = await keys(deployedBucket);
    expect(stored.length).toBe(1);
    expect(stored[0]).toMatch(KEY_SHAPE);
    const object = (await deployedBucket.get(stored[0])) as R2ObjectBody;
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(raw);
    expect(object.customMetadata).toMatchObject({
      envelope_from: "ada@sender.test",
      envelope_to: "support@staging.nemar.test",
      message_id: "<deployed@sender.test>",
    });
  });

  test("a Worker with no MAIL_INBOUND binding rejects the message", async () => {
    const res = await deliver(
      withoutBucket,
      rawMessage("rejected"),
      "ada@sender.test",
      "support@staging.nemar.test",
    );
    // The simulator answers 200 here, because the Worker's `setReject` call reaches its entry
    // worker after the handler has returned; the rejection is read from the log line Miniflare
    // writes when it arrives. What this shows is that the exported `email()` ran the handler.
    expect(res.status).toBe(200);
    let line: string | undefined;
    for (let i = 0; i < 50 && !line; i++) {
      line = rejectionLog.lines.find((l) => l.includes("Email handler rejected message"));
      if (!line) await Bun.sleep(100);
    }
    expect(line).toContain(INBOUND_REJECT_REASON);
  });
});
