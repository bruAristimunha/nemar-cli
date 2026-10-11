/**
 * A publication request made while BIDS validation is still pending or running
 * must still meet the submission minimums (ADR 0026) and the anonymity blind
 * check (ADR 0065), at both places a request is decided: the request route and
 * the blocked-request sweep that releases it once CI passes.
 *
 * A request right after an upload is nearly always pending, so the sweep is the
 * default path to `requested`. Before the shared gate, that path skipped the
 * minimums altogether: a named depositor could be released under the blind
 * label, which cannot be undone, and a request that met no minimum was queued
 * for an administrator anyway.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real auth middleware, the real route through Hono's `app.request()`, and the
 * real exported sweep. GitHub is a `Bun.serve()` stand-in for api.github.com
 * (NEMAR_GITHUB_API_URL) whose workflow runs and dataset_description.json the
 * tests change between a request and the sweep, which is the case that matters.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import {
  ACCEPTED_BODY,
  CI_UNAVAILABLE_BODY,
  FAILED_BODY,
  IN_PROGRESS_BODY,
  MINIMUMS_BODY,
  OWNER_NAME_BODY,
  PENDING_BODY,
  statusBody,
} from "../../test/helpers/pending-cli";
import { datasetRoutes } from "../src/routes/datasets";
import {
  __resetRateLimitStateForTests,
  __seedRateLimitStateForTests,
} from "../src/services/github/transport";
import {
  MAX_GATE_READS_PER_SWEEP,
  sweepBlockedBidsValidationRequests,
} from "../src/services/publication-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";

const OWNER_KEY = "pending-gate-owner-key-0123456789abcdef0123456789abcdef";
const NAMELESS_KEY = "pending-gate-nameless-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000480";
const OWNER_EMAIL = "pendinggate@example.org";

const NAME = "A sufficiently descriptive dataset title";
const ETHICS = ["Approved by an institutional review board"];
const descriptionJson = (name: string, authors: string[], ethics: string[] = ETHICS) =>
  JSON.stringify({ Name: name, Authors: authors, EthicsApprovals: ethics });
const NAMED = descriptionJson(NAME, ["Ada Lovelace"]);
const BLINDED = descriptionJson(NAME, ["Anonymous"]);
const SHORT_NAME = descriptionJson("Short", ["Ada Lovelace"]);
// No EthicsApprovals, so only a README can supply the ethics statement.
const NO_ETHICS_FIELD = descriptionJson(NAME, ["Ada Lovelace"], []);
const NO_ETHICS_BLINDED = descriptionJson(NAME, ["Anonymous"], []);
const README_WITH_ETHICS = "# README\n\nThis study had institutional review board approval.\n";

type Runs = "none" | "running" | "success" | "failure";
type ReadmeMode = "text" | "empty" | "forbidden" | "missing";

let server: Server;
let runs: Runs = "none";
// A dataset's own run state, where it differs from `runs`.
let runsFor: Record<string, Runs> = {};
let descriptionBody: string | null = NAMED;
let descriptionStatus = 200;
let runsStatus = 200;
// Seconds GitHub asks a caller to wait, sent with a failing description read.
let descriptionRetryAfter: number | null = null;
// Runs inside the stand-in when the workflow runs are asked for: after the sweep
// has read its candidate rows, before it writes to any of them.
let onRunsRead: (() => Promise<void> | void) | null = null;
let readmeMode: ReadmeMode = "text";
let readmeText = "# README";
// Every `/contents/<path>` the stand-in was asked for, in order.
let contentReads: string[] = [];
// Runs inside the stand-in when `dataset_description.json` is asked for, which
// is after the sweep has read its candidate rows and before it writes: the
// moment a concurrent request lands in the races below.
let onDescriptionRead: (() => void) | null = null;
let dispatches = 0;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (req.method === "POST" && p === "/repos/nemarDatasets/.github/dispatches") {
        dispatches++;
        return new Response(null, { status: 204 });
      }
      if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(p)) {
        return Response.json({ name: "bids-validation.yml" });
      }
      if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(p)) {
        const hook = onRunsRead;
        onRunsRead = null;
        await hook?.();
        if (runsStatus !== 200) return new Response("no", { status: runsStatus });
        const repo = /\/repos\/nemarDatasets\/([^/]+)\//.exec(p)?.[1] ?? "";
        const state = runsFor[repo] ?? runs;
        const workflow_runs =
          state === "none"
            ? []
            : [
                {
                  status: state === "running" ? "in_progress" : "completed",
                  conclusion: state === "running" ? null : state,
                  html_url: "x",
                },
              ];
        return Response.json({ workflow_runs });
      }
      const read = /\/contents\/([^/]+)$/.exec(p)?.[1];
      if (read) contentReads.push(read);
      if (read === "dataset_description.json") {
        onDescriptionRead?.();
        if (descriptionStatus !== 200) {
          return new Response("no", {
            status: descriptionStatus,
            headers:
              descriptionRetryAfter === null
                ? undefined
                : { "Retry-After": String(descriptionRetryAfter) },
          });
        }
        if (descriptionBody === null) return new Response("not found", { status: 404 });
        return Response.json({ encoding: "base64", content: btoa(descriptionBody) });
      }
      if (read === "README.md") {
        if (readmeMode === "forbidden") return new Response("no", { status: 403 });
        if (readmeMode === "missing") return new Response("not found", { status: 404 });
        // A zero-byte file comes back as base64 with an empty content field.
        const content = readmeMode === "empty" ? "" : btoa(readmeText);
        return Response.json({ encoding: "base64", content });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  runs = "none";
  runsFor = {};
  descriptionBody = NAMED;
  descriptionStatus = 200;
  runsStatus = 200;
  descriptionRetryAfter = null;
  onRunsRead = null;
  __resetRateLimitStateForTests();
  readmeMode = "text";
  readmeText = "# README";
  contentReads = [];
  onDescriptionRead = null;
  dispatches = 0;
});

function env(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_pending_gate_test",
    PRESCREEN_CALLBACK_SECRET: "pending-gate-secret",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...overrides,
  } as Bindings;
}

async function seedUser(username: string, key: string, names: boolean): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', 'member', 1, 1, 1, ?, ?)`,
    [username, `${username}@example.org`, names ? "Ada" : null, names ? "Lovelace" : null],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

function seedDataset(
  id: string,
  opts: { owner?: number; source?: string | null; exemplar?: boolean } = {},
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, is_exemplar, source)
     VALUES (?, ?, ?, 'active', 'private', 0, ?, ?, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      opts.owner ?? ownerId,
      `nemarDatasets/${id}`,
      opts.exemplar ? 1 : 0,
      opts.source ?? null,
    ],
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  ownerId = await seedUser("pendinggate", OWNER_KEY, true);
  seedDataset(DATASET);
});

interface RequestBody {
  status?: string;
  block_reason?: string;
  message?: string;
  anonymous?: boolean;
  reasons?: string[];
  details?: { reasons?: string[]; policy_url?: string };
  policy_url?: string;
}

async function requestPublication(
  opts: { id?: string; key?: string; anonymous?: boolean; bindings?: Bindings } = {},
): Promise<{ status: number; body: RequestBody }> {
  const res = await app.request(
    `/datasets/${opts.id ?? DATASET}/publish/request`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.key ?? OWNER_KEY}`,
        ...(opts.anonymous ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.anonymous ? { body: JSON.stringify({ anonymous: true }) } : {}),
    },
    opts.bindings ?? env(),
  );
  return { status: res.status, body: (await res.json()) as RequestBody };
}

interface Row {
  id: number;
  status: string;
  block_reason: string | null;
  min_requirements_reasons: string | null;
  anonymous: number;
}

function row(id = DATASET): Row {
  return db
    .query<Row, [string]>(
      `SELECT id, status, block_reason, min_requirements_reasons, anonymous
         FROM publication_requests WHERE dataset_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(id) as Row;
}

const reasonsOf = (r: Row): string[] =>
  r.min_requirements_reasons ? (JSON.parse(r.min_requirements_reasons) as string[]) : [];

describe("the request route checks the minimums while CI is pending", () => {
  test("pending validation and a too-short Name: min_requirements_failed with its reasons", async () => {
    runs = "none";
    descriptionBody = SHORT_NAME;
    const { status, body } = await requestPublication();
    expect(status).toBe(422);
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.reasons?.join(" ")).toContain("Dataset Name must be a descriptive title");
    expect(body.details?.reasons).toEqual(body.reasons);
    expect(body.policy_url).toBeTruthy();
    const r = row();
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(r)).toEqual(body.reasons ?? []);
  });

  test("control: the same dataset with a valid description is only pending, with no reasons", async () => {
    // Proves the gate ran and passed, so the test above is not just "pending
    // always answers min_requirements_failed".
    runs = "none";
    descriptionBody = NAMED;
    const { status, body } = await requestPublication();
    expect(status).toBe(422);
    expect(body.block_reason).toBe("bids_validation_pending");
    expect(body.reasons).toBeUndefined();
    expect(row().min_requirements_reasons).toBeNull();
  });

  test("the pending messages say the request is recorded, and do not ask for another request", async () => {
    // The message is also what the website's badge shows. Telling the depositor
    // to "re-request publication" contradicts a request that continues on its
    // own.
    runs = "none";
    const pending = (await requestPublication()).body.message ?? "";
    expect(pending).toBe(
      "BIDS validation has not run yet. Your request is recorded and continues automatically once validation passes.",
    );
    runs = "running";
    const running = (await requestPublication()).body.message ?? "";
    expect(running).toBe(
      "BIDS validation is currently running. Your request is recorded and continues automatically once validation passes.",
    );
    for (const message of [pending, running]) expect(message).not.toMatch(/re-?request/i);
  });

  test("the in-progress message keeps the phrase two CLI loops match on", async () => {
    // src/lib/exemplar-clone.ts and src/lib/import-openneuro.ts decide to keep
    // waiting by looking for this substring in the refusal's message. If it
    // changed, they would stop waiting and fail the run instead.
    runs = "running";
    const { body } = await requestPublication();
    expect(body.message).toContain("BIDS validation is currently running");
    // And the pending refusal must NOT contain it: they must not start
    // retrying a request that has no run at all.
    runs = "none";
    expect((await requestPublication()).body.message).not.toContain(
      "BIDS validation is currently running",
    );
  });

  test("a validation run still in progress is checked the same way", async () => {
    runs = "running";
    descriptionBody = SHORT_NAME;
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("min_requirements_failed");
    descriptionBody = NAMED;
    const again = await requestPublication();
    expect(again.body.block_reason).toBe("bids_validation_in_progress");
  });

  test("an anonymous request whose Authors still names someone is refused, not left pending", async () => {
    runs = "none";
    descriptionBody = NAMED;
    const { status, body } = await requestPublication({ anonymous: true });
    expect(status).toBe(422);
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.anonymous).toBe(true);
    expect(body.reasons?.join(" ")).toContain("still names Ada Lovelace");
    expect(row().anonymous).toBe(1);
  });

  test("control: a blinded anonymous request is only pending", async () => {
    runs = "none";
    descriptionBody = BLINDED;
    const { body } = await requestPublication({ anonymous: true });
    expect(body.block_reason).toBe("bids_validation_pending");
    expect(body.anonymous).toBe(true);
  });

  test("an anonymous request whose blind cannot be read is not granted", async () => {
    // 403, not 5xx: GitHub's retry loop sleeps between 5xx attempts.
    runs = "none";
    descriptionStatus = 403;
    const { status, body } = await requestPublication({ anonymous: true });
    expect(status).toBe(422);
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.reasons?.join(" ")).toContain("could not read dataset_description.json");
  });

  test("a native request whose description cannot be read stays pending (fail-open, as before)", async () => {
    runs = "none";
    descriptionStatus = 403;
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("bids_validation_pending");
  });

  test("a failed validation is reported as such; the minimums are not read", async () => {
    runs = "failure";
    descriptionBody = SHORT_NAME;
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("bids_validation_failed");
    expect(body.reasons).toBeUndefined();
    expect(row().min_requirements_reasons).toBeNull();
  });

  test("a missing owner name is reported as such; the minimums are not read", async () => {
    const nameless = await seedUser("nameless", NAMELESS_KEY, false);
    seedDataset("nm000481", { owner: nameless });
    descriptionBody = SHORT_NAME;
    const { body } = await requestPublication({ id: "nm000481", key: NAMELESS_KEY });
    expect(body.block_reason).toBe("owner_name_missing");
    expect(body.reasons).toBeUndefined();
  });

  test("an OpenNeuro import and an exemplar keep their exemption", async () => {
    descriptionBody = SHORT_NAME;
    seedDataset("nm000482", { source: "openneuro" });
    seedDataset("nm000483", { exemplar: true });
    for (const id of ["nm000482", "nm000483"]) {
      const { body } = await requestPublication({ id });
      expect(body.block_reason, id).toBe("bids_validation_pending");
    }
  });

  test("an anonymous request is checked even for an OpenNeuro import or an exemplar", async () => {
    // For an anonymous release the gate is the blind check, and an upstream
    // review says a dataset was curated, never that it was blinded.
    descriptionBody = NAMED;
    seedDataset("nm000484", { source: "openneuro" });
    seedDataset("nm000485", { exemplar: true });
    for (const id of ["nm000484", "nm000485"]) {
      const { body } = await requestPublication({ id, anonymous: true });
      expect(body.block_reason, id).toBe("min_requirements_failed");
      expect(body.reasons?.join(" "), id).toContain("still names Ada Lovelace");
    }
  });

  test("an empty README does not switch the whole gate off", async () => {
    // A zero-byte README.md comes back from GitHub as base64 with empty
    // content. Reading it used to throw, the throw fell through to "native
    // submissions fail open", and Name, Authors and ethics were never checked.
    descriptionBody = descriptionJson("Short", ["TBD"], []);
    readmeMode = "empty";
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("min_requirements_failed");
    const text = body.reasons?.join(" ") ?? "";
    expect(text).toContain("Dataset Name must be a descriptive title");
    expect(text).toContain("Authors in dataset_description.json must name");
    expect(text).toContain("An ethics approval statement is required");
  });

  test("the same file with a README that states the approval gives the same verdict, less the ethics reason", async () => {
    // The control for the test above: the empty README is the only difference,
    // and what it changes is the ethics reason.
    descriptionBody = descriptionJson("Short", ["TBD"], []);
    readmeText = README_WITH_ETHICS;
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("min_requirements_failed");
    const text = body.reasons?.join(" ") ?? "";
    expect(text).toContain("Dataset Name must be a descriptive title");
    expect(text).toContain("Authors in dataset_description.json must name");
    expect(text).not.toContain("An ethics approval statement is required");
  });

  test("a README that cannot be read counts as one with no statement; the other rules still run", async () => {
    descriptionBody = descriptionJson("Short", ["TBD"], []);
    readmeMode = "forbidden";
    const { status, body } = await requestPublication();
    expect(status).toBe(422);
    expect(body.block_reason).toBe("min_requirements_failed");
    const text = body.reasons?.join(" ") ?? "";
    expect(text).toContain("Dataset Name must be a descriptive title");
    expect(text).toContain("Authors in dataset_description.json must name");
    expect(text).toContain("An ethics approval statement is required");
  });

  test("an anonymous request with an empty README is judged on its file, not left unverified", async () => {
    descriptionBody = NO_ETHICS_BLINDED;
    readmeMode = "empty";
    const { body } = await requestPublication({ anonymous: true });
    expect(body.block_reason).toBe("min_requirements_failed");
    // The reason is the missing statement, not "could not read".
    expect(body.reasons?.join(" ")).toContain("An ethics approval statement is required");
    expect(body.reasons?.join(" ")).not.toContain("could not read");
  });

  test("an anonymous request whose Authors names someone is refused even though its README cannot be read", async () => {
    // The blind check is decided by the description alone.
    descriptionBody = descriptionJson(NAME, ["Ada Lovelace"], []);
    readmeMode = "forbidden";
    const { body } = await requestPublication({ anonymous: true });
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.reasons?.join(" ")).toContain("still names Ada Lovelace");
  });

  test("an empty dataset_description.json is a file with a problem, not one that cannot be read", async () => {
    // GitHub answers a zero-byte file with base64 and empty content. That is an
    // answer ("not valid JSON"), for a native and an anonymous request alike.
    descriptionBody = "";
    const native = await requestPublication();
    expect(native.body.block_reason).toBe("min_requirements_failed");
    expect(native.body.reasons?.join(" ")).toContain("is not valid JSON");
    const anonymous = await requestPublication({ anonymous: true });
    expect(anonymous.body.reasons?.join(" ")).toContain("is not valid JSON");
    expect(anonymous.body.reasons?.join(" ")).not.toContain("could not read");
  });

  test("the README is not read when the description already lists an approval", async () => {
    descriptionBody = NAMED;
    readmeMode = "forbidden";
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("bids_validation_pending");
    expect(contentReads).toEqual(["dataset_description.json"]);
  });

  test("when the description lists no approval, the README candidates are tried in order", async () => {
    descriptionBody = NO_ETHICS_FIELD;
    readmeMode = "missing";
    await requestPublication();
    expect(contentReads).toEqual([
      "dataset_description.json",
      "README.md",
      "README",
      "README.txt",
      "README.rst",
    ]);
  });

  test("re-requesting while CI runs keeps the minimums verdict instead of erasing it", async () => {
    runs = "running";
    descriptionBody = SHORT_NAME;
    const first = await requestPublication();
    expect(first.body.block_reason).toBe("min_requirements_failed");
    const recorded = reasonsOf(row());
    expect(recorded.length).toBeGreaterThan(0);

    // Same data, asked again: the verdict is re-recorded, not replaced by NULL.
    const second = await requestPublication();
    expect(second.body.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(row())).toEqual(recorded);

    // Fixed and asked again: now it is only waiting for CI, and the old
    // reasons are gone.
    descriptionBody = NAMED;
    const third = await requestPublication();
    expect(third.body.block_reason).toBe("bids_validation_in_progress");
    expect(row().min_requirements_reasons).toBeNull();
  });
});

describe("the sweep checks the same minimums before it releases a request", () => {
  test("a request whose description was edited after it was made is re-blocked with the reasons", async () => {
    runs = "none";
    descriptionBody = NAMED;
    const made = await requestPublication();
    expect(made.body.block_reason).toBe("bids_validation_pending");

    // CI passes, but the depositor has since shortened the Name.
    runs = "success";
    descriptionBody = SHORT_NAME;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.reblocked).toBe(1);
    expect(dispatches).toBe(0);
    const r = row();
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(r).join(" ")).toContain("Dataset Name must be a descriptive title");

    // And it is no longer a candidate: the depositor fixes the data and asks.
    const again = await sweepBlockedBidsValidationRequests(env());
    expect(again.scanned).toBe(0);
  });

  test("control: an unchanged, valid description is released and screened", async () => {
    runs = "none";
    descriptionBody = NAMED;
    await requestPublication();
    runs = "success";
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(1);
      expect(result.reblocked).toBe(0);
    });
    expect(row().status).toBe("requested");
    expect(row().block_reason).toBeNull();
    expect(dispatches).toBe(1);
  });

  test("an anonymous request whose Authors now names the depositor is NOT released", async () => {
    // The irreversible case: released as requested, the real name would be
    // served under the blind label.
    runs = "none";
    descriptionBody = BLINDED;
    const made = await requestPublication({ anonymous: true });
    expect(made.body.block_reason).toBe("bids_validation_pending");
    expect(row().anonymous).toBe(1);

    runs = "success";
    descriptionBody = NAMED;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.reblocked).toBe(1);
    expect(dispatches).toBe(0);
    const r = row();
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(r).join(" ")).toContain("still names Ada Lovelace");
  });

  test("control: an anonymous request that stays blinded is released", async () => {
    runs = "none";
    descriptionBody = BLINDED;
    await requestPublication({ anonymous: true });
    runs = "success";
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(1);
    });
    expect(row().status).toBe("requested");
    expect(row().anonymous).toBe(1);
  });

  test("an anonymous blind that cannot be read is left blocked for the next run, not released", async () => {
    runs = "none";
    descriptionBody = BLINDED;
    await requestPublication({ anonymous: true });
    runs = "success";
    descriptionStatus = 403;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.errors).toBe(1);
    // No verdict was reached, so the request still waits on CI alone.
    expect(row().status).toBe("blocked");
    expect(row().block_reason).toBe("bids_validation_pending");

    // The next run, with GitHub answering, releases it.
    descriptionStatus = 200;
    await withFakeResend(async () => {
      expect((await sweepBlockedBidsValidationRequests(env())).unblocked).toBe(1);
    });
  });

  test("a native request whose description cannot be read is deferred, not released", async () => {
    // The route lets a native submission through to the admin review when the
    // description cannot be read (an interactive call, ADR 0026). A daily batch
    // defers instead: leaving the row for the next run costs a day, and a
    // release on a failed read would be a verdict nobody reached.
    runs = "none";
    await requestPublication();
    runs = "success";
    descriptionStatus = 403;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.errors).toBe(1);
    expect(row().status).toBe("blocked");
    expect(row().block_reason).toBe("bids_validation_pending");
  });

  test("an empty README does not hold a request the sweep can already judge", async () => {
    // Native: made valid, then the file loses its approval and its Name while
    // the README is empty. The sweep reaches a verdict instead of releasing it.
    runs = "none";
    descriptionBody = NAMED;
    await requestPublication();
    runs = "success";
    descriptionBody = descriptionJson("Short", ["TBD"], []);
    readmeMode = "empty";
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.reblocked).toBe(1);
    expect(result.errors).toBe(0);
    expect(row().block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(row()).join(" ")).toContain("An ethics approval statement is required");
  });

  test("an anonymous request with an empty README is judged, not counted as an error every day", async () => {
    runs = "none";
    descriptionBody = BLINDED;
    await requestPublication({ anonymous: true });
    runs = "success";
    descriptionBody = NO_ETHICS_BLINDED;
    readmeMode = "empty";
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.errors).toBe(0);
    expect(result.reblocked).toBe(1);
    expect(row().block_reason).toBe("min_requirements_failed");
  });

  test("an OpenNeuro import and an exemplar are released without the check", async () => {
    descriptionBody = SHORT_NAME;
    seedDataset("nm000482", { source: "openneuro" });
    seedDataset("nm000483", { exemplar: true });
    for (const id of ["nm000482", "nm000483"]) {
      expect((await requestPublication({ id })).body.block_reason).toBe("bids_validation_pending");
    }
    runs = "success";
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(2);
      expect(result.reblocked).toBe(0);
    });
  });

  test("an anonymous exemplar or OpenNeuro import is still checked by the sweep", async () => {
    descriptionBody = BLINDED;
    seedDataset("nm000484", { source: "openneuro" });
    seedDataset("nm000485", { exemplar: true });
    for (const id of ["nm000484", "nm000485"]) {
      const { body } = await requestPublication({ id, anonymous: true });
      expect(body.block_reason, id).toBe("bids_validation_pending");
    }
    runs = "success";
    descriptionBody = NAMED;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.reblocked).toBe(2);
    for (const id of ["nm000484", "nm000485"]) {
      expect(row(id).block_reason, id).toBe("min_requirements_failed");
    }
  });

  test("the route and the sweep agree on every description", async () => {
    // One function decides both, so no description can pass one and fail the
    // other. Drive each with the same set and compare the verdicts.
    const cases: Array<[string, string | null]> = [
      ["valid", NAMED],
      ["short name", SHORT_NAME],
      ["no authors", descriptionJson(NAME, [])],
      ["placeholder author", descriptionJson(NAME, ["TBD"])],
      ["missing file", null],
    ];
    for (const [i, [label, body]] of cases.entries()) {
      const id = `nm00056${i}`;
      seedDataset(id);
      runs = "none";
      descriptionBody = body;
      const routeVerdict = (await requestPublication({ id })).body.block_reason;
      // Now let the sweep decide the same request.
      db.run(
        `UPDATE publication_requests SET status = 'blocked', block_reason = 'bids_validation_pending',
                min_requirements_reasons = NULL WHERE dataset_id = ?`,
        [id],
      );
      runs = "success";
      await withFakeResend(async () => {
        await sweepBlockedBidsValidationRequests(env());
      });
      const swept = row(id);
      const sweepVerdict =
        swept.status === "requested" ? "bids_validation_pending" : swept.block_reason;
      expect(sweepVerdict, label).toBe(routeVerdict ?? "");
    }
  });
});

describe("a readiness check that cannot run is not reported as pending", () => {
  // `bids_validation_pending` means GitHub answered and there is no run yet,
  // and the sweep then carries the request on. When the check itself fails (no
  // credential, workflow deploy, an outage) the cause can be one the sweep does
  // not cure, so the depositor is not promised a continuation: 503, no block
  // reason (the field-for-field pin below has no `block_reason` or `status`).
  const NO_GITHUB_AUTH = { GITHUB_ADMIN_PAT: undefined } as Partial<Bindings>;

  test("no GitHub credential: 503 ci_check_unavailable, and the request is still recorded", async () => {
    // The whole body is pinned, field for field, with the other CLI bodies below.
    const { status, body } = await requestPublication({ bindings: env(NO_GITHUB_AUTH) });
    expect(status).toBe(503);
    expect((body as { error: string }).error).toBe("ci_check_unavailable");
    // Recorded, as the message says, and blocked on the existing reason.
    expect(row().status).toBe("blocked");
    expect(row().block_reason).toBe("bids_validation_pending");
  });

  test("GitHub refusing the workflow-run read is the same", async () => {
    runsStatus = 403;
    const { status, body } = await requestPublication();
    expect(status).toBe(503);
    expect((body as { error: string }).error).toBe("ci_check_unavailable");
    expect(row().status).toBe("blocked");
  });

  test("the minimums are not read when the check could not run", async () => {
    // A description that would fail them must not turn a 503 into a verdict
    // drawn from a GitHub that just failed.
    runsStatus = 403;
    descriptionBody = SHORT_NAME;
    const { status, body } = await requestPublication();
    expect(status).toBe(503);
    expect((body as { error: string }).error).toBe("ci_check_unavailable");
    expect(row().min_requirements_reasons).toBeNull();
  });

  test("an anonymous request is told the same and its intent is recorded", async () => {
    const { status, body } = await requestPublication({
      anonymous: true,
      bindings: env(NO_GITHUB_AUTH),
    });
    expect(status).toBe(503);
    expect(body.anonymous).toBe(true);
    expect(row().anonymous).toBe(1);
  });

  test("control: a check that runs and finds no run is still a 422 pending", async () => {
    const { status, body } = await requestPublication();
    expect(status).toBe(422);
    expect(body.block_reason).toBe("bids_validation_pending");
  });
});

describe("the bodies the CLI tests are answered with are the route's", () => {
  // test/publish-pending-cli.test.ts and test/publish-status-pending-cli.test.ts
  // answer the real CLI from a stand-in server with the bodies in
  // test/helpers/pending-cli.ts. They are compared here with what the real route
  // sends, so the stand-in cannot drift from the Worker without this saying so.
  // Only the dataset id and the repository link, which belong to the dataset
  // under test, are substituted.
  const forDataset = (id: string) => ({
    dataset_id: id,
    ci_url: `https://github.com/nemarDatasets/${id}/actions`,
  });

  test("pending, in progress and failed: equal, field for field", async () => {
    for (const [reason, runState, stand] of [
      ["bids_validation_pending", "none", PENDING_BODY],
      ["bids_validation_in_progress", "running", IN_PROGRESS_BODY],
      ["bids_validation_failed", "failure", FAILED_BODY],
    ] as const) {
      runs = runState;
      const { status, body } = await requestPublication();
      expect(status, reason).toBe(422);
      expect(body, reason).toEqual({ ...stand, ...forDataset(DATASET) });
    }
  });

  test("pending, anonymous: the echo is true", async () => {
    descriptionBody = BLINDED;
    const { body } = await requestPublication({ anonymous: true });
    expect(body).toEqual({ ...PENDING_BODY, ...forDataset(DATASET), anonymous: true });
  });

  test("min_requirements_failed: the same keys, and details mirrors reasons", async () => {
    descriptionBody = SHORT_NAME;
    const { body } = await requestPublication();
    expect(Object.keys(body).sort()).toEqual(Object.keys(MINIMUMS_BODY).sort());
    expect(body.message).toBe(MINIMUMS_BODY.message);
    expect(body.policy_url).toBe(MINIMUMS_BODY.policy_url);
    expect(body.details).toEqual({ reasons: body.reasons, policy_url: body.policy_url });
  });

  test("a missing owner name: equal, field for field", async () => {
    const nameless = await seedUser("nameless2", NAMELESS_KEY, false);
    seedDataset("nm000486", { owner: nameless });
    const { status, body } = await requestPublication({ id: "nm000486", key: NAMELESS_KEY });
    expect(status).toBe(422);
    expect(body).toEqual({ ...OWNER_NAME_BODY, ...forDataset("nm000486") });
  });

  test("validation status that could not be checked: equal, field for field", async () => {
    runsStatus = 403;
    const { status, body } = await requestPublication();
    expect(status).toBe(503);
    expect(body).toEqual({ ...CI_UNAVAILABLE_BODY, ...forDataset(DATASET) });
  });

  test("an accepted request: the same keys, with the notice", async () => {
    runs = "success";
    await withFakeResend(async () => {
      const { status, body } = await requestPublication();
      expect(status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(Object.keys(ACCEPTED_BODY).sort());
      expect(body.message).toBe(ACCEPTED_BODY.message);
    });
  });

  test("publish status of a request waiting on validation: the same keys", async () => {
    runs = "none";
    await requestPublication();
    const res = await app.request(
      `/datasets/${DATASET}/publish/status`,
      { headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(Object.keys(statusBody()).sort());
    expect(body).toMatchObject({
      status: "blocked",
      block_reason: "bids_validation_pending",
      message: PENDING_BODY.message,
      anonymous: false,
      ...forDataset(DATASET),
    });
    // The screen view the CLI test sends for a request that has not been
    // released: not the stand-in's word for it, the route's.
    expect(body.identifier_screen).toEqual(statusBody().identifier_screen);
  });

  test("a request that is already open: error, status and message", async () => {
    runs = "success";
    await withFakeResend(async () => {
      expect((await requestPublication()).status).toBe(200);
    });
    const res = await app.request(
      `/datasets/${DATASET}/publish/request`,
      { method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "A publication request already exists",
      status: "requested",
      message: "Use 'resend' to remind admins",
    });
  });

  test("not the owner: a single error sentence", async () => {
    await seedUser("bystander", "bystander-key-0123456789abcdef0123456789abcdef", true);
    const res = await app.request(
      `/datasets/${DATASET}/publish/request`,
      {
        method: "POST",
        headers: { Authorization: "Bearer bystander-key-0123456789abcdef0123456789abcdef" },
      },
      env(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only the dataset owner can request publication" });
  });
});

describe("the sweep's reads never sleep, and share a budget", () => {
  /** Make a pending request for each id with a description that is valid now. */
  async function pendingRequests(ids: string[]): Promise<void> {
    descriptionBody = NAMED;
    for (const id of ids) {
      if (id !== DATASET) seedDataset(id);
      expect((await requestPublication({ id })).body.block_reason).toBe("bids_validation_pending");
    }
  }
  const reads = (path: string) => contentReads.filter((r) => r === path).length;

  test("a failing read is tried once, however long GitHub asks the caller to wait", async () => {
    // Under the default policy a 503 with Retry-After: 2 is retried twice, with
    // a two-second sleep before each. In a daily batch of many rows that is the
    // difference between a pass and a stall, so the sweep's reads make one
    // attempt and the row waits for the next run.
    await pendingRequests([DATASET]);
    runs = "success";
    contentReads = [];
    descriptionStatus = 503;
    descriptionRetryAfter = 2;
    const started = Date.now();
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reads("dataset_description.json")).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.unblocked).toBe(0);
    expect(row().status).toBe("blocked");
  });

  test("a nearly drained rate-limit bucket defers the row instead of sleeping until it resets", async () => {
    await pendingRequests([DATASET]);
    runs = "success";
    contentReads = [];
    // The shared bucket is nearly drained and resets in three seconds: a call
    // under the default policy sleeps until then; an interactive one is refused
    // at once. (The workflow-run lookup does not go through this policy.)
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 0,
      resetEpoch: Math.ceil(Date.now() / 1000) + 3,
      limit: 5000,
    });
    const started = Date.now();
    const result = await sweepBlockedBidsValidationRequests(env());
    // The bucket resets in three seconds; the default policy would sleep them.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(reads("dataset_description.json")).toBe(0);
    expect(result.errors).toBe(1);
    expect(row().status).toBe("blocked");
  });

  test("a README that cannot be read defers the row; the sweep gives no verdict from a partial look", async () => {
    await pendingRequests([DATASET]);
    runs = "success";
    descriptionBody = NO_ETHICS_FIELD;
    readmeMode = "forbidden";
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.errors).toBe(1);
    expect(result.reblocked).toBe(0);
    expect(result.unblocked).toBe(0);
    expect(row().block_reason).toBe("bids_validation_pending");
  });

  test("the reads of all rows share one budget, and the rows after it are left for the next run", async () => {
    const ids = ["nm000500", "nm000501", "nm000502", "nm000503"];
    await pendingRequests(ids);
    runs = "success";
    // Each row now costs five reads (the description and four README names).
    descriptionBody = NO_ETHICS_FIELD;
    readmeMode = "missing";
    contentReads = [];
    const first = await sweepBlockedBidsValidationRequests(env(), 50, 3);
    expect(contentReads).toHaveLength(3);
    expect(first.gateReads).toBe(3);
    expect(first.deferred).toBe(ids.length);
    expect(first.unblocked + first.reblocked + first.errors).toBe(0);
    // Nothing was decided and nothing was touched.
    for (const id of ids) expect(row(id).block_reason, id).toBe("bids_validation_pending");

    // The next run, with budget, decides them.
    contentReads = [];
    const second = await sweepBlockedBidsValidationRequests(env(), 50, 100);
    expect(second.deferred).toBe(0);
    expect(second.reblocked).toBe(ids.length);
    expect(second.gateReads).toBe(5 * ids.length);
    for (const id of ids) expect(row(id).block_reason, id).toBe("min_requirements_failed");
  });

  test("rows that need one read each stay well inside the default budget", async () => {
    const ids = ["nm000510", "nm000511", "nm000512"];
    await pendingRequests(ids);
    runs = "success";
    contentReads = [];
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(ids.length);
      expect(result.deferred).toBe(0);
      expect(result.gateReads).toBe(ids.length);
    });
    expect(MAX_GATE_READS_PER_SWEEP).toBeGreaterThan(ids.length);
  });

  test("a spent budget does not hold back a row that needs no read", async () => {
    // An exempt dataset is released without the gate reading anything.
    seedDataset("nm000520", { exemplar: true });
    expect((await requestPublication({ id: "nm000520" })).body.block_reason).toBe(
      "bids_validation_pending",
    );
    runs = "success";
    contentReads = [];
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env(), 50, 0);
      expect(result.unblocked).toBe(1);
      expect(result.deferred).toBe(0);
    });
    expect(contentReads).toHaveLength(0);
  });

  test("a spent budget does not hold back a row CI keeps blocked", async () => {
    // Only a row CI would release needs the gate; one whose validation is still
    // running is kept as it is, with no read, however the budget stands.
    await pendingRequests([DATASET]);
    runs = "running";
    contentReads = [];
    const result = await sweepBlockedBidsValidationRequests(env(), 50, 0);
    expect(result.deferred).toBe(0);
    expect(contentReads).toHaveLength(0);
    expect(row().status).toBe("blocked");
  });
});

describe("a request that changes while the sweep works on it is not overwritten", () => {
  // The sweep reads its candidates, spends GitHub calls on each, and writes
  // afterwards. A request made again in between rewrites the row. The writes are
  // conditional on the row still being as it was read, so the verdict reached
  // for the old row is never applied to the new one.

  async function pending(): Promise<void> {
    runs = "none";
    descriptionBody = NAMED;
    expect((await requestPublication()).body.block_reason).toBe("bids_validation_pending");
  }

  test("an anonymous request made mid-run is not released on a verdict about the native one", async () => {
    // The irreversible case: released as `requested`, the name the file still
    // carries would be published under the blind label.
    await pending();
    runs = "success";
    onRunsRead = async () => {
      runs = "none";
      const again = await requestPublication({ anonymous: true });
      expect(again.body.block_reason).toBe("min_requirements_failed");
      runs = "success";
    };
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(0);
      expect(result.skipped).toBe(1);
    });
    expect(dispatches).toBe(0);
    const r = row();
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("min_requirements_failed");
    expect(r.anonymous).toBe(1);
    expect(reasonsOf(r).join(" ")).toContain("still names Ada Lovelace");
  });

  // Each column of the observed row, changed alone so that only its own term of
  // the condition can catch it.
  const CHANGES: Array<[string, string, (r: Row) => void]> = [
    [
      // A denial leaves block_reason and anonymous as they were, and within the
      // same second even updated_at: only the status term can see it.
      "status",
      "UPDATE publication_requests SET status = 'denied' WHERE dataset_id = ?",
      (r) => expect(r.status).toBe("denied"),
    ],
    [
      "anonymous",
      "UPDATE publication_requests SET anonymous = 1 WHERE dataset_id = ?",
      (r) => {
        expect(r.status).toBe("blocked");
        expect(r.anonymous).toBe(1);
      },
    ],
    [
      "block_reason",
      "UPDATE publication_requests SET block_reason = 'bids_validation_in_progress' WHERE dataset_id = ?",
      (r) => {
        expect(r.status).toBe("blocked");
        expect(r.block_reason).toBe("bids_validation_in_progress");
      },
    ],
    [
      "updated_at",
      "UPDATE publication_requests SET updated_at = datetime('now', '+1 hour') WHERE dataset_id = ?",
      (r) => expect(r.status).toBe("blocked"),
    ],
  ];

  for (const [column, sql, afterwards] of CHANGES) {
    test(`release: a change to ${column} alone stops it`, async () => {
      await pending();
      runs = "success";
      onRunsRead = () => {
        db.run(sql, [DATASET]);
      };
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(0);
      expect(result.skipped).toBe(1);
      expect(dispatches).toBe(0);
      afterwards(row());
    });

    test(`minimums re-block: a change to ${column} alone stops it`, async () => {
      await pending();
      runs = "success";
      descriptionBody = SHORT_NAME;
      onRunsRead = () => {
        db.run(sql, [DATASET]);
      };
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.reblocked).toBe(0);
      expect(result.skipped).toBe(1);
      // The reasons for the old row were not written onto the new one.
      expect(row().min_requirements_reasons).toBeNull();
      expect(row().block_reason).not.toBe("min_requirements_failed");
      afterwards(row());
    });

    test(`failing-validation relabel: a change to ${column} alone stops it`, async () => {
      await pending();
      runs = "failure";
      onRunsRead = () => {
        db.run(sql, [DATASET]);
      };
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.reblocked).toBe(0);
      expect(result.skipped).toBe(1);
      expect(row().block_reason).not.toBe("bids_validation_failed");
      afterwards(row());
    });
  }

  test("moving a waiting row to the back does not touch a row that changed in between", async () => {
    await pending();
    runs = "running";
    onRunsRead = () => {
      db.run(
        "UPDATE publication_requests SET anonymous = 1, updated_at = datetime('now', '+1 hour') WHERE dataset_id = ?",
        [DATASET],
      );
    };
    await sweepBlockedBidsValidationRequests(env());
    const age = db
      .query<{ age: number }, []>(
        "SELECT strftime('%s','now') - strftime('%s', updated_at) AS age FROM publication_requests",
      )
      .get()?.age;
    // Still the hour ahead the concurrent request left it at, not 'now'.
    expect(age).toBeLessThan(-3000);
  });

  test("control: with no change in between, the same three writes go through", async () => {
    await pending();
    runs = "failure";
    expect((await sweepBlockedBidsValidationRequests(env())).reblocked).toBe(1);
    expect(row().block_reason).toBe("bids_validation_failed");
    runs = "success";
    descriptionBody = SHORT_NAME;
    // Re-block as failing validation was a relabel; now green with a short Name.
    const second = await sweepBlockedBidsValidationRequests(env());
    expect(second.reblocked).toBe(1);
    expect(second.skipped).toBe(0);
    expect(row().block_reason).toBe("min_requirements_failed");
  });

  test("a release clears the minimums verdict an earlier request recorded", async () => {
    await pending();
    db.run(
      "UPDATE publication_requests SET min_requirements_reasons = '[\"stale reason\"]' WHERE dataset_id = ?",
      [DATASET],
    );
    runs = "success";
    await withFakeResend(async () => {
      expect((await sweepBlockedBidsValidationRequests(env())).unblocked).toBe(1);
    });
    expect(row().status).toBe("requested");
    expect(row().min_requirements_reasons).toBeNull();
  });
});

describe("rows the sweep looks at and leaves are queued behind the rest", () => {
  // Candidates are taken oldest `updated_at` first, `limit` at a time, and a row
  // left as it is used to keep its old `updated_at`, so enough of them filled
  // every run and nothing behind them was ever reached.

  const setAge = (id: string, hoursAgo: number) =>
    db.run("UPDATE publication_requests SET updated_at = datetime('now', ?) WHERE dataset_id = ?", [
      `-${hoursAgo} hours`,
      id,
    ]);

  async function threeRows(): Promise<void> {
    descriptionBody = NAMED;
    runs = "none";
    for (const id of ["nm000530", "nm000531", "nm000532"]) {
      seedDataset(id, { exemplar: id === "nm000532" });
      expect((await requestPublication({ id })).body.block_reason).toBe("bids_validation_pending");
    }
    // The last is the newest, so it is last in line.
    setAge("nm000530", 3);
    setAge("nm000531", 2);
    setAge("nm000532", 1);
  }

  test("rows still waiting on validation do not starve the one behind them", async () => {
    await threeRows();
    runsFor = { nm000530: "running", nm000531: "none", nm000532: "success" };
    const first = await sweepBlockedBidsValidationRequests(env(), 2);
    expect(first.scanned).toBe(2);
    expect(first.unblocked).toBe(0);
    await withFakeResend(async () => {
      const second = await sweepBlockedBidsValidationRequests(env(), 2);
      expect(second.unblocked).toBe(1);
    });
    expect(row("nm000532").status).toBe("requested");
    expect(row("nm000530").status).toBe("blocked");
  });

  test("rows whose files could not be read do not starve the one behind them", async () => {
    await threeRows();
    runs = "success";
    descriptionStatus = 403;
    const first = await sweepBlockedBidsValidationRequests(env(), 2);
    expect(first.scanned).toBe(2);
    expect(first.errors).toBe(2);
    // The third is an exemplar: released without reading anything.
    await withFakeResend(async () => {
      const second = await sweepBlockedBidsValidationRequests(env(), 2);
      expect(second.unblocked).toBe(1);
    });
    expect(row("nm000532").status).toBe("requested");
  });

  test("rows already labelled as failing do not starve the one behind them", async () => {
    await threeRows();
    // Two requests CI already failed and the sweep already relabelled.
    db.run(
      "UPDATE publication_requests SET block_reason = 'bids_validation_failed' WHERE dataset_id IN ('nm000530', 'nm000531')",
    );
    runsFor = { nm000530: "failure", nm000531: "failure", nm000532: "success" };
    expect((await sweepBlockedBidsValidationRequests(env(), 2)).scanned).toBe(2);
    await withFakeResend(async () => {
      expect((await sweepBlockedBidsValidationRequests(env(), 2)).unblocked).toBe(1);
    });
  });

  test("rows whose CI lookup failed do not starve the one behind them", async () => {
    await threeRows();
    runs = "success";
    runsStatus = 403;
    const first = await sweepBlockedBidsValidationRequests(env(), 2);
    expect(first.errors).toBe(2);
    runsStatus = 200;
    // Everything is green now. The row behind the two is reached first; the
    // second place goes to the one of the two the sweep looked at earliest.
    await withFakeResend(async () => {
      expect((await sweepBlockedBidsValidationRequests(env(), 2)).unblocked).toBe(2);
    });
    expect(row("nm000532").status).toBe("requested");
    expect(row("nm000530").status).toBe("requested");
    expect(row("nm000531").status).toBe("blocked");
  });

  test("rows whose dataset has no repository do not starve the one behind them", async () => {
    await threeRows();
    db.run("UPDATE datasets SET github_repo = NULL WHERE dataset_id IN ('nm000530', 'nm000531')");
    runs = "success";
    expect((await sweepBlockedBidsValidationRequests(env(), 2)).scanned).toBe(2);
    await withFakeResend(async () => {
      expect((await sweepBlockedBidsValidationRequests(env(), 2)).unblocked).toBe(1);
    });
  });

  test("a looked-at row keeps its status, reason and flag, and only its position changes", async () => {
    await threeRows();
    runsFor = { nm000530: "running" };
    const before = row("nm000530");
    await sweepBlockedBidsValidationRequests(env(), 1);
    const after = row("nm000530");
    expect(after.status).toBe(before.status);
    expect(after.block_reason).toBe(before.block_reason);
    expect(after.anonymous).toBe(before.anonymous);
    const ages = db
      .query<{ dataset_id: string; age: number }, []>(
        `SELECT dataset_id, strftime('%s','now') - strftime('%s', updated_at) AS age
           FROM publication_requests ORDER BY dataset_id`,
      )
      .all();
    const age = (id: string) => ages.find((a) => a.dataset_id === id)?.age ?? -1;
    // Looked at: the newest of the three now. Not looked at: unchanged.
    expect(age("nm000530")).toBeLessThan(age("nm000532"));
    expect(age("nm000531")).toBeGreaterThanOrEqual(2 * 3600 - 5);
  });

  test("rows not looked at are left where they are: the unblock cap and the read budget", async () => {
    await threeRows();
    runs = "success";
    descriptionBody = NO_ETHICS_FIELD;
    readmeMode = "missing";
    // Budget spent on the first row: the other native one is deferred, not queued.
    const result = await sweepBlockedBidsValidationRequests(env(), 50, 2);
    expect(result.deferred).toBeGreaterThanOrEqual(1);
    const age = db
      .query<{ age: number }, [string]>(
        `SELECT strftime('%s','now') - strftime('%s', updated_at) AS age
           FROM publication_requests WHERE dataset_id = ?`,
      )
      .get("nm000531")?.age;
    expect(age).toBeGreaterThanOrEqual(2 * 3600 - 5);
  });
});
