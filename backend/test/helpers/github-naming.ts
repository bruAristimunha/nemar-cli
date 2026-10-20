/**
 * GitHub's answers to the two reads the naming rule makes on an exempt pull request (ADR 0107),
 * for the test stand-ins that stand in for api.github.com:
 *
 *   GET /repos/nemarDatasets/{repo}/compare/{base}...{head}
 *       the merge base, and the files the pull request changes
 *   GET /repos/nemarDatasets/{repo}/contents/dataset_description.json?ref={sha}
 *       the file at a commit (the Worker asks for the raw text)
 *
 * Each stand-in keeps a table keyed by repository. A repository with no entry gets {@link
 * UNCHANGED_NAME}: the merge base is the base commit and `dataset_description.json` is not among
 * the changed files, so the rule finds no name change and reads nothing more, which is what a test
 * about something else needs.
 *
 * The comparison answers as GitHub's does in the two respects the rule depends on: the file list
 * comes with the first page, and the commits are paged by the `per_page` the request asks for (30
 * when it asks for none, at most 100), with the whole count in `total_commits`.
 */

/**
 * A `dataset_description.json` answered as these exact bytes, for a file whose content is not a
 * name: use {@link NOT_JSON}, {@link NO_NAME} or {@link NAME_NOT_TEXT}.
 */
export interface RawDescription {
  raw: string;
}

/** A file that is there and is not JSON at all. */
export const NOT_JSON: RawDescription = { raw: "{ this is not json" };
/** JSON with no `Name` in it. */
export const NO_NAME: RawDescription = { raw: JSON.stringify({ BIDSVersion: "1.9.0" }) };
/** JSON whose `Name` is not text. */
export const NAME_NOT_TEXT: RawDescription = {
  raw: JSON.stringify({ Name: 7, BIDSVersion: "1.9.0" }),
};

/** The comparison's file list when it has reached GitHub's cap, which may have cut the list short. */
export const CUT_LIST: string[] = Array.from(
  { length: 300 },
  (_, i) => `sub-${i}/eeg/sub-${i}_task-rest_events.tsv`,
);

export interface NamingRepo {
  /** The merge base the comparison names; the base commit of the request when absent. */
  mergeBase?: string;
  /**
   * The files the comparison lists: a name (listed as modified), or GitHub's own entry, for a status
   * of its own or a rename (`previous_filename`). `null` leaves the list out of the answer.
   */
  files?: Array<string | { filename: string; status?: string; previous_filename?: string }> | null;
  /**
   * The commits of the comparison: how many it has (`total`, one when absent), and how many of them
   * the answer's page holds. A page holds as many as the request's `per_page` allows, as GitHub's
   * does, unless `onPage` says how many it holds whatever was asked: a page that is only part of the
   * comparison, which is what a test sets to see the rule refuse to believe a `files` that may not
   * cover it. `null` leaves `commits` and `total_commits` out of the answer.
   */
  commits?: { total: number; onPage?: number } | null;
  /**
   * What `dataset_description.json` holds at a commit: a `Name` (the file is
   * `{"Name": ..., "BIDSVersion": "1.9.0"}`), null for no file (404), an HTTP status to answer, or
   * a file whose content is not a name ({@link NOT_JSON}, {@link NO_NAME}, {@link NAME_NOT_TEXT}).
   * A commit left out of the table is a 404, which the comparison's list may or may not explain: a
   * file it lists as removed is gone, and one it does not list (`files: null`, {@link CUT_LIST}) is
   * a 404 nothing accounts for.
   */
  names?: Record<string, string | null | number | RawDescription>;
  /** An HTTP status for the comparison itself, instead of an answer. */
  compareStatus?: number;
  /** Answer the comparison only after this long, past any timeout a test sets. */
  compareDelayMs?: number;
}

export const UNCHANGED_NAME: NamingRepo = { files: ["README.md"] };

const COMPARE = /^\/repos\/nemarDatasets\/([^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/;
const CONTENTS = /^\/repos\/nemarDatasets\/([^/]+)\/contents\/dataset_description\.json$/;

/** Whether a request is one of the naming rule's reads. */
export function isNamingPath(pathname: string): boolean {
  return COMPARE.test(pathname) || CONTENTS.test(pathname);
}

/** The answer for a request, or null when it is not one of the naming rule's reads. */
export async function namingResponse(
  url: URL,
  table: Readonly<Record<string, NamingRepo>>,
): Promise<Response | null> {
  const compare = url.pathname.match(COMPARE);
  if (compare) {
    const repo = table[decodeURIComponent(compare[1])] ?? UNCHANGED_NAME;
    if (repo.compareDelayMs !== undefined) await Bun.sleep(repo.compareDelayMs);
    if (repo.compareStatus !== undefined) {
      return new Response("{}", { status: repo.compareStatus, headers: { "retry-after": "0" } });
    }
    const total = repo.commits?.total ?? 1;
    const asked = Number(url.searchParams.get("per_page") ?? "30");
    const pageSize = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 100) : 30;
    const onPage = repo.commits?.onPage ?? Math.min(total, pageSize);
    return Response.json({
      merge_base_commit: { sha: repo.mergeBase ?? compare[2] },
      ...(repo.commits === null
        ? {}
        : {
            total_commits: total,
            commits: Array.from({ length: onPage }, (_, i) => ({
              sha: (i + 1).toString(16).padStart(40, "0"),
            })),
          }),
      ...(repo.files === null
        ? {}
        : {
            files: (repo.files ?? []).map((f) =>
              typeof f === "string" ? { filename: f, status: "modified" } : f,
            ),
          }),
    });
  }
  const contents = url.pathname.match(CONTENTS);
  if (contents) {
    const repo = table[decodeURIComponent(contents[1])] ?? UNCHANGED_NAME;
    const ref = url.searchParams.get("ref") ?? "";
    const name = repo.names?.[ref];
    if (name === undefined || name === null) return new Response("not found", { status: 404 });
    if (typeof name === "number") {
      return new Response("{}", { status: name, headers: { "retry-after": "0" } });
    }
    if (typeof name === "object") {
      return new Response(name.raw, {
        headers: { "content-type": "application/vnd.github.raw+json" },
      });
    }
    return new Response(JSON.stringify({ Name: name, BIDSVersion: "1.9.0" }), {
      headers: { "content-type": "application/vnd.github.raw+json" },
    });
  }
  return null;
}
