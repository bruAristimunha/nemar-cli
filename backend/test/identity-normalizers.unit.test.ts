/**
 * The identity normalisers and the live-only holder lookups (ADR 0043).
 *
 * These rules used to be exercised through `POST /auth/signup`, which is gone
 * (ADR 0097). Account creation now runs through ORCID finalize, which takes its
 * iD from a signed token, so the typed-input rules (a pasted `@handle`, an iD
 * with a lowercase check digit, an `orcid.org` URL, a garbage-prefixed paste)
 * have no HTTP route left to drive them. They still decide what admin search
 * calls an exact hit, what the admin fixture-create stores and what the profile
 * routes accept, so they are pinned here directly, with a real database for the
 * holder lookups.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  findEmailHolder,
  findGithubHolder,
  findOrcidHolder,
  normalizeEmail,
  normalizeGithubHandle,
  normalizeOrcid,
} from "../src/services/identity";
import { freshDb, realD1 } from "./helpers/d1";

const ORCID = "0000-0002-1825-0097";
const X_ORCID = "0000-0001-5109-353X";

describe("normalizeOrcid", () => {
  test("a bare iD is returned as is", () => {
    expect(normalizeOrcid(ORCID)).toBe(ORCID);
  });

  test("surrounding whitespace is trimmed", () => {
    expect(normalizeOrcid(`  ${ORCID}\n`)).toBe(ORCID);
  });

  test("a lowercase check digit is stored uppercase", () => {
    // The unique index compares exactly, so a lowercase x would read as a
    // different person's iD.
    expect(normalizeOrcid(X_ORCID.toLowerCase())).toBe(X_ORCID);
  });

  test("an orcid.org URI is reduced to the bare iD, with or without a trailing slash", () => {
    expect(normalizeOrcid(`https://orcid.org/${ORCID}`)).toBe(ORCID);
    expect(normalizeOrcid(`http://orcid.org/${ORCID}/`)).toBe(ORCID);
    expect(normalizeOrcid(`https://sandbox.orcid.org/${ORCID}`)).toBe(ORCID);
  });

  test("a garbage-prefixed or garbage-suffixed paste is rejected, not 'normalised'", () => {
    // Anchoring only the tail turns `garbage0000-...-0097` into a valid iD and
    // stores it as if the user had typed one, so a fat-fingered paste silently
    // claims somebody else's identifier.
    expect(normalizeOrcid(`garbage${ORCID}`)).toBeNull();
    expect(normalizeOrcid(`${ORCID}garbage`)).toBeNull();
    expect(normalizeOrcid(`https://example.org/${ORCID}`)).toBeNull();
  });

  test("it checks the shape of an iD, not its check digit", () => {
    // Recorded so nobody assumes more than it does: a well-formed iD with a
    // wrong checksum passes. ORCID itself is the authority on whether it exists.
    expect(normalizeOrcid("0000-0002-1825-0098")).toBe("0000-0002-1825-0098");
    expect(normalizeOrcid("0000-0002-1825-009")).toBeNull();
  });

  test("empty, null and undefined are null", () => {
    expect(normalizeOrcid("")).toBeNull();
    expect(normalizeOrcid(null)).toBeNull();
    expect(normalizeOrcid(undefined)).toBeNull();
  });
});

describe("normalizeEmail and normalizeGithubHandle", () => {
  test("an address is trimmed and lowercased", () => {
    expect(normalizeEmail("  Ada.Lovelace@Example.ORG ")).toBe("ada.lovelace@example.org");
  });

  test("a pasted @handle loses the @ and keeps its case", () => {
    expect(normalizeGithubHandle("@Octocat")).toBe("Octocat");
    expect(normalizeGithubHandle("  @octocat ")).toBe("octocat");
  });

  test("only a leading @ is stripped", () => {
    expect(normalizeGithubHandle("octo@cat")).toBe("octo@cat");
  });
});

describe("a tombstoned row is not a holder", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  function insert(email: string, cols: { orcid?: string; github?: string; deleted?: boolean }) {
    db.run(
      `INSERT INTO users (username, email, status, signup_source, email_verified,
                          orcid, github_username, deleted_at)
       VALUES (NULL, ?, 'verified', 'web', 1, ?, ?, ?)`,
      [email, cols.orcid ?? null, cols.github ?? null, cols.deleted ? "2026-01-01 00:00:00" : null],
    );
  }

  test("a live row holding an iD, an address or a handle is found", async () => {
    insert("Holder@Example.org", { orcid: ORCID, github: "Octocat" });
    const d1 = realD1(db);
    expect(await findOrcidHolder(d1, ORCID)).not.toBeNull();
    expect(await findEmailHolder(d1, "holder@example.org")).not.toBeNull();
    expect(await findGithubHolder(d1, "octocat")).not.toBeNull();
  });

  test("the same values on a soft-deleted row are not", async () => {
    // The live-only predicate is what lets a person come back after deleting
    // their account: the tombstone must not hold their iD, address or handle.
    insert("Holder@Example.org", { orcid: ORCID, github: "Octocat", deleted: true });
    const d1 = realD1(db);
    expect(await findOrcidHolder(d1, ORCID)).toBeNull();
    expect(await findEmailHolder(d1, "holder@example.org")).toBeNull();
    expect(await findGithubHolder(d1, "octocat")).toBeNull();
  });

  test("an account is not in conflict with itself when its own id is passed", async () => {
    insert("self@example.org", { orcid: ORCID });
    const id = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE email = 'self@example.org'")
      .get()?.id as number;
    const d1 = realD1(db);
    expect(await findOrcidHolder(d1, ORCID)).not.toBeNull();
    expect(await findOrcidHolder(d1, ORCID, id)).toBeNull();
  });
});
