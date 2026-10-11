/**
 * The rules of `nemar admin pr-reviews next` (ADR 0093) that need no terminal and no server:
 * what each typed answer means, when `y` may approve and merge, and the reader that keeps lines
 * typed ahead and reports an input that has ended.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { approvalGate } from "../src/lib/pr-review-approve";
import { approveAllowed, parseChoice } from "../src/lib/pr-review-next";
import { LineReader } from "../src/lib/prompt-lines";

describe("what a typed answer means", () => {
  test("y n c d s q, in either case and with spaces, and the words they stand for", () => {
    expect(["y", "Y", " yes "].map(parseChoice)).toEqual(["approve", "approve", "approve"]);
    expect(["n", "N", "no"].map(parseChoice)).toEqual(["close", "close", "close"]);
    expect(["c", "comment"].map(parseChoice)).toEqual(["comment", "comment"]);
    expect(["d", "Details"].map(parseChoice)).toEqual(["details", "details"]);
    expect(["s", "skip"].map(parseChoice)).toEqual(["skip", "skip"]);
    expect(["q", "Quit"].map(parseChoice)).toEqual(["quit", "quit"]);
  });

  test("anything else, including an empty line, is not an answer", () => {
    for (const raw of ["", "  ", "x", "yy", "ok", "approve", "y n"]) {
      expect(parseChoice(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe("when y may approve and merge", () => {
  const pass = approvalGate({ verdict: "pass", staleVerdict: null });
  const green = { bids: "pass", version: "pass" };

  test("a pass with both required checks green", () => {
    expect(approveAllowed({ gate: pass, force: false, ...green })).toEqual({ ok: true });
  });

  test("a verdict that only asks first is allowed: the warning is on the screen", () => {
    for (const verdict of ["uncertain", "could_not_decide", "not_reviewed"] as const) {
      const gate = approvalGate({ verdict, staleVerdict: null });
      expect(approveAllowed({ gate, force: false, ...green })).toEqual({ ok: true });
    }
  });

  test("a required check that is not green is refused, whatever --force says, and names the check", () => {
    for (const [bids, version, word] of [
      ["fail", "pass", "BIDS failing"],
      ["pending", "pass", "BIDS pending"],
      ["missing", "pass", "BIDS missing"],
      ["unknown", "pass", "BIDS unknown"],
      ["pass", "fail", "version failing"],
      ["pass", "pending", "version pending"],
    ] as const) {
      for (const force of [false, true]) {
        const r = approveAllowed({ gate: pass, force, bids, version });
        expect(r.ok, `${bids}/${version}/${force}`).toBe(false);
        if (!r.ok) {
          expect(r.reason).toContain(word);
          expect(r.reason).toContain("GitHub would not let it merge");
        }
      }
    }
  });

  test("a failing, running or unreadable review needs --force, and the reason says so", () => {
    for (const gate of [
      approvalGate({ verdict: "fail", staleVerdict: null }),
      approvalGate({ verdict: "in_progress", staleVerdict: null }),
      approvalGate({ verdict: "pass", staleVerdict: null, unread: "the API is down" }),
    ]) {
      const refused = approveAllowed({ gate, force: false, ...green });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("--force");
      expect(approveAllowed({ gate, force: true, ...green })).toEqual({ ok: true });
    }
  });

  test("a pull request that cannot be merged as it is, is not offered y", () => {
    for (const [mergeable, word] of [
      ["dirty", "merge conflicts"],
      ["behind", "behind main"],
    ] as const) {
      const r = approveAllowed({ gate: pass, force: true, ...green, mergeable });
      expect(r.ok, mergeable).toBe(false);
      if (!r.ok) expect(r.reason).toContain(word);
    }
    // Everything else GitHub says is left to the merge itself: blocked may be waiting on this approval.
    for (const mergeable of ["clean", "unknown", "blocked", "unstable", "has_hooks", undefined]) {
      expect(
        approveAllowed({ gate: pass, force: false, ...green, mergeable }),
        String(mergeable),
      ).toEqual({ ok: true });
    }
  });

  test("both reasons are given when both apply", () => {
    const gate = approvalGate({ verdict: "fail", staleVerdict: null });
    const r = approveAllowed({ gate, force: false, bids: "fail", version: "pass" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("BIDS failing");
      expect(r.reason).toContain("needs changes");
    }
  });
});

describe("the line reader", () => {
  function reader(options?: ConstructorParameters<typeof LineReader>[2]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (b) => written.push(String(b)));
    return { input, written, reader: new LineReader(input, output, options) };
  }

  test("on a terminal, what was typed before a card was shown is dropped, and counted", async () => {
    const { input, reader: r } = reader({ typeAhead: "discard" });
    input.write("y\ny\n"); // Enter pressed while the program was busy
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await r.discardTyped()).toBe(2);
    // The next question waits for a line typed after it was shown.
    const pending = r.ask("? ");
    input.write("q\n");
    expect(await pending).toBe("q");
    r.close();
  });

  test("a pasted comment: the lines that arrive with it are dropped once it settles", async () => {
    const { input, reader: r } = reader({ typeAhead: "discard" });
    const first = r.ask("comment> ");
    input.write("Fix the README.\nAlso add a CHANGES entry.\ny\n");
    expect(await first).toBe("Fix the README.");
    expect(await r.discardTyped(30)).toBe(2);
    r.close();
  });

  test("a pipe is a script: its lines are kept and discardTyped drops nothing", async () => {
    const { input, reader: r } = reader(); // not a terminal
    input.write("y\nn\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await r.discardTyped(10)).toBe(0);
    expect(await r.ask("? ")).toBe("y");
    expect(await r.ask("? ")).toBe("n");
    r.close();
  });

  test("Ctrl+C ends the input, says it was an interrupt, and what was typed before it is not an answer", async () => {
    // A terminal as readline sees one: a stream that says it is a TTY and can go raw.
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = new PassThrough();
    const r = new LineReader(input, output, { typeAhead: "keep" });
    input.write("y\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write("\u0003");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.interrupted).toBe(true);
    // "keep" would hand the queued "y" to the next question; an interrupt clears it either way.
    expect(await r.ask("? ")).toBeNull();
    r.close();
  });

  test("an input that ended is not an interrupt", async () => {
    const { input, reader: r } = reader();
    input.end();
    expect(await r.ask("? ")).toBeNull();
    expect(r.interrupted).toBe(false);
  });

  test("lines typed ahead are kept for the questions that come later", async () => {
    const { input, reader: r } = reader();
    input.write("one\ntwo\nthree\n");
    // Let the lines arrive before anything asks.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await r.ask("? ")).toBe("one");
    expect(await r.ask("? ")).toBe("two");
    expect(await r.ask("? ")).toBe("three");
    r.close();
  });

  test("a question waits for the next line", async () => {
    const { input, written, reader: r } = reader();
    const pending = r.ask("answer> ");
    input.write("later\n");
    expect(await pending).toBe("later");
    expect(written.join("")).toContain("answer> ");
    r.close();
  });

  test("an input that ends is an answer, for the question waiting and every one after", async () => {
    const { input, reader: r } = reader();
    const waiting = r.ask("? ");
    input.end();
    expect(await waiting).toBeNull();
    expect(await r.ask("? ")).toBeNull();
  });
});
