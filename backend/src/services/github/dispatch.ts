/**
 * repository_dispatch triggers to the central workflow repo
 * (nemarDatasets/.github): archive/zarr/manifest/version-DOI/enrichment/
 * onboard/BIDS-validation/prescreen runs.
 *
 * Moved verbatim from services/github.ts (#906, epic #902); the only
 * intentional changes are import paths.
 */

import { GITHUB_API, VALIDATOR_VERSION } from "./shared";

/**
 * Trigger archive generation via repository_dispatch event.
 *
 * Phase 3 of centralization epic #601 (sub-issue #608): the workflow now
 * lives at `nemarDatasets/.github/.github/workflows/run-generate-archive.yml`
 * and dispatches use the central repo, NOT the dataset repo. The legacy
 * `repo` parameter is preserved in the signature for callsite stability
 * (CLI + admin endpoints pass the dataset repo name); it's no longer used
 * to address the dispatch target, only logged for traceability.
 *
 * client_payload shape stays compatible: `dataset_id`, `version`, `public`.
 * The central workflow mints a per-repo App token scoped to `dataset_id`
 * and checks out the dataset repo at `v$VERSION`.
 *
 * `options.totalBytes`/`totalFiles` (#1514) carry the row's already-known
 * size so the workflow's preflight can apply the archive size policy without
 * depending on the version manifest being publicly fetchable -- which it
 * isn't for a private dataset, an anonymous deposit before release, or a
 * version whose `dataset_versions` row hasn't landed yet (the nm000284
 * incident). Omitted when the caller doesn't have a number to offer; the
 * workflow's preflight falls back to a manifest-only check either way, so an
 * older Worker build and an older workflow both keep working unchanged.
 */
export async function triggerArchiveGeneration(
  repo: string,
  datasetId: string,
  version: string,
  pat: string,
  options?: {
    public?: boolean;
    s3Bucket?: string;
    callbackBaseUrl?: string;
    totalBytes?: number | null;
    totalFiles?: number | null;
  },
): Promise<void> {
  // Sanity check the legacy parameter so callsites that still pass the
  // dataset's own repo name don't drift from the dataset_id payload.
  if (repo !== datasetId) {
    console.warn(
      `[generate-archive] repo (${repo}) and datasetId (${datasetId}) differ; dispatching with dataset_id=${datasetId}`,
    );
  }
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "generate-archive",
      client_payload: {
        dataset_id: datasetId,
        version,
        public: options?.public ?? false,
        // Env-awareness (epic #923): the central workflow follows the caller's
        // bucket + callback host instead of hardcoding prod. Omitted (prod
        // default) when unset, so existing prod deliveries are unchanged.
        s3_bucket: options?.s3Bucket,
        callback_base_url: options?.callbackBaseUrl,
        // #1514: nullish -> omitted (JSON.stringify drops undefined keys), so
        // a caller with nothing to offer dispatches exactly the old payload.
        total_bytes: options?.totalBytes ?? undefined,
        total_files: options?.totalFiles ?? undefined,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger archive generation: HTTP ${response.status} - ${error}`);
  }
}

/** Central tooling repo where the manifest workflow lives. Targeted by
 *  `triggerManifestGeneration` regardless of the dataset's own repo.
 *  Relocated from `nemarOrg/nemar-cli` to `nemarDatasets/.github` (#564)
 *  so Actions minutes bill against the dataset org's Team plan rather
 *  than the constrained Free-plan tooling org. */
export const CENTRAL_WORKFLOW_REPO = "nemarDatasets/.github";

/**
 * The bucket `generate-manifest.yml` actually writes to.
 *
 * It is a hardcoded `S3_BUCKET: nemar` in the workflow, which never reads
 * `client_payload.s3_bucket` (#1451). So a caller passing a non-prod bucket is
 * not redirected, it is ignored: the dispatch would write a non-prod dataset's
 * manifest into the production bucket. `triggerManifestGeneration` refuses that
 * rather than trusting a parameter the other end drops on the floor. When the
 * workflow starts honoring `s3_bucket` this constant, and the guard, go away.
 */
export const CENTRAL_MANIFEST_BUCKET = "nemar";

/**
 * Trigger central manifest generation via repository_dispatch on
 * `nemarDatasets/.github` (NOT the individual dataset repo). The workflow
 * checks out the dataset repo's version tag, walks the tree, builds the
 * manifest + summary, uploads both to S3, and then POSTs back to
 * `callback_url`.
 *
 * Mirrors `triggerArchiveGeneration` style for error handling. The `pat`
 * must be an App-installation token (or PAT fallback) authorized on the
 * nemarDatasets org -- use `getDatasetsToken()`.
 *
 * `options.skipCanary` (default false) is the dispatch-path twin of the
 * inline `generateManifest()` `skipGitBackedVerification` option: when
 * the dataset repo is private, raw.githubusercontent.com cannot serve
 * an unauthenticated HEAD, so Stream A's Python workflow disables its
 * git-backed canary verification when this flag is set.
 *
 * `options.s3Bucket` must be {@link CENTRAL_MANIFEST_BUCKET} or absent; anything
 * else throws before the dispatch. A non-prod worker therefore cannot reach this
 * path at all, and must build the manifest inline instead (#1451) -- which on the
 * dev worker means `POST /admin/datasets/:id/manifest/:version`, the route the
 * error message names, since `/admin/manifest/dispatch` has no inline branch of
 * its own to fall back to.
 */
export async function triggerManifestGeneration(
  datasetId: string,
  version: string,
  doi: string | null,
  conceptDoi: string | null,
  callbackToken: string,
  callbackUrl: string,
  pat: string,
  options?: { skipCanary?: boolean; skipCallback?: boolean; s3Bucket?: string },
): Promise<void> {
  // Before the network call, so a refused bucket costs no dispatch and no
  // half-written manifest: the workflow ignores s3_bucket and writes to prod.
  if (options?.s3Bucket !== undefined && options.s3Bucket !== CENTRAL_MANIFEST_BUCKET) {
    throw new Error(
      `Refusing to dispatch central manifest generation for bucket "${options.s3Bucket}": generate-manifest.yml hardcodes s3://${CENTRAL_MANIFEST_BUCKET} and ignores s3_bucket (#1451), so this run would write ${datasetId}@${version} into the production bucket. Build it inline instead, with POST /admin/datasets/${datasetId}/manifest/${version}.`,
    );
  }

  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "generate-manifest",
      client_payload: {
        dataset_id: datasetId,
        version,
        doi,
        concept_doi: conceptDoi,
        callback_token: callbackToken,
        callback_url: callbackUrl,
        // Epic #923 sent this so the central workflow could follow the caller's
        // bucket. generate-manifest.yml never read it (#1451), so today it is
        // documentation of intent rather than a control, and the guard above is
        // what keeps a non-prod bucket from silently meaning "prod". Kept on the
        // payload so the workflow can start honoring it without a Worker deploy.
        // callback_url is already caller-built from API_BASE_URL, so no separate
        // callback_base_url is needed here.
        s3_bucket: options?.s3Bucket,
        skip_canary: options?.skipCanary ?? false,
        // skip_callback=true is for manual backfill — the Worker has no
        // in-flight manifest_jobs row to validate against, so the workflow
        // skips its POST to /webhooks/manifest-ready. The workflow still
        // writes manifest.json + summary.json to S3 normally.
        skip_callback: options?.skipCallback ?? false,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger manifest generation: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the central version-DOI workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-version-doi]`. The workflow mints a per-repo App
 * token scoped to `datasetId`, checks out that repo at the tag, refreshes
 * enrichment, POSTs to `/webhooks/publish-version-doi`, and dispatches
 * generate-archive against the target dataset repo. No callback handshake —
 * `/webhooks/publish-version-doi` itself is the round-trip that updates D1
 * (and is idempotent on the version-DOI ledger so a duplicate dispatch
 * during the Phase 2 cutover window is safe).
 *
 * Mirrors `triggerEnrichmentRun` and `triggerManifestGeneration`. The `pat`
 * must carry write access on `nemarDatasets/.github`'s dispatch endpoint —
 * use `getDatasetsToken()`. Phase 2 of epic #601 (sub-issue #606).
 *
 * `options.totalBytes`/`totalFiles` (#1514) ride along to `run-version-doi.yml`,
 * which forwards them into its OWN `generate-archive` dispatch (the
 * `trigger-archive` job). This is the first-publish path: a v*-tag push is
 * what actually builds nm000284's incident window (the version manifest
 * 404s because the `dataset_versions` row this same webhook mints comes
 * AFTER this dispatch fires), and it never went through
 * `triggerArchiveGeneration` at all. Omitted when the caller has nothing to
 * offer, so an older caller's dispatch is byte-for-byte unchanged.
 */
export async function triggerVersionDoiRun(
  datasetId: string,
  tag: string,
  pat: string,
  options?: { totalBytes?: number | null; totalFiles?: number | null },
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-version-doi",
      client_payload: {
        dataset_id: datasetId,
        tag,
        total_bytes: options?.totalBytes ?? undefined,
        total_files: options?.totalFiles ?? undefined,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger version-doi run: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the central LLM-enrichment workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-enrichment]`. The workflow mints a per-repo App
 * token scoped to `datasetId`, checks out that repo at `ref`, POSTs to
 * `/webhooks/llm-enrich`, and commits the returned `.nemar/metadata.json`
 * back to the dataset repo. No callback handshake — the workflow's POST to
 * `/webhooks/llm-enrich` IS the round-trip that updates D1.
 *
 * Wraps the same dispatch shape as `triggerManifestGeneration`; differs only
 * in the event_type and the (much simpler) client_payload. The `pat` must
 * carry write access on `nemarDatasets/.github`'s dispatch endpoint — use
 * `getDatasetsToken()`.
 *
 * Phase 1 of epic #601 (sub-issue #602). The legacy per-repo
 * `llm-enrichment.yml` is removed in the same PR; existing dataset repos are
 * stripped via `scripts/strip-per-repo-llm-enrichment.ts` as the final
 * cutover step.
 */
export async function triggerEnrichmentRun(
  datasetId: string,
  ref: string,
  force: boolean,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-enrichment",
      client_payload: {
        dataset_id: datasetId,
        ref,
        force,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger enrichment run: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Dispatch the `onboard-openneuro` workflow on `nemarDatasets/.github` to import
 * one or more OpenNeuro datasets (epic #775). Same repository_dispatch shape as
 * `triggerEnrichmentRun`; the workflow's parse-ids reads
 * `client_payload.openneuro_ids`. `pat` must carry dispatch write on
 * `nemarDatasets/.github` -- use `getDatasetsToken()`. `fetchImpl` defaults to
 * the global fetch (injectable for tests).
 */
export async function triggerOpenNeuroOnboard(
  openneuroIds: string,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "onboard-openneuro",
      client_payload: { openneuro_ids: openneuroIds },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger OpenNeuro onboard: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Pure builder for the `run-bids-validation` repository_dispatch payload sent to
 * `nemarDatasets/.github`. Mirrors the per-repo shim's dispatch
 * (`getWorkflowTemplates`) so a manual re-validation produces the same central
 * check-run. Extracted as a pure function so the shape is unit-testable without
 * a network call. `pr_number` is empty for branch-level (non-PR) revalidation.
 */
export function buildBidsValidationDispatch(
  datasetId: string,
  headSha: string,
  ref = "main",
): { event_type: string; client_payload: Record<string, string> } {
  return {
    event_type: "run-bids-validation",
    client_payload: {
      dataset_id: datasetId,
      ref,
      head_sha: headSha,
      pr_number: "",
      validator_version: VALIDATOR_VERSION,
    },
  };
}

/**
 * Trigger central BIDS validation on a dataset's branch HEAD by dispatching
 * `run-bids-validation` at `nemarDatasets/.github` (same path the per-repo shim
 * takes). Used by the `revalidate` admin flow to re-post a `Run BIDS Validation`
 * check-run on `main` HEAD when the shim is already deployed (so `ci/sync` is a
 * no-op). `pat` must carry dispatch access on the central repo -- use
 * `getDatasetsToken()`. Mirrors `triggerEnrichmentRun`'s error handling.
 */
export async function triggerBidsValidation(
  datasetId: string,
  headSha: string,
  pat: string,
  ref = "main",
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildBidsValidationDispatch(datasetId, headSha, ref)),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger BIDS validation: HTTP ${response.status} - ${error}`);
  }
}

/**
 * Trigger the publication pre-screen workflow on `nemarDatasets/.github` via
 * `repository_dispatch[run-prescreen]` (issue #666). The workflow mints a
 * per-repo App token, checks out the dataset metadata, runs `claude -p` to
 * judge README / dataset_description / declared-data completeness, opens a
 * GitHub issue on the dataset repo when it blocks, and POSTs a verdict to
 * `callbackUrl` (/webhooks/prescreen-result) carrying `callbackToken`.
 *
 * Mirrors `triggerEnrichmentRun`'s dispatch shape. `pat` must carry write
 * access on the central repo's dispatch endpoint -- use `getDatasetsToken()`.
 */
export async function triggerPrescreenRun(
  datasetId: string,
  ref: string,
  requestId: number,
  callbackToken: string,
  callbackUrl: string,
  pat: string,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-prescreen",
      client_payload: {
        dataset_id: datasetId,
        ref,
        request_id: requestId,
        callback_token: callbackToken,
        callback_url: callbackUrl,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to trigger prescreen run: HTTP ${response.status} - ${error}`);
  }
}

/**
 * GitHub ANSWERED an identifier-screen dispatch with a non-2xx. The message is
 * the status only, the same words the plain error carried before. A thrown fetch
 * or a timeout is not this class: GitHub may have accepted the event and lost
 * only the answer (the reasoning {@link DispatchRejectedError} records for the
 * approval dispatch).
 */
export class IdentifierScreenDispatchRejected extends Error {
  constructor(readonly httpStatus: number) {
    super(`Failed to trigger identifier screen run: HTTP ${httpStatus}`);
    this.name = "IdentifierScreenDispatchRejected";
  }

  /** True only for a 4xx: GitHub refused the request before creating an event. A 5xx may follow one. */
  get definitelyNotSent(): boolean {
    return this.httpStatus < 500;
  }
}

/**
 * Start the identifier screen of a publication request on `nemarDatasets/.github`
 * via `repository_dispatch[run-identifier-screen]` (epic #1610, phase 4). The
 * workflow screens the dataset's `ref` for identifying information and POSTs a
 * report (`shared/identifier-screen-report.ts`) to `callbackUrl`
 * (/webhooks/identifier-screen-result) with `callbackToken` in X-Webhook-Token.
 *
 * A 2xx proves nothing about the workflow running: GitHub answers 204 for an
 * `event_type` no workflow listens for. That is why the caller marks the screen
 * `pending` with a dispatch time and a watchdog turns a screen that never
 * reports into `unreported`; this function only reports whether GitHub took
 * the request. Mirrors `triggerPrescreenRun`. `pat` must carry write access on
 * the central repo's dispatch endpoint -- use `getDatasetsToken()`. `timeoutMs`,
 * when given, bounds the call (the scheduled sweep passes one; the publication
 * request does not).
 */
export async function triggerIdentifierScreenRun(
  datasetId: string,
  ref: string,
  requestId: number,
  callbackToken: string,
  callbackUrl: string,
  pat: string,
  timeoutMs?: number,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-identifier-screen",
      client_payload: {
        dataset_id: datasetId,
        ref,
        request_id: requestId,
        callback_token: callbackToken,
        callback_url: callbackUrl,
      },
    }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });

  if (!response.ok) {
    // The status only. GitHub's body is not ours to forward, and this message is
    // logged by the caller.
    throw new IdentifierScreenDispatchRejected(response.status);
  }
}

/**
 * Which backend the approval workflow should talk to. The central repo is
 * shared by every environment, so the dispatch has to say; and it says it as a
 * NAME, never a URL or a credential, so the workflow maps the name to an API
 * origin and a secret from a fixed table of its own and an admin key can never
 * be steered to a host the payload chose.
 */
export type ApprovalDispatchEnvironment = "production" | "dev";

/**
 * `production` only for the production Worker, exactly. Every other value,
 * including an unset or misspelled ENVIRONMENT, answers `dev`: the failure
 * direction that matters here is a non-production Worker driving a PRODUCTION
 * approval, which would run with the production admin key, so the fallback has
 * to be the harmless side (a dev key against a dev API simply finds no such
 * request). That is the opposite of `isNonProductionEnv`'s fail-closed answer,
 * which protects disclosure and is right for that purpose.
 */
export function approvalDispatchEnvironment(env: {
  ENVIRONMENT?: string;
}): ApprovalDispatchEnvironment {
  return env.ENVIRONMENT === "production" ? "production" : "dev";
}

/**
 * How long the approve dispatch waits for GitHub before giving up. Under the
 * website's 15 second deadline on this call, so the Worker answers the page
 * itself ("unconfirmed") rather than the page timing out first and showing a
 * bare network error for a request that may have been accepted.
 */
export const APPROVE_DISPATCH_TIMEOUT_MS = 10_000;

/**
 * GitHub ANSWERED the dispatch with a non-2xx. Whether the event was created
 * depends on the status, and callers branch on {@link definitelyNotSent} to
 * decide whether it is safe to release the claim they made before dispatching.
 * A thrown fetch or a timeout is a third case, and not an instance of this
 * class: GitHub may have accepted the request and lost only the answer.
 */
export class DispatchRejectedError extends Error {
  constructor(
    readonly httpStatus: number,
    detail: string,
  ) {
    super(`Failed to trigger approve-publication: HTTP ${httpStatus} - ${detail}`);
    this.name = "DispatchRejectedError";
  }

  /**
   * True only for a 4xx: GitHub refused the request itself (a bad token, a
   * missing repository, a malformed payload), which it does before it creates
   * an event. A 5xx is NOT "not sent". A 502, 503 or 504 comes from GitHub's
   * edge and can be returned after the event was already queued, the same
   * lost-answer case as a dropped connection, and releasing the claim then
   * would let the next click start a second run beside the first.
   */
  get definitelyNotSent(): boolean {
    return this.httpStatus < 500;
  }
}

/**
 * Hand a publication approval to the central workflow via
 * `repository_dispatch[approve-publication]` (ADR 0080).
 *
 * The workflow runs `nemar admin publish approve <dataset_id>` on a runner and
 * drives the same caller-side loop (S3 Object Lock batches, retries,
 * `--resume`) a terminal does, which is why the approval does not run inside
 * the Worker: that loop is long and its cost belongs on the runner. The payload
 * names the dataset, the request it was claimed for, whether to resume, and the
 * environment. It carries no credential and no URL.
 *
 * Failure has two meanings, and the difference matters to the caller:
 *   - {@link DispatchRejectedError} with `definitelyNotSent` (a 4xx): GitHub
 *     refused the request. Nothing was sent.
 *   - anything else a rejected promise carries (a dropped connection, a
 *     `TimeoutError` after `timeoutMs`, or a {@link DispatchRejectedError} for a
 *     5xx): UNKNOWN. GitHub may have accepted the dispatch and lost only the
 *     reply, so a caller must not assume nothing started.
 * The error text names GitHub's status and body, never the token. `pat` must
 * carry write access on the central repo's dispatch endpoint -- use
 * `getDatasetsToken()`.
 */
export async function triggerApprovePublication(
  datasetId: string,
  requestId: number,
  resume: boolean,
  environment: ApprovalDispatchEnvironment,
  pat: string,
  timeoutMs: number = APPROVE_DISPATCH_TIMEOUT_MS,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "approve-publication",
      client_payload: {
        dataset_id: datasetId,
        request_id: requestId,
        resume,
        environment,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new DispatchRejectedError(response.status, await response.text());
  }
}

/**
 * The fields the central pull-request review workflow needs, and nothing it could use to choose a
 * target. The workflow re-reads the pull request from GitHub with its own token: it is given the
 * review's coordinates, not the pull request's text, and it maps `environment` to an API origin
 * from a fixed table of its own, so a payload can never steer the callback to a host it chose.
 */
export interface PrReviewDispatch {
  datasetId: string;
  prNumber: number;
  headSha: string;
  reviewId: number;
  callbackToken: string;
  environment: ApprovalDispatchEnvironment;
}

/**
 * Trigger the pull-request review via `repository_dispatch[run-pr-review]` on
 * `nemarDatasets/.github` (ADR 0092). Throws with the status only: GitHub's body is not ours to
 * forward, and the caller logs this message.
 */
export async function triggerPrReviewRun(
  d: PrReviewDispatch,
  pat: string,
  timeoutMs?: number,
): Promise<void> {
  const response = await fetch(`${GITHUB_API()}/repos/${CENTRAL_WORKFLOW_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "NEMAR-API",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "run-pr-review",
      client_payload: {
        dataset_id: d.datasetId,
        pr_number: d.prNumber,
        head_sha: d.headSha,
        review_id: d.reviewId,
        callback_token: d.callbackToken,
        environment: d.environment,
      },
    }),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!response.ok) {
    throw new Error(`PR review dispatch rejected: HTTP ${response.status}`);
  }
}
