/**
 * Tell the PREVIOUS address that an account's sign-in email moved, for the one
 * route outside self-service that can move it (`PATCH /admin/users/by-id/:id`,
 * ADR 0096).
 *
 * The same notice `PATCH`-ing your own email sends (#1054; ADR 0044), through the
 * same sender, for the same reason: NEMAR sign-in is passwordless, so whoever
 * holds an account's email can sign in as it, and the old inbox is the only
 * channel that can reach a legitimate owner whose address was moved out from
 * under them. An admin edit is exactly that case from the owner's side, so it
 * must not be the one route that stays silent.
 *
 * Never throws and never blocks: the change has already committed when this
 * runs, so the only question left is whether the old inbox heard about it, and
 * the answer is returned for the route to report. A non-production worker
 * refuses any recipient off its allow-list (AGENTS.md: the dev database holds
 * real addresses behind a live mail key), which lands here as `false`, not as
 * an error.
 *
 * The new address is MASKED in the notice: whoever reads the old inbox may no
 * longer be the account owner, and they need to know the address changed, not
 * what it changed to.
 */

import type { Bindings } from "../types/bindings";
import { maskEmail } from "./auth-code";
import { resolveEmailConfig, sendEmailChangedNoticeEmail } from "./email";

export async function notifyPreviousEmailAddress(
  env: Bindings,
  userId: number,
  oldEmail: string,
  newEmail: string,
): Promise<boolean> {
  try {
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
    await sendEmailChangedNoticeEmail(
      oldEmail,
      maskEmail(newEmail),
      env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      env,
    );
    return true;
  } catch (err) {
    // The account id, because this mail is the ONLY channel that reaches a
    // legitimate owner whose address was moved: a failure here is one an
    // operator may have to act on, and the log has to name whom.
    console.error(
      `[admin-user-edit] could not notify the previous address of user id=${userId} (the change DID land)`,
      err,
    );
    return false;
  }
}
