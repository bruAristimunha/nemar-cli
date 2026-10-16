// The log capture helper is the instrument behind every "a log line carries only ids" assertion, so
// it must see every console method the code under test logs through.

import { describe, expect, test } from "bun:test";
import { logged } from "./logs";

describe("logged", () => {
  test("captures console.log, warn and error, in the order they were written", async () => {
    const lines = await logged(async () => {
      console.log("a log line");
      console.warn("a warning");
      console.error("an error", 7);
      console.log("another log line");
    });
    expect(lines).toEqual(["a log line", "a warning", "an error 7", "another log line"]);
  });

  test("restores every console method, including when the function throws", async () => {
    const { log, warn, error } = console;
    await expect(
      logged(async () => {
        console.log("x");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(console.log).toBe(log);
    expect(console.warn).toBe(warn);
    expect(console.error).toBe(error);
  });
});
