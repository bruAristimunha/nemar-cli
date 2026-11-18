# Dispositions of the pack reviews (2026-11-13)

Three reviews (executability EX, design DE, long-horizon advisor AD) and the owner's answers of the same day.
"Accepted" names where the fix is; "modified" says what was done instead and why; "rejected" says why.

## A. Demo critical path

| ID | Disposition |
|---|---|
| A1 image publish | Accepted, then decided by the owner (Q3 A): owner merges to `main`, CI signs; path B (unsigned, labeled) at Sat 08:00, then F2 and F3. DM-14 pins `SIGNING_IDENTITY` exactly and checks the digests artifact exists; cut line item 4; wording rule in plan 3.1. |
| A2a view fields | Accepted: `jobView` fields are in DM-06's Scope and Acceptance. |
| A2b claim digests | Accepted: DM-07 writes `launch_spec_digest` at claim under the lease guard; a re-claim overwrites it from its own specification; tested in DM-07 and DM-17. |
| A2c partition | Accepted with the recommended option: `shared` as a sizing label, `estimateSuMilli` never called; `compute.ts` and the queue memory limit checked in DM-06 with literal limits. |
| A3 settled stamp | Accepted: `NONE_SETTLED_STAMP_SQL` in DM-07; records copy and reports covered by its test and DM-17. |
| A4 Tapis selections | Accepted: every Tapis mechanic selects `executor = 'tapis'` in DM-06, with the advance-tick test. |
| A5 claim list | Accepted: `jobs[]` with a lease each in DM-04 and DM-07. |
| A6 revoke | Accepted: `runnerRevokeStatements` in DM-05 releases unstarted claims and makes started jobs `unreported` with no lease; `resolveApiKeyUser` refuses both prefixes. |
| A7 launcher boot | Accepted: the `runpy` boot line in DM-09, DM-11, DM-15. |
| A8 limits | Accepted: runner deadline and memory watchdog (DM-11), Apptainer limits under `NEMAR_ENFORCE_LIMITS` (DM-09), Docker limits (DM-10), Worker deadline in `sweepRunnerLeases` on every claim call, so it runs in any environment where a runner polls (DM-07). |
| A9 real image in CI | Accepted: DM-18 with a tiny real image under real Apptainer; `NEMAR_REQUIRE_APPTAINER=1` turns a skip into a failure in CI. |
| A10 smoke image | Accepted: `python:3.12-slim` by the Dockerfile's builder digest, moved to DM-14 step C1 because the owner allowed only a read-only probe. |
| A11 recipe argv | Accepted for the argument vector, the `cli.py` change, the network rule and the source-commit check (DM-13, DM-06). Modified for the selector: the Worker dispatches whole datasets of 2 to 6 EEG stores (DM-02); `--recording` stays for manual runs only, because a subset dispatch would stamp the dataset version as done; the stamp scope is Q0's. Demo wording no longer says "only the chunks it needed". |
| A12 CLI form | Accepted: `pipeline run <recipe> --dataset <id>[@version] --executor runner` in DM-06 and DM-15. |
| A13 source commit | Accepted: DM-13 refuses a mismatch; DM-02 checks it at selection; the index digest and Zarr engine version are recorded. |
| A14 dependencies | Accepted: DM-08 is build-only (after DM-05); integration split into DM-17 (after DM-07, DM-08) and DM-18 (after DM-11, DM-17); no "merge the epic later" rules remain. |
| A15 schedule | Accepted in substance: plan section 1, 3.5 and K1 say 34 hours and that F2 is the plan of record. Modified: the cards were not merged into fewer (each of DM-05, DM-06, DM-07 needs its own Opus review on a different invariant, and one giant PR would lengthen review more than it saves). |
| A16 DM-10 | Accepted: seeded `blocked`; the DM-01 handler sets it `todo` (and adds it to DM-15's and DM-18's Depends) or `dropped`. |
| A17 operator literals | Accepted: `outputs` command through the real links route with the pipelines key (DM-08, tested in DM-17); tmux or setsid for long-lived processes; Python 3.9 stop; literal capacity formulas; `TEST_API_URL` handling; per-run S3 credentials (DM-08). |
| A18 User-Agent | Accepted: `nemar-runner/<version>` (DM-04 constant, DM-11). |

## B. Setup, branches, numbering, gates

| ID | Disposition |
|---|---|
| B1 board setup | Accepted: runbook Setup steps 4 to 6 with the literal `init`, Parity, Slots and Budget rows, accepted with the plan. |
| B2 pack on branches | Accepted: runbook Setup step 2 commits the pack and cuts `feature/portable-compute-epic` from it; the board lives on `docs/portable-compute-board` (step 3). |
| B3 ADR numbering | Accepted: DM-03 adds 120 to `TOLERATED_GAPS`, a pointer amendment to ADR 0118, "refines 0118 for non-tenant executors"; PR #1641 in the Collisions table. |
| B4 `admitted_at` | Accepted: this program uses `runner_claimed_at`, so no column collides with P3; ADR 0121 requires P3's admitter to select `executor = 'tapis'`; Q5's options both work. |
| B5 gate fixes | Accepted: real test names (`compute-sweep.test.ts`; new files named for S1 and S6); no adr-index test as a gate for one-file docs cards; DM-03's non-gate removed; DM-10 reports CI as "not run"; `bun install --frozen-lockfile` in the preamble; DM-18 owns a full nemar-cli checkout with development dependencies; the image-missing case is exit 13 `runtime_error` with its detail; the leak check catches API keys and any host name. |
| B6 slots | Accepted: the per-repository rule is gone; an explicit order and corrected Collisions in `queue.md`. |
| B7 handlers | Accepted: questions asked at Setup, DM-01 verdict, DM-02, unanswered deadlines; defaults only where the owner pre-authorizes (Q4). |
| B8 abbreviations | Accepted: plan header and `cards/README.md`. |
| B9 DM-14 literals | Accepted: the exact JSON check of `nemar-recipe version`, stop on a failed ORAS pull, the Docker and Podman branches written out. |
| B10 switch, rotation, ACCESS | Accepted: DM-05 edits `AGENTS.md` (approved with the plan) and the rotation procedure; the claim re-checks public eligibility; a `runner/slurm` id goes in `runner_remote_id`, never `slurm_job_id`, and ACCESS keys on `accounting = 'su'`. |
| B11 lease semantics | Accepted: lease kept after complete; a started job's lease never replaced; an `unreported` job with completed outputs is verified (plan D4, DM-07). |

## C. Advisor items

| ID | Disposition |
|---|---|
| C1 lossy serving copy | Accepted, then decided by the owner: plain label in the demo; the fidelity profile and native profile stay an ADR 0123 option (plan D13, Q10). |
| C2 accounting class | Accepted: `accounting` on jobs and runners; money keys on it; `su` runner jobs refused until H1 (plan D1, D6; DM-04 to DM-07). |
| C3 derivatives home | Accepted as plan D14, ADR 0121's rule, step V1 and Q11; the demo keeps outputs local and says so. |
| C4 one recipe | Accepted: `nemar-floor-zarr` is a transition name; step Q0 converges. |
| C5 stamp tuple | Accepted: Q0 grows the tuple; until then DM-13 records the inputs in signalJourney. |
| C6 queued for slurm | Accepted: scoped to `runner/local`; decided at H1. |
| C7 reader claim | Accepted: plan D11 states the guarantee and the three readers; the demo makes no consolidation claim. |
| C8 protocol and trust | Accepted: protocol on the wire (DM-04, DM-05), `site` and `trust` on runners, usage labeled runner-reported, signed self-update with an opt-out (S4). |
| C9 reproducibility | Accepted: deterministic reconversion with converter digest and job id in the index (plan D10, Z0). |
| C10 private data | Decided by the owner: public only (Q9); R4 carries the advisor's conditions. |
| C11 access patterns | Accepted: counted refusals in DM-13's outputs; masks in Q2; raw input through presigned data-plane reads and the largest datasets in Z5 (plan D10). |
| C12 credit and equivalence | Accepted: citation fields in V1; H2 uses pre-registered tolerances with pinned threads; host facts per job; reproducibility statement in ADR 0121. |
| C13 phase Z scale | Accepted: CP-F chooses the promote mechanism against the stated scale; the drift test covers every pin mirror and the privacy floor; ADR 0123 supersedes 0029, 0033 and 0101. |
| C14 demo wording | Accepted: plan 3.1 and DM-16. |

## D. Smaller

| ID | Disposition |
|---|---|
| D1 Q6 and the override | Accepted: Q6 now waits on S3a's list; plan section 0 says plainly that approving the plan overrides `AGENTS.md` on two named points. |
| D2 unverified list | Accepted: plan section 5 updated (items 3, 6, 11, 12, 14, and new item 15). |
| D3 handle and private detail | Accepted: no handle or fork name in the pack; R4 and item 8 carry no private route detail. |

## Owner messages of 2026-11-13 (after the reviews)

| Item | Applied |
|---|---|
| Q3 A, fallbacks B and F2 | plan D8, 3.3, 3.5; DM-14; runbook handlers at 08:00 and 12:00; K9, K17 |
| QC label, profiles later | plan D13, 3.1; Q10 |
| Public only | plan D11; Q9; K4 |
| Read-only probe as the owner's login; directories and installs need a separate answer | DM-01 (no writes; smoke test moved to DM-14 C1); Q12; runbook Never list |
| Aliases confirmed; keep the mapping out of the repository | runbook live facts (`$WS_A`, `$WS_B`, `$WS_DEMO`); Q1 reduced to scratch paths |
| One machine runs the production conversion cron | DM-01's detection and demo-workstation rule; K16; DM-15's capacity limits; runbook Never list |
