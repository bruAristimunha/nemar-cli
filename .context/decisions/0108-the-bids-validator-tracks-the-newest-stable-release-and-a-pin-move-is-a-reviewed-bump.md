# ADR 0108: The BIDS validator tracks the newest stable release, and a pin move is a reviewed bump

**Status:** proposed
**Date:** 2026-10-20
**Owner:** Seyed Yahya Shirazi

## Context

The CLI, the per-dataset validation workflow and the upload preflight all run one pinned release of `@bids/validator`, read from `validator-version.json`.
The weekly `bump-validator.yml` selected only the 2.x line, so the pin could never move to 3.x by itself (issue #1036).
The 3.x line keeps the command line and the `--json` report that the CLI and the central validation workflow read, but its library entry points moved, and a browser build of the validator needs them.
The publication gate passes or refuses a dataset on the errors that survive the annex-pointer filter in the central workflow, so a new release can change which datasets are accepted without any code change in this repository.

## Decision

`validator-version.json` pins one exact release, and the monthly bump proposes the newest stable release of any major version as a pull request.
A bump is merged only after its reference-dataset comparison is on the pull request: the publication-gating error set of the old and the new release, computed with the central workflow's flags and annex filter, for the same datasets, with the differences listed in the pull request. The complete comparison is kept as the run's artifact, so a long diff is never silently cut.
The bump workflow computes that comparison itself, on a fixed set of reference datasets plus a canary layout; a full run over the nemarDatasets organization is a release-time check and is run by hand.
Every validation report the CLI writes names the release that produced it.

## Consequences

A new major version reaches a pull request without a code change, and the browser build can use the same release as the CLI.
A major version can change which datasets pass, so each bump is a review decision rather than an automatic one, and a reference set of about a dozen datasets is a sample: a change that only shows on other layouts is found by the full run, not by the monthly pull request.
The central filter removes findings at annex-pointer locations only, so a finding that a release reports at a sidecar file is not removed by it. A link to a git-annex key, which is what an unfetched annex file is, was read as present by the release compared and changed nothing; a link to no key was reported as broken with its sidecar as orphaned, so the comparison carries that layout as a detector and not as a layout that exists.
The validator version appears in the CLI's reports now; the central workflow's check-run gets it from the dispatch payload when that workflow is changed to print it.

## Alternatives considered

- **Keep the 2.x pin:** the browser validator would need a server-side pre-flight route instead, which is a larger backend change (the fallback described in issue #1036).
- **Pin a major version held in a variable:** the next major still needs a code change to adopt, which is the freeze this ADR removes.
- **Track the newest release with no review:** the publication gate reads the validator's output, so an unreviewed major release would change what gets published.

## Receipts

- Issue #1036 (the 2.x pin blocks in-browser validation) and its comment of 2026-10-20 on the policy.
- Issue #586 (the validator pin must match the version the per-dataset workflow runs) and issue #139 (run the latest validator).
- `.github/workflows/bump-validator.yml` and `scripts/validator/latest-stable.jq`.
