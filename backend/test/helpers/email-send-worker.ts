/**
 * A Worker entry that runs the real `sendRevocationEmail` against the `EMAIL` binding it is given.
 *
 * email-send-binding.test.ts bundles this file and runs it in workerd through Miniflare, whose
 * `send_email` binding is the one `wrangler dev` hands a Worker. The sender is the production
 * module, unchanged: only what stands behind `env.EMAIL` is the simulator.
 *
 * `POST /` takes `{ to, from, replyTo }` and answers `{ ok: true }` or the thrown error's name and
 * message.
 */

import { type EmailDeliveryEnv, sendRevocationEmail } from "../../src/services/email";

interface Env {
  EMAIL: EmailDeliveryEnv["EMAIL"];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { to, from, replyTo } = (await request.json()) as {
      to: string;
      from: string;
      replyTo?: string;
    };
    try {
      await sendRevocationEmail(to, "tester", "unused", from, replyTo, true, {
        ENVIRONMENT: "development",
        DEV_EMAIL_ALLOWLIST: "@nemar.test",
        EMAIL_PROVIDER: "cloudflare",
        EMAIL: env.EMAIL,
      });
      return Response.json({ ok: true });
    } catch (error) {
      const e = error as Error;
      return Response.json({ ok: false, name: e.name, message: e.message });
    }
  },
};
