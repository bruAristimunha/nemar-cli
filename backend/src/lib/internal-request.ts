/**
 * Requests this Worker builds for itself and hands to one of its own sub-apps,
 * such as an MCP tool reading a dataset's `index.json` through the zarr gateway,
 * or the Neurobagel gatherer reading the data plane (#1709, ADR 0098).
 *
 * They carry neither `CF-Connecting-IP` nor `X-Forwarded-For`, and they are not a
 * visitor. An MCP tool's request was already counted where it arrived. The
 * scheduled Neurobagel reconcile has no arriving request: it is bounded by its
 * per-tick limit (`NEUROBAGEL_RECONCILE_MAX` datasets) and by the writer's
 * operations budget (`OP_BUDGET`). What each fans out into is bounded by its own
 * caps. The data plane's limiter therefore must neither pool them with a caller
 * that failed to say who it is, nor warn about them.
 *
 * The exemption is the data plane's alone (`data-ip` and the miss budget), and
 * only for a request that carries neither address header, as the two real callers
 * build theirs. A marked request that carries a usable address is counted as that
 * address, and any other bucket counts a marked request in whatever bucket it
 * would reach unmarked, so marking a request by mistake cannot skip the strict,
 * token or private-grant limits.
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
