# Compute program: roadmap and driver playbook

**Status:** current, 2026-11-03.
**Owner:** Seyed Yahya Shirazi.
**Driver:** a Haiku model at maximum effort runs development from this file; it orchestrates, it does not write code.

This is the entry point for the compute program: NEMAR's own processing pipelines and third-party jobs on SDSC Expanse through a NEMAR Tapis tenant, NEMAR as an OpenID Connect (OIDC) provider for the partner site compute.nemar.org, allocation accounting, and per-job records.
The design is the gated docs page `admin/design/compute-gateway` in `nemarOrg/docs` (readable at `docs.nemar.org/admin/design/compute-gateway/` with an admin session, or with `nemar admin docs admin/design/compute-gateway`).
Where the patterns live in this codebase is in [`implementation-notes.md`](implementation-notes.md).
Each phase issue is the implementer's complete brief: goal, routing, scope, changes, tests, acceptance criteria, gates, rules, escalation triggers.

Where this file, an issue and an ADR disagree, the ADR wins, then the issue, then this file, except on the full-suite gate (section 3, step 6), where this file wins.
When implementation shows the plan was wrong, change the issue and the design page in the same pull request that changes the behaviour; plans are expected to move.

## 1. Roadmap

| Epic | Repository | Batch | Starts when |
|---|---|---|---|
| A. Compute gateway core: ledger, jobs, Tapis client, records, pipeline dispatch | nemar-cli | 1 | now |
| C. nemar-process: launcher, images, eegprep recipes with signalJourney, Tapis definitions | nemar-process | 1 | now |
| B. NEMAR sign-in: an OpenID Connect provider | nemar-cli, website, docs | 1 | now |
| D. Third-party compute: access, user API, `nemar compute`, the partner contract, policies | nemar-cli, docs | 2 | A and B merged to `dev` |
| E. Website compute surfaces | website | 2 | D's routes merged to `dev` |

The epic issues, their phase sub-issues and their dependencies are listed in section 6.
First party comes first: A and C together are what NEMAR's data-quality work waits for.
B runs beside them because the partner's integration takes calendar time.

**Reserved numbers**, so parallel epics never collide:
migrations 0114 to 0119 for A, 0120 to 0124 for B, and 0131 and up for D (0130 is A's anonymization migration, applied before D's range was used);
ADR 0118 for the compute gateway (A) and ADR 0119 for the OIDC provider (B).
If a phase needs more, take the next unreserved number and say so in the PR.
A migration numbered below one that is already applied is a hazard, because deploy applies by name: production would apply the lower number after the higher one while a fresh replay applies it first, so reserve above the highest applied number.

**Outside gates** that no phase can pass on its own:
the Tapis tenant and the answers in the design's section 12 (the owner asks SDSC);
Worker secrets, the two Cloudflare R2 buckets with their lock and lifecycle rules, and the R2 API token (the owner creates them);
UC San Diego counsel's approval of the policies and the official-request procedure (Epic D, phase 5);
registering compute.nemar.org as an OIDC client (the owner, after Epic B merges).
Everything else is built and tested against local stand-ins first.

## 2. Roles and models

| Role | Model | Does | Never does |
|---|---|---|---|
| Driver | Haiku, maximum effort | Picks the next phase, briefs agents, runs the gates, drives review to convergence, merges phase PRs into epic branches, merges docs PRs that keep the design page current, keeps issues and state files current, escalates | Writes or edits code; merges an epic into an integration branch (nemar-cli `dev`, website `staging`, nemar-process `main`) without the owner's approval; sets secrets; decides a design question |
| Planner | Sonnet (Opus where the issue says) | Writes the phase plan as an issue comment for an `expand` phase | Implements |
| Implementer | as the issue's Routing says (Sonnet by default; Opus for B3, B4, D4) | Implements the phase in its worktree, tests first, opens the PR, fixes review findings on the same branch | Changes scope; merges |
| Reviewer | Sonnet panel through the project plugin's `pr-review-toolkit` | One full review round, a delta round only if round 1 was substantial | Fixes code |
| Advisor | Opus | Answers security, concurrency, authorization, data-integrity or architecture findings before they are fixed; runs the Opus checkpoint the issue names | Implements |

## 3. The driver's loop for one phase

1. **Pick.** Take the lowest-numbered phase whose `Depends on` phases are merged into its epic branch.
   Run at most three phases at once across all epics, never two phases that touch the same files.
2. **Read** the whole phase issue and the design sections it cites.
3. **Plan, if the issue says `expand`.** Brief the planner with the issue and ask for a plan comment that settles every "decide in plan" item, lists files, tests and gates, and stays inside the issue's scope.
   Check the plan against the acceptance criteria.
   If the plan would change a decision recorded in the design, an ADR or another issue, stop and escalate (section 5).
4. **Branch.** Create the phase worktree from the epic branch:
   `git -C <primary checkout> worktree add <worktrees dir>/<epic-slug>-<phase> -b feature/issue-<N>-<phase-slug> origin/<epic branch>`.
   Never edit the primary checkout.
5. **Delegate** with the brief in section 4, verbatim, to the model the issue names.
6. **Verify.** When the implementer reports, run the issue's Gates yourself in the worktree: the targeted tests and the quick gates, not the full suite (`.rules/testing.md`, "Test cost").
   A report is not a result; a gate you did not run did not pass.
   Read the implementer's "not run, would check: X because Y" lines and decide whether a long run is needed; you run it, the implementer does not wait for it.
   Watch CI-only checks yourself and resume the implementer only if something is red.
   A bare or full `bun test` in an issue's Gates is the epic -> `dev` gate and is not run in a phase: report it as "not run, would check: full suite because it is the epic gate".
   On this point this file wins over the issue.
7. **Review.** Run the project plugin's `pr-review-toolkit` on the PR with Sonnet reviewers.
   Every finding is fixed (no debt carried forward) except a false positive or a deliberate design choice, each answered with a one-line reason on the PR.
   Send security, concurrency, authorization, data-integrity and architecture findings to the Opus advisor before the implementer fixes them.
   Fixes go on the phase branch through the same implementer (continue it with SendMessage).
   At most two review rounds; if round two still finds something substantial, escalate.
8. **Opus checkpoint**, when the issue's Routing names one: brief the advisor with the PR and the issue's checkpoint text; fix what it finds the same way.
9. **Merge** the phase PR into the epic branch: `gh pr merge <PR> --squash --admin` once the gates pass and the review converged.
   The full CI run is the epic -> `dev` gate, not the phase gate.
10. **Record.** Tick the phase in the epic issue, close the phase issue, update the epic's state file (`.claude/epic-<slug>.local.md` in the primary checkout), and do the issue's "When merged" step:
    if the phase settled or changed anything the design page says, open a docs PR that updates `admin/design/compute-gateway` (or the runbook named) and merge it after its CI passes.
11. **Clean up.** Confirm the branch is merged and the worktree is clean, then `rm -rf` the worktree, `git worktree prune`, and delete the local branch (`git worktree remove` fails in this setup).

**Finishing an epic.**
Run the epic issue's definition of done end to end on a local backend (and the local website where it applies), and record the commands and results in the epic -> `dev` PR, which stays a draft until then.
Wait for the full CI run to be green, run one integration-scoped Sonnet review (cross-phase only), then ask the owner to approve the merge.
Merge with `--merge` (not squash) after approval.
Then check staging.

## 4. The implementer brief

Send this, filled in, as the whole prompt:

```text
You are implementing phase <key> of the NEMAR compute program: <issue URL>.
Read the issue in full (gh issue view <N> -R <repo>), then <repo>/AGENTS.md, .rules/testing.md, .rules/javascript.md (or the repository's equivalents), .context/compute-program/implementation-notes.md, and every ADR and design section the issue cites. The design page is in the nemarOrg/docs checkout at src/content/docs/admin/design/compute-gateway.md.

Work only in this worktree: <path>, branch <branch>, which tracks <epic branch>.
Write the issue's tests first and see them fail, then implement until they pass. Prove each test fails by mutating the line it guards.
Stay inside the issue's scope. If the issue is wrong or a decision is missing, stop and report it instead of deciding.
This repository is public: no tenant names, allocation ids, account names, host details, spend figures or real home paths anywhere.
Never mock NEMAR logic. Never hand-bump a version. Never set a secret or touch production.
Commit atomically with short messages (under 50 characters, no emojis, no AI or co-author attribution).
Run every command in the issue's Gates section with targeted tests only, and paste their final lines in your report.
Never wait on a long job (a full test run, a CI watch): push, and report what you did not run as "not run, would check: X because Y".
A bare or full `bun test` in an issue's Gates is the epic -> `dev` gate and is not run in a phase: report it as "not run, would check: full suite because it is the epic gate".
On this point this brief wins over the issue.
Kill stray background test runs in your worktree before running gates, and give every scratch script a unique name in a private subfolder.
Push and open a PR into <epic branch> titled "Phase <key>: <title>" whose body lists what changed, the gates you ran with results, and anything you could not do. GitHub bodies keep each paragraph on one line.
Report: the PR URL, the gates and their results, and every deviation from the issue.
```

## 5. When to stop and ask the owner

Escalate, with one message naming the issue, what is blocked, the options and a recommendation, when:

- a phase would change a decision in the design page, an ADR or another issue, or an ADR must be superseded;
- a security, privacy or data-integrity finding cannot be fixed inside the phase;
- something needs a secret, a credential, an account, a bucket or a bucket rule, an API token, a repository setting, a DNS record or a Tapis registration;
- something would reach outside: mail to real people, a post to SDSC or the tenant operator, a production deploy, turning on a switch, merging into `dev` or `main`;
- a gate still fails after two fix attempts and an advisor consultation;
- review round two still finds substantial problems;
- a phase takes more than twice the effort its size suggests;
- anything in the issue's "Escalate to the owner if" list happens.

Otherwise, proceed without asking.

## 6. Epics and phases

The issues are the source of truth for status and for each phase's brief; this table is the map.
Phase order within an epic is by key, except that A8 runs right after A5.

| Key | Issue | Title | Depends on | Readiness | Implementer | Opus checkpoint |
|---|---|---|---|---|---|---|
| **A** | [nemar-cli#2005](https://github.com/nemarOrg/nemar-cli/issues/2005) | **Compute gateway core: ledger, jobs, Tapis client, records, pipeline dispatch** | | | | |
| A1 | [nemar-cli#2006](https://github.com/nemarOrg/nemar-cli/issues/2006) | Compute contract and ADR 0118 | none | ready | Sonnet | no |
| A2 | [nemar-cli#2007](https://github.com/nemarOrg/nemar-cli/issues/2007) | Allocation ledger and owner policy | A1 | ready | Sonnet | yes |
| A3 | [nemar-cli#2008](https://github.com/nemarOrg/nemar-cli/issues/2008) | Job records and the results and records buckets | A1, A2 | ready | Sonnet | no |
| A4 | [nemar-cli#2009](https://github.com/nemarOrg/nemar-cli/issues/2009) | Tapis client and stand-in | A1, A2 (it adds a command to A2's group) | ready | Sonnet | no |
| A5 | [nemar-cli#2010](https://github.com/nemarOrg/nemar-cli/issues/2010) | Job lifecycle, webhooks, settlement and results | A2, A3, A4 | ready | Sonnet | yes |
| A6 | [nemar-cli#2011](https://github.com/nemarOrg/nemar-cli/issues/2011) | First-party pipeline dispatch | A3, A5 | ready | Sonnet | no |
| A7 | [nemar-cli#2012](https://github.com/nemarOrg/nemar-cli/issues/2012) | Tenant reconcile, observer and reporting | A5, A6, A8 | ready | Sonnet | no |
| A8 | [nemar-cli#2013](https://github.com/nemarOrg/nemar-cli/issues/2013) | Revocation cascade and ACCESS gateway attribution | A5 | ready | Sonnet | yes |
| **B** | [nemar-cli#2014](https://github.com/nemarOrg/nemar-cli/issues/2014) | **NEMAR sign-in: an OpenID Connect provider** | | | | |
| B1 | [nemar-cli#2015](https://github.com/nemarOrg/nemar-cli/issues/2015) | ADR 0119, partner hosts, __Host- cookie and OIDC subject | none | ready | Sonnet | yes |
| B2 | [nemar-cli#2016](https://github.com/nemarOrg/nemar-cli/issues/2016) | OIDC client registry, signing keys and discovery | B1 | ready | Sonnet | no |
| B3 | [nemar-cli#2017](https://github.com/nemarOrg/nemar-cli/issues/2017) | OIDC authorization and consent | B2 | ready | Opus | yes |
| B4 | [nemar-cli#2018](https://github.com/nemarOrg/nemar-cli/issues/2018) | OIDC token, userinfo, revocation and introspection | B3 | ready | Opus | yes |
| B5 | [nemar-cli#2019](https://github.com/nemarOrg/nemar-cli/issues/2019) | OIDC revocation cascades and back-channel logout | B4 | ready | Sonnet | no |
| B6 | [nemar-cli#2020](https://github.com/nemarOrg/nemar-cli/issues/2020) | Sign in with NEMAR docs and conformance | B5 | expand | Sonnet | yes |
| **C** | [nemar-process#1](https://github.com/nemarOrg/nemar-process/issues/1) | **nemar-process: launcher, images, eegprep recipes, Tapis definitions** | | | | |
| C1 | [nemar-process#2](https://github.com/nemarOrg/nemar-process/issues/2) | Repository scaffold and the nemar-launch launcher | none | ready | Sonnet | yes |
| C2 | [nemar-process#3](https://github.com/nemarOrg/nemar-process/issues/3) | nemar-python runtime image | C1 (repository, CI skeleton, Apptainer step) | ready | Sonnet | no |
| C3 | [nemar-process#4](https://github.com/nemarOrg/nemar-process/issues/4) | nemar-floor recipe | C1, C2 | expand | Sonnet | yes |
| C4 | [nemar-process#5](https://github.com/nemarOrg/nemar-process/issues/5) | nemar-ica recipe | C3, C2 | expand | Sonnet | yes |
| C5 | [nemar-process#6](https://github.com/nemarOrg/nemar-process/issues/6) | Tapis definitions and the observer | C1 (zip builder, env names, output layout) | ready | Sonnet | yes |
| **D** | [nemar-cli#2021](https://github.com/nemarOrg/nemar-cli/issues/2021) | **Third-party compute: access, user API, nemar compute, partner contract** | | | | |
| D1 | [nemar-cli#2022](https://github.com/nemarOrg/nemar-cli/issues/2022) | Compute access request and approval | A2, A5, A8 | ready | Sonnet | no |
| D2 | [nemar-cli#2023](https://github.com/nemarOrg/nemar-cli/issues/2023) | Compute user API and read commands | D1, A2, B4 | ready | Sonnet | no |
| D3 | [nemar-cli#2024](https://github.com/nemarOrg/nemar-cli/issues/2024) | User job submission and nemar compute submit | D1, D2, A1, A3, A5 | ready | Sonnet | no |
| D4 | [nemar-cli#2025](https://github.com/nemarOrg/nemar-cli/issues/2025) | Partner reservation and report contract | D1, D2, D3 (idempotency table), A2, A5, A7, B4 | ready | Opus | no |
| D5 | [nemar-cli#2026](https://github.com/nemarOrg/nemar-cli/issues/2026) | Compute terms, privacy policy and official requests | D1 (the version constant) | expand | Sonnet | no |
| **E** | [website#493](https://github.com/nemarOrg/website/issues/493) | **Website compute surfaces** | | | | |
| E1 | [website#494](https://github.com/nemarOrg/website/issues/494) | Compute access card | D1, D2 | expand | Sonnet | no |
| E2 | [website#495](https://github.com/nemarOrg/website/issues/495) | Compute dashboard | E1, D2 | expand | Sonnet | no |
| E3 | [website#496](https://github.com/nemarOrg/website/issues/496) | Job page | E2, D3 | expand | Sonnet | no |
| E4 | [website#497](https://github.com/nemarOrg/website/issues/497) | Admin compute tab | E1, D1, and Epic A's admin read routes | expand | Sonnet | no |
| E5 | [website#498](https://github.com/nemarOrg/website/issues/498) | Replace the Compute dialog | E3, D3 | expand | Sonnet | no |

## 7. Rules that bind every phase

The full rules are `AGENTS.md`, `.rules/` and the ADRs; these are the ones this program trips over most.

- **Public repositories.** nemar-cli, nemar-process and website are public.
  Tenant names, allocation ids, account names, host details, spend figures and real home paths stay in the gated docs and in secrets.
- **No mocks of NEMAR logic.** Real D1, real routes, Miniflare R2 for the bucket bindings, `Bun.serve` stand-ins for Tapis, R2's S3 interface and ACCESS; say in a test when no real response could be recorded yet.
- **Fences.** New crons are production-only by default; switches (`COMPUTE_ENABLED`, `COMPUTE_PIPELINES_DISPATCH_ENABLED`) are absent from `backend/wrangler-sccn.toml` and pinned by tests; dev and production use separate Tapis credentials, because dev D1 shares real users.
- **Revocation cascades, always,** with the docblock caller counts updated.
- **Compute access is not upload access** (ADR 0040), and approval is a person's decision (ADR 0042).
- **Integer accounting** in thousandths of an SU; a refused hold writes nothing; the rate-limit counters are never a quota.
- **Nothing the job writes is trusted** for accounting or records.
- **Versions** are CI's (ADR 0016). **Worktrees** always. **Bun, Biome, uv, ruff, ty** only.
- **Merges:** phase into epic with `--squash --admin` after the gates; an epic into its integration branch (nemar-cli `dev`, website `staging`, nemar-process `main`) only after green CI and the owner's approval, never with `--admin`; a docs PR into nemarOrg/docs `main` after its CI passes, never with `--admin`.

## 8. Owner actions

- [ ] Send the design page to the SDSC colleague and collect answers to its section 12; ask for the dev and production tenants.
- [x] The four private Cloudflare R2 buckets exist (created 2026-11-04, location hint western North America; compute storage is R2, not AWS): `nemar-compute-records` and `nemar-compute-results` for production, `nemar-compute-records-dev` and `nemar-compute-results-dev` for dev. Records: bucket lock rules `records/` 2,557 days (7 years) and `logs/` 366 days in production, 1 day each in dev so tests can clean up; lifecycle rules deleting `incoming/` after 2 days and aborting incomplete multipart uploads after 1 day. Results: lifecycle rule deleting objects after 30 days and aborting incomplete multipart uploads after 1 day. Check them with `bunx cfman wrangler --account sccn -- r2 bucket lock list <bucket>` and `... r2 bucket lifecycle list <bucket>`. The derivative store's two private buckets, `nemar-compute-derivatives` (production) and `nemar-compute-derivatives-dev` (dev), were created 2026-11-17 with the same location hint (western North America), no lock rule, no lifecycle rule but Cloudflare's default abort of incomplete multipart uploads after 7 days (retention is the store's code, and a deletion rule would delete a `published` derivative), r2.dev access disabled and no custom domain; check them with `... r2 bucket lifecycle list <bucket>`, `... r2 bucket dev-url get <bucket>` and `... r2 bucket domain list <bucket>`.
- [ ] Create two R2 API tokens in the Cloudflare dashboard (R2, Manage API tokens), each with Object Read & Write: one on `nemar-compute-records` and `nemar-compute-results` for production, one on the two `-dev` buckets for dev, so dev and production never share a credential (owner decision of 2026-11-17: the derivative store reuses these two tokens; see the next item). Store each pair in Infisical (project `nemar`, folder `/backend/compute`; the folder exists in `dev` and `prod` and already holds `COMPUTE_R2_S3_ENDPOINT`) as `COMPUTE_R2_ACCESS_KEY_ID` and `COMPUTE_R2_SECRET_ACCESS_KEY`, using the web interface so the values never reach shell history. Then copy the three values into the Worker secrets. Two traps: `wrangler secret put` without `--env dev` writes to the production Worker, whatever Infisical environment was read; and a pipe from an `infisical` call that found nothing uploads an empty secret and still reports success, so refuse an empty value:

  ```bash
  # from nemar-cli/backend; set E=prod (production Worker) or E=dev (dev Worker)
  for n in COMPUTE_R2_ACCESS_KEY_ID COMPUTE_R2_SECRET_ACCESS_KEY COMPUTE_R2_S3_ENDPOINT; do
    v=$(infisical secrets get "$n" --env "$E" --path /backend/compute --plain --silent | tr -d '\n')
    if [ -z "$v" ]; then echo "$n is missing in Infisical $E"; continue; fi
    if [ "$E" = dev ]; then printf %s "$v" | bunx cfman wrangler --account sccn secret put "$n" -c wrangler-sccn.toml --env dev
    else printf %s "$v" | bunx cfman wrangler --account sccn secret put "$n" -c wrangler-sccn.toml; fi
  done; unset v
  ```

  Later compute secrets (Tapis credentials, the ACCESS attributes key, `OIDC_SECRET`) go in the same folder and are copied the same way. `OIDC_SECRET` must be `nmsso-` followed by `openssl rand -hex 32` (70 characters, different for dev and production); any other form leaves the OpenID Connect provider off (ADR 0119 addendum, 2026-11-07). No AWS bucket or IAM user is needed for compute.
- [ ] Give each existing compute token its own environment's derivatives bucket: add `nemar-compute-derivatives` to the production token and `nemar-compute-derivatives-dev` to the dev token (Object Read & Write, nothing else changed, never a bucket of the other environment). If the dashboard issues a new key pair, store it in Infisical and copy it with the loop above. Read each token's bucket list back: exactly its own environment's three buckets. Then prove a server-side copy of one small object from the results bucket into the derivatives bucket under `selftest/`, deleted afterwards, printing status codes only; prove that neither environment's key pair can list any of the other environment's three buckets; and declare the derivative store live.
- [ ] Set the Tapis credentials as Worker secrets for dev and production once the tenant exists.
- [ ] Generate the ACCESS gateway attributes key for the community account and set it as the Worker secret `ACCESS_GATEWAY_ATTRIBUTES_KEY`, and set the name ACCESS knows the cluster by as `ACCESS_RESOURCE_NAME` (design question 14). Confirm the header that carries the key and the body's spelling against the real interface: both are unverified constants in `backend/src/services/access-attributes.ts`.
- [ ] Take the policies and the official-request procedure (Epic D, phase 5) to UC San Diego counsel.
- [ ] Register compute.nemar.org as an OIDC client after Epic B merges, and send its credentials to the SDSC colleague.
- [ ] Turn on `COMPUTE_ENABLED` and, later, `COMPUTE_PIPELINES_DISPATCH_ENABLED`, in production.

### Before the first launch: the prerequisites, in order

`nemar admin compute status` prints each of these as yes or no (never a value) under "Prerequisites", plus the Tapis, storage and ACCESS lines, so the order below can be checked from a terminal.
The checks marked (status) are the ones it prints.
The gated runbooks at `docs.nemar.org/admin/` are reachable with `nemar admin docs` for an administrator (the systems inventory was fetched on 2026-11-06), but the ones that exist say nothing about compute, so this list is the only written procedure; where a step says "not written down", the owner decides it.

1. [ ] The Tapis credentials are set as Worker secrets and the tenant answers: `token: ok` and `health: ok` (status).
2. [ ] `PRESCREEN_CALLBACK_SECRET` is set (status: callback secret) and `API_BASE_URL` is set (status: API base address). The one secret signs every compute token, so read the rotation rule before ever changing it: rotating it ends the `job_token` inside every running job's launch specification and the Tapis webhook addresses, so drain the running jobs first (ADR 0118, A5 amendment, item 5, and `.rules/revocation.md`).
3. [ ] `COMPUTE_RUNTIME_IMAGE` is set to ONE digest-pinned reference and is absent from `wrangler-sccn.toml` (status: runtime image valid, with its digest). A `python` job and every pipeline recipe stay `created` until it is.
4. [ ] NEMAR's pipelines service account exists: username `nemar-pipelines`, account kind `service`, status `approved`, not deleted (status: pipelines service account). How the account is created is not written down in this repository; create it as the owner would any other service account and check the line.
5. [ ] The first owner policy version is set with `nemar admin compute policy set --file <json>` (owner; status: owner policy "set"). Until a version exists the default applies, so a recorded version is the owner's decision on the record: the tolerances, the retention periods and the reservation wait are in it.
6. [ ] The `people` and `pipelines` platform pools are granted (`nemar admin compute pool grant`, owner for a platform budget; status: people pool and pipelines pool granted), and each person who may run a job has an account pool granted. A hold on a person's job needs both the person's pool and the `people` budget.
7. [ ] The observer's token procedure is decided and written down by the owner. A token is `nemar admin compute observer mint`'s output, good for one hour and ONE post, and the observer posts a quick document every 15 minutes, so a fresh token has to be minted for every post; ADR 0118 leaves who mints it, where it is kept and how it reaches the observer undecided, and nothing in this repository does it.
8. [ ] `nemar admin compute status` shows every line yes or ok, no "Reconciliation paused" line that was not intended, and no "Attention" line.
9. [ ] Turn on `COMPUTE_ENABLED`. While it is off the tenant sweep is paused (status prints "Reconciliation paused"), so the final settlement against Expanse, the failed ACCESS report listing and the following of jobs nobody reserved wait.
10. [ ] Epic D hand-off, before the switch is turned on for people: the mail sent when a job's results are ready links to `<APP_BASE_URL>/compute/jobs/<job id>` (`computeJobPageUrl` in `compute-results.ts`, never to a file), so that page must exist on the website first (issue nemarOrg/website#495, the compute dashboard). A mail whose link is a 404 is the first thing a person sees of the service.
11. [ ] Know what an administrator sees when Tapis loses a job, and what to do. A live job whose Tapis record answers 404 for a week (or whose cancel and read-back both answer 404) ends `failed` with the failure word `tapis_record_lost`: `nemar admin compute jobs list --state failed` shows the word, and `jobs record <id>` shows the job. A refused credential or a schema change does NOT end jobs this way: they go `unreported` and `status` shows it. The job is flagged `mismatch`. A job that never started was released with no charge; a job that ran (a start time, a Slurm id or uploaded results) was charged provisionally, capped at its hold. If a released job in fact used the allocation, nothing corrects it automatically (the observer corrects only a charged row): the use is flagged for you, and an administrator moves it with a grant. The Tapis job, if it still runs, is recorded as an orphan and cancelled by the cancel sweep. `status` also prints `Attention: cancel_pending_failed` (a cancel not carried out an hour after it was asked for) and `Attention: copy_abandoned` (a finished job whose launcher files were never copied).

## 9. Starting the driver

Open Claude Code in the primary nemar-cli checkout with Haiku at maximum effort, and give it:

```text
You are the driver of the NEMAR compute program. Read .context/compute-program/README.md in full and follow it exactly; it is your operating manual. Then read the five epic issues it lists and the state files .claude/epic-*.local.md for these epics. Resume from the first phase that is not merged, following section 3 for every phase. Delegate all code to implementers per each issue's Routing, review with Sonnet through the project plugin's pr-review-toolkit, and escalate only on section 5's triggers. Report to me at each phase merge and whenever you escalate.
```
