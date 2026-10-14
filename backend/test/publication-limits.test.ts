/**
 * The bounds of the publication approval path are declared once, in `shared/publication-limits.ts`
 * (ADR 0102), and the Worker enforces them from there. These tests drive the real deny route, the
 * real acknowledgment schema and the shared words that quote a dataset id at the boundaries of the
 * shared constants, so a bound that is edited in one place and copied in another fails here.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
  DENIAL_REASON_MAX_LENGTH,
  PUBLICATION_DATASET_ID_RE,
} from "../../shared/publication-limits";
import { cureOf } from "../../shared/publication-review";
import { adminRoutes } from "../src/routes/admin";
import { acknowledgeIdentifierScreenSchema } from "../src/services/publication-orchestrator";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { seedScreenedRequest, seedUser } from "./helpers/publication-review";

const ADMIN_KEY = "limits-admin-0123456789abcdef0123456789abcdef";
const DATASET = "nm000497";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedUser(db, "limitsadmin", "admin", ADMIN_KEY);
});

function deny(reason: string): Promise<Response> {
  return app.request(
    `/admin/publish/${DATASET}/deny`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    },
    { DB: realD1(db), ENVIRONMENT: "production" } as Bindings,
  );
}

function statusOf(requestId: number): string {
  return (
    db.query("SELECT status FROM publication_requests WHERE id = ?").get(requestId) as {
      status: string;
    }
  ).status;
}

describe("the denial reason's bound", () => {
  test("a reason of exactly the shared maximum is accepted, one more character is refused", async () => {
    const { requestId } = seedScreenedRequest(db, { datasetId: DATASET });
    const tooLong = await deny("x".repeat(DENIAL_REASON_MAX_LENGTH + 1));
    expect(tooLong.status).toBe(400);
    expect(statusOf(requestId)).toBe("requested");
    const exact = await deny("x".repeat(DENIAL_REASON_MAX_LENGTH));
    expect(exact.status).toBe(200);
    expect(statusOf(requestId)).toBe("denied");
  });
});

describe("the identifier screen acknowledgment's bounds", () => {
  const parse = (text: string) => acknowledgeIdentifierScreenSchema.safeParse(text).success;

  test("the shared minimum and maximum, counted once trimmed", () => {
    expect(parse("x".repeat(ACKNOWLEDGMENT_MIN_LENGTH - 1))).toBe(false);
    expect(parse("x".repeat(ACKNOWLEDGMENT_MIN_LENGTH))).toBe(true);
    expect(parse("x".repeat(ACKNOWLEDGMENT_MAX_LENGTH))).toBe(true);
    expect(parse("x".repeat(ACKNOWLEDGMENT_MAX_LENGTH + 1))).toBe(false);
    // Padding does not count: the length is the trimmed text's.
    expect(parse(`  ${"x".repeat(ACKNOWLEDGMENT_MIN_LENGTH - 1)}  `)).toBe(false);
    expect(parse(`  ${"x".repeat(ACKNOWLEDGMENT_MAX_LENGTH)}  `)).toBe(true);
  });

  test("the messages state the shared numbers", () => {
    const short = acknowledgeIdentifierScreenSchema.safeParse("x");
    const long = acknowledgeIdentifierScreenSchema.safeParse("x".repeat(1000));
    expect(short.success ? "" : short.error.issues[0]?.message).toContain(
      String(ACKNOWLEDGMENT_MIN_LENGTH),
    );
    expect(long.success ? "" : long.error.issues[0]?.message).toContain(
      String(ACKNOWLEDGMENT_MAX_LENGTH),
    );
  });
});

describe("the dataset id a command is built from", () => {
  test("the shared words quote exactly the ids the shared pattern accepts", () => {
    for (const id of ["nm000123", "on000001", "xx099999"]) {
      expect(PUBLICATION_DATASET_ID_RE.test(id)).toBe(true);
      expect(cureOf("review_not_started", id, true)).toContain(id);
    }
    for (const id of ["nm00012", "nm0001234", "ab000123", "NM000123", "nm000123 --force", ""]) {
      expect(PUBLICATION_DATASET_ID_RE.test(id)).toBe(false);
      expect(cureOf("review_not_started", id, true)).toContain("<dataset>");
      expect(cureOf("review_not_started", id, true)).not.toContain(id || "\u0000");
    }
  });
});
