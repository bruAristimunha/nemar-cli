/**
 * The real GitHub webhook: POST /github, HMAC-verified against
 * GITHUB_WEBHOOK_SECRET (a different trust model from the GitHub-Actions
 * callback endpoints in routes/callbacks/, which use bearer or per-job
 * callback tokens).
 *
 * Moved verbatim from routes/webhooks.ts (#905, epic #902); the only
 * intentional changes are import paths and the register-function wrapper.
 */

import {
  isDevOwnedDatasetId,
  isDevRangeDatasetId,
  isValidDatasetId,
} from "../../services/datasetId.js";
import { isNonProductionEnv } from "../../services/environment.js";
import { getDatasetsToken } from "../../services/github-auth.js";
import { triggerEnrichmentRun, triggerVersionDoiRun } from "../../services/github.js";
import { handlePullRequestEvent } from "../../services/pr-review.js";

/**
 * Reasons a pull request was NOT reviewed that deserve a line in the Worker's log: each is a
 * setup problem or a payload nobody expected, not the ordinary filtering of events the review is
 * not for (a draft, another branch, an action that adds nothing).
 */
const PR_REVIEW_LOGGED_SKIPS: ReadonlySet<string> = new Set([
  "malformed",
  "misconfigured",
  "unknown_dataset",
]);

/** `nm000460#7`, or `unknown` when the payload does not say. Shape-checked, so safe to log. */
function describePullRequest(payload: unknown): string {
  const p = payload as { repository?: { name?: unknown }; number?: unknown } | null;
  const name = p?.repository?.name;
  const n = p?.number;
  return typeof name === "string" && isValidDatasetId(name) && Number.isSafeInteger(n)
    ? `${name}#${n}`
    : "unknown";
}
import { verifyGitHubWebhookSignature } from "../../services/webhook-signature.js";
import type { WebhookRouter } from "./shared.js";

// ─── GitHub App webhook receiver ────────────────────────────────────────────
//
// The nemar-publish-bot App is configured to deliver `push` events from every
// dataset repo under `nemarDatasets` to this endpoint. We decode the event,
// filter it down to enrichment-relevant pushes, and dispatch the central
// `run-enrichment` workflow on `nemarDatasets/.github`.
//
// Phase 1 of epic #601 / sub-issue #602. Until the strip script runs, the
// per-repo `llm-enrichment.yml` will continue to fire on the same push; both
// pipelines hit `/webhooks/llm-enrich`, where the `source_hash` guard makes
// the duplicate a Stage-2 no-op.

/** Paths whose change should trigger an enrichment run.
 *
 *  Includes only sources that *feed* enrichment (README + BIDS description).
 *  Crucially excludes `.nemar/metadata.json` — that file IS the enrichment
 *  output, written by `nemar-publish-bot` on every successful run. Listing
 *  it here turned every enrichment commit into a fresh trigger and Haiku's
 *  non-deterministic prose ensured the file always looked "changed" to the
 *  push filter, so the pipeline self-fired forever (#643, observed on
 *  on007827: ~60 runs/hr at ~$0.01 each on the then-current OpenRouter/Haiku
 *  backend; the pipeline now runs claude-sonnet-5-5 on Claude Platform on AWS
 *  at a higher per-run cost, so the guard matters even more).
 *  Manual recovery / re-enrichment is still available via
 *  `workflow_dispatch` on `nemarDatasets/.github/run-enrichment.yml`. */
const ENRICHMENT_TRIGGER_PATHS: ReadonlySet<string> = new Set([
  "README.md",
  "dataset_description.json",
]);

interface PushEventCommit {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface PushEventPayload {
  ref?: string;
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
  commits?: PushEventCommit[];
  head_commit?: PushEventCommit | null;
  deleted?: boolean;
  /** Set when the push rewrote history. We don't use this for filtering
   *  (the `commits`/`head_commit` union below already produces the
   *  correct touched-path set whether or not history was rewritten), but
   *  the field is part of GitHub's push-event payload and is modelled
   *  here so the type matches reality and to anchor the force-push test
   *  cases in `webhook-github-push.test.ts`. */
  forced?: boolean;
}

/** Decide whether a push event should fan out to the enrichment workflow.
 *
 *  Exported for unit testing — keep this pure (no env, no I/O) so the
 *  webhook-github tests can pin the filter table without spinning up a
 *  Hono harness. */
export function shouldDispatchEnrichment(
  event: PushEventPayload,
):
  | { dispatch: false; reason: string }
  | { dispatch: true; datasetId: string; ref: string; force: boolean } {
  if (event.deleted) return { dispatch: false, reason: "branch_deleted" };

  const owner = event.repository?.owner?.login;
  if (owner !== "nemarDatasets") {
    return { dispatch: false, reason: "wrong_owner" };
  }

  const datasetId = event.repository?.name;
  if (!datasetId || !isValidDatasetId(datasetId)) {
    return { dispatch: false, reason: "not_a_dataset_repo" };
  }

  const ref = event.ref ?? "";
  let refName: string;
  let force: boolean;
  if (ref === "refs/heads/main") {
    refName = "main";
    force = false;
  } else if (ref.startsWith("refs/heads/release/")) {
    refName = ref.slice("refs/heads/".length);
    // Release-branch pushes only touch the Version field in
    // dataset_description.json, so the source_hash short-circuit would
    // otherwise skip the run. Force the re-enrichment so the release PR
    // carries fresh `.nemar/metadata.json`. Mirrors the legacy per-repo
    // workflow's FORCE="true" on release/*.
    force = true;
  } else {
    return { dispatch: false, reason: "ref_not_main_or_release" };
  }

  const touched = new Set<string>();
  // `commits[]` lists every commit in the push; `head_commit` is the tip and
  // may carry paths the commits-array entries don't (force-push edge case).
  // Union them so a path mentioned only on the tip isn't missed.
  const sources: Array<PushEventCommit | null | undefined> = [
    ...(event.commits ?? []),
    event.head_commit ?? null,
  ];
  for (const c of sources) {
    if (!c) continue;
    for (const p of c.added ?? []) touched.add(p);
    for (const p of c.modified ?? []) touched.add(p);
    for (const p of c.removed ?? []) touched.add(p);
  }
  let matched = false;
  for (const p of touched) {
    if (ENRICHMENT_TRIGGER_PATHS.has(p)) {
      matched = true;
      break;
    }
  }
  if (!matched) return { dispatch: false, reason: "no_enrichment_paths_touched" };

  return { dispatch: true, datasetId, ref: refName, force };
}

/** Strict version-tag pattern: `v` + semver core + optional pre-release of
 *  the shapes the project's `scripts/bump-version.sh` actually emits
 *  (`-rc<N>`, `-alpha<N>`, `-beta<N>`, with `<N>` optional). Tighter than
 *  the legacy `tags: ['v*']` glob so a typo'd `vfoo` or unrelated `vlatest`
 *  tag doesn't cause an accidental DOI mint. Phase 2 of #601 / #606. */
const VERSION_TAG_REF_RE = /^refs\/tags\/(v\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\d*)?)$/;

/** Decide whether a push event should fan out to the version-DOI workflow.
 *
 *  Filter rules (parallel to `shouldDispatchEnrichment`, exported for unit
 *  testing):
 *    - same owner (`nemarDatasets`) + dataset id (`isValidDatasetId`) gate
 *    - `ref` matches `^refs/tags/v<semver>$` per VERSION_TAG_REF_RE
 *    - `deleted` is falsy (tag deletes must NOT mint a new DOI)
 *
 *  Returns the bare tag (sans `refs/tags/` prefix) on the happy path so
 *  callers can pass it straight to `triggerVersionDoiRun`. Phase 2 of #601.
 */
export function shouldDispatchVersionDoi(
  event: PushEventPayload,
): { dispatch: false; reason: string } | { dispatch: true; datasetId: string; tag: string } {
  if (event.deleted) return { dispatch: false, reason: "tag_deleted" };

  const owner = event.repository?.owner?.login;
  if (owner !== "nemarDatasets") {
    return { dispatch: false, reason: "wrong_owner" };
  }

  const datasetId = event.repository?.name;
  if (!datasetId || !isValidDatasetId(datasetId)) {
    return { dispatch: false, reason: "not_a_dataset_repo" };
  }

  const ref = event.ref ?? "";
  const match = VERSION_TAG_REF_RE.exec(ref);
  if (!match) {
    return { dispatch: false, reason: "ref_not_version_tag" };
  }

  return { dispatch: true, datasetId, tag: match[1] };
}

/** Source-data file extensions whose change should rebuild a recording's Zarr
 *  serving copy (epic #684). Primary recording containers plus the companion
 *  files that carry their samples/markers (EEGLAB `.fdt`; the BrainVision
 *  `.vhdr`/`.vmrk`/`.eeg` triplet), so a change confined to a companion still
 *  triggers a reconversion of its recording. Compared lowercase.
 *
 *  Must stay a superset of `generate_zarr.py`'s `PRIMARY_EXTS` (the converter,
 *  now at `scripts/zarr/` in this repo — ADR 0029) or a push changing one of
 *  those recordings
 *  never re-dispatches conversion and the serving copy goes stale silently —
 *  which is exactly what happened here: the KIT/Yokogawa/RICOH MEG formats
 *  (`.con`/`.sqd`/`.kdf`) were missing (verified against `on007763`, which has
 *  35 affected `.con` recordings). */
const ZARR_DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  "set",
  "fdt", // EEGLAB
  "edf",
  "bdf", // European Data Format (+)
  "vhdr",
  "vmrk",
  "eeg", // BrainVision triplet
  "fif", // MEG / Elekta-Neuromag FIFF
  "con", // KIT/Yokogawa MEG
  "sqd", // KIT/Yokogawa MEG
  "kdf", // RICOH MEG
]);

/** BIDS trees that never hold a raw recording the Zarr viewer serves:
 *  `derivatives/` (pipeline outputs — ICA solutions, epoched/averaged
 *  `-epo.fif`/`-ave.fif`, etc.), `sourcedata/` (pre-conversion raw dumps),
 *  and `code/` (analysis scripts). A push confined to these must never
 *  dispatch a conversion (ADR 0027): a full repo walk otherwise treats any
 *  matching file as a recording wherever it sits, and measurement showed
 *  that is where most phantom "failures" and most wrongly-served stores
 *  came from. Checked at both a top-level and a nested position, mirroring
 *  `emit_records.py`'s existing `derivatives`/`sourcedata` exclusion in
 *  `nemarDatasets/.github` (extended here to also cover `code/`). */
const ZARR_EXCLUDED_TREES: readonly string[] = ["derivatives", "sourcedata", "code"];

function isInExcludedTree(p: string): boolean {
  // Matched on a path SEGMENT (`dir/` at the start, or `/dir/` within), never as
  // a bare substring -- otherwise `mycode/`, `derivatives_old/`, or a task named
  // `task-code` would all be silently dropped. Compared lowercase like
  // ZARR_DATA_EXTENSIONS: BIDS mandates lowercase for these trees, so a
  // capitalized one is already malformed, and a non-raw tree must not become
  // servable just because it was misnamed.
  const lower = p.toLowerCase();
  return ZARR_EXCLUDED_TREES.some(
    (dir) => lower.startsWith(`${dir}/`) || lower.includes(`/${dir}/`),
  );
}

/** True if a BIDS path is a recording data file (or its companion) or a curated
 *  `_events.tsv` sidecar. A `_events.tsv` change must refresh the sibling
 *  recording's embedded events; a CTF `.ds` recording is a directory, so any
 *  file under `*.ds/` counts, as is MEF3's `.mefd` (any file under `*.mefd/`
 *  counts the same way). 4D/BTi is directory-based too but carries no extension
 *  at all, so it gets its own rule — see `isBtiMember`. The exclusion below is checked
 *  first and unconditionally, so a `derivatives/`/`sourcedata/`/`code/` path
 *  never triggers regardless of which rule below would otherwise have matched
 *  it — including the `_events.tsv` early return, which used to short-circuit
 *  before any other check. Exported for unit testing.
 *
 *  NOT CALLED IN PRODUCTION, deliberately. The Actions dispatcher this gated was
 *  retired in #1109; conversion now runs on the SDSC Hallu cron
 *  (`scripts/zarr/hallu-zarr.sh`). It is kept because it is the executable
 *  statement of ADR 0027's raw-only contract, and `zarr-gate-superset.unit.test.ts`
 *  asserts it against the converter's `PRIMARY_EXTS` (#1103) — a same-repo check
 *  now that the converter lives here. Do not delete as dead code. */
export function isZarrTriggerPath(p: string): boolean {
  if (isInExcludedTree(p)) return false;
  // Every rule below compares lowercase, so a recording can't slip the gate on
  // capitalization alone. (`.ds/` was case-sensitive before this; BIDS mandates
  // lowercase, so nothing real depended on that.)
  const lower = p.toLowerCase();
  if (lower.endsWith("_events.tsv")) return true;
  if (lower.includes(".ds/") || lower.includes(".mefd/")) return true;
  if (isBtiMember(lower)) return true;
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return false;
  return ZARR_DATA_EXTENSIONS.has(lower.slice(dot + 1));
}

/** True if a lowercased path is a member of a 4D/BTi recording directory.
 *
 *  BIDS gives 4D/BTi NO extension -- the recording is a directory
 *  `sub-<l>[_ses-<l>]_task-<l>[_run-<i>]_meg/` holding `c,rfDC`, `config`, and
 *  `hs_file` -- so it is matched on the `c,rf*` data file. The bare basenames
 *  `config`/`hs_file` are deliberately NOT matched, because `config` would
 *  false-positive on `.datalad/config`, which essentially every dataset repo
 *  carries.
 *
 *  Matched at ANY depth, deliberately, even though BIDS names the directory
 *  `..._meg/`. This gate must stay a SUPERSET of what the converter treats as a
 *  recording, and the converter (`bti_recordings` in `generate_zarr.py`) keys a
 *  BTi directory on `c,rf*` plus a sibling `config` with NO constraint on the
 *  directory's name. The gate cannot evaluate that sibling rule, since it sees
 *  one changed path at a time rather than the tree, so it takes the permissive
 *  side. Requiring `_meg` here would make the gate NARROWER than the converter:
 *  a BTi directory named anything else would be converted but would never
 *  re-dispatch on a push, so its serving copy would go stale silently. That is
 *  precisely the failure mode the missing KIT extensions caused. A false
 *  positive costs one no-op workflow run; a false negative costs correctness. */
function isBtiMember(lower: string): boolean {
  const cut = lower.lastIndexOf("/");
  if (cut === -1) return false; // a top-level file is never inside a recording dir
  const base = lower.slice(cut + 1);
  if (base.startsWith("c,rf")) return true;
  // The converter rebuilds a BTi recording on ANY touched file inside a
  // qualifying directory, not just the `c,rf*` data file -- it has tests for a
  // `config`-only edit and an `hs_file` deletion both rebuilding. Matching those
  // basenames at any depth is not an option: `.datalad/config` exists in
  // essentially every dataset repo, so it would fire on nearly every
  // metadata-only push across ~785 repos. Requiring the BIDS `..._meg/` parent
  // is the narrowest rule that covers them, and it is purely ADDITIVE to the
  // name-independent `c,rf*` match above, so it cannot re-narrow the gate.
  //
  // Residual, accepted gap: a `config`/`hs_file`-only change inside a BTi
  // directory NOT named `..._meg/` still will not re-dispatch. It self-heals on
  // the next push that dispatches for any other reason, because the workflow
  // diffs the last-converted commit against HEAD rather than trusting the event
  // payload, so it is staleness until the next push, not permanent loss.
  if (base !== "config" && base !== "hs_file") return false;
  const parent = lower.slice(0, cut);
  return parent.slice(parent.lastIndexOf("/") + 1).endsWith("_meg");
}

/** Decide whether a push event should fan out to Zarr conversion.
 *
 *  Like `isZarrTriggerPath`, retained but NOT called in production since #1109
 *  retired the Actions dispatch path; see that function's note.
 *
 *  Parallels `shouldDispatchEnrichment` (same owner/dataset gate, same
 *  touched-path union over `commits[]` + `head_commit`), but:
 *    - fires ONLY on `refs/heads/main` -- the Zarr copy is latest-only and
 *      tracks main's HEAD; data lands on main after a PR merge. Release-branch
 *      and tag pushes don't carry merged data.
 *    - matches a recording data file / companion / `_events.tsv` instead of the
 *      README/dataset_description enrichment paths.
 *
 *  Returns no file list: the workflow self-diffs HEAD against the last-converted
 *  commit recorded in `index.json`, so a giant PR can't overflow the dispatch
 *  payload and a missed delivery self-heals on the next data push. Exported for
 *  unit testing -- keep pure (no env, no I/O). */
export function shouldDispatchZarr(
  event: PushEventPayload,
): { dispatch: false; reason: string } | { dispatch: true; datasetId: string; ref: string } {
  if (event.deleted) return { dispatch: false, reason: "branch_deleted" };

  const owner = event.repository?.owner?.login;
  if (owner !== "nemarDatasets") {
    return { dispatch: false, reason: "wrong_owner" };
  }

  const datasetId = event.repository?.name;
  if (!datasetId || !isValidDatasetId(datasetId)) {
    return { dispatch: false, reason: "not_a_dataset_repo" };
  }

  if (event.ref !== "refs/heads/main") {
    return { dispatch: false, reason: "ref_not_main" };
  }

  const touched = new Set<string>();
  const sources: Array<PushEventCommit | null | undefined> = [
    ...(event.commits ?? []),
    event.head_commit ?? null,
  ];
  for (const c of sources) {
    if (!c) continue;
    for (const p of c.added ?? []) touched.add(p);
    for (const p of c.modified ?? []) touched.add(p);
    for (const p of c.removed ?? []) touched.add(p);
  }
  for (const p of touched) {
    if (isZarrTriggerPath(p)) return { dispatch: true, datasetId, ref: "main" };
  }
  return { dispatch: false, reason: "no_data_or_events_paths_touched" };
}

export function registerGithubWebhookRoutes(webhooks: WebhookRouter): void {
  /**
   * POST /webhooks/github — entry point for GitHub App webhook deliveries.
   *
   * Verifies the HMAC-SHA256 signature in `X-Hub-Signature-256` against
   * `GITHUB_WEBHOOK_SECRET`, then inspects the event. We act on `push` and
   * `pull_request` events; other event types respond 200 so we can subscribe
   * to more event types in the App config later without redeploying the Worker.
   *
   * Responds 200 (or 401 on bad signature) so GitHub doesn't retry on
   * filter-misses. The response body indicates whether a dispatch happened so
   * operators can correlate with GitHub Actions runs.
   *
   * Errors during a `push` dispatch (e.g. rate limit, transient 5xx from GitHub)
   * are logged and surfaced in the response body but DO NOT 5xx the webhook: a
   * retried delivery would just duplicate the dispatch attempt, and the App's
   * single-delivery-per-event guarantee plus the workflow's source_hash guard
   * make a missed-dispatch self-heal on the next push.
   *
   * The `pull_request` path is the exception, on purpose: an unexpected failure
   * (a database error) answers 500 so the delivery shows as failed in the App's
   * delivery log, where it can be redelivered. Redelivery is safe because
   * (dataset, pull request, commit) is unique (ADR 0092).
   */
  webhooks.post("/github", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("X-Hub-Signature-256");
    const eventType = c.req.header("X-GitHub-Event");
    const deliveryId = c.req.header("X-GitHub-Delivery") ?? "";

    if (!c.env.GITHUB_WEBHOOK_SECRET) {
      console.error("[github-webhook] GITHUB_WEBHOOK_SECRET is unset; rejecting delivery");
      return c.json({ error: "Server misconfigured" }, 500);
    }

    const sigOk = await verifyGitHubWebhookSignature(
      rawBody,
      signature ?? null,
      c.env.GITHUB_WEBHOOK_SECRET,
    );
    if (!sigOk) {
      console.warn(
        `[github-webhook] invalid signature on delivery ${deliveryId} event=${eventType}`,
      );
      return c.json({ error: "Invalid signature" }, 401);
    }

    // `push` drives enrichment and version DOIs; `pull_request` drives the dataset
    // pull-request review (ADR 0092), which is itself off unless PR_REVIEW_ENABLED is "1".
    // Other events (release, …) land here without action so the App can subscribe to
    // them in advance of any future centralization phase.
    if (eventType !== "push" && eventType !== "pull_request") {
      return c.json({ ok: true, dispatched: false, reason: "event_ignored", event: eventType });
    }

    let payload: PushEventPayload;
    try {
      payload = JSON.parse(rawBody) as PushEventPayload;
    } catch (err) {
      console.warn(
        `[github-webhook] ${eventType} delivery ${deliveryId} had unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ ok: true, dispatched: false, reason: "unparseable_payload" });
    }

    // Dev/test staging repos (xx09NNNN, epic #923) live in the shared
    // nemarDatasets org but belong to the dev worker, not prod. The production
    // worker must never dispatch enrichment/version-DOI runs against them:
    // there is no prod D1 row, and the central workflows' callbacks would 404.
    // Short-circuit here on prod. (Phase 5 adds a forward of the raw, still
    // HMAC-signed delivery to the dev worker's DEV_WEBHOOK_MIRROR_URL; the dev
    // worker, ENVIRONMENT != "production", does not take this branch and
    // dispatches normally.)
    // !isNonProductionEnv (not ENVIRONMENT === "production") so the gate FAILS
    // CLOSED: an unset/typo'd ENVIRONMENT must still short-circuit rather than
    // let the prod worker dispatch against a dev-range repo it has no row for.
    // isDevOwnedDatasetId, not isDevRangeDatasetId (#1440): the reserved `nm`
    // fixtures are dev's too. Without this, a push to nemarDatasets/nm099998
    // is delivered here and treated as prod's own, so prod dispatches an
    // ENRICHMENT run for a repository it has no D1 row for.
    //
    // Enrichment alone: zarr is not dispatched from here at all
    // (`shouldDispatchZarr` is defined and never called, #1109), and the
    // version-DOI path already refuses this case because its anonymity check
    // treats an absent `datasets` row as anonymous (#1408).
    if (!isNonProductionEnv(c.env) && isDevOwnedDatasetId(payload.repository?.name ?? "")) {
      // Audible when the DECLARED set is what matched, rather than the id shape.
      // The shape case is routine and stays quiet; the declared case is the one
      // where a bad entry would make production silently stop dispatching for a
      // real dataset, with nothing in Worker Logs to see (ADR 0053: silence is
      // only evidence of a problem when there was work to do).
      const repoName = payload.repository?.name ?? "";
      if (!isDevRangeDatasetId(repoName)) {
        console.warn(
          `[github-webhook] short-circuited ${repoName} on production: declared dev-owned (DEV_OWNED_FIXTURE_IDS, #1440), delivery=${deliveryId}`,
        );
      }
      if (c.env.DEV_WEBHOOK_MIRROR_URL) {
        // Forward the raw, still-HMAC-signed delivery to the dev worker (epic
        // #923) so it dispatches for staging exemplars. Outbound-only and
        // fire-and-forget via waitUntil: cannot mutate prod, and a dev outage
        // never affects prod latency. Dev re-verifies with its own (equal)
        // GITHUB_WEBHOOK_SECRET.
        c.executionCtx.waitUntil(
          fetch(c.env.DEV_WEBHOOK_MIRROR_URL, {
            method: "POST",
            headers: {
              "Content-Type": c.req.header("Content-Type") ?? "application/json",
              "X-Hub-Signature-256": signature ?? "",
              "X-GitHub-Event": eventType ?? "",
              "X-GitHub-Delivery": deliveryId,
            },
            body: rawBody,
          })
            .then((res) => {
              // fetch only rejects on a network-level error; a non-2xx from the
              // dev worker (secret drift, route 404, 5xx) resolves normally, so
              // surface it here or the forward fails with no trace.
              if (!res.ok) {
                console.warn(
                  `[github-webhook] dev mirror forward for delivery ${deliveryId} returned HTTP ${res.status}`,
                );
              }
            })
            .catch((err) => {
              console.warn(
                `[github-webhook] dev mirror forward failed for delivery ${deliveryId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }),
        );
        return c.json({ ok: true, dispatched: false, reason: "dev_range_repo", forwarded: true });
      }
      // The reason string keeps its name for stability (tests and logs pin it),
      // though since #1440 it covers dev-OWNED repos rather than only dev-range
      // ones: a reserved fixture like nm099998 short-circuits here too.
      return c.json({ ok: true, dispatched: false, reason: "dev_range_repo" });
    }

    // The reciprocal fence: a NON-production worker may only act on repos it
    // OWNS -- the dev sandbox range plus the reserved fixtures declared
    // dev-owned in datasetId.ts (#1440). Before that second term the dev worker
    // refused its OWN standing fixture, so the one dataset built to exercise
    // the anonymity surfaces could never have enrichment run against it.
    // The forward above re-posts a still-valid HMAC delivery, and both
    // workers share GITHUB_WEBHOOK_SECRET by design, so signature verification
    // alone cannot tell the dev worker "this one is not yours". Without this,
    // the only thing stopping the dev worker from dispatching real central
    // workflows for a real nm* push (including a version-DOI mint, whose
    // sandbox-vs-production EZID credentials are chosen from the DOI string
    // rather than ENVIRONMENT) is GitHub's delivery configuration pointing at
    // prod — an operational control, not a code one.
    if (isNonProductionEnv(c.env) && !isDevOwnedDatasetId(payload.repository?.name ?? "")) {
      return c.json({ ok: true, dispatched: false, reason: "prod_range_repo_on_dev_worker" });
    }

    // A pull request is taken up by the review, after the same ownership fences as a push:
    // production leaves dev-owned repositories to the dev Worker, and the dev Worker answers
    // only for repositories it owns.
    //
    // Unlike a push, an unexpected failure here (the database, say) answers 500. GitHub does not
    // retry a failed delivery, but it lists it as failed in the App's delivery log, where it can
    // be redelivered; answering 200 would leave a pull request with no check and no trace.
    // Redelivering is safe because (dataset, pull request, commit) is unique. A review that fails
    // AFTER it was recorded is a check that needs a person, not a failure of the delivery.
    if (eventType === "pull_request") {
      const where = describePullRequest(payload);
      try {
        const res = await handlePullRequestEvent(c.env, payload);
        if (PR_REVIEW_LOGGED_SKIPS.has(res.reason)) {
          console.warn(
            `[github-webhook] pull_request delivery ${deliveryId} (${where}) not reviewed: ${res.reason}`,
          );
        }
        return c.json(res);
      } catch (err) {
        console.error(
          `[github-webhook] pull_request delivery ${deliveryId} (${where}) failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
        );
        return c.json({ ok: false, dispatched: false, reason: "pr_review_error" }, 500);
      }
    }

    // Evaluate both decision functions. A given push delivery should only
    // match one (branch pushes carry no tag ref; tag pushes carry no branch
    // ref), but evaluating both keeps the handler symmetric for future
    // phases of #601 and makes the response shape stable for observability
    // tooling.
    const enrichmentDecision = shouldDispatchEnrichment(payload);
    const versionDoiDecision = shouldDispatchVersionDoi(payload);

    if (!enrichmentDecision.dispatch && !versionDoiDecision.dispatch) {
      // Surface whichever reason is more specific. The enrichment path's
      // reasons are richer (no_enrichment_paths_touched, wrong_owner, …)
      // but it bails at `ref_not_main_or_release` for any tag-shaped ref,
      // hiding the more useful `ref_not_version_tag` from version-doi.
      // When enrichment's reason is the generic ref-category bail, prefer
      // version-doi's reason; otherwise keep enrichment's. Code-review #607.
      const reason =
        enrichmentDecision.reason === "ref_not_main_or_release"
          ? versionDoiDecision.reason
          : enrichmentDecision.reason;
      return c.json({ ok: true, dispatched: false, reason });
    }

    const dispatched: Record<string, unknown> = {};
    const errors: Record<string, string> = {};

    // #1408: the `run-version-doi` workflow this dispatches calls
    // `POST /callbacks/version-doi`, which mints AND publishes -- it
    // deliberately does not use the `reserveOnly` mode #1447 added, because a
    // tag push is not a release decision. So dispatching for an anonymous
    // deposit would put a resolving, harvested DataCite record into the world
    // for the one dataset whose whole premise is that no identifier of it
    // resolves yet.
    //
    // An anonymous release DOES mint its own version identifier, reserved, via
    // the publication orchestrator (#1447: that step is what dispatches the
    // central manifest). That is the one entitled minter. Nothing stops the
    // depositor from pushing a `v*` tag as well -- `nemar dataset release` does
    // exactly that -- and this handler would have obliged.
    //
    // Decided here, BEFORE the GitHub token is fetched, for two reasons: a
    // refusal needs no token, and a token outage must not be able to change
    // the answer. Gated on the server rather than inside
    // `shouldDispatchVersionDoi`, which is a pure predicate over the webhook
    // payload -- and the payload cannot be trusted to say anything about
    // anonymity. The state is read from the dataset row.
    let anonymousDeposit = false;
    // Carried to the triggerVersionDoiRun call below (#1514): the row is
    // already being read here for the anonymity check, so its declared size
    // rides along for free rather than costing the archive workflow's
    // preflight a second D1 round trip it has no route to make. Populated
    // only on a successful read; the anonymity check's own failure path
    // already refuses the dispatch entirely, so these stay null together
    // with that refusal.
    let versionDoiTotalBytes: number | null = null;
    let versionDoiTotalFiles: number | null = null;
    if (versionDoiDecision.dispatch) {
      try {
        const row = await c.env.DB.prepare(
          "SELECT anonymous, file_size, total_files FROM datasets WHERE dataset_id = ?",
        )
          .bind(versionDoiDecision.datasetId)
          .first<{
            anonymous: number | null;
            file_size: number | null;
            total_files: number | null;
          }>();
        // A row that is absent is refused for the same reason an unreadable
        // one is: nothing here knows it is safe to mint.
        anonymousDeposit = row?.anonymous !== 0;
        versionDoiTotalBytes = row?.file_size ?? null;
        versionDoiTotalFiles = row?.total_files ?? null;
      } catch (err) {
        // Unreadable state is not permission to mint. A version DOI is
        // permanent; skipping one is a re-push away.
        console.error(
          `[github-webhook] anonymity check failed for ${versionDoiDecision.datasetId} delivery=${deliveryId}; skipping version-doi dispatch:`,
          err instanceof Error ? err.message : err,
        );
        anonymousDeposit = true;
      }
      if (anonymousDeposit) {
        console.warn(
          `[github-webhook] version-doi NOT dispatched for ${versionDoiDecision.datasetId}@${versionDoiDecision.tag} delivery=${deliveryId}: anonymous deposit (or its state was unreadable)`,
        );
        errors.version_doi = "anonymous_deposit";
      }
    }

    // Nothing left that needs credentials.
    if (!enrichmentDecision.dispatch && !(versionDoiDecision.dispatch && !anonymousDeposit)) {
      return c.json({ ok: true, dispatched: false, errors });
    }

    const pat = await getDatasetsToken(c.env);

    if (enrichmentDecision.dispatch) {
      try {
        await triggerEnrichmentRun(
          enrichmentDecision.datasetId,
          enrichmentDecision.ref,
          enrichmentDecision.force,
          pat,
        );
        console.log(
          `[github-webhook] dispatched run-enrichment for ${enrichmentDecision.datasetId}@${enrichmentDecision.ref} force=${enrichmentDecision.force} delivery=${deliveryId}`,
        );
        dispatched.enrichment = {
          dataset_id: enrichmentDecision.datasetId,
          ref: enrichmentDecision.ref,
          force: enrichmentDecision.force,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[github-webhook] enrichment dispatch failed for ${enrichmentDecision.datasetId}@${enrichmentDecision.ref} delivery=${deliveryId}: ${msg}`,
        );
        errors.enrichment = msg;
      }
    }

    if (versionDoiDecision.dispatch && !anonymousDeposit) {
      try {
        await triggerVersionDoiRun(versionDoiDecision.datasetId, versionDoiDecision.tag, pat, {
          totalBytes: versionDoiTotalBytes,
          totalFiles: versionDoiTotalFiles,
        });
        console.log(
          `[github-webhook] dispatched run-version-doi for ${versionDoiDecision.datasetId}@${versionDoiDecision.tag} delivery=${deliveryId}`,
        );
        dispatched.version_doi = {
          dataset_id: versionDoiDecision.datasetId,
          tag: versionDoiDecision.tag,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[github-webhook] version-doi dispatch failed for ${versionDoiDecision.datasetId}@${versionDoiDecision.tag} delivery=${deliveryId}: ${msg}`,
        );
        errors.version_doi = msg;
      }
    }

    const anyDispatched = Object.keys(dispatched).length > 0;
    const anyErrors = Object.keys(errors).length > 0;
    return c.json({
      ok: true,
      dispatched: anyDispatched,
      ...(anyDispatched ? { runs: dispatched } : {}),
      ...(anyErrors ? { errors } : {}),
    });
  });
}
