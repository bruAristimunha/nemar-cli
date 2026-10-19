/**
 * Answers in the Messages API's own wire format, for the test stand-ins of api.anthropic.com.
 *
 * The review's model calls stream (`messages.stream(...).finalMessage()`), so the real SDK sends
 * `stream: true` and reads server-sent events. A stand-in that answered those requests with a plain
 * JSON message would not exercise the reading the job really does: how the SDK assembles the text,
 * the stop reason and the usage from the events. {@link sseReply} turns a message into exactly that
 * sequence (`message_start`, a start, deltas and a stop per content block, `message_delta` with the
 * stop reason and the output tokens, `message_stop`), so the SDK's own accumulator builds the message
 * the test meant. {@link messageJson} is the same message as a plain response, for a request that
 * did not ask to stream.
 */

/** A content block of a stand-in message: text, or a thinking block (empty, as the API omits it). */
export type StandInBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string };

export interface StandInMessage {
  model: string;
  content: StandInBlock[];
  /** `end_turn`, `max_tokens`, `refusal`, ... */
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** A message whose one text block holds `text`, with a thinking block before it as at max effort. */
export function standInMessage(
  text: string,
  over: Partial<Omit<StandInMessage, "content">> = {},
): StandInMessage {
  return {
    model: over.model ?? "claude-haiku-5-5",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text },
    ],
    stop_reason: over.stop_reason ?? "end_turn",
    usage: over.usage ?? { input_tokens: 1200, output_tokens: 300 },
  };
}

/** The message as the non-streaming API returns it. */
export function messageJson(m: StandInMessage): Response {
  return Response.json({
    id: "msg_stand_in",
    type: "message",
    role: "assistant",
    model: m.model,
    content: m.content.map((b) =>
      b.type === "thinking" ? { type: "thinking", thinking: b.thinking, signature: "sig" } : b,
    ),
    stop_reason: m.stop_reason,
    stop_sequence: null,
    usage: m.usage,
  });
}

function event(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Cut text into pieces of at most `size` characters, so a block arrives as several deltas. */
function pieces(text: string, size: number): string[] {
  if (text === "") return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** The server-sent events of the message, as the streaming API sends them. */
export function sseEvents(m: StandInMessage, chunk = 17): string[] {
  const out: string[] = [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_stand_in",
        type: "message",
        role: "assistant",
        model: m.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: m.usage.input_tokens, output_tokens: 1 },
      },
    }),
  ];
  m.content.forEach((block, index) => {
    if (block.type === "thinking") {
      out.push(
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
      );
      for (const piece of pieces(block.thinking, chunk)) {
        out.push(
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: piece },
          }),
        );
      }
      out.push(
        event("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: "sig" },
        }),
      );
    } else {
      out.push(
        event("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
      );
      for (const piece of pieces(block.text, chunk)) {
        out.push(
          event("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: piece },
          }),
        );
      }
    }
    out.push(event("content_block_stop", { type: "content_block_stop", index }));
  });
  out.push(
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: m.stop_reason, stop_sequence: null },
      usage: { output_tokens: m.usage.output_tokens },
    }),
    event("message_stop", { type: "message_stop" }),
  );
  return out;
}

/** The message as a streamed response: `text/event-stream`, one event per write. */
export function sseReply(m: StandInMessage): Response {
  const events = sseEvents(m);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/**
 * A response that starts streaming and then never finishes: `message_start` and nothing more, held
 * open until the request is aborted. For a test of a stage's deadline.
 */
export function stalledReply(m: StandInMessage, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const first = sseEvents(m)[0] ?? "";
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(first));
      signal.addEventListener("abort", () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A streamed response whose body is exactly these events, then the end of the body. */
function eventStream(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A stream that breaks off: the message and its first block begin, some text arrives, and the body
 * ends there, with no stop reason and no `message_stop`. What a connection lost mid-answer looks
 * like to the SDK.
 */
export function cutShortReply(m: StandInMessage): Response {
  const events = sseEvents(m);
  const textStart = events.findIndex((e) => e.includes('"type":"text"'));
  return eventStream(events.slice(0, textStart >= 0 ? textStart + 2 : 1));
}

/** A 200 that streams nothing at all. */
export function emptyStreamReply(): Response {
  return eventStream([]);
}

/** A stream that begins and then carries the API's own `error` event, as an overload mid-answer does. */
export function errorEventReply(m: StandInMessage, type: string, message: string): Response {
  const first = sseEvents(m)[0] ?? "";
  return eventStream([first, event("error", { type: "error", error: { type, message } })]);
}

/**
 * The reply to a request: streamed when it asked to stream, plain otherwise. A `Response` is sent as
 * it is (an error a test builds), so a stand-in's reply function can return either.
 */
export function replyFor(
  body: Record<string, unknown>,
  reply: StandInMessage | Response,
): Response {
  if (reply instanceof Response) return reply;
  return body.stream === true ? sseReply(reply) : messageJson(reply);
}
