/**
 * Fixtures for the pull-request review queue's tests (ADR 0093): the nodes GitHub's GraphQL search
 * returns for open pull requests, a valid stored report, and a `pr_reviews` row.
 *
 * Shared by the Worker-side suite (backend/test/pr-review-queue.test.ts) and the command-line
 * suite (test/admin-pr-reviews-cli.test.ts), so the two cannot drift into testing different
 * shapes of the same thing.
 */

import type { Database } from "bun:sqlite";
import {
  LEGACY_INLINE_BIDS_REPOS,
  NEMAR_APP_ID,
} from "../../src/services/github/branch-protection";

/** GitHub Actions, the app that posts a workflow job's check run (and `version-check`). */
export const GITHUB_ACTIONS_APP_ID = 15368;

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export interface CheckSpec {
  type: "run" | "status";
  name: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  at?: string;
  /** The GitHub App that posted a check run. Defaults to GitHub Actions. */
  appId?: number;
}

export interface PrSpec {
  ds: string;
  n: number;
  sha?: string;
  author?: string | null;
  authorId?: number | null;
  authorType?: string;
  draft?: boolean;
  forkOwner?: string | null | false;
  branch?: string;
  created?: string;
  title?: string;
  /** null: the commit has no rollup at all. */
  checks?: CheckSpec[] | null;
  moreChecks?: boolean;
  repoOwner?: string;
  /** GraphQL `state` (OPEN, MERGED, CLOSED) and `baseRefName`: the search index can lag. */
  prState?: string;
  baseRef?: string;
  /** The commit the connection returns, when it is not the head the search names. */
  commitOid?: string;
  /** Fields a pull request has that the query never asks for; the response must not carry them. */
  extra?: Record<string, unknown>;
}

export function bidsOk(ds: string): CheckSpec {
  // Every dataset in these tests except the four legacy ones runs the central BIDS shim.
  return {
    type: "run",
    name: LEGACY_INLINE_BIDS_REPOS.has(ds) ? "bids-validation" : "Run BIDS Validation",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    // The ruleset pins the central BIDS check to the NEMAR App; the legacy one is a plain job.
    appId: LEGACY_INLINE_BIDS_REPOS.has(ds) ? GITHUB_ACTIONS_APP_ID : NEMAR_APP_ID,
  };
}
export const versionOk: CheckSpec = {
  type: "run",
  name: "version-check",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};

export function checkNode(c: CheckSpec): Record<string, unknown> {
  return c.type === "run"
    ? {
        __typename: "CheckRun",
        name: c.name,
        status: c.status ?? "COMPLETED",
        conclusion: c.conclusion ?? null,
        startedAt: c.status === "QUEUED" ? null : (c.at ?? "2026-10-01T00:00:00Z"),
        checkSuite: { app: { databaseId: c.appId ?? GITHUB_ACTIONS_APP_ID } },
      }
    : {
        __typename: "StatusContext",
        context: c.name,
        state: c.state ?? "SUCCESS",
        createdAt: c.at ?? "2026-10-01T00:00:00Z",
      };
}

export function prNode(o: PrSpec): Record<string, unknown> {
  const checks = o.checks === undefined ? [bidsOk(o.ds), versionOk] : o.checks;
  const author =
    o.author === null
      ? null
      : {
          __typename: o.authorType ?? "User",
          login: o.author ?? "contributor",
          ...((o.authorType ?? "User") === "User" ? { databaseId: o.authorId ?? 501 } : {}),
        };
  return {
    __typename: "PullRequest",
    number: o.n,
    state: o.prState ?? "OPEN",
    baseRefName: o.baseRef ?? "main",
    ...o.extra,
    title: o.title ?? `Update ${o.ds}`,
    isDraft: o.draft ?? false,
    createdAt: o.created ?? "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    headRefName: o.branch ?? "update-metadata",
    headRefOid: o.sha ?? SHA_A,
    isCrossRepository: o.forkOwner !== undefined && o.forkOwner !== false,
    headRepositoryOwner: typeof o.forkOwner === "string" ? { login: o.forkOwner } : null,
    repository: { name: o.ds, owner: { login: o.repoOwner ?? "nemarDatasets" } },
    author,
    commits: {
      nodes: [
        {
          commit: {
            oid: o.commitOid ?? o.sha ?? SHA_A,
            statusCheckRollup:
              checks === null
                ? null
                : {
                    contexts: {
                      pageInfo: { hasNextPage: o.moreChecks === true },
                      nodes: checks.map(checkNode),
                    },
                  },
          },
        },
      ],
    },
  };
}

export const EMPTY = { added: 0, modified: 0, removed: 0 };
export function goodReport(criteria: Record<string, string> = {}) {
  return {
    v: 1,
    model: "claude-haiku-5-5",
    criteria: {
      no_degradation: "pass",
      advances_revision: "pass",
      material_improvement: "pass",
      ...criteria,
    },
    findings: [],
    summary: "Adds two subjects and corrects the task description.",
    steering: false,
    evidence: {
      files_changed: 3,
      files_read: 1,
      truncated: false,
      version_before: "1.0.0",
      version_after: "1.1.0",
      subjects_before: 20,
      subjects_after: 22,
      areas: {
        dataset_description: { added: 0, modified: 1, removed: 0 },
        readme_and_changes: EMPTY,
        participants: EMPTY,
        sidecars: EMPTY,
        recordings: { added: 2, modified: 0, removed: 0 },
        derivatives: EMPTY,
        sourcedata: EMPTY,
        code: EMPTY,
        other: EMPTY,
      },
      listed: [{ status: "modified", path: "dataset_description.json" }],
    },
  };
}

export interface RowSeed {
  ds: string;
  n: number;
  sha?: string;
  authorId?: number;
  login?: string;
  state: "dispatched" | "reported" | "declined" | "errored" | "unreported";
  verdict?: "pass" | "fail" | "uncertain" | null;
  detail?: string | null;
  report?: unknown;
  createdAt?: string;
  /** When the commit was last delivered; defaults to now. "Newest" means the last SEEN. */
  seenAt?: string;
}

export function seedReview(db: Database, r: RowSeed) {
  const report =
    r.report !== undefined
      ? r.report
      : r.state === "reported"
        ? goodReport(
            r.verdict === "fail"
              ? { no_degradation: "fail" }
              : r.verdict === "uncertain"
                ? { material_improvement: "unknown" }
                : {},
          )
        : null;
  // A review still waiting for its report is dated now unless a test says otherwise: an old one
  // reads as never reported (the queue does not show an overdue review as running).
  const created =
    r.createdAt ??
    (r.state === "dispatched"
      ? new Date().toISOString().slice(0, 19).replace("T", " ")
      : "2026-10-01 00:00:00");
  db.run(
    `INSERT INTO pr_reviews (dataset_id, pr_number, head_sha, author_id, author_login, state,
                             verdict, detail, report, created_at, decided_at, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%d %H:%M:%f', 'now')))`,
    [
      r.ds,
      r.n,
      r.sha ?? SHA_A,
      r.authorId ?? 501,
      r.login ?? "contributor",
      r.state,
      r.verdict ?? null,
      r.detail ?? null,
      report === null ? null : typeof report === "string" ? report : JSON.stringify(report),
      created,
      r.state === "dispatched" ? null : created,
      r.seenAt ?? null,
    ],
  );
}
