# Runbook: the manager's tick for portable compute

Follow this literally, with the `project:manager-loop` skill.
`<skill>` is that skill's directory; `B` is the absolute path of `board.md` in the board worktree (Setup step 3).
The board helper needs Python 3.10 or newer: every helper call here is `uv run --no-project --python 3.12 python -I <skill>/scripts/manager_board.py ...`, written below as `mb`.
Where this runbook and the skill disagree, the skill's "Never" list wins, then this runbook.

## What to read

- Every tick: `mb status B`, and only the events it points to.
- First tick of a session: this runbook, `queue.md`, `checkpoints.md`, `risks.md`, `open-questions.md`, once.
- Never the whole `board-log.md` or large evidence; read a card only to dispatch it.

## Tools

| Need | How |
|---|---|
| Dispatch a card | Agent tool, `run_in_background: true`, model from Parity for the card's tier, prompt = `cards/README.md` + the card verbatim + live facts |
| Message a running worker | SendMessage to its agent id |
| Review | `project:pr-review-toolkit` (Sonnet panel); for a card whose Review line names Opus, one Opus reviewer with that focus |
| Ask the owner | `mb ask`, then AskUserQuestion (at most four questions, one recommended option each) |
| Notify | PushNotification, one per event class per day |
| Wake | ScheduleWakeup: 1200 s while any card is `active` before 2026-11-15T06:00 Pacific; then 1800 s with workers running, 3600 s waiting on people |

## Live facts added to every dispatch

From the board and the world at dispatch time: `$WT`, `$NEMAR_CLI`, `$NEMAR_PROCESS`, `$EEGPREP`; for cards that need a workstation, `$WS_A` and `$WS_B` (the ssh aliases from the owner's answer), `$SCRATCH_A` and `$SCRATCH_B` (Q1), and after DM-01 `$WS_DEMO` and `$RUNNER_ROOT` (a directory named `nemar-runner` under the demo workstation's scratch path); the base head; open PRs touching the card's Scope; DM-01, DM-02, DM-12 (head commit) and DM-14 (reference, digest, path) findings in public-safe form.
Aliases, paths and host facts are never written into the board, a commit, a PR or an issue: keep them in a mode-0600 file in the manager's scratch and add them to the prompt only.

## Setup (once, before the first dispatch; the owner's approval of the plan accepts every value below)

1. `date`.
2. Put the pack on the epic branches (a docs-only commit, approved with the plan):
   `git -C $WT/portable-compute-plan add .context/plans/portable-compute && git -C $WT/portable-compute-plan commit -m "docs: portable compute plan pack"`, then
   `git -C $WT/portable-compute-plan push origin docs/portable-compute-plan` and
   `git -C $WT/portable-compute-plan push origin docs/portable-compute-plan:refs/heads/feature/portable-compute-epic`;
   for nemar-process: `git -C "$NEMAR_PROCESS" fetch origin && git -C "$NEMAR_PROCESS" push origin origin/feature/issue-1-epic-process:refs/heads/feature/runner-epic`.
3. Board worktree: `git -C "$NEMAR_CLI" worktree add $WT/nemar-cli-pc-board -b docs/portable-compute-board origin/feature/portable-compute-epic`; the board and its log live there at `.context/plans/portable-compute/`, are committed there every tick, and are pushed to `docs/portable-compute-board` only at checkpoints with `[skip ci]`; they never go to the epic branch.
4. `mb init B --title "Portable compute" --plan .context/plans/portable-compute/plan.md --repo nemarOrg/nemar-cli --branch feature/portable-compute-epic`.
5. Hand-edit Parity, Slots and Budget to exactly these rows, then `mb check B`:
   Parity: `worker` Sonnet high; `worker-hard` Sonnet xhigh; `lead` Opus xhigh; `frontier` Fable; `reviewer` Sonnet high (Codex and Copilot columns as the template has them).
   Slots: `claude-sonnet` (Claude; worker, worker-hard; Max 3; Can network); `claude-opus` (Claude; lead; Max 1; Can network); `operator` (Claude; worker; Max 1; Can network, ssh:ws-a, ssh:ws-b); `codex` (Codex; Max 0).
   Budget: `Agents today` limit 100 (owner, 2026-11-13, raised from 60 for the 48-hour sprint), resets daily; `Advisor consults` limit 5, never resets (one is CP-F's frontier consult); no wave row (this plan uses slots, not waves).
6. Seed the Steps and Questions as `queue.md` says ("Board seeding").
7. Open one epic issue per repository with `gh issue create` (nemar-cli: "Portable compute: workstation runners"; nemar-process: "Runner, launcher runtimes and the Zarr recipe"), each with the card IDs as a task list; `mb decide` the numbers.
8. `mb card` on every file in `cards/` (README.md is skipped); every card must pass.
9. Ask Q1, Q4 and Q12 now (AskUserQuestion), recorded first with `mb ask`.

## The tick

1. `date`; `mb tick B --manager <id>` (first tick of a session: `--state running --next 20m`).
2. First tick of a session: reconcile every `active` or `review` step with its PR and worktree.
3. `mb status B`.
4. Collect events: reports, `gh pr checks <n>`, reviews, owner answers, the times below.
5. Handle them with the handlers below, in the skill's order.
6. Fill free slots from the dispatch plan; a card needing `ssh:ws-a` or `ssh:ws-b` goes only to `operator`, and only after its Depends line's owner answers are recorded.
7. Contribute (the skill's closed checklist). 8. Ask if needed.
9. `mb log`, commit the board in the board worktree (`docs: board, <what>`), `mb tick B --next <cadence>`, ScheduleWakeup.

## Event handlers

**A report arrives.** Verify by observation (head and base, diff inside Scope, the card's Acceptance commands run by you in its worktree, a revert check per fix, deviations triaged); start the review while CI runs; "not run, would check: full suite" is expected.
For DM-12 (sccn/eegprep) "done" is: gates verified, PR open; its merge is the owner's.

**DM-01 reports.** Record the verdicts and the demo-workstation line (as "A" or "B") with `mb decide`.
Verdict `docker` or `podman` for the demo workstation: set DM-10 `todo` and add DM-10 to the Depends of DM-15 and DM-18 (`mb set B Steps DM-15 Depends=...`). Otherwise set DM-10 `dropped` with Next "becomes C1".
Demo workstation `none`: ask Q2.

**DM-02 reports.** Ask Q4 with DM-02's choice as the recommended option.

**DM-13 merges into `feature/runner-epic`.** Notify the owner once: "DM-13 merged; please merge nemar-process PR #17 and then `feature/runner-epic` into `main` so CI signs the demo image (Q3, decided A)." Set DM-14 `todo`.

**2026-11-14T08:00.** If DM-14 has no verified path A digest, log "DM-14 path B" and tell DM-14's worker (or redispatch) to run path B.

**2026-11-14T12:00.** If no container has run on the demo workstation (DM-14 C3 not `ok`), or Q12 is not answered yes, log "F3" and redispatch DM-19 in F3 mode.

**CP-GO (2026-11-14T18:00).** Log the pre-registered reading: if G5 already passed, "F1 available"; otherwise "F2 is the plan of record; the chain continues toward an F1 recording until 2026-11-15T05:00". This is not a judgment.

**2026-11-15T03:00.** If DM-18 is not green, set DM-15 `dropped` (Next: "no F1"). At 05:00 nothing new is dispatched.

**A review returns.** Every finding gets an outcome; security, credential, concurrency, accounting and isolation findings go to the Opus advisor before a fix; at most two rounds.

**A check fails.** Caused by the diff: two fix rounds, then the advisor with the log. Not caused by the diff: one `gh run rerun <id> --failed`, then file an issue and continue.

**A gate fails on an epic branch.** Stop merging into it; advisor.

**A timebox expires.** At the timebox nudge once; at twice the timebox, advisor.

**A worker goes silent.** Implementer 45 minutes without a commit or message, reviewer 20: nudge once, then redispatch with an inventory.

**An owner answer arrives.** Act, `mb decide <text> --by owner`, close the question; if it contradicts a card, ask the lead to correct the card first.

**A question passes its "needed by" time unanswered.** Notify once with what waits; apply a default only if the owner pre-authorized that question's default in `open-questions.md`, and log that it was applied.

**A checkpoint is due.** Do the row in `checkpoints.md`; never complete an outline card yourself.

## Never (the skill's list, plus)

- Never touch `nm000103`-`nm000107`, staging, production, a switch, a secret, a deploy or `wrangler-sccn.toml`.
- Never ssh to a workstation yourself; only the operator slot does, from a card, within the owner's permissions (read-only until Q12 is yes; no installs without a separate owner answer).
- Never let any card list, open, lock or write the Zarr converter's lock, ledger or scratch directories.
- Never write an alias, host name, user, path or address into the repository, the board, a PR or an issue.
- Never merge into `dev`, `main`, `sccn/eegprep` or `nemarOrg/docs`, and never trigger an image publish.
- Never present a recorded or manual result as live.
