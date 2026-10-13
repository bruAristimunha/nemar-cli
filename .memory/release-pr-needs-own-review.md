---
name: release-pr-needs-own-review
description: "The dev-to-main release PR gets its own single integration-scoped review before merging, even when every phase and the epic PR were already reviewed; its fixes go in one fix PR into dev, and an accepted finding never ships in the next release"
metadata:
  type: feedback
---

On the v0.10.0 release of nemar-cli (2026-09-08), after the epic #1272 had per-phase reviews and an epic-level review, Yahya added: "promoting dev to main needs its own PR review to find things that might have fallen from seams."

**Why:** between the epic review and the release, `dev` accumulates follow-ups (live-tier fixes, config notes, an email fence, version bumps) that were each reviewed alone but never together against `main`; the release diff is the only place their interactions, config and workflow drift, and the release-safety checklist are visible at once.

**How to apply:** in the epic-dev finalize flow, after the epic PR merges into `dev` and before merging the `dev` to `main` release PR, run ONE integration-scoped release review on the full `origin/main...dev` diff (a detached worktree at the dev tip, one read-only reviewer on Sonnet; the feature PRs were already reviewed, so it does not re-review them): a seams-focused code review (follow-ups versus the epic, wrangler and workflow config, AGENTS.md and docs versus shipped behavior, migration catalog) plus a check of `.context/release-safety-playbook.md` against the PR body's checklist. Every finding gets an outcome (fixed, rejected with a reason, or filed as an issue for code the release did not touch). Put all fixes from the round in ONE fix PR into `dev`, never one PR per finding and never a direct commit to `dev`; that fix PR gets the delta review only if round 1 was substantial (the two-round cap in `.rules/code_review.md`). Never ship an accepted finding in the next release. Open the release PR only when it is ready, merge it promptly (every push to `dev` re-runs the release PR's CI), and put the changelog in the release PR, not in a patch PR after it. See [[cite-adr-by-content-not-plan-numbers]] and [[dev-worker-deploys-only-from-dev]].

**Revised 2026-10-12:** one reviewer instead of several, the one-fix-PR rule and the ban on shipping accepted findings in the next release were added after releases 0.10.8 to 0.10.10 spawned seven fix or changelog-patch PRs, with findings shipped in the next release.
