/**
 * GitHub App authentication for the Worker. Signs short-lived App JWTs,
 * mints per-installation access tokens, caches them in module scope,
 * and exposes a discriminated `GitHubAuth` source so the orchestrator
 * can route through one helper without caring whether the underlying
 * credential is a user PAT or an App installation token.
 */

import type { Bindings } from "../types/bindings";

const GITHUB_API = "https://api.github.com";

/** 5-min lead on GitHub's 60-min token lifetime covers clock drift + round trip. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/** Branded epoch-milliseconds. Prevents accidental mixing with seconds
 *  elsewhere in the codebase (cf. JWT `iat`/`exp` in seconds). */
export type EpochMs = number & { readonly __brand: "EpochMs" };

interface CacheEntry {
  token: string;
  expiresAt: EpochMs;
  refreshing?: Promise<string>;
}

const installationTokenCache: Map<number, CacheEntry> = new Map();

export function __resetInstallationTokenCacheForTests(): void {
  installationTokenCache.clear();
}

export function __seedInstallationTokenCacheForTests(
  installationId: number,
  token: string,
  expiresAt: number,
): void {
  installationTokenCache.set(installationId, { token, expiresAt: expiresAt as EpochMs });
}

/** Drop a single installation's cached token so the next `getInstallationToken`
 *  call mints a fresh one. Use after observing a 401 from GitHub on a call
 *  that used this installation's token — the cache may be holding a value
 *  that GitHub no longer recognises (key rotation, App reinstall, momentary
 *  upstream auth blip). Pair with one retry; if the retry still 401s, the
 *  failure is structural and should bubble up. Issue #596. */
export function invalidateInstallationToken(installationId: number): void {
  installationTokenCache.delete(installationId);
}

// ---------------------------------------------------------------------
// JWT signing (behavioral mirror of scripts/verify-github-app.ts).
//
// Intentionally duplicated: the standalone script must work without
// pulling in Worker deps, and the Worker must not reach into scripts/.
// test/github-auth.test.ts and test/verify-github-app.test.ts both pin
// the same invariants on their respective copies; divergence is caught.
// ---------------------------------------------------------------------

function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// PKCS#1 is GitHub's default download; Web Crypto only imports PKCS#8.
function pkcs8PemToDer(pem: string): ArrayBuffer {
  const trimmed = pem.replace(/^﻿/, "").trim();
  if (trimmed.includes("BEGIN ENCRYPTED PRIVATE KEY")) {
    throw new Error(
      "GitHub App private key is an encrypted PKCS#8 file. Re-export unencrypted with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>",
    );
  }
  if (trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GitHub App private key is PKCS#1, not PKCS#8. Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in <in> -out <out>",
    );
  }
  const match = trimmed.match(
    /-----BEGIN PRIVATE KEY-----\s*([\s\S]+?)\s*-----END PRIVATE KEY-----/,
  );
  if (!match) {
    throw new Error("Could not find PKCS#8 PEM block in GITHUB_APP_PRIVATE_KEY.");
  }
  const body = match[1].replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

/** Sign a 10-minute App JWT (RS256). 30 s iat backstep covers
 *  maintainer-laptop clock skew; harmless on a Worker. */
export async function signAppJwt(
  appId: number | string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const der = pkcs8PemToDer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const iat = nowSeconds - 30;
  const exp = iat + 600;
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat, exp, iss: String(appId) };
  const encoded = `${base64url(new TextEncoder().encode(JSON.stringify(header)))}.${base64url(
    new TextEncoder().encode(JSON.stringify(payload)),
  )}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(encoded));
  return `${encoded}.${base64url(sig)}`;
}

// ---------------------------------------------------------------------
// Installation tokens
// ---------------------------------------------------------------------

interface InstallationTokenResponse {
  token: string;
  expires_at: string; // ISO 8601
}

export interface InstallationToken {
  token: string;
  expiresAt: EpochMs;
}

/** Internal options for tests only; not exported so production callers
 *  can't accidentally point at a fake GitHub. */
interface FetchInstallationTokenInternalOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

/** POST /app/installations/:id/access_tokens with the signed App JWT.
 *  401 from GitHub usually means key/clock/App ID mismatch; 404 means
 *  the installation isn't visible to this App. */
export async function fetchInstallationToken(
  jwt: string,
  installationId: number,
  options: FetchInstallationTokenInternalOptions = {},
): Promise<InstallationToken> {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? GITHUB_API;
  const res = await fetchFn(`${baseUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "nemar-worker",
    },
  });
  if (!res.ok) {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens -> HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as Partial<InstallationTokenResponse>;
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens: response \`token\` missing or empty: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  if (typeof body.expires_at !== "string") {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens: response missing \`expires_at\`: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const expiresAtMs = Date.parse(body.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens: invalid expires_at "${body.expires_at}"`,
    );
  }
  if (expiresAtMs <= Date.now()) {
    // Token born expired: clock skew, replay, or a buggy upstream. Don't cache it.
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens: token already expired (expires_at=${body.expires_at}, now=${new Date().toISOString()})`,
    );
  }
  return { token: body.token, expiresAt: expiresAtMs as EpochMs };
}

function entryIsFresh(entry: CacheEntry, now: number): boolean {
  return now < entry.expiresAt - REFRESH_LEAD_MS;
}

/** Return a valid installation token for `installationId`, hitting the
 *  module-level cache when possible. Concurrent callers during a
 *  refresh share one in-flight `refreshing` promise so we never mint
 *  N tokens for N parallel orchestrator steps. */
export async function getInstallationToken(
  env: Bindings,
  installationId: number,
  options: FetchInstallationTokenInternalOptions = {},
): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error(
      "GitHub App credentials missing: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set.",
    );
  }

  const now = Date.now();
  const cached = installationTokenCache.get(installationId);
  if (cached) {
    if (entryIsFresh(cached, now)) return cached.token;
    if (cached.refreshing) return cached.refreshing;
  }

  const refreshing = (async () => {
    const jwt = await signAppJwt(env.GITHUB_APP_ID as string, env.GITHUB_APP_PRIVATE_KEY as string);
    const { token, expiresAt } = await fetchInstallationToken(jwt, installationId, options);
    installationTokenCache.set(installationId, { token, expiresAt });
    return token;
  })();

  // Stash the in-flight promise so concurrent callers attach instead of
  // spawning their own mints.
  installationTokenCache.set(installationId, {
    token: cached?.token ?? "",
    expiresAt: cached?.expiresAt ?? (0 as EpochMs),
    refreshing,
  });

  try {
    return await refreshing;
  } catch (err) {
    // Drop the failed entry so the next call re-attempts a clean mint
    // rather than serving a stale token or an empty string. If we had a
    // still-fresh stale entry, preserve it (without the failed refresh).
    if (!cached || !entryIsFresh(cached, Date.now())) {
      installationTokenCache.delete(installationId);
    } else {
      installationTokenCache.set(installationId, {
        token: cached.token,
        expiresAt: cached.expiresAt,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// Discriminated source the orchestrator + webhooks will consume.
// ---------------------------------------------------------------------

export type GitHubAuth =
  | { kind: "pat"; token: string }
  | { kind: "app"; installationId: number; getToken: () => Promise<string> };

/** The bindings that make up the App configuration, and nothing else of the Worker's environment. */
export type GitHubAppEnv = Pick<
  Bindings,
  | "GITHUB_APP_ID"
  | "GITHUB_APP_PRIVATE_KEY"
  | "GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS"
  | "GITHUB_APP_INSTALLATION_ID_NEMAR_ORG"
>;

/** Parsed GitHub App configuration, or `null` when not configured. */
export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationIdsByOrg: Readonly<Record<string, number>>;
}

/** Read the App config from env. Returns `null` when the required pair
 *  (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`) is absent. Per-org
 *  installation IDs are best-effort: missing or malformed values are
 *  silently omitted, and the caller will fall back to PAT for that org.
 *  This is the single place that decides "App auth is available"; all
 *  callers should route through here rather than re-reading env. */
export function getGitHubAppConfig(env: GitHubAppEnv): GitHubAppConfig | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  const installationIdsByOrg: Record<string, number> = {};
  const orgs: ReadonlyArray<readonly [string, string | undefined]> = [
    ["nemarDatasets", env.GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS],
    ["nemarOrg", env.GITHUB_APP_INSTALLATION_ID_NEMAR_ORG],
  ];
  for (const [orgLogin, raw] of orgs) {
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && String(n) === raw.trim()) {
      installationIdsByOrg[orgLogin] = n;
    } else {
      // Loud signal that App auth is partially configured. Without this,
      // a single typo would silently degrade every orchestrator call for
      // that org to the legacy PAT path.
      console.warn(
        `[github-auth] GITHUB_APP_INSTALLATION_ID for ${orgLogin} is set but not a positive integer: "${raw}". Falling back to PAT for this org.`,
      );
    }
  }
  return {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationIdsByOrg,
  };
}

/** Lookup the installation ID configured for an org login, or
 *  `undefined` when there isn't one. Phase 3 callsites use this with
 *  `getDefaultGitHubAuth` to stay decoupled from env var names. */
export function resolveInstallationId(env: Bindings, orgLogin: string): number | undefined {
  return getGitHubAppConfig(env)?.installationIdsByOrg[orgLogin];
}

/** Pick the right auth source for an operation targeting `installationId`.
 *  Returns App auth when the App is configured AND the requested
 *  installation ID is present. Falls back to PAT otherwise — including
 *  when App auth is partially configured. The fallback exists so dev
 *  environments without App secrets keep working.
 *
 *  Throws if neither App nor a non-empty PAT is configured: a Worker in
 *  that state can't talk to GitHub at all, so a clear error here beats
 *  an opaque 401 from the next REST call. */
export function getDefaultGitHubAuth(env: Bindings, installationId?: number): GitHubAuth {
  if (installationId !== undefined) {
    const app = getGitHubAppConfig(env);
    if (app) {
      return {
        kind: "app",
        installationId,
        getToken: () => getInstallationToken(env, installationId),
      };
    }
  }
  if (!env.GITHUB_ADMIN_PAT) {
    throw new Error(
      "No GitHub auth configured: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + installation IDs, or GITHUB_ADMIN_PAT as fallback.",
    );
  }
  return { kind: "pat", token: env.GITHUB_ADMIN_PAT };
}

/** Auth for operations on the nemarDatasets org. Falls back to PAT
 *  when App config is incomplete. */
export function getDatasetsAuth(env: Bindings): GitHubAuth {
  return getDefaultGitHubAuth(env, resolveInstallationId(env, "nemarDatasets"));
}

/** Bearer token for the nemarDatasets org. App-minted tokens are cached
 *  per-installation, so repeat calls in one request are cheap. */
export async function getDatasetsToken(env: Bindings): Promise<string> {
  const auth = getDatasetsAuth(env);
  return auth.kind === "app" ? await auth.getToken() : auth.token;
}

/** Bundle of `{ token, refresh }` for callers that want a token plus a
 *  way to recover from a 401 by minting a fresh one. `refresh` invalidates
 *  the installation token cache (for App auth) and returns a new token;
 *  for PAT auth there is no cache to bust, so `refresh` just re-reads the
 *  same PAT. Wire `refresh` into `githubFetchWithRetry`'s
 *  `refreshTokenOn401` option to make any GitHub call self-heal from a
 *  one-off stale-token 401. Issue #596. */
export async function getDatasetsTokenWithRefresher(
  env: Bindings,
): Promise<{ token: string; refresh: () => Promise<string> }> {
  const auth = getDatasetsAuth(env);
  if (auth.kind === "app") {
    return {
      token: await auth.getToken(),
      refresh: async () => {
        invalidateInstallationToken(auth.installationId);
        return await auth.getToken();
      },
    };
  }
  // PAT path: no cache to invalidate, but expose the same shape so
  // callers don't branch on auth kind. The refresh is a no-op that
  // returns the same token; a 401 here means the PAT itself is bad,
  // which won't be helped by re-reading it.
  return { token: auth.token, refresh: async () => auth.token };
}
