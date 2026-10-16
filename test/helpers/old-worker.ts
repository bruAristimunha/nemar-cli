/**
 * The 0.10.18 Worker, as the HTTP boundary of the API shows it, for the tests of what the current
 * CLI does against a Worker that predates this release.
 *
 * Why a stand-in at all: the package is published and the Worker is deployed by separate workflows
 * within minutes of each other, in either order, so for a while a new CLI talks to the old Worker
 * (`.rules/testing.md` allows a stand-in at the HTTP boundary of an old Worker when skew is the
 * thing under test). The current Worker's code cannot be run as the old one.
 *
 * What is real: every answer except the ones below is the current backend's own, forwarded as it
 * came, so the rows the old list route returns are real rows of a real database, and a refusal is
 * still a refusal the Worker made. What reproduces the old Worker, each read from
 * `git show origin/main:backend/src/routes/...` at the 0.10.18 tag:
 *
 *   - `GET /admin/publish/requests` ran `WHERE pr.status = ?` with the WHOLE `status` string, so
 *     `requested,approving,blocked` matched nothing, and it did not read `search` at all. Its rows
 *     had no `dataset_name` and no `publication_review`.
 *   - The routes this release added did not exist, and an unrouted request got the plain 404 body
 *     (`backend/src/lib/not-found.ts`, unchanged since): the review's detail and start routes, the
 *     comment route, the owner's force-verify and the depositor's withdraw.
 */

import { notFoundBody } from "../../backend/src/lib/not-found";

/** Routes the 0.10.18 Worker did not have, as `METHOD` and a pattern over the path. */
const ROUTES_ADDED_LATER: Array<[string, RegExp]> = [
  ["GET", /^\/admin\/publish\/[^/]+\/review$/],
  ["POST", /^\/admin\/publish\/[^/]+\/review\/start$/],
  ["POST", /^\/admin\/publish\/[^/]+\/comment$/],
  ["POST", /^\/admin\/users\/by-id\/[^/]+\/verify$/],
  ["POST", /^\/datasets\/[^/]+\/publish\/withdraw$/],
];

export interface OldWorkerCall {
  method: string;
  path: string;
  /** The query string as the command sent it, `?` included, or the empty string. */
  search: string;
}

export interface OldWorker {
  readonly url: string;
  /** Every request the command made to this Worker, in order; cleared by `reset()`. */
  readonly calls: OldWorkerCall[];
  reset(): void;
  stop(): void;
}

/** `forwardTo` is where the current backend answers (`PublishCli.apiUrl`). */
export function startOldWorker(forwardTo: string): OldWorker {
  const calls: OldWorkerCall[] = [];

  async function forward(req: Request, path: string, search: string): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.delete("host");
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    return fetch(`${forwardTo}${path}${search}`, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname: path, search } = url;
      calls.push({ method: req.method, path, search });

      if (ROUTES_ADDED_LATER.some(([m, re]) => m === req.method && re.test(path))) {
        return Response.json(notFoundBody(req.method, path), {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        });
      }

      if (req.method === "GET" && path === "/admin/publish/requests") {
        // The old route's only filter: string equality on the whole `status` value, when there is
        // one. `search` is never read. The rows are the current route's, asked for with no filter
        // at all, minus the two keys the old route did not send.
        const status = url.searchParams.get("status");
        const res = await forward(req, path, "");
        if (!res.ok) return res;
        const body = (await res.json()) as { requests: Array<Record<string, unknown>> };
        const requests = body.requests
          .filter((row) => !status || row.status === status)
          .map(({ dataset_name: _name, publication_review: _review, ...old }) => old);
        return Response.json({ requests, count: requests.length });
      }

      return forward(req, path, search);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    reset() {
      calls.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}
