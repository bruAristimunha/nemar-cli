/**
 * Unit tests for the service-access upload gate (website ADR 0010, #1013;
 * ADR 0040 phase 2 for the channel). Pure decision logic shared by every
 * real-upload entry point (POST /datasets, /:id/upload-urls,
 * /:id/upload-credentials).
 *
 * The create-time matrix is exhaustive on purpose: channel x service_access x
 * sandbox_completed is eight cases, and exactly one of them differs between
 * the two channels. A spot-check would not distinguish "the web channel skips
 * sandbox training" from "the gate stopped checking sandbox training".
 *
 * These are a supplement, not the coverage (`.rules/testing.md`): a pure
 * function cannot catch the caller deriving `channel` from the wrong thing.
 * The route-level half — that the channel comes from the credential and not
 * from anything the client sends — is in upload-channel-route.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  EXPLICIT_ID_ADMIN_ERROR,
  EXPLICIT_ID_NOT_DEV_OWNED_ERROR,
  EXPLICIT_ID_NOT_RESERVED_ERROR,
  EXPLICIT_ID_PRODUCTION_ERROR,
  SANDBOX_TRAINING_ERROR,
  SERVICE_ACCESS_ERROR,
  TEST_ACCOUNT_SANDBOX_ONLY_ERROR,
  type UploadChannel,
  type UploadGateBody,
  explicitDatasetIdGate,
  realDatasetCreateGate,
  realDatasetServiceGate,
  uploadChannelForAuthMethod,
} from "../src/services/upload-gate";

interface Case {
  channel: UploadChannel;
  service_access: 0 | 1;
  sandbox_completed: 0 | 1;
  expected: UploadGateBody | null;
  why: string;
}

/** `person` throughout this matrix: the kind check is a separate dimension,
 *  covered exhaustively of its own accord below (epic #1272 phase 4, #1284;
 *  ADR 0048), and mixing it into this matrix would double the case count for
 *  a dimension that does not interact with channel/service_access/sandbox at
 *  all -- it is checked FIRST and short-circuits everything else. */
const PERSON = "person" as const;

const CASES: Case[] = [
  // The authorization gate comes first on both channels, and nothing about
  // the channel can substitute for it.
  {
    channel: "cli",
    service_access: 0,
    sandbox_completed: 0,
    expected: SERVICE_ACCESS_ERROR,
    why: "no grant, no training",
  },
  {
    channel: "cli",
    service_access: 0,
    sandbox_completed: 1,
    expected: SERVICE_ACCESS_ERROR,
    why: "training does not substitute for the grant",
  },
  {
    channel: "web",
    service_access: 0,
    sandbox_completed: 0,
    expected: SERVICE_ACCESS_ERROR,
    why: "the browser is not exempt from the grant",
  },
  {
    channel: "web",
    service_access: 0,
    sandbox_completed: 1,
    expected: SERVICE_ACCESS_ERROR,
    why: "the browser is not exempt from the grant",
  },
  // The training gate is the CLI's alone: `nemar sandbox` has no browser
  // equivalent, so requiring it of a web upload would gate the dashboard on a
  // command the dashboard cannot run.
  {
    channel: "cli",
    service_access: 1,
    sandbox_completed: 0,
    expected: SANDBOX_TRAINING_ERROR,
    why: "the CLI still owes the training run",
  },
  {
    channel: "web",
    service_access: 1,
    sandbox_completed: 0,
    expected: null,
    why: "THE case that separates the channels: web needs the grant alone",
  },
  {
    channel: "cli",
    service_access: 1,
    sandbox_completed: 1,
    expected: null,
    why: "both gates satisfied",
  },
  {
    channel: "web",
    service_access: 1,
    sandbox_completed: 1,
    expected: null,
    why: "a web user who happens to have trained is still allowed",
  },
];

describe("realDatasetCreateGate: channel x service_access x sandbox_completed", () => {
  for (const c of CASES) {
    const label = `${c.channel} / service_access=${c.service_access} / sandbox=${c.sandbox_completed} -> ${
      c.expected === null ? "allowed" : c.expected.error
    } (${c.why})`;
    test(label, () => {
      expect(
        realDatasetCreateGate(
          {
            service_access: c.service_access,
            sandbox_completed: c.sandbox_completed,
            account_kind: PERSON,
          },
          c.channel,
        ),
      ).toBe(c.expected);
    });
  }
});

describe("realDatasetCreateGate: account_kind is checked first (epic #1272 phase 4, #1284; ADR 0048)", () => {
  test("a test-kind account is refused even with full service_access and training", () => {
    expect(
      realDatasetCreateGate(
        { service_access: 1, sandbox_completed: 1, account_kind: "test" },
        "cli",
      ),
    ).toBe(TEST_ACCOUNT_SANDBOX_ONLY_ERROR);
  });

  test("a test-kind account is refused on the web channel too", () => {
    expect(
      realDatasetCreateGate(
        { service_access: 1, sandbox_completed: 1, account_kind: "test" },
        "web",
      ),
    ).toBe(TEST_ACCOUNT_SANDBOX_ONLY_ERROR);
  });

  test("a test-kind account with NO service_access still gets the kind refusal, not the grant refusal", () => {
    // Order is the point: the kind refusal names the actual reason (this
    // account can never create a real dataset, granted or not) rather than a
    // grant refusal that implies asking for upload access would fix it.
    expect(
      realDatasetCreateGate(
        { service_access: 0, sandbox_completed: 0, account_kind: "test" },
        "cli",
      ),
    ).toBe(TEST_ACCOUNT_SANDBOX_ONLY_ERROR);
  });

  test("a service-kind account is NOT refused by the kind check (falls through to the ordinary gates)", () => {
    // A service account CAN reach this route in practice, using a key an
    // owner minted for it (POST /admin/users/:username/keys) -- that key
    // authenticates through authMiddleware exactly like any other, which
    // never reads account_kind. The device flow and self-service key mint
    // only refuse a service/test account from SELF-serving a key; they say
    // nothing about a request already carrying one (ADR 0048; #1284
    // review corrected an earlier, false version of this comment). The gate
    // itself only singles out `test` -- proving that is what makes the
    // predicate exactly `=== 'test'` rather than `!== 'person'`.
    expect(
      realDatasetCreateGate(
        { service_access: 1, sandbox_completed: 1, account_kind: "service" },
        "cli",
      ),
    ).toBeNull();
    expect(
      realDatasetCreateGate(
        { service_access: 0, sandbox_completed: 0, account_kind: "service" },
        "cli",
      ),
    ).toBe(SERVICE_ACCESS_ERROR);
  });

  test("a person account is unaffected", () => {
    expect(
      realDatasetCreateGate(
        { service_access: 1, sandbox_completed: 1, account_kind: PERSON },
        "cli",
      ),
    ).toBeNull();
  });
});

describe("uploadChannelForAuthMethod", () => {
  test("the session cookie is the web channel", () => {
    expect(uploadChannelForAuthMethod("cookie")).toBe("web");
  });

  test("a bearer token is the CLI channel", () => {
    expect(uploadChannelForAuthMethod("token")).toBe("cli");
  });

  test("an unrecorded credential falls to the STRICTER channel", () => {
    // If a route ever reaches the gate without authMiddleware having recorded
    // how the caller authenticated, the safe default is the channel that
    // still owes sandbox training -- not the one that skips it.
    expect(uploadChannelForAuthMethod(undefined)).toBe("cli");
  });
});

describe("realDatasetServiceGate", () => {
  test("no service access -> service-access error (a collaborator without service access)", () => {
    expect(realDatasetServiceGate({ service_access: 0 })).toBe(SERVICE_ACCESS_ERROR);
  });

  test("service access present -> allowed (null); sandbox training is not re-checked", () => {
    // Byte-flow has no channel of its own: sandbox training was enforced at
    // create time (on whichever channel created the dataset), so re-asking
    // here would block a collaborator who never created anything.
    expect(realDatasetServiceGate({ service_access: 1 })).toBeNull();
  });
});

describe("explicitDatasetIdGate (ADR 0068, #1432)", () => {
  const ok = { isProduction: false, isAdmin: true, datasetId: "nm099998" };

  test("allows only the three terms together", () => {
    expect(explicitDatasetIdGate(ok)).toBeNull();
  });

  test("production refuses regardless of the other two", () => {
    expect(explicitDatasetIdGate({ ...ok, isProduction: true })).toEqual(
      EXPLICIT_ID_PRODUCTION_ERROR,
    );
  });

  test("a non-admin refuses regardless of the id", () => {
    expect(explicitDatasetIdGate({ ...ok, isAdmin: false })).toEqual(EXPLICIT_ID_ADMIN_ERROR);
  });

  test("every allocatable id is refused, including live and boundary ones", () => {
    // nm000104 is a LIVE production dataset and the reason non-production is
    // not a sufficient fence on its own: nemarDatasets is shared, so naming it
    // from dev would reach a real repository. nm099899/xx099899 are the ids
    // immediately below the band.
    for (const datasetId of [
      "nm000104",
      "nm000108",
      "nm099899",
      "xx000001",
      "xx090001",
      "xx099899",
      // on099999 rather than on008062: the latter fails BOTH the prefix rule
      // and the floor rule, so it cannot isolate the prefix term. This one is
      // in the band numerically and refused only because `on` never allocates.
      "on099999",
    ]) {
      expect(explicitDatasetIdGate({ ...ok, datasetId })).toEqual(EXPLICIT_ID_NOT_RESERVED_ERROR);
    }
  });

  test("a reserved id is allowed only once it is DECLARED dev-owned", () => {
    // Reserved is necessary and not sufficient (#1440). Creation used to admit
    // any reserved id while ownership was declared for one, so the next fixture
    // would be born undeclared: production dispatching enrichment for a repo it
    // has no row for, the dev worker refusing its own dataset, and
    // delete-dataset refused on the only worker that could rebuild it.
    expect(explicitDatasetIdGate({ ...ok, datasetId: "nm099998" })).toBeNull();
    // nm099997 is the soak fixture of ADR 0102, declared before it exists.
    expect(explicitDatasetIdGate({ ...ok, datasetId: "nm099997" })).toBeNull();

    // Reserved `xx` ids are dev-range, so they are dev-owned without being
    // named in the set.
    for (const datasetId of ["xx099900", "xx099907", "xx099999"]) {
      expect(explicitDatasetIdGate({ ...ok, datasetId })).toBeNull();
    }
  });

  test("an UNDECLARED reserved nm id is refused, and says what to do", () => {
    // nm099997 was the next standing fixture ADR 0068 named, and is declared now;
    // nm099996 is the one after it, so this is the documented next step rather
    // than a hypothetical.
    for (const datasetId of ["nm099900", "nm099996"]) {
      expect(explicitDatasetIdGate({ ...ok, datasetId })).toEqual(EXPLICIT_ID_NOT_DEV_OWNED_ERROR);
    }
    expect(EXPLICIT_ID_NOT_DEV_OWNED_ERROR.message).toMatch(/DEV_OWNED_FIXTURE_IDS/);
  });

  test("nm099999 is refused here: it has its own reset endpoint, not this route", () => {
    // Reserved, a fixture, and production's. It is created and rebuilt through
    // POST /admin/datasets/nm099999/reset, so naming it here would be a second
    // way to make a dataset production also uses.
    expect(explicitDatasetIdGate({ ...ok, datasetId: "nm099999" })).toEqual(
      EXPLICIT_ID_NOT_DEV_OWNED_ERROR,
    );
  });

  test("a malformed id is refused, never treated as a name", () => {
    for (const datasetId of ["", "nm99998", "nm100000", "zz099998", "nm099998 ", "NM099998"]) {
      expect(explicitDatasetIdGate({ ...ok, datasetId })).toEqual(EXPLICIT_ID_NOT_RESERVED_ERROR);
    }
  });

  test("the outermost fence answers first", () => {
    // Ordering is observable and worth pinning: a production caller who is also
    // a non-admin naming a live id must be told about production, which is the
    // term that can never be satisfied, rather than being sent to ask for an
    // admin role that would not help.
    expect(
      explicitDatasetIdGate({ isProduction: true, isAdmin: false, datasetId: "nm000104" }),
    ).toEqual(EXPLICIT_ID_PRODUCTION_ERROR);
  });
});
