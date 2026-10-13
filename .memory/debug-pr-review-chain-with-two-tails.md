---
name: debug-pr-review-chain-with-two-tails
description: "To find where the dataset PR review chain stops, tail the production and dev Workers filtered by the x-github-event header, then read the public workflow run log"
metadata:
  type: reference
---

Verified 2026-10-12 during the ADR 0092 trial.
The chain for a dev-owned dataset is: GitHub App delivery to the production Worker, the forward to the dev Worker (`DEV_WEBHOOK_MIRROR_URL`), the dev gate, the check and comment, the `repository_dispatch` to `run-pr-review.yml` in `nemarDatasets/.github`, the Anthropic identity exchange, the model, and the callback.
Where the evidence stops says which link failed.

1. **Tail both Workers, filtered to the event.** From `backend/`:
   `bunx cfman wrangler --account sccn tail nemar-api --header x-github-event:pull_request` for production, and the same with `nemar-api-dev` for dev.
   The filter is `key:value` on the request header (wrangler splits on the first colon).
   Production should show the delivery arriving; a forward that failed shows as a `warn` (`dev mirror forward ... returned HTTP <status>`), not an error.
   Dev should show the same delivery; an `invalid signature` line there is the secret drift in [[pr-review-three-faults-behind-no-review]].
   Nothing on production means GitHub never delivered, or the filter does not match: check the App's subscription and recent deliveries.
2. **Then read the workflow run log.** `nemarDatasets/.github` is public, so `gh run list -R nemarDatasets/.github -w run-pr-review.yml` and `gh run view <run> --log -R nemarDatasets/.github` need no special access.
   The log prints only a review id, fixed words, class names and HTTP statuses by design, so it is safe to read and to quote.
   No run after dev accepted the delivery means the dispatch failed, which the Worker records.
   A run that stops early names the cause: a missing organization variable, a refused claim (ends green and spends nothing), or an identity exchange that failed.

**Why it matters:** every link answers 2xx or ends green, so the only way to find the broken one is to look at each in order.

**How to apply:** tail first, start the pull request second, and keep both tails running until the run log exists.
Never paste a secret, a token or an identifier into a note or an issue while doing this.
