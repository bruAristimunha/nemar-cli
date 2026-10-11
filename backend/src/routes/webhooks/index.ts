/**
 * Webhook routes for GitHub Actions integration
 *
 * These endpoints are called by GitHub Actions workflows
 * and authenticated via a shared secret token.
 *
 * Split from the monolithic routes/webhooks.ts (#905, epic #902): the real
 * GitHub webhook (HMAC-verified) lives in ./github.ts; the GitHub-Actions
 * callback endpoints (bearer/callback-token authed) live in ../callbacks/.
 * One shared Hono instance keeps routing semantics identical to pre-split
 * (see ./shared.ts).
 */

import { Hono } from "hono";
import type { Bindings } from "../../types/bindings.js";
import { registerArchiveReadyRoutes } from "../callbacks/archive-ready.js";
import { registerIdentifierScreenRoutes } from "../callbacks/identifier-screen.js";
import { registerIdentifierSweepCallbackRoutes } from "../callbacks/identifier-sweep.js";
import { registerImportStateRoutes } from "../callbacks/import-state.js";
import { registerLlmEnrichRoutes } from "../callbacks/llm-enrich.js";
import { registerManifestCallbackRoutes } from "../callbacks/manifest.js";
import { registerPrReviewRoutes } from "../callbacks/pr-review.js";
import { registerPrescreenRoutes } from "../callbacks/prescreen.js";
import { registerRecordsReadyRoutes } from "../callbacks/records-ready.js";
import { registerVersionDoiRoutes } from "../callbacks/version-doi.js";
import { registerZarrReadyRoutes } from "../callbacks/zarr-ready.js";
import { registerGithubWebhookRoutes } from "./github.js";

const webhooks = new Hono<{ Bindings: Bindings }>();

// Monolith registration order preserved, except /manifest-failed now
// registers beside /manifest-ready. All webhook paths are distinct static
// paths, so registration order is not load-bearing (pinned by
// test/webhooks-route-inventory.unit.test.ts).
registerVersionDoiRoutes(webhooks);
registerManifestCallbackRoutes(webhooks);
registerPrescreenRoutes(webhooks);
registerPrReviewRoutes(webhooks);
registerIdentifierScreenRoutes(webhooks);
registerIdentifierSweepCallbackRoutes(webhooks);
registerImportStateRoutes(webhooks);
registerLlmEnrichRoutes(webhooks);
registerGithubWebhookRoutes(webhooks);
registerZarrReadyRoutes(webhooks);
registerArchiveReadyRoutes(webhooks);
registerRecordsReadyRoutes(webhooks);

export default webhooks;
