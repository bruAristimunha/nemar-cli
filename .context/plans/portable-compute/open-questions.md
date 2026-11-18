# Open questions for the owner

Each pending row names a plan of record, so the pack runs whichever way the owner answers; the manager records each with `mb ask` before asking, and no question takes a default unless the row says the owner pre-authorized it.

## Decided by the owner (2026-11-13)

| ID | Decision | Where it is applied |
|---|---|---|
| Q3 | Option A: the owner merges nemar-process PR #17 and `feature/runner-epic` (with DM-13) into `main`, and CI publishes and signs; the manager never merges to `main`. Fallbacks: path B (operator-built, unsigned, labeled) if no signed digest verifies by 2026-11-14T08:00, then F2 and F3. | plan D8, 3.3 item 4; DM-14; runbook handlers |
| Q9 | Public data only on runners; private data waits for launcher-staged, no-network private jobs. | plan D11, R4; risk K4 |
| Q10 | QC runs on the Zarr serving copy by default (EEG 250 Hz; EMG and iEEG 1 kHz) with the label "QC ran on the serving copy (EEG 250 Hz, 16-bit), not on the archive"; a named fidelity profile and a native-rate profile stay an option for ADR 0123, not a demo item. Refined by the owner (2026-11-14, Q18, option A): 250 Hz is the EEG rate cap of ADR 0028, not a resampling target, so the demo label is "QC ran on NEMAR's Zarr serving copy (EEG capped at 250 Hz, 16-bit; the serving copy of this dataset is at 200 Hz), not on the archived recordings"; general statements say "capped at 250 Hz", and the archived recordings' own rate was not checked and is never stated. | plan D13, 3.1; DM-13; DM-16 |
| Q1 (partly) | The two ssh aliases work from the manager's host; a read-only probe as the owner's own login is allowed after plan approval. | DM-01; runbook live facts |

## Decided by the owner at plan approval (2026-11-13, later)

| ID | Decision | Where it is applied |
|---|---|---|
| Plan | Approved as written, including both `AGENTS.md` overrides, the merge authority (epic branches only) and the routing. | plan section 0 |
| Budget | `Agents today` raised to 100; `Advisor consults` stays 5. | runbook Setup step 5 |
| Q12 | Option B: the operator may create `nemar-runner` on the demo workstation under the scratch path, pull or build the image there, run it and delete it all; no installs of system software and no `sudo`; a user-local Bun install is allowed. | DM-14, DM-15, DM-19 |
| Q1 | No scratch path named: DM-01 uses `$HOME` for `$SCRATCH_A` and `$SCRATCH_B`, marked provisional. | DM-01 |
| Q4 | The owner named two datasets: `nm000132` and `on003645`. DM-02 checks both against its criteria (public, non-anonymous, small, EEG, a Zarr copy that exists) and reports; if both pass, `nm000132` is the demo dataset; if only one passes, that one; if neither, the manager asks the owner. No default of DM-02's own applies. | DM-02, DM-13, DM-19 |

## Pending

| ID | Question | Options | Plan of record until answered | Waits | Needed by |
|---|---|---|---|---|---|
| Q1 | Which scratch path on each workstation may the demo use? | A: a path the owner names per host (Recommended). B: `/tmp` (not recommended: often small and cleared). | DM-01 probes `$HOME` and `/tmp` only and leaves the scratch fields "unknown" | DM-01 scratch fields, DM-14, DM-15, DM-19 | 2026-11-13T15:00 |
| Q12 | May the operator, as the owner's login on the demo workstation, create `nemar-runner` under the Q1 scratch path, pull or build the demo image there, run the manual container run and (for F1) the runner, and delete it all afterwards? Nothing installed, no `sudo`. | A: yes, on the demo workstation only (Recommended). B: yes, and also Bun user-local for the stack-on-loopback path. C: no. | F3 on the operator's machine; DM-14 stops after its GitHub steps; DM-15 dropped | DM-14 C-steps, DM-19 steps 2 to 4, DM-15 | 2026-11-14T06:00 |
| Q2 | Only if DM-01 finds no usable runtime on the demo workstation: what then? | A: the owner installs Apptainer unprivileged (user namespaces) for their login (Recommended). B: the owner adds their login to the `docker` group (root-equivalent; single-tenant machine only, recorded in the gated inventory). C: F3. | F3 | DM-10, DM-14, DM-19 | 2026-11-13T20:00 |
| Q4 | Which dataset is on screen? | A: DM-02's choice (Recommended). B: a dataset the owner names that passes DM-02's criteria. | DM-02's choice; the owner may pre-authorize this default | DM-13's network run, DM-19 | 2026-11-13T20:00 |
| Q5 | Order into `dev`: #2116, #2121 P3, this epic? | A: #2116, then P3, then this epic with 0140 (Recommended). B: this epic first; #2116 and P3 then apply lower numbers after a higher one, which the replay rule calls a hazard even though no column collides. | A | S2, S5 | CP-2 (2026-11-16) |
| Q6 | Turn on `COMPUTE_ENABLED` and `COMPUTE_RUNNERS_ENABLED` in production before a Tapis tenant exists? | A: decide after S3a lists everything `COMPUTE_ENABLED` opens with no Tapis secrets (Recommended). B: yes after a 7-day staging soak. C: wait for Tapis. | switches off (the owner's) | S3 | CP-3 |
| Q7 | Which machine runs Zarr conversion jobs after the migration? | A: the current conversion host, registered as a runner with conversion capacity, the other workstation as overflow (Recommended). B: both workstations, and the cron host is retired. | A | Z5, Z6 | CP-3 |
| Q8 | How does the collaborator's reader epic come upstream? | A: ask her to open her PR against a nemar-cli epic branch now, keeping ADR 0120, with the Worker staying a second host of the core (Recommended). B: wait for her schedule. C: the Worker stops hosting the core. | B (nothing in the demo depends on it) | R0 to R5 | CP-2 |
| Q11 | Where do derivatives live durably? | A: their own addressable store keyed by (source dataset version, recipe, recipe version, engine, input profile, index digest), own retention class, optional DOI, never in the serving copy or the dataset repository (Recommended). B: keep only the 30-day results bucket for now. | outputs stay in the results bucket (30 days) and the demo's local stand-in | V1, Q2 | CP-3 |
