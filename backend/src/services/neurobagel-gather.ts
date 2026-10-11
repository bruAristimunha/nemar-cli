/**
 * Gathering one dataset's transform inputs, in the Worker (epic #1586, phase 4).
 *
 * The three documents the transform reads (`metadata.json`, `participants.tsv`,
 * `participants.json`) are obtained THROUGH THE DATA PLANE ITSELF: the real
 * `dataRoutes` app is called in-process, so what the transform sees is, byte for
 * byte, what the public data plane serves, by the same code that serves it:
 *
 *   - `metadata.json` is built by the data plane's own metadata builder from the D1
 *     row and a streamed digest of the manifest (ADR 0072: no manifest is ever read
 *     whole here), with the anonymity blind of ADR 0065 already applied;
 *   - a git-tracked file (participants.tsv and participants.json almost always are)
 *     is brokered by the data plane's git-file broker, under the manifest as the
 *     capability list (ADR 0066): the repository comes from the dataset row, the
 *     visibility gate runs before the token is used, and a blob is verified against
 *     the manifest's SHA;
 *   - a plain ANNEXED file answers 302 to its object URL, which is followed once;
 *     a chunked file streams through the data plane under one eight-request budget
 *     shared by both tables. The URL is never logged or reported.
 *
 * Nothing here decides eligibility. The caller has decided it from the D1 row; this
 * module adds the second, independent guard (the gathered metadata must say
 * `anonymous: false`), and reads no depositor file before that guard has passed.
 *
 * A failed fetch is an error and is NEVER passed to the transform as an absent file:
 * only an answer the data plane gives for a path the manifest does not name is
 * `null` (the transform's contract).
 */

import type { NeurobagelInput } from "../../../shared/neurobagel/index.js";
import { dataRoutes } from "../routes/data.js";
import type { Bindings } from "../types/bindings.js";
import { CHUNK_GETS_USED_HEADER, CHUNK_GET_BUDGET_HEADER } from "./chunked-delivery.js";
import { resolveDataBaseOrigin } from "./environment.js";

/** metadata.json carries the bids_index, so it grows with the subject count. */
export const MAX_METADATA_BYTES = 16 * 1024 * 1024;
/** participants.tsv and participants.json are small; anything larger is not a phenotype table. */
export const MAX_TABLE_BYTES = 8 * 1024 * 1024;
/** Hard cap shared by participants.tsv and participants.json for one gather. */
export const MAX_GATHER_CHUNK_GETS = 8;
export const GATHER_TABLE_COUNT = 2;

const USER_AGENT = "nemar-neurobagel-writer/1";

/** Why a gather produced nothing. Stable codes: they appear in status and in the audit log. */
export type GatherRefusalCode =
  /** The data plane's metadata does not say `anonymous: false`. Anonymity-class. */
  | "anonymity_disagreement"
  /** The data plane's visibility gate answered 404 for a dataset the row calls eligible. */
  | "data_plane_gate_refused"
  | "metadata_invalid"
  | "metadata_too_large"
  /** `bids_index` is null: the manifest digest was unavailable, so subjects are unknown. */
  | "metadata_degraded"
  | "no_latest_version"
  | "participants_too_large"
  /** A file the data plane could not answer (5xx, a throw): transient, never an absent file. */
  | "fetch_failed";

export class GatherRefusal extends Error {
  constructor(
    readonly code: GatherRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "GatherRefusal";
  }
}

export interface GatheredDocuments {
  datasetId: string;
  latestVersion: string;
  input: NeurobagelInput;
}

export interface GatherDeps {
  /** Hands work to `waitUntil` (the data plane's cache writes). */
  waitUntil?: (work: Promise<unknown>) => void;
  /**
   * Follows the redirect for a plain annexed file. It is the network boundary:
   * the default is the global `fetch`, and a test substitutes the object host.
   */
  followRedirect?: typeof fetch;
  /**
   * The data plane's entry point. The default calls the real `dataRoutes` in process. A
   * test wraps THAT, to inject a fault the real one makes only by accident: a document
   * with no `anonymous` value, or a 404 that is not "this file is not in the manifest".
   */
  dataPlane?: (request: Request) => Promise<Response>;
}

function executionContext(deps: GatherDeps): ExecutionContext | undefined {
  const waitUntil = deps.waitUntil;
  if (!waitUntil) return undefined;
  return {
    waitUntil: (p: Promise<unknown>) => waitUntil(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

/** Read a body, refusing to hold more than `cap` bytes. */
async function readCapped(
  response: Response,
  cap: number,
): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "too_large" }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => {});
    return { kind: "too_large" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { kind: "ok", bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { kind: "too_large" };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { kind: "ok", bytes: out };
}

/** UTF-8 text that KEEPS a byte order mark, so the transform's own `bom_stripped` sees it. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

function dataPlaneRequest(env: Bindings, path: string, chunkGetBudget?: number): Request {
  return new Request(`${resolveDataBaseOrigin(env)}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(chunkGetBudget === undefined
        ? {}
        : { [CHUNK_GET_BUDGET_HEADER]: String(chunkGetBudget) }),
    },
  });
}

async function callDataPlane(
  env: Bindings,
  path: string,
  deps: GatherDeps,
  chunkGetBudget?: number,
): Promise<Response> {
  try {
    const request = dataPlaneRequest(env, path, chunkGetBudget);
    if (deps.dataPlane) return await deps.dataPlane(request);
    return await dataRoutes.fetch(request, env, executionContext(deps));
  } catch (err) {
    throw new GatherRefusal(
      "fetch_failed",
      `data plane threw for ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Does a 404 from the data plane say "this path is not in the manifest"? Only that
 * answer is an absent file. The route's other 404s (the dataset, the version, a
 * manifest it could not read) say something else, and passing them as `null` would
 * publish a dataset without its phenotype table because S3 blinked.
 */
async function isAbsentFile(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return body.error === "File not found";
  } catch {
    return false;
  }
}

/**
 * One participants file: its text, or `null` when the manifest does not name it.
 * Throws a {@link GatherRefusal} for anything that is not one of those two answers.
 */
async function fetchTable(
  datasetId: string,
  version: string,
  name: "participants.tsv" | "participants.json",
  deps: GatherDeps,
  requestDataPlane: (path: string) => Promise<Response>,
): Promise<string | null> {
  const response = await requestDataPlane(`/${datasetId}/${version}/${name}`);
  if (response.status === 404) {
    if (await isAbsentFile(response)) return null;
    throw new GatherRefusal(
      "fetch_failed",
      `${name}: the data plane answered 404 for the version, not for the file`,
    );
  }
  let source = response;
  if (response.status === 302) {
    const location = response.headers.get("Location");
    await response.body?.cancel().catch(() => {});
    if (!location || !/^https:\/\//i.test(location)) {
      throw new GatherRefusal("fetch_failed", `${name}: the redirect has no usable https target`);
    }
    // The target is never logged: it can carry a signature.
    try {
      source = await (deps.followRedirect ?? fetch)(location, {
        redirect: "error",
        headers: { "User-Agent": USER_AGENT },
      });
    } catch {
      throw new GatherRefusal("fetch_failed", `${name}: the object host did not answer`);
    }
    if (source.status === 404) {
      await source.body?.cancel().catch(() => {});
      throw new GatherRefusal(
        "fetch_failed",
        `${name}: the manifest names a file the object host does not have`,
      );
    }
  }
  if (!source.ok) {
    await source.body?.cancel().catch(() => {});
    throw new GatherRefusal("fetch_failed", `${name}: HTTP ${source.status}`);
  }
  const read = await readCapped(source, MAX_TABLE_BYTES);
  if (read.kind === "too_large") {
    throw new GatherRefusal("participants_too_large", `${name} is over ${MAX_TABLE_BYTES} bytes`);
  }
  return decode(read.bytes);
}

/**
 * The anonymity guard's whole contract: the data plane's `anonymous` value must be
 * EXACTLY `false`. A missing value, `null`, the string `"false"` and `0` are unknown or
 * something else, and unknown is not false; `true` is the disagreement itself.
 */
export function saysNotAnonymous(value: unknown): value is false {
  return value === false;
}

/**
 * Gather one dataset's inputs. Throws {@link GatherRefusal}; returns the input the
 * transform takes, with `expectedDatasetId` set (the transform requires it).
 *
 * The order is the safety property: metadata first; the anonymity guard on its RAW
 * `anonymous` value; only then the depositor's files.
 */
export async function gatherNeurobagelInput(
  env: Bindings,
  datasetId: string,
  deps: GatherDeps = {},
): Promise<GatheredDocuments> {
  const metadataResponse = await callDataPlane(env, `/${datasetId}/metadata.json`, deps);
  if (metadataResponse.status === 404) {
    await metadataResponse.body?.cancel().catch(() => {});
    throw new GatherRefusal(
      "data_plane_gate_refused",
      "the data plane does not serve this dataset, though its row is eligible",
    );
  }
  if (!metadataResponse.ok) {
    await metadataResponse.body?.cancel().catch(() => {});
    throw new GatherRefusal("fetch_failed", `metadata.json: HTTP ${metadataResponse.status}`);
  }
  const metadataRead = await readCapped(metadataResponse, MAX_METADATA_BYTES);
  if (metadataRead.kind === "too_large") {
    throw new GatherRefusal(
      "metadata_too_large",
      `metadata.json is over ${MAX_METADATA_BYTES} bytes`,
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(decode(metadataRead.bytes));
  } catch {
    throw new GatherRefusal("metadata_invalid", "metadata.json is not JSON");
  }
  if (typeof metadata !== "object" || metadata === null) {
    throw new GatherRefusal("metadata_invalid", "metadata.json is not an object");
  }
  const doc = metadata as Record<string, unknown> & {
    extensions?: { nemar?: { bids_index?: unknown } | null } | null;
    provenance?: { latest_snapshot?: unknown } | null;
  };

  // The SECOND guard. The row said eligible; the document must say not anonymous,
  // and "exactly false": a missing or null value is unknown, and unknown is not false.
  // Checked before any depositor file is requested.
  if (!saysNotAnonymous(doc.anonymous)) {
    throw new GatherRefusal(
      "anonymity_disagreement",
      "the row is eligible but the data plane's metadata does not say anonymous: false",
    );
  }
  if (doc.dataset_id !== datasetId) {
    throw new GatherRefusal("metadata_invalid", "metadata.json names another dataset");
  }
  const latest = doc.provenance?.latest_snapshot;
  if (typeof latest !== "string" || latest === "") {
    throw new GatherRefusal("no_latest_version", "metadata.json names no latest version");
  }
  // `bids_index` is null exactly when the manifest digest could not be read. The
  // transform would fall back to the participants table and publish a degraded
  // graph over a good one, because S3 blinked once.
  if (
    doc.extensions?.nemar?.bids_index === null ||
    doc.extensions?.nemar?.bids_index === undefined
  ) {
    throw new GatherRefusal("metadata_degraded", "metadata.json carries no bids_index");
  }

  let remainingChunkGets = MAX_GATHER_CHUNK_GETS;
  const requestTable = async (path: string): Promise<Response> => {
    const response = await callDataPlane(env, path, deps, remainingChunkGets);
    const rawUsed = response.headers.get(CHUNK_GETS_USED_HEADER);
    if (rawUsed === null) {
      if (response.ok || response.status === 302) {
        await response.body?.cancel().catch(() => {});
        throw new GatherRefusal("fetch_failed", "data plane omitted the chunk request count");
      }
      return response;
    }
    if (!/^(0|[1-9]\d*)$/.test(rawUsed)) {
      await response.body?.cancel().catch(() => {});
      throw new GatherRefusal("fetch_failed", "data plane returned an invalid chunk request count");
    }
    const used = Number(rawUsed);
    if (!Number.isSafeInteger(used) || used > remainingChunkGets) {
      await response.body?.cancel().catch(() => {});
      throw new GatherRefusal(
        "fetch_failed",
        "data plane exceeded the gather chunk request budget",
      );
    }
    remainingChunkGets -= used;
    return response;
  };

  const participantsTsv = await fetchTable(
    datasetId,
    latest,
    "participants.tsv",
    deps,
    requestTable,
  );
  const participantsJson = await fetchTable(
    datasetId,
    latest,
    "participants.json",
    deps,
    requestTable,
  );

  return {
    datasetId,
    latestVersion: latest,
    input: { expectedDatasetId: datasetId, metadata, participantsTsv, participantsJson },
  };
}
