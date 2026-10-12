/**
 * Requests this Worker builds for itself and hands to one of its own sub-apps,
 * such as an MCP tool reading a dataset's `index.json` through the zarr gateway,
 * or the Neurobagel gatherer reading the data plane (#1709, ADR 0098).
 *
 * They carry neither `CF-Connecting-IP` nor `X-Forwarded-For`, and they are not a
 * visitor: the request that caused them was already counted where it arrived, and
 * what they fan out into is bounded by their own caps. The limiter therefore must
 * neither pool them with a caller that failed to say who it is, nor warn about
 * them.
 *
 * The mark is an object identity held in module memory, not a header, so nothing
 * a client sends can claim it, and a copy of a marked request (`new Request(req)`)
 * is not marked. Hono hands a sub-app's middleware the same `Request` object it
 * was given (`c.req.raw`), which is what lets the limiter see the mark.
 */
const internalRequests = new WeakSet<Request>();

/** Mark a request this Worker built for itself, and return it. */
export function internalRequest(request: Request): Request {
  internalRequests.add(request);
  return request;
}

export function isInternalRequest(request: Request): boolean {
  return internalRequests.has(request);
}
