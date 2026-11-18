/**
 * A stand-in for the two EXTERNAL services the Zarr source check reads (portable compute, card DM-06b): the
 * GitHub REST API (a commit by tag, and the compare of two commits) and the Zarr serving copy's index
 * (`<base>/<id>/zarr/index.json`). One real `Bun.serve` on loopback; the request log says what was asked, so a
 * test can say a path made no call and that a dispatch made at most three.
 *
 * It answers only what a test has told it, and a question it was not told about is the answer GitHub gives
 * for an object it does not have (404). Nothing of NEMAR's own logic is in here: it neither compares commits
 * nor reads a path.
 *
 *   const github = startGithubCompareStandin();
 *   (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = github.url;
 *   (globalThis as { NEMAR_ZARR_INDEX_BASE?: string }).NEMAR_ZARR_INDEX_BASE = github.indexBase;
 */

const LOOPBACK = "127.0.0.1";
/** The most files GitHub lists for one comparison. */
const GITHUB_COMPARE_FILES_MAX = 300;

/** One request the stand-in saw. `authorization` is the scheme only (`Bearer`) or null: no token is kept. */
export interface StandinRequest {
  method: string;
  path: string;
  /** The query string, without the `?`. */
  query: string;
  authorization: "Bearer" | "other" | null;
  userAgent: string | null;
}

/** A file of a compare, as GitHub lists it. */
export interface CompareFile {
  filename: string;
  status?: string;
  previous_filename?: string;
}

/** What a compare answers: a 200 body, or only a status. */
export type CompareAnswer =
  | { status: string; behind_by: number; ahead_by?: number; files?: unknown; [k: string]: unknown }
  | { http: number };

export interface GithubCompareStandin {
  /** The GitHub API base (`NEMAR_GITHUB_API_URL`). */
  url: string;
  /** The index base (`NEMAR_ZARR_INDEX_BASE`): `<indexBase>/<id>/zarr/index.json`. */
  indexBase: string;
  /** Every request, in order. */
  log: StandinRequest[];
  /**
   * A TAG of a repository: the commit it resolves to (a lightweight and an annotated tag both resolve to the
   * commit the endpoint answers, so one call serves both), or the status to answer instead, or a whole body.
   * It resolves through `commits/refs/tags/<name>` and, as on GitHub, through the bare `commits/<name>`; the
   * short `commits/tags/<name>` is a 422. Unset: 404.
   */
  tag(repo: string, name: string, answer: string | { http: number } | { body: unknown }): void;
  /**
   * A BRANCH of a repository. GitHub's `commits/<ref>` resolves a branch by its bare name (and `refs/heads/`),
   * and a branch does NOT resolve through `refs/tags/`: a caller that wants a tag must say so.
   */
  branch(repo: string, name: string, commit: string): void;
  /** The compare of `base...head`, 404 when unset. */
  compare(repo: string, base: string, head: string, answer: CompareAnswer): void;
  /** The index of a dataset: a document, or a status (404 when unset); a string is sent as it is. */
  index(
    id: string,
    answer: Record<string, unknown> | string | { http: number } | { stream: string },
  ): void;
  /** Answer the requests of `scope` (default: both services) only after `ms` (a stalled service). */
  stall(ms: number, scope?: "all" | "github" | "index"): void;
  /** Forget every answer and the log. */
  reset(): void;
  stop(): void;
}

const isStatusOnly = (v: unknown): v is { http: number } =>
  typeof v === "object" &&
  v !== null &&
  "http" in v &&
  typeof (v as { http: unknown }).http === "number";

export function startGithubCompareStandin(): GithubCompareStandin {
  const tags = new Map<string, string | { http: number } | { body: unknown }>();
  const branches = new Map<string, string>();
  const compares = new Map<string, CompareAnswer>();
  const indexes = new Map<
    string,
    Record<string, unknown> | string | { http: number } | { stream: string }
  >();
  const log: StandinRequest[] = [];
  let stallMs = 0;
  let stallScope: "all" | "github" | "index" = "all";

  const server = Bun.serve({
    port: 0,
    hostname: LOOPBACK,
    // A stalled answer must end at the CLIENT's deadline, never at the server's. Bun.serve closes a request
    // that has been idle for `idleTimeout` seconds (10 by default, the same as the index deadline), and when
    // it wins that race on a pooled connection the client sends the request a second time, so the log counts
    // two index requests where the check made one. Measured: with a pooled connection and a server idle
    // timeout shorter than the client's deadline the stalled path was seen twice; with it longer, once.
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      log.push({
        method: req.method,
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        authorization: auth === null ? null : auth.startsWith("Bearer ") ? "Bearer" : "other",
        userAgent: req.headers.get("user-agent"),
      });
      const isIndex = url.pathname.startsWith("/zarr-index/");
      const stalled = stallScope === "all" || (stallScope === "index" ? isIndex : !isIndex);
      if (stallMs > 0 && stalled) await new Promise((r) => setTimeout(r, stallMs));

      let m = /^\/repos\/nemarDatasets\/([^/]+)\/commits\/(.+)$/.exec(url.pathname);
      if (m) {
        const repo = m[1] as string;
        const ref = decodeURIComponent(m[2] as string);
        // How GitHub resolves `commits/<ref>`: a fully qualified ref by its kind, the short `tags/` form is
        // refused, and a bare name is any ref (a branch first, then a tag).
        let hit: string | { http: number } | { body: unknown } | undefined;
        if (ref.startsWith("refs/tags/")) {
          hit = tags.get(`${repo}/${ref.slice("refs/tags/".length)}`);
        } else if (ref.startsWith("refs/heads/")) {
          hit = branches.get(`${repo}/${ref.slice("refs/heads/".length)}`);
        } else if (ref.startsWith("tags/")) {
          return Response.json({ message: "No commit found for the ref" }, { status: 422 });
        } else {
          hit = branches.get(`${repo}/${ref}`) ?? tags.get(`${repo}/${ref}`);
        }
        if (hit === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
        if (typeof hit !== "string") {
          if ("body" in hit) return Response.json(hit.body);
          return new Response("{}", { status: hit.http });
        }
        return Response.json({ sha: hit, commit: { message: "x" } });
      }
      m = /^\/repos\/nemarDatasets\/([^/]+)\/compare\/(.+)$/.exec(url.pathname);
      if (m) {
        const hit = compares.get(`${m[1]}/${decodeURIComponent(m[2] as string)}`);
        if (hit === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
        if (isStatusOnly(hit)) return new Response("{}", { status: hit.http });
        // GitHub lists at most 300 files of a comparison, however many changed.
        const files = (hit as { files?: unknown }).files;
        return Response.json(
          Array.isArray(files) ? { ...hit, files: files.slice(0, GITHUB_COMPARE_FILES_MAX) } : hit,
        );
      }
      m = /^\/zarr-index\/([^/]+)\/zarr\/index\.json$/.exec(url.pathname);
      if (m) {
        const hit = indexes.get(m[1] as string);
        if (hit === undefined) return new Response("not found", { status: 404 });
        if (isStatusOnly(hit)) return new Response("{}", { status: hit.http });
        if (typeof hit === "string") return new Response(hit, { status: 200 });
        // A chunked body with no declared length: only the reader's own bound can stop it.
        if ("stream" in hit) {
          const text = hit.stream;
          return new Response(
            new ReadableStream({
              start(controller) {
                const bytes = new TextEncoder().encode(text);
                for (let at = 0; at < bytes.length; at += 1 << 20) {
                  controller.enqueue(bytes.subarray(at, at + (1 << 20)));
                }
                controller.close();
              },
            }),
          );
        }
        return Response.json(hit);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://${LOOPBACK}:${server.port}`;
  return {
    url,
    indexBase: `${url}/zarr-index`,
    log,
    tag: (repo, name, answer) => void tags.set(`${repo}/${name}`, answer),
    branch: (repo, name, commit) => void branches.set(`${repo}/${name}`, commit),
    compare: (repo, base, head, answer) => void compares.set(`${repo}/${base}...${head}`, answer),
    index: (id, answer) => void indexes.set(id, answer),
    stall: (ms, scope = "all") => {
      stallMs = ms;
      stallScope = scope;
    },
    reset() {
      tags.clear();
      branches.clear();
      compares.clear();
      indexes.clear();
      log.length = 0;
      stallMs = 0;
      stallScope = "all";
    },
    stop: () => void server.stop(true),
  };
}
