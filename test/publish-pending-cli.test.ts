/**
 * `nemar dataset publish request` when BIDS validation has not finished yet,
 * driven through the real CLI entry point.
 *
 * A publication request made before validation concludes is recorded as blocked,
 * and the backend answers 422 with block_reason `bids_validation_pending` or
 * `bids_validation_in_progress`. That is a pending state, not a rejection: the
 * CLI says so in the info style and exits 0, and it never waits or asks again on
 * its own. A real refusal (a failed validation, a missing minimum, a missing
 * owner name, a request already open, anything else) keeps its text and exits 1.
 * An identifier finding is never a refusal of this command: the request is
 * accepted, the screen runs after it, and a finding blocks the request later,
 * which `nemar dataset publish status` and the requester's mail report.
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
import {
  ACCEPTED_BODY,
  CI_UNAVAILABLE_BODY,
  DATASET_ID,
  FAILED_BODY,
  FAIL_MARK,
  IN_PROGRESS_BODY,
  MINIMUMS_BODY,
  MINIMUM_REASONS,
  OWNER_NAME_BODY,
  OWNER_NAME_MISSING_MESSAGE,
  PENDING_BODY,
  RED,
  SPAWN_TEST_TIMEOUT_MS,
  SUBMISSION_POLICY_URL,
  all,
  pendingStdout,
  usePendingCliHarness,
} from "./helpers/pending-cli";

const { standIn, run } = usePendingCliHarness();

const request = (...extra: string[]) =>
  run(["dataset", "publish", "request", DATASET_ID, ...extra]);
const requestInColor = () => run(["dataset", "publish", "request", DATASET_ID], { color: true });
const posts = () =>
  standIn.hits.filter((h) => h === `POST /datasets/${DATASET_ID}/publish/request`);
const WARNING = "you asked for an anonymous release, but the server did not";

describe("a CI-pending refusal is a pending state", () => {
  test("not started: exits 0, says it is recorded, and points at the CI command", async () => {
    standIn.reply = { status: 422, body: PENDING_BODY };
    const r = await request();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/^(ℹ|i) Request recorded: BIDS validation has not started yet\.$/m);
    // The headline is on stderr only; stdout opens with the line that says a
    // request exists, so a caller that drops stderr still reads it.
    expect(r.stdout).not.toContain("Request recorded");
    expect(r.stdout).toBe(pendingStdout());
    expect(r.stdout).toContain("nemar dataset ci nm099999");
    // The server's own refusal sentence is not repeated as an error.
    expect(all(r)).not.toContain("re-request publication");
    expect(all(r)).not.toContain("Failed");
    // Once. No waiting, no asking again.
    expect(posts()).toHaveLength(1);
  });

  test("running: exits 0 and the clause says so, not 'not started'", async () => {
    standIn.reply = { status: 422, body: IN_PROGRESS_BODY };
    const r = await request();
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/^(ℹ|i) Request recorded: BIDS validation is still running\.$/m);
    expect(all(r)).not.toContain("has not started yet");
    expect(r.stdout).toBe(pendingStdout());
    expect(posts()).toHaveLength(1);
  });

  test("not started does not say it is running", async () => {
    standIn.reply = { status: 422, body: PENDING_BODY };
    const r = await request();
    expect(all(r)).not.toContain("still running");
  });

  test("without a ci_url there is no CI line, and nothing else changes", async () => {
    standIn.reply = { status: 422, body: { ...PENDING_BODY, ci_url: undefined } };
    const r = await request();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(pendingStdout(false, null));
  });

  test(
    "it carries no error styling: no red, no failure mark, on either stream",
    async () => {
      for (const body of [PENDING_BODY, IN_PROGRESS_BODY]) {
        standIn.reply = { status: 422, body };
        const r = await requestInColor();
        expect(r.exitCode).toBe(0);
        const text = all(r);
        // The next test proves this detector sees red when there is some.
        expect(text).not.toMatch(RED);
        expect(text).not.toMatch(FAIL_MARK);
        expect(text).toContain("Request recorded");
      }
    },
    SPAWN_TEST_TIMEOUT_MS * 2,
  );

  test("control: the same detector does see red on a real refusal", async () => {
    standIn.reply = { status: 422, body: FAILED_BODY };
    const r = await requestInColor();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toMatch(RED);
  });

  test("a plain pending request is not warned about anonymity", async () => {
    // The body echoes anonymous:false, which is the right answer to a request
    // that did not ask for anonymity.
    standIn.reply = { status: 422, body: PENDING_BODY };
    const r = await request();
    expect(r.exitCode).toBe(0);
    expect(all(r)).not.toContain(WARNING);
    expect(all(r)).not.toContain("WARNING");
    expect(r.stdout).not.toContain("--anonymous");
  });
});

describe("an anonymous request that is pending", () => {
  test("confirmed: exits 0 and is handed its flag back in the command to run again", async () => {
    standIn.reply = { status: 422, body: { ...PENDING_BODY, anonymous: true } };
    const r = await request("--anonymous");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(pendingStdout(true));
    expect(r.stdout).toContain(
      "Once it has passed, request again: nemar dataset publish request nm099999 --anonymous",
    );
    expect(all(r)).not.toContain("WARNING");
    expect(standIn.bodies[0]).toContain('"anonymous":true');
  });

  test("not echoed at all: warned about, exits 1, and the flag still comes from what was typed", async () => {
    standIn.reply = { status: 422, body: { ...PENDING_BODY, anonymous: undefined } };
    const r = await request("--anonymous");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(WARNING);
    expect(r.stdout).toContain("nemar dataset publish status nm099999");
    // The server did not confirm the flag, yet the command to run again keeps it.
    expect(r.stdout).toContain(
      "Once it has passed, request again: nemar dataset publish request nm099999 --anonymous",
    );
  });

  test("echoed as false: the same, not read as unknown", async () => {
    standIn.reply = { status: 422, body: { ...PENDING_BODY, anonymous: false } };
    const r = await request("--anonymous");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(WARNING);
    expect(r.stdout).toContain("nemar dataset publish request nm099999 --anonymous");
  });
});

describe("a real refusal still exits 1 with its own text", () => {
  test("bids_validation_failed", async () => {
    standIn.reply = { status: 422, body: FAILED_BODY };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toContain(FAILED_BODY.message);
    expect(all(r)).not.toContain("Request recorded");
    expect(posts()).toHaveLength(1);
  });

  test("min_requirements_failed prints each reason and the policy", async () => {
    standIn.reply = { status: 422, body: MINIMUMS_BODY };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toContain(MINIMUMS_BODY.message);
    expect(r.stdout).toContain("Not accepted for publication:");
    for (const reason of MINIMUM_REASONS) expect(r.stdout).toContain(reason);
    expect(r.stdout).toContain(`Policy: ${SUBMISSION_POLICY_URL}`);
    expect(all(r)).not.toContain("Request recorded");
  });

  test("owner_name_missing", async () => {
    standIn.reply = { status: 422, body: OWNER_NAME_BODY };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toContain(OWNER_NAME_MISSING_MESSAGE);
    expect(all(r)).not.toContain("Request recorded");
  });

  test("a 422 with no block reason", async () => {
    standIn.reply = { status: 422, body: { error: "Validation failed" } };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toContain("Validation failed");
    expect(all(r)).not.toContain("Request recorded");
  });

  test("a pending reason in a 422 that is not a recorded block", async () => {
    // Nothing says the request was recorded, so nothing is promised.
    standIn.reply = {
      status: 422,
      body: { block_reason: "bids_validation_pending", message: PENDING_BODY.message },
    };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).not.toContain("Request recorded");
  });

  test("409, a request is already open", async () => {
    standIn.reply = {
      status: 409,
      body: {
        error: "A publication request already exists",
        status: "requested",
        message: "Use 'resend' to remind admins",
      },
    };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toContain("A publication request already exists");
    expect(r.stdout).toContain("nemar dataset publish resend");
    expect(all(r)).not.toContain("Request recorded");
  });

  test("403, not the owner", async () => {
    standIn.reply = {
      status: 403,
      body: { error: "Only the dataset owner can request publication" },
    };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toContain("Only the dataset owner can request publication");
  });

  test("503, validation status could not be checked: the sentence, exit 1, not a pending state", async () => {
    standIn.reply = { status: 503, body: CI_UNAVAILABLE_BODY };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).toContain(CI_UNAVAILABLE_BODY.message);
    // The bare code is not what a person reads.
    expect(all(r)).not.toContain("ci_check_unavailable");
    expect(all(r)).not.toContain("Request recorded:");
    expect(posts()).toHaveLength(1);
  });

  test("the pending reason on any other status is not a pending state", async () => {
    // The reason is read from a 422. The same word on a 500 is a server
    // fault, which keeps its error treatment and its exit code.
    standIn.reply = { status: 500, body: { ...PENDING_BODY, error: "Internal error" } };
    const r = await request();
    expect(r.exitCode).toBe(1);
    expect(all(r)).not.toContain("Request recorded");
  });
});

describe("an accepted request", () => {
  test("exits 0 and is told, among the rest, which mails to expect", async () => {
    standIn.reply = { status: 200, body: ACCEPTED_BODY };
    const r = await request();
    expect(r.exitCode).toBe(0);
    const flat = r.stdout.replace(/\s+/g, " ");
    expect(flat).toContain("Your request was received.");
    expect(flat).toContain("You will be emailed");
    expect(flat).toContain("nemar dataset publish status nm099999");
    expect(all(r)).not.toContain("Request recorded");
  });

  test("an anonymous release the server confirmed exits 0", async () => {
    standIn.reply = { status: 200, body: { ...ACCEPTED_BODY, anonymous: true } };
    const r = await request("--anonymous");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Your identity will be withheld");
    expect(all(r)).not.toContain("WARNING");
  });

  test(
    "an anonymous release the server did not confirm is warned about and exits 1",
    async () => {
      // It would be published under the real name, so a script must not go on.
      for (const body of [
        { ...ACCEPTED_BODY, anonymous: false },
        { ...ACCEPTED_BODY, anonymous: undefined },
      ]) {
        standIn.reply = { status: 200, body };
        const r = await request("--anonymous");
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain(WARNING);
        // The rest of the answer is still printed before the exit.
        expect(r.stdout).toContain("Your request was received.");
      }
    },
    SPAWN_TEST_TIMEOUT_MS * 2,
  );
});

describe("there is no --wait", () => {
  test("the flag is refused as unknown and no request is sent", async () => {
    standIn.reply = { status: 422, body: PENDING_BODY };
    const r = await request("--wait");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown option '--wait'");
    expect(posts()).toHaveLength(0);
  });
});

describe("the help text", () => {
  test("--help-all says validation runs after the upload, what a request before it does, and how to check", async () => {
    // The detailed text sits behind --help-all, as for every command.
    const r = await run(["dataset", "publish", "request", "--help-all"]);
    expect(r.exitCode).toBe(0);
    const flat = r.stdout.replace(/\s+/g, " ");
    expect(flat).toContain(
      "BIDS validation runs on GitHub after the upload. A request made before it has completed is recorded, and NEMAR continues it once validation passes.",
    );
    expect(flat).toContain("Check validation with: nemar dataset ci <dataset-id>");
    expect(r.stdout).not.toContain("--wait");
  });

  test("--help is the short form: it points at --help-all and carries no detail", async () => {
    const r = await run(["dataset", "publish", "request", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--help-all");
    expect(r.stdout).toContain("--anonymous");
    expect(r.stdout).not.toContain("BIDS validation runs");
    expect(r.stdout).not.toContain("--wait");
  });
});
