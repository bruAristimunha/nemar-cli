# ADR 0026: Mechanical submission minimums hard-gate native publication; adequacy stays LLM-advisory

**Status:** accepted
**Date:** 2026-08-18
**Owner:** Seyed Yahya Shirazi

## Context

ADR 0014 made name adequacy LLM-judged and advisory after the calibration scan
(1,777 public OpenNeuro datasets, 577 in scope) showed a regex gate would
desk-reject ~3 legitimate short acronym titles per genuinely bad name. That
measurement was taken on an ALREADY-PUBLISHED corpus, where a rejection means
losing good data. On 2026-08-18 the owner published the Dataset Submission
Standards policy (docs.nemar.org/policies/submission-standards/) making a
descriptive name of >= 25 characters, named non-placeholder authors, and an
ethics approval statement hard requirements for native submissions. For a NEW
submission the false-positive cost inverts: a depositor with an acronym title
just expands it with a subtitle; nothing is lost.

## Decision

The mechanically checkable minimums hard-block a native publication request
server-side, at POST /datasets/:id/publish/request, before any admin is
notified: `Name` >= 25 characters, `Authors` contains at least one
non-placeholder entry, and an ethics statement exists (`EthicsApprovals`
non-empty, or an ethics/IRB statement in the README). The 422 states each
failed item and links the policy, so the depositor learns the specific reasons
from the CLI or GUI immediately. Quality judgments beyond the mechanical floor
(is the name meaningful, does the README describe THIS dataset) remain
LLM-judged and advisory to the reviewing admin — that half of ADR 0014
survives. OpenNeuro imports and exemplars stay exempt (upstream review
already accepted them). A fetch failure fails open to admin review; the gate
adds certainty for depositors, it does not replace the human gate.

## Consequences

- Depositors get an immediate, specific verdict at request time instead of a
  later denial; the blocked row reuses the existing `block_reason` channel
  (`min_requirements_failed`), and re-requesting re-runs the checks.
- The publication sweep does not auto-clear these blocks (it is scoped to
  `bids_validation_*`): only a fixed dataset clears them, by re-request.
- Already-published datasets are not gated retroactively; the gate runs only
  on publication requests.
- A request recorded while BIDS validation was pending is released later by the
  blocked-request sweep, which runs the same check before it releases the
  request and re-blocks one that fails; a row whose files it cannot read waits
  for the next run instead of failing open. See the amendment of 2026-10-07 in
  [ADR 0086](0086-publication-requests-are-screened-for-identifiers-in-ci-and-the-admin-mail-waits-for-the-verdict.md).
- The 25-character floor is enforced as a plain length check. This is the
  regex-style gate ADR 0014 rejected — deliberately re-decided for native
  first publication, where the remedy is a title edit, not a desk rejection.

## Alternatives considered

- **Keep everything advisory (ADR 0014 as-was).** Rejected by owner decision:
  the policy names these as requirements, and an advisory that admins must
  manually re-litigate on every request is slower for depositors and
  inconsistent across reviewers.
- **Gate in the prescreen workflow instead of the Worker.** Rejected: the
  prescreen is async and advisory by design (#756); the depositor would not
  learn the verdict at request time, which is the point.
- **Block on fetch failure (fail closed).** Rejected: the CI readiness check
  already blocks on GitHub infrastructure failure; double-blocking adds a
  second spurious failure mode while the admin review still stands behind
  the gate.

## Receipts

- #1087 (implementation); #817 (original Tier A proposal); ADR 0014 (superseded)
- `backend/src/services/submission-minimums.ts`;
  `backend/src/routes/datasets/publication.ts`
- docs.nemar.org/policies/submission-standards/ (the policy this enforces)
