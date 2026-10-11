/**
 * API Client Integration Tests
 *
 * Tests the API client against the real backend.
 * Requires test users to be set up in the database.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ABSENT_DATASET_ID } from "../backend/src/services/datasetId";
import rootPkg from "../package.json";
import { LIVE_TARGET_BLOCKED, TEST_CONFIG, sleep, testRequest } from "./setup";

/**
 * Every case in this file needs a live backend, so the whole file skips when the
 * harness has blocked the live target -- which it does whenever `TEST_API_URL` is
 * unset or names production (test/live-target.ts). Skipping is the point: these
 * used to run with an empty key against PRODUCTION and fail with confusing 400s.
 */
const describeLive = describe.skipIf(LIVE_TARGET_BLOCKED);

// Add delay between tests to avoid rate limiting
beforeEach(async () => {
  await sleep(300);
});

describeLive("API Health", () => {
  test("GET /health returns status ok", async () => {
    const { status, data } = await testRequest<{ status: string; version: string }>("/health");

    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    // /health must echo a semver from the worker's bundled package.json.
    // We don't lock to rootPkg.version because api-test runs against the
    // already-deployed dev backend and races deploy-dev (deploy-dev
    // re-rolls the worker on the same push). The shape check still
    // catches the original failure mode where the import resolved to an
    // unexpected file and version came back undefined or empty.
    expect(data.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  test("GET / returns 200 or 404 (no dedicated root handler)", async () => {
    // Root route may return 404 (prod) or 200 (dev default handler)
    const response = await fetch(`${TEST_CONFIG.apiUrl}/`);
    expect([200, 404]).toContain(response.status);
  });
});

describeLive("Authentication API", () => {
  describe("POST /auth/login", () => {
    test("valid admin API key returns user info with admin role", async () => {
      const { status, data } = await testRequest<{
        valid: boolean;
        user: { username: string; role: string };
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ api_key: TEST_CONFIG.adminApiKey }),
      });

      expect(status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.user.username).toBe("test-admin");
      expect(data.user.role).toBe("admin");
    });

    test("valid user API key returns user info with member role", async () => {
      const { status, data } = await testRequest<{
        valid: boolean;
        user: { username: string; role: string };
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ api_key: TEST_CONFIG.userApiKey }),
      });

      expect(status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.user.username).toBe("test-user");
      expect(data.user.role).toBe("member");
    });

    test("invalid API key returns 401", async () => {
      const { status, data } = await testRequest<{ error: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ api_key: "invalid_key_12345678901234567890" }),
      });

      expect(status).toBe(401);
      expect(data.error).toBe("Invalid API key");
    });

    test("missing API key returns 400", async () => {
      const { status } = await testRequest("/auth/login", {
        method: "POST",
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
    });
  });

  describe("GET /auth/check-github", () => {
    test("registered github_username returns registered: true", async () => {
      const { status, data } = await testRequest<{
        valid: boolean;
        username: string;
        registered: boolean;
      }>("/auth/check-github?username=test-user-gh");

      expect(status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.registered).toBe(true);
    });

    test("valid but unregistered github returns registered: false", async () => {
      const { status, data } = await testRequest<{
        valid: boolean;
        username: string;
        registered: boolean;
      }>("/auth/check-github?username=octocat");

      expect(status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.registered).toBe(false);
    });

    test("missing username returns 400", async () => {
      const { status, data } = await testRequest<{ error: string }>("/auth/check-github");

      expect(status).toBe(400);
      expect(data.error).toBe("GitHub username required");
    });
  });

  describe("POST /auth/resend-verification", () => {
    test("resend for non-existent email returns generic message (no leak)", async () => {
      const { status, data } = await testRequest<{ message: string }>("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: "nonexistent@example.com" }),
      });

      expect(status).toBe(200);
      expect(data.message).toContain("If an account exists");
    });

    test("resend for already verified user returns appropriate message", async () => {
      const { status, data } = await testRequest<{ message: string }>("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: "test-user@nemar.test" }),
      });

      expect(status).toBe(200);
      expect(data.message).toContain("already verified");
    });
  });
});

describeLive("User API", () => {
  describe("GET /users/me", () => {
    test("authenticated user can get their info", async () => {
      const { status, data } = await testRequest<{
        user: { username: string; email: string; role: string };
      }>("/users/me", {}, TEST_CONFIG.userApiKey);

      expect(status).toBe(200);
      expect(data.user.username).toBe("test-user");
      expect(data.user.email).toBe("test-user@nemar.test");
      expect(data.user.role).toBe("member");
    });

    test("admin user can get their info with role", async () => {
      const { status, data } = await testRequest<{
        user: { username: string; role: string };
      }>("/users/me", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.user.username).toBe("test-admin");
      expect(data.user.role).toBe("admin");
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/users/me");

      expect(status).toBe(401);
    });

    test("invalid token returns 401", async () => {
      const { status } = await testRequest("/users/me", {}, "invalid_token");

      expect(status).toBe(401);
    });
  });
});

describeLive("Admin API", () => {
  describe("GET /admin/users", () => {
    test("admin can list all users", async () => {
      const { status, data } = await testRequest<{
        users: Array<{ username: string; status: string }>;
        count: number;
      }>("/admin/users", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.count).toBeGreaterThan(0);
      expect(data.users.some((u) => u.username === "test-admin")).toBe(true);
    });

    test("admin can filter users by status", async () => {
      const { status, data } = await testRequest<{
        users: Array<{ username: string; status: string }>;
      }>("/admin/users?status=verified", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.users.every((u) => u.status === "verified")).toBe(true);
    });

    test("non-admin user gets 403", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/users",
        {},
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(403);
      expect(data.error).toContain("Admin");
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/admin/users");

      expect(status).toBe(401);
    });
  });

  describe("POST /admin/approve/:username", () => {
    test("approving non-existent user returns 404", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/approve/nonexistent-user",
        { method: "POST" },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(404);
    });

    test("approving already approved user returns error", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/approve/test-user",
        { method: "POST" },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(409); // Conflict: already approved
      expect(data.error).toContain("approved");
    });

    test("non-admin cannot approve users", async () => {
      const { status } = await testRequest(
        "/admin/approve/test-verified",
        { method: "POST" },
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(403);
    });
  });

  describe("POST /admin/revoke/:username", () => {
    test("revoking non-existent user returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/admin/revoke/nonexistent-user",
        { method: "POST" },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(404);
    });

    test("non-admin cannot revoke users", async () => {
      const { status } = await testRequest(
        "/admin/revoke/test-user",
        { method: "POST" },
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(403);
    });
  });
});

describeLive("Datasets API", () => {
  describe("GET /datasets", () => {
    test("public can list datasets (returns empty or datasets)", async () => {
      const { status, data } = await testRequest<{
        datasets: Array<{ dataset_id: string }>;
        count: number;
      }>("/datasets");

      expect(status).toBe(200);
      expect(Array.isArray(data.datasets)).toBe(true);
      expect(typeof data.count).toBe("number");
    });

    test("search matches managed dataset_id (nm*/on*) even when search_text omits it", async () => {
      // Pick any active managed dataset from the unfiltered list, then assert
      // that search=<its id> returns it. Previously the search clause only
      // checked name/description/c.search_text, so any nm* whose enrichment
      // failed to write the id into search_text vanished from search results.
      const { data: all } = await testRequest<{
        datasets: Array<{ dataset_id: string; source_type?: string }>;
      }>("/datasets?limit=50");
      const managed = all.datasets.find((d) => d.source_type === "managed");
      if (!managed) return; // tolerated on empty/sandbox dev DBs

      const { status, data } = await testRequest<{
        datasets: Array<{ dataset_id: string }>;
      }>(`/datasets?search=${encodeURIComponent(managed.dataset_id)}`);

      expect(status).toBe(200);
      expect(data.datasets.some((d) => d.dataset_id === managed.dataset_id)).toBe(true);
    });

    test("listing entries expose latest_version (null when no minted version)", async () => {
      // The hallu sync script reads this field to skip the per-dataset
      // /manifest call. Every entry must include the key, even if null,
      // so the script can rely on its presence.
      const { status, data } = await testRequest<{
        datasets: Array<{ dataset_id: string; latest_version: string | null | undefined }>;
      }>("/datasets?limit=50");

      expect(status).toBe(200);
      for (const entry of data.datasets) {
        expect("latest_version" in entry).toBe(true);
        if (entry.latest_version !== null && entry.latest_version !== undefined) {
          expect(typeof entry.latest_version).toBe("string");
        }
      }
    });

    test("GET /datasets?mine=true with no auth header returns 401 generic", async () => {
      // Caller never logged in. Backend can't tell why they want --mine, so
      // the generic "Authentication required" reply stands.
      const { status, data } = await testRequest<{ error: string }>("/datasets?mine=true");
      expect(status).toBe(401);
      expect(data.error).toBe("Authentication required to view your datasets");
    });

    test("GET /datasets?mine=true with invalid bearer token returns 401 with re-login hint", async () => {
      // This is the nemarOrg/nemar-cli#447 case: the CLI thinks it's logged
      // in (config has an apiKey) but the backend can't resolve the key
      // (revoked, rotated, wrong env). Generic "Authentication required"
      // leaves the user stuck. The backend must direct them to re-login.
      const { status, data } = await testRequest<{ error: string }>(
        "/datasets?mine=true",
        {},
        // 32+ chars so optionalAuthMiddleware does the DB lookup; a hash that
        // won't match any real token's api_key_hash.
        "nemar_definitely_invalid_token_for_test_only_12345",
      );
      expect(status).toBe(401);
      expect(data.error).toContain("rejected");
      expect(data.error).toContain("nemar auth login");
      // Must not fall through to the generic "no header" message.
      expect(data.error).not.toContain("Authentication required");
    });

    test("GET /datasets?mine=true with valid user token returns 200", async () => {
      const { status, data } = await testRequest<{
        datasets: Array<{ dataset_id: string }>;
      }>("/datasets?mine=true", {}, TEST_CONFIG.userApiKey);
      expect(status).toBe(200);
      expect(Array.isArray(data.datasets)).toBe(true);
    });

    test("listing hides ds* catalog shadows when an on* mirror exists", async () => {
      // The catalog row keeps its OpenNeuro id (c.id = "ds002718"); the
      // managed mirror carries the canonical id ("on002718") and back-points
      // via source_id = "ds002718". Without the catalog query's second
      // NOT IN clause, every mirrored ds* shows up twice in the list.
      const { data } = await testRequest<{
        datasets: Array<{ dataset_id: string; source?: string; source_id?: string | null }>;
      }>("/datasets?limit=200");

      const ids = new Set(data.datasets.map((d) => d.dataset_id));
      const shadowed = data.datasets.filter((d) => {
        if (!d.dataset_id.startsWith("on")) return false;
        const dsCounterpart = `ds${d.dataset_id.slice(2)}`;
        return ids.has(dsCounterpart);
      });
      // Each `on*` row in the list must NOT have its ds* counterpart alongside.
      expect(shadowed).toEqual([]);
    });

    test("listing's latest_version agrees with /manifest for managed datasets", async () => {
      // Ground truth for what the hallu sync script previously read.
      // If the SQL subquery diverges from /manifest's ordering or source,
      // the script will silently fall back to per-dataset /manifest calls.
      // Tolerated: dev DBs without any minted version still pass via early
      // return when no managed-and-versioned dataset exists.
      const { data } = await testRequest<{
        datasets: Array<{
          dataset_id: string;
          latest_version: string | null;
          source_type?: string;
        }>;
      }>("/datasets?limit=200");

      const managedWithVersion = data.datasets.filter(
        (d) => d.source_type === "managed" && d.latest_version,
      );
      if (managedWithVersion.length === 0) return;

      const sample = managedWithVersion[0];
      const { status: mStatus, data: m } = await testRequest<{
        versions: Array<{ version: string; created_at: string }>;
      }>(`/datasets/${sample.dataset_id}/versions`, {}, TEST_CONFIG.adminApiKey);
      // /versions requires auth + access; admin bypasses owner/collab checks.
      // It returns versions sorted DESC by created_at, matching the listing's
      // SQL subquery (`ORDER BY created_at DESC LIMIT 1`).
      if (mStatus !== 200) return; // tolerated: dataset may be admin-only/private
      expect(m.versions[0]?.version).toBe(sample.latest_version);
    });
  });

  describe("GET /datasets/:id", () => {
    test("non-existent dataset returns 404", async () => {
      // `ABSENT_DATASET_ID`, not a hand-picked id. This read "valid format
      // within the MAX_NUMBER=99999 cap, but unlikely to be allocated" and
      // named nm099998, which epic #1430 then designated as the standing
      // anonymous deposit; building it turned this test red. The constant is
      // the floor of the reserved band, which the allocator can never return.
      const { status } = await testRequest(`/datasets/${ABSENT_DATASET_ID}`);

      expect(status).toBe(404);
    });

    test("GET /datasets/:id with invalid bearer token returns 401 with re-login hint for private datasets", async () => {
      // Same bug class as #447: stale-token owner of a private dataset gets
      // "Dataset not found" instead of a re-login hint. nm099999 is always
      // private during dev/test, so a rejected token should see 401 + hint.
      const { status, data } = await testRequest<{ error: string }>(
        "/datasets/nm099999",
        {},
        // 32+ chars so optionalAuthMiddleware does the DB lookup; a hash
        // that won't match any real token's api_key_hash.
        "nemar_definitely_invalid_token_for_test_only_12345",
      );
      // nm099999 is private: stale token => 401 with re-login hint, not 404.
      expect(status).toBe(401);
      expect(data.error).toContain("rejected");
      expect(data.error).toContain("nemar auth login");
      expect(data.error).not.toContain("Authentication required");
    });
  });
});

describeLive("DOI/Zenodo API", () => {
  describe("GET /admin/datasets/:id/doi", () => {
    test("admin can get DOI info for a dataset", async () => {
      // Use nm099999 (seeded managed dataset) directly; the list endpoint
      // may return catalog-only datasets first which don't exist in D1.
      const { status, data } = await testRequest<{
        dataset_id: string;
        name: string;
        concept_doi: string | null;
      }>("/admin/datasets/nm099999/doi", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.dataset_id).toBe("nm099999");
    });

    test("non-admin user gets 403", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/datasets/nm000001/doi",
        {},
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(403);
      expect(data.error).toContain("Admin");
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/admin/datasets/nm000001/doi");

      expect(status).toBe(401);
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/admin/datasets/nm999999/doi",
        {},
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(404);
    });
  });

  describe("POST /admin/datasets/:id/doi/concept", () => {
    test("non-admin user gets 403", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/admin/datasets/nm000001/doi/concept",
        { method: "POST", body: JSON.stringify({}) },
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(403);
      expect(data.error).toContain("Admin");
    });

    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/admin/datasets/nm000001/doi/concept", {
        method: "POST",
        body: JSON.stringify({}),
      });

      expect(status).toBe(401);
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/admin/datasets/nm999999/doi/concept",
        { method: "POST", body: JSON.stringify({}) },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(404);
    });
  });

  describe("POST /webhooks/publish-version-doi", () => {
    test("missing webhook token returns 401 or 500", async () => {
      const { status } = await testRequest<{ error: string }>("/webhooks/publish-version-doi", {
        method: "POST",
        body: JSON.stringify({
          dataset_id: "nm000001",
          version: "1.0.0",
          release_url: "https://github.com/example/repo/releases/tag/v1.0.0",
        }),
      });

      // Returns 401 if token validation works, or 500 if webhook token secret not configured
      expect([401, 500]).toContain(status);
    });

    test("invalid webhook token returns 401 or 500", async () => {
      const headers = { "X-Webhook-Token": "invalid_token" };
      const response = await fetch(`${TEST_CONFIG.apiUrl}/webhooks/publish-version-doi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          dataset_id: "nm000001",
          version: "1.0.0",
          release_url: "https://github.com/example/repo/releases/tag/v1.0.0",
        }),
      });

      // Returns 401 if token validation works, or 500 if webhook token secret not configured
      expect([401, 500]).toContain(response.status);
    });

    test("missing required fields returns 400 or 401 or 500", async () => {
      const headers = { "X-Webhook-Token": "test_token" };
      const response = await fetch(`${TEST_CONFIG.apiUrl}/webhooks/publish-version-doi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify({
          dataset_id: "nm000001",
          // Missing version and release_url
        }),
      });

      // Returns 400 if fields missing, 401 if token invalid, or 500 if secret not configured
      expect([400, 401, 500]).toContain(response.status);
    });
  });

  describe("POST /admin/notify", () => {
    test("omitting both 'to' and 'user' returns 400", async () => {
      // The broadcastRequestSchema Zod refinement rejects bodies that have
      // neither the group ('to') nor the per-user ('user') field. This test
      // exercises the HTTP layer so the refinement is confirmed wired up.
      const { status, data } = await testRequest<{ error: unknown }>(
        "/admin/notify",
        {
          method: "POST",
          body: JSON.stringify({ subject: "Test", body: "Body" }),
        },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(400);
    });
  });
});

describeLive("Dataset Collaborators API", () => {
  describe("POST /datasets/:id/request-access", () => {
    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/datasets/nm000001/request-access", {
        method: "POST",
      });

      expect(status).toBe(401);
    });

    test("non-existent dataset returns 404", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/datasets/nm999999/request-access",
        { method: "POST" },
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(404);
    });

    test("invalid dataset ID format returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/datasets/invalid-id/request-access",
        { method: "POST" },
        TEST_CONFIG.userApiKey,
      );

      // Invalid ID format results in 404 since no dataset matches
      expect(status).toBe(404);
    });
  });

  describe("POST /datasets/:id/invite", () => {
    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/datasets/nm000001/invite", {
        method: "POST",
        body: JSON.stringify({ username: "someone" }),
      });

      expect(status).toBe(401);
    });

    test("non-admin non-owner gets 403", async () => {
      // nm099999 is owned by test-admin; test-user is not the owner
      const { status, data } = await testRequest<{ error: string }>(
        "/datasets/nm099999/invite",
        { method: "POST", body: JSON.stringify({ username: "someone" }) },
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(403);
      expect(data.error).toContain("owner or admin");
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/datasets/nm999999/invite",
        { method: "POST", body: JSON.stringify({ username: "test-user" }) },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(404);
    });

    test("inviting non-existent user returns 404", async () => {
      const { status, data } = await testRequest<{ error: string }>(
        "/datasets/nm099999/invite",
        { method: "POST", body: JSON.stringify({ username: "nonexistent-user-12345" }) },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(404);
      expect(data.error).toContain("not found");
    });

    test("missing username returns 400", async () => {
      const { status } = await testRequest(
        "/datasets/nm000001/invite",
        { method: "POST", body: JSON.stringify({}) },
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(400);
    });
  });

  describe("GET /datasets/:id/collaborators", () => {
    test("unauthenticated request returns 401", async () => {
      const { status } = await testRequest("/datasets/nm000001/collaborators");

      expect(status).toBe(401);
    });

    test("non-admin non-owner gets 403", async () => {
      // nm099999 is owned by test-admin; test-user is not the owner
      const { status, data } = await testRequest<{ error: string }>(
        "/datasets/nm099999/collaborators",
        {},
        TEST_CONFIG.userApiKey,
      );

      expect(status).toBe(403);
      expect(data.error).toContain("owner or admin");
    });

    test("non-existent dataset returns 404", async () => {
      const { status } = await testRequest<{ error: string }>(
        "/datasets/nm999999/collaborators",
        {},
        TEST_CONFIG.adminApiKey,
      );

      expect(status).toBe(404);
    });

    test("admin can list collaborators for any dataset", async () => {
      // Use nm099999 (seeded managed dataset) directly
      const { status, data } = await testRequest<{
        dataset_id: string;
        collaborators: Array<{ username: string }>;
        count: number;
      }>("/datasets/nm099999/collaborators", {}, TEST_CONFIG.adminApiKey);

      expect(status).toBe(200);
      expect(data.dataset_id).toBe("nm099999");
      expect(Array.isArray(data.collaborators)).toBe(true);
      expect(typeof data.count).toBe("number");
    });
  });
});

describeLive("Error Handling", () => {
  test("invalid JSON returns 400", async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (TEST_CONFIG.bypassToken) {
      headers["X-Test-Bypass"] = TEST_CONFIG.bypassToken;
    }
    const response = await fetch(`${TEST_CONFIG.apiUrl}/auth/login`, {
      method: "POST",
      headers,
      body: "not valid json",
    });

    expect(response.status).toBe(400);
  });

  test("unknown route returns 404", async () => {
    // Unknown routes return plain text 404, not JSON
    const response = await fetch(`${TEST_CONFIG.apiUrl}/unknown/route`);
    expect(response.status).toBe(404);
  });
});
