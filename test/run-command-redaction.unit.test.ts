/**
 * What --verbose shows when the CLI reads a GitHub token through the real gh executable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureGitHubRemote, getGitHubToken } from "../src/lib/git-annex/github";
import { credentialValues, runCommand } from "../src/lib/git-annex/run-command";
import { adminGitHubToken } from "../src/lib/pr-review-approve";
import { setVerbose } from "../src/lib/verbose";

const SECRET = "NEMAR-TEST-GH-TOKEN-0123456789";

/** Run fn with verbose on, collecting what is written to stderr. */
async function verboseLog<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setVerbose(true);
  try {
    return { value: await fn(), log: chunks.join("") };
  } finally {
    setVerbose(false);
    process.stderr.write = write;
  }
}

afterEach(() => setVerbose(false));

describe("getGitHubToken under --verbose", () => {
  test("the real gh auth token result is not written to the verbose log", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nemar-gh-auth-"));
    const previous = {
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
    };
    process.env.GH_CONFIG_DIR = configDir;
    process.env.GH_TOKEN = SECRET;
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
    Reflect.deleteProperty(process.env, "GH_ENTERPRISE_TOKEN");

    try {
      const { value, log } = await verboseLog(getGitHubToken);

      expect(value.token).toBe(SECRET);
      expect(log).toContain("[sensitive subprocess output suppressed]");
      expect(log).not.toContain(SECRET);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("without --verbose the command writes nothing to the log", async () => {
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { runCommand } = await import("../src/lib/git-annex/run-command");
      await runCommand(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: process.cwd(),
      });
    } finally {
      process.stderr.write = write;
    }
    expect(chunks.join("")).toBe("");
  });
});

describe("credentialValues", () => {
  test("collects the given and inherited AWS values once each, skipping empty ones", () => {
    const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;
    const saved = keys.map((key) => process.env[key]);
    for (const key of keys) Reflect.deleteProperty(process.env, key);
    process.env.AWS_ACCESS_KEY_ID = "INHERITED-KEY-ID-0001";
    try {
      const values = credentialValues({
        AWS_SECRET_ACCESS_KEY: "NEMAR-TEST-AWS-SECRET",
        AWS_SESSION_TOKEN: "",
        AWS_ACCESS_KEY_ID: "INHERITED-KEY-ID-0001",
      });
      expect(values.sort()).toEqual(["INHERITED-KEY-ID-0001", "NEMAR-TEST-AWS-SECRET"].sort());
    } finally {
      for (const [i, key] of keys.entries()) {
        const value = saved[i];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});

/** A scratch git repository, removed by the caller. */
async function scratchRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "nemar-redact-repo-"));
  const init = await runCommand(["git", "init", "-q"], { cwd: dir });
  expect(init.exitCode).toBe(0);
  return dir;
}

describe("a secret handed to a command in its arguments", () => {
  test("`redact` blanks it from the echoed command line, and the command still gets it", async () => {
    const dir = await scratchRepo();
    try {
      const { value, log } = await verboseLog(() =>
        runCommand(["git", "config", "nemar.test", `password=${SECRET}`], {
          cwd: dir,
          redact: [SECRET],
        }),
      );

      expect(value.exitCode).toBe(0);
      expect(log).toContain("$ git config nemar.test");
      expect(log).toContain("<redacted>");
      expect(log).not.toContain(SECRET);
      const stored = await runCommand(["git", "config", "--get", "nemar.test"], { cwd: dir });
      expect(stored.stdout.trim()).toBe(`password=${SECRET}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without `redact` the echo shows the argument (the case the option exists for)", async () => {
    const dir = await scratchRepo();
    try {
      const { log } = await verboseLog(() =>
        runCommand(["git", "config", "nemar.test", `password=${SECRET}`], { cwd: dir }),
      );
      expect(log).toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("configureGitHubRemote does not write the token to the verbose log", async () => {
    const dir = await scratchRepo();
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = SECRET;
    try {
      const { value, log } = await verboseLog(() =>
        configureGitHubRemote(dir, "git@github.com:nemarDatasets/nm099999.git"),
      );

      expect(value.success).toBe(true);
      expect(log).not.toContain(SECRET);
      // The helper really was written, with the token, for later pushes.
      const helper = await runCommand(
        ["git", "config", "--get", "credential.https://github.com.helper"],
        { cwd: dir, sensitiveOutput: true },
      );
      expect(helper.stdout).toContain(`password=${SECRET}`);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "GH_TOKEN");
      else process.env.GH_TOKEN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("configureGitHubRemote with the token gh holds", () => {
  test("the token read from gh is not written to the verbose log either", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nemar-gh-remote-"));
    writeFileSync(
      join(configDir, "hosts.yml"),
      `github.com:\n    user: tester\n    oauth_token: ${SECRET}\n    git_protocol: https\n`,
    );
    const dir = await scratchRepo();
    const previous = {
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.GH_CONFIG_DIR = configDir;
    Reflect.deleteProperty(process.env, "GH_TOKEN");
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
    try {
      const { value, log } = await verboseLog(() =>
        configureGitHubRemote(dir, "git@github.com:nemarDatasets/nm099999.git"),
      );

      expect(value.success).toBe(true);
      expect(log).not.toContain(SECRET);
      const helper = await runCommand(
        ["git", "config", "--get", "credential.https://github.com.helper"],
        { cwd: dir, sensitiveOutput: true },
      );
      expect(helper.stdout).toContain(`password=${SECRET}`);
    } finally {
      for (const [key, v] of Object.entries(previous)) {
        if (v === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = v;
      }
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adminGitHubToken under --verbose", () => {
  test("the token gh holds is read and not written to the verbose log", async () => {
    // The stored login, as `gh` itself reads it: no environment token, a config directory
    // whose hosts file holds the login in plain text.
    const configDir = mkdtempSync(join(tmpdir(), "nemar-gh-admin-"));
    writeFileSync(
      join(configDir, "hosts.yml"),
      `github.com:\n    user: tester\n    oauth_token: ${SECRET}\n    git_protocol: https\n`,
    );
    const previous = {
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.GH_CONFIG_DIR = configDir;
    Reflect.deleteProperty(process.env, "GH_TOKEN");
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
    try {
      const { value, log } = await verboseLog(() => adminGitHubToken({}));

      expect(value).toEqual({ ok: true, token: SECRET, source: "gh" });
      expect(log).toContain("[sensitive subprocess output suppressed]");
      expect(log).not.toContain(SECRET);
    } finally {
      for (const [key, v] of Object.entries(previous)) {
        if (v === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = v;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
