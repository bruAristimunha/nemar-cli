/**
 * Live end-to-end tests for `nemar auth login`/`signup`/`status`/`keys`/
 * `logout` over the device authorization grant (RFC 8628; epic #1272 phase
 * 3, #1283; ADR 0047) -- the CLI subprocess half of what
 * test/auth-device-flow.test.ts already drives directly against the REST
 * routes.
 *
 * Targets a deployed backend (set TEST_API_URL; defaults to api.nemar.org
 * per test/setup.ts). The dev worker deploys only from `dev`
 * (a call from .github/workflows/auto-bump-dev.yml to deploy-backend.yml), so this phase's
 * CLI-facing wiring is not guaranteed to
 * be live on whatever backend TEST_API_URL points at until the epic branch
 * reaches dev. This file probes `POST /auth/device/start` first; a 404
 * means the routes are not deployed yet, and every case below skips itself
 * with a loud console message rather than failing.
 *
 * Prod-traffic safeguard, matching test/auth-device-flow.test.ts and
 * test/auth-passwordless.test.ts: if TEST_API_URL points at api.nemar.org or
 * data.nemar.org, the suite skips itself unless TEST_ALLOW_PROD=1.
 *
 * The CLI side runs as a REAL subprocess (`bun run src/index.ts ...`),
 * streamed so a test can read the printed user code off stdout and act on
 * it from the "browser" side (a seeded web session, via the same
 * `POST /auth/code/request` + echoed `dev_code` + `POST /auth/code/verify`
 * passwordless flow test/auth-device-flow.test.ts uses) while the CLI is
 * still polling in the background.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { machineName } from "../src/lib/device-login";
import "./setup";
import { LIVE_TARGET_BLOCKED, TEST_CONFIG } from "./setup";

const API = TEST_CONFIG.apiUrl;
const ORIGIN = "https://app.nemar.org";
const POINTS_AT_PROD = API.includes("api.nemar.org") || API.includes("data.nemar.org");
// `LIVE_TARGET_BLOCKED` rather than a local `!process.env.TEST_ALLOW_PROD`: raw
// truthiness disarms this guard for `TEST_ALLOW_PROD=0`, which is someone saying NO
// and used to send MORE traffic to production than leaving it unset. The shared flag
// is the strict opt-in (test/live-target.ts), so the two halves cannot disagree.
const PROD_GUARD_ACTIVE = LIVE_TARGET_BLOCKED;

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const baseHeaders: Record<string, string> = TEST_CONFIG.bypassToken
  ? { "X-Test-Bypass": TEST_CONFIG.bypassToken }
  : {};

function freshEmail(label: string): string {
  return `dcli-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nemar.test`;
}

/** A format-valid, NOT real, ORCID iD (shared/contract/publication.ts's
 *  orcidIdSchema checks only the `\d{4}-\d{4}-\d{4}-\d{3}[\dX]` shape, never
 *  the checksum), unique per call. Migration 0077's
 *  `idx_users_orcid_live_unique` is a real UNIQUE index on live rows, and a
 *  literal like "0000-0002-1825-0097" is already claimed by many other
 *  fixture rows across this suite (api.test.ts, auth-passwordless.test.ts,
 *  ...) that never freshEmail() and so never go away -- seeding a NEW row
 *  with that literal here 500s with "Failed to seed user"
 *  (UNIQUE constraint failed: users.orcid). A fresh account needs a fresh iD. */
function freshOrcid(): string {
  const digits = (Date.now().toString() + Math.random().toString().slice(2)).slice(-16);
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 15)}${digits[15]}`;
}

async function postJson(
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders, ...extra },
    body: JSON.stringify(body),
  });
}

/** Optional profile columns the fixture can seed alongside the row itself
 *  (backend/src/routes/admin/users.ts's seedWebUserSchema `profile` object).
 *  Used below to make a fixture row look like a REAL web account -- one
 *  created through ORCID OAuth already carries a verified iD (ADR 0008 is
 *  the only web creation path), which a bare `seedWebUser(email, "verified")`
 *  does not. */
interface SeedWebUserProfile {
  given_name?: string;
  family_name?: string;
  orcid?: string;
  orcid_verified?: boolean;
  github_username?: string;
  city?: string;
  country?: string;
  affiliation?: string;
}

/** Returns the seeded row's numeric id (`{ user: { id, email, status } }`,
 *  backend/src/routes/admin/users.ts) -- the same id `POST
 *  /admin/revoke/by-id/:id` takes, so a caller that needs to revoke this
 *  fixture mid-test does not have to invent a second lookup for it. */
async function seedWebUser(
  email: string,
  status: "pending" | "verified" | "approved" | "revoked",
  profile?: SeedWebUserProfile,
): Promise<{ id: number }> {
  const r = await fetch(`${API}/admin/test-fixtures/seed-web-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
      ...baseHeaders,
    },
    body: JSON.stringify(profile ? { email, status, profile } : { email, status }),
  });
  if (r.status !== 200) {
    throw new Error(`seedWebUser failed (${r.status}): ${await r.text()}`);
  }
  const body = (await r.json()) as { user: { id: number } };
  return { id: body.user.id };
}

interface CodeRequestResponse {
  ok: boolean;
  dev_code?: string;
  dev_skip?: string;
  error?: string;
}

/** Sign in via the passwordless flow and return the `nemar_session` cookie
 *  header value -- the "browser" side of every case below. */
async function signIn(email: string): Promise<string> {
  const req = await postJson("/auth/code/request", { email });
  const reqBody = (await req.json()) as CodeRequestResponse;
  if (!reqBody.dev_code) {
    throw new Error(`no dev_code for ${email}: ${JSON.stringify(reqBody)}`);
  }
  const verify = await postJson(
    "/auth/code/verify",
    { email, code: reqBody.dev_code, remember: false },
    { Origin: ORIGIN },
  );
  const setCookie = verify.headers.get("Set-Cookie");
  const m = setCookie?.match(/nemar_session=([^;]+)/);
  if (!m) throw new Error(`sign-in did not set a session cookie for ${email}: ${verify.status}`);
  return `nemar_session=${m[1]}`;
}

let deviceRoutesDeployed = false;

beforeAll(async () => {
  if (PROD_GUARD_ACTIVE) return;
  const probe = await postJson("/auth/device/start", { machine_name: "deploy-probe" });
  deviceRoutesDeployed = probe.status !== 404;
  if (!deviceRoutesDeployed) {
    console.warn(
      "[auth-device-cli-live] SKIPPING every case: POST /auth/device/start answered 404. " +
        "The dev worker deploys only from `dev` (a call from .github/workflows/auto-bump-dev.yml " +
        "to deploy-backend.yml), so this phase's routes are not live on the backend TEST_API_URL " +
        "points at yet -- expected until the epic branch reaches dev.",
    );
  }
});

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-auth-device-cli-live-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** Spawns the CLI and resolves `codeReady` with the printed user code the
 *  moment it appears in stdout -- the CLI keeps polling in the background,
 *  so the caller can act on the "browser" side (confirm/deny) before
 *  awaiting `finished`. */
function runCliStreaming(args: string[]) {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: API,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      NEMAR_NO_BROWSER: "1",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutAcc = "";
  let resolveCode: (code: string) => void;
  const codeReady = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  let codeSeen = false;

  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      stdoutAcc += chunk;
      if (!codeSeen) {
        const match = stdoutAcc.match(/Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/);
        if (match) {
          codeSeen = true;
          resolveCode(match[1]);
        }
      }
    }
    return stdoutAcc;
  })();
  const stderrDone = new Response(proc.stderr).text();

  const finished = (async () => {
    const stdout = await stdoutDone;
    const stderr = await stderrDone;
    const exitCode = await proc.exited;
    return { stdout, stderr, out: `${stdout}${stderr}`, exitCode };
  })();

  return { proc, codeReady, finished };
}

async function runCli(args: string[]) {
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: API,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      NEMAR_NO_BROWSER: "1",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, out: `${stdout}${stderr}`, exitCode };
}

describe.skipIf(PROD_GUARD_ACTIVE)(
  "nemar auth login/status/keys/logout, live (#1283, ADR 0047)",
  () => {
    test("the full loop: login, status, keys shows current, logout revokes it", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("full-loop");
      await seedWebUser(email, "verified");
      const cookie = await signIn(email);

      const cli = runCliStreaming(["auth", "login", "--no-open"]);
      const userCode = await cli.codeReady;

      // Real browser-side lookup before confirm, mirroring
      // test/auth-device-flow.test.ts's full-loop test: the CLI printed
      // this code, so the machine name the "browser" sees must be the one
      // the CLI itself started the device code with.
      const lookupRes = await fetch(
        `${API}/auth/device/lookup?code=${encodeURIComponent(userCode)}`,
        { headers: { ...baseHeaders, Cookie: cookie } },
      );
      expect(lookupRes.status).toBe(200);
      const lookupBody = (await lookupRes.json()) as { machine_name: string };
      expect(lookupBody.machine_name).toBe(machineName());

      const confirmRes = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(confirmRes.status).toBe(200);

      const result = await cli.finished;
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain("Welcome");

      const status = await runCli(["auth", "status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Key:");

      const keys = await runCli(["auth", "keys"]);
      expect(keys.exitCode).toBe(0);
      expect(keys.stdout).toContain("(this machine)");

      // Read the minted key straight from the config file the device flow
      // just wrote, BEFORE logout clears it -- the CLI never prints a login's
      // own key value to stdout (only `keys create` does).
      const mintedKey = readMintedApiKey(configDir);
      const meBefore = await fetch(`${API}/users/me`, {
        headers: { ...baseHeaders, Authorization: `Bearer ${mintedKey}` },
      });
      expect(meBefore.status).toBe(200);

      const logout = await runCli(["auth", "logout", "-y"]);
      expect(logout.exitCode).toBe(0);

      // The revoked key no longer authenticates.
      const meAfter = await fetch(`${API}/users/me`, {
        headers: { ...baseHeaders, Authorization: `Bearer ${mintedKey}` },
      });
      expect(meAfter.status).toBe(401);
    }, 60000);

    test("deny: the CLI prints the contract sentence and exits 1", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("deny");
      await seedWebUser(email, "verified");
      const cookie = await signIn(email);

      const cli = runCliStreaming(["auth", "login", "--no-open"]);
      const userCode = await cli.codeReady;

      const denyRes = await postJson(
        "/auth/device/deny",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(denyRes.status).toBe(200);

      const result = await cli.finished;
      expect(result.exitCode).toBe(1);
      expect(result.out).toContain(
        "This sign-in was declined in the browser. Run `nemar auth login` again if that was a mistake.",
      );
    }, 60000);

    test("a pending account is promoted to verified by sign-in, so confirm succeeds (REST-level; matches test/auth-device-flow.test.ts; account_pending unreachable here, ADR 0047)", async () => {
      if (!deviceRoutesDeployed) return;
      // seedWebUser(email, "pending") plants status='pending', but signIn()
      // below is the REAL /auth/code/request + /auth/code/verify
      // passwordless flow, and applyEmailVerification
      // (backend/src/services/email-verification.ts) unconditionally
      // promotes a pending row to 'verified' in the SAME transaction that
      // mints the session -- proving the inbox is the whole content of that
      // transition (ADR 0040 phase 2, epic #1252). By the time this test
      // holds a session cookie, the account is no longer pending: there is
      // no window in which a session-bound request can observe
      // status='pending' through this path.
      //
      // This is the same SHAPE of unreachability ADR 0047 already records
      // for account_revoked at lookup/confirm/deny ("findSessionByCookieId
      // already filters revoked accounts out of session resolution, so a
      // revoked person carries no web session and never reaches this
      // refusal") -- just a different mechanism (promotion-on-verify
      // instead of exclusion-at-lookup). The one place a session CAN
      // legitimately be pending is a brand-new ORCID sign-up
      // (backend/src/routes/auth-orcid.ts's finalize handler mints a
      // session before the first verification code is even sent), which
      // this fixture-plus-passwordless-signin path cannot reach:
      // seed-web-user has no way to hand back a session without going
      // through /auth/code/verify, and that route promotes on every
      // successful verify. Driving a real ORCID sign-up is out of reach for
      // an automated test (see this file's "signup with flags" case
      // above), so this test instead pins the actual, provable behavior of
      // the reachable path: sign-in promotes, and confirm then succeeds.
      const email = freshEmail("pending-confirm");
      await seedWebUser(email, "pending");
      const cookie = await signIn(email);
      const started = await postJson("/auth/device/start", { machine_name: "e2e-pending-machine" });
      const { user_code: userCode } = (await started.json()) as { user_code: string };
      const res = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(res.status).toBe(200);
    });

    test("an account revoked between confirm and collect: the CLI's terminal sentence", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("revoke-midflight");
      const { id } = await seedWebUser(email, "verified");
      const cookie = await signIn(email);

      const cli = runCliStreaming(["auth", "login", "--no-open"]);
      const userCode = await cli.codeReady;

      const confirmRes = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(confirmRes.status).toBe(200);

      // Revoke the account before the CLI's next poll collects the key, by
      // the id seedWebUser returned -- not best-effort: a revoke that did
      // not actually land would make this test pass for the wrong reason
      // (a poll that happens to hit some OTHER terminal state).
      const revokeRes = await fetch(`${API}/admin/revoke/by-id/${id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`, ...baseHeaders },
      });
      expect(revokeRes.status).toBe(200);

      const result = await cli.finished;
      expect(result.exitCode).toBe(1);
    }, 60000);

    test("signup with flags lands the PATCH and the upload-access request", async () => {
      if (!deviceRoutesDeployed) return;
      const email = freshEmail("signup-flags");
      // A brand-new email that has never signed in before is exactly the
      // "ORCID creates the account" case this phase's signup targets, but
      // driving REAL ORCID consent is out of reach for an automated test --
      // seedWebUser instead plants a verified account it can sign into,
      // which exercises the SAME completion path (device flow, then
      // profile_gaps-driven completion) without a from-scratch ORCID
      // account. That gap is a known limit; nemarOrg/nemar-cli#1283 records
      // the manual walk-through for the true from-scratch path.
      //
      // The fixture also has to carry orcid_verified=true. A bare
      // seedWebUser(email, "verified") leaves orcid_verified=0, and
      // PROFILE_GAP_MATRIX's orcid_verified row (shared/contract/profile-
      // gaps.ts) blocks upload_access on that alone. A REAL web account
      // never hits this in production, because ORCID OAuth is the only web
      // creation path (ADR 0008) -- "every web account already carries a
      // verified iD by the time it can reach this list" (profile-gaps.ts's
      // own comment) -- but this fixture is a direct DB seed, not an OAuth
      // round trip, so it has to say so explicitly to match what a real web
      // account looks like.
      //
      // given_name/family_name are ALSO required for upload_access
      // (PROFILE_GAP_MATRIX's own comment: "Raised even under a verified
      // ORCID iD" -- neither field has a CLI flag, `completeProfile` never
      // touches them, and the real ORCID record is what would have supplied
      // them on an actual sign-up). Confirmed by running with the CLI's
      // stdout/stderr temporarily logged: without these two, the PATCH
      // landed but the upload-access request was refused with `missing:
      // ["given_name", "family_name"]`.
      await seedWebUser(email, "verified", {
        given_name: "Grace",
        family_name: "Hopper",
        orcid: freshOrcid(),
        orcid_verified: true,
      });
      const cookie = await signIn(email);

      // --username is passed explicitly rather than relying on sign-in's
      // own auto-assignment (auth-web.ts's pickUsernameForName, which needs
      // a given_name/family_name this fixture does not set): completeProfile's
      // guardNonInteractive (src/commands/auth.ts) refuses to hang under
      // this subprocess's `stdin: "ignore"` when `username` is still a
      // profile_gaps entry and no --username was given -- printing "Provide
      // --username (this terminal cannot prompt)." and exiting 1 before the
      // PATCH or the upload-access request are ever attempted. That was the
      // actual failure this test used to hit (confirmed by temporarily
      // logging result.stdout/stderr): the test's own premise (a bare
      // seedWebUser(email, "verified") is signup-ready) was false, not the
      // ORCID gate above -- the process never got far enough to reach it.
      const username = `dcli${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      // "mojombo" and not "octocat": test/api.test.ts's
      // "valid but unregistered github returns registered: false" asserts
      // octocat stays unclaimed by any NEMAR account forever -- parking a
      // real handle on a persistent dev-DB row is exactly how that broke CI
      // once already (see auth-passwordless.test.ts's own comment on the
      // same incident). "mojombo" is the established safe substitute that
      // file already uses for the same reason, and this test releases it
      // again in the `finally` below so a rerun of either file never finds
      // it already claimed.
      const github = "mojombo";

      const cli = runCliStreaming([
        "auth",
        "signup",
        "--no-open",
        "--username",
        username,
        "--github",
        github,
        "--city",
        "San Diego",
        "--country",
        "USA",
        "--why",
        "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.",
      ]);
      const userCode = await cli.codeReady;
      const confirmRes = await postJson(
        "/auth/device/confirm",
        { code: userCode },
        { Origin: ORIGIN, Cookie: cookie },
      );
      expect(confirmRes.status).toBe(200);

      const result = await cli.finished;
      try {
        expect(result.exitCode).toBe(0);

        // Prove the PATCH and the upload-access request actually landed,
        // rather than trusting a 0 exit code alone -- the test's own name
        // ("lands the PATCH and the upload-access request") is a claim
        // about server state, not just about the process's exit code.
        //
        // GET /auth/me (cookie), not GET /users/me (bearer): the latter's
        // response never carried city/country/upload_access_requested_at
        // (backend/src/routes/users.ts's `/me` handler queries them off
        // userDetails but never puts them on the wire) -- only auth-web.ts's
        // `publicUser()` shape does, which is what GET /auth/me returns. The
        // session cookie from signIn() above is still live.
        const me = await fetch(`${API}/auth/me`, {
          headers: { ...baseHeaders, Cookie: cookie },
        });
        expect(me.status).toBe(200);
        const meBody = (await me.json()) as {
          user: {
            username: string | null;
            github_username: string | null;
            city: string | null;
            country: string | null;
            upload_access_requested_at: string | null;
          } | null;
        };
        expect(meBody.user?.username).toBe(username);
        expect(meBody.user?.github_username).toBe(github);
        expect(meBody.user?.city).toBe("San Diego");
        expect(meBody.user?.country).toBe("USA");
        expect(meBody.user?.upload_access_requested_at).not.toBeNull();
      } finally {
        // Release "mojombo" even if an assertion above threw, so it never
        // outlives this test on the shared dev D1 (see the comment on
        // `github` above).
        const mintedKey = readMintedApiKey(configDir);
        await fetch(`${API}/auth/profile`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mintedKey}`,
            ...baseHeaders,
          },
          body: JSON.stringify({ github_username: "" }),
        }).catch(() => {});
      }
    }, 60000);

    test.todo("a service account cannot sign in via the device flow (phase 4)");
  },
);

/** The active account's `apiKey`, read straight off the on-disk config the
 *  CLI just wrote. The CLI itself never prints a login's own key value to
 *  stdout (only `keys create` does), so a test that needs to act AS the
 *  key it just minted -- proving a later logout actually revoked it --
 *  has to read it from the same file `nemar auth status` does. */
function readMintedApiKey(dir: string): string {
  const raw = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
    activeAccount?: string;
    accounts?: Record<string, { apiKey?: string }>;
  };
  const active = raw.activeAccount ? raw.accounts?.[raw.activeAccount] : undefined;
  if (!active?.apiKey) throw new Error(`no active account with an apiKey in ${dir}/config.json`);
  return active.apiKey;
}
