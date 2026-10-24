// The external boundary for tests of the Cloudflare mail provider (epic #1893, ADR 0110).
//
// Not a mock of the email service: services/email.ts runs unchanged. Only what stands behind
// `env.EMAIL`, the `send_email` binding, is replaced by a recorder, the way `withFakeResend`
// redirects `api.resend.com` to a local server. It exists because the binding's failures carry a
// Cloudflare `.code` that Miniflare's simulator never raises (email-send-binding.test.ts drives
// the simulator for what it does implement).

import type { CloudflareSendEmail } from "../../src/services/email";

export type BindingMessage = Parameters<CloudflareSendEmail["send"]>[0];

/**
 * A `send_email` binding that records what it is handed. `failure`, when given, is called per send
 * with the message and returns what to throw (or undefined to let that send succeed).
 */
export function recordingBinding(failure?: (message: BindingMessage) => unknown) {
  const sent: BindingMessage[] = [];
  const binding: CloudflareSendEmail = {
    async send(message) {
      sent.push(message);
      const thrown = failure?.(message);
      if (thrown !== undefined) throw thrown;
      return { messageId: "<recorded@staging.nemar.test>" };
    },
  };
  return { binding, sent };
}

/** An error the way the binding raises one: an Error with a `code`. */
export function bindingError(code: string | undefined, message = "refused"): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}
