/**
 * The D1 wrappers in helpers/d1.ts. They exist so a concurrency test can fail
 * for a non-atomic claim, so what matters is that they really yield and really
 * run the hook before the statement, and that they stay transparent otherwise.
 */

import { describe, expect, test } from "bun:test";
import { freshDb, interceptingD1, realD1, yieldingD1 } from "./d1";

describe("yieldingD1", () => {
  test("lets another task run between a statement's start and its execution", async () => {
    const d1 = yieldingD1(realD1(freshDb()));
    const order: string[] = [];
    const statement = d1
      .prepare("SELECT 1 AS n")
      .first()
      .then(() => order.push("statement"));
    order.push("after-call");
    await Promise.resolve();
    order.push("microtask");
    await statement;
    // A synchronous passthrough would have put "statement" before "after-call".
    expect(order).toEqual(["after-call", "microtask", "statement"]);
  });

  test("is otherwise transparent: bind, run, first, all and batch behave as the shim does", async () => {
    const db = freshDb();
    const d1 = yieldingD1(realD1(db));
    await d1
      .prepare(
        "INSERT INTO users (username, email, password_hash, status, role) VALUES (?, ?, 'x', 'approved', 'member')",
      )
      .bind("wrapped", "wrapped@example.org")
      .run();
    const row = await d1
      .prepare("SELECT username FROM users WHERE email = ?")
      .bind("wrapped@example.org")
      .first<{ username: string }>();
    expect(row?.username).toBe("wrapped");
    const all = await d1.prepare("SELECT username FROM users").all<{ username: string }>();
    expect(all.results.map((r) => r.username)).toContain("wrapped");
    await d1.batch([
      d1.prepare("UPDATE users SET role = 'admin' WHERE email = ?").bind("wrapped@example.org"),
    ]);
    expect(
      db.query<{ role: string }, []>("SELECT role FROM users WHERE username='wrapped'").get()?.role,
    ).toBe("admin");
  });
});

describe("interceptingD1", () => {
  test("runs the hook, with the statement's SQL, before the statement executes", async () => {
    const db = freshDb();
    const seen: string[] = [];
    const d1 = interceptingD1(realD1(db), (sql) => {
      seen.push(sql);
      // Lands a write BEFORE the statement under test reads.
      db.run(
        "INSERT INTO users (username, email, password_hash, status, role) VALUES ('hooked', 'hooked@example.org', 'x', 'approved', 'member')",
      );
    });
    const row = await d1
      .prepare("SELECT username FROM users WHERE email = 'hooked@example.org'")
      .first<{ username: string }>();
    expect(seen).toEqual(["SELECT username FROM users WHERE email = 'hooked@example.org'"]);
    expect(row?.username).toBe("hooked");
  });

  test("hands the hook the values the statement was bound with, so a fault can aim at one row", async () => {
    const db = freshDb();
    const seen: Array<[string, readonly unknown[]]> = [];
    const d1 = interceptingD1(realD1(db), (sql, binds) => {
      seen.push([sql, binds]);
      if (binds.includes("poisoned@example.org")) throw new Error("aimed fault");
    });
    await d1.prepare("SELECT ? AS n").bind(1).first();
    await expect(
      d1.prepare("SELECT username FROM users WHERE email = ?").bind("poisoned@example.org").first(),
    ).rejects.toThrow("aimed fault");
    expect(seen).toEqual([
      ["SELECT ? AS n", [1]],
      ["SELECT username FROM users WHERE email = ?", ["poisoned@example.org"]],
    ]);
  });
});
