/**
 * PATCH /admin/users/by-id/:id (ADR 0096).
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real
 * admin router (authMiddleware + adminMiddleware, real hashed tokens). No mocks.
 *
 * ONE PATH THIS FILE REACHES WITHOUT A RACE. The route pre-checks that nobody
 * holds an address and then relies on the database to refuse the write if
 * somebody grabbed it in between. Two requests cannot be interleaved on this
 * harness (see admin-kind-route.test.ts for why), but the second half can still
 * be exercised honestly: a TOMBSTONED row is invisible to the pre-check (it
 * looks only at live accounts) and still counts for the table-level UNIQUE on
 * `users.email` and the table-wide NOCASE index on `github_username`, so a
 * deleted row holding the value reaches the catch with the real constraint
 * firing. The username index is partial on live rows, so it has no such path.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ADMIN_USER_ERROR_MESSAGES } from "../../shared/contract/admin-user.js";
import { adminRoutes } from "../src/routes/admin";
import { applyEditWithAudit } from "../src/routes/admin/user-edit";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "edit-owner-key-0123456789abcdef0123456789abc";
const ADMIN_KEY = "edit-admin-key-0123456789abcdef0123456789abc";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedActor(username: string, role: "owner" | "admin", apiKey: string): Promise<void> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
  ).run(username, `${username}@example.org`, role);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: actor insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
}

function seedTarget(
  username: string,
  extra: Partial<{
    email: string;
    github: string | null;
    given: string | null;
    family: string | null;
    affiliation: string | null;
    orcid: string | null;
    orcidVerified: number;
    emailVerified: number;
    autoAssigned: number;
    deleted: boolean;
  }> = {},
): number {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        github_username, given_name, family_name, affiliation, orcid,
                        orcid_verified, username_auto_assigned, deleted_at)
     VALUES (?, ?, 'x', 'verified', 'member', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    username,
    extra.email ?? `${username}@example.org`,
    extra.emailVerified ?? 1,
    extra.github ?? null,
    extra.given ?? "Given",
    extra.family ?? "Family",
    extra.affiliation ?? "Old Lab",
    extra.orcid ?? null,
    extra.orcidVerified ?? 0,
    extra.autoAssigned ?? 0,
    extra.deleted ? "2026-01-01 00:00:00" : null,
  );
  return idOf(username);
}

function idOf(username: string): number {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`no such user ${username}`);
  return row.id;
}

function row(id: number): Record<string, unknown> {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown>;
}

function audits(action = "admin_user_edited") {
  return db
    .query<
      { user_id: number; resource_type: string; resource_id: string; details: string },
      [string]
    >(
      "SELECT user_id, resource_type, resource_id, details FROM audit_log WHERE action = ? ORDER BY id",
    )
    .all(action);
}

/** The union of what the route answers with: success and every refusal. */
interface EditResponse {
  error?: string;
  message?: string;
  changed: Record<string, { from: string | null; to: string | null }>;
  notes: string[];
  old_address_notified?: boolean;
  holder?: { id: number; username: string | null };
  user: Record<string, unknown>;
}

async function patch(
  id: number | string,
  body: unknown,
  key = OWNER_KEY,
): Promise<{ status: number; body: EditResponse }> {
  const res = await app.request(
    `/admin/users/by-id/${id}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    { DB: realD1(db), ENVIRONMENT: "test" } as Bindings,
  );
  return { status: res.status, body: (await res.json()) as EditResponse };
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedActor("editowner", "owner", OWNER_KEY);
  await seedActor("editadmin", "admin", ADMIN_KEY);
});

describe("descriptive fields: any admin", () => {
  test("an admin edits name, affiliation, city and country, and the change is audited", async () => {
    const id = seedTarget("subject");
    const { status, body } = await patch(
      id,
      {
        given_name: "  Ada ",
        family_name: "Lovelace",
        affiliation: "Analytical Engines Ltd",
        city: "London",
        country: "United Kingdom",
      },
      ADMIN_KEY,
    );
    expect(status).toBe(200);
    expect(Object.keys(body.changed).sort()).toEqual([
      "affiliation",
      "city",
      "country",
      "family_name",
      "given_name",
    ]);
    expect(body.changed.given_name).toEqual({ from: "Given", to: "Ada" });

    const after = row(id);
    expect(after.given_name).toBe("Ada");
    expect(after.family_name).toBe("Lovelace");
    expect(after.affiliation).toBe("Analytical Engines Ltd");
    expect(after.city).toBe("London");
    expect(body.user.given_name).toBe("Ada");

    const log = audits();
    expect(log).toHaveLength(1);
    expect(log[0].user_id).toBe(idOf("editadmin"));
    expect(log[0].resource_id).toBe(String(id));
    const details = JSON.parse(log[0].details);
    expect(details.changed_by).toBe("editadmin");
    expect(details.target_username).toBe("subject");
    expect(details.changed.family_name).toEqual({ from: "Family", to: "Lovelace" });
  });

  test("an empty affiliation clears it to NULL; an empty city is refused", async () => {
    const id = seedTarget("subject");
    expect((await patch(id, { affiliation: "" }, ADMIN_KEY)).status).toBe(200);
    expect(row(id).affiliation).toBeNull();

    const refused = await patch(id, { city: "  " }, ADMIN_KEY);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("city_required");
  });

  test("re-sending the current values is a 200 with no change and no audit row", async () => {
    const id = seedTarget("subject");
    const before = row(id);
    const { status, body } = await patch(
      id,
      { given_name: "Given", affiliation: "Old Lab" },
      ADMIN_KEY,
    );
    expect(status).toBe(200);
    expect(body.changed).toEqual({});
    expect(body.message).toContain("No changes");
    expect(audits()).toHaveLength(0);
    expect(row(id).updated_at).toBe(before.updated_at);
  });

  test("a name on an account with a verified ORCID iD is refused; its affiliation is not", async () => {
    const id = seedTarget("orcidperson", { orcid: "0000-0002-1825-0097", orcidVerified: 1 });
    const refused = await patch(id, { given_name: "Changed" }, ADMIN_KEY);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("name_is_orcid_canonical");
    expect(row(id).given_name).toBe("Given");

    expect((await patch(id, { affiliation: "New Lab" }, ADMIN_KEY)).status).toBe(200);
    expect(row(id).affiliation).toBe("New Lab");
  });

  test("an unverified ORCID iD does not freeze the name", async () => {
    const id = seedTarget("claimed", { orcid: "0000-0002-1825-0097", orcidVerified: 0 });
    expect((await patch(id, { given_name: "Changed" }, ADMIN_KEY)).status).toBe(200);
  });
});

describe("identity fields: owners only", () => {
  test("an admin who is not an owner is refused for each of the three, and nothing changes", async () => {
    const id = seedTarget("subject", { github: "oldhandle" });
    const before = row(id);
    for (const body of [
      { username: "renamed" },
      { email: "new@example.org" },
      { github_username: "newhandle" },
      // A descriptive field alongside an identity one does not smuggle it through.
      { given_name: "Ok", email: "new@example.org" },
    ]) {
      const res = await patch(id, body, ADMIN_KEY);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("owner_only_field");
      expect(res.body.message).toBe(ADMIN_USER_ERROR_MESSAGES.owner_only_field);
    }
    expect(row(id)).toEqual(before);
    expect(audits()).toHaveLength(0);
  });

  test("an owner changes the email: normalised, unverified, audited, and says so", async () => {
    const id = seedTarget("subject", { email: "old@example.org" });
    const { status, body } = await patch(id, { email: "  New.Address@Example.ORG " });
    expect(status).toBe(200);
    expect(body.changed.email).toEqual({ from: "old@example.org", to: "new.address@example.org" });
    const after = row(id);
    expect(after.email).toBe("new.address@example.org");
    expect(after.email_verified).toBe(0);
    expect(body.notes.join(" ")).toContain("email_verified reset to 0");
    expect(JSON.parse(audits()[0].details).email_verified_reset).toBe(true);
  });

  test("changing only the case of an email keeps it verified", async () => {
    const id = seedTarget("subject", { email: "MiXeD@Example.org" });
    const { status } = await patch(id, { email: "mixed@example.org" });
    expect(status).toBe(200);
    const after = row(id);
    expect(after.email).toBe("mixed@example.org");
    expect(after.email_verified).toBe(1);
  });

  test("an address another live account holds is refused case-insensitively, naming the holder", async () => {
    const holder = seedTarget("holder", { email: "taken@example.org" });
    const id = seedTarget("subject", { email: "mine@example.org" });
    const { status, body } = await patch(id, { email: "TAKEN@example.org" });
    expect(status).toBe(409);
    expect(body.error).toBe("email_in_use");
    expect(body.holder).toEqual({ id: holder, username: "holder" });
    expect(body.message).toContain("holder");
    expect(row(id).email).toBe("mine@example.org");
    expect(audits()).toHaveLength(0);
  });

  test("a malformed email is refused", async () => {
    const id = seedTarget("subject");
    for (const email of ["not-an-address", "a@", ""]) {
      const res = await patch(id, { email });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_edit");
    }
  });

  test("an owner renames a username; the auto-assigned marker is cleared", async () => {
    const id = seedTarget("autoname", { autoAssigned: 1 });
    const { status, body } = await patch(id, { username: "chosen-name" });
    expect(status).toBe(200);
    expect(body.changed.username).toEqual({ from: "autoname", to: "chosen-name" });
    const after = row(id);
    expect(after.username).toBe("chosen-name");
    expect(after.username_auto_assigned).toBe(0);
    expect(body.notes.join(" ")).toContain("old username");
  });

  test("a username that collides case-insensitively is refused; a bad one is refused by rule", async () => {
    seedTarget("TakenName");
    const id = seedTarget("subject");
    const clash = await patch(id, { username: "takenname" });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe("username_taken");

    const short = await patch(id, { username: "ab" });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe("username_too_short");
    const charset = await patch(id, { username: "has space" });
    expect(charset.body.error).toBe("username_charset");
    expect(row(id).username).toBe("subject");
  });

  test("the approval lock that stops a person renaming themselves does not stop an owner", async () => {
    const id = seedTarget("approvedperson");
    db.query("UPDATE users SET status = 'approved' WHERE id = ?").run(id);
    expect((await patch(id, { username: "renamedbyowner" })).status).toBe(200);
  });

  test("an owner sets the GitHub handle with a leading @ stripped, and clears it with an empty string", async () => {
    const id = seedTarget("subject");
    const set = await patch(id, { github_username: "@Octo-Cat" });
    expect(set.status).toBe(200);
    expect(row(id).github_username).toBe("Octo-Cat");
    expect(set.body.notes.join(" ")).toContain("not against GitHub");

    const cleared = await patch(id, { github_username: "" });
    expect(cleared.status).toBe(200);
    expect(row(id).github_username).toBeNull();
    expect(cleared.body.changed.github_username).toEqual({ from: "Octo-Cat", to: null });
  });

  test("a handle another account holds is refused; a malformed one is refused by rule", async () => {
    seedTarget("holder", { github: "SharedHandle" });
    const id = seedTarget("subject");
    const clash = await patch(id, { github_username: "sharedhandle" });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe("github_in_use");

    const bad = await patch(id, { github_username: "-bad--handle" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_github_username");
  });

  test("an owner cannot edit their OWN identity fields here, but can their descriptive ones", async () => {
    const self = idOf("editowner");
    for (const body of [
      { username: "newowner" },
      { email: "me@example.org" },
      { github_username: "me" },
    ]) {
      const res = await patch(self, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("edit_own_account");
    }
    expect(row(self).email).toBe("editowner@example.org");
    expect((await patch(self, { city: "Somewhere" })).status).toBe(200);
  });
});

describe("what is not editable here", () => {
  const POINTERS: Array<[string, unknown, string]> = [
    ["role", "owner", "nemar admin role"],
    ["status", "approved", "nemar admin approve"],
    ["service_access", 1, "nemar admin approve"],
    ["account_kind", "service", "nemar admin kind"],
    ["orcid", "0000-0002-1825-0097", "never typed in"],
    ["orcid_verified", 1, "ORCID sign-in flow"],
    ["identity_conflict", 0, "duplicates --clear"],
    ["email_verified", 1, "resets it for you"],
    ["description", "x", "the person's own statement"],
  ];

  for (const [field, value, pointer] of POINTERS) {
    test(`${field} is refused with a pointer to where it IS changed`, async () => {
      const id = seedTarget("subject");
      const before = row(id);
      const { status, body } = await patch(id, { [field]: value });
      expect(status).toBe(400);
      expect(body.error).toBe("field_not_editable");
      expect(body.message).toContain(pointer);
      expect(row(id)).toEqual(before);
      expect(audits()).toHaveLength(0);
    });
  }

  test("an unknown key is refused as not a field, and the editable set is listed", async () => {
    const id = seedTarget("subject");
    const { status, body } = await patch(id, { favourite_colour: "green" });
    expect(status).toBe(400);
    expect(body.error).toBe("field_not_editable");
    expect(body.message).toContain("not an editable field");
    expect(body.message).toContain("given_name");
  });

  test("a forbidden key alongside a valid one changes nothing at all", async () => {
    const id = seedTarget("subject");
    const before = row(id);
    const { status } = await patch(id, { city: "Paris", role: "owner" });
    expect(status).toBe(400);
    expect(row(id)).toEqual(before);
  });

  test("the owner-only refusal comes after the not-a-field one", async () => {
    // An admin sending a field that does not exist is told so, rather than
    // being told that field is owner-only.
    const id = seedTarget("subject");
    const { body } = await patch(id, { nonsense: "x" }, ADMIN_KEY);
    expect(body.error).toBe("field_not_editable");
  });
});

describe("bad requests and missing targets", () => {
  test("empty body, array body, non-JSON and non-string values", async () => {
    const id = seedTarget("subject");
    expect((await patch(id, {})).body.error).toBe("empty_patch");
    expect((await patch(id, [])).status).toBe(400);
    expect((await patch(id, "{not json")).status).toBe(400);
    const numeric = await patch(id, { city: 42 });
    expect(numeric.status).toBe(400);
    expect(numeric.body.error).toBe("invalid_edit");
  });

  test("404 for an unknown id and for a tombstoned account", async () => {
    expect((await patch(999999, { city: "x" })).status).toBe(404);
    const gone = seedTarget("gone", { deleted: true });
    expect((await patch(gone, { city: "x" })).status).toBe(404);
    expect(row(gone).city).toBeNull();
  });

  test("400 for an id that is not a whole number", async () => {
    for (const bad of ["abc", "0", "1.5", "1e3", "12abc"]) {
      const res = await patch(bad, { city: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_user_id");
    }
  });

  test("the internal system account is refused by name, not as a malformed id", async () => {
    const res = await patch(-1, { city: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("system_account");
  });

  test("a member is refused", async () => {
    const MEMBER_KEY = "edit-member-key-0123456789abcdef0123456789a";
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('editmember', 'editmember@example.org', 'x', 'approved', 'member', 1)`,
    ).run();
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      idOf("editmember"),
      await hashApiKey(MEMBER_KEY),
      MEMBER_KEY.slice(0, 8),
    );
    const id = seedTarget("subject");
    expect((await patch(id, { city: "x" }, MEMBER_KEY)).status).toBe(403);
  });
});

describe("the database is the last word on uniqueness", () => {
  test("an address held only by a tombstoned row slips past the pre-check and is refused by the constraint", async () => {
    seedTarget("tombstone", { email: "reserved@example.org", deleted: true });
    const id = seedTarget("subject", { email: "mine@example.org" });
    const { status, body } = await patch(id, { email: "reserved@example.org" });
    expect(status).toBe(409);
    expect(body.error).toBe("email_in_use");
    expect(row(id).email).toBe("mine@example.org");
    // The batch is atomic: the refused change left no audit row behind.
    expect(audits()).toHaveLength(0);
  });

  test("a GitHub handle held only by a tombstoned row is refused the same way", async () => {
    seedTarget("tombstone", { github: "reservedhandle", deleted: true });
    const id = seedTarget("subject");
    const { status, body } = await patch(id, { github_username: "reservedhandle" });
    expect(status).toBe(409);
    expect(body.error).toBe("github_in_use");
    expect(row(id).github_username).toBeNull();
    expect(audits()).toHaveLength(0);
  });
});

describe("keys that are not fields never reach Object.prototype", () => {
  test("constructor, toString and __proto__ get the generic sentence", async () => {
    const id = seedTarget("subject");
    // A raw string: JSON.stringify would drop the inherited-looking keys.
    const res = await patch(id, '{"constructor":"x","toString":1,"__proto__":2}');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("field_not_editable");
    expect(res.body.message).not.toContain("native code");
    expect(res.body.message).not.toContain("[object");
    expect(res.body.message).toContain("constructor: not an editable field");
    expect(res.body.message).toContain("toString: not an editable field");
  });
});

describe("re-sending current values is a 200 that writes nothing, whoever sends it", () => {
  test("an ORCID-verified account's unchanged name", async () => {
    const id = seedTarget("orcidperson", { orcid: "0000-0002-1825-0097", orcidVerified: 1 });
    const res = await patch(id, { given_name: "Given", family_name: "Family" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual({});
    expect(audits()).toHaveLength(0);
  });

  test("an owner's own unchanged email", async () => {
    const res = await patch(idOf("editowner"), { email: "editowner@example.org" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual({});
  });
});

describe("owner accounts are closed to identity edits", () => {
  const OWNER2_KEY = "edit-owner2-key-0123456789abcdef0123456789a";
  beforeEach(async () => {
    await seedActor("editowner2", "owner", OWNER2_KEY);
  });

  test("one owner cannot re-point another owner's username, email or handle", async () => {
    const other = idOf("editowner2");
    const before = row(other);
    for (const body of [
      { email: "hijack@example.org" },
      { username: "hijacked" },
      { github_username: "hijack-gh" },
    ]) {
      const res = await patch(other, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("owner_account");
    }
    expect(row(other)).toEqual(before);
    expect(audits()).toHaveLength(0);
  });

  test("an owner's descriptive fields can still be edited", async () => {
    const res = await patch(idOf("editowner2"), { city: "Zurich" });
    expect(res.status).toBe(200);
  });

  test("an owner can edit an admin's identity fields", async () => {
    const res = await patch(idOf("editadmin"), { github_username: "admin-gh" });
    expect(res.status).toBe(200);
  });
});

describe("an owner cannot edit their own identity by bundling it with another field", () => {
  test("any identity field in the request refuses the whole request", async () => {
    const self = idOf("editowner");
    for (const body of [
      { city: "X", email: "me2@example.org" },
      { given_name: "X", username: "newname1" },
      { country: "Y", github_username: "mine" },
    ]) {
      const res = await patch(self, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("edit_own_account");
    }
    const after = row(self);
    expect(after.city).toBeNull();
    expect(after.given_name).toBeNull();
    expect(after.email).toBe("editowner@example.org");
    expect(audits()).toHaveLength(0);
  });
});

describe("changing an email address", () => {
  test("voids a verification link already sent to the old address", async () => {
    // A CLI sign-up with a typo: the link went to the wrong inbox.
    const id = seedTarget("pendingtypo", { email: "tyop@example.org", emailVerified: 0 });
    db.query(
      `UPDATE users SET status = 'pending', verification_token = 'tok-mailed-to-old',
              verification_expires_at = datetime('now', '+1 day') WHERE id = ?`,
    ).run(id);
    const res = await patch(id, { email: "typo@example.org" });
    expect(res.status).toBe(200);
    const after = row(id);
    expect(after.email).toBe("typo@example.org");
    expect(after.email_verified).toBe(0);
    expect(after.verification_token).toBeNull();
    expect(after.verification_expires_at).toBeNull();
    expect(res.body.notes.join(" ")).toContain("void");
  });

  test("a change of letter case alone keeps the link, and the verification", async () => {
    const id = seedTarget("casing", { email: "MiXeD@Example.org" });
    db.query("UPDATE users SET verification_token = 'tok-keep' WHERE id = ?").run(id);
    const res = await patch(id, { email: "mixed@example.org" });
    expect(res.status).toBe(200);
    const after = row(id);
    expect(after.verification_token).toBe("tok-keep");
    expect(after.email_verified).toBe(1);
    expect(res.body.old_address_notified).toBeUndefined();
  });

  test("tells the previous address, and says plainly when it could not", async () => {
    const id = seedTarget("moved", { email: "old@example.org" });
    const res = await patch(id, { email: "new@example.org" });
    expect(res.status).toBe(200);
    expect(row(id).email).toBe("new@example.org");
    // This engine is a non-production worker, which mails only allow-listed
    // recipients: the notice is fenced, the edit stands, and the answer is honest.
    expect(res.body.old_address_notified).toBe(false);
    expect(res.body.notes.join(" ")).toContain("could NOT be sent a notice");
  });

  test("an edit that moves no inbox mentions no notice", async () => {
    const id = seedTarget("stayed");
    const res = await patch(id, { city: "Paris" });
    expect(res.body.old_address_notified).toBeUndefined();
    expect(res.body.notes ?? []).toEqual([]);
  });
});

describe("the audit row follows the write", () => {
  test("an update that matched nothing leaves no audit row, and says so", async () => {
    const live = seedTarget("livetarget");
    const gone = seedTarget("goneafter", { deleted: true });
    const d1 = realD1(db);
    const update = (id: number) =>
      d1
        .prepare("UPDATE users SET city = ?1 WHERE id = ?2 AND deleted_at IS NULL")
        .bind("Paris", id);
    const entry = (id: number) => ({
      userId: idOf("editowner"),
      action: "admin_user_edited",
      resourceType: "user",
      resourceId: String(id),
      details: "{}",
    });

    // The window the route cannot reach on a single-writer engine: the account
    // was tombstoned between the read and the write.
    expect(await applyEditWithAudit(d1, update(gone), entry(gone))).toBe(false);
    expect(audits()).toHaveLength(0);
    expect(row(gone).city).toBeNull();

    expect(await applyEditWithAudit(d1, update(live), entry(live))).toBe(true);
    expect(audits()).toHaveLength(1);
    expect(row(live).city).toBe("Paris");
  });
});

describe("the success path changes only what it says", () => {
  function changedColumns(before: Record<string, unknown>, after: Record<string, unknown>) {
    return Object.keys(after)
      .filter((key) => after[key] !== before[key])
      .sort();
  }

  test("a descriptive edit moves updated_at and nothing else", async () => {
    const id = seedTarget("subject", { autoAssigned: 1 });
    db.query("UPDATE users SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
    const before = row(id);
    // `given_name` equals the stored value: not a change, not written, not audited.
    const res = await patch(id, { city: "Paris", given_name: "Given" });
    expect(res.status).toBe(200);
    expect(changedColumns(before, row(id))).toEqual(["city", "updated_at"]);
    expect(row(id).username_auto_assigned).toBe(1);
    expect(Object.keys(res.body.changed)).toEqual(["city"]);
    expect(audits()[0].resource_type).toBe("user");
  });

  test("an email edit changes exactly the email columns", async () => {
    const id = seedTarget("subject");
    db.query(
      `UPDATE users SET verification_token = 'tok', verification_expires_at = '2099-01-01 00:00:00',
              updated_at = '2000-01-01 00:00:00' WHERE id = ?`,
    ).run(id);
    const before = row(id);
    await patch(id, { email: "elsewhere@example.org" });
    expect(changedColumns(before, row(id))).toEqual([
      "email",
      "email_verified",
      "updated_at",
      "verification_expires_at",
      "verification_token",
    ]);
  });

  test("a username edit changes exactly the username columns", async () => {
    const id = seedTarget("subject", { autoAssigned: 1 });
    db.query("UPDATE users SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
    const before = row(id);
    await patch(id, { username: "renamed-user" });
    expect(changedColumns(before, row(id))).toEqual([
      "updated_at",
      "username",
      "username_auto_assigned",
    ]);
  });
});

describe("the ORCID name rule, edge by edge", () => {
  test("a family name alone is refused", async () => {
    const id = seedTarget("orcidone", { orcid: "0000-0002-1825-0097", orcidVerified: 1 });
    const res = await patch(id, { family_name: "Changed" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_is_orcid_canonical");
  });

  test("a name next to another field refuses the whole request", async () => {
    const id = seedTarget("orcidtwo", { orcid: "0000-0002-1825-0097", orcidVerified: 1 });
    const res = await patch(id, { given_name: "Changed", affiliation: "New Lab" });
    expect(res.status).toBe(409);
    expect(row(id).affiliation).toBe("Old Lab");
    expect(row(id).given_name).toBe("Given");
  });

  test("a verified flag with no iD on file does not freeze the name", async () => {
    const id = seedTarget("halfstate", { orcid: null, orcidVerified: 1 });
    const res = await patch(id, { given_name: "Changed" });
    expect(res.status).toBe(200);
    expect(row(id).given_name).toBe("Changed");
  });
});

describe("documented edit invariants", () => {
  test("a change of letter case alone is a change, for a username and a handle", async () => {
    const id = seedTarget("subject", { github: "octo-cat" });
    const res = await patch(id, { username: "Subject", github_username: "Octo-Cat" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.changed).sort()).toEqual(["github_username", "username"]);
    expect(row(id).username).toBe("Subject");
    expect(row(id).github_username).toBe("Octo-Cat");
  });

  test("an owner gives a username to an account that has none, by id", async () => {
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, signup_source)
       VALUES (NULL, 'webonly@example.org', 'x', 'verified', 'member', 1, 'web')`,
    ).run();
    const id = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE email = 'webonly@example.org'")
      .get()?.id as number;
    const res = await patch(id, { username: "webchosen" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Updated webonly@example.org: username");
    expect(row(id).username).toBe("webchosen");
    expect(row(id).username_auto_assigned).toBe(0);
    expect(JSON.parse(audits()[0].details).target_username).toBeNull();
  });

  test("a taken username and a taken handle name their holders", async () => {
    const userHolder = seedTarget("takenuser");
    const ghHolder = seedTarget("ghholder", { github: "takengh" });
    const id = seedTarget("subject");

    const u = await patch(id, { username: "TAKENUSER" });
    expect(u.status).toBe(409);
    expect(u.body.error).toBe("username_taken");
    expect(u.body.holder).toEqual({ id: userHolder, username: "takenuser" });

    const g = await patch(id, { github_username: "TakenGh" });
    expect(g.status).toBe(409);
    expect(g.body.error).toBe("github_in_use");
    expect(g.body.holder).toEqual({ id: ghHolder, username: "ghholder" });
  });
});
