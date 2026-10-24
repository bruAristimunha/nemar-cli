// The external boundary for tests of Cloudflare Queues (epic #1893 phase 2).
//
// Not a mock of the outbox: services/broadcast.ts and services/email-outbox.ts run unchanged.
// Only what stands behind `env.EMAIL_OUTBOX`, the Queue producer binding, is replaced by a
// recorder, and the consumer's `MessageBatch` is a plain object whose ack/retry are recorders.

export interface RecordedQueue {
  queue: Queue;
  /** Bodies in the order they were enqueued, across `send` and `sendBatch`. */
  bodies: unknown[];
  /** The size of each `sendBatch` call. */
  batchSizes: number[];
}

/** A Queue producer that records what it is handed. `failBatchAt` throws on that (0-based) sendBatch call. */
export function recordingQueue(options: { failBatchAt?: number } = {}): RecordedQueue {
  const bodies: unknown[] = [];
  const batchSizes: number[] = [];
  const queue = {
    async send(body: unknown) {
      bodies.push(body);
    },
    async sendBatch(messages: Iterable<{ body: unknown }>) {
      const list = [...messages];
      if (batchSizes.length === options.failBatchAt) {
        batchSizes.push(-1);
        throw new Error("queue unavailable");
      }
      batchSizes.push(list.length);
      for (const m of list) bodies.push(m.body);
    },
  } as unknown as Queue;
  return { queue, bodies, batchSizes };
}

export interface RecordedMessage {
  body: unknown;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
}

/** A consumer batch of `bodies`, with each message's ack and retry recorded. */
/** `attempts` is each message's delivery attempt number (the first delivery is 1). */
export function recordingBatch(bodies: unknown[], attempts = 1) {
  const recorded: RecordedMessage[] = bodies.map((body) => ({ body, acked: false, retried: null }));
  const messages = recorded.map((r, i) => ({
    id: `m${i}`,
    timestamp: new Date(0),
    attempts,
    body: r.body,
    ack() {
      r.acked = true;
    },
    retry(options?: { delaySeconds?: number }) {
      r.retried = options ?? {};
    },
  }));
  const batch = {
    queue: "nemar-email-outbox-test",
    messages,
    ackAll() {
      for (const r of recorded) r.acked = true;
    },
    retryAll() {
      for (const r of recorded) r.retried = {};
    },
  } as unknown as MessageBatch<unknown>;
  return { batch, recorded };
}
