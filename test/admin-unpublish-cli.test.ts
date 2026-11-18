/**
 * `nemar admin repo unpublish`, through the real command against the real backend app (ADR 0125).
 *
 * The execute path needs GitHub and S3 and is proven in backend/test/unpublish.test.ts, with the
 * stand-ins for both. What only the command can break is here: that it sends the request the
 * Worker expects, that a dry run changes nothing, that --execute needs a reason before anything
 * is sent, that a skip is reported and exits 0, and that the output says the DOIs are untouched.
 *
 * CI TIER: unit-pure. Hermetic: an in-process backend over a local database, the CLI spawned
 * against it, no live network.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { UNPUBLISH_CACHE_NOTE } from "../shared/contract/publication";
import { type CliResult, startPublishCli } from "./helpers/admin-publish-cli";

setDefaultTimeout(60_000);

const ADMIN_KEY = "unpublish-cli-admin-key-0123456789abcdef0123456789abcdef";

const h = startPublishCli();
afterAll(() => h.stop());

let ownerId: number;

beforeEach(async () => {
  h.reset();
  await h.admin("unpublishadmin", ADMIN_KEY);
  ownerId = (await h.admin(
    "unpublishowner",
    "unpublish-owner-key-0123456789abcdef01234567",
  )) as number;
});

const output = (r: CliResult) => `${r.stdout}\n${r.stderr}`;

function seedHalfState(id: string): void {
  h.db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo, status, visibility,
                           anonymous, concept_doi, ezid_status, first_published_at)
     VALUES (?, ?, ?, 0, ?, 'active', 'private', 0, ?, 'public', '2026-10-05 12:00:00')`,
    [id, id, ownerId, `nemarDatasets/${id}`, `10.82901/nemar.${id}`],
  );
  h.db.run(
    "INSERT INTO dataset_versions (dataset_id, version, doi, ezid_status) VALUES (?, 'v1.0.1', ?, 'public')",
    [id, `10.82901/nemar.${id}.v1.0.1`],
  );
  h.db.run(
    "INSERT INTO publication_requests (dataset_id, requested_by, status) VALUES (?, ?, 'published')",
    [id, ownerId],
  );
}

const resetCount = (id: string) =>
  h.db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM publication_requests WHERE dataset_id = ? AND unpublished_at IS NOT NULL",
    )
    .get(id)?.n;

describe("nemar admin repo unpublish", () => {
  test("a dry run plans the repair of a half state and changes nothing", async () => {
    seedHalfState("nm000289");

    const r = await h.cli(["admin", "repo", "unpublish", "nm000289"]);

    expect(r.exitCode).toBe(0);
    const out = output(r);
    expect(out).toContain("[dry-run] nm000289");
    expect(out).toContain("a publication record still says published");
    expect(out).toContain("DOIs left untouched: concept 10.82901/nemar.nm000289, 1 version(s)");
    expect(out).toContain("Nothing was changed");
    expect(resetCount("nm000289")).toBe(0);
    expect(h.posted.map((p) => p.body)).toEqual([{ dry_run: true }]);
  });

  test("--execute without --reason sends nothing", async () => {
    seedHalfState("nm000289");

    const r = await h.cli(["admin", "repo", "unpublish", "nm000289", "--execute", "--yes"]);

    expect(r.exitCode).toBe(1);
    expect(output(r)).toContain("--reason is required with --execute");
    expect(h.posted).toEqual([]);
    expect(resetCount("nm000289")).toBe(0);
  });

  test("declining the confirmation sends nothing", async () => {
    seedHalfState("nm000289");

    const r = await h.cli([
      "admin",
      "repo",
      "unpublish",
      "nm000289",
      "--execute",
      "--reason",
      "authors request",
      "--no",
    ]);

    expect(r.exitCode).toBe(0);
    expect(h.posted).toEqual([]);
    expect(resetCount("nm000289")).toBe(0);
  });

  test("a live dataset is skipped with the reason, and the exit is 0", async () => {
    h.db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo, status, visibility)
       VALUES ('nm000104', 'live', ?, 0, 'nemarDatasets/nm000104', 'active', 'public')`,
      [ownerId],
    );

    const r = await h.cli(["admin", "repo", "unpublish", "nm000104", "--json"]);

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ dataset_id: "nm000104", dry_run: true });
    expect(JSON.parse(r.stdout).skipped).toContain("live dataset");
  });

  test("an unknown dataset is reported as skipped, not as a crash", async () => {
    const r = await h.cli(["admin", "repo", "unpublish", "nm000998"]);

    expect(r.exitCode).toBe(0);
    expect(output(r)).toContain("Dataset not found");
  });
});

describe("the cache note after an execute", () => {
  test("a dry run does not print it (nothing changed, nothing to wait for)", async () => {
    seedHalfState("nm000290");
    const dry = await h.cli(["admin", "repo", "unpublish", "nm000290"]);
    expect(output(dry)).not.toContain("cached at the edge");
  });

  test("the note says search is immediate and the page and list are edge-cached", () => {
    expect(UNPUBLISH_CACHE_NOTE).toBe(
      "Search reflects this at once; the public dataset page and catalog list are cached at the edge and can keep showing the dataset for several minutes.",
    );
  });
});
