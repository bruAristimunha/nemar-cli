# Worker preamble (sent before every card)

You are implementing one card of NEMAR's portable compute plan (`.context/plans/portable-compute/plan.md` on the nemar-cli epic branch `feature/portable-compute-epic`).
Read the card in full, then the files its Context names, then act.

## Abbreviations used across the cards

Architecture Decision Record (ADR); command-line interface (CLI); continuous integration (CI); pull request (PR); Open Container Initiative (OCI); OCI Registry As Storage (ORAS); Singularity Image Format (SIF); GitHub Container Registry (GHCR); Brain Imaging Data Structure (BIDS); electroencephalography (EEG); tab-separated values (TSV); graphics processing unit (GPU); Structured Query Language (SQL); Transmission Control Protocol (TCP); Simple Linux Utility for Resource Management (SLURM); service unit (SU); quality control (QC); Cloudflare's SQLite database (D1); Cloudflare's object store (R2); OpenID Connect (OIDC); the NSF program Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support (ACCESS).

## Rules

- One card, one branch, one PR, in the worktree the card names; use absolute paths.
  Create the worktree from the primary checkout the manager gives you (never edit a primary checkout): `git -C <primary checkout> fetch origin && git -C <primary checkout> worktree add <worktree> -b <branch> origin/<base>`.
  In a nemar-cli worktree then run `bun install --frozen-lockfile`; in a nemar-process worktree, `uv sync --frozen`.
- Only the manager merges. Push once per review round. Never force-push, never rebase a pushed branch; to take a newer base, merge it into your branch and rerun the gates.
- Stay inside the card's Scope. Anything else goes in your report as a patch note for its owner.
- Write the tests first and see them fail; prove each test fails by mutating the one line it guards, then revert and confirm `git status --porcelain` is clean.
- No mocks of NEMAR logic, no mock data. A real `Bun.serve` stand-in for an EXTERNAL service (Tapis, R2's S3 interface, ACCESS) is allowed, as are HTTP fixtures for transport failures (timeouts, 5xx, dropped connections).
  The happy path of anything that talks to NEMAR is proven against NEMAR's real routes (the local stack of DM-08) in the card that owns that integration (DM-17, DM-18); a card that only changes what a client SENDS may check its requests with nemar-process's existing request-recording stand-ins, and says so.
- Run every gate yourself and quote its last lines. A computed value is never reported as measured.
- Never wait on a long job: the full `bun test` (about 80 minutes) and CI watches are the manager's. Report each as "not run, would check: X because Y".
- Kill stray `bun test` or `pytest` runs whose working directory is your own worktree before gates (`pgrep -fl "bun test"`, `lsof -a -d cwd -p <pid>`).
- Scratch scripts get unique names in a private subfolder of your worktree that you do not commit.
- No computer use, no visible graphical runs, no secrets. Never print a token, key, password or presigned address.
- The session shell may point NEMAR's CLI at the test API through `TEST_API_URL`: use `env -u TEST_API_URL` for production public reads, or set it explicitly to the address the card names.

## Hard rules of this repository family

- **Public repositories.** No host names, user names, home paths, IP addresses, tenant names, allocation ids or spend figures in code, tests, comments, commits, PRs or issues. Machines are "workstation A" and "workstation B"; the fork is "the collaborator's reader epic".
- **Live datasets** `nm000103`-`nm000107` are never modified or used; demo and tests only READ other public data.
- **Switches** (`COMPUTE_ENABLED`, `COMPUTE_PIPELINES_DISPATCH_ENABLED`, `COMPUTE_RUNNERS_ENABLED`, the re-pull switches) stay out of `backend/wrangler-sccn.toml`.
- **Revocation cascades, always,** with the docblock caller counts updated.
- **Versions are CI's.** Never edit a `version` field or run a bump script.
- **Tooling:** Bun and Biome for TypeScript; uv, ruff and ty for Python; never npm, npx, pip, conda, ESLint or Prettier.
- **Commits:** atomic, `<type>: <description>` under 50 characters, no emojis, no AI or co-author attribution. PR bodies: one line per paragraph, what changed, gates run with results, what was not run and why, the card ID.

## The leak check (every card that writes prose into a repository runs it on each such file)

```bash
f=<file>
grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' "$f" | grep -vx '127\.0\.0\.1'
grep -nE -i '/home/|/data/|/Users/|/scratch/|nm_[A-Za-z0-9_-]{16,}|nmr_[0-9a-f]{8}|nmra_[0-9a-f]{8}|nmo_[a-z]{2}_' "$f"
grep -oE '[A-Za-z0-9][A-Za-z0-9.-]*\.(edu|com|net|org|io|local|lan|internal)\b' "$f" | sort -u \
  | grep -vxE '(zarr|api|docs|app|test)\.nemar\.org|nemar\.org|ghcr\.io|github\.com|docker\.io|mne\.io|epic\.local|token\.actions\.githubusercontent\.com'
```

All three commands must print nothing (the loopback address is the only address allowed).

## Report (your final message, at most 25 lines)

PR number and head commit; each gate with its quoted last lines; evidence paths; a revert check per fix or test; deviations from the card; questions for the lead; patch notes for other owners; "not run, would check" lines.
