# Git & Version Control Standards

## [STRICT] Nothing merges without a review, and nothing skips the PR

**Why:** this is a standing rule that was already in force and got broken anyway,
which is the only reason it is written here now. During epic #1144 a fix for
issue #1164 was committed straight to the epic branch, with no PR and no review
pass, on the judgement that it was small and its reasoning was obvious.

That judgement was the same one that created the bug it was fixing. Phase 2b had
shipped a sweep with a service, an admin endpoint and two test files and simply
never wired it to the cron, and it looked complete from every angle anyone
checked. "Too small to need review" is not a category that exists here; the
severity of a defect is not proportional to the size of the diff that carries it.

**The rule:**

- **A pull request is merged only after a review pass.** No exceptions for size,
  for obviousness, or for the author being confident.
- **Every change reaches an integration branch through a pull request.** That
  includes an epic branch. Committing directly to one bypasses the review gate
  and is the same violation by another route.
- The narrow carve-out is documentation that cannot affect behaviour: `.rules/`,
  `.context/`, and the gitignored epic-state file. Anything under `src/`,
  `backend/src/`, `shared/`, `scripts/`, `test/` or `backend/test/` is a PR.
  Tests are included deliberately: a bad test does not break production, it
  removes the thing that would have caught the break.
- **"A review pass" is the two-round cap in `.rules/code_review.md`.** One full
  round and, only when it was substantial, one delta round on the fixes. Merge
  once every accepted finding is fixed; a third round needs the owner.
- **Review-fix commits belong to the PR they fix.** Push them to that PR's own
  branch, once per round. They are covered by its review rounds and are not a
  new change needing a PR of their own. A feature branch is not an integration
  branch, so this does not breach the integration-branch rule above.
- **A separate fix PR is the exception:** a large fix (defined in
  `.rules/code_review.md`), or a head branch that bars direct commits (`dev`
  for a release PR, an epic branch for the final epic PR). Open ONE per round,
  targeting the PR's head branch. It gets the delta review only if round 1 was
  substantial (a large fix always is). While a release PR is open, even a
  docs-only fix goes in that one fix PR: the direct-to-`dev` carve-out above and
  in `.rules/ci_cd.md` does not apply to the head of a release PR, because a push
  to it re-runs the PR's checks and a `[skip ci]` head blocks the merge.

**Record the review where it survives.** Post the findings and their resolution
as a comment on the PR. Agent-driven reviews leave `reviewCount: 0` on GitHub, so
a review that exists only in a local state file or a terminal scrollback is a
review that nobody after you can find. Epic #1144 Phase 1 took three review
rounds and its record lives in a gitignored file; Phases 2 and 2b posted theirs
and are still readable.

## Commit Messages
- **Format:** `<type>: <description>`
- **Length:** <50 characters
- **No emojis** in commits or PR titles
- **Types:**
  - `feat:` New feature
  - `fix:` Bug fix
  - `docs:` Documentation only
  - `refactor:` Code restructuring
  - `test:` Adding tests (real tests only)
  - `chore:` Maintenance tasks

## Branch Strategy
- **Feature branches:** `feature/short-description`
- **Bugfix branches:** `fix/issue-description`
- **No spaces** in branch names, use hyphens
- **Delete after merge**

## Commit Practice
- **Atomic commits** - One logical change per commit
- **Test before commit** - Ensure code works
- **No broken commits** - Each commit should work independently

## Pull Request Process
1. Create issue first (for significant changes)
2. Branch from main
3. Make atomic commits
4. Push branch
5. Create PR with:
   - Clear title (no issue numbers)
   - Description with "Fixes #123"
   - Test results
   - Screenshots if UI changes

## Git Commands
```bash
# Start feature
git checkout -b feature/new-thing

# Atomic commits
git add -p  # Stage selectively
git commit -m "feat: add user authentication"

# Update branch
git fetch origin
git rebase origin/main

# Push and create PR
git push -u origin feature/new-thing
gh pr create
```

## .gitignore Essentials
```
.context/        # Local workflow docs
__pycache__/     # Python
node_modules/    # JavaScript
.env            # Secrets
*.log           # Logs
```

---
*Atomic commits, clear messages, clean history.*