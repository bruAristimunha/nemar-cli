# Risks (pre-registered)

Each risk names the observation, the date it is read, what happens if it reads bad, and who decides.
A read date is the day on which nobody may keep hoping, not a deadline for the work.

| ID | Risk | Observation | Read on | If it reads bad | Decides |
|---|---|---|---|---|---|
| K1 | The 48 hours | the control-plane chain is about 34 hours; DM-05 merged by Sat 04:00, DM-06 by Sat 12:00, DM-07 by Sat 22:00, DM-18 green by Sun 03:00 (Pacific) | CP-1, CP-GO, Sun 03:00 | already priced in: F2 is the plan of record; a later slip only drops F1 | the plan (pre-registered) |
| K2 | Workstation access | the aliases work (confirmed by the owner) and DM-01 completes | Fri 18:00 | F2-b and F2-c only, plus F3 on the operator's machine | owner |
| K3 | Container runtime | DM-01's verdict for the demo workstation | Fri 18:00 | `docker` or `podman`: DM-10 joins the path; `none`: Q2 | owner (Q2) |
| K4 | Private data reaching a runner | any runner job on a non-public dataset | every claim (the claim re-checks public eligibility in its statement) | stop runner dispatch; incident note in the gated runbook | owner; decided: public only (Q9) |
| K5 | Accounting integrity | runner jobs add zero ledger rows, settle with `charged_milli = 0`, do not reduce the Tapis tenant room; the Tapis insert and hold statements unchanged; no Tapis tick touches a runner row | DM-06 and DM-07 reviews, S2 | block the merge; advisor before any fix | lead, then owner |
| K6 | Conversion outage during the Zarr migration | conversions per day and backlog against the 14 days before Z5; `zarr-ready` callbacks per day | weekly from Z5 to 14 days after Z6 | pause cutover; the cron keeps converting; nemar-cli's converter is deleted only after 7 clean days | owner |
| K7 | Coordination with the collaborator's reader epic | her upstream PR opened, ADR 0120 kept, conflicts in `backend/src/mcp/*` and `shared/zarr/*` | CP-2, then weekly | phase R waits; the demo does not depend on her code | owner (Q8) |
| K8 | Migration order with #2116 (0131-0134) and #2121 P3 (0136) | which reaches `dev` first | CP-2 | none of this program's columns is P3's (`runner_claimed_at`, not `admitted_at`), so either order applies; the replay-order rule still asks Q5 | owner (Q5) |
| K9 | The signed image is late | the owner's merge of PR #17 and `feature/runner-epic` to `main`, and a signed digest verified by DM-14 path A | 2026-11-14T08:00 | path B, labeled unsigned; at 12:00 without a container, F3 | the plan (pre-registered); owner decided A |
| K10 | Serving copy refuses or throttles the readers | DM-02's probe and DM-12's network tests get 200 and 206 | DM-02, DM-12 | a User-Agent change in eegprep-lean before DM-13 | lead |
| K11 | Demo dataset too slow | DM-13's network run: wall time over all EEG stores | DM-13, CP-1 | above 30 minutes: DM-02's runner-up | lead |
| K12 | Host details leak into a public repository | the leak check of `cards/README.md` on every prose file; reviews | every PR | revert in the same PR; if pushed, the owner decides on history rewriting | owner |
| K13 | The image pins an unmerged eegprep-lean commit | DM-12's PR state | CP-2 | keep the branch until the owner merges and releases; then move the pin | owner |
| K14 | Usage under Docker or Podman is partial | `usage_partial` on the job | S6 | reports mark such rows partial | lead |
| K15 | The local stack is mistaken for a deployment | the banner and DM-16's labels | DM-16 review | correct the brief before 2026-11-15T04:00 | lead |
| K16 | One workstation also runs the production Zarr conversion cron (ADR 0101 slots, a shared RAM and scratch admission ledger, a lock) | DM-01's "conversion cron" and "scratch on the converter's filesystem" fields | Fri 18:00 | the demo runs on the other machine; if only the conversion host can, it runs with one slot, scratch at most 50 GB and 10 percent of free space on a different filesystem, memory at most a quarter of RAM; on the same filesystem: no runner there (F2 on the other machine or F3); no card ever lists, opens, locks or writes the converter's directories | the plan (pre-registered); owner informed |
| K17 | Merging epic C (PR #17) to `main` for the image also ships the launcher, observer and Tapis definitions to `main` | the epic's own CI and review state at the owner's merge | Sat 08:00 | the owner may merge only after #17's gates are green; otherwise path B | owner |
