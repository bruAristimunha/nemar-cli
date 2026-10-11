/**
 * `nemar dataset publish status` for a request that is waiting on BIDS
 * validation, driven through the real CLI entry point.
 *
 * A request blocked only because validation has not finished is a pending state,
 * and the status view says so the way `publish request` does: in the info style,
 * with the command to run again carrying `--anonymous` for an anonymous request
 * (asking again without it would turn a blind request into a named one), and
 * without the red "Blocked:" the server's sentence would print. Any other
 * blocked reason stays a red block.
 *
 * The harness (a stand-in backend, an isolated config directory, the spawned
 * CLI) is test/helpers/pending-cli.ts.
 *
 * test.yml sorts a test file into the integration-dev tier when its TEXT matches a
 * grep for the live-backend environment variable, the request helper or the
 * CLI-runner helper, and that grep reads comments too, so none of those three
 * names appears anywhere in this file: it stays in the offline unit-pure tier.
 */

import { describe, expect, test } from "bun:test";
import { ciPendingHint } from "../src/lib/publish-pending";
import {
  CI_URL,
  DATASET_ID,
  FAILED_BODY,
  FAIL_MARK,
  IN_PROGRESS_BODY,
  MINIMUMS_BODY,
  MINIMUM_REASONS,
  RED,
  SUBMISSION_POLICY_URL,
  all,
  statusBody,
  usePendingCliHarness,
} from "./helpers/pending-cli";

const { standIn, run } = usePendingCliHarness();

const status = (opts: { color?: boolean } = {}) =>
  run(["dataset", "publish", "status", DATASET_ID], opts);

describe("publish status for a request that is waiting on validation", () => {
  test("not started: info, not a red block, and no 'then re-request' from the server's sentence", async () => {
    standIn.statusReply = { status: 200, body: statusBody() };
    const r = await status();
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines).toContain("  ℹ Request recorded: BIDS validation has not started yet.");
    // The hint, whole and in order, and the link to the runs.
    const at = lines.indexOf("  ℹ Request recorded: BIDS validation has not started yet.");
    expect(lines.slice(at + 1, at + 1 + 6)).toEqual(ciPendingHint(DATASET_ID));
    expect(r.stdout).toContain(`CI: ${CI_URL}`);
    expect(r.stdout).not.toContain("Blocked:");
    expect(all(r)).not.toContain("re-request publication");
    expect(r.stdout).not.toContain("--anonymous' to retry");
    // The stand-in sends the screen view the real route sends for a request
    // that has not been released ("NOT RUN for this request"); a request
    // that is only waiting is not told its screen did not run.
    expect(r.stdout).not.toContain("Identifier screen");
  });

  test("running: the clause says so", async () => {
    standIn.statusReply = {
      status: 200,
      body: statusBody({
        block_reason: "bids_validation_in_progress",
        message: IN_PROGRESS_BODY.message,
      }),
    };
    const r = await status();
    expect(r.stdout).toContain("Request recorded: BIDS validation is still running.");
    expect(r.stdout).not.toContain("has not started yet");
    expect(r.stdout).not.toContain("Blocked:");
  });

  test("it carries no error styling", async () => {
    standIn.statusReply = { status: 200, body: statusBody() };
    const r = await status({ color: true });
    expect(r.exitCode).toBe(0);
    expect(all(r)).not.toMatch(RED);
    expect(all(r)).not.toMatch(FAIL_MARK);
  });

  test("an anonymous request is handed its flag back, so retrying cannot name the depositor", async () => {
    standIn.statusReply = { status: 200, body: statusBody({ anonymous: true }) };
    const r = await status();
    expect(r.stdout).toContain("Anonymous: yes");
    expect(r.stdout).toContain(
      "Once it has passed, request again: nemar dataset publish request nm099999 --anonymous",
    );
  });

  test("a request that is not anonymous is not told to add the flag", async () => {
    standIn.statusReply = { status: 200, body: statusBody() };
    const r = await status();
    expect(r.stdout).not.toContain("--anonymous");
  });
});

describe("publish status for a request blocked for another reason", () => {
  test("a failed validation stays a red block with the server's sentence and its retry command", async () => {
    standIn.statusReply = {
      status: 200,
      body: statusBody({ block_reason: "bids_validation_failed", message: FAILED_BODY.message }),
    };
    const r = await status({ color: true });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Blocked:");
    expect(r.stdout).toContain(FAILED_BODY.message);
    expect(r.stdout).toMatch(RED);
    expect(r.stdout).not.toContain("Request recorded");
    expect(r.stdout).toContain("nemar dataset publish request nm099999' to retry now");
    // Only a request waiting on validation leaves its screen unmentioned.
    expect(r.stdout).toContain("Identifier screen");
  });

  test("an anonymous request's retry command keeps the flag for every reason", async () => {
    standIn.statusReply = {
      status: 200,
      body: statusBody({
        anonymous: true,
        block_reason: "bids_validation_failed",
        message: FAILED_BODY.message,
      }),
    };
    const r = await status();
    expect(r.stdout).toContain("nemar dataset publish request nm099999 --anonymous' to retry now");
  });

  test("min_requirements_failed lists its reasons in red", async () => {
    standIn.statusReply = {
      status: 200,
      body: statusBody({
        block_reason: "min_requirements_failed",
        message: MINIMUMS_BODY.message,
        reasons: MINIMUM_REASONS,
        policy_url: SUBMISSION_POLICY_URL,
      }),
    };
    const r = await status({ color: true });
    expect(r.stdout).toContain("Blocked:");
    for (const reason of MINIMUM_REASONS) expect(r.stdout).toContain(reason);
    expect(r.stdout).toContain(`Policy: ${SUBMISSION_POLICY_URL}`);
    expect(r.stdout).not.toContain("Request recorded");
    expect(r.stdout).toMatch(RED);
  });
});
