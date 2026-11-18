# ADR 0118: The compute gateway records every tenant job and keeps the ledger in Expanse service units

**Status:** accepted
**Date:** 2026-11-03
**Owner:** Seyed Yahya Shirazi

Epic #2005, issue #2006.
This Architecture Decision Record (ADR) refines stage 3 of [ADR 0049](0049-compute-runs-in-the-browser-osa-owns-the-runtime-only-hpc-is-gated.md) and keeps [ADR 0040](0040-approval-is-the-single-writer-of-upload-access.md) and [ADR 0042](0042-upload-access-is-requested-once-by-the-person-who-wants-it.md) intact: compute access is its own grant, never `service_access`, and approval is a person's decision.

## Context

ADR 0049 left stage 3, high-performance computing (HPC) submission, as "a NEMAR gateway" without saying who runs a job, who holds its record or how time is counted.
NEMAR now runs jobs on the San Diego Supercomputer Center's (SDSC) Expanse through a Tapis tenant, from three front doors (the command-line interface (CLI), the website, a partner site) and for its own pipelines.
Tapis has no allocations and no idempotency key, signs no webhook, lets a job's owner edit its tags, and a partner site can mint a Tapis token for any username, so the Tapis record alone cannot say who ran what or what it cost.

## Decision

1. **A community account runs every job**, so people need no account of their own in the National Science Foundation's Advanced Cyberinfrastructure Coordination Ecosystem: Services & Support (ACCESS) program, or on Expanse.
2. **NEMAR is the record of every tenant job, whichever front door submitted it**: who ran it, exactly what was submitted, what it cost, what happened and the logs.
3. **The ledger is append-only integer thousandths of an Expanse service unit (SU)**, never floating point.
   One SU is one core-hour with up to 2 GB per core, or one graphics processing unit (GPU) hour.
   A hold precedes every submit, as one conditional insert that checks the person's pool and the platform budget; a refused hold writes nothing.
4. **A charge settles twice.**
   Provisionally from the Tapis record when the job ends, then finally from Expanse's own accounting, as an adjustment; a difference within the owner's policy tolerance is routine and a larger one is reported.
   A failure NEMAR caused is refunded; a user-caused one, including a result upload refused for size or quota, is not.
   **[Superseded for the refund by the A5 amendment of 2026-11-04 (#2010), item 1: no failure is refunded automatically, whoever caused it. The attribution stays as a flag. The rest of this decision stands.]**
   For a launcher failure, who caused it is decided by its code and its fixed-word detail together (decision 13).
5. **An unreserved partner job is cancelled and charged to the partner's pool, never to a person**, because a Tapis `owner` is not proof of who ran a job.
6. **Webhooks are hints.**
   NEMAR reads the job back from Tapis before it acts, polls as a backstop, and tags every job `nemar_job:<id>` so a retried submit finds the job instead of submitting twice.
7. **Retention is a policy row, not a constant**: records 7 years, logs 1 year, results 30 days and never fewer than 14.
   Storage is two private Cloudflare R2 buckets, records (locked by prefix) and results (expiring), outside the Amazon Web Services (AWS) account that holds the Open Data buckets.
   Only the Worker reaches them, through bindings, and no storage credential reaches Tapis, a node or the launcher: uploads go to addresses the Worker signs for one file of one job.
8. **`COMPUTE_ENABLED` is a dark switch**: exactly `1` and absent from the wrangler configuration. The switch and the test that pins it landed in phase A4 (issue #2009); every compute cron runs in production only.
9. **NEMAR reports ACCESS gateway attributes for every tenant job**, once, under a per-account pseudonym that is not the sign-in subject.
10. **Every compute word is declared once**, in one of these modules:
   `shared/compute-state.ts` (states, failure, refusal, ledger and cancel words);
   `shared/contract/compute.ts` (the job specification, partition and rate tables, owner policy and launcher file shapes);
   `shared/contract/compute-launch.ts` (the launch specification and the launcher's routes, with their JSON Schema, which `nemarOrg/nemar-process` copies byte for byte);
   `shared/contract/compute-admin.ts` (the allocation, reporting, status and pipeline routes' error words, request shapes and open response schemas; a module of words and of open schemas only, never of a strict one);
   `shared/compute-header.ts` (the inline job header a script states its resources in, read by the CLI and the Worker alike);
   `shared/compute-recipes.ts` (the pipeline recipe registry, the stamp states and the recipe's argument words);
   `shared/contract/compute-observation.ts` (the observer's document, with its JSON Schema shared byte for byte with `nemarOrg/nemar-process`);
   `shared/contract/compute-responses.ts` (the open response schemas of a person's cancel and links and of the observer's answer).
11. **Two digests, named apart.** `spec_digest` is the job row's: the SHA-256 of the exact bytes of `records/<id>/spec.json`. `launch_spec_digest` is the launcher's: the SHA-256 of the exact raw bytes of the `NEMAR_LAUNCH_SPEC` value, which is ASCII-only JSON, hashed before parsing.
12. **Responses are open, requests and documents are closed.** The two responses a launcher reads ignore unknown keys, so one that runs for 48 hours survives the Worker adding a key; the job specification, owner policy, launch specification and the launcher's own files refuse them.
13. **Launcher details are declared and classified, in `shared/compute-state.ts`.**
   `LAUNCHER_DETAILS` maps each of the seven launcher codes to the fixed-word details it may carry, and `PLATFORM_LAUNCHER_DETAILS` is the subset that is a NEMAR, node, runtime or contract fault.
   The rule: a detail is the platform's if and only if a submitter cannot cause it with a valid specification and bundle, and a dataset that was eligible when the job was submitted.
   That rests on an eligibility gate at submit, and today the gate runs on the pipeline path only: `resolveRun` in `compute-pipeline.ts` refuses with `dataset_not_eligible` a dataset that is not eligible (ADR 0065 and the pipeline predicate), `version_not_found` or `version_untagged` for a version that is not published or has no data-plane tag, and `too_many_files` for a manifest over 38,000 entries (`PIPELINE_MANIFEST_MAX_ENTRIES`).
   `createJob` does not apply it: it leaves the check to its caller, and no person-facing submit route exists until Epic D3 (#2024).
   So the classification is a REQUIREMENT on that route, which must call the same eligibility check before it creates a job (the hand-off is on #2024), and until it does, `dataset_not_found` and the manifest-too-large case are declared as the platform's only because the one submitter that is reachable, NEMAR's own pipeline, passes the gate; a person's job cannot reach them yet.
   `isPlatformFailure(code, detail)` follows it: a platform detail is refunded even under `runtime_error` **["refunded" superseded by the A5 amendment of 2026-11-04 (#2010), item 1: it is attributed to the platform, flagged, and not refunded]**, a submitter detail is charged even under `code_fetch_failed` or `dataset_fetch_failed`, and a missing or undeclared detail leaves the code alone to decide, as before.
   The result refusal details stay as they were.
   [The platform failure CODES, which `isPlatformFailure` also reads, are now twelve: `tapis_record_lost` is the twelfth (a live job whose Tapis record is gone; "Review fixes of 2026-11-06", item 10). It settles by the row's evidence of use, and a charged lost job is flagged `mismatch`.]
   The Worker's own cancel record overrules the launcher's `terminated` detail, because the launcher cannot tell a cancel by the person from a Slurm preemption.
   The default for an undeclared `runtime_error` detail is deliberate: it is charged, which is the unfavourable direction for a fault NEMAR caused.
   So a launcher change that adds a detail word lands with its entry here, in both repositories, in the same pair of pull requests, and the launcher's drift test compares its `LAUNCHER_DETAILS` with this list for each code at a pinned commit.
14. **The launch specification carries the data-plane tag and a digest-named Singularity image file (SIF).**
   `datasets[].version` is the data-plane tag, `latest` or `v<major>.<minor>.<patch>`, which the Worker makes from a job's version with `dataTagForVersion` (`1.0.2` becomes `v1.0.2`) at most 64 characters, the limit of the provenance `staging[].version` the launcher writes; the job specification keeps accepting what it accepted, so the dataset version tag is the one launch rule `JobSpecSchema` does not enforce, and the Worker and the CLI run `launchSpecFits` before the hold and refuse a job whose version has none with `invalid_spec`, naming the field `datasetVersionWithoutTag` finds.
   `image.sif` is exactly `<the 64 hex digits of image.digest>.sif`, a basename relative to `NEMAR_SIF_ROOT`, which is required: the launcher has no fallback and ends `image_missing` when it is unset.
   `image.uri` ends with `@sha256:<the hex of image.digest>`, because the digest names the file that runs.
   The JSON Schema cannot compare two fields, so these two rules are zod's and the encoder refuses a document that breaks either; the schema says so, and the differential tests list every rule only zod enforces.
   The launcher does not verify the SIF's content hash: the name is all that ties the file to the digest.
15. **The include glob dialect and the entry semantics are part of the contract.**
   An include pattern is matched against manifest paths relative to the dataset root: `**/` matches zero or more directories (so `a/**/b` matches `a/b`); `**` elsewhere matches any run of characters including `/`; `*` and `?` stay inside one path segment; `[abc]`, `[a-c]` and `[!abc]` are classes; a character class never matches `/`, so like `*` and `?` it stays inside one path segment, and a negated class `[!a]` matches any single character except `a` and `/`; an unterminated `[` is a literal `[`; an empty class `[]` and an inverted range such as `[z-a]` are refused, and `bad_include` is exactly the set of patterns this dialect refuses; matching is case-sensitive; there are no escapes; and a matcher must run in time linear in the pattern length times the path length, with no backtracking and no cap on wildcards.
   `includePatternProblem` is that refusal as a pure function, and `JobSpecSchema` applies it, so such a pattern is refused at submit with `invalid_spec`, naming `datasets.<i>.include.<j>`, and is never charged.
   A python job with an entry runs `python /code/<entry>` followed by `args`; a command runs as given with `args` appended; an image job with an entry runs `/code/<entry>` directly, which needs the executable bit the bundle packer must preserve; the runtime image must provide `python` on its PATH for the python runtime.
   A bundle archive's member names may carry a leading `./`; absolute names, `..`, links, devices and named pipes (first in, first out, or FIFOs) are refused by the launcher.

## Consequences

- Later phases import these modules instead of declaring their own words, numbers or states, and a test fails when one is added or dropped.
- NEMAR carries a ledger, a record store and retention duties it did not have; the periods are owner policy, so counsel's answer changes a row, not a deploy.
- The rate table (2 GB per core, 92 GB per GPU, preempt at 0.8 with the 1 SU minimum applied after that factor) and the `debug` ceilings are unconfirmed with SDSC and stay marked so until the first charge is compared with Expanse.
- Access, approval and the partner contract are not decided here; they follow ADR 0040 and ADR 0042 in Epics B and D.

## Alternatives considered

- **Per-person Expanse accounts.** Cannot be asked of this audience, and ACCESS does not need them for a community account.
- **The Tapis record as the system of record.** It has no allocation and no stable owner, and a partner can write both owner and tags.
- **Fractional SU in floating point.** A ledger that cannot be summed exactly cannot be reconciled with Expanse's.

## Amendment 2026-11-04 (#2007): the allocation ledger and the owner policy are built (phase A2)

Migration `0114_compute_ledger.sql`, `backend/src/services/compute-ledger.ts`, `compute-policy.ts`, `backend/src/routes/admin/compute.ts` and `nemar admin compute policy|pool` build decision 3 and the policy of decision 7.
What the build settled, each a rule and not a description of today:

1. **The ledger is the only writer of a pool's totals, and the writer is a trigger.**
   `compute_ledger_apply` (AFTER INSERT) adds an entry's granted, held and charged deltas to its pool's row, and its held and charged deltas to the row of its budget pool.
   "Totals change only if the entry was written" holds by construction, because there is no second statement to forget.
   No code path updates a total, and a test reads every source file and every migration for one (quoted, schema-qualified, bracketed and conflict-clause spellings of a write included, each proven by a planted string).
   D1 runs the trigger; if it ever stopped, the design stops with it, and the fallback is not application-side updates.
2. **The table refuses what the statement refuses, under every conflict clause.**
   A conflict clause on the OUTER statement (`INSERT OR IGNORE`, `OR FAIL`, `OR REPLACE`) overrides the clause that applies inside a trigger, so an entry whose totals the pool's CHECKs refused would stay in the ledger while the totals did not move.
   Three BEFORE INSERT triggers raise ABORT, which no conflict clause overrides (the two budget triggers of item 5 are the other two of the five that the build added): no total of the pool, or of the budget it names, leaves 0 to 2^53 - 1 (`compute_ledger_totals_in_range`); a hold does not take the pool's or the budget's available below 0 (`compute_ledger_hold_fits`); a release or a charge names a hold of the same job, pool, budget and held amount (`compute_ledger_closes_its_hold`).
   The service's statements say the same as WHERE terms, so a refusal there writes nothing and raises nothing.
3. **A hold is one conditional INSERT.**
   Its WHERE checks the pool not frozen, the pool's available, the budget pool's available, the key unused and any guard the caller adds, so two holds for the last SU cannot both be written and a refused hold writes nothing.
   Freezing applies to the holder's own pool; a frozen budget pool does not refuse a hold.
   A closing entry is one INSERT taken from the hold row: the HELD side of a charge and the whole of a release are the hold's own amount, so a caller cannot misstate them; the CHARGED figure of a settlement is the caller's, capped at the hold, and what the job used above the hold is an `overrun` entry written by the same statement.
   A job has one hold, and a hold is closed once.
4. **Available may be negative; a stored total may not.**
   An `overrun`, or an adjustment of the grant below what is used, makes available negative and refuses new holds until a grant brings it back.
   Every amount is a whole number of milli-SU up to 2^53 - 1, checked before a statement is built and again by `typeof` and range CHECKs; a grant or a positive adjustment that would take a total past it is `would_exceed_limit`, and one request moves at most 2^40 milli-SU.
5. **The table enforces the budget rule where both of the owner's options agree, and leaves the rest to code.**
   Two BEFORE INSERT triggers, and only these.
   `compute_ledger_budget_is_people`: a budget an entry names is the platform `people` pool of the same cpu or gpu word as its pool, and an entry on a platform pool names none; this holds for every kind, a refund and a correction of a charge included, whenever one is named.
   `compute_ledger_budget_required`: a hold, a release, a charge, an overrun and a job's final-settlement adjustment on an account or partner pool MUST name that budget, because the budget records what people consumed and each of these moves it under either option below.
   NEMAR's own pipelines are their own pool, `pipelines`, and count against nothing else.
   A refund, and an adjustment of a charge that names no job, may name the `people` budget or none, and the table does not choose: whether they credit the budget back is the repository owner's open decision, and a code choice, not a schema rule. **[Decided on 2026-11-04: the owner chose option A, see the end of this item.]**
   Option A: the `people` budget records consumption only (holds, settlements and overruns), and a refund or a correction moves the person's pool alone.
   Option B: a refund and a correction also credit the budget back, so the budget and the people never disagree.
   Today's code is option B, with an interim rule that is easy to loosen (correcting an account's charge is the owner's; an administrator corrects a grant): an adjustment of the charge of an account's pool moves the `people` budget with it, and a refund of a job takes its whole charge back from the budget as well. **[Superseded by the owner decision of 2026-11-04: the code is option A now, see the end of this item.]**
   If the owner chooses option A, the code changes (the refund and the adjustment name no budget) and the migration does not.
   **The owner decision of 2026-11-04 is option A, and the code implements it: the `people` budget records consumption only, so `refundJob` and its statement are deleted (nothing is refunded automatically), a correction that lowers the charge of an account's or a partner's pool names no budget (`adjustPool` refuses one that does) while one that raises it names the budget, and a job's final settlement is the one entry that names the budget and lowers it, because it corrects a figure that was recorded as consumption.**
6. **A key is never shared, and is compared on everything.**
   The keys the Worker writes are made of the job (`job:<id>:hold`, `:final`, `:refund` **[`:refund` retired by the owner decision of 2026-11-04: no refund is written]**) or the hold (`hold:<id>:charge`), so no caller picks one, and a caller's key may not start with `job:` or `hold:`; an administrator's `Idempotency-Key` is stored behind the kind and the actor (`grant:<actor>:<key>`), so two administrators sending the same key each make their own entry.
   A key that finds its entry is a replay only if the request is the same on every field (kind, pool, budget, amounts, job and reason); anything else is a conflict, never a replay.
   A closing step replayed returns its closing entry with `replayed: true` when it is of the requested kind, and `hold_closed` says which kind closed the hold otherwise.
   A hold replayed returns its entry with `replayed: true` only while the hold is open; the same hold asked for again after it was released or settled is `hold_closed` too (with the step that closed it), because a replay would tell the caller a hold is live that its pool no longer holds.
7. **A job's final settlement happens once, even when it changes nothing, and never after a refund.**
   It is an `adjust` entry that carries the job and a charged delta that may be 0 (the only adjustment that may be), whose key `job:<id>:final` records that it happened; a job's charge is the sum of `charged_delta_milli` by `job_id` over its charge, overrun, refund and that adjustment.
   A refund ends a job's charge: a final settlement after one is refused (`refunded`), because it would charge the job again. **[The owner decision of 2026-11-04 removed the refund path: no code writes a refund, and the refusal stays for an entry of that kind, which the table's vocabulary keeps.]**
8. **The policy write is owner-only in the statement, validated strictly, and audited in the same batch; the read fails closed.**
   `putPolicy` inserts a version only for an account that is an owner, not deleted and in an active status, in that statement, checks the strict schema, and writes the audit row with it.
   `getPolicy` parses a stored row with the same strict schema and answers 503 for one it cannot parse; the default applies only when there is no row.
   A new policy key is therefore added as optional.
   The CLI reads the route's answer with an open schema (`shared/contract/compute-admin.ts`) and checks only what `policy set` sends with the strict one.
9. **What the database cannot prevent, and what guards it instead.**
   `INSERT OR REPLACE` and `REPLACE INTO` rewrite a conflicting row without firing the append-only DELETE trigger, because recursive triggers cannot be enabled on D1, so only the source scan guards against them.
   `DROP TABLE` removes the append-only triggers with the table, and a rebuild of `compute_ledger` must copy its rows before it creates `compute_ledger_apply`, or every total doubles.
**Retention is not decided here.**
The ledger and the policy are append-only and are never removed by a cascade from the account row.
Their retention, and the anonymisation of `holder_ref` and `actor_user_id`, are the job of phase A7 (#2012), which adds its own narrowly scoped exception in its own migration.

## Amendment 2026-11-04 (#2008): the job index and the two buckets are built (phase A3)

Migration `0115_compute_jobs.sql`, `backend/src/services/compute-jobs.ts`, `compute-records.ts` and `compute-s3.ts` build decisions 2, 7 and 9.
What the build settled, each a rule and not a description of today:

1. **A job and its hold are one batch, and the job is gated on the hold.**
   The batch is the ledger's hold statement (the person's live-job limit is a guard read inside that statement, so two requests racing for the last slot cannot both win), then the pseudonym's `INSERT OR IGNORE`, then the job's INSERT, each of the last two written only if the hold row of this job exists.
   A refused hold therefore leaves no job row, no ledger entry, no pseudonym and no object in either bucket, and the reason is read after the refusal and never decided by a second hold.
   A job id has one hold for ever, so a resubmission is a new job; a retried `(account, idempotency key)` returns the existing job, and the same key for another request is an error and never an answer with the first job.
2. **Records are written after the commit, never before, and once.**
   A bucket lock makes a record for a refused job permanent, so nothing is copied into `records/` before the job's row, which exists only if its hold does, has been read back; a bundle waits in `incoming/`, which a lifecycle rule empties.
   Every record write is create-only, and a record that exists is never rewritten.
   `records_written_at` says the job's records have landed, and phase A5 refuses to submit without it: `createJob` sets it for a job that uploads nothing, and `finalizeBundle` or `finalizeSubmittedFiles` (a partner batch job's own files) sets it after the copy.
   A failed write leaves the job and its hold, is logged by job id and a fixed word, and is finished by a replay of the same key.
3. **D1 job rows carry the account id and fixed words only; identity is in the records bucket only.**
   There is no column for a name, an email, a country, an ORCID iD, an affiliation or a subject, and a test refuses one.
   `identity.json` holds exactly the ORCID iD, name, email, country, affiliation, account id, a null subject and the capture time.
   The words that a later epic may add (a failure code, a detail, a cancel reason, a partition) are checked by shape, never by a list, so adding one never rebuilds the table.
4. **The gateway pseudonym is random and stored.**
   `gw_` and 20 lowercase base32 characters, made on an account's first job, stored in `compute_gateway_users`, copied to every job of that account, never rotated and never reused (triggers refuse a change and a removal until a later phase's narrowly scoped exception, and a third trigger ignores an insert whose account or pseudonym is already stored, because `INSERT OR REPLACE` deletes the conflicting row without firing the delete trigger, recursive triggers being off on D1).
   It is not derived from a key, because a derived value would change if the key were rotated; the issue's earlier wording, a derivation from `ENCRYPTION_KEY`, is superseded.
   NEMAR's own pipeline jobs carry the literal `nemar-pipelines`, which is not stored there.
5. **`spec_digest` is the SHA-256 of the exact bytes of `records/<id>/spec.json`,** made once before the INSERT and written after the commit, and it is never the launch specification, which carries a token; the launcher's `launch_spec_digest` is a different column, added by phase A5.
6. **Reading identity or a submitted file is owner-only, reasoned and audited first.**
   The role is read from the database in the audit statement itself, the reason is 8 to 200 characters, the `compute.record.read` row is written before any byte is read, and the read is refused when that write fails.
   A read that then finds nothing still leaves its row, because the attempt is what is audited.
7. **Compute storage is reached by the binding, and by the S3 interface only for what a binding cannot do.**
   A binding has no copy and no presigned address, so a presigned PUT (one hour), a presigned GET (10 minutes for the launcher's own bundle, 5 minutes for an owner's read) and the server-side `CopyObject` are signed with aws4fetch against the account endpoint, path style.
   The endpoint is `globalThis.NEMAR_COMPUTE_S3_URL` when set and otherwise the Worker secret; `S3_ENDPOINT_URL` is never read for compute; an expiry above seven days is refused.
   A key is encoded segment by segment and judged by the contract's own path predicate, never by `assertValidS3Key`, which refuses `a..b.csv` and throws on `100%.txt` and so would fail an upload with a code that refunds the job.
8. **The checksum header is signed for an incoming PUT and is not trusted.**
   `x-amz-checksum-sha256` is signed with the URL when a digest is given; whether R2 enforces it on a presigned PUT has not been checked against the real service, so the size read back through the binding is the bound `finalizeBundle` relies on.
   On an output PUT the header is deferred to epic A, to be decided once it has been verified on R2.
9. **The outputs request's body cap is derived from the owner's `maxFiles`.**
   The policy lets `maxFiles` reach 100,000 and the launcher caps its own request at 1 MiB, so the Worker neither bounds `maxFiles` nor reads less than 1 MiB: it reads at most `8 KiB + maxFiles x 1,700 bytes`, never above 64 MiB.
   The launcher's 1 MiB is the tighter bound today, and raising it is the launcher's change.
10. **A partner's per-file upload is at most 500 files,** whatever the owner's bundle limit (the cap shadows `bundleLimits.maxFiles` with the same refusal word, so the partner contract and the design's section 6 must say 500), because each file is one `CopyObject` and a Worker invocation may make at most 1,000 subrequests; the sizes of the uploaded files are read from one listing before any file is copied, so a file of the wrong size refuses the whole set and copies nothing.
11. **A partner's job is its hold body, kept byte for byte.**
    A partner's request is not a job specification, so `createJob` takes its hold body as the exact text that was sent, reads only the nine small fields a hold needs (a strict schema; the partition tables and the owner's ceilings are the ones every job meets), and skips the specification schema, `launchSpecFits` and the bundle checks.
    `spec_digest` is the SHA-256 of those exact bytes, computed once before the INSERT, and the same text is written as `records/<id>/spec.json` after the commit, so the same fields with other whitespace are another request.
12. **An idempotency key needs an account.**
    The unique index treats NULL accounts as distinct, so a key on a job with no account could be stored and never found, and two calls would take two holds; `createJob` refuses it as a programming error.
    A partner's replay is keyed by the partner contract's own table (#2024, #2025).
13. **A name is judged by the path rule, and a key by the key rules, and both are asked before anything is signed.**
    A submitted file's path is at most 512 characters and holds no traversal in any percent-encoding, however many stray `%` stand beside it; a path that becomes a key of the job (a partner's own files, and an owner's read of one) is also well-formed text and builds an `incoming/` and a `records/` key of at most 1,024 bytes each.
    A manifest path inside an archive builds no key and keeps the 512-character rule.
14. **One copy is at most 5 GiB, whatever the owner's limits say.**
    The contract's bundle limits are not bounded above, and R2 copies (and one presigned PUT takes) at most 5 GiB, so a job, an upload address and a finalize refuse a larger archive or file as `bundle_too_large`.

## Amendment 2026-11-04 (#2010): the job lifecycle is built, and no failure is refunded (phase A5)

Migration `0116_compute_lifecycle.sql`, `backend/src/services/compute-lifecycle.ts`, `compute-verify.ts`, `compute-outputs.ts`, `compute-results.ts`, `compute-advance.ts`, `compute-tokens.ts`, the webhook route `routes/callbacks/tapis.ts`, the launcher's callbacks `routes/callbacks/compute-job-callbacks.ts`, `routes/compute.ts` and `nemar admin compute jobs` build decision 4 ("A charge settles twice") and decision 6 ("Webhooks are hints") of the Decision section above and the lifecycle of design sections 5 to 9.
Numbering: "decision N" in this amendment always means the numbered decision of the Decision section at the top of this record, cited with its name where it matters; "item N" means the numbered item of THIS amendment (the #2007 and #2008 amendments number their own items from 1 as well, and are cited as "the A2 amendment, item N" and "the A3 amendment, item N").
The repository owner's decisions of 2026-11-04 settle three questions, and the first supersedes wording above.

1. **No failure is refunded automatically, whoever caused it.**
   This supersedes the sentence of decision 4 of the Decision section ("A charge settles twice") that says a failure NEMAR caused is refunded, and the word "refunded" in its decision 13 ("Launcher details are declared and classified"); both carry an inline marker now.
   Consumed service units stay consumed.
   A job that never started on the scheduler is RELEASED in full, which is not a refund: nothing was consumed.
   A job that started is charged what the Tapis record says it used (`remoteStarted` to `remoteEnded`, the record's resources, at least one SU, never above the hold; what it used above the hold is an `overrun` entry and the job is flagged `overrun`).
   A job whose Tapis record has no start time is still charged when something shows it ran: Tapis reports FINISHED, or its launcher claimed result bytes or completed an upload; it is charged the minimum (one SU) and flagged `mismatch`.
   A start time that is present but is not a time charges the whole hold and flags `mismatch`, because a record that cannot be read must not give compute away.
   Only a job with no start time, no FINISHED and no launcher claim is released, because a release closes the hold and the ledger then refuses a charge, so a job released after it ran could never be charged.
   `isPlatformFailure(code, detail)` and the detail words of decision 13 of the Decision section stay, as an ATTRIBUTION and not a billing rule: the job row carries `platform_failure` (an information flag, written with the terminal transition) and the administrator's reports show it, so a NEMAR-caused failure can be compensated by a manual grant.
   Nothing in this phase calls `refundJob`, `settleFinal` or `adjustPool`, and no ledger write is driven by the flag. **[`refundJob` was deleted afterwards by the A2 follow-up (#2044), under item 2 below.]**
2. **The `people` budget records consumption only (option A of the A2 amendment, #2007).**
   Only a final settlement figure and the owner's own platform adjustments move it; nothing a person or an administrator does to a person's pool gives budget back.
   No path of this phase credits a budget.
   The A2 statements `refundJob` and `adjustPool` still credit it (the option B they were built with, because the choice is a code choice and the migration allows either); aligning them is a separate change, and neither is called by the lifecycle. **[Superseded by the A2 follow-up (#2044): that change is made, so the code is option A now. `refundJob` is deleted, `adjustPool` refuses a correction that lowers a charge and names the budget, and a job's final settlement is the one entry that names the budget and lowers it. The sentence above described the code as phase A5 found it.]**
3. **NEMAR owns every Tapis job.**
   The Tapis `owner` of every job, whichever front door submitted it, is the NEMAR service identity read from the Tapis configuration (`tapisConfig(env).username`, the identity the credential strategy uses), never a constant in code and never a person; a person exists only in NEMAR's job row and records.
   Nobody but NEMAR and the site's operators can read a Tapis job record, so a person who owns a Tapis job cannot read its token back; the `result.json` exit-number cross-check against the exit code Tapis reports stays as defence in depth.

What the build settled, each a rule and not a description of today:

4. **A submit is idempotent, and its outcome may be unknown.**
   Before any submit the job is searched by its tag (`nemar_job:<id>`): one hit is bound instead of a submit, two are a duplicate (nothing is submitted, the job is flagged `mismatch`), none goes on.
   `unavailable` and `invalid_response` after a submit, a cancel or a subscribe mean the effect may have happened, so the next attempt searches first; a submit is never repeated blind.
   The SHA-256 of the exact `NEMAR_LAUNCH_SPEC` bytes (decision 11 of the Decision section, "Two digests, named apart") is written to the row in a conditional UPDATE BEFORE the call; a retry that finds nothing overwrites it with the digest of the rebuilt text.
   The request names no archive system, asks Tapis not to archive the launch files, and carries the launch specification (and its per-job token) only in the environment variable.
   A 4xx rejection fails the job `tapis_submit_failed` and releases the hold; an unavailable Tapis leaves it `created`; a `created` row past the policy's reservation wait with nothing at Tapis fails `submit_timeout`.
   A job whose launch specification cannot be built (a recipe job that names no entry or command) is failed, not stranded.
   The runtime image of a `python` job is the Worker variable `COMPUTE_RUNTIME_IMAGE`: ONE digest-pinned reference and not JSON, owner-set, absent from the wrangler configuration, validated when it is read, with the digest and the Singularity file name derived from it by the contract's own functions; `GET /admin/compute/status` reports whether it is set, whether it is valid and its digest.
   Every submit sends the memory per node, minutes, nodes and cores: Tapis always passes a memory to the scheduler (its own default is 100 MB), so a job that named none would be limited to that however much it was charged for, and the memory sent is the memory the charge pays for (a whole node's from the rate table, since the partition table has no per-node memory field), clamped to the most the job's queue can schedule (`QUEUE_MAX_MEMORY_MB` in `compute-queues.ts`, declared once and mirrored from the program's Tapis execution system; a whole node's nominal memory is more than Slurm will hand out, and Tapis refuses a request over the queue's limit).
   A submitter takes a lease on the row before it searches or submits (`submit_claimed_at`, five minutes, `SUBMIT_LEASE_MINUTES`), and releases it only if the claim stamp is still its own, so two submitters cannot both reach Tapis and a stalled attempt cannot clear its successor's lease.
   A Tapis job that no row owns (the row ended, or is bound to another Tapis job) is recorded on the row as `orphan_tapis_uuid` before it is cancelled, flagged `mismatch`, and cancelled again by every tick until Tapis confirms; only one orphan is recorded per row.
   A cancel of a row that has no Tapis job yet and whose lease is live leaves its intent recorded for the sweep and ends nothing: a Tapis job may be in flight that no search can see, and ending the row would release a hold for a job that then runs.
   The submitter's bind turns a pending cancel into an orphan cancel, and once the lease ends the sweep's tag search is the authority.
   `limits.max_files` and `limits.max_total_bytes` of the launch specification bound the dataset selection and are named constants (`LAUNCH_DATASET_LIMITS`), never the results limit.
5. **A webhook is a hint, and one function transitions a job.**
   The webhook address carries an HMAC token (domain tag `compute-webhook`, over the job id and the job's `webhook_nonce`, no clock) and the launcher's `job_token` is the same construction under the tag `compute-job`, under the callback secret that signs every other callback; the nonce is cleared one day after the job is terminal, which is when the address stops working.
   The route ignores the body, answers one identical refusal for every failure, reads the job back from Tapis (one attempt, a short ceiling) and calls `applyTapisJob`, which the 30-minute tick, a cancel and an administrator's command call too.
   `applyTapisJob` writes `WHERE id = ? AND state = <from>` along the edges of `COMPUTE_TRANSITIONS`, so a repeated, reordered or concurrent writer changes nothing, and a subscription that cannot be deduplicated is harmless.
   **One secret signs three kinds of token, so it cannot be rotated while a job runs.**
   `PRESCREEN_CALLBACK_SECRET` signs the webhook token, the launcher's `job_token` and the observer's run token (domain-separated by their tags), and the prescreen and pull-request review callbacks as well.
   The job token is written into the job's launch specification once, at submit, and that text is never re-signed.
   Rotating the secret therefore refuses every running job's uploads (the job ends `result_upload_failed` and is charged, as any upload failure is), stops the webhook addresses registered with Tapis (the 30-minute poll remains), and refuses an observer token already minted.
   The safe rotation: switch compute off, let the running jobs drain (none `submitted`, `queued`, `running`, `archiving` or `unreported`), change the secret, mint observer tokens afterwards, switch compute on; for a suspected leak, cancel the running jobs first and accept the cost.
   `.rules/revocation.md`, `compute-tokens.ts` and the binding's comment say the same.
6. **A terminal transition and its settlement are one batch.**
   The state UPDATE, the ledger entry (a charge, or a release for a job that never started) gated on the job row having just taken the new state and not being settled, and the stamp of what was settled run in one D1 batch; a retry repairs a terminal row whose `settled_provisional_at` is still NULL.
7. **A Tapis `FINISHED` stands only after the upload is verified.**
   The launcher completed, its three documents parse and carry this job's id, its provenance's `launch_spec_digest` is the one NEMAR stored, its bundle and image digests are the job's, its result reports no failure and its exit number is the one Tapis reports, its manifest is what it declared, and every declared output is in the bucket with the exact size (a SHA-256 is compared only where R2 returns one for the object; where it returns none the output is checked by size alone, and nothing counts how many).
   Otherwise the job fails `result_verification_failed` (or `result_upload_failed` when the launcher never completed), with the reason as a fixed word in `failure_detail`.
   A failed job's code comes from the Worker's own recorded refusal first, then from `result.json` only when it is trusted (this job's id, a matching exit number, a provenance with the stored digest), else from the Tapis condition; a launcher that exits before writing `result.json` takes the Tapis condition.
   The Worker's own cancel record overrules the launcher's `terminated` detail.
   `tapisjob.out` is user output, copied as a log and never parsed.
8. **The launcher's callbacks carry one token and one refusal.**
   `bundle`, `outputs` and `outputs/complete` take the job token in `X-Compute-Job-Token`, never a URL; it stops working when the job is terminal, and every refusal of it is the same `job_not_found`.
   `bundle` signs only the job's own `bundle.tar.gz` from the verified job id.
   `outputs` checks before it signs anything (count, file size, job size, then one conditional UPDATE that claims the bytes against the person's share and the platform's total, both read inside the statement), records a refusal the submitter caused as `failure_detail` while still presigning the launcher's four files, writes `declared.json` through the binding, and is idempotent; an empty follow-up request after a refusal is accepted: the person's share is not applied to the launcher's own files, the platform's total still is, and each launcher file is capped on its own (a document at the outputs-body bound, the log at 16 MiB).
   Before the claim, every output path is also checked as an object key (at most 1,024 bytes of UTF-8, well-formed text), so a path no address can be signed for is `invalid_spec` naming the output and never a claim made for nothing.
   `complete` lists the declared objects (a listing, not a head each) and is idempotent; no address is issued after it.
9. **The records, the links and the mail.**
   After a terminal commit the launcher's files and the logs are copied into the locked records, never overwriting, and a copy that failed is retried by the tick for three days.
   Links are 7-day presigned GETs of a finished job's declared outputs, for the owner only, at most 1,000 at a time (an optional `after` cursor in the request body pages through the rest, and a cursor that is not an output path is `invalid_spec`), renewable while a head finds the objects and `results_expired` once it does not; the mail links to the job's page and never to a file.
   A log is copied up to 5 MiB and the copy records that it was cut; a log that could not be read for any reason but not existing leaves the whole copy owed, so it is never stamped done without it.
10. **Every compute cron is production only.**
    `runComputeAdvanceCron` (ten live rows a tick in rotation, the unreported mark after a day without a good read, the nonce clear, the repairs) and `sweepComputeCancellations` ride the 30-minute tick's production block, are absent from `DEV_CRON_ALLOWLIST`, refuse outside exact production on their own and read no switch; the switch is read only where a job is submitted.
    The rotation is by EXAMINATION and not by success: each row a tick takes is stamped `examined_at` before its step runs, so a row that cannot make progress goes to the back of the line and never holds a slot for good; the live rows Tapis has accepted and the `created` rows each have their own quota of ten, and so do the terminal rows owed a settlement and those owed a copy, so no kind of row can starve another.
11. **Read-only maintenance mode lets a running job finish.**
    The three launcher callbacks (`POST /compute/jobs/<job id>/bundle`, `/outputs` and `/outputs/complete`) stay open in `read-only` mode by an exact pattern, for POST and a well-formed job id only: a job already on a cluster has nowhere to hold its results, and a launcher refused there would fail a job that did nothing wrong.
    The person's own `cancel` and `links` stay blocked like any other write, and `full` mode refuses all three callbacks with everything else.
    **What each maintenance mode does to the rest of compute** (verified against `middleware/maintenance.ts` and the crons on 2026-11-06; the middleware, and the service-binding entrypoint beside it, are the Worker's only readers of `MAINTENANCE_MODE`; no cron reads it):

    | Surface | `read-only` | `full` |
    |---|---|---|
    | Launcher callbacks (`POST /compute/jobs/<id>/bundle`, `outputs`, `outputs/complete`) | open, by exact shape | 503: the launcher's upload fails and the job ends `result_upload_failed`, charged what it used, with no refund |
    | A person's `cancel` and `links` | 503 | 503 |
    | Tapis webhook (`POST /webhooks/tapis/<job id>/<token>`) | open: it passes the `/webhooks/` allowlist, and it WRITES (the job's state, and its settlement or release in the ledger) | 503; the job's end is then seen by the poll after the mode ends |
    | The observer (`POST /compute/observer`) | 503: a write, not on any allowlist, so the day's settlement waits for a post after the mode ends (its token is good for an hour) | 503 |
    | Administrator routes (`/admin/compute/*`, including the ledger-writing ones: pool grant and adjust, `jobs advance` and `cancel`, the pipeline run, holds, observer mint, the ACCESS re-queue) | open: the `/admin/` prefix is allowlisted, so they write | 503 |
    | Crons (the 30-minute tick, the daily jobs) | run | run |

    The crons do not read `MAINTENANCE_MODE` at all: the advance tick, the cancel sweep, the ACCESS reporter, the tenant sweep and the retention sweep run and write in every mode, which is deliberate for a job already on a cluster and means maintenance does not freeze the ledger.
    Anyone who needs the ledger frozen turns the compute switch off, which stops new holds and submits but not these.
    `LAUNCHER_CALLBACK_RE` is anchored at `/compute`, so the `/nemar/compute/...` spelling of the same route (the API is mounted at `/` and at `/nemar`, and middleware sees the full path) is not matched and is refused in `read-only`; the same is true of the `/admin/`, `/webhooks/` and `/auth/login` allowlists.
    That is not a defect today and the regex is unchanged: the launcher and the Tapis webhook address are built from `API_BASE_URL`, which has no prefix, so no caller uses the `/nemar` spelling, and the miss is in the safe direction (blocked, never opened).
    A deployment whose `API_BASE_URL` gains the `/nemar` prefix has to widen every allowlist at once, not this pattern alone (`.memory/api-mounted-twice-full-path.md`).
12. **The webhook token is redacted from this Worker's access log.**
    The Tapis webhook address carries its token in the path, because Tapis does not sign webhooks, so the Worker's access logger and the maintenance refusal line print `/webhooks/tapis/<job id>/[redacted]`.
    The token is bound to the job's nonce, dies a day after the job ends and can only make the Worker read the job back from Tapis, so a leaked one is a nuisance and not a breach.
    This covers what THIS Worker prints; Cloudflare's own request logs record the URL before any of this code runs and are outside it.

Not verified against a real tenant or a real R2, and listed so nobody reads them as facts: whether Tapis takes `archiveFilter.includeLaunchFiles` from the request, what `remoteResultInfo` carries for a failed job, the webhook retry policy, presigned multipart `UploadPart` (the 5 GB per-file cap stands), R2's error on a locked delete, a signed checksum header on a presigned PUT (deferred), the `--gpus` spelling, whether R2 returns a SHA-256 on a listing for an object the launcher uploaded through a presigned PUT (it does only for an object stored with one; where it does not, verification of an output is by size alone), whether Tapis passes a JSON launch specification, quotes and braces included, through an environment variable value to the launcher unaltered, and whether the memory and the other request fields a job asks for are taken from the request as written.

## Amendment 2026-11-04 (#2013): the revocation cascade and the ACCESS attribution are built (phase A8)

Migration `0119_compute_access_reports.sql`, `backend/src/services/compute-release.ts`, `access-attributes.ts`, the two callers named below and the reporter's place on the 30-minute tick build decision 9 ("NEMAR reports ACCESS gateway attributes for every tenant job, once") and the revocation rules of design section 7.
"Item N" means the numbered item of THIS amendment.

1. **Ending an account ends its compute in the same batch as its other credentials, through two callers.**
   `computeReleaseStatements(userId)` is run by `finalizeRevocation` (admin revoke, by username and by id) and by `tombstoneUserCascade` (the owner-only soft delete and the scheduled sweep of the live tests' accounts, which run the same function, so it counts once).
   It is not run by a role demotion, because compute is not an admin's standing and a demoted person keeps an account, a grant and jobs; nor by a key revocation (self-service, the owner's, the emailed regeneration), because a job's identity is the account's and not a key's (so a stolen key's jobs that were already submitted keep running, and are charged to the account, until the person cancels them or an administrator revokes the account); nor by logout.
   The caller-count sentences of `services/docs-auth.ts` and `services/ticket-assignment.ts` say so, and a third path that ends a whole account needs these statements too.
   `backend/test/compute-release-cascade.test.ts` and `admin-credential-cascade.test.ts` fail when either caller drops them.
2. **A job ends in SQL only when it provably never reached Tapis; every other live job records the intent.**
   The statements, in order and each keyed by the account: every live job records `cancel_requested_at` and the reason `account_ended`, keeping a reason and a time that were already recorded (the first cause stands, so a person's earlier cancel stays `user`); a job with no Tapis job, no launch specification written and no live submit lease is cancelled, its hold released and the release stamped as its settlement, which is `commitTerminal`'s terminal transition and settlement for a job that never started, in the one batch; every pool of the account is frozen.
   "Provably" is exactly the rule `driveCancel` applies before it ends a row itself (item 4 of the A5 amendment): a submit whose answer was lost writes the launch specification before the call and a Tapis job may exist that no search can see, and a submitter holding the lease may be in flight, so ending such a job in SQL would release a hold for a job that then runs, charged to nobody.
   A partner's reservation (`source = 'partner'`, no Tapis job yet) is left alone entirely, by the cascade and by `driveCancel` (and the sweep's list leaves it out, like `CREATED_ROWS_SQL`): NEMAR never writes a launch specification or takes a submit lease for a partner job, so "never reached Tapis" is true of it whether or not the partner has launched its own Tapis job under the reservation, and ending it would release a hold for a job that may be running.
   The reservation is the partner contract's to resolve (an open point for the partner phase); a partner job that has a Tapis job is an ordinary live job, cancelled there because NEMAR owns every Tapis job.
   The Tapis cancel of those jobs is never made in the batch: the retried `sweepComputeCancellations` makes it, and charges what the job used, so the account's pools stay held until Tapis says it is over.
   Every statement ends in a WHERE clause and uses plain `?` placeholders, because `tombstoneUserCascade` called with `onlyIfEmail` appends its mask guard to each statement's text; a test runs each statement alone under a false guard and finds nothing changed.
3. **A frozen pool stays frozen until something unfreezes it, and nothing in this phase does.**
   A hold on a frozen pool is refused `suspended`.
   A re-approval of an account for compute (the compute access phase, Epic D) has to unfreeze its pools; so does an administrator's lifting of a suspension.
   An account that was revoked and then restored by the status column alone stays refused for compute, which is the safe direction.
   Two things will freeze a pool (this cascade and the suspension of compute in Epic D) and they share one bit, so Epic D has to record the freeze cause, or derive `frozen` from the access state, so that lifting one cause does not lift the other.
4. **The report ACCESS is owed is a row made in the batch in which a job's record first shows a Slurm id.**
   `compute_access_reports` has one row per job (the primary key), made by `INSERT OR IGNORE` from the job row in the batch of each of the two writers of `slurm_job_id`: the live transition and the terminal transition of `applyTapisJob`.
   So a replayed read adds no second row and never resets a row that has moved on, and a job the scheduler never saw owes nothing.
   This replaces the empty hook `noteSlurmJobId` of the A5 amendment, which ran after the write and could not be one batch with it.
5. **A report is sent at most once towards ACCESS for every outcome the sender cannot judge, and retried only when the answer shows the request was not processed.**
   The claim is one conditional UPDATE (`pending` to `attempting`, a lease stamp, the attempt counted) made before the POST, so two overlapping ticks or Workers cannot both send; the POST is made between two statements and never inside a batch; the outcome is written only under the sender's own stamp.
   A 2xx is `sent`.
   Only an answer that shows the request was not processed is retried: a 4xx other than 409, 408, 429 and 503; the row is then `pending` again with an hour's delay doubling to a day, and `failed` after eight attempts.
   Every other outcome is one the sender cannot judge, and is treated as no answer: no answer at all (a timeout, a lost or refused connection), a 500, 502 or 504 (a gateway in front of a server that already stored the request answers 502 or 504, and a server answers 500 after the write), every 3xx (303, "created, see other", is the usual reply to a POST that stored something, and a redirect is never followed), 409 (which may turn out to mean "already recorded"), and a sender that died holding its ten-minute lease and may have died before or after the POST.
   Each of these ends the row `failed` with `outcome_unknown`, which nothing in code sends again.
   The tick stops CLAIMING new rows after the first of them (the rows not claimed stay `pending`, with no attempt spent and no lease, for the next tick): the first sign of a deploy's 502, a 500, a redirect from a wrong address or a timeout may be a fault every later row would meet the same way, and a systematic fault therefore loses one report a tick and not ten, which leaves the error-level log line a margin of thirty minutes to be noticed in.
   An answer that proves the request was not processed (a retry) does not stop the tick.
   `sent` and `failed` are final.
   The guarantee is therefore that a report may be LOST and is never doubled; it is not that every job is reported.
   The choice follows the design page, where a second report double-counts a person, and the interface's behaviour on a duplicate is unverified.
   Owner action: ask ACCESS whether `job_attributes` stores one record per (job id, resource), so that a duplicate is ignored; if it does, the one function `classifyAnswer` turns the unknown outcomes into retries and nothing else moves.
6. **ACCESS is told the pseudonym and nothing else about a person.**
   The body is the Slurm job id, the scheduler's submission time, the resource name and the job row's `gateway_user` (the stored `gw_` pseudonym, or `nemar-pipelines`), checked against that shape before it is sent; it never carries a name, an email, an ORCID iD or the sign-in subject.
   A job with no pseudonym (a partner job that maps to no account) ends `failed` with `no_gateway_user` and nothing is sent; a record with no submission time waits, costs no attempt and is looked at again in an hour, and a week after the Slurm id first showed it ends `failed` with `no_submit_time` (a terminal job is never read from Tapis again, so a time that is not there by then will not come, and the row would otherwise come back into the ten-row window every hour for ever).
   Outside production the body carries `debug`, which the design says the interface offers for tests.
7. **The key, the resource name and the spelling are the owner's and unverified.**
   The key is the Worker secret `ACCESS_GATEWAY_ATTRIBUTES_KEY` and the resource name `ACCESS_RESOURCE_NAME`, both optional, both absent from every table of `wrangler-sccn.toml` and pinned absent by test; unset, a row stays `pending` with `unconfigured`.
   A persistent refusal is noticed in hours, not days: a key ACCESS refuses (401, 403) or a wrong base address (404) is retried with a delay doubling from an hour, which is about 79 hours of info-level lines before the eighth attempt fails the row, so every tick logs one error-level line (counts and a fixed word only) whenever a pending row has used three attempts with a retry class, whether or not any row is due.
   `GET /admin/compute/status` and `nemar admin compute status` report the presence of each (never a value), because the reports wait until both are set, and every tick that leaves a row waiting for either logs one error-level line with the count: silence while there is work to do is evidence of nothing (ADR 0053, 0054).
   The key is sent in a header and never logged, stored or put in a job.
   The header name (`ACCESS_KEY_HEADER`), the body field names and the time format (`ACCESS_BODY_FIELDS`, `accessSubmitTime`) and the `debug` field are each one constant, taken from the design page and the phase issue, and none has been seen against the real interface.
8. **The reporter is a production-only cron.**
   `runAccessReportCron` (ten due rows a tick, oldest first, one log line of counts and fixed words only) rides the 30-minute tick's production block, is absent from `DEV_CRON_ALLOWLIST`, refuses outside exact production on its own and reads no switch, because a job that ran is owed its report whether or not compute is on.
   It stops CLAIMING new rows about twenty seconds after it starts (one POST's fifteen and a margin); the rows it did not claim stay `pending` for the next tick, so a run that is killed does not strand a claimed row as `outcome_unknown`.
9. **The two-caller rule is enforced by a source scan, not by prose alone.**
   `COMPUTE_END_CALLERS` (the documented list of the functions that run `computeReleaseStatements`) and `COMPUTE_END_EXCEPTIONS` (the functions that revoke all of an account's keys and its sessions and deliberately leave its compute: the role demotion and the emailed key regeneration, each with its reason) are held to the code by `backend/test/compute-end-callers.test.ts`, on the syntax tree, through aliased and namespace imports and uses that pass the function as a value, and refusing what it cannot follow (a dynamic import, a re-export, a module-level reference).
   "Revokes all of an account's keys and its sessions" means THROUGH THE STATEMENT SHAPES THE SCAN RECOGNISES: `UPDATE tokens SET revoked_at ... WHERE user_id ...` (an equal to a placeholder, an `IN`, a subselect, in either order of the predicates, the table quoted, bracketed or schema-qualified, in any case, and not a one-key revocation by id or hash) and `UPDATE web_sessions SET revoked_at` or `DELETE FROM web_sessions WHERE user_id ...`, inline or in a constant or helper resolved by value, in the module it is imported from.
   A revocation written another way (SQL assembled from parts the scan cannot fold) is not recognised: the scan is a tripwire for the shapes the Worker uses, not a proof that no path ends an account.
   A third path that ends an account (Epic D's suspension) has to run the compute statements or be named an exception, in a reviewed change. Epic B's owner merge command, `oidc end-account`, is not such a path: per ADR 0119 it ends the OIDC holdings only and revokes nothing, and compute ends through the revoke or delete the owner runs after it, which are already listed.

Open points for the phases that follow, recorded so nobody reads them as settled:
- A partner job with no account has no pseudonym and ends `failed` with `no_gateway_user`; the partner contract must supply one for account-less partner jobs (for example per client and Tapis owner).
- The partner contract (phase D4) must define, for a partner reservation (item 2):
  (a) who ends or expires an unlaunched reservation and releases its hold;
  (b) what a person's cancel of a reservation means: today it records the intent and reports success while the row stays `created` with its hold open, and a later partner bind is refused because `BIND_TAPIS_JOB_SQL` requires `cancel_requested_at IS NULL`;
  (c) a partner that launches under the reservation of an ended account runs unchallenged under a frozen pool, because the cascade records no intent on a reservation (it fails open): consider recording the intent so the bind refuses (fail closed);
  (d) a way to list stuck reservations for the reporting phase (the status view does not count them).
- Residuals of the reporter, accepted and recorded so nobody reads them as closed:
  (i) a 503 that a proxy answers after the upstream had processed the request (an upstream reset behind a gateway) would duplicate a report; it is rare, and the checkpoint accepted it;
  (ii) if the runtime stops `waitUntil` work about thirty seconds after `scheduled()` returns, a twenty-second budget plus a fifteen-second POST can exceed it; the reaper then ends the claimed row `outcome_unknown`, so the report is lost and never doubled.
- The reporting phase lists `failed` report rows by word, and an owner-only re-queue requires an explicit acknowledgement that the report is confirmed not recorded at ACCESS.
- The cancel sweep takes the oldest ten rows with a recorded cancel, so a queue of cancels that cannot complete can stall it (pre-existing, phase A5), and staging never cancels at Tapis (phase A5's choice).
- Which headers the interface wants, beyond the key's (for example a resource header), is checked against the real interface when the key is issued.

Not verified, and listed so nobody reads it as fact: which header carries the key, the body's spelling and time format, whether `debug` is a body field, what the interface answers for a duplicate, and whether it accepts the pseudonymous gateway user.

## Amendment 2026-11-04 (#2043): the launch specification travels as base64url (contract follow-up A1c)

The review of the launcher phase found that the launch specification, which travels as ONE scheduler environment value, is not safe to carry as compact JSON.
It read the scheduler as writing an environment value into a file that a shell sources on the compute node, and as quoting a value only conditionally; that reading is unverified (see the list at the end).
On that reading, a value with no space is written bare, so the shell consumes the quotes of the JSON and the launcher reads invalid JSON; and shell-active characters in a user's strings (a command substitution, a backtick, a quote, a backslash) are expanded or break the quoting, outside the container.
Nothing is registered with a tenant and every compute switch is dark, so nothing was exposed.
The repository owner approved the fix on 2026-11-04: base64url without padding.
"Item N" means the numbered item of THIS amendment.

1. **The `NEMAR_LAUNCH_SPEC` value is the launch specification's JSON text in base64url, with no padding.**
   Request for Comments (RFC) 4648 section 5, alphabet `A-Za-z0-9-_` (`SHELL_INERT_ENV_ALPHABET`), no padding and no line break, applied to the bytes of the printable-ASCII JSON text that `encodeLaunchSpec` writes (every byte 0x20 to 0x7e: JSON escapes the control bytes, and `encodeLaunchSpec` escapes DEL and everything from 0x80 up).
   The variable name is unchanged.
   A value made only of that alphabet holds none of the characters a conditional quoter would quote for and none that a shell, a glob or a quoting rule acts on, so how the scheduler quotes is no longer something the launch specification depends on.
   `encodeLaunchSpecEnv(text)` is the wire step, beside `encodeLaunchSpec`, which still returns the JSON text because the text is what is hashed and recorded.
   It returns a branded type, `LaunchSpecEnvValue`, and the Tapis client's input is that type (`SubmitJobInput.launchSpecEnv`), so the compiler stops the text being sent as the value (a plain string is not assignable to it); at run time the client's schema also refuses a text where a value belongs (item 5).
   The brand works in one direction only.
   The value is still a string, so the reverse mistake compiles: passing the value where the text belongs, encoded again or hashed in place of the text.
   The compiler does not catch that; verification does, because a digest over the value is not the launcher's digest of the decoded text, so the job fails closed and the digest and verify tests fail.
   No production code mixes them, and a second brand for the text was weighed and not added: it would touch many test call sites for a mistake that verification already catches.
   A5's builder (`buildLaunch`) calls both, records the digest of the text and sends only the encoded value in `parameterSet.envVariables`.
2. **The JSON text, its 64 KiB cap and both digests are unchanged.**
   `spec_digest` is the SHA-256 of `records/<id>/spec.json`, and `launch_spec_digest` is the SHA-256 of the launch specification's JSON text, which is what the value decodes to; neither is over the encoded value.
   The launcher decodes the value, hashes the TEXT, then parses it, and records that digest in `provenance.json`.
   The Worker's digest, written before the submit, is of the same text, so the check that compares them (item 7 of the A5 amendment) proves what it proved before.
   The golden vector's text and its SHA-256 are unchanged; an encoded golden vector (its string, its length and its SHA-256) is added beside it, with a second vector chosen to hold both `-` and `_` and the characters a shell acts on.
3. **The encoded value is bounded, and the bound is declared once.**
   `LAUNCH_SPEC_ENV_MAX_CHARS` is `ceil(65536 * 4 / 3)`, which is 87,382: base64url without padding spends `ceil(n * 4 / 3)` characters on `n` bytes, so every text within the 64 KiB cap encodes within the bound, and a text of exactly the cap encodes to exactly the bound.
   The encoder checks the cap on the text and nothing else, because a second check of the encoded length could never fire; a test pins the arithmetic instead (`ceil(n * 4 / 3)` only grows, is exactly the bound at 65,536 and one past it at 65,537), and `launchSpecFits` (the Worker's worst case) asks the text cap alone.
   The decoder and the Tapis client's request schema bound the value by the same constant.
4. **The decoder is strict and canonical, and there is no earlier format.**
   `decodeLaunchSpecEnv(value)` returns the text or one of five fixed refusal words (`empty`, `too_long`, `not_base64url`, `bad_length` or `not_printable`) that never holds a part of the value.
   The checks run in this order, and the first to fail names the refusal: the value is a string (an unset environment variable is not one, and is refused with `not_base64url`); it is not empty; it is at most the bound, counted in characters of the value (UTF-16 code units in the reference; for every accepted value that is also its length in bytes, because an accepted value is ASCII); it is made only of the alphabet (so no padding, no `+` or `/`, no whitespace and no line break); its length is not 1 modulo 4; the `=` padding is added back to a multiple of four (one sign for a length of 3 modulo 4, two for a length of 2 modulo 4; a length of 1 modulo 4 was refused before this step) and the value is decoded; it decodes to printable ASCII only, every byte 0x20 to 0x7e; and it is canonical.
   A value is canonical when encoding the decoded text again gives the value back, so the unused trailing bits of its last character are zero and there is one value per text: `QQ` is accepted, and `QR`, which decodes to the same byte, is refused with `not_base64url`.
   The caller then parses the JSON.
   The encoder refuses a text with a byte outside 0x20 to 0x7e (a control byte, DEL or anything from 0x80 up) with a TypeError, and a text over the cap with a RangeError, and no message holds any part of the text.
   The printable rule is one rule for both sides: the launcher drops its separate NUL check (`has_nul`) and uses `not_printable`.
   A raw JSON value, which starts with `{`, is refused: nothing is registered with a tenant, so no earlier format is accepted anywhere.
   The launcher's decoder is required to follow the same rules, with the same words for ASCII values, in the same order.
   For a value that contains a non-ASCII character, `too_long` and `not_base64url` are both conforming answers: neither can be accepted, and a length is counted in different units by different languages (UTF-16 code units, code points, bytes), so the first word can differ.
   The conformance comparison checks accept or refuse for every value, and the word only for ASCII values.
   The length check stays first because it keeps the work bounded.
5. **The Tapis client refuses anything else before a request is built, and a refusal of the job's own data ends the job.**
   The request schema's value passes only when `decodeLaunchSpecEnv` accepts it (one rule, shared with the decoder, and not a second check of the characters), so a raw JSON text, padding, a quote, a space, a newline, a value over the bound, a value that is not canonical and one that does not decode to printable text are each refused with the field's name and never the value.
   The closed one-variable array and `archiveFilter.includeLaunchFiles: false` are unchanged.
   A request refused for the job's own data (the launch value, or a field that comes from the job's row) is wrong the same way on every attempt, so it is a typed error, `SubmitRequestRefused`, with a reason word (`launch_spec_env` or `job_field`).
   `submitLeased` ends such a job `failed` with `tapis_submit_failed` and the detail `invalid_spec`, the code a refused launch specification already carries, and releases the whole hold through the path of a job that never started (released, not refunded), instead of trying again on every tick until the reservation wait runs out.
   The owner is NEMAR's configuration and not the job's data: a bad one stays a plain RangeError and the job waits for the fix, and any other exception keeps the unavailable retry.
   The encoded value holds the per-job token, so it is held to every rule the plain token is: it is not logged, returned or stored.
   The tests that look for a leak look for every form of the token (the plain token, the whole value, and the token's base64url text at each of its three alignments in a group), because the plain token is not a substring of the value, nor of a slice of it.
6. **The hazard is reproduced, not asserted.**
   `test/compute-launch-env-shell.test.ts` implements the scheduler's conditional quoting (`backend/test/helpers/scheduler-launch-file.ts`), writes `export NEMAR_LAUNCH_SPEC=<value>`, sources the file with a real `sh` in a fresh directory and prints the variable back.
   The old value, kept in the test as the negative control, fails the round trip for a specification without a space and for `$(...)`, a backtick, `"` and `\` in a user's string; `$(...)` and a backtick make the shell run what the value holds (the examples are inert: a `touch` of a path in that directory).
   One shape the old value did carry is asserted too, so the detector is seen to tell cases apart.
   The new value comes back exactly for adversarial arguments, a command, environment values and a document of 64 KiB, and no file is made.
   The scheduler's rule is the review's reading of it and is unverified; that is why the launch specification is made independent of it.
7. **What this supersedes.**
   Decision 11 says the digest is "of the exact raw bytes of the `NEMAR_LAUNCH_SPEC` value, which is ASCII-only JSON": read it as the exact bytes of the launch specification's JSON text, which the value decodes to.
   Item 4 of the A5 amendment ("the SHA-256 of the exact `NEMAR_LAUNCH_SPEC` bytes") reads the same way.
   The last clause of the A5 amendment's not-verified paragraph (whether Tapis passes a JSON launch specification, quotes and braces included, through an environment variable unaltered) is no longer the question: the value holds no quote or brace.
   Nothing is removed from this record; the earlier sentences stay as they were written.
8. **Registration stays blocked.**
   **[Read as the Tapis go-live block from 2026-11-14, so a runner-only deployment is not blocked by it: see the amendment of 2026-11-14, items 1 and 2.]**
   No application definition is registered with any tenant, and `COMPUTE_ENABLED` is not turned on anywhere, until the launcher's decoder lands in `nemar-process` (it implements the same format, with the golden vectors and the alphabet pinned on both sides) AND the owner items recorded on the launcher phase's pull request (`nemarOrg/nemar-process#9`) are settled.
   The order is: this change merges into the compute epic branch, then `nemar-process` re-pins the schema file to this merge commit and merges.
   The schema file `shared/contract/compute-launch.schema.json` changes in its descriptions and not its structure: it describes the document, says the document travels as base64url and claims nothing about the scheduler; `nemar-process` copies it byte for byte.

Not verified against a real tenant, and listed so nobody reads it as fact: how the scheduler quotes an environment value (the rule the tests reproduce is a reading of it), and whether Tapis and the scheduler accept an environment value of up to 87,382 characters.

## Amendment 2026-11-05 (#2011): first-party pipeline dispatch is built (phase A6)

"Item N" means the numbered item of THIS amendment.

1. **A recipe is resolved before `createJob`.**
   The job is made from a complete specification: the recipe's name beside the `image` runtime, NEMAR's own runtime image (`COMPUTE_RUNTIME_IMAGE`, one digest-pinned reference), the command `nemar-recipe run <name>`, and arguments that carry the dataset directory (`/data/<id>`), the product directory (`/work/outputs/product`), the dataset identity and the image digest.
   So `spec.json`, `spec_digest` and `launch_spec_digest` describe what ran, and the launch-specification builder never meets a recipe-only specification.
   The arguments are absolute because the command is an argument vector and no shell expands a variable.
   A whole-dataset run names no `--recording`.
   The registry is `shared/compute-recipes.ts`; its numbers are initial, and its version and engine are what the Worker EXPECTS the recipe to report.
2. **One stamp per dataset version, recipe, recipe version and engine** (`compute_pipeline_stamps`, migration 0117).
   A run claims its tuple FIRST, with an insert whose attempt number is read inside the statement, and a partial unique index refuses a second `dispatched` or `succeeded` row for one tuple, so two runs racing for one tuple make one stamp and one job.
   A `failed` or `refused` stamp is history and never blocks a retry.
   The job's idempotency key is made from the tuple and the attempt, so a job whose creation committed and whose link did not is found again by its key instead of being failed.
   A claim never followed by a job is failed after 30 minutes.
   Deleting a dataset deletes its stamps; the job rows and the ledger stay.
3. **The stamp says what ran.**
   It is claimed with the registry's version and engine and, when the job succeeds, rewritten from the recipe's own dataset record (`extensions.nemar.recipe` and `.engine`), read from the results bucket; a record that is absent, unreadable or another recipe's ends the stamp `failed`, and the job is untouched.
   When a job finishes, the sync compares the tuple its record names with the tuple its stamp claimed.
   A difference holds the CLAIMED tuple (a `failed` stamp with the word `tuple_mismatch`, written once per job, before the stamp is rewritten): the registry is out of date or the image is, and dispatching again would run the same datasets over and over under a tuple the table does not name.
   The hold is checked in the shared dispatch path, so a single dispatch, the queue, the daily dispatcher and the dry run all refuse with `registry_drift`, writing nothing.
   The hold does not clear by time.
   It clears when the registry declares another tuple, which is what a version bump is (a bump is never held, because the hold names the old tuple), or when its mismatch rows are deleted: deleting the dataset a row names deletes the row too, because the dataset cascade removes every stamp of the dataset, and the cascade is the rule.
   The next mismatch on any dataset holds the tuple again, so the exposure that a deletion lifts is bounded by the live cap.
   What stays exposed are the jobs already in flight when a mismatch first appears: they were dispatched under the claimed tuple and finish under the same mismatch, so the first mismatch can cost up to the live cap of jobs, each of which is stamped with what it ran.
   A record whose `<package>@<version>` is longer than the stamp's 64-character engine column is unreadable and ends the stamp `failed`.
   A stamp that cannot carry the tuple its record names ends `failed`: as `tuple_already_stamped` when that tuple already holds a live or succeeded stamp, and as `tuple_attempt_taken` when it only has a row (history) with this attempt number. The run may be good in both cases; the word says only that this stamp cannot carry its tuple, and neither word counts toward the cooldown or the cap.
   A tuple whose stamp failed is not a candidate of the queue for 7 days after the failure, nor once it has failed 3 times (both initial, `RETRY_COOLDOWN_DAYS` and `MAX_FAILED_ATTEMPTS`), so datasets that keep failing cannot take the page of every run.
   Only failures a dataset can cause count toward either: the platform's failure codes, a cancel, and the words for the Worker's and the registry's own faults (`NON_DATASET_FAILURE_WORDS`) do not, so transient errors on three days cannot shut a dataset out until its version changes.
   The cooldown and the cap govern the queue and the cron only: an administrator's dispatch of one named dataset bypasses both, and is still refused for a live stamp, a held tuple or an ineligible dataset.
   A placeholder recipe (`nemar-ica`) is refused on every path with `recipe_placeholder`.
4. **The image digest a recipe job passes is checked against the launcher's provenance.**
   `--image-digest` is the caller's claim and the recipe cannot check it.
   `verifyResults` compares the one value the recorded specification passes with the digest `provenance.json` says the launcher ran, and fails the job `result_verification_failed` with `image_digest_mismatch` (flagged for an administrator) on a difference, a missing flag, a malformed value or a second flag.
5. **Eligibility is one predicate, decided from the D1 row on every dispatch** (ADR 0065): active, public, `anonymous = 0` (NULL is unknown, and unknown is not false), first published, not withdrawn, DOI not tombstoned, a version, `eeg` as a whole modality token, and a real `nm` or `on` id outside the reserved fixture band.
   **[Outside production a second text of this predicate also admits the compute fixture `nm099996`: see the amendment of 2026-11-14, item 8.]**
   The request names a recipe, a dataset and optionally a version, and nothing else; a body with any other key is refused.
   A version with no data-plane tag, or one whose manifest holds more than 38,000 entries, is refused (`version_untagged`, `too_many_files`) and is never a candidate of the queue.
6. **The daily dispatcher is dark three times over.**
   It returns null outside exact production, does nothing and touches no table until `COMPUTE_ENABLED` and `COMPUTE_PIPELINES_DISPATCH_ENABLED` are both exactly `1`, and is wired only into the production-only daily block.
   It dispatches `autoDispatch` recipes only, within `policy.pipelines.dailyJobCap` less today's pipeline jobs (an administrator's included) and `policy.pipelines.maxLiveJobs` per pool, and a refused hold stops the run for that pool.
   It also stops at 10 jobs a tick, a bound of its own: one dispatch costs about 25 statements and calls and the one sync of the tick 250 to 450 (50 open stamps at 5 to 9 statements and calls each), so a tick is bounded at about 510 in the usual case and 710 at the worst, against the allowance of 1,000 that the daily jobs share, and the owner's cap is a ceiling and not a rate.
7. **A dry run reads only** and works in every environment: it makes no stamp, job, hold or audit row and calls neither Tapis nor a bucket.
   The compute switch is read where new pipeline work would start (the dispatch, the route's live run) and reported by the dry run; the lifecycle still gates in `submitLeased` alone, so a job already on a cluster is never stranded.

Not verified: the figures in the registry (cores, memory, minutes), the 10-job tick bound against a measured subrequest count, and the engine string a real run of the recipe reports (the reader follows the recipe's published record format, not an observed record).

## Amendment 2026-11-05 (#2012): the tenant sweep, the observer, reporting, holds and retention are built (phase A7)

"Item N" means the numbered item of THIS amendment.

1. **A job that skipped the reservation is charged as an `overrun` of the partner pool `tenant`.**
   The issue said "a `charge` entry (no hold)".
   The table refuses a `charge` that closes no hold (`compute_ledger_closes_its_hold`), and a job nobody reserved has none, so the entry is an `overrun`: use charged to the pool without a hold, counted against the `people` budget (the table requires it), with the balance free to go negative, once per job (`job:<id>:unreserved`), for a figure above 0, and only to a partner pool (the statement checks the holder kind).
   It is NEVER written to a person's pool, however clear whose job it was. Moving the charge later is a ledger operation (an `adjust` entry) that Epic D's partner-pool phase exposes; the admin routes reach account and platform pools only, so until then no route moves it.
   The row's `flag_overrun` is NOT set for it (the `unreserved` flag already says what happened).
   The decision is one small statement (`unreservedChargeStatements`); a `charge` kind that closes no hold would need a migration of the ledger's triggers, which the phase did not take.
2. **Expanse's own figure does not correct an unreserved job's charge.**
   A final settlement is `settleFinal`, which corrects a hold's charge; a job that skipped the reservation has no hold.
   The observer still matches such a job's row by its Slurm id and lists it; the figure is read by an administrator. Moving the charge, if it is warranted, is the ledger operation Epic D's partner-pool phase exposes; until then no route moves it.
3. **The tenant sweep** (`sweepTenantJobs`, `live` every 30 minutes and `week` once a day, production only, and only while `COMPUTE_ENABLED` is `1`) lists the tenant with `listType=ALL_JOBS` (five pages of 1,000, newest first as asked with `orderBy=created(desc)`, whose spelling is UNVERIFIED) and filters in code.
   For a Tapis job no row is bound to: a tag `nemar_job:<id>` for a row that has no Tapis job binds the row (the submit race) and cancels nothing; a tag for a row bound to another job, ended, or with a cancel pending is a duplicate, cancelled, the row flagged `mismatch`, never indexed (this is what catches a row's SECOND orphan, which the row's one orphan slot cannot hold); anything else is indexed FIRST (source `partner`, client `tenant`, `spec_digest` the SHA-256 of the Tapis fields read, `unreserved`, or `unattributed` when the owner maps to no active account by the gateway pseudonym), then cancelled, then followed to its end and charged.
   The row is written before the cancel so that a crash between them leaves a row to finish.
   A listing that fails changes nothing.
   A job that skipped the reservation is the sweep's own row: the tick, a read-back, a person's or an administrator's cancel and `jobs advance` leave it alone (`flag_unreserved = 1` is excluded from every generic list and refused by `driveCancel` and `advanceComputeJob`).
   The sweep reads the compute switch (`computeEnabled`), which the source scan of phase A5 had allowed in one place; the scan names the sweep now.
4. **The observer is an unsigned sender with a token for one run.**
   An administrator mints it (`POST /admin/compute/observer-runs`, audited): `<run id>.<HMAC>` under the callback secret with the domain tag `compute-observer` over the run id and the run's own nonce, valid for an hour, never stored.
   `POST /compute/observer` takes the token as `Authorization: Bearer <token>` (the amendment of 2026-11-06 replaced the header `X-Compute-Observer-Token` and the body described here), checks it BEFORE it reads a byte, answers ONE refusal (`403 observer_refused`) for a wrong, expired, reused, unknown or missing token, reads at most 1 MiB, validates the document and every row it maps to to the shape of its column, and only then spends the run with one conditional UPDATE, so two posts racing make one ingest and a body that fails validation does not spend the run.
   The two bounds, 1 MiB and 5,000 rows, are both kept; the longest row is 231 bytes, so 1 MiB admits about 4,500 of them.
5. **Final settlement against Expanse's figure** (`settleObservedRows`, run by the ingest and by the daily sweep): a stored row is matched to the job with its Slurm id; when that job has ended with a provisional `charge` and no final one, `settleFinal` brings the charge to the row's own `charged_milli` or, when it sent none, to the rate table's figure for the allocation it reports (per node: the row's CPUs, memory and GPUs are totals).
   A difference within `settle.toleranceMilli` or `settle.tolerancePercent` of the provisional charge is routine; beyond it `flag_mismatch` is set and the job is STILL settled to Expanse's figure.
   A row whose job has not ended waits and is settled by the next pass; a row that cannot be priced, or that the pools cannot take, flags the job once and is judged (`applied_at`), so it is not tried for ever.
6. **Legal holds** (`compute_legal_holds`): a hold on `job:<id>` or `account:<id>`, owner-only and audited, one active hold per target.
   The retention sweep reads the hold when it chooses and again immediately before it deletes, and the statement that reduces the row carries the hold term as well.
   A hold never keeps a result.
7. **Retention** (`runComputeRetentionSweep`, daily, exact production, no switch): for a terminal job past `retention_until` with no hold it deletes `records/<id>/` and `logs/<id>/` and reduces the row to anonymous counts (null `account_id`, `tapis_owner`, `gateway_user`, `idempotency_key`); an unflagged, unheld job loses its logs after `retention.logsDays`; a flagged job keeps them with its records (design section 9); results are only reconciled (a result still present a day after `retention.resultsDays` is deleted and counted `late`).
   It never changes a lock: ANY refusal of a `records/` or `logs/` key is counted `locked`, whatever its text (the text of R2's refusal is not verified), the job is left whole and stamped (`retention_attempted_at`) to go behind the others, and the next day asks again.
   One audit row of counts, only when something happened, and one log line; nothing per job.
8. **Anonymization of a deleted account's pools and ledger actors** (migration 0130, numbered after the used ranges, 0114 to 0119 and 0120 to 0124; Epic D's range starts at 0131 so that no migration is numbered below an applied higher one): the two triggers that made the pools' identity and the ledger immutable are replaced by themselves plus one narrow exception.
   A deleted account's pool may have its `holder_ref` replaced by `9` and the pool's own id padded to 15 digits (derived from the pool, unique, passing the account shape check), and nothing else about it may change in that statement (not an amount, `frozen`, the word or the kind), and not while it holds SU in an open hold.
   A ledger entry whose `actor_user_id` is a deleted account may have it replaced by 2^53 - 1, with every other column equal, and not while it is an open hold's own entry.
   The ledger's DELETE trigger is NOT replaced: no row is removed.
   THE TOTALS INVARIANT therefore holds by construction: nothing the exception allows changes a delta, a total, a kind or a hold, and the one writer of a total (`compute_ledger_apply`) fires on INSERT only.
   An administrator's idempotency key embeds the actor's number; it is kept, because rewriting a key would change the identity a replay is judged by.
   The sweep anonymizes a pool and an actor only when no job row still carries the account's number (so after the 7 years), no legal hold names the account, and nothing is open.
9. **The five open points of phase A5 for this phase.**
   (a) The two terminal repair lists, the orphan list and the cancel list ROTATE by the last time the list took the row (`examined_at`, and `cancel_attempted_at` for the cancel list), stamped before the step, so ten rows that cannot make progress no longer hold every slot.
   (b) A row has one orphan slot (`orphan_tapis_uuid`): a second orphan is logged (`orphan_slot_taken`) and the row flagged; the tenant sweep cancels any duplicate it lists, which is the net.
   (c) A terminal row whose Tapis record is gone (`not_found`), or has not been readable for a week, is settled without it (released unless something shows it ran, flagged `mismatch`). Where it charged the minimum, the observer's final settlement corrects it; where it released the hold, the observer has no `charge` entry to correct (its candidate query requires one), so a sacct row for that job stays matched but unapplied and only the `mismatch` flag records the use: it is flagged, not charged.
   (d) The cancel sweep is production-only; `advanceComputeJob` now carries out a recorded cancel for a job that has a Tapis job, so a staging Worker, where no cron runs, no longer leaves one for ever.
   (e) NOT CHANGED: the 30-minute tick equals the default `reservationWaitMinutes` (30), so a `created` job gets one retry before it times out.
   It is the owner's policy, not a code constant; a value of at least two ticks (60) gives it two.
10. **ACCESS reports in `failed`** are listed by their fixed word (`jobs access-reports`), counted in the daily sweep's log line (error level while any exist), and re-queued only by the owner, on the explicit statement that the report is CONFIRMED NOT recorded at ACCESS (`POST /admin/compute/access-reports/:jobId/requeue` with `confirmed_not_recorded: true`, and `--confirmed-not-recorded` on the command): an unknown outcome is never resent by code, so a person looked.
11. **Rules the review of the phase added.**
   (a) A `nemar_job:<id>` tag is trusted only on a job the NEMAR service identity owns; a stranger can write any tag, so a foreign job with one is a job that skipped the reservation.
   (b) The sweep's bound-uuid snapshot is read before the per-job reads, so a job a row owns by the time it is read is never flagged or cancelled, and a conflicting insert cancels only when the existing row is the sweep's own.
   (c) Only a 409 means a cancel is over; any other refusal is a failure, logged and asked again.
   (d) A followed unreserved row is closed with nothing charged (flagged `mismatch`) when Tapis no longer has the job, or when no read has found it for 7 days (`TENANT_GIVE_UP_DAYS`), counted from the last good read, so one transient error on an old row does not close it. This differs from phase A5's repair of a terminal row, which settles without the record (a release unless something shows the job ran) after 7 days from its end.
   (e) A stored `sacct` row is replaced by a later one while it is not applied and its state is not ended, and the state is the first word of what `sacct` printed.
   (f) A run whose rows could not be stored is given back (`issued`), and the same token may post again; a settlement that fails after the rows are stored does not fail the post.
   (g) A prefix bigger than one run's pages is `incomplete` and never reduces its row or marks its results reconciled; a capped stage counts the due rows it left (`backlog`) and logs at error level; a refusal is counted `locked` with its class kept, except a programming error (`TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`), which is a failed stage; a refusal more than a day past `retention_until` logs at error level.
   (h) Migration 0130 also pins a pool's `created_at` and `updated_at`.

Not verified: the order of Tapis's job list (`orderBy`), whether the tenant credential lists more than its own and shared jobs (the sweep finds what the service identity can list, and the fallback is the issue's: NEMAR is the only submitter), the text of R2's refusal of a locked key, and the observer's real export (no response of the real posting service was recorded; the bounds and shapes are the issue's).

## Owner decisions, 2026-11-06

The owner approved these five decisions of phase A7 (#2012) as they stand in the code.

1. **D1.** The unreserved usage entry is an `overrun` on the tenant pool, counted against the `people` budget.
2. **D2.** The observer-runs mint stays admin-level, as the issue says. Accepted risk: an administrator who mints a token can post a charged amount that settles a pool without owner authority.
3. **D3.** Migration 0130 keeps the account link (`compute_gateway_users.account_id`) and the `gw_` pseudonym for ever, and the migration 0115 triggers refuse change and delete. A deleted account's pools and ledger actors are anonymized (0130); the pseudonym mapping is not.
4. **D4.** `TENANT_GIVE_UP_DAYS` stays at 7 days; a followed unreserved row closes with nothing charged.
5. **D5.** The 30-minute tick stays equal to the default `reservationWaitMinutes` (30), so a `created` job gets one retry before `submit_timeout`.

## Amendment 2026-11-06: the Worker adopts the observer's document

The integration review of the compute epic found that the Worker and the real observer (`observer/observe.py` in `nemarOrg/nemar-process`) did not speak the same wire: the Worker read the header `X-Compute-Observer-Token` and a strict `{snapshots, sacct}` body of its own design, and the observer posts a `nemar.observation.v1` document with `Authorization: Bearer <token>`.
The owner decided that the Worker adopts the observer's document and the observer is not changed.
This amendment supersedes the wire described in item 4 of the amendment of 2026-11-05, and nothing else of it: the token, the one refusal, the 1 MiB and 5,000-row bounds, the single conditional UPDATE that spends the run, the settlement and the tolerance are as they were.

1. **The document is written once, as a JSON Schema, and shared byte for byte.**
   `shared/contract/compute-observation.schema.json` (draft 2020-12, every object the observer writes closed) is the same file as `observer/schema/observation-v1.schema.json` in nemar-process, the way the launch specification is shared.
   A zod schema in `shared/contract/compute-observation.ts` mirrors it, and `test/compute-observation-contract.unit.test.ts` holds the two to each other on a corpus of valid and invalid documents.
   The schema was derived from what the observer emits, and the two documents the observer itself wrote (`test/fixtures/compute-observation/`) are fixtures on both sides.
   Drift is checked on both sides: nemar-process compares its copies with nemar-cli's at a pinned commit (CI sets `NEMAR_REQUIRE_OBSERVATION_DRIFT=1` and checks the commit out), and nemar-cli compares with a nemar-process checkout when `NEMAR_PROCESS_OBSERVATION_DIR` names one (`NEMAR_REQUIRE_PROCESS_OBSERVATION_DRIFT=1` turns a missing checkout into a failure).
   `test.yml` checks out nemar-process's integration branch (public, sparse, no token) and sets both, so CI compares against that branch's HEAD, not a pinned commit; it does not check that nemar-process's own CI is green or that its pin is current (its advisory job says so).
   A change to the document is made in nemar-cli and copied, never edited in one copy.
2. **The token is `Authorization: Bearer <token>` only.**
   The header `X-Compute-Observer-Token` is not read; a post that carries it alone is the one refusal, like a wrong token.
   Nothing else about the token changed: the one-hour per-run `compute-observer` HMAC, constant-time comparison, identical refusals for a wrong, expired, reused, unknown and missing token, and never logged.
3. **The document is validated, then mapped to the stored rows by a table.**
   `services/compute-observation.ts` holds the table (partition queue figures to `compute_queue_snapshots`; each accounting job to a `compute_sacct_rows` row; `charged_milli` always NULL, so the rate table prices the allocation as it does for any row without a figure of its own).
   The CPU, memory, node and GPU figures are read from `alloc_tres` by one function, `parseAllocTres`, which fails closed: a value it cannot read refuses the post (400 `invalid_post`, the path and the fixed word `malformed_tres`, never the value), the run is not spent and nothing is stored.
   Memory is converted to megabytes with Slurm's powers of 1024 and rounded up; a number with no unit is refused unless it is 0.
   A row with elapsed time and no `cpu` item is refused (`missing_cpu`): an allocation that ran and is not on record would be priced at nothing, which is a guess.
   A row with elapsed time and no `node` item is refused the same way (`missing_node`): the settlement reads no node as one node, which is a guess too.
   A refusal lists at most five paths, and a key the sender chose (a partition, a state, a reason, an allocation item) is printed as `<key>`.
4. **What is skipped is counted, not refused.**
   A partition whose queue was not read (`jobs` is null) is not stored as zero; a row whose job id is not one Slurm job (a pending array `123_[1-5]`), whose partition, state or elapsed time the observer could not read, or whose value is past a column's bound is not a job NEMAR could have submitted as one Slurm job.
   Both are skipped and counted in `skipped` in the answer, so one array on the community account does not stop the rest of the day from settling.
   A `truncated` export says so in the answer (`truncated: true`).
   The rows it lost are NOT on a later export: `sacct -S day -E day+1` selects a job by the day it ran, so a job that began and ended inside the cut day is on no other export and stays at its provisional charge until an administrator moves it.
5. **A mode is never a dry run.** The observer defines `quick` and `daily`; both are live.
   A `quick` document has no `accounting` and no `sources.sacct` (the schema requires both for `daily`), so it stores the queue and settles whatever earlier rows can now be settled.
   Any other `mode`, and a `schema` word that is not exactly `nemar.observation.v1`, is refused like any malformed body.
6. **A decision for the owner to confirm: one unreadable row refuses the whole day.**
   An `alloc_tres` value that `parseAllocTres` cannot read, a row with elapsed time and no `cpu` item, and a row with elapsed time and no `node` item each refuse the entire post (400 `invalid_post`, the run not spent, nothing stored), not just the row.
   That is deliberate and fail closed: a charge that is guessed is a charge to a person's pool, and a post that settles part of a day hides that the rest was refused.
   The cost is that the same document is refused on every retry until the observer or the cluster's text changes, so one row can hold back a whole day of settlement.
   The alternative is to skip and count such a row as the unreadable-partition rows are; it is not taken here, and the owner is asked to confirm the choice.
7. **Open item for the observer-dispatch phase: the row cap and the byte cap differ.**
   The observer cuts its export by bytes only (1 MiB, from the end), and the Worker refuses more than 5,000 rows (partitions and accounting jobs together).
   A busy day of short rows can pass 5,000 jobs inside 1 MiB, and the document is then refused `too_big` on every retry, so that day never settles.
   The observer is not changed here; the dispatch phase has to choose between a row cap in the observer, a larger Worker bound, or accepting the refusal and re-reading the day in parts.
8. **Not verified.** The observer's formats were written from the Slurm manual and the public user guide, not captured from a cluster (nemar-process `docs/unverified.md`), so this schema describes what the observer emits and not what a cluster has been seen to print.
   A quick post is made every 15 minutes and a token is good for one post, so a token per quick run must be minted; that is the operator's procedure and is not decided here.

## Review fixes of 2026-11-06 (implementer A)

The three-reviewer review of the epic's pull request found money loops and silent failures in the compute services.
Each item below says what changed and what was decided; the owner decisions of 2026-11-06 are final.

1. **The Workers subrequest limit for the compute crons is 10,000, not the project's older 1,000.**
   The 1,000-subrequest model used elsewhere in this project is not the compute limit, and the compute crons are NOT restructured and get no shared operation budget.
   The first week's observability counts (the per-tick lines of the advance, cancellation, tenant, pipeline and ACCESS crons) should confirm the larger limit; a count that approaches it is a reason to reopen this, not to guess.
2. **An ACCESS report whose call never left the Worker is retried, not ended `outcome_unknown`.**
   A throw of `fetch` was classified as no answer, and no answer is never resent, so a call the runtime refused before it was made (the invocation's subrequest limit) lost its report for good.
   The runtime gives no code or class for that refusal, only its message, so `throwedBeforeSend` recognizes exactly that message (a closed list) and nothing else.
   A timeout, a reset, a refused or lost connection and every other throw stay unknown and are never resent: a runtime cannot tell them from a reset after the request left, and ACCESS is not known to ignore a duplicate.
   The conservative choice is therefore explicit: only a throw that proves nothing was sent is retried, through the ordinary retry (an attempt is spent, the delay applies, the bound still ends it, the word is `unavailable`), and the tick stops claiming after one, since every later row would meet the same limit.
3. **An observer run is spent before its rows are stored; the re-mint path is manual and is documented.**
   `CLAIM_RUN_SQL` spends the run, then the rows are stored; the run is reopened only when the store throws.
   A worker that is killed between the two leaves a run `ingested` with no rows, and the token is good for one post.
   The recovery is to mint a new run (`POST /admin/compute/observer-runs`) and post again; the stored rows are keyed by Slurm job id and the upsert is idempotent, so a repeated day is safe.
   Nothing is redesigned.
   A run left `ingested` with no stored rows is the signal to look for in the observer-runs listing; the listing is the reporting module's, and the count is not added here.
   The public runbook on docs.nemar.org should carry the same two sentences.
4. **A run that failed AFTER consuming units counts toward the pipeline's cooldown and cap.**
   `result_upload_failed` and `result_verification_failed` (the job ran, then its results could not be taken or checked), `tapis_record_lost`, and any `failed` job whose row was charged above 0, are no longer on the list of failures that are not the dataset's (`NON_DATASET_FAILURE_WORDS`): they count toward the 7-day cooldown and the 3-failure cap like a failure the dataset caused, so the queue no longer sends the same dataset again every day with nothing to stop it.
   A failure before any charge (staging, `tapis_submit_failed`, `submit_timeout`) stays an immediate candidate.
   The charge is read from the stamp's linked job row, in the same SQL that decides the candidates.
5. **The tenant sweep owes the ACCESS report for the jobs it indexes (decision 9).**
   A tenant job that skipped the reservation now gets its pseudonym copied from `compute_gateway_users` when its owner maps to an active account, and a report row in the same batch as the index row (and at its close, for a Slurm id that first shows then), by the statement the lifecycle uses.
   A job whose owner maps to no account has no pseudonym, so its report ends `failed` with `no_gateway_user` and the gap is visible; the partner contract still has to supply a pseudonym for account-less partner jobs.
6. **A cut-off tenant listing needs a person only when a live job could be hiding.**
   The listing is newest first and at most 5,000 jobs.
   A `live` pass raises `needsPerson` for a cut only when the last page it read still held a job that has not ended (`liveMayHide`); a tenant that has simply run more than 5,000 jobs no longer raises it for ever.
   A `week` pass still raises it on any cut, since a job of the week may be missing.
   The line carries `live_may_hide`.
7. **Retention reads the hold between the two prefixes.**
   Stage 1 deletes `records/<id>/` and then `logs/<id>/`.
   A hold placed after the first read and during the first delete now keeps the logs, because the hold is read again between the two; the reducing statement already guarded the row.
8. **A Tapis cancel that failed is counted, and loud while it persists.**
   `driveCancel` and `retryOrphanCancel` return an outcome (`ended`, `pending`, `failed`, `skipped`) instead of nothing.
   The cancel sweep counts `cancel_failed` (a count, never a job id or an account) and logs at error level when it is above 0, so a persistent failure is loud on every tick it persists, and a transient failure the next tick cures is one line.
   `cancel_pending_failed` counts live rows whose recorded cancel is still not carried out an hour after it was asked for (`countCancelPendingFailed`); the status view will carry it once the reporting changes that wire it are merged.
   An orphan's cancel (a Tapis job NEMAR made that no row owns) now clears the record only on a 409, on a 404 that a read of the job confirms, or on a refusal after which a read shows the job has ended (a finished job may be answered with a 400): a 400 or a 403 no longer clears an orphan that is still running (this is the tenant sweep's rule).
9. **A status Tapis reports that NEMAR does not know is treated as an unreadable record.**
   `unknown_status` refreshes nothing, so the row's last good read ages and the job is `unreported` after a day (it used to stay live and silent for ever); the tick counts it as `unknown_status` and logs the status word shortened to 32 characters and reduced to letters and underscores.
   It is not ended as lost: only a record that cannot be read at all is.
10. **A live job whose Tapis record is gone ends `failed` with `tapis_record_lost` (owner decision 1 of 2026-11-06, refined in review).**
    The word is a platform failure code (`PLATFORM_FAILURE_CODES`, so `isPlatformFailure` is true and the attribution follows).
    Only a read that answers 404 can end a job this way; a refused credential, a response that fails its schema and a Tapis that is down for a week each leave the job `unreported` and put an error line in the tick, because a record that is merely unreadable may still be running.
    Two things end it: a row whose last good read of Tapis is more than `UNREADABLE_GIVE_UP_DAYS` (7) days old and whose read answers 404 again; and a job with a cancel recorded whose cancel answers 404 AND whose read-back answers 404, when its last good read is more than a day old (so one wrong-tenant 404 cannot end a job at once).
    A job Tapis has ANSWERED since its last usable read is never lost: a status NEMAR does not know leaves `tapis_synced_at` alone, so the job goes `unreported` after a day as before, and is stored in `tapis_status` (an administrator sees the word), and the stored word that names no known status is what stops the lost-by-age rule.
    That is the clock chosen instead of a new column: no migration.
    What the lost job settles at depends on the row, because a job that ran is never released (a release closes the hold, the ledger then refuses a charge, and the observer corrects only a row that has a `charge` entry):
    - **evidence of a start** (`started_at` set by an earlier read): charged the time from that start to now, capped at the job's own time limit, through `provisionalCharge`, once, capped at the hold, excess to overrun as for any failed job that ran;
    - **other evidence of use** (the launcher's bytes or completed upload, a Slurm id, or the last reported state `running` or `archiving`): the contract's minimum is charged;
    - **no evidence of ever starting**: the hold is released with no charge, once, by the same release statement and gate as any release.
    In every case the row is flagged `mismatch`, leaves the live states (the account's live-job slot is free), and its Tapis uuid is recorded as the row's orphan, so a job that is in fact still running is cancelled by the existing orphan retry as soon as Tapis answers a cancel.
    A released job's later use is FLAGGED for an administrator, not reconciled: the observer cannot repair a released job and the tenant sweep skips a bound row (the repair path above says the same).
    A pipeline stamp that reads the row fails with the same word, which counts toward the pipeline's cooldown (item 4) because the job may have run.
    Recovery before 7 days is unchanged: a good read refreshes the clock.
11. **A copy of the launcher files abandoned after three days is counted.**
    `UNCOPIED_TERMINAL_SQL` stops listing a terminal row three days after it ended, and the failure used to be a log line.
    The tick now flags such a row `mismatch` where it is not flagged already, and reports `copy_abandoned` in its result and its line at error level: the rows that are abandoned whatever their flag (a lost record is born flagged and is abandoned all the same) whose window closed in the last 30 days, so the line is an error on every tick for a month and then stops.
    `countCopyAbandoned` is the running total with no age limit; the status view will carry it once the reporting changes that wire it are merged.
12. **The tick's line says what it did.**
    A tick where Tapis could not be read for a row is a `warn` line (it used to log nothing when nothing else happened); `unknown_status` and a repair that did not finish are `warn`; a failed step and an abandoned copy are `error`.
    `repaired` counts only a repair that finished what was owed (`repairTerminal` returns the real outcome); an attempt that left something owed is `repair_attempted`.
    The pipeline dispatch line adds `synced_later` and `synced_errored` (a sync that could not decide yet, and one that threw) when they are above 0.
13. **Tapis answers that are a proxy's, not Tapis's decision, are transient.**
    A 408 and any 3xx (a redirect is never followed) map to `unavailable`, not `rejected`.
    A submit that met a proxy's 302 or 408 ended the job for ever as `tapis_submit_failed`; it now stays `created` and the next tick looks the job up by its tag.
    400, 405 and 409 stay `rejected`.
14. **A fault reading the owner's policy on the outputs route is `policy_unavailable` (503), not `compute_disabled`.**
    `compute_disabled` says the platform is switched off, which a caller may take as final; the new word is a refusal code of its own with the same status and its own sentence.
    The launcher's reaction to an unknown 503 word is the launcher's (nemar-process) to confirm; the contract declares no retryable word of its own for this.
    `mintResultLinks` still answers `results_expired` for a declared file that is invalid or unreadable: no distinct word is declared for it, so it is left and noted here.
15. **Code that is declared and not wired is marked.**
    The `uploading` state has no writer, and `presignIncomingUploads`, `finalizeBundle` and `finalizeSubmittedFiles` have no caller: Epic D's partner contract wires them, and each now says so in a comment.
    `compute_jobs.legal_hold` is unused (always 0); the hold that counts is a row of `compute_legal_holds`, read by `heldSql`.
    The comment of migration 0115 that said the retention sweep honours the column was wrong and is corrected (comment only).
16. **`GET /admin/compute/pipeline/status` writes, and read-only maintenance mode lets it through.**
    The route syncs the pipeline stamps (`syncPipelineStamps`, a write that finishes stamps whose job ended) before it reads, because the status view must show the state of the jobs and not the state of the last cron.
    A GET that writes is an exception to the rule that read-only mode refuses writes; the middleware admits it because it is a GET.
    The write is the same, idempotent sync the cron makes, it touches only stamps and never a job, a hold or the ledger, and a repeated read changes nothing.
    The route header should say so in a sentence; it is added with the change that owns that route file.

## Amendment 2026-11-10 (#2121, phase P1): the pipelines' caps apply to every path, atomically

The pipelines' two caps (`pipelines.maxLiveJobs` per pool, `pipelines.dailyJobCap`) were applied only as reads by the daily dispatcher, so an administrator's `pipeline run --eligible --limit N` (up to 100) and a run racing the cron could pass them.
The owner ruled that the administrator's run obeys the same limits.

1. **The live cap is a guard inside every pipeline hold.**
   `createJob` adds `PIPELINE_LIVE_JOBS_GUARD_SQL` to the hold's own statement for `source = 'pipeline'`, the way the person's live-job limit is: the pipeline jobs live in the job's pool (every recipe, every live state, `created` included) must be fewer than `policy.pipelines.maxLiveJobs` of that pool.
   A refusal is the existing `over_concurrency`, written as before (a refused hold writes no job, no ledger row and no pseudonym) and ending the stamp `refused`.
   The count names no account: the cap is NEMAR's pipelines in total, and the same statement (`PIPELINE_LIVE_JOBS_SQL`) is what the dispatchers read, so the room that is read is the room that is enforced.
   It is answered from a partial index of the live rows, never the whole table.
2. **The daily cap is a clamp, not a guard.**
   `pipelineRoom(db, policy, pool)` (`compute-pipeline.ts`) is the one reading of both caps, used by the cron, the administrator's run and the dry run.
   `dispatchEligible` tries at most `min(limit, COMPUTE_PIPELINE_RUN_PER_INVOCATION, daily_left, live_left)` datasets for every actor.
   When the room is 0, or a cap and not the number asked for ended the run, it stops with `over_concurrency` (the live cap) or the new word `daily_cap_reached` (409, pipelines only; no path answers it as an HTTP status today, it is a `stopped_by` of a 200 or 201 run).
   It stays a clamp in P1 for two reasons.
   `PIPELINE_JOBS_TODAY_SQL` is a full scan of `compute_jobs`, which a guard would run inside every pipeline hold's write, and the alternatives (an account-bound count served by `compute_jobs_account_created`, or a new index) need an account bind or a migration that P1 does not have.
   A guard could be passed through `dispatchPipelineJob` into `createJob` (the third-party branch does this for a client's day as `CLIENT_DAY_GUARD_SQL`), so the clamp is a choice of P1 and not a limit of the hold.
   Runs that race can therefore pass the daily cap by up to (the number of racing runs minus 1) times min(10, the daily room, the live room).
   The money ceiling is another fence: the pipelines pool's balance, enforced atomically by the same hold (`HOLD_INSERT_SQL`; pipelines have no budget pool), although an overrun can push it below zero; the caps only pace spending.
   An atomic daily guard, if wanted, belongs in P2 beside the tenant-ceiling guard, with an account-bound count.
3. **The per-invocation bound is 10** (`COMPUTE_PIPELINE_RUN_PER_INVOCATION`, equal to the cron's tick bound).
   A Worker request cannot be trusted to carry 100 dispatches (about 25 subrequests each, and each waits on the job platform in turn).
   Whether the compute limit of item 1 of the review fixes of 2026-11-06 applies to this route has not been measured, so the bound is conservative and raising it needs a measurement.
   A run that wants more is asked again; the answer's `room.limited_by` says it was the bound.
4. **A single named dataset** is bounded by the live guard (`over_concurrency`, 409, when the pool is full) and by the pool's balance, and counts toward the daily cap without being refused by it; the owner ruled this for P1 and may rule otherwise later.
5. **What an administrator sees.**
   A run's answer and a dry run's carry `room { daily_left, live_left, limited_by }`, `limited_by` being one of `limit`, `per_invocation`, `daily_cap`, `live_cap` (the first of these on a tie).
   A dry run trims `would_dispatch` to the room, so the preview is what a live run would do; for a named dataset on a full pool it reports `blocked: over_concurrency`.

The decision to queue a job NEMAR cannot yet admit (rather than refuse it) is not taken here; design and open questions are in #2121.

## Amendment 2026-11-10 (#2121, phase P2): a tenant-wide ceiling on live jobs, checked when a job is accepted

The class caps of P1 bound each of NEMAR's front doors separately, so together they could ask for more of the cluster account than it has.
The owner approved a ceiling for the whole tenant, with a floor of slots for each class that no other class may use.
The numbers are policy defaults the owner can change without a deploy once the center says how the cluster account's limit is counted.
It adds no queue and no migration.

1. **The rule is a guard in every hold.**
   `createJob` adds `tenantGuard` (`services/compute-tenant.ts`) to the hold's own statement for EVERY source, after the class cap that already exists (a person's live-job limit, or the pipelines' live cap).
   A job of class K is admitted when `occupied + 1 + SUM over the classes L other than K of max(0, floor[L] - occupied[L]) <= ceiling`.
   It is counted inside the statement that writes the hold, so two requests racing for the last slot cannot both win; it is a guard, not a clamp.
   The floors are unconditional: a floor slot is never lent to another class, and a class's floor is what it is owed, not what it is limited to.
   A floor protects a class from the OTHER classes; it does not admit anything over the ceiling.
   When jobs NEMAR did not admit fill the headroom, a class still below its floor is refused like any other, because the cluster's limit is real.
2. **The classes are counted by the job's `source`.**
   People are `cli` and `web`; pipelines are `pipeline`; the partner is `partner` with `flag_unreserved = 0`; everything else is `other`: a row the tenant sweep found that skipped the reservation (`flag_unreserved = 1`, whatever its source) and an orphan (below).
   `other` has no floor and cannot be admitted, because NEMAR did not admit it; it is only counted.
   On `dev` only `pipeline` and swept rows exist today.
   The person's submit and the partner's reserve are on the held third-party branch (#2116); the class function is written by the source word so both are already counted when that branch merges.
   Whoever merges `dev` into that branch:
   - keeps the tenant guard, the pipeline guard and the `guardRefusal` ordering in the `guards` block of `createJob`;
   - does not keep the tail of that branch's refusal wording that ends `return refusal("over_concurrency")`, which would word every tenant refusal `over_concurrency`: use `guardRefusal`'s result;
   - keeps the access guard's own read before the others, because it needs two words (`suspended` or `no_compute_access`) and a guard of this file holds one fixed word;
   - adds `platform_busy` to that branch's closed partner table and sentences (`COMPUTE_PARTNER_ERROR_STATUS`, `COMPUTE_PARTNER_SENTENCES`), to `COMPUTE_SUBMIT_SENTENCES` for people, and as a step of the reserve order after the client caps.
3. **What occupies a slot.**
   Every row in a live state, `created` included (the states are written literally in the statement so the existing partial indexes of the live rows serve the count), and one slot more for EVERY row that records an orphaned platform job (`orphan_tapis_uuid IS NOT NULL`), live or not: that job runs on until the sweep cancels it.
   A live row can carry one in two ways, and then holds two slots: a duplicate of the job the row owns, found when a second submit is bound; and a row that is still live with a cancel pending (`created` or `uploading` with `cancel_requested_at` set) whose Tapis job turned up after the cancel was asked for, which `bindTapisJob` records as the row's `tapis_uuid` AND as its orphan, so that one job counts twice.
   The second case lasts only while the cancel of that job keeps failing, until `cancelOrphan` succeeds or the row ends; it costs one slot, errs high as documented, and the row also shows in `cancel_pending_failed` after an hour.
   The count errs toward too many for what NEMAR has recorded; it is not an upper bound on the cluster (see the limits).
4. **The defaults and why.**
   The policy key is `tenant { maxLiveJobs, reserved { people, pipelines, partner } }`; the schema refuses floors that add up to more than the ceiling, and `PUT /admin/compute/policy` therefore refuses them.
   The defaults are a ceiling of 20 and floors of 8 for people, 2 for the pipelines and 0 for the partner.
   The cluster account is limited to 24 jobs at once, so the ceiling of 20 leaves four slots of headroom on purpose: that headroom is for occupants NEMAR cannot see yet (a partner job that skipped the reservation until the sweep finds it, a job someone ran by hand, a duplicate), which is also why the sweep warns when its listing holds more live jobs than the ceiling.
   With the defaults the pipelines can burst to 12 and people to 18.
   NEMAR's own pipelines keep the room they had (8 CPU and 4 GPU, 12 in all) only while nothing else occupies a slot: an orphan or a swept row, and people holding more than their floor, each reduce it, and a stored policy that raises `pipelines.maxLiveJobs` to 100 for both pools and has no tenant key stops at 12 under the default ceiling.
   The pipelines' caps are in effect bounded by the ceiling less the people and partner floors.
   Each live orphan cuts the pipelines' 12 by one (20 less the people floor of 8), and the four slots between the ceiling and the cluster's limit do not help them, because the guard checks the ceiling of 20 and never the cluster's limit of 24: a stray orphan or two leaves the normal daily run (at most 10 a tick) unchanged unless more than about 2 pipeline jobs from earlier days are still live.
   A stored policy that lacks the key uses `TENANT_POLICY_DEFAULT`, the very object the shipped default carries, never "no limit".
   A ceiling of 0 admits nothing new (running jobs finish).
5. **A refusal is `platform_busy` (409), and it is not a queue.**
   It is worded after the refusal, last in the documented order: a pool that is suspended, a balance that is short, the platform budget and the class cap are read first, then each guard is asked again in order and the first that fails names the word.
   A pipeline run stops with it (`stopped_by`), and the daily dispatcher ends its whole run (`platform_busy` is in `ENDS_THE_RUN`), because the ceiling does not depend on the pool or the recipe.
   A retry that raced its own original request, and found the slot taken by it, gets the original job back: `createJob` reads the idempotency key again before it words a refusal, as a sequential replay is answered before any guard.
   Whether to hold such a job until a slot frees (the queue, P3) is decided elsewhere (#2121); until then the caller asks again.
   The partner is checked only when it reserves, so it cannot be queued behind the ceiling: a reservation either holds a slot now or is refused.
6. **What an administrator sees.**
   `GET /admin/compute/status` carries `tenant { ceiling, occupied, by_class, reserved }` and the attention count `tenant_over_ceiling`, which a job NEMAR did not admit, or a ceiling lowered below what is already live, can make positive; `nemar admin compute status` prints `Tenant: occupied/ceiling (people, pipelines, partner, other)`.
   When the stored policy cannot be read the block is absent and the attention count `policy_unreadable` is 1: that is a compute outage (every hold, run and limit reads the policy and fails closed), and the route says so instead of dropping the block.
   The live tenant sweep adds `tenant_live=<live jobs in its listing> occupied=<n>/<ceiling>` to its line, both read before the run indexes or cancels anything, and logs a warning when `tenant_live` exceeds the ceiling.
   A pipeline run's `room` (and a dry run's) gains `tenant_left`, the slots the pipelines' class could take under the ceiling, and `limited_by` gains `tenant` (the order is `limit`, `per_invocation`, `daily_cap`, `live_cap`, `tenant`, the first on a tie, so a run that ends at exactly the number it was asked for was not limited).
   A run is clamped to `tenant_left` and stops with `platform_busy` when it ended the run, so the preview is what a live run does; for a named dataset a dry run reports `blocked: platform_busy` after the class cap's `over_concurrency`.
   The clamp is a read of the guard's own arithmetic (`tenantRoom`); the hold's guard still decides, so a run that races another is refused there and its stamp ends `refused`.
7. **Honest limits.**
   - The guard counts NEMAR's own rows.
     A job it has not been told about holds a slot nobody counts until the sweep finds it, and a second orphan of one row is not recorded (the row has one orphan slot) until the first is cleared, which is what the headroom and the warning are for; the ceiling is not a guarantee about the cluster.
   - The count is read inside every hold.
     The live rows are served by a partial index, but the orphan term has no index (it would need a migration) and is a scan of `compute_jobs`; the table has one row per job.
     The index (`compute_jobs_orphan ON compute_jobs (examined_at) WHERE orphan_tapis_uuid IS NOT NULL`, which the plain predicate of the statement is written to match) is filed as #2131 and goes into the queue phase's migration (`dev` is at 0130, and the held third-party branch holds 0131 to 0134).
   - A refused job is refused by the guard at the moment of the hold; the word is read afterwards, so a slot freed in between can leave a refusal worded by the first guard, and the next request may be admitted.
   - A guard is not a clamp.
     The tenant guard is atomic, the daily cap of P1 stays a clamp, and an atomic daily guard (with an account-bound count) is a separate small change.
   - The pipelines' floor protects them from people and from the partner, and the people floor protects people from the pipelines; neither bounds NEMAR against slots held by what NEMAR did not admit, and neither admits a job over the ceiling.
   - Rolling the Worker back to a build from before this change reads a stored policy that has the `tenant` key as unreadable (the policy reader is as strict as the writer, on purpose) and fails closed.
     That is not only the holds: every reader of the policy stops.
     The launcher's outputs call is answered 503 (`policy_unavailable` at the route, `compute_disabled` from the service's own read), so a job that is running can lose its results if the outage outlasts the launcher's retries; the tick's created-row path returns `unavailable`; the dispatcher logs `policy_unreadable`; retention, the records and bundle limits, the observer's settlement and the tenant sweep stop or fail as well.
     It is triggered more easily than it looks: with no stored row `policy show` now returns the default WITH the `tenant` key, so any show, edit and set round trip writes the key without the owner meaning to.
     Recovery: `putPolicy` never reads the current row, so a version without the key can be written first (by the older Worker's own `policy set`, from a file without `tenant`).
     While `COMPUTE_ENABLED` is absent in production there is nothing live to break.

## Amendment 2026-11-13: pointer to ADR 0121 and ADR 0122

[ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md) refines this ADR for jobs that are not Tapis tenant jobs: a job with `accounting = 'none'` runs on a runner, never on Tapis, makes no hold and writes no ledger entry.
For those jobs it departs from decision 3 and the A3 amendment's item 1 (the hold), decision 4 (settles twice), decision 9 (the ACCESS report), the A2 amendment's item 7 (`settled_final_at` and the `job:<id>:final` entry) and the A5 amendment's item 6 (the terminal batch's ledger entry).
A tenant or partner job has a Tapis job and is always `su`, so nothing changes for it.
[ADR 0122](0122-one-oci-image-runs-under-apptainer-or-docker-from-one-digest.md) refines decision 14: `NEMAR_SIF_ROOT` is not required under Docker (Podman is unsupported), and the SIF is built and signed once in CI.
`shared/contract/compute-runner.ts` also extends decision 10's list of modules.
`sweepRunnerLeases` also runs on claim calls outside production; the 30-minute tick itself stays production-only, so decision 8 and the dark-switch rule of `AGENTS.md` are intact.
The verdict of this ADR stands.

## Amendment 2026-11-14: the registration block and runner-only deployments

The amendment of 2026-11-04 (#2043), item 8, was written when `COMPUTE_ENABLED` could only mean a Tapis submission.
Read literally it binds every environment and every executor, because "anywhere" has no qualifier, yet both of its conditions (the launcher's decoder, and the owner items recorded on the launcher phase's pull request) guard the Tapis go-live: registration with a tenant, and a launch specification reaching a scheduler that writes it into a file a shell sources.
[ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md) does not mention item 8, and an agent cannot read away a sentence of an accepted ADR, so the owner amends it here.
The owner decided on 2026-11-14 to mark Tapis as parked and to apply this text.
"Item N" means the numbered item of THIS amendment.
It changes no code, no switch, no wrangler file and no version.

1. **Item 8 of the amendment of 2026-11-04 (#2043) is read as the Tapis go-live block.**
   It blocks three things, in every environment: registering an application definition with a tenant, setting a Tapis credential (`TAPIS_USERNAME`, `TAPIS_PASSWORD` or `TAPIS_SERVICE_TOKEN`) in a Worker where `COMPUTE_ENABLED` is `1`, and submitting a job to a tenant.
   Its first condition, the launcher's decoder in `nemar-process`, is met (`nemarOrg/nemar-process#10`).
   The owner items of `nemarOrg/nemar-process#9` still block all three.
2. **`COMPUTE_ENABLED` may be `1`, with `COMPUTE_RUNNERS_ENABLED`, in a Worker that holds no Tapis credential, for runner jobs.**
   Every path that would reach Tapis in such a Worker answers `unconfigured`, and no job, credential or launch value is sent to a tenant.
   A Tapis-executor pipeline run is refused with `tapis_unconfigured` (503) before any write, for every caller (step S3c of the portable compute plan, #2168), so no stamp, no job row and no ledger hold can appear that only a cancel would end.
   A runner run and a dry run are unaffected.
3. **Setting a Tapis credential where `COMPUTE_ENABLED` is `1` is the Tapis go-live.**
   It needs the items of `nemarOrg/nemar-process#9` settled and every Tapis mechanic selecting `executor = 'tapis'`, the tenant sweep's tag bind included.
   The bind (`handleUnbound` with `BIND_TAPIS_JOB_SQL`) selects no executor at the time of writing, so once Tapis is configured a Tapis job tagged `nemar_job:<a runner job's id>` could move that runner row; with no credential it is unreachable.
4. **The item on `--no-mount hostfs` is not Tapis-only.**
   It is the launcher's Apptainer flag set, and a runner drives the same launcher, so it applies to every Apptainer run, a runner's included.
   The owner decided that the production runner uses Apptainer, rootless, so the first production Apptainer runner waits for that item.
   A runner that drives Docker is not affected by it.
5. **The Tapis go-live is parked by the owner's decision of 2026-11-14.**
   Nothing in this amendment settles the owner items of `nemarOrg/nemar-process#9`.
6. **The switches stay the owner's.**
   A production switch is set in a reviewed pull request that edits the dark-switch test (`backend/test/compute-switches-flag.test.ts`), and nothing else sets one.
   Decision 8 and the dark-switch rule of `AGENTS.md` are unchanged.
7. **Policy keys, and the first production cap.**
   The policy reader is as strict as the writer (the A2 amendment's item 8), so a Worker that does not know a key reads a stored policy that holds it as unreadable and fails every compute path closed (the P2 amendment's item 7).
   No policy version holding the `tenant` or the `runners` key is stored in production until the previous production deployment reads both, so that a one-step rollback cannot land on a Worker that cannot read the policy.
   The shipped default carries `tenant`, so a `policy show`, edit and `policy set` round trip writes it even when nobody meant to.
   The first production runner cap stays the code default (`RUNNERS_POLICY_DEFAULT`) until a second release that carries the epic is deployed, and only then is a cap stored as `policy.runners`; the owner chose that over lowering the code default.
8. **Eligibility has a second, non-production text.**
   Eligibility stays one predicate written once as a list of terms (item 5 of the amendment of 2026-11-05 (#2011, phase A6)), and step S1 of the portable compute plan (#2164) added a second, non-production text of it (`PIPELINE_ELIGIBLE_SQL_NONPROD`) that admits the compute fixture `nm099996` outside production only; production's text is unchanged, and an `ENVIRONMENT` that is unset or misspelled behaves as production.
