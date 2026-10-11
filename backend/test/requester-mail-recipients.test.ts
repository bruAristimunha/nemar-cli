/**
 * Who is emailed when a publication request is decided.
 *
 * The notice an accepted request is told ("You will be emailed if a check needs
 * your attention, and when an administrator decides", ADR 0090) promises mail to
 * the requester on three events. The identifier screen's blocked mail is tested
 * at the recipient level in identifier-screen-flow.test.ts; this file does the
 * other two, at the real routes, with the real mail builders and the real
 * delivery fence, and Resend moved to a local server (helpers/resend.ts):
 *
 * - a DENIAL goes to the user who made the request (`requested_by`);
 * - an APPROVAL goes to the dataset's owner (`owner_email`), which is the
 *   requester except when an administrator requested on the owner's behalf.
 *   The two are different people here on purpose, so a change of recipient
 *   from one column to the other fails.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { PUBLICATION_STEPS } from "../../shared/publication-steps.js";
import { adminRoutes } from "../src/routes/admin";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { mainRefAnswer, markDatasetScreensClean } from "./helpers/identifier-screen";
import { sendsTo, subjects, withFakeResend } from "./helpers/resend";

const ADMIN_KEY = "recipients-admin-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000490";
const OWNER_EMAIL = "recipientsowner@example.org";
const REQUESTER_EMAIL = "recipientsrequester@example.org";
const ADMIN_EMAIL = "recipientsadmin@example.org";

// Everything done except the logged no-op steps and the notification itself, so
// a resumed approval reaches `notify_user` with no network beyond the one
// GitHub read of `main` the identifier-screen gate makes.
const DONE_BUT_NOTIFY = PUBLICATION_STEPS.filter(
  (s) => s !== "upload_to_zenodo" && s !== "sync_nemar" && s !== "notify_user",
);

let server: Server;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;
let requesterId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const ref = mainRefAnswer(req);
      if (ref) return ref;
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
  db.close();
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_recipients_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

function seedUser(username: string, role: string, email: string): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 1, 'Ada', 'Lovelace')`,
    [username, email, role],
  );
  return db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username)
    ?.id as number;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  ownerId = seedUser("recipientsowner", "member", OWNER_EMAIL);
  requesterId = seedUser("recipientsrequester", "member", REQUESTER_EMAIL);
  const adminId = seedUser("recipientsadmin", "admin", ADMIN_EMAIL);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, visibility)
     VALUES (?, 'Recipients Dataset', ?, ?, 'private')`,
    [DATASET, ownerId, `nemarDatasets/${DATASET}`],
  );
});

/** A request made by `requesterId` on a dataset owned by `ownerId`. */
function seedRequest(steps: readonly string[]): void {
  db.run(
    `INSERT INTO publication_requests
       (dataset_id, status, requested_by, requested_at, updated_at, steps_completed)
     VALUES (?, 'requested', ?, datetime('now', '-3 hours'), datetime('now'), ?)`,
    [DATASET, requesterId, JSON.stringify(steps)],
  );
  markDatasetScreensClean(db, DATASET);
}

describe("a denial is mailed to the user who made the request", () => {
  test("the requester gets the denial with the reason, and the dataset owner does not", async () => {
    seedRequest([]);
    await withFakeResend(async (calls) => {
      const res = await app.request(
        `/admin/publish/${DATASET}/deny`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "The README does not describe the recording setup." }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      const toRequester = sendsTo(calls, REQUESTER_EMAIL);
      expect(toRequester).toHaveLength(1);
      expect(toRequester[0]?.subject).toBe(`Publication request denied: ${DATASET}`);
      expect(toRequester[0]?.html).toContain("The README does not describe the recording setup.");
      // The recipient is `requested_by`: the owner of the dataset is not it.
      expect(sendsTo(calls, OWNER_EMAIL)).toHaveLength(0);
      expect(subjects(calls)).toHaveLength(1);
    });
  });
});

describe("an approval is mailed to the dataset owner", () => {
  test("the owner gets the published mail, and the administrator who requested does not", async () => {
    seedRequest(DONE_BUT_NOTIFY);
    await withFakeResend(async (calls) => {
      const res = await app.request(
        `/admin/publish/${DATASET}/approve`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ resume: true }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      const toOwner = sendsTo(calls, OWNER_EMAIL);
      expect(toOwner).toHaveLength(1);
      expect(toOwner[0]?.subject).toBe(`Dataset published: ${DATASET}`);
      // The recipient is `owner_email`: `requested_by` is a different person
      // here, and is not the one told.
      expect(sendsTo(calls, REQUESTER_EMAIL)).toHaveLength(0);
    });
  });
});
