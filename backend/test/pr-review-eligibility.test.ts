/**
 * Which datasets the review applies to (ADR 0107): the row-in-hand rule the ruleset tooling uses,
 * tied to the SQL rule the Worker uses, and the band of fixture ids the tooling never touches.
 *
 * The tie is the point of the first block. `isReviewableRow` and the Worker's
 * `REVIEWABLE_DATASET_PREDICATE` are two statements of one rule, and a ruleset put on a dataset
 * the Worker will not review (or left off one it will) is a required check that never comes, or a
 * review nobody requires. Both are run over the same rows, in a real SQLite database with every
 * migration applied, through `reviewableDataset`, the Worker's own function.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { GitHubAppEnv } from "../src/services/github-auth";
import { reviewableDataset } from "../src/services/pr-review";
import {
  type AppIdState,
  OUTSIDE_FIXTURE_BAND,
  REMOVAL_IS_NEVER_REFUSED,
  REVIEWABLE_ROW_COLUMNS,
  type ReviewableRow,
  automaticReviewIntent,
  isAutoRequireEnabled,
  isRequirementTarget,
  isReviewEnabled,
  isReviewRulesetFixture,
  isReviewableRow,
  notReviewableReason,
  readReviewIntent,
  reviewAppIdRefusal,
  reviewAppIds,
  reviewAppInstallationRefusal,
  reviewAppRefusal,
  reviewIntentOf,
} from "../src/services/pr-review-eligibility";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";
import { REVIEW_APP_BINDINGS } from "./helpers/github-rulesets";

/** What the functions that decide the review intent read of the Worker's environment. */
type AutoEnv = Pick<Bindings, "DB" | "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE"> & GitHubAppEnv;

const STATUSES = ["active", "archived", "deleted"] as const;
const VISIBILITIES = ["public", "private"] as const;
const ANONYMOUS = [0, 1] as const;
// A real stamp, an empty string (which SQL's IS NOT NULL calls set), and NULL.
const PUBLISHED = ["2026-01-01 00:00:00", "", null] as const;

function combinations(): ReviewableRow[] {
  const out: ReviewableRow[] = [];
  for (const status of STATUSES)
    for (const visibility of VISIBILITIES)
      for (const anonymous of ANONYMOUS)
        for (const first_published_at of PUBLISHED)
          out.push({ status, visibility, anonymous, first_published_at });
  return out;
}

function insert(db: Database, id: string, row: ReviewableRow): void {
  db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo,
                           status, visibility, anonymous, first_published_at)
     VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    [
      id,
      `Dataset ${id}`,
      `nemarDatasets/${id}`,
      row.status,
      row.visibility,
      row.anonymous,
      row.first_published_at,
    ],
  );
}

describe("isReviewableRow agrees with the Worker's SQL rule", () => {
  test("for every combination of status, visibility, anonymity and publication", async () => {
    const db = freshDb();
    // A published anonymous row cannot exist: these two triggers refuse it, which is the invariant
    // the rule leans on. The rule must still say no to one, so the triggers are dropped in this
    // scratch database to put the combination in front of the SQL as well.
    db.run("DROP TRIGGER datasets_anonymous_unpublished_ai");
    db.run("DROP TRIGGER datasets_anonymous_unpublished_au");

    const rows = combinations();
    const d1 = realD1(db);
    const disagreements: string[] = [];
    let reviewable = 0;
    for (const [i, row] of rows.entries()) {
      const id = `nm${String(300 + i).padStart(6, "0")}`;
      insert(db, id, row);
      const sql = (await reviewableDataset(d1, id)) === "reviewable";
      if (sql) reviewable++;
      if (sql !== isReviewableRow(row)) {
        disagreements.push(`${JSON.stringify(row)}: SQL ${sql}, row ${isReviewableRow(row)}`);
      }
    }

    expect(disagreements).toEqual([]);
    // Not vacuous: both answers occur, and exactly the rows that are active, public, named and
    // stamped (the stamp may be an empty string) are the reviewable ones.
    expect(rows.length).toBe(36);
    expect(reviewable).toBe(2);
  });

  test("a missing anonymity value is not reviewable, as SQL's anonymous = 0 is not true of NULL", () => {
    // The column is NOT NULL, so no row holds this; the function still has to say no.
    const row = {
      status: "active",
      visibility: "public",
      anonymous: null,
      first_published_at: "2026-01-01 00:00:00",
    };
    expect(isReviewableRow(row)).toBe(false);
  });
});

describe("notReviewableReason", () => {
  const reviewable: ReviewableRow = {
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-01-01 00:00:00",
  };

  test("names the one condition a dataset fails", () => {
    expect(notReviewableReason(reviewable)).toBeNull();
    expect(notReviewableReason({ ...reviewable, status: "archived" })).toBe("inactive");
    expect(notReviewableReason({ ...reviewable, visibility: "private" })).toBe("private");
    expect(notReviewableReason({ ...reviewable, anonymous: 1, first_published_at: null })).toBe(
      "anonymous",
    );
    expect(notReviewableReason({ ...reviewable, first_published_at: null })).toBe("unpublished");
  });

  test("names the first one in a fixed order when a dataset fails several", () => {
    const nothing: ReviewableRow = {
      status: "deleted",
      visibility: "private",
      anonymous: 1,
      first_published_at: null,
    };
    expect(notReviewableReason(nothing)).toBe("inactive");
    expect(notReviewableReason({ ...nothing, status: "active" })).toBe("private");
    expect(notReviewableReason({ ...nothing, status: "active", visibility: "public" })).toBe(
      "anonymous",
    );
  });
});

describe("what a dataset row calls for", () => {
  const reviewable: ReviewableRow = {
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-01-01 00:00:00",
  };

  test("a reviewed dataset is required while the review is on, and left alone while it is off", () => {
    expect(reviewIntentOf("nm000301", reviewable, true)).toBe("require");
    expect(reviewIntentOf("nm000301", reviewable, false)).toBeUndefined();
  });

  test("a dataset that is not reviewed has the ruleset removed, whether the review is on or off", () => {
    for (const row of [
      { ...reviewable, visibility: "private" },
      { ...reviewable, status: "archived" },
      { ...reviewable, anonymous: 1, first_published_at: null },
      { ...reviewable, first_published_at: null },
    ]) {
      expect(reviewIntentOf("nm000301", row, true)).toBe("remove");
      expect(reviewIntentOf("nm000301", row, false)).toBe("remove");
    }
  });

  test("a standing fixture calls for nothing, whatever its row says", () => {
    // A reviewed-looking row would be required, a private one removed: neither touches a fixture.
    for (const id of ["nm099999", "nm099998", "nm099900"]) {
      for (const row of [reviewable, { ...reviewable, visibility: "private" }]) {
        for (const enabled of [true, false]) {
          expect(
            reviewIntentOf(id, row, enabled),
            `${id} ${row.visibility} ${enabled}`,
          ).toBeUndefined();
        }
      }
    }
    // The staging exemplars are not fixtures to the tooling: they are where a ruleset is tried.
    expect(reviewIntentOf("xx099900", reviewable, true)).toBe("require");
  });

  test("the review is on only for exactly 1", () => {
    expect(isReviewEnabled({ PR_REVIEW_ENABLED: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "01", "11"]) {
      expect(isReviewEnabled({ PR_REVIEW_ENABLED: value }), JSON.stringify(value)).toBe(false);
    }
  });

  test("is read from the catalog as it is now", async () => {
    const db = freshDb();
    insert(db, "nm000301", reviewable);
    insert(db, "nm000302", { ...reviewable, visibility: "private" });
    const env = (flag: string | undefined) =>
      ({
        DB: realD1(db),
        PR_REVIEW_ENABLED: flag,
        PR_REVIEW_AUTO_REQUIRE: "1",
        ...REVIEW_APP_BINDINGS,
      }) as unknown as AutoEnv;

    expect(await readReviewIntent(env("1"), "nm000301")).toBe("require");
    expect(await readReviewIntent(env(undefined), "nm000301")).toBeUndefined();
    expect(await readReviewIntent(env("1"), "nm000302")).toBe("remove");
    // A dataset the catalog does not hold gets no answer, so nothing is touched.
    expect(await readReviewIntent(env("1"), "nm000399")).toBeUndefined();
    // Nor does a fixture, although its row is there and is reviewed.
    insert(db, "nm099950", reviewable);
    expect(await readReviewIntent(env("1"), "nm099950")).toBeUndefined();

    // And it follows the row: the same dataset, made private, no longer calls for the ruleset.
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000301'");
    expect(await readReviewIntent(env("1"), "nm000301")).toBe("remove");
  });

  test("a read that fails answers nothing, so the rest of the repository's work is not lost", async () => {
    const db = freshDb();
    insert(db, "nm000301", reviewable);
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql.includes("FROM datasets")) throw new Error("D1 is unavailable");
    });

    // Both switches on, so that the only reason for an empty answer is the failed read.
    const intent = await readReviewIntent(
      { DB: failing, PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1" } as unknown as Pick<
        Bindings,
        "DB" | "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE"
      >,
      "nm000301",
    );

    expect(intent).toBeUndefined();
  });

  test("the columns it selects are the ones the rule reads", () => {
    expect(
      REVIEWABLE_ROW_COLUMNS.split(",")
        .map((c) => c.trim())
        .sort(),
    ).toEqual(["anonymous", "first_published_at", "status", "visibility"]);
  });
});

describe("the automatic requirement switch (PR_REVIEW_AUTO_REQUIRE)", () => {
  const reviewable: ReviewableRow = {
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-01-01 00:00:00",
  };

  test("is on only for exactly 1, and unset is off", () => {
    expect(isAutoRequireEnabled({ PR_REVIEW_AUTO_REQUIRE: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "01", "11"]) {
      expect(isAutoRequireEnabled({ PR_REVIEW_AUTO_REQUIRE: value }), JSON.stringify(value)).toBe(
        false,
      );
    }
  });

  test("off, the automatic paths ask for no requirement, with the review on or off", () => {
    for (const review of ["1", undefined]) {
      const env = { PR_REVIEW_ENABLED: review, PR_REVIEW_AUTO_REQUIRE: undefined };
      expect(
        automaticReviewIntent(env, "nm000301", reviewable),
        `reviewable, review=${review}`,
      ).toBeUndefined();
    }
  });

  test("off, they still take the ruleset off a dataset that is not reviewed: the switch gates only the addition", () => {
    // A dataset made private while the switch is off must not keep a ruleset that nothing can
    // satisfy, so a row that is not reviewed is removed whatever the switch and the review say.
    const rows: ReviewableRow[] = [
      { ...reviewable, visibility: "private" },
      { ...reviewable, status: "archived" },
      { ...reviewable, first_published_at: null },
      { ...reviewable, anonymous: 1, first_published_at: null },
    ];
    for (const row of rows) {
      for (const review of ["1", undefined]) {
        for (const auto of [undefined, "0", "1"]) {
          const env = { PR_REVIEW_ENABLED: review, PR_REVIEW_AUTO_REQUIRE: auto };
          expect(
            automaticReviewIntent(env, "nm000301", row),
            `${JSON.stringify(row)} review=${review} auto=${auto}`,
          ).toBe("remove");
        }
      }
    }
  });

  test("a standing fixture is left alone with the switch off, as it is with it on", () => {
    const priv = { ...reviewable, visibility: "private" };
    for (const auto of [undefined, "1"]) {
      const env = { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: auto };
      expect(automaticReviewIntent(env, "nm099998", priv), String(auto)).toBeUndefined();
      expect(automaticReviewIntent(env, "nm099999", reviewable), String(auto)).toBeUndefined();
    }
  });

  test("the requirement is the target only with the review on AND the switch on, each exactly 1", () => {
    expect(isRequirementTarget({ PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1" })).toBe(true);
    for (const [review, auto] of [
      ["1", undefined],
      [undefined, "1"],
      ["1", "0"],
      ["0", "1"],
      ["1", "true"],
      ["true", "1"],
      [undefined, undefined],
    ] as const) {
      expect(
        isRequirementTarget({ PR_REVIEW_ENABLED: review, PR_REVIEW_AUTO_REQUIRE: auto }),
        `${review}/${auto}`,
      ).toBe(false);
    }
  });

  test("on, they ask what the row calls for", () => {
    const on = { PR_REVIEW_AUTO_REQUIRE: "1", ...REVIEW_APP_BINDINGS };
    expect(automaticReviewIntent({ ...on, PR_REVIEW_ENABLED: "1" }, "nm000301", reviewable)).toBe(
      "require",
    );
    // The review being off still keeps the requirement off, as it did before the switch existed.
    expect(automaticReviewIntent(on, "nm000301", reviewable)).toBeUndefined();
    const priv = { ...reviewable, visibility: "private" };
    expect(automaticReviewIntent({ ...on, PR_REVIEW_ENABLED: "1" }, "nm000301", priv)).toBe(
      "remove",
    );
    expect(automaticReviewIntent(on, "nm000301", priv)).toBe("remove");
    // And a standing fixture is still left alone.
    expect(
      automaticReviewIntent({ ...on, PR_REVIEW_ENABLED: "1" }, "nm099998", reviewable),
    ).toBeUndefined();
  });

  // The function the publication, visibility and orchestrator paths call, against a real catalog.
  describe("readReviewIntent, read from a real D1", () => {
    function seeded() {
      const db = freshDb();
      insert(db, "nm000301", reviewable);
      insert(db, "nm000302", { ...reviewable, visibility: "private" });
      const env = (review: string | undefined, auto: string | undefined) =>
        ({
          DB: realD1(db),
          PR_REVIEW_ENABLED: review,
          PR_REVIEW_AUTO_REQUIRE: auto,
          ...REVIEW_APP_BINDINGS,
        }) as unknown as AutoEnv;
      return { db, env };
    }

    test("off, a reviewable public dataset has no answer although the review is on", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env("1", undefined), "nm000301")).toBeUndefined();
    });

    test("on, a reviewable public dataset is required", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env("1", "1"), "nm000301")).toBe("require");
    });

    test("a private dataset has the requirement removed, with the switch on or off", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env("1", "1"), "nm000302")).toBe("remove");
      expect(await readReviewIntent(env("1", undefined), "nm000302")).toBe("remove");
    });

    test("anything but exactly 1 is off: no requirement, and the removal is still asked for", async () => {
      const { env } = seeded();
      for (const value of ["", "0", "true", "yes", " 1", "01", "11"]) {
        expect(
          await readReviewIntent(env("1", value), "nm000301"),
          `reviewable, ${JSON.stringify(value)}`,
        ).toBeUndefined();
        expect(
          await readReviewIntent(env("1", value), "nm000302"),
          `private, ${JSON.stringify(value)}`,
        ).toBe("remove");
      }
    });

    test("on with the review off keeps the requirement off, and still removes it", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env(undefined, "1"), "nm000301")).toBeUndefined();
      expect(await readReviewIntent(env(undefined, "1"), "nm000302")).toBe("remove");
    });

    test("it follows the row, switching the same dataset from require to remove", async () => {
      const { db, env } = seeded();
      expect(await readReviewIntent(env("1", "1"), "nm000301")).toBe("require");
      db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000301'");
      expect(await readReviewIntent(env("1", "1"), "nm000301")).toBe("remove");
      // Turned off again, the same row still has the ruleset taken off: the switch gates only the
      // addition.
      expect(await readReviewIntent(env("1", undefined), "nm000301")).toBe("remove");
    });
  });
});

// The ruleset requires the NEMAR PR Review check from one GitHub App, and the Worker posts it as the
// App whose id is its GITHUB_APP_ID binding. Unless they are the same App the check never arrives,
// and every pull request on a repository that carries the ruleset waits for it for good.
describe("the GitHub App the ruleset requires the check from", () => {
  const reviewable: ReviewableRow = {
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-01-01 00:00:00",
  };

  test("agrees only with exactly the NEMAR App id, digit for digit", () => {
    expect(reviewAppIds({ GITHUB_APP_ID: "3679074" })).toEqual({
      github_app_id: "3679074",
      github_app_id_state: "id",
      ruleset_app_id: 3679074,
      app_id_matches: true,
      // The id alone is not a way to sign in as the App: see the installation tests below.
      installation_configured: false,
    });
    expect(reviewAppIdRefusal({ GITHUB_APP_ID: "3679074" })).toBeNull();
    for (const value of [
      undefined,
      "",
      "0",
      "1234567",
      " 3679074",
      "3679074 ",
      "03679074",
      "3679074\n",
      "3679074.0",
      "app",
    ]) {
      expect(reviewAppIds({ GITHUB_APP_ID: value }).app_id_matches, JSON.stringify(value)).toBe(
        false,
      );
      expect(reviewAppIdRefusal({ GITHUB_APP_ID: value }), JSON.stringify(value)).not.toBeNull();
    }
  });

  test("the sentence names both ids", () => {
    const sentence = reviewAppIdRefusal({ GITHUB_APP_ID: "1234567" }) ?? "";
    expect(sentence).toContain("3679074");
    expect(sentence).toContain("1234567");
  });

  // One row of a page carries this sentence and the CLI prints it once for the page, where other
  // rows may have been changed, so it says nothing about what was changed. The route for one
  // dataset adds that nothing was, and a test of it is in review-ruleset-routes.test.ts.
  test("a refusal ends with the way out, in a plain sentence, and says nothing of what was changed", () => {
    const sentences = [
      reviewAppIdRefusal({ GITHUB_APP_ID: "1234567" }),
      reviewAppInstallationRefusal({ GITHUB_APP_ID: "3679074" }),
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toBeNull();
      expect(sentence).toEndWith(REMOVAL_IS_NEVER_REFUSED);
      expect(sentence).not.toContain("Nothing was changed");
      expect(sentence).not.toContain("neither remove");
    }
    expect(REMOVAL_IS_NEVER_REFUSED).toBe(
      "Taking the ruleset off is never refused, whether it is asked for or the dataset is not one the review covers.",
    );
  });

  // `github_app_id` is null for an unset binding and for one that holds something else, so the
  // two are told apart by the state, and an administrator is told which one to fix.
  test("the binding is one of three states, unset, not a number and an id, and each is told apart", () => {
    const cases: Array<[string | undefined, AppIdState, string | null]> = [
      [undefined, "unset", null],
      ["", "unset", null],
      ["-----BEGIN PRIVATE KEY-----", "not_a_number", null],
      [" 3679074", "not_a_number", null],
      ["3679074\n", "not_a_number", null],
      ["12345678901234567", "not_a_number", null],
      ["app", "not_a_number", null],
      ["1234567", "id", "1234567"],
      ["3679074", "id", "3679074"],
    ];
    for (const [value, state, id] of cases) {
      expect(reviewAppIds({ GITHUB_APP_ID: value }), JSON.stringify(value)).toMatchObject({
        github_app_id_state: state,
        github_app_id: id,
      });
    }
  });

  test("the sentence names the state the binding is in and not another", () => {
    const unset = reviewAppIdRefusal({ GITHUB_APP_ID: undefined }) ?? "";
    expect(unset).toContain("GITHUB_APP_ID is not set");
    expect(unset).not.toContain("not a plain number");

    const notANumber = reviewAppIdRefusal({ GITHUB_APP_ID: " 3679074" }) ?? "";
    expect(notANumber).toContain("GITHUB_APP_ID is set but is not a plain number");
    expect(notANumber).not.toContain("is not set");

    const another = reviewAppIdRefusal({ GITHUB_APP_ID: "1234567" }) ?? "";
    expect(another).toContain("the App with id 1234567");
    expect(another).not.toContain("is not set");
    expect(another).not.toContain("plain number");
  });

  test("an unset binding is said to be unset, and a value that is not an id is never repeated", () => {
    expect(reviewAppIdRefusal({ GITHUB_APP_ID: undefined })).toContain("GITHUB_APP_ID is not set");
    expect(reviewAppIdRefusal({ GITHUB_APP_ID: "" })).toContain("GITHUB_APP_ID is not set");
    // Whatever was pasted into the binding by mistake is not echoed into an answer.
    const pasted = "-----BEGIN PRIVATE KEY-----";
    const sentence = reviewAppIdRefusal({ GITHUB_APP_ID: pasted }) ?? "";
    expect(sentence).not.toContain("PRIVATE KEY");
    expect(sentence).toContain("not a number");
    expect(reviewAppIds({ GITHUB_APP_ID: pasted }).github_app_id).toBeNull();
  });

  test("a Worker on another App asks for no requirement on its own, says why in the log, and still asks for the removal", () => {
    const env = { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1", GITHUB_APP_ID: "1234567" };
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      expect(automaticReviewIntent(env, "nm000301", reviewable)).toBeUndefined();
      // A removal needs no check to arrive, so it is never held back by this.
      expect(automaticReviewIntent(env, "nm000301", { ...reviewable, visibility: "private" })).toBe(
        "remove",
      );
    } finally {
      console.error = realError;
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("nm000301");
    expect(logged[0]).toContain("3679074");
    expect(logged[0]).toContain("1234567");
    // And with the right App the same row is required.
    expect(automaticReviewIntent({ ...env, ...REVIEW_APP_BINDINGS }, "nm000301", reviewable)).toBe(
      "require",
    );
  });

  // The check is posted with an installation token for nemarDatasets. Without the App's private key
  // or that organization's installation id the Worker falls back to a personal access token
  // (getDatasetsTokenWithRefresher), and GitHub does not let one post a check run: a matching id
  // is not enough.
  describe("a Worker with the right App id and no way to sign in as the App", () => {
    const withoutKey = { ...REVIEW_APP_BINDINGS, GITHUB_APP_PRIVATE_KEY: undefined };
    const withoutInstallation = {
      ...REVIEW_APP_BINDINGS,
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: undefined,
    };

    /** Run `fn` with the warning getGitHubAppConfig gives for a malformed installation id silenced. */
    function quietly<T>(fn: () => T): T {
      const realWarn = console.warn;
      console.warn = () => {};
      try {
        return fn();
      } finally {
        console.warn = realWarn;
      }
    }

    test("the installation is configured only with the key and a plain positive installation id", () => {
      expect(reviewAppIds(REVIEW_APP_BINDINGS).installation_configured).toBe(true);
      expect(reviewAppIds(withoutKey).installation_configured).toBe(false);
      expect(reviewAppIds(withoutInstallation).installation_configured).toBe(false);
      // An installation id for the other organization is not the one the check is posted with.
      expect(
        reviewAppIds({
          ...withoutInstallation,
          GITHUB_APP_INSTALLATION_ID_NEMAR_ORG: "424242",
        }).installation_configured,
      ).toBe(false);
      for (const bad of ["", "0", "-5", "12abc", "4.2", "abc"]) {
        const ids = quietly(() =>
          reviewAppIds({ ...REVIEW_APP_BINDINGS, GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: bad }),
        );
        expect(ids.installation_configured, JSON.stringify(bad)).toBe(false);
      }
      // The id still matches: it is only the way to sign in that is missing.
      expect(reviewAppIds(withoutInstallation).app_id_matches).toBe(true);
    });

    test("the refusal is a plain sentence that says what is missing and why it matters", () => {
      for (const env of [withoutKey, withoutInstallation]) {
        const sentence = reviewAppInstallationRefusal(env) ?? "";
        expect(sentence).toContain("GITHUB_APP_PRIVATE_KEY");
        expect(sentence).toContain("GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS");
        expect(sentence).toContain("personal access token");
        expect(sentence).toContain("check would never arrive");
        // It does not talk about the App's id: that is not what is wrong.
        expect(sentence).not.toContain("3679074");
      }
      expect(reviewAppInstallationRefusal(REVIEW_APP_BINDINGS)).toBeNull();
    });

    test("the id is said first, and the installation only for the right App", () => {
      expect(reviewAppRefusal(REVIEW_APP_BINDINGS)).toBeNull();
      expect(reviewAppRefusal(withoutKey)?.code).toBe("review_app_not_configured");
      expect(reviewAppRefusal(withoutInstallation)?.code).toBe("review_app_not_configured");
      // Another App, and no installation either: the id is what is said.
      const another = reviewAppRefusal({ GITHUB_APP_ID: "1234567" });
      expect(another?.code).toBe("review_app_mismatch");
      expect(another?.sentence).toContain("1234567");
      expect(another?.sentence).not.toContain("GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS");
    });

    test("they ask for no requirement on their own, say why in the log, and still ask for the removal", () => {
      const logged: string[] = [];
      const realError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      try {
        for (const config of [withoutKey, withoutInstallation]) {
          const env = { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1", ...config };
          expect(automaticReviewIntent(env, "nm000301", reviewable)).toBeUndefined();
          // A removal needs no check to arrive, so it is never held back by this.
          expect(
            automaticReviewIntent(env, "nm000301", { ...reviewable, visibility: "private" }),
          ).toBe("remove");
        }
      } finally {
        console.error = realError;
      }
      expect(logged).toHaveLength(2);
      for (const line of logged) {
        expect(line).toContain("nm000301");
        expect(line).toContain("GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS");
      }
      // With both the right App and a way to sign in as it, the same row is required.
      expect(
        automaticReviewIntent(
          { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1", ...REVIEW_APP_BINDINGS },
          "nm000301",
          reviewable,
        ),
      ).toBe("require");
    });

    test("read from the catalog, the same", async () => {
      const db = freshDb();
      insert(db, "nm000301", reviewable);
      insert(db, "nm000302", { ...reviewable, visibility: "private" });
      const env = (config: Partial<GitHubAppEnv>) =>
        ({
          DB: realD1(db),
          PR_REVIEW_ENABLED: "1",
          PR_REVIEW_AUTO_REQUIRE: "1",
          ...config,
        }) as unknown as AutoEnv;
      const realError = console.error;
      console.error = () => {};
      try {
        expect(await readReviewIntent(env(REVIEW_APP_BINDINGS), "nm000301")).toBe("require");
        expect(await readReviewIntent(env(withoutInstallation), "nm000301")).toBeUndefined();
        expect(await readReviewIntent(env(withoutInstallation), "nm000302")).toBe("remove");
      } finally {
        console.error = realError;
      }
    });
  });

  test("the App id is not asked when nothing would be required", () => {
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      // The switch is off: no requirement is the answer, and there is nothing to refuse.
      expect(
        automaticReviewIntent(
          { PR_REVIEW_ENABLED: "1", GITHUB_APP_ID: undefined },
          "nm000301",
          reviewable,
        ),
      ).toBeUndefined();
    } finally {
      console.error = realError;
    }
    expect(logged).toEqual([]);
  });
});

describe("the fixture band the ruleset tooling never touches", () => {
  test("is the top 100 ids of the nm prefix, nm099900 to nm099999, named as a band", () => {
    for (let n = 99900; n <= 99999; n++) {
      expect(isReviewRulesetFixture(`nm${String(n).padStart(6, "0")}`), String(n)).toBe(true);
    }
    // The ids on either side of the band are ordinary datasets.
    expect(isReviewRulesetFixture("nm099899")).toBe(false);
    expect(isReviewRulesetFixture("nm000108")).toBe(false);
  });

  test("names the fixtures that matter, and not the five datasets the old rule protected", () => {
    expect(isReviewRulesetFixture("nm099999")).toBe(true); // the end-to-end dataset
    expect(isReviewRulesetFixture("nm099998")).toBe(true); // the standing anonymous deposit
    // More than 900 datasets are live, so no dataset is protected for being live. The five that
    // an earlier rule named are datasets like any other here.
    for (const id of ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]) {
      expect(isReviewRulesetFixture(id), id).toBe(false);
    }
  });

  test("is the nm band only: the staging exemplars and imports are not in it", () => {
    for (const id of ["xx099900", "xx099999", "on099950", "on000001", "xx000001"]) {
      expect(isReviewRulesetFixture(id), id).toBe(false);
    }
  });

  test("is not fooled by something that is not an id", () => {
    for (const id of ["", "nm", "nm99999", "nm0999999", "NM099999", "nm099999 ", "x nm099999"]) {
      expect(isReviewRulesetFixture(id), JSON.stringify(id)).toBe(false);
    }
  });

  test("the WHERE condition and the function are one rule", () => {
    const db = freshDb();
    const ids = [
      "nm000001",
      "nm000103",
      "nm000108",
      "nm050000",
      "nm099899",
      "nm099900",
      "nm099901",
      "nm099950",
      "nm099997",
      "nm099998",
      "nm099999",
      "xx000001",
      "xx099900",
      "xx099999",
      "on000001",
      "on099950",
      "on099999",
    ];
    const outside = db.query<{ dataset_id: string }, [string, number]>(
      `SELECT dataset_id FROM (SELECT ? AS dataset_id) WHERE ${OUTSIDE_FIXTURE_BAND.sql}`,
    );
    for (const id of ids) {
      const kept = outside.all(id, OUTSIDE_FIXTURE_BAND.bind).length === 1;
      expect(kept, id).toBe(!isReviewRulesetFixture(id));
    }
    // Not vacuous: both outcomes occur.
    expect(ids.filter(isReviewRulesetFixture).length).toBeGreaterThan(0);
    expect(ids.filter((id) => !isReviewRulesetFixture(id)).length).toBeGreaterThan(0);
  });
});
