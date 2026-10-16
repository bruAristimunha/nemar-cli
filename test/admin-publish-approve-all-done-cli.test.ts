/**
 * `nemar admin publish approve` of a request whose steps are all done (ADR 0105 decision 12,
 * #1730): what the operator is told when a tail job warned.
 *
 * A resumed run with every step already complete runs two tail jobs of a de-anonymization (the
 * Zarr rebuild stamp and the completion of the version identifiers a concealed release left
 * reserved). When one warns, the warning says to approve the request again to retry it, and the
 * Worker leaves the request `approving` so that is true. The warning has to reach the person who
 * can act on it: the command prints the answer's `warning` (one key, the warnings joined), and an
 * answer that carried it under another key printed a success line and exited 0 with the sentence
 * that says what to do lost. The real command against the real backend app over a real D1
 * (`helpers/admin-publish-cli.ts`); the dataset has a concealed era (an earlier anonymous request
 * and a recorded version with no concept identifier to relate it to), which warns from rows alone,
 * with no network.
 *
 * A call that leaves the request `approving` is not a success: it exits 1 and says the request is
 * not published yet (`runApproval` reads the answer's `status`), where it used to print a success
 * line and exit 0 with the warning as the only sign.
 *
 * Mutation checks (each turns a named test red): answer the warnings under a plural key again
 * (the "prints the warning" row); close the request despite the warning, or answer `published` for
 * a request the call left approving (the "left approving" row); print a warning for a call that
 * had none (the control row); ignore the answer's `status` in `runApproval` (the exit-code rows).
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, stand-ins only at GitHub and Resend, no live network; it sets its own default
 * timeout.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { seedScreenedRequest } from "../backend/test/helpers/publication-review";
import { PUBLICATION_STEPS } from "../shared/publication-steps";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";
import { DATASET } from "./helpers/approve-seeds";

setDefaultTimeout(60_000);

const ADMIN_KEY = "all-done-cli-admin-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

beforeEach(async () => {
  h.reset();
  await h.admin("alldoneadmin", ADMIN_KEY);
});

const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

/** An `approving` request with every step done, and the concealed era that makes a tail job warn. */
function seedAllDone(opts: { concealedEra: boolean }): number {
  const { requestId } = seedScreenedRequest(h.db, {
    datasetId: DATASET,
    requestStatus: "approving",
  });
  h.db.run("UPDATE publication_requests SET steps_completed = ? WHERE id = ?", [
    JSON.stringify(PUBLICATION_STEPS),
    requestId,
  ]);
  if (opts.concealedEra) {
    h.db.run(
      `INSERT INTO publication_requests (dataset_id, requested_by, status, anonymous, requested_at)
       VALUES (?, (SELECT owner_user_id FROM datasets WHERE dataset_id = ?), 'denied', 1,
               datetime('now', '-10 days'))`,
      [DATASET, DATASET],
    );
    h.db.run("INSERT INTO dataset_versions (dataset_id, version, doi) VALUES (?, '1.0.0', ?)", [
      DATASET,
      "10.5072/FK2all-done-cli",
    ]);
  }
  return requestId;
}

const requestStatus = (id: number) =>
  h.db
    .query<{ status: string }, [number]>("SELECT status FROM publication_requests WHERE id = ?")
    .get(id)?.status;

const approve = () => h.cli(["admin", "publish", "approve", DATASET, "--resume", "--yes"]);

describe("approving a request whose steps are all done", () => {
  test("a tail job's warning is printed, and the request it says to approve again is left approving", async () => {
    const id = seedAllDone({ concealedEra: true });

    const r = await approve();

    // Not a success: the request is not published, and a script that asked for an approval has to
    // be able to tell (the Worker's answer says `approving`, not `published`).
    expect(r.exitCode).toBe(1);
    expect(output(r)).not.toContain("attach the log to a new issue");
    expect(output(r)).toContain("All steps already completed");
    expect(output(r)).toContain("Not published yet");
    expect(output(r)).toContain("the request is approving");
    expect(output(r)).toContain(`nemar admin publish approve ${DATASET} --resume`);
    // The warning says what to do, and it is on the console: the operator is told, not left to
    // read a success line.
    const warning = output(r)
      .split("\n")
      .find((line) => line.includes("Warning:"));
    expect(warning).toBeDefined();
    expect(warning).toContain("Approve the request again to retry");
    expect(requestStatus(id)).toBe("approving");
  });

  test("the retry the warning asks for is real: approving again finds the request and warns again while the cause stands", async () => {
    const id = seedAllDone({ concealedEra: true });
    expect((await approve()).exitCode).toBe(1);

    const again = await approve();

    expect(again.exitCode).toBe(1);
    expect(output(again)).toContain("Warning:");
    expect(requestStatus(id)).toBe("approving");

    // Repaired by hand, the next approval has nothing to warn about and closes the request.
    h.db.run("DELETE FROM dataset_versions WHERE dataset_id = ?", [DATASET]);
    const closing = await approve();
    expect(closing.exitCode).toBe(0);
    expect(output(closing)).not.toContain("Warning:");
    expect(output(closing)).not.toContain("Not published yet");
    expect(requestStatus(id)).toBe("published");
  });

  test("the control: a run with nothing to warn about prints no warning and closes the request", async () => {
    const id = seedAllDone({ concealedEra: false });

    const r = await approve();

    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain("All steps already completed");
    expect(output(r)).not.toContain("Warning:");
    expect(requestStatus(id)).toBe("published");
  });
});
