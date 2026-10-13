# Code Review Standards

## PR Review Toolkit
When the `pr-review-toolkit` plugin is available, use it after creating PRs to catch issues before merge.

### Available Agents
- `code-reviewer` - Review for style, best practices, project guidelines
- `silent-failure-hunter` - Find inadequate error handling, silent failures
- `code-simplifier` - Simplify code while preserving functionality
- `comment-analyzer` - Check comment accuracy and maintainability
- `pr-test-analyzer` - Review test coverage quality
- `type-design-analyzer` - Analyze type design and invariants

### Workflow
One PR gets at most two review rounds, then it merges.
The full procedure is
[review-convergence.md](https://github.com/neuromechanist/research-skills/blob/main/plugins/project/skills/pr-review-toolkit/references/review-convergence.md).

1. **At most two rounds.**
   Round 1 is a full review: one reviewer for a docs-only PR or under 50 changed lines, otherwise a panel of at most 3.
   Round 2 is one reviewer on the fix commits only.
   It runs only if round 1 was substantial: an accepted Critical; fixes over 150 non-test, non-doc lines; a public contract change; authorization, encryption, data integrity, or concurrency touched; or the approach replaced.
   It reports only Critical or Important defects the fixes introduce or fail to resolve.
   No third round unless the owner asks.
2. **Every finding gets one outcome:** fixed, rejected with a one-sentence reason, or filed as an issue (only for code the PR did not touch).
   Fix accepted findings before merge, never in a follow-up PR or the next release.
3. **Fixes ride on the PR.**
   Review-fix commits go on the PR's own branch, pushed once per round; they are part of that PR and are not a new change that needs its own PR.
   A separate fix PR exists only for a large fix (over 150 non-test, non-doc lines, a public contract change, or a replaced approach) or when the PR's head branch bars direct commits (`dev` for a release PR, an epic branch for the final epic PR).
   Then open ONE per round, targeting the PR's head branch.
   It gets the round 2 delta review only if round 1 was substantial (a large fix always is); otherwise the driver checks each finding is resolved.
   A release PR or the final epic PR gets one integration-scoped reviewer (see `.memory/release-pr-needs-own-review.md`).
4. **Merge gate:** the round 1 report (and the round 2 report, if round 2 runs) is in, every finding has an outcome, no accepted Critical is open, and CI is green on the final head.
   Never merge while a review is still running.

## Manual Code Review Checklist

### Before Committing
- [ ] Code compiles without warnings
- [ ] Tests pass
- [ ] No debug code left (print statements, TODO hacks)
- [ ] No sensitive data in code or logs

### Logic & Safety
- [ ] Error cases handled appropriately
- [ ] No silent failures (empty catch blocks)
- [ ] Thread safety for shared state
- [ ] Resource cleanup (files, connections, memory)

### Code Quality
- [ ] Functions do one thing
- [ ] Clear naming (no abbreviations)
- [ ] No magic numbers (use constants)
- [ ] Comments explain "why", not "what"

### Swift Specific
- [ ] Use `#if DEBUG` for debug-only code
- [ ] Prefer `let` over `var`
- [ ] Use `guard` for early returns
- [ ] Handle optionals safely (no force unwrap in production)

## Review Comments
When leaving review comments:
- Be specific about the issue
- Suggest a fix when possible
- Label severity (Critical, Important, suggestion); every accepted finding is fixed before merge
- Reference documentation or examples

---
*Two review rounds at most, then merge.*
