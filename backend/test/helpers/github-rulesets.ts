/**
 * A `Bun.serve()` stand-in for the parts of api.github.com that put a ruleset on a dataset
 * repository, read it back and take it off again, and for the reads `ensureRepoToSpec` makes around
 * that (ADR 0107).
 *
 * It keeps state, because the property under test is what a repository holds after a call: rulesets
 * live per repository, `POST` makes one and refuses a name the repository already uses, `PUT` and
 * `DELETE` answer 404 for an id it does not hold, and the list endpoint leaves out organization
 * rulesets only when asked for `includes_parents=false`, which is exactly how an inherited ruleset
 * of the same name would be mistaken for a repository's own. A write is checked against what
 * GitHub documents about the body: target, enforcement, bypass actor types and modes, the ref_name
 * condition of a branch or tag ruleset, and the parameters of a required_status_checks rule
 * (a boolean strict policy, a list of checks that each name a context, an integer integration id
 * where one is given, a boolean do_not_enforce_on_create). A field that is missing (so a
 * misspelled name) or of the wrong type is a 422 here as it is there.
 *
 * Install it with `globalThis.NEMAR_GITHUB_API_URL = standIn.url`, as the other GitHub stand-ins do,
 * and restore that in `afterAll`.
 */

import type { Server } from "bun";
import { NEMAR_APP_ID, getWorkflowTemplates } from "../../src/services/github";
import {
  __seedInstallationTokenCacheForTests,
  invalidateInstallationToken,
} from "../../src/services/github-auth";

export interface RulesetRecord {
  id: number;
  name: string;
  source_type: "Repository" | "Organization";
  /** The body as written, so a read-back shows what GitHub would hold. */
  body: Record<string, unknown>;
}

export interface StandInCall {
  method: string;
  path: string;
  search: string;
  /** The Authorization header, as sent. */
  auth: string | null;
  body: Record<string, unknown> | null;
}

export interface RulesetStandIn {
  url: string;
  calls: StandInCall[];
  /** Each repository's OWN rulesets. */
  rulesets: Map<string, RulesetRecord[]>;
  /** Organization rulesets, listed for every repository unless `includes_parents=false`. */
  orgRulesets: RulesetRecord[];
  /** A repository's default branch ("main" if absent); `null` makes the repository answer 404. */
  defaultBranches: Map<string, string | null>;
  /**
   * Repositories that have no `main` branch: `GET /branches/main` answers 404 for them until the
   * default branch is renamed to `main`, which is what ensureMainBranch does then.
   */
  missingMain: Set<string>;
  /** The conclusion of the BIDS check on a repository's head ("success" if absent). */
  bidsConclusion: Map<string, string>;
  /**
   * Answer the next `times` requests that match with `status` and no work done. Use a status the
   * transport does not retry (403, 422), or the test waits out its backoff.
   */
  failNext(method: string, path: RegExp, status: number, times?: number): void;
  /**
   * Run `run` once, just before the next request that matches is handled, so a test can change
   * what GitHub holds at the moment between two of the caller's requests (a ruleset that somebody
   * else deletes after it was listed, or creates before it is written).
   */
  beforeNext(method: string, path: RegExp, run: () => void): void;
  /**
   * Apply the next `times` requests that match, and then answer each with `status` in place of
   * the answer GitHub gave: a write that GitHub processed and whose answer was lost to a gateway
   * error (a 502). A request that GitHub refused keeps its own refusal. Use a status the transport
   * retries (500 and up), and the retry is a second write of the same body.
   */
  failAfterWriting(method: string, path: RegExp, status: number, times?: number): void;
  /** Requests that changed something: every method but GET. */
  writes(): StandInCall[];
  /** The writes to rulesets only. */
  rulesetWrites(): StandInCall[];
  reset(): void;
  stop(): void;
}

/** An installation id no real installation has, so the seeded token cannot be taken for one. */
export const STAND_IN_INSTALLATION_ID = 7_654_321;

/**
 * The App configuration a Worker needs for the review check to be postable (ADR 0107): the NEMAR
 * App's id, a private key and an installation id for nemarDatasets, which is what leaves the
 * Worker signing in as the App and not falling back to the personal access token. Spread it into
 * a test's environment, and call {@link seedStandInAppToken} in `beforeAll`.
 *
 * The key is deliberately not a key. A token for the installation is put in the module's cache
 * instead, so nothing is ever minted; and if the cache were ever to miss, signing would throw
 * before any request is made. Nothing configured here can reach GitHub.
 */
export const REVIEW_APP_BINDINGS = {
  GITHUB_APP_ID: String(NEMAR_APP_ID),
  GITHUB_APP_PRIVATE_KEY: "not a private key: a seeded token stands in for the one it would mint",
  GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: String(STAND_IN_INSTALLATION_ID),
};

/** Put `token` where `getDatasetsToken` finds it for the stand-in installation. */
export function seedStandInAppToken(token: string): void {
  __seedInstallationTokenCacheForTests(
    STAND_IN_INSTALLATION_ID,
    token,
    Date.now() + 2 * 60 * 60 * 1000,
  );
}

/** Take the seeded token out again, in `afterAll`, so no later test file finds it. */
export function dropStandInAppToken(): void {
  invalidateInstallationToken(STAND_IN_INSTALLATION_ID);
}

const ACTOR_TYPES = new Set([
  "Integration",
  "OrganizationAdmin",
  "RepositoryRole",
  "Team",
  "DeployKey",
  "User",
]);
const BYPASS_MODES = new Set(["always", "pull_request"]);
const TARGETS = new Set(["branch", "tag", "push"]);
const ENFORCEMENTS = new Set(["active", "disabled", "evaluate"]);

/**
 * The reason GitHub would refuse a required_status_checks rule's parameters, or null. `integration_id`
 * is optional (an unpinned check omits it) and an integer when it is there.
 */
function statusChecksRefusal(parameters: unknown): string | null {
  if (typeof parameters !== "object" || parameters === null) {
    return "required_status_checks needs parameters";
  }
  const p = parameters as Record<string, unknown>;
  if (typeof p.strict_required_status_checks_policy !== "boolean") {
    return "strict_required_status_checks_policy must be a boolean";
  }
  if (p.do_not_enforce_on_create !== undefined && typeof p.do_not_enforce_on_create !== "boolean") {
    return "do_not_enforce_on_create must be a boolean";
  }
  if (!Array.isArray(p.required_status_checks)) return "required_status_checks must be an array";
  for (const check of p.required_status_checks as Array<Record<string, unknown> | null>) {
    if (typeof check !== "object" || check === null || typeof check.context !== "string") {
      return "every required status check needs a context";
    }
    if (check.context === "") return "a required status check's context cannot be empty";
    if (check.integration_id !== undefined && !Number.isInteger(check.integration_id)) {
      return "integration_id must be an integer";
    }
  }
  return null;
}

/** The reason GitHub would refuse a branch or tag ruleset's ref_name condition, or null. */
function refNameRefusal(conditions: unknown): string | null {
  const ref =
    typeof conditions === "object" && conditions !== null
      ? (conditions as { ref_name?: unknown }).ref_name
      : undefined;
  if (typeof ref !== "object" || ref === null) {
    return "conditions.ref_name is required for a branch or tag ruleset";
  }
  for (const key of ["include", "exclude"] as const) {
    const patterns = (ref as Record<string, unknown>)[key];
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) {
      return `conditions.ref_name.${key} must be an array of strings`;
    }
  }
  return null;
}

/** The reasons GitHub would refuse a ruleset body with a 422, or null when it would take it. */
function refusal(body: Record<string, unknown> | null): string | null {
  if (!body) return "body is not an object";
  if (typeof body.name !== "string" || body.name === "") return "name is required";
  if (typeof body.target !== "string" || !TARGETS.has(body.target)) return "target is invalid";
  if (typeof body.enforcement !== "string" || !ENFORCEMENTS.has(body.enforcement)) {
    return "enforcement is invalid";
  }
  if (body.target === "branch" || body.target === "tag") {
    const why = refNameRefusal(body.conditions);
    if (why) return why;
  }
  if (!Array.isArray(body.rules)) return "rules must be an array";
  for (const rule of body.rules) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      typeof (rule as { type?: unknown }).type !== "string"
    ) {
      return "every rule needs a type";
    }
    if ((rule as { type: string }).type === "required_status_checks") {
      const why = statusChecksRefusal((rule as { parameters?: unknown }).parameters);
      if (why) return why;
    }
  }
  if (body.bypass_actors !== undefined) {
    if (!Array.isArray(body.bypass_actors)) return "bypass_actors must be an array";
    for (const actor of body.bypass_actors as Array<Record<string, unknown>>) {
      if (typeof actor.actor_type !== "string" || !ACTOR_TYPES.has(actor.actor_type)) {
        return "bypass actor type is invalid";
      }
      if (typeof actor.bypass_mode !== "string" || !BYPASS_MODES.has(actor.bypass_mode)) {
        return "bypass mode is invalid";
      }
      if (
        (actor.actor_type === "Integration" || actor.actor_type === "RepositoryRole") &&
        !Number.isInteger(actor.actor_id)
      ) {
        return "this bypass actor needs an integer id";
      }
    }
  }
  return null;
}

const summary = (r: RulesetRecord, repo: string) => ({
  id: r.id,
  name: r.name,
  target: r.body.target,
  source_type: r.source_type,
  source: r.source_type === "Repository" ? `nemarDatasets/${repo}` : "nemarDatasets",
  enforcement: r.body.enforcement,
});

export function startRulesetStandIn(): RulesetStandIn {
  const calls: StandInCall[] = [];
  const rulesets = new Map<string, RulesetRecord[]>();
  const orgRulesets: RulesetRecord[] = [];
  const defaultBranches = new Map<string, string | null>();
  const bidsConclusion = new Map<string, string>();
  const missingMain = new Set<string>();
  const failures: Array<{ method: string; path: RegExp; status: number; remaining: number }> = [];
  const hooks: Array<{ method: string; path: RegExp; run: () => void }> = [];
  const lateFailures: Array<{ method: string; path: RegExp; status: number; remaining: number }> =
    [];
  let nextId = 1000;

  /** Answer one request, once the failures and hooks have had their say. Synchronous: the body is already read. */
  const respond = (method: string, url: URL, body: Record<string, unknown> | null): Response => {
    if (url.pathname === "/orgs/nemarDatasets/members") return Response.json([]);

    const m = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)(\/.*)?$/);
    if (!m) return new Response("{}", { status: 404 });
    const repo = decodeURIComponent(m[1]);
    const rest = m[2] ?? "";
    const branch = defaultBranches.has(repo) ? defaultBranches.get(repo) : "main";
    if (branch === null || branch === undefined) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const own = rulesets.get(repo) ?? [];

    if (rest === "") {
      if (method === "GET") return Response.json({ name: repo, default_branch: branch });
      if (method === "PATCH") {
        // The one repository setting a test follows is the default branch, which is what
        // ensureMainBranch repoints; a visibility or auto-merge PATCH carries no such field.
        if (typeof body?.default_branch === "string") {
          defaultBranches.set(repo, body.default_branch);
        }
        return Response.json({ name: repo });
      }
    }
    // A repository has a `main` branch to repoint to, unless it is in `missingMain`: then the
    // default branch is renamed to `main`, and that is how it gets one.
    if (rest === "/branches/main" && method === "GET") {
      return missingMain.has(repo)
        ? Response.json({ message: "Branch not found" }, { status: 404 })
        : Response.json({ name: "main" });
    }
    if (/^\/branches\/[^/]+\/rename$/.test(rest) && method === "POST") {
      if (body?.new_name === "main") {
        defaultBranches.set(repo, "main");
        missingMain.delete(repo);
      }
      return Response.json({ name: body?.new_name }, { status: 201 });
    }

    if (rest === "/rulesets") {
      if (method === "GET") {
        const parents = url.searchParams.get("includes_parents") !== "false";
        const listed = [...own, ...(parents ? orgRulesets : [])];
        return Response.json(listed.map((r) => summary(r, repo)));
      }
      if (method === "POST") {
        const why = refusal(body);
        if (why)
          return Response.json({ message: "Validation Failed", errors: [why] }, { status: 422 });
        if (own.some((r) => r.name === body?.name)) {
          return Response.json(
            { message: "Validation Failed", errors: ["Name must be unique"] },
            { status: 422 },
          );
        }
        const record: RulesetRecord = {
          id: ++nextId,
          name: String(body?.name),
          source_type: "Repository",
          body: body as Record<string, unknown>,
        };
        rulesets.set(repo, [...own, record]);
        return Response.json({ id: record.id, ...record.body }, { status: 201 });
      }
    }

    const one = rest.match(/^\/rulesets\/(\d+)$/);
    if (one) {
      const id = Number(one[1]);
      const record = own.find((r) => r.id === id);
      if (!record) return Response.json({ message: "Not Found" }, { status: 404 });
      if (method === "GET") return Response.json({ id: record.id, ...record.body });
      if (method === "PUT") {
        const why = refusal(body);
        if (why)
          return Response.json({ message: "Validation Failed", errors: [why] }, { status: 422 });
        record.name = String(body?.name);
        record.body = body as Record<string, unknown>;
        return Response.json({ id: record.id, ...record.body });
      }
      if (method === "DELETE") {
        rulesets.set(
          repo,
          own.filter((r) => r.id !== id),
        );
        return new Response(null, { status: 204 });
      }
    }

    if (rest === "/contents/.github/workflows" && method === "GET") {
      // Every workflow the Worker would deploy is already there.
      return Response.json(getWorkflowTemplates().map((w) => ({ path: w.path, type: "file" })));
    }
    if (/^\/commits\/[^/]+\/check-runs$/.test(rest) && method === "GET") {
      return Response.json({
        check_runs: [
          {
            name: "Run BIDS Validation",
            conclusion: bidsConclusion.get(repo) ?? "success",
            app: { id: 3679074 },
          },
        ],
      });
    }
    if (/^\/commits\/[^/]+\/status$/.test(rest) && method === "GET") {
      return Response.json({ statuses: [] });
    }
    if (rest === "/collaborators" && method === "GET") return Response.json([]);
    if (/^\/collaborators\/[^/]+$/.test(rest) && (method === "PUT" || method === "DELETE")) {
      return new Response(null, { status: 204 });
    }

    return Response.json({ message: `no stand-in for ${method} ${url.pathname}` }, { status: 404 });
  };

  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;
      const body =
        method === "GET" || method === "DELETE"
          ? null
          : ((await req.json().catch(() => null)) as Record<string, unknown> | null);
      calls.push({
        method,
        path: url.pathname,
        search: url.search,
        auth: req.headers.get("Authorization"),
        body,
      });

      const hook = hooks.findIndex((h) => h.method === method && h.path.test(url.pathname));
      if (hook >= 0) hooks.splice(hook, 1)[0].run();

      const failure = failures.find(
        (f) => f.remaining > 0 && f.method === method && f.path.test(url.pathname),
      );
      if (failure) {
        failure.remaining--;
        return Response.json({ message: "refused by the stand-in" }, { status: failure.status });
      }

      const response = respond(method, url, body);
      const late = lateFailures.find(
        (f) => f.remaining > 0 && f.method === method && f.path.test(url.pathname),
      );
      if (late && response.ok) {
        late.remaining--;
        return Response.json({ message: "answered late by the stand-in" }, { status: late.status });
      }
      return response;
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    rulesets,
    orgRulesets,
    defaultBranches,
    missingMain,
    bidsConclusion,
    failNext(method, path, status, times = 1) {
      failures.push({ method, path, status, remaining: times });
    },
    beforeNext(method, path, run) {
      hooks.push({ method, path, run });
    },
    failAfterWriting(method, path, status, times = 1) {
      lateFailures.push({ method, path, status, remaining: times });
    },
    writes: () => calls.filter((c) => c.method !== "GET"),
    rulesetWrites: () => calls.filter((c) => c.method !== "GET" && c.path.includes("/rulesets")),
    reset() {
      calls.length = 0;
      rulesets.clear();
      orgRulesets.length = 0;
      defaultBranches.clear();
      missingMain.clear();
      bidsConclusion.clear();
      failures.length = 0;
      hooks.length = 0;
      lateFailures.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}
