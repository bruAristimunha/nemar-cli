/**
 * Redaction unit tests for the --debug diagnostic bundle (issue #1256,
 * epic #1250 phase 6).
 *
 * These exercise pure functions with no shared module state (no config
 * singleton, no debug-log module flags), so -- unlike the CLI-subprocess
 * tests in debug-log-cli.test.ts -- they're safe to run in-process even
 * though `bun test` shares one process across test/ and backend/test
 * (see MEMORY: bun-test-shared-process-root-and-backend).
 *
 * The literal secrets below (API keys, AWS credentials, emails) are
 * representative sample input for a text-transformation function, not
 * mocked business logic -- no different from testing formatBytesCli with a
 * literal byte count.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_DISPATCH_TOKEN_HEADER } from "../shared/contract/publication";
import {
  buildCommandLabel,
  maskEmail,
  pruneLogsDir,
  redactArgv,
  redactBody,
  redactHeaders,
  redactUrl,
  shouldEnableDebug,
} from "../src/lib/debug-log";

describe("redactHeaders", () => {
  test("redacts Authorization, Cookie, X-Api-Key regardless of case", () => {
    const out = redactHeaders({
      Authorization: "Bearer sk-live-abcdef1234567890",
      cookie: "nemar_session=deadbeef",
      "X-API-KEY": "raw-secret-value",
      "Content-Type": "application/json",
    });
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out["X-API-KEY"]).toBe("[REDACTED]");
    expect(out["Content-Type"]).toBe("application/json");
  });

  test("redacts the approval dispatch token header, whatever its casing", () => {
    // The executor of a web approval presents this token on every `/approve` call. It is not the
    // API key, so the three names above never covered it, and `--debug` writes the request
    // headers into the log users are told to attach to public issues. The header is named from
    // the shared contract, so a rename of the header that skips the redaction list fails here.
    const token = "a".repeat(64);
    for (const name of [
      APPROVAL_DISPATCH_TOKEN_HEADER,
      "X-Approval-Dispatch-Token",
      "x-approval-dispatch-token",
      "X-APPROVAL-DISPATCH-TOKEN",
    ]) {
      const out = redactHeaders({ [name]: token, "Content-Type": "application/json" });
      expect(out[name]).toBe("[REDACTED]");
      expect(JSON.stringify(out)).not.toContain(token);
      expect(out["Content-Type"]).toBe("application/json");
    }
  });

  test("leaves unrelated headers untouched", () => {
    const out = redactHeaders({ "X-CLI-Version": "0.9.16" });
    expect(out).toEqual({ "X-CLI-Version": "0.9.16" });
  });
});

describe("maskEmail", () => {
  test("keeps the first character and the domain, masks the rest", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
  });
});

describe("redactBody", () => {
  test("redacts a sensitive JSON key regardless of nesting", () => {
    const raw = JSON.stringify({
      api_key: "sk-live-abcdef1234567890",
      nested: { password: "hunter2", ok: "keep-me" },
    });
    const out = redactBody(raw);
    expect(out).toBeDefined();
    expect(out).not.toContain("sk-live-abcdef1234567890");
    expect(out).not.toContain("hunter2");
    expect(out).toContain('"keep-me"');
    const parsed = JSON.parse(out as string);
    expect(parsed.api_key).toBe("[REDACTED]");
    expect(parsed.nested.password).toBe("[REDACTED]");
  });

  test("masks an email value under an unrelated key", () => {
    const raw = JSON.stringify({ contact: "Reach me at alice@example.com please" });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("a***@example.com");
  });

  test("redacts a Bearer token embedded in a JSON string value", () => {
    const raw = JSON.stringify({ note: "Bearer abcDEF123456.token-part" });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("abcDEF123456.token-part");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("redacts an AWS access key ID by shape", () => {
    const raw = JSON.stringify({ note: "key is AKIAABCDEFGHIJKLMNOP" });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(out).toContain("[REDACTED_AWS_KEY]");
  });

  test("redacts an aws_secret_access_key assignment even under a non-matching JSON key name", () => {
    // The key name itself ("aws_secret_access_key") does not exactly match
    // the JSON-key allowlist (which expects bare "secret"/"access_key"), so
    // this only gets caught by the regex fallback pass -- see debug-log.ts.
    const raw = JSON.stringify({
      aws_secret_access_key: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
    expect(out).toContain("[REDACTED]");
  });

  test("falls back to regex scrubbing on a non-JSON body", () => {
    const raw = "user=alice@example.com&token=Bearer abc.def-123";
    const out = redactBody(raw) as string;
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("Bearer abc.def-123");
    expect(out).toContain("a***@example.com");
  });

  test("truncates a body over the byte cap and marks it", () => {
    const raw = JSON.stringify({ blob: "x".repeat(5000) });
    const out = redactBody(raw, 2048) as string;
    expect(out.endsWith("... [truncated]")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(2048 + "... [truncated]".length);
  });

  test("passes through undefined unchanged", () => {
    expect(redactBody(undefined)).toBeUndefined();
  });

  // Review finding (PR #1257, item A1): a presigned S3 URL carries its
  // credential in the query string, not the body -- a naive redaction pass
  // that only knows about JSON key names or Bearer tokens misses it
  // entirely when it's embedded as a string VALUE (an upload_url/
  // download_url field), not a top-level field of its own.
  test("masks presigned-S3 query params embedded in an upload_url/download_url field", () => {
    const raw = JSON.stringify({
      upload_url:
        "https://nemar-dev.s3.amazonaws.com/objects/abc123" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAABCDEFGHIJKLMNOP%2F20260101%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Security-Token=FwoGZXIvYXdzEXAMPLETOKENVALUEHERE" +
        "&X-Amz-Signature=abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567",
      download_url:
        "https://example.com/f?Signature=deadbeefdeadbeefdeadbeef&AWSAccessKeyId=AKIAZZZZZZZZZZZZZZZZ",
    });
    const out = redactBody(raw) as string;
    expect(out).not.toContain("AKIAABCDEFGHIJKLMNOP%2F20260101");
    expect(out).not.toContain("FwoGZXIvYXdzEXAMPLETOKENVALUEHERE");
    expect(out).not.toContain("abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567");
    expect(out).not.toContain("deadbeefdeadbeefdeadbeef");
    expect(out).not.toContain("AKIAZZZZZZZZZZZZZZZZ");
    // Separator chars survive the replace so the URL still reads sensibly.
    expect(out).toContain("X-Amz-Credential=[REDACTED]");
    expect(out).toContain("&X-Amz-Security-Token=[REDACTED]");
    expect(out).toContain("&X-Amz-Signature=[REDACTED]");
    expect(out).toContain("?Signature=[REDACTED]");
    expect(out).toContain("&AWSAccessKeyId=[REDACTED]");
    // The non-secret host/path is left alone.
    expect(out).toContain("nemar-dev.s3.amazonaws.com/objects/abc123");
  });

  test("does not throw and caps recursion on a pathologically deep body", () => {
    // 5000 levels is well past any realistic API payload and, pre-fix,
    // overflowed the call stack (RangeError) inside redactJsonValue.
    let deep: unknown = "bottom";
    for (let i = 0; i < 5000; i++) {
      deep = { child: deep };
    }
    const raw = JSON.stringify({ top: deep });
    let out: string | undefined;
    expect(() => {
      out = redactBody(raw);
    }).not.toThrow();
    expect(out).toContain("[REDACTED: depth]");
  });
});

describe("redactUrl (#1257)", () => {
  test("masks presigned-S3 params in the request URL itself", () => {
    const url =
      "https://nemar.s3.amazonaws.com/objects/xyz" +
      "?X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef" +
      "&X-Amz-Security-Token=SECURITYTOKENVALUE";
    const out = redactUrl(url);
    expect(out).not.toContain("0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(out).not.toContain("SECURITYTOKENVALUE");
    expect(out).toContain("?X-Amz-Signature=[REDACTED]");
    expect(out).toContain("&X-Amz-Security-Token=[REDACTED]");
  });

  test("masks an email embedded in a query string (e.g. admin email-preference routes)", () => {
    const url = "https://api.nemar.org/admin/email-preferences?user=alice@example.com";
    const out = redactUrl(url);
    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("user=a***@example.com");
  });

  test("leaves a plain URL with no secrets untouched", () => {
    const url = "https://api.nemar.org/datasets/nm000104";
    expect(redactUrl(url)).toBe(url);
  });
});

describe("shouldEnableDebug (#1257 item D9)", () => {
  test("NEMAR_DEBUG=1 enables debug mode with no --debug flag", () => {
    expect(shouldEnableDebug([], { NEMAR_DEBUG: "1" })).toBe(true);
  });

  test("no flag and no env var: disabled", () => {
    expect(shouldEnableDebug([], {})).toBe(false);
  });

  test("NEMAR_DEBUG=0 does not enable debug mode", () => {
    expect(shouldEnableDebug([], { NEMAR_DEBUG: "0" })).toBe(false);
  });

  test("--debug flag alone enables debug mode with no env var", () => {
    expect(shouldEnableDebug(["--debug"], {})).toBe(true);
  });
});

describe("buildCommandLabel (#1257 item D13)", () => {
  test("caps at the first two non-flag tokens", () => {
    expect(buildCommandLabel(["dataset", "upload", "./my-dataset", "-n", "My EEG Dataset"])).toBe(
      "dataset-upload",
    );
  });

  test("a positional path never reaches the filename", () => {
    expect(buildCommandLabel(["dataset", "validate", "/Users/alice/secret-project-name"])).toBe(
      "dataset-validate",
    );
  });

  test("a single-word command with no second token labels as itself", () => {
    expect(buildCommandLabel(["doctor"])).toBe("doctor");
  });

  test("empty argv falls back to a fixed label", () => {
    expect(buildCommandLabel([])).toBe("nemar");
  });

  // Item 20 (CRITICAL, reviewer-reproduced): a secret flag's value used to
  // land in the label because it was the second RAW non-flag token.
  test("a secret flag's value is never part of the label, even as the second token", () => {
    expect(buildCommandLabel(["login", "-k", "sk-live-THE-ACTUAL-SECRET-KEY"])).toBe("login");
    expect(buildCommandLabel(["login", "--key", "sk-live-THE-ACTUAL-SECRET-KEY"])).toBe("login");
    expect(buildCommandLabel(["auth", "login", "-k", "sk-live-ANOTHER-SECRET"])).toBe("auth-login");
  });

  // Item 24 (CRITICAL, reviewer-reproduced): the filename was never
  // actually at risk from the attached spellings (a token starting with
  // "-" is already excluded from buildCommandLabel's scan regardless), but
  // pinning it here alongside item 20's cases documents that both
  // vulnerability classes are covered from the filename's side too.
  test("an attached-value secret flag never reaches the label either", () => {
    expect(buildCommandLabel(["login", "--key=sk-live-THE-ACTUAL-SECRET-KEY"])).toBe("login");
    expect(buildCommandLabel(["login", "-ksk-live-THE-ACTUAL-SECRET-KEY"])).toBe("login");
  });
});

describe("redactArgv (#1257 item 24)", () => {
  // CRITICAL, reviewer-reproduced: redactArgv matched SECRET_FLAGS by exact
  // token equality, so the two attached-value spellings Commander accepts
  // for an option with a required argument -- "--flag=value" and, for a
  // one-letter short flag, "-fvalue" with no separator at all -- slipped
  // through untouched and put the raw key in the debug log's "Command:"
  // line. `nemar --debug login --key=sk-... ` and `nemar --debug login
  // -ksk-...` both reproduced the leak before this fix.
  test("redacts the value out of a --flag=value token, keeping the flag visible", () => {
    const out = redactArgv(["login", "--key=sk-live-THE-ACTUAL-SECRET-KEY"]);
    expect(out).toEqual(["login", "--key=[REDACTED]"]);
    expect(out.join(" ")).not.toContain("sk-live-THE-ACTUAL-SECRET-KEY");
  });

  test("redacts the value out of a one-letter short flag with no separator (-kVALUE)", () => {
    const out = redactArgv(["login", "-ksk-live-THE-ACTUAL-SECRET-KEY"]);
    expect(out).toEqual(["login", "-k[REDACTED]"]);
    expect(out.join(" ")).not.toContain("sk-live-THE-ACTUAL-SECRET-KEY");
  });

  test("still redacts the original bare-flag spelling (separate value token)", () => {
    const out = redactArgv(["login", "-k", "sk-live-THE-ACTUAL-SECRET-KEY"]);
    expect(out).toEqual(["login", "-k", "[REDACTED]"]);
  });

  test("covers every flag in SECRET_FLAGS in attached form", () => {
    expect(redactArgv(["--password=hunter2"])).toEqual(["--password=[REDACTED]"]);
    expect(redactArgv(["--api-key=sk-live-abc"])).toEqual(["--api-key=[REDACTED]"]);
  });

  test("leaves an unrelated flag/token untouched", () => {
    expect(redactArgv(["dataset", "manifest", "-d", "nm000104"])).toEqual([
      "dataset",
      "manifest",
      "-d",
      "nm000104",
    ]);
  });
});

describe("pruneLogsDir (#1257 item D10)", () => {
  test("removes exactly the oldest logs down to `keep`; non-log files are untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-prune-"));
    try {
      for (let i = 0; i < 12; i++) {
        const ms = String(i).padStart(3, "0");
        writeFileSync(join(dir, `nemar-2020-01-01T00-00-00-${ms}Z-fake.log`), "x");
      }
      writeFileSync(join(dir, "config.json"), "{}");
      writeFileSync(join(dir, "notes.txt"), "not a log");

      pruneLogsDir(dir, 10);

      const remaining = readdirSync(dir);
      const logs = remaining
        .filter((name) => name.startsWith("nemar-") && name.endsWith(".log"))
        .sort();
      expect(logs.length).toBe(10);
      // The two OLDEST (lowest-numbered) logs are the ones removed.
      expect(logs).not.toContain("nemar-2020-01-01T00-00-00-000Z-fake.log");
      expect(logs).not.toContain("nemar-2020-01-01T00-00-00-001Z-fake.log");
      expect(logs).toContain("nemar-2020-01-01T00-00-00-002Z-fake.log");
      expect(logs).toContain("nemar-2020-01-01T00-00-00-011Z-fake.log");
      expect(remaining).toContain("config.json");
      expect(remaining).toContain("notes.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keep greater than the file count is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-prune-noop-"));
    try {
      writeFileSync(join(dir, "nemar-2020-01-01T00-00-00-000Z-fake.log"), "x");
      pruneLogsDir(dir, 100);
      expect(readdirSync(dir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a nonexistent directory does not throw", () => {
    expect(() => pruneLogsDir(join(tmpdir(), "nemar-does-not-exist-xyz"), 10)).not.toThrow();
  });
});
