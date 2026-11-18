# NEMAR CLI: Development Instructions

> Tool-agnostic project instructions for any coding agent (Codex, Cursor, Copilot, Windsurf, Claude Code, ...).
> Claude Code reads this via `@AGENTS.md` in `CLAUDE.md`.

**This file is the hard rules and nothing else**:
what can go badly wrong in THIS checkout and is not obvious from the code, each in a few lines with a link to the detail.
Explanation, history and reference belong in `.rules/`, the decision index, `.memory/` or docs.nemar.org, never here:
two copies drift (ADR 0057).
**Read the hard rules in full before you edit anything**, and follow a link when you touch that area.

---

## Reading the documentation

- Public pages need nothing.
  **Every page has a Markdown mirror**:
  the page path plus `.md`, with **no trailing slash** (`/cli/commands/` is `/cli/commands.md`).
  `https://docs.nemar.org/llms.txt` indexes them.
- `/admin/` pages are gated to `admin` and `owner`.
  An admin with a CLI key reads one with `nemar admin docs admin/operations/systems-inventory`.
- **If you cannot read something you need, open the issue anyway**:
  say what you could not read and what you were trying to do, and tag **`@nemarOrg/admins`** (ADR 0057).
  Escalation replaces read access; **silence does not**.
- Page map, gated pages, retrieval detail: [`.rules/docs-site.md`](.rules/docs-site.md).

## START HERE: Architecture Decision Records

[`.context/decisions/`](.context/decisions/README.md) records what was decided and why.
Read the index before designing anything, and before "fixing" something that looks wrong:
several oddities here are deliberate, and the ADR says which.

- **Where an ADR and any other doc disagree, the ADR wins.**
  `.context/` keeps the analysis; the ADR is the verdict.
- **Never delete an ADR. Supersede it** (ADR 0019 shows what a superseded one looks like).
- **Write a new one** when a decision is expensive to reverse, closes off other reasonable paths,
  has been argued more than once, or encodes a constraint that is not obvious from the code.
  Copy `0000-template.md`, number sequentially, add it to the index;
  `test/adr-index.unit.test.ts` enforces that index and files agree.
- The load-bearing ADRs, one line each, are in the index's
  [Load-bearing ADRs](.context/decisions/README.md#load-bearing-adrs) section.
  Read the ones for your area.

## Hard rules

### Live datasets

**`nm000103`-`nm000107` are LIVE** (public, DOIs minted).
Do NOT modify their visibility, S3 data, DOIs or repo settings during development or testing.
For end-to-end testing use `nm099999` (`nemar admin e2e-test`; reset with `POST /admin/datasets/nm099999/reset`).
`xx`-prefix datasets are blocked from publishing.
Detail: [`.rules/datasets-and-fixtures.md`](.rules/datasets-and-fixtures.md).

### Dataset ID bands

All ids sit inside the 0-99999 cap (`xx900001` is invalid).
The top 100 ids of each allocating prefix (`nm099900`-`nm099999`, `xx099900`-`xx099999`) are RESERVED for standing fixtures and the allocator never returns one (ADR 0068);
fixtures are assigned downward from `nm099999`, and `nm099900` is `ABSENT_DATASET_ID`, never to be declared dev-owned.
The exemplar fleet (`xx0999NN`) is permanent.
**`nm099998` is the standing anonymous deposit: never publish it non-anonymously, a named publication destroys it** (ADR 0065).
The band table, the fixture gate and the fixtures: [`.rules/datasets-and-fixtures.md`](.rules/datasets-and-fixtures.md).

### Dev D1 shares production users and the GitHub org

Dev D1 `users` still holds roughly 609 real email addresses behind a live `RESEND_API_KEY`, and the `nemarDatasets` org is shared between prod and dev:
a dev job that selects users by a generic predicate can email real people, and a cascade delete can destroy a real repo.

- Do not re-seed production `nm`/`ds` rows into dev D1 (ADR 0009).
- Admin notification mail is production-only (`getAdminEmailsForCategory`);
  set `DEV_ADMIN_NOTIFICATIONS=1` only for a deliberate staging test.
  `DEV_EMAIL_ALLOWLIST` holds exact human addresses, never a domain (`@nemar.org` has a catch-all that becomes a production support ticket).
- **A new daily cron job is production-only BY DEFAULT**; the dev cron is a fail-safe allowlist in `scheduled()`.
- Staging auth uses `TEST_ADMIN_API_KEY` from `test/.env.test` with an isolated `NEMAR_CONFIG_DIR`, never a production key.
  Seeded account kinds and the rest: [`.rules/environments.md`](.rules/environments.md).

### Two names that look like bugs and are not

`ORG_NAME = "nemarDatasets"` is correct (`nemarOrg` holds tooling, `nemarDatasets` holds dataset repositories):
**do not change it to `nemarOrg`**.
**EZID is the DOI registrar, not Zenodo** (ADR 0007): a DOI change made on the strength of the Zenodo prior art is wrong.
[`.rules/environments.md`](.rules/environments.md).

### Revocation cascades, always

Ending a credential has to end everything minted from it (the GitHub token, S3 credentials, and the `docs` and `private` sessions).
Every route that revokes keys without ending every session calls `revokeDocsCredentials`.
The docblocks of `services/docs-auth.ts` and `services/private-auth.ts` name the callers of their revoke and purge statements;
**those counts are load-bearing, so add yourself to them**.
A role demotion and an API-key revocation deliberately leave `private` sessions alone.
Detail: [`.rules/revocation.md`](.rules/revocation.md).

### Never hand-bump the version

`package.json` version is owned by CI.
Do not edit it and do **not** run `./scripts/bump-version.sh` before a `dev` to `main` PR (ADR 0016).
Detail: [`.rules/release-and-repull.md`](.rules/release-and-repull.md).

### The re-pull switches and caps are the owner's

`AUTO_REPULL_ENABLED`, `AUTO_REPULL_MERGE_ENABLED`, `REPULL_DAILY_OPEN_CAP` and `REPULL_DAILY_MERGE_CAP` stay out of `backend/wrangler-sccn.toml` (`backend/test/repull-switches-flag.test.ts` fails a change that adds one);
only the owner adds one, because every re-pull merge mints a version DOI that cannot be withdrawn (ADR 0111).
A manual major bump on an `on` dataset is refused: plan an upstream re-pull instead.
Detail: [`.rules/release-and-repull.md`](.rules/release-and-repull.md).

### The vector visibility switch is the owner's

`VECTORIZE_VISIBILITY_FILTER` stays out of `backend/wrangler-sccn.toml` (`backend/test/vectorize-switch-flag.test.ts` fails a change that adds one); only the owner turns it on (ADR 0126).

### The compute switches are the owner's

`COMPUTE_ENABLED`, `COMPUTE_PIPELINES_DISPATCH_ENABLED` and `COMPUTE_RUNNERS_ENABLED` (registered runners; it also needs `COMPUTE_ENABLED`) are dark switches: they stay out of `backend/wrangler-sccn.toml` (`backend/test/compute-switches-flag.test.ts` fails a change that adds one),
and only the owner adds one, in a reviewed pull request that edits that test.
Compute crons are production-only (ADR 0118).

### Account copy and the profile-gap matrix are declared once

Every sentence about tiers, upload access or a missing field comes from [`shared/contract/account-copy.ts`](shared/contract/account-copy.ts),
and the ONE gap rule is `computeProfileGaps` in [`shared/contract/profile-gaps.ts`](shared/contract/profile-gaps.ts) (ADR 0045).
Change a sentence or a rule there, never at a call site.
Detail: [`.rules/documentation.md`](.rules/documentation.md).

### Work in a worktree

Do not edit the primary checkout; concurrent sessions share it: `git worktree add <path> -b <branch> origin/dev`.

## Tooling is fixed

**Bun** for JavaScript and TypeScript, never npm or npx.
**Biome** for lint and format, never ESLint or Prettier.
**uv** for anything Python, never pip or conda.
Wrangler runs through cfman only: `bunx cfman wrangler --account sccn <arguments>`.
Commands: `bun install`, `bun run src/index.ts` (run the CLI from source), `bun run typecheck`, `bun run lint`, and `bun test` (targeted; see Test cost below).

## Development workflow

- **One change:** check the decision index and [`.context/plan.md`](.context/plan.md), branch into a worktree, follow [`.rules/javascript.md`](.rules/javascript.md),
  write real tests ([`.rules/testing.md`](.rules/testing.md): NO MOCKS), commit atomically (under 50 characters, no emojis, no co-author tags),
  open a PR that references the issue, and review it per [`.rules/code_review.md`](.rules/code_review.md) (at most two rounds, fixes on the PR's own branch).
  If the change settled something an ADR should own, add or supersede one in the same PR.
- **Test cost:** phases, fixes and review rounds run only targeted tests plus the quick gates,
  the full `bun test` (about 80 minutes) runs only at epic -> `dev`,
  and agents never wait on long jobs (push and report "not run, would check: X because Y"):
  [`.rules/testing.md`](.rules/testing.md), [`.rules/ci_cd.md`](.rules/ci_cd.md).
- **Multi-phase work is driven with `/project:epic-dev`** (`--next-phase`, `--resume`, `--finalize`; inspect with `/project:epic-status`);
  never hand-roll an epic, and never let the issues, PRs and `.claude/epic.local.md` drift.
  Phase PRs squash-merge into the epic branch; the epic branch merges into `dev`;
  never admin-merge `dev` or `main` ([`.rules/git.md`](.rules/git.md)).
- **The compute program** (compute gateway, sign-in provider, third-party compute) runs from its operating manual, [`.context/compute-program/README.md`](.context/compute-program/README.md):
  roles, the per-phase loop, the implementer brief and when to escalate.

## Where everything else lives

- **Standards:** [`.rules/`](.rules/) (`javascript`, `git`, `testing`, `code_review`, `documentation`, `ci_cd`, and the hard-rule detail files linked above).
  **Platform reference:** docs.nemar.org via [`.rules/docs-site.md`](.rules/docs-site.md); `nemar <group> --help` is authoritative for commands.
- **Observations:** [`.memory/`](.memory/README.md), one per file, binding nobody (an ADR is a ruling, a `.context/` document an argument, a memory an observation).
  **Plans and research:** [`.context/README.md`](.context/README.md) marks what is current and what is historical;
  start from [`plan.md`](.context/plan.md), [`ideas.md`](.context/ideas.md) and [`research.md`](.context/research.md) (prior art from before NEMAR, not the production path).
