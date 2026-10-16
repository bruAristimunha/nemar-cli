/**
 * The publication review, end to end (ADR 0102): from a screen result to the administrator's mail,
 * through every piece the phase built, each one the real thing.
 *
 *   the identifier screen's callback  ->  the Worker starts a review and dispatches it
 *   the workflow's own shell steps    ->  validate the dispatch, claim the review (real bash, real curl)
 *   the real job script `main`        ->  reads a real git repository, calls a model, posts the report
 *   the Worker's callback routes      ->  store the report, derive the verdict, re-block a failed minimum
 *   the admin mail, the admin routes and the depositor's status
 *
 * What is real: the Worker's Hono app, served over HTTP by `Bun.serve` (the helper of
 * `backend/test/helpers/publication-review-app.ts`, in the pattern of `pr-queue-app.ts`) on a real
 * bun:sqlite database with every migration; real WebCrypto callback tokens; the workflow's
 * `Validate the dispatch` and `Claim the review` steps, run by `bash` against that server; the job
 * script's `main`, over a real local git repository, with the real Anthropic SDK; the mail
 * service, with Resend redirected at the network boundary.
 *
 * What stands in, and only at a boundary: GitHub's dispatch endpoint (a `Bun.serve` that records
 * the dispatch the Worker sent, whose payload then feeds the workflow's steps as GitHub would), the
 * Anthropic Messages API (a `Bun.serve` that answers the way the API does) and Resend. The request
 * itself is a fixture row, not a call of the depositor's request route (which reads the repository
 * through GitHub); every later step is reached through its own route.
 *
 * The property most likely to go wrong is a chain that passes without exercising the chain: the
 * mail asserted before the review reports, or the job's post never reaching the real route. So the
 * mail count is read at EVERY step, after the work the request deferred has finished, and the
 * chain's last assertions are made on state only the real routes could have written.
 */

import type { Database } from "bun:sqlite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { signIdentifierScreenCallbackToken } from "../backend/src/services/github";
import {
  notifyAdminsOfScreen,
  sweepIdentifierScreens,
} from "../backend/src/services/identifier-screen";
import { sweepPublicationReviews } from "../backend/src/services/publication-review";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import {
  screenReportBodyFor,
  seedScreenedRequest,
  seedUser,
  textOf,
} from "../backend/test/helpers/publication-review";
import { makePublicationReviewApp } from "../backend/test/helpers/publication-review-app";
import {
  type CapturedEmail,
  type ResendSendBody,
  asSend,
  withFakeResend,
} from "../backend/test/helpers/resend";
import { CALLBACK_ORIGINS, main } from "../scripts/ci/publication-review";
import type {
  PublicationReviewDetail,
  StartPublicationReviewResponse,
} from "../shared/contract/publication-review-admin";
import { NOT_ASSESSED_LINE } from "../shared/publication-review";

setDefaultTimeout(60_000);

const ADMIN_KEY = "e2e-admin-key-0123456789abcdef0123456789abcdef";
const DEPOSITOR_KEY = "e2e-depositor-key-0123456789abcdef0123456789abcd";
const ADMIN_EMAIL = "e2eadmin@example.org";
const CALLBACK_SECRET = "e2e-callback-secret";
const GITHUB_PAT = "ghp_e2e_test_token";
const DATASET = "nm000480";
const WORKFLOW = join(
  import.meta.dir,
  "..",
  ".github",
  "dataset-workflows",
  "run-publication-review.yml",
);

// ---------------------------------------------------------------------------------------------
// The stand-ins at the boundaries: GitHub's dispatch endpoint, and the Messages API
// ---------------------------------------------------------------------------------------------

interface Dispatch {
  event_type: string;
  client_payload: Record<string, string | number | boolean>;
}
let dispatches: Dispatch[] = [];
let githubServer: ReturnType<typeof Bun.serve>;

/** What the model stand-in is asked, and how it answers. */
const modelRequests: string[] = [];
let modelStatus = 200;
let modelServer: ReturnType<typeof Bun.serve>;
const MODEL_SUMMARY = "SUMMARY-FROM-THE-MODEL-STAND-IN";

function modelAnswer(): Response {
  if (modelStatus !== 200) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "api_error", message: "unavailable" } }),
      {
        status: modelStatus,
        // The SDK would retry a 5xx with a backoff; the stand-in says it should not.
        headers: { "content-type": "application/json", "x-should-retry": "false" },
      },
    );
  }
  return Response.json({
    id: "msg_stand_in",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          questions: {
            complete_and_honest: "pass",
            meets_standards: "pass",
            authors_and_license: "pass",
            name_adequate: "pass",
          },
          findings: [],
          summary: MODEL_SUMMARY,
          steering: false,
        }),
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

const SDK_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_IDENTITY_TOKEN",
] as const;
const savedSdkEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------------------------
// The Worker, served over HTTP
// ---------------------------------------------------------------------------------------------

const app = makePublicationReviewApp();
let db: Database;
let backend: ReturnType<typeof Bun.serve>;
let backendUrl: string;
let root: string;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: GITHUB_PAT,
    PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
    PUBLICATION_REVIEW_ENABLED: "1",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "publication-review-e2e-"));
  githubServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        dispatches.push((await req.json()) as Dispatch);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${githubServer.port}`;

  modelServer = Bun.serve({
    port: 0,
    async fetch(req) {
      modelRequests.push(await req.text());
      return modelAnswer();
    },
  });
  for (const k of SDK_ENV) {
    savedSdkEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-ant-stand-in";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${modelServer.port}`;

  backend = Bun.serve({ port: 0, fetch: (req) => app.handle(req, env()) });
  backendUrl = `http://127.0.0.1:${backend.port}`;
});

afterAll(() => {
  backend.stop(true);
  githubServer.stop(true);
  modelServer.stop(true);
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  for (const k of SDK_ENV) {
    if (savedSdkEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedSdkEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  db = freshDb();
  dispatches = [];
  modelRequests.length = 0;
  modelStatus = 200;
  await seedUser(db, "e2eadmin", "admin", ADMIN_KEY, {
    email: ADMIN_EMAIL,
    givenName: "Grace",
    familyName: "Hopper",
  });
});

// ---------------------------------------------------------------------------------------------
// A real git repository as the dataset
// ---------------------------------------------------------------------------------------------

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "/",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

const README =
  "# Resting EEG\n\nTwelve volunteers recorded at rest with a 32 channel cap at 256 Hz.\n";

/** The description of a dataset that meets every submission minimum. */
const GOOD_DESCRIPTION = {
  Name: "Resting EEG of healthy volunteers, eyes open and closed",
  BIDSVersion: "1.9.0",
  Version: "1.0.0",
  License: "CC0",
  Authors: ["Ada Lovelace", "Alan Turing"],
  EthicsApprovals: ["IRB 2024-0001, University X"],
};

interface Dataset {
  /** The runner's temp directory, holding `repo`, `tags.txt` and `bids-runs.json`. */
  temp: string;
  head: string;
}

let datasetSeq = 0;

/** A dataset on `main`, laid out as the review job finds it on a runner. */
function newDataset(description: Record<string, unknown> = GOOD_DESCRIPTION): Dataset {
  const temp = join(root, `runner-${++datasetSeq}`);
  const dir = join(temp, "repo");
  const files: Record<string, string> = {
    "dataset_description.json": JSON.stringify(description),
    "README.md": README,
    CHANGES: "1.0.0 2026-01-01\n - Initial release\n",
    LICENSE: "Creative Commons Zero\n",
    "participants.json": JSON.stringify({ participant_id: { Description: "Unique label" } }),
    "sub-01/eeg/sub-01_task-rest_eeg.edf": "recording bytes",
    "sub-01/eeg/sub-01_task-rest_eeg.json": JSON.stringify({
      SamplingFrequency: 256,
      EEGChannelCount: 32,
    }),
  };
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  const head = git(dir, "rev-parse", "HEAD");
  // What the workflow's own steps leave beside the clone: the tags and the BIDS validation runs.
  writeFileSync(join(temp, "tags.txt"), "");
  writeFileSync(
    join(temp, "bids-runs.json"),
    JSON.stringify({
      total_count: 1,
      workflow_runs: [
        {
          id: 1,
          status: "completed",
          conclusion: "success",
          head_sha: head,
          created_at: "2026-10-01T00:00:00Z",
        },
      ],
    }),
  );
  return { temp, head };
}

// ---------------------------------------------------------------------------------------------
// The workflow's own shell steps, run for real
// ---------------------------------------------------------------------------------------------

interface Step {
  name?: string;
  run?: string;
}
const workflow = parse(readFileSync(WORKFLOW, "utf8")) as { jobs: { review: { steps: Step[] } } };

function stepNamed(name: string): Step {
  const s = workflow.jobs.review.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step named "${name}"`);
  return s;
}

async function runStep(name: string, temp: string, stepEnv: Record<string, string>) {
  const out = join(temp, `output-${name.replaceAll(/\W+/g, "-")}`);
  const genv = join(temp, `env-${name.replaceAll(/\W+/g, "-")}`);
  writeFileSync(out, "");
  writeFileSync(genv, "");
  const file = join(temp, `step-${name.replaceAll(/\W+/g, "-")}.sh`);
  writeFileSync(file, stepNamed(name).run ?? "");
  // Async on purpose: a synchronous spawn would block the event loop the Worker is served on.
  const proc = Bun.spawn(["bash", "-e", file], {
    cwd: temp,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      RUNNER_TEMP: temp,
      HOME: temp,
      GITHUB_OUTPUT: out,
      GITHUB_ENV: genv,
      ...stepEnv,
    },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    status,
    stdout,
    stderr,
    output: readFileSync(out, "utf8"),
    envFile: readFileSync(genv, "utf8"),
  };
}

/** What the runner's job env holds, read out of the dispatch the Worker sent. */
function jobEnv(d: Dispatch): Record<string, string> {
  const p = d.client_payload;
  return {
    DATASET_ID: String(p.dataset_id),
    REQUEST_ID: String(p.request_id),
    REVIEW_ID: String(p.review_id),
    HEAD_SHA: String(p.head_sha),
    ANONYMOUS: String(p.anonymous),
    ENVIRONMENT: String(p.environment),
    PUBLICATION_REVIEW_CALLBACK_TOKEN: String(p.callback_token),
  };
}

/**
 * The job, as the workflow runs it: validate the dispatch, claim the review (the Worker's real
 * claim route over HTTP), and, when the claim was taken, run the review script with the arguments
 * read out of the workflow's own `Review` step. Everything a runner does for a review.
 */
async function runWorkflow(d: Dispatch, ds: Dataset, claimToken?: string) {
  const base = jobEnv(d);
  const validated = await runStep("Validate the dispatch", ds.temp, base);
  expect(validated.status, validated.stderr).toBe(0);
  // The origin is chosen from the fixed table, by the environment's NAME.
  expect(validated.envFile).toBe(`ORIGIN=${CALLBACK_ORIGINS.production}\n`);

  // The one departure from a runner: the table's host is this suite's Worker.
  const claimEnv = {
    ...base,
    ORIGIN: backendUrl,
    ...(claimToken ? { PUBLICATION_REVIEW_CALLBACK_TOKEN: claimToken } : {}),
  };
  const claim = await runStep("Claim the review", ds.temp, claimEnv);
  const claimed = claim.output.trim() === "claimed=true";
  if (!claimed) return { claimed, claim, exit: null as number | null, log: [] as string[] };

  const values: Record<string, string> = {
    RUNNER_TEMP: ds.temp,
    HEAD_SHA: base.HEAD_SHA,
    FETCHED_SHA: git(join(ds.temp, "repo"), "rev-parse", "HEAD"),
    REVIEW_ID: base.REVIEW_ID,
    REQUEST_ID: base.REQUEST_ID,
    DATASET_ID: base.DATASET_ID,
    ANONYMOUS: base.ANONYMOUS,
    ENVIRONMENT: base.ENVIRONMENT,
  };
  const argv = ["review"];
  for (const m of (stepNamed("Review").run ?? "").matchAll(/--([a-z-]+) "\$(\w+)(\/[\w.-]+)?"/g)) {
    const value = values[m[2] as string];
    expect(value, `${m[1]}: ${m[2]}`).toBeDefined();
    argv.push(`--${m[1]}`, `${value}${m[3] ?? ""}`);
  }

  process.env.PUBLICATION_REVIEW_CALLBACK_TOKEN = base.PUBLICATION_REVIEW_CALLBACK_TOKEN;
  const log: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => void log.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void log.push(a.map(String).join(" "));
  let exit: number;
  try {
    exit = await main(argv, { production: backendUrl, dev: backendUrl });
  } finally {
    Object.assign(console, original);
    Reflect.deleteProperty(process.env, "PUBLICATION_REVIEW_CALLBACK_TOKEN");
  }
  return { claimed, claim, exit, log };
}

// ---------------------------------------------------------------------------------------------
// Reading the Worker
// ---------------------------------------------------------------------------------------------

/** The screen job's own post, to the Worker's real route. */
async function postScreenResult(requestId: number, head: string) {
  const token = await signIdentifierScreenCallbackToken(
    { datasetId: DATASET, requestId, nonce: "n" },
    CALLBACK_SECRET,
  );
  const res = await fetch(`${backendUrl}/webhooks/identifier-screen-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
    body: JSON.stringify({
      dataset_id: DATASET,
      request_id: requestId,
      report: screenReportBodyFor(DATASET, "clean", head),
    }),
  });
  return res.status;
}

const adminHeaders = { Authorization: `Bearer ${ADMIN_KEY}` };

async function adminReview(): Promise<PublicationReviewDetail> {
  const res = await fetch(`${backendUrl}/admin/publish/${DATASET}/review`, {
    headers: adminHeaders,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PublicationReviewDetail;
}

function reviews() {
  return db.query("SELECT * FROM publication_reviews ORDER BY id").all() as Record<
    string,
    unknown
  >[];
}

function requestRow(id: number) {
  return db.query("SELECT * FROM publication_requests WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

/** The mail the administrator received, after everything the requests deferred has run. */
async function adminMails(calls: CapturedEmail[]): Promise<ResendSendBody[]> {
  await app.settled();
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((b) => b.to.includes(ADMIN_EMAIL));
}

/** A depositor's request whose identifier screen is running, and whose mail has not gone out. */
async function pendingRequest() {
  const { requestId, userId } = seedScreenedRequest(db, { datasetId: DATASET, status: "pending" });
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    userId,
    await hashApiKey(DEPOSITOR_KEY),
    DEPOSITOR_KEY.slice(0, 8),
  );
  expect(requestRow(requestId)).toMatchObject({
    status: "requested",
    identifier_screen_status: "pending",
    identifier_screen_emailed_at: null,
  });
  return requestId;
}

/** Both watchdogs, as the cron tick runs them: neither may send a mail a review still holds. */
async function tick() {
  await sweepIdentifierScreens(env());
  await sweepPublicationReviews(env());
}

// ---------------------------------------------------------------------------------------------

describe("a request whose review passes", () => {
  test("screen result, dispatch, claim, report: one admin mail, after the review and never before", async () => {
    await withFakeResend(async (calls) => {
      const ds = newDataset();
      const requestId = await pendingRequest();

      // Step 0: the request waits for its screen. Nothing has been sent to anyone.
      expect(await adminMails(calls)).toHaveLength(0);
      expect(reviews()).toHaveLength(0);

      // Step 1: the screen reports, through the real route.
      expect(await postScreenResult(requestId, ds.head)).toBe(200);
      await app.settled();
      expect(requestRow(requestId)).toMatchObject({ identifier_screen_status: "clean" });
      // A review was started for exactly the screened commit, and handed to GitHub.
      expect(reviews()).toHaveLength(1);
      expect(reviews()[0]).toMatchObject({
        request_id: requestId,
        head_sha: ds.head,
        anonymous: 0,
        state: "dispatched",
        claimed_at: null,
      });
      expect(dispatches).toHaveLength(1);
      const [dispatch] = dispatches as [Dispatch];
      expect(dispatch.event_type).toBe("run-publication-review");
      expect(dispatch.client_payload).toMatchObject({
        dataset_id: DATASET,
        request_id: requestId,
        review_id: reviews()[0]?.id,
        head_sha: ds.head,
        anonymous: false,
        environment: "production",
      });
      // MAIL: the screen is in, but the mail waits for the review. Nothing yet.
      expect(await adminMails(calls)).toHaveLength(0);
      expect(requestRow(requestId).identifier_screen_emailed_at).toBeNull();

      // Step 2: the watchdogs tick while the review is young. They hold the mail too.
      await tick();
      expect(await adminMails(calls)).toHaveLength(0);
      expect(reviews()[0]?.state).toBe("dispatched");

      // The administrator can see it is running, not that it passed.
      const running = await adminReview();
      expect(running.outcome).toBe("action_required");
      expect(running.reasons.map((r) => r.code)).toEqual(["review_running"]);

      // Step 3: the workflow validates and CLAIMS the review. No model has been called.
      expect(modelRequests).toHaveLength(0);
      // (The job itself runs below; its claim is the first thing it does.)
      const job = await runWorkflow(dispatch, ds);
      expect(job.claimed).toBe(true);
      expect(job.claim.stdout).toContain("claimed");
      expect(job.exit).toBe(0);
      // The job's own public log line: ids and fixed words.
      const reviewId = reviews()[0]?.id as number;
      expect(job.log).toContain(
        `review ${reviewId} (request ${requestId}): reported; callback delivered`,
      );
      // The model saw the real README, once.
      expect(modelRequests).toHaveLength(1);
      expect(modelRequests[0]).toContain("Twelve volunteers recorded at rest");

      // The report was stored by the real route, which derived the verdict itself.
      expect(reviews()[0]).toMatchObject({
        state: "reported",
        verdict: "pass",
        nonce: null,
        head_sha: ds.head,
      });
      expect(reviews()[0]?.claimed_at).not.toBeNull();
      expect(requestRow(requestId).status).toBe("requested");

      // MAIL: exactly one, now, carrying the review's section.
      const mails = await adminMails(calls);
      expect(mails).toHaveLength(1);
      const text = textOf(mails[0]?.html ?? "");
      expect(text).toContain("Publication review: pass");
      expect(text).toContain(NOT_ASSESSED_LINE);
      expect(text).toContain(`nemar admin publish approve ${DATASET}`);
      // The model's own words are not in the mail, and no token or nonce is.
      expect(text).not.toContain(MODEL_SUMMARY);
      expect(mails[0]?.html).not.toContain(String(dispatch.client_payload.callback_token));
      expect(requestRow(requestId).identifier_screen_emailed_at).not.toBeNull();

      // Step 4: nothing sends it again, whatever tries.
      await tick();
      expect(await notifyAdminsOfScreen(env(), requestId)).toBe("not-claimed");
      expect(await adminMails(calls)).toHaveLength(1);

      // The administrator reads the verdict the Worker derived, and the model's summary only here.
      const done = await adminReview();
      expect(done.outcome).toBe("pass");
      expect(done.reasons).toEqual([]);
      expect(done.review?.state).toBe("reported");
      expect(done.review?.summary).toContain(MODEL_SUMMARY);
      // A replay of the job's report finds the token spent.
      const replay = await runWorkflow(dispatch, ds);
      expect(replay.claimed).toBe(false);
      expect(replay.claim.stdout).toContain("nothing was spent");
      expect(modelRequests).toHaveLength(1);
      expect(await adminMails(calls)).toHaveLength(1);
    });
  });
});

describe("a request whose submission minimum failed at the reviewed commit", () => {
  test("the depositor sees it blocked and the review is stored; the admin is mailed once, after", async () => {
    await withFakeResend(async (calls) => {
      // A title too short to be descriptive: a minimum the review re-checks at the reviewed commit.
      const ds = newDataset({ ...GOOD_DESCRIPTION, Name: "EEG" });
      const requestId = await pendingRequest();

      expect(await postScreenResult(requestId, ds.head)).toBe(200);
      await app.settled();
      expect(reviews()).toHaveLength(1);
      expect(dispatches).toHaveLength(1);
      // MAIL: none before the review.
      expect(await adminMails(calls)).toHaveLength(0);
      expect(requestRow(requestId).status).toBe("requested");

      const job = await runWorkflow(dispatches[0] as Dispatch, ds);
      expect(job.claimed).toBe(true);
      expect(job.exit).toBe(0);

      // The review is stored.
      const reviewId = reviews()[0]?.id as number;
      expect(reviews()[0]).toMatchObject({ state: "reported", nonce: null });
      const stored = JSON.parse(String(reviews()[0]?.report));
      expect(stored.evidence).toMatchObject({
        head: ds.head,
        minimums: "failed",
        minimum_failures: ["name_too_short"],
      });

      // The request is re-blocked, with a generic sentence and never a word from the dataset.
      expect(requestRow(requestId)).toMatchObject({
        status: "blocked",
        block_reason: "min_requirements_failed",
      });
      const reasons = JSON.parse(
        String(requestRow(requestId).min_requirements_reasons),
      ) as string[];
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("at least");

      // The depositor can see it through the route they use, and nothing the model wrote.
      const status = await fetch(`${backendUrl}/datasets/${DATASET}/publish/status`, {
        headers: { Authorization: `Bearer ${DEPOSITOR_KEY}` },
      });
      expect(status.status).toBe(200);
      const text = await status.text();
      expect(JSON.parse(text)).toMatchObject({
        status: "blocked",
        block_reason: "min_requirements_failed",
        reasons,
      });
      expect(text).not.toContain(MODEL_SUMMARY);

      // MAIL: exactly one, after the review, about the blocked request, with the review's section.
      const mails = await adminMails(calls);
      expect(mails).toHaveLength(1);
      expect(textOf(mails[0]?.html ?? "")).toContain("Publication review:");
      expect(textOf(mails[0]?.html ?? "")).not.toContain(MODEL_SUMMARY);

      // The administrator's view: the review is the reviewed commit's, and not a pass.
      const detail = await adminReview();
      expect(detail.request_status).toBe("blocked");
      expect(detail.outcome).not.toBe("pass");
      expect(detail.review?.id).toBe(reviewId);

      // Nothing sends the mail again.
      await tick();
      expect(await adminMails(calls)).toHaveLength(1);
    });
  });
});

describe("a job that posts an error word", () => {
  test("the model fails: the review says so, one mail, and an administrator's start runs it again", async () => {
    await withFakeResend(async (calls) => {
      const ds = newDataset();
      const requestId = await pendingRequest();
      expect(await postScreenResult(requestId, ds.head)).toBe(200);
      await app.settled();
      expect(await adminMails(calls)).toHaveLength(0);
      const first = dispatches[0] as Dispatch;

      // The model is down: the real script posts the closed word for it, through the real route.
      modelStatus = 500;
      const failed = await runWorkflow(first, ds);
      expect(failed.claimed).toBe(true);
      expect(failed.exit).toBe(0);
      expect(failed.log.some((l) => l.includes("error (model_unavailable"))).toBe(true);
      expect(modelRequests).toHaveLength(1);
      const reviewId = reviews()[0]?.id as number;
      expect(reviews()[0]).toMatchObject({
        state: "errored",
        detail: "model_unavailable",
        verdict: null,
        nonce: null,
      });
      // The request is untouched: an error word re-blocks nothing.
      expect(requestRow(requestId).status).toBe("requested");

      // MAIL: one, after the failure, and it says the review could not run (never a pass).
      const mails = await adminMails(calls);
      expect(mails).toHaveLength(1);
      const text = textOf(mails[0]?.html ?? "");
      expect(text).toContain("Publication review: action required");
      expect(text).not.toContain("Publication review: pass");
      const detail = await adminReview();
      expect(detail.outcome).toBe("action_required");
      expect(detail.reasons.map((r) => r.code)).toContain("review_could_not_run");

      // The administrator starts it again, through the real route.
      modelStatus = 200;
      const start = await fetch(`${backendUrl}/admin/publish/${DATASET}/review/start`, {
        method: "POST",
        headers: adminHeaders,
      });
      expect(start.status).toBe(202);
      expect((await start.json()) as StartPublicationReviewResponse).toEqual({
        environment: "production",
        started: true,
        reason: "redispatched",
        review_id: reviewId,
      });
      expect(dispatches).toHaveLength(2);
      const second = dispatches[1] as Dispatch;
      expect(second.client_payload.callback_token).not.toBe(first.client_payload.callback_token);
      expect(reviews()[0]).toMatchObject({ state: "dispatched", claimed_at: null, attempts: 2 });
      const audit = db
        .query("SELECT * FROM audit_log WHERE action = 'publication_review_started'")
        .all() as Record<string, unknown>[];
      expect(audit).toHaveLength(1);
      expect(JSON.parse(String(audit[0]?.details))).toEqual({
        request_id: requestId,
        review_id: reviewId,
        reason: "redispatched",
        head_sha: ds.head,
      });

      // The first run's token was replaced: it can no longer claim, and spends nothing.
      const stale = await runWorkflow(second, ds, String(first.client_payload.callback_token));
      expect(stale.claimed).toBe(false);
      expect(modelRequests).toHaveLength(1);
      // The mail already went once; a start alone sends none.
      expect(await adminMails(calls)).toHaveLength(1);

      // The second run claims, reads the repository again, and reports.
      const again = await runWorkflow(second, ds);
      expect(again.claimed).toBe(true);
      expect(again.exit).toBe(0);
      expect(modelRequests).toHaveLength(2);
      expect(reviews()[0]).toMatchObject({ state: "reported", verdict: "pass", nonce: null });
      expect((await adminReview()).outcome).toBe("pass");
      // This screen result's mail went once, and a later pass does not send another.
      expect(await adminMails(calls)).toHaveLength(1);
    });
  });
});
