# ADR 0109: A large change is read as an exact, platform-computed summary

**Status:** accepted
**Date:** 2026-10-20
**Owner:** Seyed Yahya Shirazi

Amends [ADR 0107](0107-dataset-pull-requests-are-screened-on-content-owners-and-administrators-are-exempt-and-the-review-check-is-required.md) on what counts as read and on the review prompt, and [ADR 0092](0092-dataset-pull-requests-get-a-derived-verdict-from-a-worker-gated-model-review.md) on what the evidence's `files_read` counts.
It records Part A of epic #1851; the design is `.context/plans/pr-review-change-summary.md`, whose owner questions were answered on 2026-10-20.
Everything else in ADR 0107 stands: the two stages, the derived verdict, `V3_RULES`, no tools for the model, and its worst case of 45.4 minutes.

## Context

After release 0.10.21 gave the review stage its whole output ceiling of 128,000 tokens, a bulk pull request still could not pass.
In `nemarDatasets/on004551` #1, 125 modified `channels.tsv` files have 114 distinct diffs of 127 to 394 lines each; the reader shows 40 diffs at most, so `changed_metadata_not_shown_in_full` stayed true and `no_degradation` could never pass, at any output budget.
On the 86 open dataset pull requests of 2026-10-20, 31 had changed content the review could not read in full.
Larger diff budgets do not help: the diffs fit no prompt, and the review's thinking, not its input, already fills the output ceiling.
The review check cannot be required while the main data author's pull requests are stuck there.

## Decision

### The summary and its bounds

The platform parses both sides of every modified `.tsv` and `.json` file in the areas the review reads, under strict parsers that refuse anything ambiguous, and computes every difference as an atom with a role: loss, relocated, modification or additive.
Atoms with the same kind, path shape, field, rule and detail are one change class, so one edit made to 125 subjects is one class with a count, described exactly by its rule or by the complete list of its distinct value pairs.
The bounds are 120 classes and 30,000 characters rendered, 12 distinct pairs per class, 300 characters per value, 8 MiB per file side, 256 MiB read per run, and 32 Mi code units held by the relocation pools.
A class that does not fit is cut whole, and the classes shown are always a prefix of the order, losses first.
The summary starts only while more than 40 seconds of the content pass are left, and is abandoned whole at that line, which leaves the review exactly where it was without one.

### What counts as read

A modified file counts as read when it parsed on both sides with no refusal, its diff was total, the summary was not abandoned, and every class holding one of its atoms that is not additive was shown completely.
That is a third way to be covered, beside a diff shown in full and a proven cosmetic change, and `readIncomplete` and `truncated` keep their formulas.
`files_read` becomes the size of a union: the files whose diff was shown, the files a diff shown in full repeats in, and the files the summary accounted for, each once; the facts key the model reads, `files_with_content_shown`, keeps its name.
No evidence field, report version, Worker parser or check sentence changes.

### Loss facts and platform findings

Rows removed, columns removed with values and JSON keys removed with values are loss facts, unless the same content appears elsewhere in the pull request: a row verbatim under `sourcedata/<anything>/<the same path>`, or a key with the same value in a sidecar that applies by Brain Imaging Data Structure (BIDS) inheritance.
A removed row with no such copy is unrelocated, a removed key with no such sidecar is unkept, and a column removed with its values is always a loss.
The summary counts them only in the files it summarized: a file it refuses (a ragged row, a repeated key, a file over a cap) has no atoms, so a removal in it is not a loss fact.
An unrelocated or unkept removal in a summarized file adds a platform finding: a finding the job builds from the summary's counts, never from a model, a `blocker` on `no_degradation` with an existing code.

- `data_removed`: "The platform found N rows removed from T tables and not copied unchanged into sourcedata at the same path, and C columns with values removed. A person confirms a removal." Either part stands alone when the other is zero, and a count of one is singular.
- `metadata_removed`: "The platform found K keys with values removed from J JSON files and not kept, with the same value, in a sidecar that applies by inheritance. A person confirms a removal."

A note holds only letters, digits, spaces, commas and full stops, is a fixed point of the report's sanitizer, and is at most 197 characters at ten-digit counts, under the 200 a note may have.
The path is the summary's first file, in code-unit order, with a removal; it goes to the finding of its file's kind (a table's to the rows, a JSON document's to the keys), the other finding names none, and the report's parser checks it like any path.
At most three platform findings exist (the third is kept for the original-content rules), and only a full report takes them: a screen report given one is refused.

They come first.
The report's findings are the platform's, then the review's that fit, then the script's own findings for a failed text judgment, so no model output can push a platform finding out.
The parser gives a criterion that fails with no finding one of its own and makes room for it by trimming the report's last findings, which are the script's, so the room left for the review is what eight leaves after the platform's and the script's findings and after one place for each failing criterion that no finding names.
A failed text judgment (the title, the description, a misleading description) carries one reason: the review's own when it gave one on that judgment's criterion with one of that judgment's codes, and otherwise the script's.
The review's reason is then always kept, in the place the script's finding would have taken; a code filed under another criterion explains nothing, so the script gives its own.
The review's first finding on each other failing criterion that no finding of the platform's or the script's and no such reason names is kept before its other findings, and the kept ones stay in the review's order; with every failing criterion explained, that is the review's first findings, as a plain cut keeps.
At most three platform findings explain `no_degradation`, the script's findings and the review's reasons for the text judgments are at most three together and explain the two text criteria, and a full report's `genuine_contribution` passes, so those findings and the failing criteria are at most eight together: every reason the review gave for a failing criterion fits, the parser trims nothing, and a report parses back to itself.
A model finding cut for room still does what the parser does with one that fits: a steering finding makes the report a steering attempt, and a blocker lowers its criterion's `pass` to `unknown`, never `genuine_contribution`, which a full report keeps at `pass`.
Without that carry, the room made for platform findings could raise a verdict: a steering finding cut from the end of eight would no longer fail the review.
So the verdict can only be lowered, and the stored report holds the lowered criterion, so the Worker's re-derivation gives the job's verdict.
A platform blocker also takes the place of the check's derived line for a removed file, because that fact no longer moves the criterion; the table of what changed and the file list still show the removal.

### The prompt

The facts block gains `change_summary`, last: the twelve facts of the design's section 8.1 (whether the summary was abandoned, and eleven counts), built key by key, and the class table, one line per class shown, `C<n> <kind words> | <items> in <files> | in full` or `not shown in full`, whose kind words are a closed list.
No path, value or name is in it.
A new fenced block, `changed-metadata-summary`, holds the class descriptions between the groups block and the diffs, and only when the summary has a class.
Every value and path in it is quoted and escaped by the summary, so nothing in it can start a line, and the fence breaks a forged `<facts>` or closing tag as it does for any content.
The groups block gains a sixth column: how many files of the shape the summary accounted for.
The system prompt gains one paragraph after the trust boundary and one clause in the groups sentence.
The paragraph says that only the files the summary summarized are counted in the facts, and that a removal in any other file is shown only in its diff and is the review's to judge; a file counts as shown in full through the summary only when the summary summarized it.

### Owner answers of 2026-10-20

- A1: an unrelocated or unkept removal blocks `no_degradation`; it is lowered to `unknown`, and a person confirms.
- A2: relocation counts only verbatim into `sourcedata/<anything>/<the same path>`, and for JSON the same key and value in a sidecar that applies by inheritance.
- A3: emptying a value is shown exactly and does not block.
- A4: removing a JSON key whose value was already missing is not a loss.
- A5: the 400-name cut keeps truncating; it is argued in its own phase.
- A6: the relabel rules (prefix and suffix, zero padding, case, letters and digits in order) are exact descriptions of a renamed key.

Part B, what a contributor may change of the original authors' content (questions B1 to B7), was answered with the design's defaults the same day and is built in later phases.
Until then only its three finding codes are in force: the Worker accepts them, and nothing emits them.

### Release order

Whatever widens what counts as read ships in the same release as the finding that covers what it no longer shows.
The evidence reader counted accounted files as read one phase before the prompt and the platform findings existed, and in that window an unrelocated or unkept removal in an accounted file read as complete with no finding.
The window was never released: the summary, the coverage rule, the prompt and the platform findings reach `dev` together, when the epic merges.

### Cost

The pools are bounded by their 32 Mi code-unit budget, and only the files a candidate can consult are read at all.
A modified JSON document is still walked whole as a candidate and as a pool file, which a hostile one turns into about 1 GB of memory per document in flight; time, not memory, ends such a run, because the summary is abandoned at its line and the raw path takes over.
No new budget enters the job: ADR 0107's 45.4 minutes are unchanged.

## Consequences

- A bulk pull request like `on004551` #1 can now pass `no_degradation`: its 125 tables are 5 classes and about 2,400 characters, and every number in them matches its author's own account.
  With the prototype, the pull requests with unread content fell from 31 to 14 of 86, 7 of those over the 400-name cut; 17 carry an unrelocated or unkept removal and need a person for it.
- An unrelocated or unkept removal in a file the summary summarized is a platform blocker, at 3 files or at 3,000, whether or not that file was also shown as a diff.
  A removal in a file the summary did not summarize is read from its diff by the model, as before the summary existed, and when that diff is not shown in full the pull request is incomplete, as before.
- The prompt is a calibrated one, changed: the model calibration of ADR 0107 is required again before the check is required.
- The longest review message, system prompt included, grows to 258,381 characters, under the 300,000 a test holds it to.
- Two values that the fence makes equal (a `<facts>` and a `</facts>`) show as equal text with no note on where they differ, because the note is computed before the fence.
  No loss can hide this way, since a removal is an atom of its own with a finding; the calibration phase adds the case to its hostile fixtures and fixes it there.

## Alternatives considered

- **Raise the diff budgets:** 114 distinct diffs of 127 to 394 lines (in 125 modified tables) fit no prompt, and the output ceiling is already filled by thinking.
- **Fold near-identical diffs:** masking the lines or values that differ is exactly what lets a one-byte change hide; ADR 0107's folding is exact for that reason.
- **Give the model a tool to open files:** ADR 0092 and ADR 0107 give it none.
- **Group by each file's set of classes:** the files of one bulk edit rarely share all their classes, so it gives dozens of groups where classes give five.
- **Ordered row diffs:** quadratic on hostile input, and they read a reorder as a loss.
- **Store the summary in the report:** it is input to the model, not to the verdict, and what decides already reaches the verdict through `truncated` and the platform findings.
- **A new evidence field for the loss counts:** it would let the check and the calibration read them, but it changes the evidence keys every reader parses for no change in any verdict; it waits for its own phase.
- **Fold an unrelocated or unkept removal into `truncated`:** the check would then say some files were not shown, which is false and gives the author nothing to fix.
- **Always render the summary block, as "(none)":** a block with nothing in it adds a fence for every small pull request and nothing for the model to read.
- **A blocking path per kind of loss:** a second path field on the loss facts; the path is attributed by the file's kind instead, which is sound because tables yield only row and column removals and JSON documents only key removals.

## Receipts

- Design: `.context/plans/pr-review-change-summary.md` (sections 4 to 8, 10.3 to 10.5, 11, 12 and 13).
- Epic #1851 and its phase issues #1852 to #1857.
- Pull requests #1863 (the three accept-only codes), #1865, #1867, #1868 and #1871 (the summary and the evidence reader), and the pull request of issue #1857, which wires the summary into the prompt, the report and the job.
