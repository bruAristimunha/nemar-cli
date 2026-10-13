/**
 * What every part of the publication review shares to write a log line and to read a commit
 * (ADR 0102): one way to name an error, and one pattern for a commit id.
 *
 * It imports nothing from the other review modules, which import it: the write path, the view,
 * the mail and the admin routes each need both, and a module they all import cannot be one of
 * them without a cycle. The commit pattern is declared once in the shared contract (the job's
 * scripts read it there too) and re-exported here for the Worker.
 */

export { HEAD as SHA40 } from "../../../shared/publication-review.js";

/**
 * The message a rejected dispatch carries (`triggerPublicationReviewRun`): the one message whose
 * status is worth a log line, and a closed shape.
 */
const DISPATCH_REJECTED = /^Publication review dispatch rejected: HTTP (\d{3})$/;

/**
 * What an error is called in a log line: its name and one word of a closed list, never its
 * message, which can carry SQL or text a service echoed back. The words are `no_such_table` (what
 * a deploy before the review's migration is applied produces), `timeout` (a read or a dispatch
 * that did not answer), `http_NNN` (a dispatch GitHub refused, by its status) and `other`. The
 * name is shown only when it is a plain identifier, and is `unknown` for anything that is not an
 * `Error`.
 */
export function errorWords(err: unknown): string {
  const name =
    err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(err.name) ? err.name : "unknown";
  const message = err instanceof Error ? err.message : "";
  const status = DISPATCH_REJECTED.exec(message);
  const kind = /no such table/i.test(message)
    ? "no_such_table"
    : name === "TimeoutError" || name === "AbortError" || /time(d)? ?out/i.test(message)
      ? "timeout"
      : status
        ? `http_${status[1]}`
        : "other";
  return `${name}, ${kind}`;
}
