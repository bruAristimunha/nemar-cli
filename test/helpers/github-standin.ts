/**
 * A `Bun.serve()` stand-in for api.github.com that speaks everything the pull-request review queue
 * and the CLI's approval make: the GraphQL search and the REST reads the Worker makes with the
 * datasets token, and the calls the CLI makes with an administrator's own token (`GET /user`, the
 * pull request, a review, a merge).
 *
 * It answers `GET /user` by token, so an app token is refused as a person's and a bot is not
 * accepted, and it records every request with the token it carried. That record is the property
 * under test: the tests show that the Worker's token never reached a review or a merge endpoint.
 */

import type { Server } from "bun";
import { projectOnto } from "../../backend/test/helpers/graphql-select";

export const WORKER_TOKEN = "ghp_worker_datasets_token";
export const ADMIN_TOKEN = "gho_admin_own_token";
export const APP_TOKEN = "ghs_app_installation_token";
export const OTHER_TOKEN = "gho_someone_else";
export const BOT_TOKEN = "gho_a_bot_login";
/** A bot by LOGIN whose type claims to be a person, and one by TYPE whose login does not say so, so each guard is tested without the other. */
export const BOT_LOGIN_TOKEN = "gho_a_bot_by_login";
export const BOT_TYPE_TOKEN = "gho_a_bot_by_type";

export interface Seen {
  method: string;
  path: string;
  token: string | null;
  body: Record<string, unknown> | null;
}

export interface PullState {
  state?: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  base?: string;
  sha: string;
  author?: string;
  /** GitHub's numeric id for the author; 501 unless a test says otherwise. */
  authorId?: number;
  /** `author_association` on the pull request ("COLLABORATOR" unless set). */
  assoc?: string;
  mergeableState?: string;
  /** Served for the first N reads, then `mergeableState`. */
  unknownReads?: number;
  /** Set after the approval is recorded, to simulate a push landing in between. */
  movesToAfterReview?: string;
  /** The head every read AFTER THE FIRST sees: a push that lands between two readers' reads. */
  headAfterFirstRead?: string;
}

export interface GitHubStandin {
  url: string;
  seen: Seen[];
  /** Pull requests the REST read serves, keyed `dataset#number`. */
  pulls: Record<string, PullState>;
  /** The GraphQL search pages. */
  searchPages: unknown[][];
  /** The `issueCount` the search reports, when a test needs it to differ from the nodes returned. */
  searchTotal: number | null;
  /** What the repository dispatch that hands a review to the workflow answers (204 accepts it). */
  dispatchStatus: number;
  users: Record<string, { id: number; login: string; type: string }>;
  /** When set, the review POST answers this status instead of recording an approval. */
  reviewStatus: number | null;
  /** When set, the review POST records this state instead of APPROVED. */
  reviewState: string | null;
  /** When set, the review POST answers with this commit instead of the one it was asked about. */
  reviewCommit: string | null;
  /** When set, `GET /user` answers this status whatever the token (an outage, a rate limit). */
  userStatus: number | null;
  /** The message body of that answer. */
  userMessage: string;
  mergeStatus: number;
  /** When set, posting a comment answers this status instead of recording it. */
  commentStatus: number | null;
  /** When set, closing a pull request answers this status instead of closing it. */
  closeStatus: number | null;
  /** The comments recorded, in order: `{ dataset, number, body, token }`. */
  comments: Array<{ dataset: string; number: number; body: string; token: string | null }>;
  /**
   * When true, the review POST and the merge PUT are APPLIED and answered 200 with a body that is
   * not JSON: the case where a write happened and its answer cannot be read.
   */
  unreadableAnswers: boolean;
  reset(): void;
  stop(): void;
}

const IDENTITIES: Record<string, { login: string; id: number; type: string } | number> = {
  [ADMIN_TOKEN]: { login: "queueadmin-gh", id: 9001, type: "User" },
  [OTHER_TOKEN]: { login: "someone-else", id: 9002, type: "User" },
  [BOT_TOKEN]: { login: "nemar-bot[bot]", id: 9003, type: "Bot" },
  [BOT_TYPE_TOKEN]: { login: "helper-account", id: 9004, type: "Bot" },
  [BOT_LOGIN_TOKEN]: { login: "odd-account[bot]", id: 9005, type: "User" },
  // An installation token is refused by GET /user.
  [APP_TOKEN]: 403,
};

export function startGitHubStandin(): GitHubStandin {
  const state = {
    seen: [] as Seen[],
    pulls: {} as Record<string, PullState>,
    searchPages: [] as unknown[][],
    searchTotal: null as number | null,
    dispatchStatus: 204,
    users: {} as GitHubStandin["users"],
    reviewStatus: null as number | null,
    reviewState: null as string | null,
    reviewCommit: null as string | null,
    userStatus: null as number | null,
    userMessage: "Server Error",
    mergeStatus: 200,
    commentStatus: null as number | null,
    closeStatus: null as number | null,
    comments: [] as GitHubStandin["comments"],
    unreadableAnswers: false,
  };
  const reads: Record<string, number> = {};

  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "") || null;
      const body = req.method === "GET" ? null : ((await req.json().catch(() => null)) as never);
      state.seen.push({ method: req.method, path: url.pathname, token, body });

      if (req.method === "POST" && url.pathname === "/graphql") {
        const after = (body as { variables?: { after?: string | null } } | null)?.variables?.after;
        const index = after ? Number(after) : 0;
        // Only the fields the query asks for, as GitHub sends them.
        return Response.json({
          data: projectOnto(String((body as { query?: unknown } | null)?.query ?? ""), {
            search: {
              issueCount: state.searchTotal ?? state.searchPages.flat().length,
              pageInfo: {
                hasNextPage: index + 1 < state.searchPages.length,
                endCursor: String(index + 1),
              },
              nodes: state.searchPages[index] ?? [],
            },
          }),
        });
      }

      if (req.method === "GET" && url.pathname === "/user") {
        if (state.userStatus !== null) {
          return Response.json({ message: state.userMessage }, { status: state.userStatus });
        }
        const who = token ? IDENTITIES[token] : undefined;
        if (typeof who === "number") {
          return Response.json(
            { message: "Resource not accessible by integration" },
            { status: who },
          );
        }
        return who
          ? Response.json(who)
          : Response.json({ message: "Bad credentials" }, { status: 401 });
      }

      const user = url.pathname.match(/^\/users\/([^/]+)$/);
      if (req.method === "GET" && user) {
        const hit = state.users[user[1].toLowerCase()];
        return hit ? Response.json(hit) : new Response("{}", { status: 404 });
      }

      // What the Worker does when it starts a review: hand it to the central workflow and publish
      // the check and the comment. Recorded in `seen` with the token each carried.
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        return new Response(state.dispatchStatus < 300 ? null : "{}", {
          status: state.dispatchStatus,
        });
      }
      if (/^\/repos\/nemarDatasets\/[^/]+\/check-runs(\/\d+)?$/.test(url.pathname)) {
        return Response.json(
          { id: 7000 + state.seen.length },
          { status: req.method === "POST" ? 201 : 200 },
        );
      }
      if (req.method === "PATCH" && /\/issues\/comments\/\d+$/.test(url.pathname)) {
        return Response.json({ id: 1 });
      }

      const comment = url.pathname.match(
        /^\/repos\/nemarDatasets\/([^/]+)\/issues\/(\d+)\/comments$/,
      );
      if (req.method === "POST" && comment) {
        if (state.commentStatus !== null) {
          return Response.json({ message: "Validation Failed" }, { status: state.commentStatus });
        }
        if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 201 });
        const text = (body as { body?: string } | null)?.body ?? "";
        state.comments.push({ dataset: comment[1], number: Number(comment[2]), body: text, token });
        return Response.json({ id: state.comments.length, body: text }, { status: 201 });
      }

      const pull = url.pathname.match(/^\/repos\/nemarDatasets\/([^/]+)\/pulls\/(\d+)(\/[a-z]+)?$/);
      if (pull) {
        const key = `${pull[1]}#${pull[2]}`;
        const p = state.pulls[key];
        if (!p) return Response.json({ message: "Not Found" }, { status: 404 });
        if (req.method === "GET" && !pull[3]) {
          reads[key] = (reads[key] ?? 0) + 1;
          const unknown = (p.unknownReads ?? 0) >= reads[key];
          return Response.json({
            number: Number(pull[2]),
            state: p.state ?? "open",
            merged: p.merged ?? false,
            draft: p.draft ?? false,
            mergeable_state: unknown ? "unknown" : (p.mergeableState ?? "clean"),
            title: "Add subjects",
            author_association: p.assoc ?? "COLLABORATOR",
            user: { login: p.author ?? "contributor", id: p.authorId ?? 501, type: "User" },
            base: {
              ref: p.base ?? "main",
              repo: {
                name: pull[1],
                full_name: `nemarDatasets/${pull[1]}`,
                owner: { login: "nemarDatasets" },
              },
            },
            head: {
              sha: p.headAfterFirstRead && reads[key] > 1 ? p.headAfterFirstRead : p.sha,
              ref: "add-subjects",
              repo: { full_name: `nemarDatasets/${pull[1]}`, owner: { login: "nemarDatasets" } },
            },
          });
        }
        if (req.method === "PATCH" && !pull[3]) {
          if (state.closeStatus !== null) {
            return Response.json({ message: "Validation Failed" }, { status: state.closeStatus });
          }
          if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 200 });
          p.state = "closed";
          return Response.json({ number: Number(pull[2]), state: "closed" });
        }
        if (req.method === "POST" && pull[3] === "/reviews") {
          if (state.reviewStatus !== null) {
            return Response.json(
              { message: "Can not approve your own pull request" },
              { status: state.reviewStatus },
            );
          }
          const who = token ? IDENTITIES[token] : undefined;
          const login = typeof who === "object" ? who.login : "unknown";
          const commit = (body as { commit_id?: string } | null)?.commit_id ?? p.sha;
          if (p.movesToAfterReview) p.sha = p.movesToAfterReview;
          if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 200 });
          return Response.json({
            id: 1,
            state: state.reviewState ?? "APPROVED",
            commit_id: state.reviewCommit ?? commit,
            user: { login },
          });
        }
        if (req.method === "PUT" && pull[3] === "/merge") {
          if (state.unreadableAnswers) return new Response("<html>proxy</html>", { status: 200 });
          if (state.mergeStatus === 200) {
            p.merged = true;
            p.state = "closed";
          }
          return state.mergeStatus === 200
            ? Response.json({ merged: true, sha: "f".repeat(40) })
            : Response.json(
                { message: "Pull Request is not mergeable" },
                { status: state.mergeStatus },
              );
        }
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    get seen() {
      return state.seen;
    },
    get pulls() {
      return state.pulls;
    },
    get searchPages() {
      return state.searchPages;
    },
    set searchPages(v) {
      state.searchPages = v;
    },
    get searchTotal() {
      return state.searchTotal;
    },
    set searchTotal(v) {
      state.searchTotal = v;
    },
    get dispatchStatus() {
      return state.dispatchStatus;
    },
    set dispatchStatus(v) {
      state.dispatchStatus = v;
    },
    get users() {
      return state.users;
    },
    get reviewStatus() {
      return state.reviewStatus;
    },
    set reviewStatus(v) {
      state.reviewStatus = v;
    },
    get reviewState() {
      return state.reviewState;
    },
    set reviewState(v) {
      state.reviewState = v;
    },
    get reviewCommit() {
      return state.reviewCommit;
    },
    set reviewCommit(v) {
      state.reviewCommit = v;
    },
    get userStatus() {
      return state.userStatus;
    },
    set userStatus(v) {
      state.userStatus = v;
    },
    get userMessage() {
      return state.userMessage;
    },
    set userMessage(v) {
      state.userMessage = v;
    },
    get mergeStatus() {
      return state.mergeStatus;
    },
    set mergeStatus(v) {
      state.mergeStatus = v;
    },
    get commentStatus() {
      return state.commentStatus;
    },
    set commentStatus(v) {
      state.commentStatus = v;
    },
    get closeStatus() {
      return state.closeStatus;
    },
    set closeStatus(v) {
      state.closeStatus = v;
    },
    get comments() {
      return state.comments;
    },
    get unreadableAnswers() {
      return state.unreadableAnswers;
    },
    set unreadableAnswers(v) {
      state.unreadableAnswers = v;
    },
    reset() {
      state.seen.length = 0;
      state.searchPages = [];
      state.searchTotal = null;
      state.dispatchStatus = 204;
      state.reviewStatus = null;
      state.reviewState = null;
      state.reviewCommit = null;
      state.userStatus = null;
      state.userMessage = "Server Error";
      state.mergeStatus = 200;
      state.unreadableAnswers = false;
      state.commentStatus = null;
      state.closeStatus = null;
      state.comments.length = 0;
      for (const k of Object.keys(state.pulls)) delete state.pulls[k];
      for (const k of Object.keys(state.users)) delete state.users[k];
      for (const k of Object.keys(reads)) delete reads[k];
    },
    stop() {
      server.stop(true);
    },
  } as GitHubStandin;
}
