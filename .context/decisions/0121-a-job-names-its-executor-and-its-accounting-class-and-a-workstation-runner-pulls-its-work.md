# ADR 0121: A job names its executor and its accounting class, and a workstation runner pulls its work

**Status:** proposed
**Date:** 2026-11-13
**Owner:** Seyed Yahya Shirazi

Epic #2145.
This Architecture Decision Record (ADR) refines [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) for jobs that are not Tapis tenant jobs, and refines stage 3 of [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md) a second time.
A tenant or partner job has a Tapis job and is always `su`, so nothing changes for it.
For an `accounting = 'none'` job the departures are ADR 0118 decision 3 and the A3 amendment's item 1 (the hold), decision 4 (a charge settles twice), decision 9 (the ACCESS report is owed for tenant jobs only), the A2 amendment's item 7 (`settled_final_at` implies a `job:<id>:final` entry) and the A5 amendment's item 6 (the terminal batch writes a ledger entry); `shared/contract/compute-runner.ts` also extends decision 10's list of modules.
It supersedes nothing.
[ADR 0122](0122-one-oci-image-runs-under-apptainer-or-docker-from-one-digest.md) decides the container.

## Context

ADR 0118 assumes every job runs on Expanse through Tapis, so a job, its ledger entry and its hold are one fact.
NEMAR now wants the same containerized job to run first on a lab workstation, which has no allocation to meter, and later on other clusters.
A workstation sits behind a firewall and must not hold a credential that reaches NEMAR's storage.
Money must be counted only where an allocation exists, and every job, wherever it ran, must have the one record ADR 0118 promises.

## Decision

1. **A job names its executor and its accounting class.**
   `compute_jobs.executor` is `tapis` (the default) or `runner`; a runner job also records `runner_backend`, `local` (a workstation) or `slurm` (a cluster scheduler, decided later).
   `compute_jobs.accounting` is `su` (the default) or `none`, and a Tapis job is always `su`: a table CHECK says so.
   Executor mechanics select `executor = 'tapis'`: the advance tick, the submit claim, the cancel sweep, the tenant sweep, the admin advance, and every Tapis admission path, including the pipeline admitter of #2121 phase P3 when it lands.
   Money and tenancy select `accounting = 'su'`: the ledger, `tenantGuard`, the pipelines' live cap, the observer's settlement and the ACCESS report.
   Only a job whose `source` is `pipeline` (the administrator's pipeline run) can be a runner job; a person's or a partner's job is never `none`, which keeps ADR 0040 and ADR 0042 intact.
   `su` means Expanse's allocation: the ledger unit is the Expanse service unit (SU), so a runner on another cluster needs its own accounting decision before it is `su`, and an ACCESS report keyed on `su` must not be sent for it.
2. **There is no new state.**
   A waiting runner job is `created` with `runner_claimed_at` NULL; a claim sets `runner_claimed_at`, `runner_id` and a lease and leaves the state `created`.
   The runner's `started` heartbeat writes `created -> running`, its `uploading` heartbeat writes `running -> archiving`, and `finished` stands only after `verifyResults`.
   An unstarted lease that expires clears the claim, so no backward edge is needed; a started job whose lease expires becomes `unreported`.
   An `unreported` runner job whose outputs completed is verified like any other; otherwise it fails `runner_lost` `lease_expired` after a give-up wait (60 minutes at the time of writing).
   `runner_lost` has five declared details: `lease_expired`, `claims_exhausted`, `deadline_exceeded`, `runner_revoked` and `dataset_ineligible` (a waiting job whose dataset is gone or no longer eligible is ended by the sweep so it stops holding a live-job slot); `runner_revoked` is written by `sweepRunnerLeases` for a revoked runner's started job whose outputs did not complete, and a job whose outputs completed is verified.
   `submitted` and `queued` are never used by `runner/local`; whether `runner/slurm` uses `queued` is decided when that backend is built.
   The column is deliberately not #2121 phase P3's `admitted_at`, so either migration can land first.
3. **Workstations pull; NEMAR never pushes.**
   `nemar-runner` opens no inbound port, polls the Worker over HTTPS and sends `User-Agent: nemar-runner/<version>`.
   It runs as an ordinary user, but its privileges are those of the container runtime it drives (see the consequences and ADR 0122).
4. **The protocol is `nemar.runner.v1`: register, exchange, claim, heartbeat, complete.**
   A claim returns a list of up to `free_slots` jobs, each admitted by its own conditional UPDATE with its own lease, and the dataset's public eligibility is checked again inside that statement.
   The claim writes `launch_spec_digest` for the specification it answers, and a re-claim overwrites it.
   A heartbeat renews the lease and carries a cancel back; a started job's lease is never replaced; an unstarted expired lease releases the claim a bounded number of times, then `runner_lost` `claims_exhausted`.
   The runner stops a job at its end time plus a grace, and the Worker fails a started job a grace past its minutes with `runner_lost` `deadline_exceeded` unless its outputs completed.
   `sweepRunnerLeases` runs on every claim call, in every environment, and on the production 30-minute tick; the tick itself stays production-only, so ADR 0118 decision 8 stands.
   The bundle, outputs and outputs-complete calls of a runner job are accepted only under the current lease, and a retried complete answers the same state.
   Execution is at least once and acceptance is at most once; exactly once is not achievable across a partition.
   Every number, word and shape is declared once in `shared/contract/compute-runner.ts`; at the time of writing a lease is 10 minutes, a heartbeat 60 seconds and a job is claimed at most 3 times.
5. **Registration is owner-only, and a revoke ends the runner's work.**
   A registration mints a secret `nmr_` plus 64 hex, shown once and stored as a hash; the secret buys a short-lived access token `nmra_` plus 64 hex.
   Every other route refuses both prefixes before any lookup (`runner_credential_not_accepted`), as ADR 0119 does for `nmo_`.
   Revoking a registration, in one batch, revokes it, deletes its tokens, releases its unstarted claims and moves its started jobs to `unreported` with the lease cleared, so neither the job token nor the lease can land outputs.
   `runnerEndStatements(userId)` does the same for every registration an owner made.
   Three callers run it in their own batch: `finalizeRevocation`, `tombstoneUserCascade` and the demotion of an owner, a caller although ADR 0118's A8 amendment spares a demotion, because a registration is owner standing and a demotion ends it.
   `RUNNER_END_CALLERS` names them, a source-scan test holds the list, and the docblocks of the revocation statements must keep their caller counts, which the revocation rule of `AGENTS.md` relies on.
   A key revocation (self-service, the owner's, the emailed regeneration) is DELIBERATELY not a caller: a registration is a standing grant of the owner's account that outlives any one key, so rotating a key must not stop a lab's queue.
   The residual, in the style of ADR 0118's A8 item 1: a registration made with a stolen owner key survives that key's revocation until the owner revokes the registration.
6. **An `accounting = 'none'` job writes no ledger entry, and its usage is measured and labeled.**
   It makes no hold, charge or adjustment, and its terminal batch stamps both settled timestamps with `charged_milli = 0`, so the records copy and the reports treat it as settled.
   Usage is `runner_wall_seconds`, `runner_cpu_seconds` and `runner_max_rss_mb`, shown as "runner-reported core-hours" and never as SU.
   Capacity is a runner guard inside the job's own INSERT: live `accounting = 'none'` runner jobs of the pool must be fewer than `policy.runners.maxLiveJobs[pool]` (defaults 64 for `cpu` and 8 for `gpu`).
   A runner job's sizing uses an existing partition name as a label only, `shared`, whose ceilings apply, and `estimateSuMilli` is never called for it.
   An `accounting = 'su'` runner job is refused (`runner_accounting_unbuilt`) until the phase that builds its hold, settlement and report.
   Runners do not share the Zarr conversion host's capacity ledger (ADR 0101) until a later ADR (planned as 0123) decides how.
7. **`COMPUTE_RUNNERS_ENABLED` is a third dark switch.**
   It is needed together with `computeEnabled(env)` and stays out of `backend/wrangler-sccn.toml`; the change that builds it will pin it with a flag test and name it in the dark-switch rule of `AGENTS.md`.
8. **A derivative has its own home.**
   Derived outputs are never written into the raw-only serving copy ([ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md)) and never committed into the dataset repository, where they would cost a version bump, an irrevocable DOI and a stamp loop.
   Until a derivative store is decided, a demo keeps outputs in a local stack or an operator's scratch and says so.
9. **A result is reproducible from an image digest, a launch specification and an input snapshot, with no runner and no Tapis.**
   The launch specification carries a per-job token, so it is never the record of an input; a recipe that streams a Zarr store, not the platform, records what it read.
   Each runner job records its registration's facts (site, trust, capacity) as host facts.
10. **A pipeline stamp names the input a recipe read, and the one `nemar-floor` reads two.**
    This refines the pipeline stamp of the [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) amendment of 2026-11-05 (items 1 to 3) in four ways, built by migration 0141 and `shared/compute-recipes.ts`.
    First, the stamp's tuple is (dataset version, recipe, recipe version, engine, input), where `input` is `bids` (the dataset's files, on Tapis) or `zarr` (its Zarr serving copy, on a runner), so one run of each input of one dataset version coexist and the one-live-stamp rule holds per input.
    The recipe `nemar-floor-zarr` is gone from the registry: `nemar-floor` lists both inputs, the table of which input runs on which executor is declared once, and the old stamps keep their recipe name with `input` set to `zarr`, so the registry answers `recipe_unknown` for them and they never occupy a `nemar-floor` slot.
    Second, the command is still `nemar-recipe run <name>` for the BIDS input, byte for byte, and is `nemar-recipe run <name> --input zarr` for the Zarr input; the arguments are unchanged, because a Zarr job's arguments already fill the 64 a launch specification may carry.
    Third, the registry hold is per input, not one per registry tuple: a finished record that names another recipe version, engine or input than the stamp claimed holds the claimed tuple and input only, and a record of another input ends the stamp `failed` with `tuple_mismatch` (that stamp is the hold), so a stamp never says "read zarr" of a run that read something else.
    Fourth, a `succeeded` stamp takes three fields from the recipe's own record, each stored only in the shape of its column and otherwise left empty and logged by name: `reader`, `input_engine` and `input_digest`.
    A Zarr digest (`sha256:`) is stored only when the record shows it covers every store the run was given (an empty `stores_unread`, a non-empty `stores_content`, and the paths of its rows equal to `input.stores`, each once), which a run over a subset of the stores (`--recording`) satisfies for the stores it was given, so the derivative store's spec check, not the stamp, decides whether that subset is an input it keys on; a BIDS digest is `git:` and the source commit the record carries, and a Worker-dispatched BIDS record carries none, so a BIDS stamp has no digest.
    The stamp does not recompute the digest from the rows: that check belongs to the derivative store (item 8), which holds the one shared definition of the input digest.
    One ordering changes with it: where a recipe may run (its listed executors) is now asked before the placeholder question, so a placeholder asked to run on an executor it does not list (`nemar-ica` on a runner) is refused as an unlisted executor, not as `recipe_placeholder`; item 3 of the ADR 0118 amendment, which says a placeholder is refused on every path with `recipe_placeholder`, is inexact for that one case.

## Consequences

- A workstation runner needs no storage credential and no inbound route.
  That is not a small attack surface on a rootful container runtime, where the runner's user is root-equivalent, and until the runner verifies signatures it runs whatever digest the Worker names (ADR 0122).
- Reports must group by executor and accounting class; a runner-reported core-hour is never added to an SU total.
- An `accounting = 'none'` job escapes the ledger's guards by design, so the runner guard, the dark switch, public-data-only eligibility, the pipeline-only source and the owner-only registration are the whole of its budget control.
- Two admission paths (P3's `admitted_at` and `runner_claimed_at`) coexist until a later change converges them.
- Rollback hazard: once an owner stores a `policy.runners` key, a Worker from before this ADR reads the policy as unreadable and fails every compute path closed, Tapis jobs' outputs included; the recovery of ADR 0118's P2 amendment applies.

## Alternatives considered

- **Key money on the executor:** a runner on an allocation would escape the ledger.
- **A table per executor:** forks the records and the reports.
- **A `claimed` state:** widens every CHECK for what a column already says.
- **NEMAR ssh-ing jobs to hosts:** a push surface and stored host credentials.
- **A message broker or a WebSocket push:** a new service for what polling does.
- **A zero-SU hold:** a shape that lies about a budget; a second ledger in core-hours was rejected for the same reason.
- **Exactly-once execution:** impossible across a partition.

## Receipts

- [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md), [ADR 0119](0119-nemar-is-an-openid-connect-provider-and-orcid-stays-the-upstream-identity.md), [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md), [ADR 0027](0027-zarr-dispatch-is-raw-only-derivatives-sourcedata-code-excluded.md).
- The runner contract, declared once (#2146): `shared/contract/compute-runner.ts` and `shared/compute-state.ts`.
