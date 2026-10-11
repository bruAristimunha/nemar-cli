/**
 * Every path to public stamps the publication (#1407, epic #1406).
 *
 * The triggers in migration 0085 refuse to make a PUBLISHED dataset
 * anonymous, and they decide that by reading `first_published_at`. So the
 * invariant is exactly as strong as the set of code paths that write that
 * column, and the first version of this phase had one writer against three
 * paths that make a dataset public. A dataset published with `nemar admin
 * make-public` kept the column NULL, and could then be made anonymous
 * afterwards -- DOI minted, landing page indexed, git history cloned, and D1
 * reporting a never-published anonymous deposit. That is the state ADR 0065
 * calls theater, reached through the door the ADR was written to close.
 *
 * Two kinds of test here, because neither is sufficient alone. The
 * source-level scan catches a FOURTH path added later, which no runtime test
 * over today's routes could ever reach. The real-database tests prove the SQL
 * those paths interpolate actually does what its name says, including the
 * case the whole design turns on: an anonymous deposit going public without
 * being stamped.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  ANONYMOUS_RELEASE_SKIPPED_STEPS,
  ANONYMOUS_RELEASE_STEPS,
} from "../../shared/publication-steps";
import {
  ANONYMOUS_AUTHORS_LABEL,
  END_ANONYMITY_AT_PUBLICATION_SQL,
  FIRST_PUBLICATION_STAMP_SQL,
  PRIOR_ANONYMOUS_REQUEST_SQL,
  expectedRepoVisibility,
} from "../src/services/anonymity";
import { freshDb } from "./helpers/d1";

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `UPDATE datasets SET ... WHERE`, however it is wrapped across lines. */
const DATASET_UPDATE = /UPDATE\s+datasets\s+SET[\s\S]{0,500}?WHERE/gi;
const SETS_VISIBILITY = /\bvisibility\s*=/i;
const CARRIES_STAMP =
  /first_published_at|FIRST_PUBLICATION_STAMP_SQL|END_ANONYMITY_AT_PUBLICATION_SQL/;

/**
 * Statements that set visibility and deliberately do NOT stamp, with the
 * reason. Only one shape qualifies: a transition to PRIVATE, which is not a
 * publication and must not record one.
 */
const DELIBERATE_UNSTAMPED: Readonly<Record<string, string>> = {
  "routes/admin/datasets-lifecycle.ts":
    "the reset path sets visibility='private'; going private is not a publication",
};

describe("no path makes a dataset public without recording it", () => {
  test("every UPDATE that sets visibility carries the stamp", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file
        .slice(SRC.length + 1)
        .split(sep)
        .join("/");
      if (DELIBERATE_UNSTAMPED[rel]) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(DATASET_UPDATE)) {
        const statement = match[0];
        if (!SETS_VISIBILITY.test(statement)) continue;
        if (CARRIES_STAMP.test(statement)) continue;
        offenders.push(`${rel}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scan would notice: it finds the statements it is scanning for", () => {
    // Without this, a regex that matched nothing would pass the test above
    // forever. Four sites today -- the publication orchestrator's repo_public
    // step, its end-of-run consistency fix, its operator recovery string, and
    // the direct make-public route -- plus the visibility service.
    let stamped = 0;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(DATASET_UPDATE)) {
        if (SETS_VISIBILITY.test(match[0]) && CARRIES_STAMP.test(match[0])) stamped++;
      }
    }
    expect(stamped).toBeGreaterThanOrEqual(5);
  });
});

/** Apply a SET fragment the way the production statements interpolate it. */
function setVisibilityPublic(db: Database, id: string, fragment: string): void {
  db.prepare(`UPDATE datasets SET visibility = 'public', ${fragment} WHERE dataset_id = ?`).run(id);
}

function seed(db: Database, id: string, anonymous = 0, visibility = "private"): void {
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status, role)
     VALUES (7, 'realname', 'real@example.org', 'real-gh', 'approved', 'user')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, description, authors, owner_user_id,
                           status, visibility, is_sandbox, anonymous)
     VALUES (?, 'A study of something', 'd', 'Ada Lovelace', 7, 'active', ?, 0, ?)`,
  ).run(id, visibility, anonymous);
}

function row(db: Database, id: string): { anonymous: number; first_published_at: string | null } {
  return db
    .query("SELECT anonymous, first_published_at FROM datasets WHERE dataset_id = ?")
    .get(id) as { anonymous: number; first_published_at: string | null };
}

describe("FIRST_PUBLICATION_STAMP_SQL records a publication of the IDENTITY", () => {
  test("a normal dataset going public is stamped", () => {
    const db = freshDb();
    seed(db, "nm000930");
    setVisibilityPublic(db, "nm000930", FIRST_PUBLICATION_STAMP_SQL);
    expect(row(db, "nm000930").first_published_at).toBeTruthy();
  });

  test("an anonymous deposit going public is NOT stamped, and stays anonymous", () => {
    // The case the whole design turns on. An anonymous deposit is
    // deliberately listed, browsable and downloadable while its depositor is
    // concealed, so stamping here would both trip the triggers and record a
    // publication of an identity that has not been published.
    const db = freshDb();
    seed(db, "nm000931", 1);
    setVisibilityPublic(db, "nm000931", FIRST_PUBLICATION_STAMP_SQL);
    expect(row(db, "nm000931")).toEqual({ anonymous: 1, first_published_at: null });
  });

  test("a republished dataset keeps the FIRST date", () => {
    const db = freshDb();
    seed(db, "nm000932");
    db.prepare(
      "UPDATE datasets SET first_published_at = '2020-01-01 00:00:00' WHERE dataset_id = 'nm000932'",
    ).run();
    setVisibilityPublic(db, "nm000932", FIRST_PUBLICATION_STAMP_SQL);
    expect(row(db, "nm000932").first_published_at).toBe("2020-01-01 00:00:00");
  });

  test("the stamp closes the retroactive-anonymity hole", () => {
    // The regression this file exists for, end to end: publish through the
    // admin make-public path's exact SET clause, then try to conceal the
    // depositor afterwards. Before the stamp reached this path the UPDATE
    // below succeeded.
    const db = freshDb();
    seed(db, "nm000933");
    setVisibilityPublic(db, "nm000933", FIRST_PUBLICATION_STAMP_SQL);

    expect(() =>
      db.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'nm000933'").run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });
});

describe("END_ANONYMITY_AT_PUBLICATION_SQL ends concealment in one statement", () => {
  test("an anonymous deposit is de-anonymized and stamped together", () => {
    const db = freshDb();
    seed(db, "nm000934", 1, "public");

    // Two statements would abort on whichever ran first: the triggers refuse
    // a row that is simultaneously anonymous and stamped.
    setVisibilityPublic(db, "nm000934", END_ANONYMITY_AT_PUBLICATION_SQL);

    const after = row(db, "nm000934");
    expect(after.anonymous).toBe(0);
    expect(after.first_published_at).toBeTruthy();
  });

  test("stamping the date alone is refused, which is why it is one statement", () => {
    const db = freshDb();
    seed(db, "nm000935", 1, "public");
    expect(() =>
      db
        .prepare(
          "UPDATE datasets SET first_published_at = datetime('now') WHERE dataset_id = 'nm000935'",
        )
        .run(),
    ).toThrow(/anonymous requires first_published_at IS NULL/);
  });

  test("a second run is idempotent and keeps the first date", () => {
    const db = freshDb();
    seed(db, "nm000936", 1, "public");
    setVisibilityPublic(db, "nm000936", END_ANONYMITY_AT_PUBLICATION_SQL);
    const first = row(db, "nm000936").first_published_at;
    setVisibilityPublic(db, "nm000936", END_ANONYMITY_AT_PUBLICATION_SQL);
    expect(row(db, "nm000936").first_published_at).toBe(first);
  });
});

/**
 * An awaited CALL that can change what the world can read of a dataset's
 * repository. `await` excludes both the declarations and the prose: the word
 * appears in several comments, and a comment decides nothing.
 */
const VISIBILITY_MUTATOR = /await\s+(setRepoVisibility|ensureRepoToSpec)\s*\(/g;

/**
 * A visibility decision written as a LITERAL rather than computed.
 *
 * That is the whole bug class, and stating it this way is what makes the scan
 * able to fail. An earlier draft asked whether the enclosing region MENTIONED
 * `expectedRepoVisibility`, and a call whose own argument had been reverted to
 * `false` still passed, because a different call twenty lines away mentioned
 * it. A scan is only worth running if the thing it reads is the thing that
 * decides.
 */
const LITERAL_VISIBILITY = /^\s*(true|false|"public"|"private"|'public'|'private')\s*$/;

/**
 * A literal that means PRIVATE.
 *
 * The scan is deliberately asymmetric, because the two directions are not
 * comparable. Publishing a repository is what discloses a concealed depositor
 * -- the git history carries commit author names and emails and the pre-blind
 * `.nemar/metadata.json` -- and a clone cannot be taken back. Making one
 * private discloses nothing; every literal-private call in this codebase is a
 * REVERT after a failed write, and a revert must not be made conditional on
 * the rule it is recovering from.
 *
 * So a literal private is allowed anywhere, and a literal `false` / `"public"`
 * is an offense everywhere. This replaces a `file:line`-keyed allowlist, which
 * pinned two revert calls by line number in an 1,100-line file and broke the
 * moment an unrelated comment above them grew by six lines.
 */
const LITERAL_PRIVATE = /^\s*(true|"private"|'private')\s*$/;

/**
 * The text of the ARGUMENT that decides visibility at one call site:
 * `setRepoVisibility(repo, <decision>, pat)`, or the `visibility:` property of
 * `ensureRepoToSpec(repo, pat, { ... })`.
 */
function visibilityDecision(text: string, at: number): string {
  const call = text.slice(at, at + 1200).replace(/^await\s+/, "");
  if (call.startsWith("setRepoVisibility")) {
    const args = /^setRepoVisibility\s*\(([^)]*)\)/.exec(call);
    return args ? (args[1].split(",")[1] ?? "") : "";
  }
  const visibility = /\bvisibility:\s*([^\n,]*)/.exec(call);
  return visibility ? visibility[1] : "";
}

describe("the repository does not follow the catalog row", () => {
  test("an anonymous deposit stays private on GitHub while its row is public", () => {
    expect(expectedRepoVisibility({ visibility: "public", anonymous: 1 })).toBe("private");
    expect(expectedRepoVisibility({ visibility: "public", anonymous: 0 })).toBe("public");
    expect(expectedRepoVisibility({ visibility: "private", anonymous: 0 })).toBe("private");
    expect(expectedRepoVisibility({ visibility: "private", anonymous: 1 })).toBe("private");
    expect(expectedRepoVisibility({ visibility: "public", anonymous: null })).toBe("public");
  });

  test("every mutator of repository visibility goes through the rule", () => {
    // `setRepoVisibility` is what actually publishes a git history: the commit
    // author names and emails, and the pre-blind `.nemar/metadata.json` still
    // in it. A call site that computes its argument from `visibility` alone
    // publishes an anonymous deposit's repository while the catalog keeps
    // reporting the depositor as concealed -- with a 200 and no log line, and
    // nothing to revert, because a clone is a clone.
    //
    // EXHAUSTIVE, in the shape of the two scans above, and it had to become so
    // to be worth anything: it was a hardcoded list of two files, and the call
    // that runs during an approved anonymous release
    // (`publication-orchestrator.ts`) was not one of them. Reverting that one
    // argument to a literal left the whole suite green.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file
        .slice(SRC.length + 1)
        .split(sep)
        .join("/");
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(VISIBILITY_MUTATOR)) {
        const line = text.slice(0, match.index).split("\n").length;
        const site = `${rel}:${line}`;
        const decision = visibilityDecision(text, match.index ?? 0);
        if (!LITERAL_VISIBILITY.test(decision)) continue;
        // A literal PRIVATE is the safe direction and is always allowed; see
        // LITERAL_PRIVATE. Only a literal public is an offense.
        if (LITERAL_PRIVATE.test(decision)) continue;
        offenders.push(site);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scan would notice: it finds the call sites it is scanning for", () => {
    // Twelve today across four files. Without this a regex that matched
    // nothing would pass the test above forever, which is exactly how the
    // hardcoded list it replaced managed to miss the orchestrator.
    let sites = 0;
    for (const file of sourceFiles(SRC)) {
      sites += [...readFileSync(file, "utf8").matchAll(VISIBILITY_MUTATOR)].length;
    }
    expect(sites).toBeGreaterThanOrEqual(10);
  });
});

describe("anonymity is requested at publication, not refused there", () => {
  const PUBLICATION = readFileSync(join(SRC, "routes", "datasets", "publication.ts"), "utf8");
  const MINIMUMS = readFileSync(join(SRC, "services", "submission-minimums.ts"), "utf8");
  // The gate moved out of the route into one function the request route and
  // the blocked-request sweep both call, so the two cannot disagree. The
  // behavior is driven through both in publish-request-ci-pending.test.ts;
  // these are the source pins that follow the code to its new home.
  const GATE = readFileSync(join(SRC, "services", "submission-gate.ts"), "utf8");

  test("the request route reads an --anonymous intent off the body", () => {
    // Phase 2 blocked every publication request from an anonymous dataset.
    // That was too blunt in BOTH directions: a depositor could never reach the
    // anonymous state, and a blinded deposit could never be published for real,
    // because the normal request is exactly how de-anonymization happens.
    expect(PUBLICATION).toContain("let anonymousRequested = false;");
    expect(PUBLICATION).not.toContain("blockReason = ANONYMOUS_DEPOSIT_REASON;");
  });

  test("the guard that refuses a published dataset reads a column the query asks for", () => {
    // `hasEverBeenPublished` reads `first_published_at`. The field used to be
    // OPTIONAL on the shared type, so this SELECT could omit the column, the
    // predicate answered `false`, and TypeScript raised nothing -- the guard
    // was dead. Both halves are pinned: the column is selected, and the type
    // requires it so the next omission is a compile error.
    expect(PUBLICATION).toMatch(/SELECT d\.id[^`]*d\.first_published_at/);
    expect(PUBLICATION).toContain("first_published_at: string | null;");
  });

  test("an `anonymous` key that is not a boolean is refused, never coerced", () => {
    // `{"anonymous": "true"}` from a form serializer parses cleanly and is not
    // `=== true`. Reading that as a normal publication would conceal nothing
    // while telling the depositor their request succeeded -- and there is no
    // un-publishing a name.
    expect(PUBLICATION).toContain('error: "invalid_anonymous",');
  });

  test("the answer says which of the two was recorded", () => {
    // A lost flag otherwise produces output byte-identical to a correct
    // request, on every surface, until the dataset is published.
    expect(PUBLICATION).toContain("anonymous: anonymousRequested,");
    expect(PUBLICATION).toContain("anonymous: request.anonymous === 1,");
    // The admin mail carries it too. Since epic #1610 phase 4 the mail goes
    // through `mailPublicationRequest`; when it waits for the identifier
    // screen, the flag is read back off the request row instead, which
    // identifier-screen-flow.test.ts asserts on the mail itself.
    expect(PUBLICATION).toMatch(
      /mailPublicationRequest\(c\.env, \{[^}]*anonymous: anonymousRequested,/,
    );
  });

  test("the blind check cannot be skipped by a GitHub hiccup or an upstream review", () => {
    // For a publication this gate is a quality check and failing open costs a
    // weak title. For an anonymous release it IS the blind check: the rule
    // that `dataset_description.json` does not still name the depositor. A
    // transient GitHub error, or an OpenNeuro/exemplar exemption, would have
    // granted a blind nobody verified.
    expect(PUBLICATION).toContain("anonymous: anonymousRequested,");
    expect(PUBLICATION).toContain("await checkSubmissionGate({");
    expect(GATE).toContain(
      'return anonymous || (dataset.source !== "openneuro" && !dataset.is_exemplar);',
    );
    // A failed read is `unverified` for everyone. Only a native submission
    // fails open on it (the route's policy); an anonymous release is blocked.
    expect(GATE).toContain('kind: "unverified"');
    expect(PUBLICATION).toContain(
      'if (gate.kind === "blocked" || (gate.kind === "unverified" && anonymousRequested)) {',
    );
  });

  test("the intent is persisted, because approval runs a different publication", () => {
    // At request time the dataset is not anonymous yet -- asking is what makes
    // it so, later. So the approval step cannot re-derive this from the row.
    expect(PUBLICATION).toMatch(/INSERT INTO publication_requests[^`"]*anonymous\)/);
    expect(PUBLICATION).toContain("anonymousRequested ? 1 : 0");
  });

  test("a re-request without the flag cannot inherit a stale anonymous intent", () => {
    // The unblock path rewrites the row. If it left `anonymous` alone, a
    // depositor re-requesting a NORMAL publication would silently get an
    // anonymous release instead -- the one mistake this flow must not make
    // quietly.
    const unblock = PUBLICATION.indexOf("SET status = 'requested', block_reason = NULL");
    expect(unblock).toBeGreaterThan(-1);
    expect(PUBLICATION.slice(unblock, unblock + 400)).toContain("anonymous = ?");
  });

  test("the placeholder-author gate is exempted for a release and enforced for a publication", () => {
    // This is the interlock, and it is one gate doing two jobs. A blinded
    // deposit legitimately has placeholder Authors; a real publication must
    // not. ADR 0065's first draft claimed this came for free from ADR 0026,
    // which was false twice over -- the regex is anchored and the gate reads
    // the repository file, never `datasets.authors`.
    expect(GATE).toContain("anonymousRelease: anonymous,");
    expect(MINIMUMS).toContain("anonymousRelease?: boolean;");
    // The rule INVERTS, it does not relax: a release refuses real names and a
    // publication requires them. Permitting was the first draft and it let a
    // depositor be named by their own file on a public dataset page.
    expect(MINIMUMS).toContain("} else if (realAuthors.length > 0) {");
    expect(MINIMUMS).toContain("} else if (realAuthors.length === 0) {");
  });

  test("asking for anonymity on a published dataset is refused, not blocked", () => {
    // A block invites a re-request; this can never succeed, because the
    // triggers refuse it and no amount of retrying changes that.
    expect(PUBLICATION).toContain("if (anonymousRequested && hasEverBeenPublished(dataset)) {");
    expect(PUBLICATION).toContain('error: "already_published",');
  });
});

describe("an anonymous release is a publication minus the steps that expose identity", () => {
  const ORCHESTRATOR = readFileSync(join(SRC, "services", "publication-orchestrator.ts"), "utf8");

  test("the skipped set is exactly the identity-exposing steps", () => {
    // Driven through the real exported constant rather than a copy: a step
    // added to the skip list without a reason, or removed from it, changes
    // what an anonymous release does in the world.
    expect([...ANONYMOUS_RELEASE_SKIPPED_STEPS].sort()).toEqual([
      "publish_doi",
      "update_metadata",
      "update_readme",
      "upload_to_zenodo",
    ]);
  });

  test("version_doi RUNS, because it is also the only manifest trigger (#1447)", () => {
    // It was skipped until #1447, which reads correctly from the step's name
    // and is wrong: `publishEzidVersionDoiViaCentral` mints the identifier AND
    // dispatches the central manifest job whose callback inserts the
    // `dataset_versions` row. Skipping it left a released anonymous deposit
    // with no manifest and no version -- measured on the dev worker, the data
    // plane answered 404 "Version not published" for a dataset the release had
    // just made public, and the catalog listing omitted it entirely.
    expect(ANONYMOUS_RELEASE_STEPS).toContain("version_doi");
    // What makes that safe is that the mint stops at `reserved`. If this term
    // is ever dropped, the step publishes a resolving version DOI for a
    // concealed deposit, which is irreversible.
    const CENTRAL = readFileSync(join(SRC, "services", "central-manifest.ts"), "utf8");
    expect(CENTRAL).toContain("const reserveOnly = isAnonymous(dataset);");
    expect(CENTRAL).toContain("reserveOnly,");
  });

  test("the DOI is not written into the files the data plane serves", () => {
    // `update_metadata` writes DatasetDOI into dataset_description.json and
    // `update_readme` adds a DOI badge to README.md. Both files are
    // git-tracked and served publicly (#1403), and the identifier is RESERVED
    // -- it does not resolve. Running them would have put a dead DOI on the
    // dataset page of the one deposit whose premise is that no identifier of
    // it resolves yet, and a depositor mid-submission would have cited it.
    expect(ANONYMOUS_RELEASE_STEPS).not.toContain("update_metadata");
    expect(ANONYMOUS_RELEASE_STEPS).not.toContain("update_readme");
    // Deferred, not dropped: doi_create still reserves the identifier, so the
    // publication that ends anonymity activates the SAME one.
    expect(ANONYMOUS_RELEASE_STEPS).toContain("doi_create");
  });

  test("repo_public still runs, because it is what releases the data", () => {
    // The step's name is now narrower than what it does: it flips the catalog
    // row public while `expectedRepoVisibility` keeps the repository private.
    expect(ANONYMOUS_RELEASE_STEPS).toContain("repo_public");
    expect(ANONYMOUS_RELEASE_STEPS).toContain("s3_public_read");
    // The gates are not skipped either: an anonymous release is validated and
    // reviewed exactly like a publication.
    expect(ANONYMOUS_RELEASE_STEPS).toContain("ci_check");
  });

  test("the run picks its step set from the request, not from the dataset row", () => {
    expect(ORCHESTRATOR).toContain("const anonymousRelease = request.anonymous === 1;");
    expect(ORCHESTRATOR).toContain("? ANONYMOUS_RELEASE_STEPS");
  });

  test("the release blinds before the data plane can serve the repository's file", () => {
    // `.nemar/metadata.json` is backend-written and publicly served from the
    // manifest, and enrichment has already run by this point, so the committed
    // copy still names the depositor until a fresh pass rewrites it.
    const markAt = ORCHESTRATOR.indexOf("const marked = await markAnonymous(c.env, datasetId);");
    const reenrichAt = ORCHESTRATOR.indexOf(
      "const reenriched = await runEnrichmentForDataset(c.env, datasetId);",
    );
    expect(markAt).toBeGreaterThan(-1);
    expect(reenrichAt).toBeGreaterThan(markAt);
    // UNCONDITIONAL. It used to be gated on `marked.repoMetadataStale`, which
    // is read from `enrichment_json IS NOT NULL` -- a CACHE of the committed
    // document, not the document. An admin revert nulls that column and leaves
    // the repository's file in place, so the two disagree and the gate said
    // "nothing to do" while the committed metadata still named the depositor.
    expect(ORCHESTRATOR).not.toContain("if (marked.repoMetadataStale) {");
    // A failure to blind stops the release rather than publishing under the
    // depositor's name.
    expect(ORCHESTRATOR).toContain("the release was stopped rather than published under");
  });

  test("publishing a formerly blinded deposit restores attribution before the mint", () => {
    // doi_create prefers `.nemar/metadata.json` over the BIDS description, so
    // minting before the restoring pass would cite an enrichment with no
    // authors on a permanent, harvested identifier.
    const restoreAt = ORCHESTRATOR.indexOf("if (restoreAttribution) {");
    const mintAt = ORCHESTRATOR.indexOf("anonymousDeposit: c.anonymousRelease,");
    expect(restoreAt).toBeGreaterThan(-1);
    expect(mintAt).toBeGreaterThan(restoreAt);
  });

  test("the restoration condition survives its own UPDATE, and the retry", () => {
    // It used to read `isAnonymous(c.dataset)` at the point of use -- AFTER
    // the UPDATE three lines above had already set `anonymous = 0`, and with
    // `c.dataset` re-SELECTed on every invocation. So a retry after a failed
    // enrichment saw a non-anonymous row, skipped the restoration silently,
    // and minted a permanent DataCite record whose creator was the blinded
    // label. The intent is captured before the write and read from the request
    // history, which no step can rewrite.
    const captureAt = ORCHESTRATOR.indexOf("const restoreAttribution =");
    const updateAt = ORCHESTRATOR.indexOf("END_ANONYMITY_AT_PUBLICATION_SQL}");
    expect(captureAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(captureAt);
    // Through the shared constant rather than its text: both this site and the
    // finalize tail jobs ask the same question, and a copy here could be
    // narrowed on its own.
    expect((ORCHESTRATOR.match(/prepare\(PRIOR_ANONYMOUS_REQUEST_SQL\)/g) ?? []).length).toBe(2);
    expect(ORCHESTRATOR).not.toContain("FROM publication_requests WHERE dataset_id = ? AND anon");
    expect(ORCHESTRATOR).not.toContain("if (!c.anonymousRelease && isAnonymous(c.dataset)) {");
  });

  test("de-anonymizing asks for the Zarr stores to be rebuilt, AFTER the DOI exists", () => {
    // The stores carry the catalog row's attribution, an anonymous deposit is
    // public so it has been converting all along with the blinded label, and
    // publishing for real changes neither the dataset version nor the global
    // engine stamp -- the only two triggers the conversion queue had. Without
    // this stamp the published, attributed dataset keeps serving
    // "Anonymous (withheld until publication)" from zarr.nemar.org forever.
    //
    // The stamp is written at the END of the run, not inside the restoration
    // block: `doi_create` runs after `repo_public`, so a rebuild that raced an
    // earlier stamp would bake the restored attribution with NO DOI and spend
    // the one request doing it. This is a source-order check only; the write
    // itself is exercised behaviorally in `zarr-requeue-flip.test.ts`.
    const restoreAt = ORCHESTRATOR.indexOf("if (restoreAttribution) {");
    const doiAt = ORCHESTRATOR.indexOf('stepsToRun.includes("doi_create")');
    const requeueAt = ORCHESTRATOR.indexOf("const zarrRequeueWarning = await stampZarrRequeue(");
    expect(restoreAt).toBeGreaterThan(-1);
    expect(doiAt).toBeGreaterThan(restoreAt);
    expect(requeueAt).toBeGreaterThan(doiAt);
  });

  test("the reservations the blind left behind are finished at BOTH ends of the run", () => {
    // An anonymous release mints its version identifier and leaves it reserved,
    // and review is exactly the process that produces a revision -- so at real
    // publication the ordinary shape is a public `1.0.1` beside a still-reserved
    // `1.0.0` whose `dataset_versions` row has stopped being withheld. Nothing
    // else revisits it: the `version_doi` step only ever names the version being
    // published now, and the DOI reconcile sweep reads `latest_version_doi`
    // alone. The dataset page then renders a live `https://doi.org/...` anchor
    // for an identifier that does not resolve.
    //
    // BOTH ends means both call sites: the finalize block, and the
    // all-steps-complete early return. The warning this returns tells the admin
    // to approve again, so approving again has to be the thing that retries it --
    // and a run with nothing left to do returns before finalize ever executes.
    //
    // Deliberately NOT an assertion about its position relative to
    // `stampZarrRequeue`. Both are awaited tail jobs after the last step, both
    // only read `dataset_versions` and the repository, and neither writes
    // anything the other reads, so swapping them changes no behavior -- an
    // ordering test there passes on the mutation it claims to catch. What the
    // order does depend on is `doi_create` and `version_doi` having run, and
    // that is what being inside the finalize block gives it.
    //
    // Call-site check only; the writes are exercised behaviorally in
    // `concealed-era-version-dois.test.ts`.
    const finalizeAt = ORCHESTRATOR.indexOf(
      "const concealedEraDoiWarning = await completeConcealedEraVersionDois(",
    );
    const lastStepAt = ORCHESTRATOR.indexOf('stepsToRun.includes("version_doi")');
    expect(lastStepAt).toBeGreaterThan(-1);
    expect(finalizeAt).toBeGreaterThan(lastStepAt);
    expect(ORCHESTRATOR.split("await completeConcealedEraVersionDois(").length - 1).toBe(2);
    // The other call site, and its warning reaching the body rather than a log.
    expect(ORCHESTRATOR).toContain(
      "const retryWarnings = [retryWarning, retryVersionWarning].filter(Boolean);",
    );
    expect(ORCHESTRATOR).toContain("    concealedEraDoiWarning,\n  ].filter(Boolean);");
  });

  test("a blinded author list is an interlock on the mint, not only a step order", () => {
    // The ordering above is enforced by where the steps sit. This is the same
    // rule as a state check, so a retry, a resume or a future reordering
    // cannot slip a permanent identifier past it: a DataCite record naming
    // ANONYMOUS_AUTHORS_LABEL as its creator is harvested within hours and
    // inverts ADR 0041 on the one identifier nothing can retract.
    expect(ORCHESTRATOR).toContain("async function blockedByUnrestoredAttribution(");
    expect(ORCHESTRATOR).toContain(
      'const blocked = await blockedByUnrestoredAttribution(c, "doi_create");',
    );
    expect(ORCHESTRATOR).toContain(
      'const blocked = await blockedByUnrestoredAttribution(c, "publish_doi");',
    );
  });

  test("every path to public carries the stamp its own run needs", () => {
    // FIRST_PUBLICATION_STAMP_SQL records a publication only when the row is
    // not anonymous; END_ANONYMITY clears the flag and stamps unconditionally.
    // Pasting the second into an anonymous release -- which the end-of-run
    // repair and the operator recovery string both did -- names the depositor
    // as published and destroys the concealment the run just delivered.
    const branched =
      "c.anonymousRelease ? FIRST_PUBLICATION_STAMP_SQL : END_ANONYMITY_AT_PUBLICATION_SQL";
    // The visibility flip, the end-of-run consistency repair, and the
    // `action_required` statement an operator is told to paste.
    expect(ORCHESTRATOR.split(branched).length - 1).toBe(3);
  });

  test("the repo spec is enforced against the visibility the repo actually has", () => {
    // A hardcoded `visibility: "public"` took the published-repo branch for an
    // anonymous release and locked `main` behind a pull-request ruleset on a
    // repository that is still PRIVATE -- breaking the documented way out of
    // anonymity, where the depositor commits restored Authors straight to main
    // precisely because ADR 0001 has not bitten yet. It applied silently: a
    // successful ruleset is never logged.
    expect(ORCHESTRATOR).toContain('visibility: repoShouldBePrivate ? "private" : "public",');
  });

  test("the mint reads THIS RUN's intent, never the dataset row", () => {
    // On a normal publication of a formerly blinded deposit the row was
    // anonymous moments earlier. Reading it would mint the real, permanent DOI
    // with no curator -- inverting ADR 0041 on the one identifier that is
    // actually harvested.
    expect(ORCHESTRATOR).toContain("anonymousDeposit: c.anonymousRelease,");
    expect(ORCHESTRATOR).not.toContain("anonymousDeposit: isAnonymous(dataset)");
  });
});

describe("the two statements the de-anonymization ordering rests on", () => {
  // `stepRepoPublic` cannot be driven in-suite (approving a publication makes
  // real GitHub, S3 and EZID calls), but the two queries it decides from are
  // just SQL, and SQL can be run. Both were asserted only as source text,
  // which pins where they are written and nothing about what they return.

  function seedRequest(db: Database, datasetId: string, anonymous: number, status: string): void {
    db.prepare(
      `INSERT INTO publication_requests (dataset_id, requested_by, status, anonymous)
       VALUES (?, 7, ?, ?)`,
    ).run(datasetId, status, anonymous);
  }

  test("the history query finds a PAST anonymous request, whatever became of it", () => {
    // Deliberately unfiltered by status and unordered, and this is the test that
    // breaks when someone narrows it. `requested` and `denied` look like
    // requests that never ran, and neither is: the deny route accepts a request
    // that is already `approving`, so a release that reached `markAnonymous` and
    // then failed can be denied afterwards, and `blocked` is written both before
    // a run and mid-run, with `publication-sweep` moving it back to `requested`.
    // Narrowing reintroduces the permanent-DOI-cites-the-blinded-label bug for
    // the sake of skipping an idempotent pass.
    const db = freshDb();
    seed(db, "nm000950");
    seedRequest(db, "nm000950", 1, "denied");
    seedRequest(db, "nm000950", 0, "requested");
    expect(db.prepare(PRIOR_ANONYMOUS_REQUEST_SQL).get("nm000950")).toEqual({ found: 1 });
    db.close();
  });

  test("a dataset that was never anonymous returns nothing", () => {
    // The control. Without it, a query that matched every row would satisfy
    // the assertion above -- and every ordinary publication would pay for an
    // enrichment pass it does not need.
    const db = freshDb();
    seed(db, "nm000951");
    seedRequest(db, "nm000951", 0, "requested");
    expect(db.prepare(PRIOR_ANONYMOUS_REQUEST_SQL).get("nm000951")).toBeNull();
    db.close();
  });

  test("the mint interlock reads the label the writer actually stores", () => {
    // `blockedByUnrestoredAttribution` compares `datasets.authors` against
    // `ANONYMOUS_AUTHORS_LABEL`. Both sides import the same constant, so the
    // comparison cannot drift -- but the STORED value can, and the column is
    // written by `writeDatasetCatalogFields`, not by the interlock. Run the
    // interlock's own query against a row in the state `markAnonymous` leaves.
    const db = freshDb();
    seed(db, "nm000952", 1);
    db.prepare("UPDATE datasets SET authors = ? WHERE dataset_id = ?").run(
      ANONYMOUS_AUTHORS_LABEL,
      "nm000952",
    );
    const blinded = db
      .prepare("SELECT authors FROM datasets WHERE dataset_id = ?")
      .get("nm000952") as { authors: string | null };
    expect(blinded.authors).toBe(ANONYMOUS_AUTHORS_LABEL);

    // And after restoration the interlock lets the mint through.
    db.prepare("UPDATE datasets SET authors = ? WHERE dataset_id = ?").run(
      "Lovelace, Ada",
      "nm000952",
    );
    const restored = db
      .prepare("SELECT authors FROM datasets WHERE dataset_id = ?")
      .get("nm000952") as { authors: string | null };
    expect(restored.authors).not.toBe(ANONYMOUS_AUTHORS_LABEL);
    db.close();
  });
});

describe("the DOI routes refuse to name a concealed depositor", () => {
  const ADMIN_DOI = readFileSync(join(SRC, "routes", "admin", "doi.ts"), "utf8");

  test("the concept mint passes the flag rather than leaving it defaulted", () => {
    // The option existed for a whole review cycle with no caller, so the ADR
    // described a branch nothing reached.
    expect(ADMIN_DOI).toContain("anonymousDeposit: isAnonymous(dataset),");
  });

  test("making a record public or rebuilding it is refused while anonymous", () => {
    expect(ADMIN_DOI).toContain(
      'if (isAnonymous(dataset) && (body.status === "public" || body.refresh_metadata)) {',
    );
  });

  test("the second writer of .nemar/metadata.json blinds what it commits", () => {
    expect(ADMIN_DOI).toContain(
      "const enrichmentToWrite = isAnonymous(dataset) ? blindEnrichmentMetadata(body) : body;",
    );
    // The commit and the D1 cache must use the SAME blinded value, or the
    // publicly-served file and the API would disagree about who deposited it.
    expect(ADMIN_DOI).toContain("JSON.stringify(enrichmentToWrite, null, 2)");
  });
});

describe("enrichment does not un-blind what it just blinded", () => {
  const ENRICH = readFileSync(join(SRC, "services", "enrich-dataset.ts"), "utf8");

  test("the DOI sync is skipped before the EZID write, not after", () => {
    // This block rebuilds the DataCite document from `finalMetadata` (the
    // UNBLINDED object) and `resolveOwnerIdentity` (the real depositor), a
    // hundred lines after the commit document is blinded. Running it would
    // undo the blind inside the same function call.
    const skipAt = ENRICH.indexOf("if (dataset.concept_doi && isAnonymous(dataset)) {");
    const ezidWriteAt = ENRICH.indexOf("await updateIdentifier(ezidAuth");
    expect(skipAt).toBeGreaterThan(-1);
    expect(ezidWriteAt).toBeGreaterThan(skipAt);
  });

  test("the sync branches are mutually exclusive", () => {
    // `if (anonymous) {...} else if (wouldStrip) {...} else if (concept_doi) {...sync...}`.
    // A refactor into independent `if`s would skip AND push.
    const anonymityBranch = ENRICH.indexOf("if (dataset.concept_doi && isAnonymous(dataset)) {");
    const attributionBranch = ENRICH.indexOf(
      "} else if (dataset.concept_doi && refreshWouldStripAttribution(dataset, doiUploader)) {",
    );
    const syncBranch = ENRICH.indexOf("} else if (dataset.concept_doi) {");
    expect(attributionBranch).toBeGreaterThan(anonymityBranch);
    expect(syncBranch).toBeGreaterThan(attributionBranch);
  });

  test("the committed document is blinded before it is both committed and cached", () => {
    const blindAt = ENRICH.indexOf("const documentToCommit = isAnonymous(dataset)");
    const serializeAt = ENRICH.indexOf("const metadataContent = JSON.stringify(documentToCommit");
    const cacheAt = ENRICH.indexOf("UPDATE datasets SET enrichment_json = ?");
    expect(blindAt).toBeGreaterThan(-1);
    expect(serializeAt).toBeGreaterThan(blindAt);
    expect(cacheAt).toBeGreaterThan(serializeAt);
  });
});

describe("every DOI mint asks whether the deposit is anonymous", () => {
  // A mint is the shortest path from a concealed deposit to a PERMANENT
  // DataCite record naming its depositor, and `resolveOwnerIdentity` reads the
  // real name, ORCID and username straight off the joined `users` row. The
  // exemplar re-mint route (`nemar admin exemplar remint-dois`) did not pass
  // `anonymousDeposit`, and it is the documented maintenance command for the
  // fleet that contains the standing anonymous exemplar -- so running it would
  // have de-anonymized exactly the dataset the fleet keeps concealed.
  const MINT_CALL = /createConceptDoi|dispatchCreateConceptDoi/;

  test("no call site mints without deciding the anonymity question", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = file
        .slice(SRC.length + 1)
        .split(sep)
        .join("/");
      const text = readFileSync(file, "utf8");
      // Only call sites, not the declaration or the import.
      for (const match of text.matchAll(
        /await\s+(dispatchCreateConceptDoi|createConceptDoi)\s*\(/g,
      )) {
        const after = text.slice(match.index, (match.index ?? 0) + 2500);
        if (after.includes("anonymousDeposit")) continue;
        offenders.push(`${rel}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scan would notice: it finds the mint call sites it scans", () => {
    // Without this a regex matching nothing would pass forever. Two today:
    // the concept-DOI route and the exemplar re-mint.
    let sites = 0;
    for (const file of sourceFiles(SRC)) {
      sites += [
        ...readFileSync(file, "utf8").matchAll(
          /await\s+(dispatchCreateConceptDoi|createConceptDoi)\s*\(/g,
        ),
      ].length;
    }
    expect(sites).toBeGreaterThanOrEqual(2);
    expect(MINT_CALL.test("dispatchCreateConceptDoi")).toBe(true);
  });
});

describe("a version DOI is refused for a concealed deposit", () => {
  // `createEzidVersionDoi` calls `makePublic` unconditionally, so a version
  // mint publishes a RESOLVING DataCite record -- irreversible, and what
  // ADR 0067's invariant A6 forbids. The webhook dispatcher decided this
  // correctly and fails closed, but the endpoint that actually mints never
  // read the column, so anything reaching it without passing that gate (a
  // workflow re-run, a workflow_dispatch, any holder of the webhook token)
  // minted anyway. Migration 0085's own header: "a rule that lives only in a
  // service is one a future route can forget."
  const CALLBACK = readFileSync(join(SRC, "routes", "callbacks", "version-doi.ts"), "utf8");

  test("the callback reads the column and refuses", () => {
    expect(CALLBACK).toMatch(/anonymous: number \| null;/);
    expect(CALLBACK).toMatch(/if \(isAnonymous\(dataset\)\)/);
  });

  test("the refusal comes before the mint", () => {
    const refusalAt = CALLBACK.indexOf("if (isAnonymous(dataset))");
    const mintAt = CALLBACK.indexOf("await createEzidVersionDoi(");
    expect(refusalAt).toBeGreaterThan(-1);
    expect(mintAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(mintAt);
  });
});
