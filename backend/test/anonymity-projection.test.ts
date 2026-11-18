/**
 * The owner projection stays in one place (#1407, epic #1406).
 *
 * A source-level assertion, in the same shape as the one
 * `test/data-summary-route.test.ts` uses to keep the summary route a
 * passthrough. It exists because of what ADR 0017 already concedes about
 * visibility scoping: "every new list, search, or catalog endpoint inherits
 * the obligation ... getting one wrong reopens the hole." The obligation here
 * is narrower and easier to discharge -- withhold the owner when the dataset
 * is anonymous -- but it has the same failure mode, which is a sixth query
 * added later that spells the join out by hand and quietly names a depositor
 * who paid for concealment. A runtime test cannot catch that: a new endpoint
 * that leaks is new code, and no assertion about the existing endpoints would
 * run against it.
 *
 * WHAT IS SCANNED, AND WHY NOT LESS
 * ---------------------------------
 * The first version of this file matched one exact alias spelling,
 * `u.username AS owner_username`. A reviewer pointed out that
 * `SELECT u.username, u.github_username` -- the spelling
 * `routes/datasets/collaborators.ts` already uses -- sails straight past it,
 * as do `u.username AS uploader` and `SELECT d.*, u.*`. So the scan now looks
 * for any dataset-scoped SQL statement that reads a username off the `users`
 * table, whatever it calls the result.
 *
 * It is scoped to statements mentioning `datasets` / `dataset_collaborators`
 * rather than to every `u.username` in the backend, because matching them all
 * flags twenty-odd auth and account-management files that have nothing to do
 * with dataset projections -- an allowlist nobody would read, appended to by
 * reflex, which is how a guard stops guarding.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { OWNER_GITHUB_SQL, OWNER_USERNAME_SQL, VERSION_DOI_SQL } from "../src/services/anonymity";

const SRC = join(import.meta.dir, "..", "src");

/** Every .ts file under backend/src, so a new route cannot opt out by living somewhere new. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** A SQL statement, from SELECT to whatever terminates the literal holding it. */
const SQL_STATEMENT = /SELECT[\s\S]{0,1200}?(?=`|"\s*\)|';)/gi;
/** Reads a username off `users`, under any alias or none. */
const READS_OWNER = /\b(?:u|users)\.(?:username|github_username)\b/;
/** Is this a dataset query at all? */
const DATASET_SCOPED = /\bdatasets\b|\bdataset_collaborators\b/i;
const USES_THE_RULE = /OWNER_USERNAME_SQL|OWNER_GITHUB_SQL/;

/**
 * Reads a version DOI off `dataset_versions`.
 *
 * A bare `doi`, which is the only spelling that reaches the column: `\b`
 * treats `_` as a word character, so `concept_doi`, `latest_version_doi` and
 * `dataset_doi` do not match, and the many `SELECT version FROM
 * dataset_versions` subqueries in `catalog.ts` do not either.
 */
const READS_VERSION_DOI = /\bdoi\b/;
const VERSION_SCOPED = /\bdataset_versions\b/i;
const USES_THE_VERSION_RULE = /VERSION_DOI_SQL|PUBLIC_DATASET_VERSIONS_SQL/;

/**
 * Sites that resolve the real owner ON PURPOSE, each with the reason.
 *
 * Requirement R5: anonymity is toward the public and never toward the
 * archive. NEMAR has to keep knowing who deposited a dataset -- to mint a DOI
 * with a real curator at publication, to email the owner, to grant the right
 * GitHub account access to the repository, to run the publication flow at all
 * -- so an internal read of `users.username` is not a leak, it is the
 * feature. What would be a leak is an ANONYMOUS-facing projection: a list, a
 * search result, a detail payload.
 *
 * The list is explicit rather than a path heuristic so that adding a file to
 * it is a deliberate act with a justification attached, the same shape
 * `test/api-export-surface.unit.test.ts` uses for its post-split additions. A
 * new public endpoint that joins the owner by hand is not on this list and
 * therefore fails.
 */
const DELIBERATE_INTERNAL_READS: Readonly<Record<string, string>> = {
  "routes/admin/doi.ts": "admin-only DOI minting; the curator must be the real person (ADR 0041)",
  "services/anonymity-sweep.ts":
    "the sweep searches the depositor's own files for the depositor, so it has to know exactly who that is (#1409); nothing it reads reaches a caller -- the findings name a file and a check, never a name",
  "routes/admin/exemplar.ts": "admin-only exemplar tooling, never an anonymous surface",
  "routes/admin/user-duplicates.ts":
    "admin-only identity reconciliation; the subject IS the user, and its dataset reference is a count",
  "routes/admin/users.ts": "admin-only user administration; datasets appear only as a count",
  "routes/datasets/collaborators.ts":
    "collaborator management, owner-or-admin only; the point of the payload is who has access",
  "routes/datasets/publication.ts":
    "the publication request and CI-status routes; owner-or-admin only, and both authorize by comparing the real username rather than returning it",
  "services/enrich-dataset.ts":
    "resolves the uploader to build DataCite attribution; blinds at the WRITE instead",
  "services/publication-orchestrator.ts": "the publish flow itself, which is where anonymity ends",
  "services/repo-spec.ts":
    "resolves GitHub handles to grant repository access; a blinded handle would grant it to nobody",
};

describe("owner identity is projected through one rule", () => {
  test("no dataset query reads the owner off users by hand", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file
        .slice(SRC.length + 1)
        .split(sep)
        .join("/");
      // The constants themselves contain the column names, by construction.
      if (rel === "services/anonymity.ts") continue;
      if (DELIBERATE_INTERNAL_READS[rel]) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(SQL_STATEMENT)) {
        const statement = match[0];
        if (!DATASET_SCOPED.test(statement)) continue;
        if (!READS_OWNER.test(statement)) continue;
        if (USES_THE_RULE.test(statement)) continue;
        offenders.push(`${rel}:${text.slice(0, match.index).split("\n").length}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the scan matches the statements it claims to match", () => {
    // A regex that matched nothing would pass the test above forever. Every
    // allowlisted file must actually contain a hit -- which also means an
    // entry that stops being needed shows up as a failure rather than
    // lingering as permission nobody re-examined.
    for (const [rel, reason] of Object.entries(DELIBERATE_INTERNAL_READS)) {
      const text = readFileSync(join(SRC, ...rel.split("/")), "utf8");
      const hits = [...text.matchAll(SQL_STATEMENT)].filter(
        (m) => DATASET_SCOPED.test(m[0]) && READS_OWNER.test(m[0]) && !USES_THE_RULE.test(m[0]),
      );
      expect(
        hits.length,
        `${rel} is allowlisted (${reason}) but has no matching statement`,
      ).toBeGreaterThan(0);
    }
  });

  test("the rule withholds only when the dataset is anonymous", () => {
    // Pinning the SQL text rather than only its behavior: these strings are
    // interpolated into queries in five places, and a change here is a change
    // to what every one of them discloses.
    expect(OWNER_USERNAME_SQL).toBe(
      "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.username END AS owner_username",
    );
    expect(OWNER_GITHUB_SQL).toBe(
      "CASE WHEN d.anonymous = 1 THEN NULL ELSE u.github_username END AS owner_github",
    );
  });

  test("the catalog's projections use the rule", () => {
    const catalog = readFileSync(join(SRC, "routes", "datasets", "catalog.ts"), "utf8");
    // Five sites today: the FTS-fallback list, the "mine" list, the main list,
    // the source-id lookup, and the detail route. The count is asserted
    // loosely on purpose -- a sixth site is fine, a site that bypasses the
    // rule is not, and the test above is what catches that.
    const uses = catalog.match(/\$\{OWNER_USERNAME_SQL\}/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    expect(catalog).toContain("${OWNER_GITHUB_SQL}");
  });
});

/**
 * Reads a version DOI on purpose, each with the reason.
 *
 * Same shape and same argument as `DELIBERATE_INTERNAL_READS` above: NEMAR has
 * to keep knowing a concealed deposit's version identifier -- it minted it, it
 * has to be able to tombstone it, complete it, or hand it back to the
 * depositor. What must not happen is an ANONYMOUS-FACING projection carrying
 * one, because a `reserved` identifier does not resolve.
 */
const DELIBERATE_VERSION_DOI_READS: Readonly<Record<string, string>> = {
  "routes/datasets/manifests.ts":
    "the `GET /:id/versions` handler: authenticated, then owner-or-collaborator-or-admin, and the depositor is entitled to their own version DOI",
  "routes/callbacks/version-doi.ts":
    "the callback that MINTS the identifier, reading back what it wrote; nothing it returns is a public projection",
  "routes/admin/doi.ts":
    "admin-only DOI tooling: builds the concept record's HasVersion relations and refreshes each version record at EZID",
  "routes/admin/datasets-lifecycle.ts":
    "admin-only backfill and manifest dispatch, both of which write the DOI INTO a manifest rather than into a response",
  "services/central-manifest.ts":
    "collects prior version DOIs to preserve the concept record's HasVersion relations",
  "services/publication-orchestrator.ts": "the publish flow itself, which is where anonymity ends",
  "services/anonymity-sweep.ts":
    "the sweep that VERIFIES each version identifier is still `reserved` at EZID (ADR 0067); it reports to admins and stamps `sweep_stamps`, and a rule that withheld the DOI from it would blind the check to the thing it exists to check",
  "services/withdraw.ts":
    "admin withdrawal and restore, which must tombstone every version DOI including a reserved one",
  "services/unpublish.ts":
    "admin-only unpublish counts the version DOIs it leaves untouched; only the count reaches the response and audit row, never an identifier",
  "services/upstream-repull-verified.ts":
    "admin-only record of a re-pull's release: checks that the version was minted before recording it, and puts the identifier in no response or audit row",
  // The manifest-generation family. Each reads the version DOI to EMBED it in
  // the S3 manifest object, and the public route that serves that object
  // (`GET /<id>/<v>/manifest.json`) returns only the per-file entries array --
  // `VersionManifest.doi` and `.concept_doi` are not in its response shape.
  // `ANONYMITY_DECLARED_SCOPE_LIMITS` records what is left of this: the S3
  // object itself, which is not a NEMAR response.
  "services/manifest-coverage.ts": "coverage report; the DOI goes into the manifest it regenerates",
  "services/doctor/checks/missing-manifest.ts": "doctor check, same manifest payload",
  "services/manifest-sweep.ts": "the cron form of the same check",
};

describe("a version DOI is projected through one rule", () => {
  test("no public query reads a version doi by hand", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file
        .slice(SRC.length + 1)
        .split(sep)
        .join("/");
      // The constants themselves contain the column name, by construction.
      if (rel === "services/anonymity.ts" || rel === "services/data-router.ts") continue;
      if (DELIBERATE_VERSION_DOI_READS[rel]) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(SQL_STATEMENT)) {
        const statement = match[0];
        if (!VERSION_SCOPED.test(statement)) continue;
        if (!READS_VERSION_DOI.test(statement)) continue;
        if (USES_THE_VERSION_RULE.test(statement)) continue;
        offenders.push(`${rel}:${text.slice(0, match.index).split("\n").length}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the scan matches the statements it claims to match", () => {
    for (const [rel, reason] of Object.entries(DELIBERATE_VERSION_DOI_READS)) {
      const text = readFileSync(join(SRC, ...rel.split("/")), "utf8");
      const hits = [...text.matchAll(SQL_STATEMENT)].filter(
        (m) =>
          VERSION_SCOPED.test(m[0]) &&
          READS_VERSION_DOI.test(m[0]) &&
          !USES_THE_VERSION_RULE.test(m[0]),
      );
      expect(
        hits.length,
        `${rel} is allowlisted (${reason}) but has no matching statement`,
      ).toBeGreaterThan(0);
    }
  });

  test("the rule withholds only when the dataset is anonymous", () => {
    // Pinned, like the owner projections: this string decides what three
    // public surfaces disclose, and `dv` / `d` are the aliases every caller
    // must supply.
    expect(VERSION_DOI_SQL).toBe("CASE WHEN d.anonymous = 1 THEN NULL ELSE dv.doi END AS doi");
  });

  test("all three public readers share the one statement", () => {
    // The landing page and metadata.json (routes/data.ts) and the page bundle.
    // Each had its own copy of `SELECT version, doi, created_at FROM
    // dataset_versions`, and the withholding was in none of them.
    const data = readFileSync(join(SRC, "routes", "data.ts"), "utf8");
    const bundle = readFileSync(join(SRC, "services", "page-bundle.ts"), "utf8");
    expect((data.match(/PUBLIC_DATASET_VERSIONS_SQL/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(bundle).toContain("PUBLIC_DATASET_VERSIONS_SQL");
  });
});

describe("the owner leaks that a projection rule cannot reach", () => {
  test("the detail route withholds the raw owner FK", () => {
    // `GET /datasets/:id` is `SELECT d.*`, so `owner_user_id` rides along
    // beside the nulled username. It de-anonymizes in one request -- read it
    // here, then find any other public dataset with the same value and read
    // its disclosed owner -- and it is a stable handle linking one
    // depositor's several anonymous deposits even with nothing to join to.
    const catalog = readFileSync(join(SRC, "routes", "datasets", "catalog.ts"), "utf8");
    expect(catalog).toContain("owner_user_id: isAnonymous(dataset) ? null : ownerUserIdRaw,");
  });

  test("the ?owner= filter cannot be used as a confirmation oracle", () => {
    // The filter matches on the REAL username in a WHERE clause, which no
    // SELECT-list rule can reach: a hit with `owner_username: null` confirms
    // that this named person deposited it. Excluded for everyone except an
    // admin and the depositor themselves.
    const filters = readFileSync(join(SRC, "services", "dataset-filters.ts"), "utf8");
    expect(filters).toContain('from += " AND d.anonymous = 0";');
    expect(filters).toMatch(/hasRole\(user\.role, "admin"\) \|\| user\.username === owner/);
  });
});
