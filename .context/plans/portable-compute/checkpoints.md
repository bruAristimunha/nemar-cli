# Checkpoints

The lead reads only what a row lists, completes the outline cards that are due, updates `risks.md`, and produces one docs PR (into `feature/portable-compute-epic`) with a note of at most one page.
The manager runs the anticipation pass at each checkpoint (how will the owner, reviewers and users react, and what will they ask next).

| ID | When | Who | Reads | Produces |
|---|---|---|---|---|
| CP-0 pack review | done 2026-11-13 (three reviews) | executability (Sonnet), design (Opus), long-horizon advisor (Fable) | the pack | `dispositions.md`; `mb card` passes on every card |
| CP-R (per card) | when DM-03, DM-05, DM-06, DM-07, DM-10, DM-11 reach review | one Opus reviewer | the PR, the card's Review line, the plan decisions it names | findings with severities; security, concurrency, credential, accounting and isolation findings go to the advisor before a fix |
| CP-1 | 2026-11-13T22:00 Pacific | lead | board, DM-01, DM-02, DM-04 reports, DM-05's state | DM-10 dispatched or dropped (per the handler); the dataset kept or switched to DM-02's runner-up (risk K11); slips named against the cut line |
| CP-GO | 2026-11-14T18:00 Pacific | manager (mechanical), lead note | DM-15 or the board | the runbook's pre-registered reading |
| CP-F frontier | after DM-16, before 2026-11-15T05:00 Pacific | advisor at the frontier tier (Fable), one consult | plan sections 2 and 4, DM-16 and DM-19 (and DM-15) reports, ADRs 0118, 0121, 0122, 0029, 0033, 0101, 0049, the collaborator's reader epic summary, `open-questions.md` | the escalation format's verdict on: sequencing of S, Z and R; the Zarr promote mechanism at scale (D10); the no-outage migration; the accounting class model; derivative persistence (Q11); at most three owner questions |
| CP-2 | 2026-11-16 (Monday) | lead | CP-F verdict, answers to Q5, Q8, Q11 | full cards for S1, S2, S3a, S4, S6, C1 (if dropped), C2, Q0, R0, W1, W2, Z0, Z1; the demo runner registration revoked and the local stack's state deleted; `$RUNNER_ROOT` removed on the demo workstation (with the owner's yes); a note on #2121 that P3 must select `executor = 'tapis'` and keep `admitted_at` to itself |
| CP-3 | when S2 is done | lead | S2 and S3a evidence, answers to Q6, Q7 | full cards for S3, S5, V1, Q1, Q2, Z2, Z3, Z4, Z5, R1, R3, H1; ADR 0123 and 0124 drafts reviewed |
| CP-4 | when Z5 is done (20 of 20 identical, the largest included) | lead, then the owner | Z5 report, conversion backlog (risk K6) | full cards for Z6, R2, R4, R5, H2; the cutover schedule for the owner |

## Frontier trigger (plan section 0)

The frontier tier is also used when the lead tier cannot decide a contested architecture finding after one Opus advisor consult, or when one card loops through three failed approaches; each use spends one `Advisor consults` unit and is recorded with `mb decide`.
