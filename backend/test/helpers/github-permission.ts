/**
 * GitHub's answer to `GET /repos/{owner}/{repo}/collaborators/{login}/permission`, for the test
 * stand-ins that stand in for api.github.com.
 *
 * The review's exemption asks it once a NEMAR account has matched (ADR 0107). The real endpoint
 * answers 200 with `{ permission, role_name, user }` for any login on a public repository, `read`
 * for a login with no access at all, and 404 for a login that does not exist, so a stand-in that
 * said `admin` for everyone would hide the whole point of the question. Each stand-in therefore
 * keeps a table: `repo#login` (the login in lower case) beats `login`, and a login with no entry
 * gets `fallback`, which is `admin` so that a test about something else need not mention it.
 *
 * `permission` is GitHub's legacy field, which folds `maintain` into `write` and `triage` into
 * `read`; `role_name` is the real role. The two are built together the way GitHub builds them.
 */

export type PermissionAnswer =
  /** A role: the pair of fields GitHub sends for it. */
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none"
  /** An HTTP status with an empty body (a retry-after of zero, so a failing test is not slow). */
  | number
  /** A 200 whose body is not JSON. */
  | "garbage"
  /** A 200 that carries the legacy `permission` and no `role_name`. */
  | "no_role_name"
  /** A 200 that answers after this long, past any timeout a test sets. */
  | { delayMs: number };

const LEGACY: Record<string, string> = {
  admin: "admin",
  maintain: "write",
  write: "write",
  triage: "read",
  read: "read",
  none: "none",
};

/** The path this answers. Group 1 is the repository, group 2 the login. */
const PERMISSION_PATH = /^\/repos\/nemarDatasets\/([^/]+)\/collaborators\/([^/]+)\/permission$/;

export function isPermissionPath(pathname: string): boolean {
  return PERMISSION_PATH.test(pathname);
}

/** The answer for a request, or null when it is not a permission request. */
export async function permissionResponse(
  url: URL,
  table: Readonly<Record<string, PermissionAnswer>>,
  fallback: PermissionAnswer = "admin",
): Promise<Response | null> {
  const m = url.pathname.match(PERMISSION_PATH);
  if (!m) return null;
  const repo = decodeURIComponent(m[1]);
  const login = decodeURIComponent(m[2]);
  const answer = table[`${repo}#${login.toLowerCase()}`] ?? table[login.toLowerCase()] ?? fallback;
  const user = { login, id: 1, type: "User" };
  if (typeof answer === "number") {
    return new Response("{}", { status: answer, headers: { "Retry-After": "0" } });
  }
  if (typeof answer === "object") {
    await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    return Response.json({ permission: "admin", role_name: "admin", user });
  }
  if (answer === "garbage") return new Response("<html>not json</html>", { status: 200 });
  if (answer === "no_role_name") return Response.json({ permission: "admin", user });
  return Response.json({ permission: LEGACY[answer], role_name: answer, user });
}
