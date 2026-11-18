/**
 * Pure unit tests for the shared wire contract (epic #896, #898).
 *
 * No live backend: validates the schemas + version canonicalizer directly, so
 * this is a required unit-pure test that also gates deploys. The live-response
 * drift guard is the separate integration test test/contract-live.test.ts.
 * (Intentionally no live-backend env-var token in this file's text: the CI tier
 * classifier is a content grep, and a mere mention would misroute this pure test
 * out of the required/deploy-gating tier -- see epic #896 cross-phase review.)
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import * as computeModule from "../shared/contract/compute";
import * as launchModule from "../shared/contract/compute-launch";
import * as runnerModule from "../shared/contract/compute-runner";
import {
  NEUROSCHEMA_VERSION,
  NO_SESSION_KEY,
  bidsIndexSchema,
  bidsIndexSubjectSchema,
  catalogItemSchema,
  datasetDetailSchema,
  datasetListEnvelopeSchema,
  datasetSearchEnvelopeSchema,
  isVersionTag,
  neuroschemaDatasetSchema,
  searchHitSchema,
  toBareVersion,
  toVersionTag,
  userMeResponseSchema,
  versionTagSchema,
  webUserSchema,
} from "../shared/contract/index.js";

describe("version canonicalizer", () => {
  test("toVersionTag is idempotent and coerces bare -> tag", () => {
    expect(toVersionTag("1.0.0")).toBe("v1.0.0");
    expect(toVersionTag("v1.0.0")).toBe("v1.0.0");
    expect(toBareVersion("v2.3.4")).toBe("2.3.4");
    expect(isVersionTag("v1.0.0")).toBe(true);
    expect(isVersionTag("1.0.0")).toBe(false);
  });

  test("versionTagSchema accepts bare or tagged, outputs canonical tag", () => {
    expect(versionTagSchema.parse("1.2.3")).toBe("v1.2.3");
    expect(versionTagSchema.parse("v1.2.3")).toBe("v1.2.3");
    expect(versionTagSchema.parse("1.0.0-rc1")).toBe("v1.0.0-rc1");
    expect(() => versionTagSchema.parse("latest")).toThrow();
    expect(() => versionTagSchema.parse("1.0")).toThrow();
  });
});

describe("catalog item schema", () => {
  const row = {
    dataset_id: "nm000108",
    id: "nm000108",
    name: "Test",
    description: null,
    status: "active",
    visibility: "public",
    concept_doi: null,
    doi: null,
    created_at: "2026-01-01T00:00:00Z",
    owner_username: "someone",
    source: "nemar",
    modalities: "eeg",
    participants: 12,
    tasks: "rest",
    authors: "Doe, J.",
    license: "CC0",
    file_size: 123456,
    file_size_formatted: "120 KB",
    latest_version: "1.0.0", // bare on the wire today; coerced to tag on parse
  };

  test("accepts a current catalog row and canonicalizes latest_version", () => {
    const parsed = catalogItemSchema.parse(row);
    expect(parsed.latest_version).toBe("v1.0.0");
  });

  test("tolerates additive unknown fields (passthrough)", () => {
    const parsed = catalogItemSchema.parse({ ...row, some_future_field: 1 });
    expect((parsed as Record<string, unknown>).some_future_field).toBe(1);
  });

  test("rejects a row missing a required field", () => {
    const { name, ...noName } = row;
    void name;
    expect(() => catalogItemSchema.parse(noName)).toThrow();
  });

  test("list envelope validates", () => {
    expect(() =>
      datasetListEnvelopeSchema.parse({ datasets: [row], count: 1, total_count: 1 }),
    ).not.toThrow();
  });

  test("latest_version_at is an optional nullable string, never a number", () => {
    expect(catalogItemSchema.parse(row).latest_version_at).toBeUndefined();
    expect(
      catalogItemSchema.parse({ ...row, latest_version_at: null }).latest_version_at,
    ).toBeNull();
    expect(
      catalogItemSchema.parse({ ...row, latest_version_at: "2026-09-16 17:22:05" })
        .latest_version_at,
    ).toBe("2026-09-16 17:22:05");
    expect(() => catalogItemSchema.parse({ ...row, latest_version_at: 1790000000 })).toThrow();
  });

  test("accepts the #970 honest-size fields (total_files, data_complete, bytes_present)", () => {
    const parsed = catalogItemSchema.parse({
      ...row,
      total_files: 400,
      data_complete: 0,
      bytes_present: 36,
    });
    expect(parsed.total_files).toBe(400);
    expect(parsed.data_complete).toBe(0);
    expect(parsed.bytes_present).toBe(36);
  });

  test("#970 fields are optional and nullable (older backends / not-yet-audited rows)", () => {
    expect(() => catalogItemSchema.parse(row)).not.toThrow();
    const parsed = catalogItemSchema.parse({
      ...row,
      total_files: null,
      data_complete: null,
      bytes_present: null,
    });
    expect(parsed.data_complete).toBeNull();
  });

  test("rejects an out-of-domain data_complete value", () => {
    expect(() => catalogItemSchema.parse({ ...row, data_complete: 2 })).toThrow();
  });

  test("accepts the #1062 zarr fields, including the derived zarr_index_url", () => {
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_status: "ready",
      zarr_store_count: 41,
      zarr_converted_at: "2026-08-01T00:00:00.000Z",
      zarr_source_commit: "abc123",
      zarr_errors: 0,
      zarr_failure_count: 0,
      zarr_deterministic: 0,
      zarr_failed_at: null,
      zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
    });
    expect(parsed.zarr_store_count).toBe(41);
    expect(parsed.zarr_index_url).toBe("https://zarr.nemar.org/on007763/zarr/index.json");
  });

  test("the #1062 zarr fields are optional and nullable (older backends / not-yet-converted rows)", () => {
    expect(() => catalogItemSchema.parse(row)).not.toThrow();
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_store_count: null,
      zarr_converted_at: null,
      zarr_source_commit: null,
      zarr_errors: null,
      zarr_failure_count: null,
      zarr_deterministic: null,
      zarr_failed_at: null,
      zarr_index_url: null,
    });
    expect(parsed.zarr_index_url).toBeNull();
  });

  // PR #1201 review, item 3: the cross-field invariant a regressed
  // deriveZarrIndexUrl (or a future write path setting the two fields
  // independently) would violate -- caught at the contract layer, not just
  // trusted from the derivation function's own code.
  test("REJECTS zarr_index_url set when zarr_status is not 'ready'", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_status: "pending",
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).toThrow();
  });

  test("REJECTS zarr_index_url set when zarr_status is null (never converted)", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_status: null,
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).toThrow();
  });

  test("ACCEPTS zarr_index_url set when zarr_status IS 'ready' (the consistent pair)", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_status: "ready",
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).not.toThrow();
  });

  // Issue #1068, epic #1181 phase 8: the fidelity verification sweep's verdict.
  test("accepts the #1068 zarr_verify_status/zarr_verified_at fields", () => {
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_status: "ready",
      zarr_verify_status: "verified",
      zarr_verified_at: "2026-09-02 00:00:00",
    });
    expect(parsed.zarr_verify_status).toBe("verified");
    expect(parsed.zarr_verified_at).toBe("2026-09-02 00:00:00");
  });

  test("zarr_verify_status/zarr_verified_at are optional and null (a fresh conversion the sweep hasn't reached yet)", () => {
    expect(() => catalogItemSchema.parse(row)).not.toThrow();
    const parsed = catalogItemSchema.parse({
      ...row,
      zarr_verify_status: null,
      zarr_verified_at: null,
    });
    expect(parsed.zarr_verify_status).toBeNull();
    expect(parsed.zarr_verified_at).toBeNull();
  });

  test("rejects an out-of-enum zarr_verify_status", () => {
    expect(() => catalogItemSchema.parse({ ...row, zarr_verify_status: "bogus" })).toThrow();
  });

  // The cross-field invariant a regressed sweep write (or a future path that
  // sets the two independently) would violate.
  test("REJECTS zarr_verified_at set when zarr_verify_status is null", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_verify_status: null,
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).toThrow();
  });

  test("ACCEPTS zarr_verified_at set when zarr_verify_status is non-null (the consistent pair)", () => {
    expect(() =>
      catalogItemSchema.parse({
        ...row,
        zarr_verify_status: "failed",
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).not.toThrow();
  });
});

describe("detail schema: zarr_data_failures (#1191, fixes #1188)", () => {
  const detailRow = {
    dataset_id: "on007763",
    id: "on007763",
    name: "Test",
    description: null,
    status: "active",
    visibility: "public",
    concept_doi: null,
    doi: null,
    created_at: "2026-01-01T00:00:00Z",
    owner_username: "someone",
    source: "openneuro",
    modalities: "meg",
    participants: 41,
    tasks: "rest",
    authors: "Doe, J.",
    license: "CC0",
    file_size: 123456,
  };

  test("accepts the bounded {count, detail_ref} summary object", () => {
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: { count: 36, detail_ref: "zarr/index.json" },
    });
    expect(parsed.zarr_data_failures).toEqual({ count: 36, detail_ref: "zarr/index.json" });
  });

  test("accepts the summary object with the optional compacted_by (migration 0074 rows)", () => {
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: {
        count: 877,
        detail_ref: "zarr/index.json",
        compacted_by: "migration_0074",
      },
    });
    expect(parsed.zarr_data_failures?.compacted_by).toBe("migration_0074");
  });

  test("accepts null (no known failures on record)", () => {
    const parsed = datasetDetailSchema.parse({ ...detailRow, zarr_data_failures: null });
    expect(parsed.zarr_data_failures).toBeNull();
  });

  test("KEEPS the coverage counts and the unpublished-sibling flags", () => {
    // Every one of these is written into the same stored object by
    // `zarrFailureColumns` and projected by `parseZarrDataFailures`. Undeclared,
    // the closed object silently STRIPPED them here -- which is how #1197's
    // "2 of 43" reached D1 and never reached a consumer.
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: {
        count: 36,
        detail_ref: "zarr/index.json",
        pending: 5,
        discovered: 43,
        events_upload_failed: true,
        manifest_upload_failed: true,
      },
    });
    expect(parsed.zarr_data_failures).toEqual({
      count: 36,
      detail_ref: "zarr/index.json",
      pending: 5,
      discovered: 43,
      events_upload_failed: true,
      manifest_upload_failed: true,
    });
  });

  test("the sibling flags are true-only: false is not a shape the writer produces", () => {
    // `zarrFailureColumns` omits the key rather than writing false, so absence
    // IS the negative. Accepting false as well would give the same condition two
    // spellings and let a consumer read one of them wrong.
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_data_failures: {
          count: 0,
          detail_ref: "zarr/index.json",
          manifest_upload_failed: false,
        },
      }),
    ).toThrow();
  });

  test("an undeclared key passes THROUGH rather than being stripped", () => {
    // The module's rule for every other object here: the contract is a lower
    // bound. This nested object was the one exception, and stripping is exactly
    // what made #1197's counts invisible -- a newer backend's next additive key
    // must reach the caller, not vanish on the way out.
    const parsed = datasetDetailSchema.parse({
      ...detailRow,
      zarr_data_failures: { count: 1, detail_ref: "zarr/index.json", not_yet_declared: 7 },
    });
    expect((parsed.zarr_data_failures as Record<string, unknown>).not_yet_declared).toBe(7);
  });

  test("zarr_data_failures is optional (older backends omit it entirely)", () => {
    expect(() => datasetDetailSchema.parse(detailRow)).not.toThrow();
  });

  test("REJECTS a raw string -- the pre-#1191 shape must never validate again", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_data_failures: JSON.stringify({ count: 36, detail_ref: "zarr/index.json" }),
      }),
    ).toThrow();
  });

  test("rejects a bare array (the pre-migration-0074 per-file list shape)", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_data_failures: [{ path: "a", code: "x" }],
      }),
    ).toThrow();
  });

  // PR #1201 review, item 3: datasetDetailSchema carries the same
  // zarr_index_url/zarr_status invariant as catalogItemSchema -- re-applied
  // via superRefine after `.extend()`, since `.extend()` is not available on
  // a ZodEffects. Proven here so a future refactor that drops the reapply
  // (e.g. reordering the chain) fails this test, not just the list schema's.
  test("also REJECTS zarr_index_url set when zarr_status is not 'ready'", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_status: "pending",
        zarr_index_url: "https://zarr.nemar.org/on007763/zarr/index.json",
      }),
    ).toThrow();
  });

  // Issue #1068, epic #1181 phase 8: same zarr_verified_at/zarr_verify_status
  // invariant as catalogItemSchema, re-applied after `.extend()` -- proven
  // separately for the same reason as the zarr_index_url pair above.
  test("also REJECTS zarr_verified_at set when zarr_verify_status is null", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_verify_status: null,
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).toThrow();
  });

  test("also ACCEPTS the consistent zarr_verify_status/zarr_verified_at pair", () => {
    expect(() =>
      datasetDetailSchema.parse({
        ...detailRow,
        zarr_verify_status: "unverifiable",
        zarr_verified_at: "2026-09-02 00:00:00",
      }),
    ).not.toThrow();
  });
});

describe("search hit schema", () => {
  // The real /datasets/search projection: `d.dataset_id AS id`, no latest_version.
  const hit = {
    id: "nm000108",
    name: "Test",
    modalities: "eeg",
    participants: 12,
    doi: null,
    tasks: "rest",
    authors: "Doe, J.",
    has_hed: 1,
    score: 0.87,
  };

  test("accepts a real search hit (keyed on id, not dataset_id)", () => {
    expect(() => searchHitSchema.parse(hit)).not.toThrow();
  });

  test("rejects a hit missing id (regression guard for the #898 review Critical)", () => {
    const { id, ...noId } = hit;
    void id;
    expect(() => searchHitSchema.parse(noId)).toThrow();
  });

  test("tolerates null raw columns (no COALESCE in the search query)", () => {
    expect(() =>
      searchHitSchema.parse({ id: "nm000108", name: "T", modalities: null, participants: null }),
    ).not.toThrow();
  });

  test("search envelope validates a non-empty results array", () => {
    // "fts" was never a real `method` value the backend emits; #1145 review
    // I6/I7 tightened the schema's `method` to the real 5-member enum, so
    // this now has to use a literal the backend actually returns.
    expect(() =>
      datasetSearchEnvelopeSchema.parse({ results: [hit], count: 1, method: "text", min_score: 0 }),
    ).not.toThrow();
  });

  test("search envelope rejects a method value the backend never emits", () => {
    expect(() =>
      datasetSearchEnvelopeSchema.parse({ results: [hit], count: 1, method: "fts", min_score: 0 }),
    ).toThrow();
  });
});

describe("user /me envelope schema", () => {
  test("accepts the nested {user, token} envelope", () => {
    const env = {
      user: { id: 1, username: "u", email: "e@x.org", github_username: "gh", role: "user" },
      token: { prefix: "abc", created_at: "2026-01-01", last_used_at: null },
    };
    const parsed = userMeResponseSchema.parse(env);
    expect(parsed.user.username).toBe("u");
  });

  test("rejects a flat user (the getCurrentUser bug shape)", () => {
    expect(() =>
      userMeResponseSchema.parse({ id: 1, username: "u", email: "e@x.org", role: "user" }),
    ).toThrow();
  });

  test("status is the column's closed vocabulary, not any string", () => {
    // The four values migration 0001's CHECK constraint admits. The reason it
    // is closed on the wire too: `status === "pending"` is what raises the
    // email_verified gap, and a typo or a stray value there is a comparison
    // that silently never matches rather than a compile or parse error.
    const user = {
      id: 1,
      username: null,
      email: "e@x.org",
      github_username: null,
      role: "user",
    };
    for (const status of ["pending", "verified", "approved", "revoked"]) {
      expect(
        userMeResponseSchema.parse({ user: { ...user, status }, token: null }).user.status,
      ).toBe(status);
    }
    // "active" is the DASHBOARD's collapsed value and belongs to /auth/me, not
    // here; mixing the two vocabularies is the confusion the split prevents.
    expect(() =>
      userMeResponseSchema.parse({ user: { ...user, status: "active" }, token: null }),
    ).toThrow();
  });

  test("a profile_gaps entry may carry only its field name", () => {
    // getCurrentUser throws ApiError on ANY mismatch, so a required `set_on`
    // would make one thin entry break every /users/me consumer -- over a key
    // the renderer never reads (resolveWireProfileGaps takes `field` and
    // `blocks`, and falls back to the matrix for a `blocks` it cannot use).
    const parsed = userMeResponseSchema.parse({
      user: {
        id: 1,
        username: null,
        email: "e@x.org",
        github_username: null,
        role: "user",
        profile_gaps: [{ field: "username", blocks: ["upload_access"] }, { field: "city" }],
      },
      token: null,
    });
    expect(parsed.user.profile_gaps?.map((g) => g.field)).toEqual(["username", "city"]);
    expect(parsed.user.profile_gaps?.[1].set_on).toBeUndefined();
  });

  test("a profile_gaps entry still needs its field name", () => {
    // The one key the renderers cannot do without: an entry with no `field` is
    // dropped by resolveWireProfileGaps, so accepting it would carry a line
    // nothing can ever print.
    expect(() =>
      userMeResponseSchema.parse({
        user: {
          id: 1,
          username: null,
          email: "e@x.org",
          github_username: null,
          role: "user",
          profile_gaps: [{ blocks: ["upload_access"] }],
        },
        token: null,
      }),
    ).toThrow();
  });
});

describe("old-CLI compatibility: no schema in the contract is strict", () => {
  /**
   * The property epic #1250 rests on and nothing was watching (#1274).
   *
   * A CLI installed before the epic parses THIS repo's schemas as they were
   * shipped to it, and the backend it talks to is the new one. Every field the
   * epic added -- `service_access`, the tier fields, `profile_gaps`,
   * `username_auto_assigned` -- is an unknown key to that older parse, and
   * `status: "verified"` is a value its `accountStatusSchema` may not have
   * carried at all. Zod's default is to STRIP unknown keys, and every user
   * schema here goes further and declares `.passthrough()`. One `.strict()`
   * anywhere in the contract would turn that forward compatibility into an
   * ApiError on `nemar auth status` for every un-upgraded install.
   *
   * Both halves are pinned: the parse below proves the shapes accept an
   * extended payload, and the source grep proves nobody can quietly make one
   * closed. The grep reads the files as TEXT rather than inspecting the schema
   * objects, because a Zod object gives no public, version-stable answer to
   * "which unknown-key policy is this?" -- and the thing being forbidden is a
   * line of source, which is exactly what a reader can see.
   */
  const CONTRACT_DIR = join(import.meta.dir, "..", "shared", "contract");

  test("a /users/me payload with verified + the new fields + an unknown key parses", () => {
    const parsed = userMeResponseSchema.parse({
      user: {
        id: 1,
        username: "u",
        email: "e@x.org",
        github_username: "gh",
        role: "member",
        // The base tier ADR 0040 introduced. An older CLI has no branch for it
        // and must still get a parsed object rather than a thrown ApiError.
        status: "verified",
        service_access: false,
        email_verified: true,
        orcid_verified: false,
        given_name: "Ada",
        family_name: "Lovelace",
        profile_gaps: [{ field: "city", blocks: ["upload_access"] }],
        username_auto_assigned: true,
        // A field no released CLI has ever heard of.
        some_future_field: { nested: true },
      },
      token: { prefix: "abc", created_at: "2026-01-01", last_used_at: null },
      future_envelope_key: 1,
    });
    expect(parsed.user.status).toBe("verified");
    expect(parsed.user.service_access).toBe(false);
    // `.passthrough()`, not `.strip()`: the unknown key survives the parse, so
    // a client that learns about it later needs no schema change to read it.
    expect((parsed.user as Record<string, unknown>).some_future_field).toEqual({ nested: true });
    expect((parsed as Record<string, unknown>).future_envelope_key).toBe(1);
  });

  test("an /auth/me payload with an unknown key parses through webUserSchema", () => {
    // The dashboard's shape, whose `status` is the collapsed vocabulary --
    // `verified` reaches it as "active" (userStatusForDashboard), which is why
    // this half pins the unknown key rather than the status value.
    const parsed = webUserSchema.parse({
      id: 1,
      email: "e@x.org",
      username: "u",
      role: "member",
      status: "active",
      email_verified: true,
      given_name: null,
      family_name: null,
      orcid: null,
      orcid_verified: false,
      github_username: null,
      city: null,
      country: null,
      affiliation: null,
      service_access: false,
      service_access_granted_at: null,
      upload_access_requested_at: null,
      profile_gaps: [],
      username_auto_assigned: false,
      some_future_field: "kept",
    });
    expect(parsed.status).toBe("active");
    expect((parsed as Record<string, unknown>).some_future_field).toBe("kept");
  });

  /**
   * The compute gateway's documents (epic #2005 phase A1, ADR 0118) are strict ON PURPOSE: a job
   * specification, an owner policy, a launch specification and the launcher's files are validated
   * as they come IN, or written by the Worker itself, and a mistyped key in them must be refused
   * rather than stripped. No released CLI parses them as a response. A schema that a CLI does use
   * to parse a RESPONSE must still never be strict: build that one lenient, in its own file.
   *
   * The two responses the launcher reads (`BundleResponseSchema`, `OutputsResponseSchema`) are in
   * those files but are OPEN (`.passthrough()`): a launcher that runs for 48 hours must survive the
   * Worker adding a key. The next two tests keep that line where it is, by behaviour and by import.
   *
   * `compute-runner.ts` (the runner protocol `nemar.runner.v1`, portable compute) is exempt for the
   * same reason: its five REQUEST schemas are strict, because the Worker validates them as they
   * arrive, and its five responses are open. Its request names are in {@link RUNNER_REQUEST_NAMES},
   * which joins the strict names the import guard looks for, so no other file can build a response
   * from one.
   */
  const STRICT_BY_DESIGN = new Set([
    "compute.ts",
    "compute-launch.ts",
    "compute-observation.ts",
    "compute-runner.ts",
  ]);

  const HEX = "a".repeat(64);
  const JOB = "job_0123456789abcdef01234567";
  const CLOSED = ["strict", "lenient"] as const;
  /**
   * Every schema the two compute files export that is, or holds, an object (an array of them, a
   * union), a valid document for it, and which side of the line it is on. Checked BY BEHAVIOUR below:
   * an unknown key is refused by a strict schema and kept by a lenient one. A new export that is not
   * in this table fails the test, so it is classified on purpose rather than by accident; one that
   * the test cannot read at all (a kind of schema it does not know) fails it too.
   */
  type Classified = {
    side: (typeof CLOSED)[number];
    valid: () => unknown;
    /** Where an unknown key goes, for a schema that is not itself an object (an array, a union). */
    withUnknown?: (doc: unknown) => unknown;
  };
  const CLASSIFIED: Record<string, Classified> = {
    JobSpecSchema: {
      side: "strict",
      valid: () => ({
        name: "x",
        runtime: "python",
        entry: "run.py",
        bundle: { size: 1, sha256: HEX },
        partition: "shared",
        minutes: 5,
      }),
    },
    ComputePolicySchema: {
      side: "strict",
      valid: () => ({ ...computeModule.DEFAULT_COMPUTE_POLICY }),
    },
    ComputeCeilingSchema: {
      side: "strict",
      valid: () => ({ maxNodes: 1, maxCoresPerNode: 1, maxGpusPerNode: 0, maxMinutes: 1 }),
    },
    ComputeClientCapsSchema: {
      side: "strict",
      valid: () => ({ maxOpenReservations: 1, maxReservedMilliPerDay: 1 }),
    },
    ComputeTenantPolicySchema: {
      side: "strict",
      valid: () => ({ maxLiveJobs: 20, reserved: { people: 8, pipelines: 2, partner: 0 } }),
    },
    ResultManifestSchema: { side: "strict", valid: () => ({ job_id: JOB, files: [] }) },
    LauncherResultSchema: {
      side: "strict",
      valid: () => ({
        job_id: JOB,
        failure_code: null,
        detail: null,
        exit_number: 0,
        entry_exit_code: 0,
      }),
    },
    LauncherProvenanceSchema: {
      side: "strict",
      valid: () => ({
        job_id: JOB,
        launch_spec_digest: HEX,
        bundle_digest: null,
        image: { uri: "docker://ghcr.io/example/runtime", digest: `sha256:${HEX}` },
        runtime_version: "3.12",
        staging: [],
        timings: {},
        slurm_job_id: null,
        entry_exit_code: null,
      }),
    },
    LaunchSpecSchema: {
      side: "strict",
      valid: () => ({
        job_id: JOB,
        runtime: "python",
        entry: "run.py",
        args: [],
        bundle: { sha256: HEX, size: 1 },
        datasets: [],
        api_base: "https://api.example.test",
        image: {
          uri: `docker://ghcr.io/example/runtime@sha256:${HEX}`,
          digest: `sha256:${HEX}`,
          sif: `${HEX}.sif`,
        },
        env: {},
        resources: { gpus: 0 },
        limits: { max_files: 1, max_total_bytes: 1 },
        job_token: "t".repeat(32),
      }),
    },
    OutputsRequestSchema: {
      side: "strict",
      valid: () => ({
        outputs: [],
        launcher: ["result.json", "provenance.json", "manifest.json", "launcher.log"].map(
          (name) => ({
            name,
            size: 1,
          }),
        ),
      }),
    },
    BundleResponseSchema: {
      side: "lenient",
      valid: () => ({ url: "https://r2.example.test/b", expires_at: "2026-11-03T12:00:00Z" }),
    },
    OutputsResponseSchema: {
      side: "lenient",
      valid: () => ({
        uploads: [{ path: "outputs/a", url: "https://r2.example.test/o" }],
        expires_at: "2026-11-03T13:00:00Z",
      }),
    },
  };

  type ZodDef = { typeName?: string } & Record<string, unknown>;
  const defOf = (schema: z.ZodTypeAny): ZodDef => schema._def as ZodDef;

  /** A zod schema, seen through the effects (a `superRefine`, a `refine`) around it. */
  function withoutEffects(schema: z.ZodTypeAny): z.ZodTypeAny {
    let current = schema;
    while (defOf(current).typeName === "ZodEffects")
      current = defOf(current).schema as z.ZodTypeAny;
    return current;
  }

  /** The kinds of zod schema that hold no other schema. */
  const LEAF_KINDS = new Set([
    "ZodString",
    "ZodNumber",
    "ZodBigInt",
    "ZodBoolean",
    "ZodDate",
    "ZodNaN",
    "ZodLiteral",
    "ZodEnum",
    "ZodNativeEnum",
    "ZodNull",
    "ZodUndefined",
    "ZodVoid",
    "ZodAny",
    "ZodUnknown",
    "ZodNever",
    "ZodSymbol",
  ]);

  /**
   * The schemas one level inside `schema`: what an array holds, what a union offers, what a wrapper
   * wraps. A KIND this table does not know throws, so a new way of building a schema is never
   * skipped by accident: the test fails until the table learns it.
   */
  function innerSchemas(schema: z.ZodTypeAny): z.ZodTypeAny[] {
    const def = defOf(schema);
    const at = (key: string) => def[key] as z.ZodTypeAny;
    const kind = String(def.typeName);
    if (LEAF_KINDS.has(kind)) return [];
    switch (kind) {
      case "ZodArray":
      case "ZodPromise":
      case "ZodBranded":
        return [at("type")];
      case "ZodSet":
        return [at("valueType")];
      case "ZodMap":
      case "ZodRecord":
        return [at("keyType"), at("valueType")];
      case "ZodTuple":
        return [...(def.items as z.ZodTypeAny[]), ...(def.rest ? [at("rest")] : [])];
      case "ZodUnion":
      case "ZodDiscriminatedUnion":
        return [...(def.options as Iterable<z.ZodTypeAny>)];
      case "ZodIntersection":
        return [at("left"), at("right")];
      case "ZodOptional":
      case "ZodNullable":
      case "ZodDefault":
      case "ZodCatch":
      case "ZodReadonly":
        return [at("innerType")];
      case "ZodEffects":
        return [at("schema")];
      case "ZodLazy":
        return [(def.getter as () => z.ZodTypeAny)()];
      case "ZodPipeline":
        return [at("in"), at("out")];
      default:
        throw new Error(`cannot classify a ${kind}: teach innerSchemas about it`);
    }
  }

  /** Whether an object schema is `schema` or anywhere inside it: an array's element, a union's member. */
  function containsObject(schema: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): boolean {
    if (seen.has(schema)) return false;
    seen.add(schema);
    if (defOf(schema).typeName === "ZodObject") return true;
    return innerSchemas(schema).some((inner) => containsObject(inner, seen));
  }

  const addUnknownKey = (doc: unknown) => ({ ...(doc as object), zz_unknown_key: 1 });

  /**
   * Which side of the line a schema is on, BY BEHAVIOUR: its valid document must parse, and the same
   * document with an unknown key is refused by a strict schema and kept by a lenient one. Where the
   * key goes is the top level of the document unless `withUnknown` says otherwise, which a schema
   * that is not itself an object (an array of them, a union) must: a key added to an array proves
   * nothing about its elements.
   */
  function sideOf(
    schema: z.ZodTypeAny,
    valid: () => unknown,
    withUnknown?: (doc: unknown) => unknown,
  ): "strict" | "lenient" | "invalid" {
    if (!schema.safeParse(valid()).success) return "invalid";
    return schema.safeParse((withUnknown ?? addUnknownKey)(valid())).success ? "lenient" : "strict";
  }

  /** Every zod schema the two compute files export that is, or holds, an object schema. */
  const exportedObjectSchemas = (...modules: object[]) =>
    Object.entries(Object.assign({}, ...modules)).filter(
      (entry): entry is [string, z.ZodTypeAny] =>
        entry[1] instanceof z.ZodType && containsObject(entry[1]),
    );

  /** What is wrong with how `schema` is classified as `entry`, or null if nothing is. */
  function classificationProblem(schema: z.ZodTypeAny, entry: Classified): string | null {
    if (defOf(withoutEffects(schema)).typeName !== "ZodObject" && entry.withUnknown === undefined) {
      return "is not an object itself: say where its unknown key goes";
    }
    const side = sideOf(schema, entry.valid, entry.withUnknown);
    return side === entry.side ? null : `is ${side}, classified ${entry.side}`;
  }

  test("every schema the compute files export that holds an object is classified, and behaves as classified", () => {
    const exported = exportedObjectSchemas(computeModule, launchModule);
    // Guards the guard: the walk found the schemas, not nothing.
    expect(exported.length).toBeGreaterThanOrEqual(11);
    expect(exported.map(([name]) => name).sort()).toEqual(Object.keys(CLASSIFIED).sort());
    for (const [name, schema] of exported) {
      expect(classificationProblem(schema, CLASSIFIED[name]), name).toBeNull();
    }
  });

  describe("the classifier itself, on schemas built here", () => {
    const strictObject = z.object({ a: z.string() }).strict();
    const openObject = z.object({ a: z.string() }).passthrough();
    const element = (doc: unknown) => [addUnknownKey((doc as unknown[])[0])];

    test("it finds an object schema however the export wraps it", () => {
      const holds: Array<[string, z.ZodTypeAny]> = [
        ["an object", strictObject],
        ["an object behind effects", strictObject.superRefine(() => {})],
        ["an array of objects", z.array(strictObject)],
        ["an array of an array of objects", z.array(z.array(strictObject))],
        ["a union of objects", z.union([strictObject, openObject])],
        ["a union of an object and a string", z.union([z.string(), openObject])],
        [
          "a discriminated union of objects",
          z.discriminatedUnion("k", [
            z.object({ k: z.literal("a") }).strict(),
            z.object({ k: z.literal("b") }).strict(),
          ]),
        ],
        ["an optional object", strictObject.optional()],
        ["a nullable object", strictObject.nullable()],
        ["an object with a default", strictObject.default({ a: "x" })],
        ["a record of objects", z.record(z.string(), strictObject)],
        ["a tuple holding an object", z.tuple([z.string(), strictObject])],
        ["a tuple whose rest is an object", z.tuple([z.string()]).rest(strictObject)],
        ["an intersection ending in an object", z.intersection(z.record(z.string()), strictObject)],
        [
          "an intersection starting with an object",
          z.intersection(strictObject, z.record(z.string())),
        ],
        ["a map keyed by objects", z.map(strictObject, z.string())],
        ["a pipe from an object", strictObject.pipe(z.unknown())],
        ["a lazy object", z.lazy(() => strictObject)],
        ["a set of objects", z.set(strictObject)],
        ["a map of objects", z.map(z.string(), strictObject)],
        ["a branded object", strictObject.brand("b")],
        ["an object with a catch", strictObject.catch({ a: "x" })],
        ["a readonly object", strictObject.readonly()],
        ["a promise of an object", z.promise(strictObject)],
        [
          "a piped object",
          z.string().pipe(
            z
              .string()
              .transform(() => ({}))
              .pipe(strictObject),
          ),
        ],
        ["an object holding an array of objects", z.object({ list: z.array(strictObject) })],
      ];
      for (const [label, schema] of holds) expect(containsObject(schema), label).toBe(true);
    });

    test("it does not take a schema with no object in it for one", () => {
      const holds: Array<[string, z.ZodTypeAny]> = [
        ["a string", z.string()],
        ["an enum", z.enum(["a", "b"])],
        ["an array of strings", z.array(z.string())],
        ["a record of strings", z.record(z.enum(["a"]), z.string().max(3))],
        ["a union of strings and numbers", z.union([z.string(), z.number()])],
        ["a tuple of scalars", z.tuple([z.string(), z.number()])],
        ["a refined string", z.string().refine(() => true)],
        ["a nullable number", z.number().nullable()],
        ["a literal", z.literal("x")],
        ["a number", z.number()],
        ["a bigint", z.bigint()],
        ["a boolean", z.boolean()],
        ["a date", z.date()],
        ["a NaN", z.nan()],
        ["a native enum", z.nativeEnum({ A: "a" } as const)],
        ["a null", z.null()],
        ["an undefined", z.undefined()],
        ["a void", z.void()],
        ["any", z.any()],
        ["unknown", z.unknown()],
        ["never", z.never()],
        ["a symbol", z.symbol()],
        ["a set of strings", z.set(z.string())],
        ["a map of strings", z.map(z.string(), z.number())],
        ["a promise of a string", z.promise(z.string())],
        ["a readonly array", z.array(z.string()).readonly()],
        ["a catch", z.string().catch("x")],
        ["a branded string", z.string().brand("b")],
        ["an intersection of strings", z.intersection(z.string(), z.string().max(3))],
        ["a pipe of strings", z.string().pipe(z.string())],
        ["a lazy string", z.lazy(() => z.string())],
        ["a union of literals", z.union([z.literal("a"), z.literal("b")])],
      ];
      for (const [label, schema] of holds) expect(containsObject(schema), label).toBe(false);
    });

    test("it stops on a schema that refers to itself", () => {
      type Node = { next?: Node };
      const node: z.ZodType<Node> = z.lazy(() => z.object({ next: node.optional() }));
      expect(containsObject(node)).toBe(true);
      const loop: z.ZodTypeAny = z.lazy(() => z.array(loop));
      expect(containsObject(loop)).toBe(false);
    });

    test("a kind it does not know fails the test instead of being skipped", () => {
      class Mystery extends z.ZodType {
        _parse(): never {
          throw new Error("never parsed");
        }
      }
      const mystery = new Mystery({ typeName: "ZodMystery" } as never);
      expect(() => containsObject(mystery)).toThrow(/cannot classify a ZodMystery/);
      expect(() => containsObject(z.array(mystery))).toThrow(/cannot classify a ZodMystery/);
      expect(() => containsObject(z.union([mystery, strictObject]))).toThrow(/ZodMystery/);
    });

    test("an export that is not an object itself must say where its unknown key goes", () => {
      const list: Classified = { side: "strict", valid: () => [{ a: "x" }] };
      expect(classificationProblem(z.array(strictObject), list)).toMatch(
        /where its unknown key goes/,
      );
      expect(
        classificationProblem(z.array(strictObject), { ...list, withUnknown: element }),
      ).toBeNull();
      // Said, and wrong: the array is strict, not lenient.
      expect(
        classificationProblem(z.array(strictObject), {
          ...list,
          side: "lenient",
          withUnknown: element,
        }),
      ).toBe("is strict, classified lenient");
      expect(classificationProblem(z.array(openObject), { ...list, withUnknown: element })).toBe(
        "is lenient, classified strict",
      );
      // An object behind effects needs no such word, and a document that does not parse is a problem.
      const object: Classified = { side: "strict", valid: () => ({ a: "x" }) };
      expect(
        classificationProblem(
          strictObject.superRefine(() => {}),
          object,
        ),
      ).toBeNull();
      expect(classificationProblem(strictObject, { ...object, valid: () => ({ a: 1 }) })).toBe(
        "is invalid, classified strict",
      );
    });

    test("sideOf reads the behaviour, at the top or where the key is told to go", () => {
      const doc = () => ({ a: "x" });
      expect(sideOf(strictObject, doc)).toBe("strict");
      expect(sideOf(openObject, doc)).toBe("lenient");
      expect(sideOf(z.object({ a: z.string() }), doc)).toBe("lenient");
      expect(
        sideOf(
          strictObject.superRefine(() => {}),
          doc,
        ),
      ).toBe("strict");
      expect(sideOf(strictObject, () => ({ a: 1 }))).toBe("invalid");
      // An array of objects: a key at the top says nothing, a key on the element does.
      const list = () => [{ a: "x" }];
      expect(sideOf(z.array(strictObject), list, element)).toBe("strict");
      expect(sideOf(z.array(openObject), list, element)).toBe("lenient");
      const union = z.union([strictObject, z.object({ b: z.number() }).strict()]);
      expect(sideOf(union, doc)).toBe("strict");
      expect(sideOf(z.union([openObject, z.string()]), doc)).toBe("lenient");
    });
  });

  test("the open responses are open all the way down, and the closed requests closed all the way down", () => {
    const upload = { path: "outputs/a", url: "https://r2.example.test/o", extra: 1 };
    expect(
      launchModule.OutputsResponseSchema.safeParse({
        uploads: [upload],
        expires_at: "2026-11-03T13:00:00Z",
      }).success,
    ).toBe(true);
    const request = CLASSIFIED.OutputsRequestSchema.valid() as {
      outputs: unknown[];
      launcher: object[];
    };
    expect(
      launchModule.OutputsRequestSchema.safeParse({
        ...request,
        outputs: [{ path: "a", size: 1, sha256: HEX, extra: 1 }],
      }).success,
    ).toBe(false);
    expect(
      launchModule.OutputsRequestSchema.safeParse({
        ...request,
        launcher: request.launcher.map((f) => ({ ...f, extra: 1 })),
      }).success,
    ).toBe(false);
  });

  /** The five strict request schemas of `compute-runner.ts`, which are not in CLASSIFIED. */
  const RUNNER_REQUEST_NAMES = [
    "RunnerRegisterRequestSchema",
    "RunnerTokenRequestSchema",
    "RunnerClaimRequestSchema",
    "RunnerHeartbeatRequestSchema",
    "RunnerCompleteRequestSchema",
  ];

  /** The names a response schema must never be built from. */
  const STRICT_NAMES = [
    ...Object.entries(CLASSIFIED)
      .filter(([, c]) => c.side === "strict")
      .map(([name]) => name),
    ...RUNNER_REQUEST_NAMES,
  ];

  /**
   * What a file under shared/contract takes from the strict compute schemas, by any route. Pure:
   * it reads source text and a path, never the disk, so each shape it must catch has a probe below.
   *
   * A specifier is resolved against the importing file and judged by the file it names, never by
   * how it is spelled: `./compute`, `./compute.js`, `./compute.ts` and `../contract/compute.js` are
   * one file. Three things are offences, from the strict files AND from `index` (which re-exports
   * them): a namespace (`import * as`, `export *`), any strict name (`{ A }`, `{ A as B }`,
   * `default, { A }`, a type-only one too, since the rule is by name), and a dynamic `import()` or
   * `require()`, which takes the whole module; a dynamic one whose specifier is not a plain string
   * cannot be resolved and is an offence too. The one exemption is index.ts's own `export *`.
   * A comment that quotes an import is read as one: reword it.
   */
  function strictComputeTakes(
    contractDir: string,
    file: string,
    text: string,
    strictNames: readonly string[],
  ): string[] {
    const strictFiles = [...STRICT_BY_DESIGN].map((name) =>
      join(contractDir, name.replace(/\.ts$/, "")),
    );
    const indexFile = join(contractDir, "index");
    const target = (specifier: string): "strict" | "index" | null => {
      if (!specifier.startsWith(".")) return null; // a package: nothing in it is ours
      const resolved = resolve(dirname(join(contractDir, file)), specifier).replace(
        /\.(?:js|ts)$/,
        "",
      );
      if (strictFiles.includes(resolved)) return "strict";
      if (resolved === indexFile || resolved === contractDir) return "index";
      return null;
    };
    const offenders: string[] = [];
    const statement = /\b(import|export)\s+([\w$\s,{}*]+?)\s*from\s*(["'])([^"']+)\3/g;
    for (const [, keyword, clause, , specifier] of text.matchAll(statement)) {
      const where = target(specifier);
      if (where === null) continue;
      const ownReexport = file === "index.ts" && where === "strict" && clause.trim() === "*";
      if (ownReexport) continue;
      const names: string[] = clause.match(/[\w$]+/g) ?? [];
      if (clause.includes("*") || strictNames.some((name) => names.includes(name))) {
        offenders.push(`${keyword} ${clause.trim()} from "${specifier}"`);
      }
    }
    for (const call of text.matchAll(/(?<![\w$.])(import|require)\s*\(\s*([^)]*)/g)) {
      const [, keyword, argument] = call;
      const literal = /^(["'`])([^"'`$\n]*)\1(?:\s*,[\s\S]*)?$/.exec(argument.trim());
      if (literal === null) {
        offenders.push(`${keyword}(${argument.trim()}): a specifier the guard cannot resolve`);
      } else if (target(literal[2]) !== null) {
        offenders.push(`${keyword}("${literal[2]}")`);
      }
    }
    return offenders;
  }

  /** One probe per shape: a file, its text, and whether the guard must report it. */
  const IMPORT_PROBES: Array<[label: string, file: string, text: string, offends: boolean]> = [
    // The named import the old guard already caught, and its spellings.
    ["a named import", "x.ts", `import { JobSpecSchema } from "./compute.js";`, true],
    ["a specifier in single quotes", "x.ts", `import { JobSpecSchema } from './compute.js';`, true],
    ["a specifier with no extension", "x.ts", `import { JobSpecSchema } from "./compute";`, true],
    [
      "a specifier with a .ts extension",
      "x.ts",
      `import { JobSpecSchema } from "./compute.ts";`,
      true,
    ],
    [
      "the launch file with a .ts extension",
      "x.ts",
      `import { LaunchSpecSchema } from "./compute-launch.ts";`,
      true,
    ],
    [
      "an alias",
      "x.ts",
      `import { OutputsRequestSchema as Req } from "./compute-launch.js";`,
      true,
    ],
    [
      "a name among others on several lines",
      "x.ts",
      `import {\n  computePathSchema,\n  JobSpecSchema,\n} from "./compute.js";`,
      true,
    ],
    [
      "a type-only import of a strict name",
      "x.ts",
      `import type { JobSpecSchema } from "./compute.js";`,
      true,
    ],
    [
      "an inline type modifier beside a strict name",
      "x.ts",
      `import { type JobSpec, LaunchSpecSchema } from "./compute-launch.js";`,
      true,
    ],
    [
      "a path through the parent directory",
      "x.ts",
      `import { JobSpecSchema } from "../contract/compute.js";`,
      true,
    ],
    [
      "a file in a subdirectory",
      "neuroschema/x.ts",
      `import { JobSpecSchema } from "../compute.js";`,
      true,
    ],
    // Namespaces, and a default beside either.
    ["a namespace import", "x.ts", `import * as compute from "./compute.js";`, true],
    ["a namespace re-export", "x.ts", `export * from "./compute.js";`, true],
    [
      "a named namespace re-export in index.ts",
      "index.ts",
      `export * as compute from "./compute.js";`,
      true,
    ],
    [
      "a named re-export in index.ts",
      "index.ts",
      `export { JobSpecSchema } from "./compute.js";`,
      true,
    ],
    [
      "a default and a strict name",
      "x.ts",
      `import compute, { JobSpecSchema } from "./compute.js";`,
      true,
    ],
    [
      "a default and an aliased strict name",
      "x.ts",
      `import compute, { JobSpecSchema as J } from "./compute.ts";`,
      true,
    ],
    ["a default and a namespace", "x.ts", `import compute, * as all from "./compute.js";`, true],
    // Through index, which re-exports the strict files.
    [
      "a strict name through ./index.js",
      "x.ts",
      `import { JobSpecSchema } from "./index.js";`,
      true,
    ],
    ["a strict name through ./index", "x.ts", `import { JobSpecSchema } from "./index";`, true],
    [
      "a strict name through ./index.ts",
      "x.ts",
      `import { JobSpecSchema } from "./index.ts";`,
      true,
    ],
    [
      "a strict name through the directory, ./",
      "x.ts",
      `import { JobSpecSchema } from "./";`,
      true,
    ],
    ["a strict name through the directory, .", "x.ts", `import { JobSpecSchema } from ".";`, true],
    [
      "a strict name through ../index.js",
      "neuroschema/x.ts",
      `import { JobSpecSchema } from "../index.js";`,
      true,
    ],
    ["a strict name through ..", "neuroschema/x.ts", `import { JobSpecSchema } from "..";`, true],
    [
      "a strict name re-exported through index",
      "x.ts",
      `export { LaunchSpecSchema } from "./index.js";`,
      true,
    ],
    ["a namespace import of index", "x.ts", `import * as all from "./index.js";`, true],
    ["a namespace re-export of index", "x.ts", `export * from "./index.js";`, true],
    [
      "a default and a strict name through index",
      "x.ts",
      `import all, { OutputsRequestSchema } from "./index.js";`,
      true,
    ],
    // Dynamic.
    ["a dynamic import", "x.ts", `const m = await import("./compute.js");`, true],
    [
      "a dynamic import with single quotes and .ts",
      "x.ts",
      `await import('./compute-launch.ts');`,
      true,
    ],
    ["a dynamic import of a template literal", "x.ts", "await import(`./compute.js`);", true],
    [
      "a dynamic import with an options argument",
      "x.ts",
      `await import("./compute.js", { with: {} });`,
      true,
    ],
    [
      "a dynamic import of index",
      "x.ts",
      `const { JobSpecSchema } = await import("./index.js");`,
      true,
    ],
    ["a require", "x.ts", `const m = require("./compute");`, true],
    ["a require with .ts", "x.ts", `const m = require('./compute-launch.ts');`, true],
    ["a require of index", "x.ts", `const m = require("./index");`, true],
    [
      "a concatenation that starts with another file",
      "x.ts",
      `await import("./other.js" + suffix);`,
      true,
    ],
    ["a dynamic import of a variable", "x.ts", "const m = await import(name);", true],
    ["a require of a variable", "x.ts", "const m = require(path);", true],
    [
      "a dynamic import built from a template",
      "x.ts",
      "await import(`./compute${suffix}.js`);",
      true,
    ],
    ["a dynamic import built by concatenation", "x.ts", `await import("./compute" + ".js");`, true],
    [
      "a forbidden one after allowed ones",
      "x.ts",
      `import { z } from "zod";\nimport type { JobSpec } from "./compute.js";\nawait import("./other.js");\nawait import("./compute.js");`,
      true,
    ],
    [
      "index.ts export * from a file in a subdirectory called index.ts",
      "neuroschema/index.ts",
      `export * from "../compute.js";`,
      true,
    ],
    // What stays allowed.
    ["a namespace import in index.ts", "index.ts", `import * as c from "./compute.js";`, true],
    ["index.ts re-exporting index", "index.ts", `export * from "./index.js";`, true],
    [
      "index.ts re-exports the compute file whole",
      "index.ts",
      `export * from "./compute.js";`,
      false,
    ],
    [
      "a type that is not a strict name",
      "x.ts",
      `import type { JobSpec } from "./compute.js";`,
      false,
    ],
    [
      "a plain helper",
      "x.ts",
      `import { COMPUTE_PATH_RE, computePathSchema } from "./compute.js";`,
      false,
    ],
    [
      "launch helpers and types",
      "x.ts",
      `import type { LaunchSpec } from "./compute-launch.js";\nimport { LAUNCH_SPEC_MAX_BYTES, encodeLaunchSpec } from "./compute-launch.js";`,
      false,
    ],
    [
      "a lenient name through index",
      "x.ts",
      `import { catalogItemSchema } from "./index.js";`,
      false,
    ],
    ["a type through index", "x.ts", `import type { JobSpec } from "./index.js";`, false],
    ["a package", "x.ts", `import { z } from "zod";`, false],
    [
      "a package that is named like the file",
      "x.ts",
      `import { JobSpecSchema } from "compute";`,
      false,
    ],
    [
      "a dynamic import of another file with options",
      "x.ts",
      `await import("./other.js", { with: { type: "json" } });`,
      false,
    ],
    [
      "a sibling that only starts like it",
      "x.ts",
      `import { a } from "./compute-state.js";`,
      false,
    ],
    ["another sibling", "x.ts", `import { a } from "./computed.js";`, false],
    [
      "the shared compute words",
      "x.ts",
      `import { COMPUTE_WORD_RE } from "../compute-state.js";`,
      false,
    ],
    ["a default import of something else", "x.ts", `import other from "./other.js";`, false],
    [
      "a name that only contains a strict name",
      "x.ts",
      `import { JobSpecSchemaNote } from "./other.js";`,
      false,
    ],
    [
      "a name that only contains a strict name, from the compute file",
      "x.ts",
      `import { JobSpecSchemaNote } from "./compute.js";`,
      false,
    ],
    ["a template literal of another file", "x.ts", "await import(`./other.js`);", false],
    ["a strict name that is not imported", "x.ts", `const name = "JobSpecSchema";`, false],
    ["a dynamic import of another file", "x.ts", `await import("./other.js");`, false],
    ["a dynamic import of a package", "x.ts", `await import("zod");`, false],
    ["a require of a package", "x.ts", `const z = require("zod");`, false],
    ["a method named require", "x.ts", "loader.require(name);", false],
    [
      "a runner request schema",
      "x.ts",
      `import { RunnerClaimRequestSchema } from "./compute-runner.js";`,
      true,
    ],
    [
      "a runner request schema, renamed",
      "x.ts",
      `import { RunnerCompleteRequestSchema as C } from "./compute-runner";`,
      true,
    ],
    [
      "a runner request schema through the index",
      "x.ts",
      `import { RunnerRegisterRequestSchema } from "./index.js";`,
      true,
    ],
    [
      "a runner response schema",
      "x.ts",
      `import { RunnerClaimResponseSchema } from "./compute-runner.js";`,
      false,
    ],
    ["a function whose name ends in import", "x.ts", "reimport(name);", false],
  ];

  test("the import guard flags every shape of taking a strict compute schema, and only those", () => {
    expect(STRICT_NAMES).toHaveLength(15);
    expect(IMPORT_PROBES.length).toBeGreaterThan(55);
    for (const [label, file, text, offends] of IMPORT_PROBES) {
      const found = strictComputeTakes(CONTRACT_DIR, file, text, STRICT_NAMES);
      expect(found.length > 0, `${label}: ${JSON.stringify(found)}`).toBe(offends);
    }
  });

  test("the five runner request names are strict schemas, and no runner response is", () => {
    const exported = runnerModule as unknown as Record<string, z.ZodTypeAny>;
    const lease = "0".repeat(32);
    const valid_: Record<string, Record<string, unknown>> = {
      RunnerRegisterRequestSchema: {
        name: "a",
        pool: "cpu",
        cores: 1,
        memory_mb: 1,
        gpus: 0,
        scratch_gb: 1,
        backend: "local",
        runtimes: ["docker"],
        arch: "amd64",
        accounting: "none",
        site: "a",
        trust: "lab",
      },
      RunnerTokenRequestSchema: { protocol: "nemar.runner.v1", runner_version: "0.1.0" },
      RunnerClaimRequestSchema: {
        protocol: "nemar.runner.v1",
        free_slots: 1,
        runtimes: ["docker"],
        arch: "amd64",
        runner_version: "0.1.0",
      },
      RunnerHeartbeatRequestSchema: { job_id: JOB, lease_id: lease, phase: "started" },
      RunnerCompleteRequestSchema: {
        job_id: JOB,
        lease_id: lease,
        exit_number: 0,
        launcher_failure_code: null,
        launcher_detail: null,
        usage: { wall_seconds: 0, cpu_seconds: 0, max_rss_mb: 0 },
        usage_partial: false,
        scratch_discarded: false,
      },
    };
    for (const name of RUNNER_REQUEST_NAMES) {
      const valid = valid_[name];
      expect(exported[name]?.safeParse(valid).success, `${name}: valid`).toBe(true);
      expect(exported[name]?.safeParse({ ...valid, extra: 1 }).success, name).toBe(false);
    }
    for (const name of Object.keys(exported).filter((n) => /^Runner.*Response.*Schema$/.test(n))) {
      expect(STRICT_NAMES, name).not.toContain(name);
    }
  });

  test("no other file under shared/contract takes a strict compute schema", () => {
    const files = readdirSync(CONTRACT_DIR, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !STRICT_BY_DESIGN.has(name))
      .map((name) => ({ name, text: readFileSync(join(CONTRACT_DIR, name), "utf8") }));
    // Guards the guard: a mistyped directory would scan nothing and pass, and index.ts must be in it.
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((f) => f.name)).toContain("index.ts");
    const offenders = files.flatMap(({ name, text }) =>
      strictComputeTakes(CONTRACT_DIR, name, text, STRICT_NAMES).map((o) => `${name}: ${o}`),
    );
    expect(offenders, "Build a response schema in its own file, from nothing strict.").toEqual([]);
  });

  test("no schema file under shared/contract calls .strict(), but the compute documents", () => {
    const files = readdirSync(CONTRACT_DIR, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !STRICT_BY_DESIGN.has(name))
      .map((name) => join(CONTRACT_DIR, name));
    // Guards the exemption: a rename must not leave a silent hole, and each exempt file must
    // really be one that needs it.
    for (const name of STRICT_BY_DESIGN) {
      const path = join(CONTRACT_DIR, name);
      expect(existsSync(path), name).toBe(true);
      expect(readFileSync(path, "utf8").includes(".strict("), name).toBe(true);
    }
    // Guards the guard: a mistyped directory would scan nothing and pass.
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes(".strict("));
    expect(offenders, "A strict schema breaks every un-upgraded CLI.").toEqual([]);
  });
});

describe("neuroschema dataset schema", () => {
  test("pins the v0.4.1 envelope + required identity fields", () => {
    expect(NEUROSCHEMA_VERSION).toBe("0.4.1");
    const ds = {
      schema_version: "0.4.1",
      doc_type: "dataset",
      dataset_id: "nm000108",
      name: "Test",
      source: "nemar",
      recording_modality: ["EEG"],
    };
    expect(() => neuroschemaDatasetSchema.parse(ds)).not.toThrow();
  });

  test("rejects a wrong schema_version or empty modality", () => {
    const base = {
      schema_version: "0.4.1",
      doc_type: "dataset",
      dataset_id: "nm000108",
      name: "T",
      source: "nemar",
      recording_modality: ["EEG"],
    };
    expect(() => neuroschemaDatasetSchema.parse({ ...base, schema_version: "0.2.0" })).toThrow();
    // The previous release: the literal moved with the vendored bundle.
    expect(() => neuroschemaDatasetSchema.parse({ ...base, schema_version: "0.4.0" })).toThrow();
    expect(() => neuroschemaDatasetSchema.parse({ ...base, recording_modality: [] })).toThrow();
  });
});

// Epic #1586 Phase 2 (#1588): the BIDS index's per-session datatype pairing.
// The schemas end in `.passthrough()`, so "parse an object and read the value
// back" would pass with the declaration deleted; every assertion here is on
// the DECLARED shape (`.shape` keys) or on a rejection.
describe("bids_index wire contract: session_modalities (#1588)", () => {
  const subject = {
    sessions: ["01", "02"],
    modalities: { anat: { tasks: {} }, eeg: { tasks: { rest: { runs: ["1"] } } } },
    session_modalities: { "01": ["anat"], "02": ["eeg"] },
  };

  test("declares exactly the keys a consumer is promised", () => {
    expect(Object.keys(bidsIndexSubjectSchema.shape)).toEqual([
      "sessions",
      "modalities",
      "session_modalities",
    ]);
    expect(Object.keys(bidsIndexSchema.shape)).toEqual(["version", "subjects"]);
  });

  test("the no-session key is the declared literal and can never be a session label", () => {
    expect(NO_SESSION_KEY).toBe("no-session");
    // Session labels are alphanumeric; this contains a hyphen.
    expect(NO_SESSION_KEY).not.toMatch(/^[A-Za-z0-9]+$/);
  });

  test("accepts a subject that has it, including the no-session bucket and an empty session", () => {
    const withBucket = {
      ...subject,
      session_modalities: { ...subject.session_modalities, [NO_SESSION_KEY]: ["beh"], "03": [] },
    };
    expect(bidsIndexSubjectSchema.parse(withBucket).session_modalities).toEqual(
      withBucket.session_modalities,
    );
    expect(bidsIndexSubjectSchema.parse({ ...subject, session_modalities: {} })).toBeDefined();
  });

  // Not decoration: a data plane that predates the field, and a response
  // cached for up to a minute before it deployed, both omit it. Making it
  // required here would turn a rolling deploy into a contract failure.
  test("accepts a subject without it, which is how an older data plane serves it", () => {
    const { session_modalities, ...older } = subject;
    void session_modalities;
    expect(bidsIndexSubjectSchema.safeParse(older).success).toBe(true);
    expect(
      bidsIndexSchema.safeParse({ version: "v1.0.0", subjects: { "sub-01": older } }).success,
    ).toBe(true);
  });

  test("rejects a value that is not a list of datatype names per session", () => {
    expect(
      bidsIndexSubjectSchema.safeParse({ ...subject, session_modalities: { "01": "eeg" } }).success,
    ).toBe(false);
    expect(
      bidsIndexSubjectSchema.safeParse({ ...subject, session_modalities: { "01": [1] } }).success,
    ).toBe(false);
    expect(
      bidsIndexSubjectSchema.safeParse({ ...subject, session_modalities: ["eeg"] }).success,
    ).toBe(false);
    // Absent or an object: null is neither, and would read as "unknown" to one
    // consumer and "none" to another.
    expect(bidsIndexSubjectSchema.safeParse({ ...subject, session_modalities: null }).success).toBe(
      false,
    );
  });

  test("the whole index parses, and is null-able the way the wire sends it", () => {
    const index = { version: "v1.0.0", subjects: { "sub-01": subject } };
    expect(bidsIndexSchema.safeParse(index).success).toBe(true);
    expect(bidsIndexSchema.nullable().safeParse(null).success).toBe(true);
    expect(bidsIndexSchema.safeParse({ subjects: index.subjects }).success).toBe(false);
  });
});
