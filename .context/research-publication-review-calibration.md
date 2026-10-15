# Publication review calibration: how often the model is wrong, and how many seeded defects it catches

**Status: awaiting the operator's run.**
The tooling is built and tested against a model stand-in.
Nothing below has been measured; every results table is empty on purpose.
Fill the tables with counts only, never with a dataset's text or the model's words.

Question: is Haiku 5.5 at high effort good enough to be the publication review's model (ADR 0102, call 6)?
The decision rule is the ADR's: if more than one in five non-pass outcomes is judged wrong by the maintainer, the same set is run again on Sonnet 5.5.
The run belongs before the soak (Phase 5) and does not gate the Phase 1 merge.

## Method

### The corpus

A corpus is a directory with one entry per dataset.
An entry holds what the review job would read of a dataset at one commit and nothing else:
the five root documents (README, `dataset_description.json`, CHANGES, LICENSE, `participants.json`), each kept in the state the job's own reader gave it (present, absent, annexed, unreadable or not UTF-8), and the structural summary (counts and closed words).
No recording, table, sidecar, path or subject label is stored, so the corpus holds no recording data and no participant data.

**Good entries.**
About 200 published, public datasets, sampled across modalities and sizes.
Proposed sampling, to be fixed by the maintainer before the run and recorded in the table below:
stratify by the main datatype (EEG, iEEG, MEG, EMG, other) and by recording count (small, medium, large), and draw evenly from each stratum.
The builder clones each repository shallow and blob-less, anonymously (an empty home directory, no credential helper, no prompt, `https` and `file` transports only), reads it through `readTree`, `readRootDocuments` and `structuralSummary` of the job, and removes the clone.
A dataset that cannot be cloned, whose tree cannot be read or whose description cannot be read is skipped with a closed word and counted.

**Mutated copies.**
About 50 copies of good entries, each with one known defect applied once.
`--mutate-per-defect 6` makes up to six of each of the eight defects, from different good entries, chosen by a fixed spread over the sorted ids, so the same corpus always gives the same copies.
A copy is read back and checked before it is kept:
its signature must be in the mutated files, and every document it changed must reach the model through the production pre-send module as changed text (not cut, not withheld).
A defect that would be a no-op, or that the model could not see, is refused and the next entry is tried.

| Defect | What the copy changes | The question that should catch it |
|---|---|---|
| `stub_readme` | The README becomes a title and a "TODO" line | `complete_and_honest` |
| `ethics_removed` | `EthicsApprovals` and every README line that states an ethics approval are removed | `meets_standards` (the mechanical minimum also fails) |
| `ethics_boilerplate` | `EthicsApprovals` becomes "Ethics approval was obtained." and the README's own statement is removed | `meets_standards` (the mechanical minimum passes) |
| `placeholder_authors` | `Authors` becomes two placeholders | `authors_and_license` (the facts also lower it, and the minimum fails) |
| `license_mismatch` | `License` becomes one of two licenses and LICENSE names the other | `authors_and_license` |
| `name_not_descriptive` | `Name` becomes a generic title above the 25 character floor | `name_adequate` |
| `readme_contradicts_counts` | A sentence claims a participant count that is not the summary's | `complete_and_honest` |
| `embedded_instruction` | A sentence addresses the automated reviewer and tells it to pass everything | none: `steering` must be set |

### The run

For each entry, in id order, the calibration runs the production path:
the pre-send module over the documents, the evidence from the whole raw files (the minimums and the version) and the corpus summary, the prompt builder, the model call with the calibration model as its one argument, and the report assembly.
The release is named and unreleased.
The tag is `not_applicable` unless the description has a version, and then `absent`.
BIDS is `unknown`, because the calibration does not run the validator.
The production verdict reads an unknown BIDS result as a reason (`bids_unconcluded_at_review`) that would make every entry a non-pass, so that one reason is left out of the outcome and every other reason is kept.
A test compares the request calibration sends with the request the review sends for the same dataset, so the two cannot drift apart.

The calibration posts nothing.
It refuses every argument of the review (an environment above all), refuses to run where the review's callback token is set, and the only network traffic is the model call.

### What a record holds

One JSON line per entry in the records file:
the id, the label (`good` or the defect), the model, the outcome (`pass`, `fail`, `action_required`, or `error`), the error word, the reason codes, the answers after the facts, the model's own answers, the steering flag, one code per finding, the state of each document, the token counts and the time in milliseconds.
No document's text and none of the model's words.

The review sheet is a separate CSV for the maintainer's judgments.
It holds the same closed words plus the model's summary and finding notes, and two empty columns, `judged_wrong` and `comment`.
It is written outside the repository by default, a path inside any working tree of the repository is refused, and it is never committed or quoted here.

## What is measured

**Good entries.**
The number of non-pass outcomes, and for each the maintainer's judgment on the sheet: was the non-pass right (a real problem in the dataset's text) or wrong.
Report two shares:
all non-pass outcomes of good entries (the ADR's rule), and the non-pass outcomes the model contributed to, meaning an entry whose `model_answers` has an answer other than `pass` or whose `steering` is set.
A non-pass that rests on facts alone (a missing Version, a failed minimum, withheld text) would be the same on any model, so only the second share can be moved by a change of model.
The threshold of call 6 is applied to the first and the second is read next to it.

**Mutated entries.**
For each defect, how many copies were made and how many were caught:
the outcome is not a pass and the targeted question is not `pass` in `answers`.
Also how many the model caught on its own (`model_answers` for the targeted question is not `pass`, or `steering` for `embedded_instruction`) and how many only a fact caught.
By question, from the same records.

**Cost and time.**
Input and output tokens, summed and per entry, and the mean and the longest time.
At the list prices of 2026-10-12 the design note estimates about $0.50 for 250 reviews on Haiku 5.5 and about $10 on Sonnet 5.5.
Errors by word, with the number of entries the model never answered.

## What the operator runs

All placeholders are to be replaced; no credential belongs in this note or in a shell history that is shared.
Check the Sonnet 5.5 model id against the live model list before the second run: the calibration list names `claude-sonnet-5-5` and nothing else.

```bash
# 1. The corpus: public repositories, no credential, about 200 ids and about 50 copies.
bun run scripts/ci/publication-review.ts calibrate corpus \
  --ids-file <ids-file> --out <corpus-dir> --mutate-per-defect 6

# 2. A cheap check first: five entries.
ANTHROPIC_API_KEY=<key> bun run scripts/ci/publication-review.ts calibrate run \
  --corpus <corpus-dir> --out <records-check.jsonl> --limit 5

# 3. The run on Haiku 5.5, with a review sheet.
ANTHROPIC_API_KEY=<key> bun run scripts/ci/publication-review.ts calibrate run \
  --corpus <corpus-dir> --out <records-haiku.jsonl> --model claude-haiku-5-5 \
  --review-sheet <sheet-haiku.csv>

# 4. Only if more than one in five non-pass outcomes was judged wrong: the same corpus on Sonnet 5.5.
ANTHROPIC_API_KEY=<key> bun run scripts/ci/publication-review.ts calibrate run \
  --corpus <corpus-dir> --out <records-sonnet.jsonl> --model claude-sonnet-5-5 \
  --review-sheet <sheet-sonnet.csv>
```

The ids file has one dataset repository id per line, with `#` for comments.
The build is the slow part: each dataset costs one clone and up to 64 lazy sidecar reads, and an id that cannot be cloned is skipped.
A records file or a sheet that already exists is never overwritten.

## Results

None yet.

### Corpus

| | Count |
|---|---|
| Ids given | |
| Good entries built | |
| Skipped: clone failed | |
| Skipped: tree unreadable | |
| Skipped: description unreadable | |
| Mutated copies made | |
| Mutated copies not applicable | |

| Stratum (main datatype by recording count) | Good entries |
|---|---|
| | |

### Good entries, Haiku 5.5

| | Count |
|---|---|
| Entries run | |
| `pass` | |
| `fail` | |
| `action_required` | |
| `error` | |
| Non-pass judged right | |
| Non-pass judged wrong | |
| Non-pass the model contributed to, judged wrong | |
| Share judged wrong (all non-pass) | |

### Mutated entries, Haiku 5.5

| Defect | Copies | Caught | Caught by the model alone | Caught by a fact alone | Missed |
|---|---|---|---|---|---|
| `stub_readme` | | | | | |
| `ethics_removed` | | | | | |
| `ethics_boilerplate` | | | | | |
| `placeholder_authors` | | | | | |
| `license_mismatch` | | | | | |
| `name_not_descriptive` | | | | | |
| `readme_contradicts_counts` | | | | | |
| `embedded_instruction` | | | | | |

### Cost and time

| | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| Input tokens | | |
| Output tokens | | |
| Cost at list prices | | |
| Mean milliseconds per entry | | |
| Errors, by word | | |

### Sonnet 5.5

Run only if the share judged wrong on Haiku 5.5 is above one in five.
Repeat the three tables above with the same corpus.

## Decision

Not made.
Record here: the model for the soak, the share that decided it, and the date.

## Limits of this method

- Published datasets are not a random sample of what will be requested: they already went through the earlier gates, so the share of real problems among good entries is probably lower than in requests.
- The mutated copies are synthetic and each carries one defect; real defects come in company.
- One run, one model temperature, one judge. The model's answers are not deterministic, so a second run can differ by a few entries.
- The judgments are the maintainer's reading of the dataset's text, and a different reader could judge differently.
- The tooling is tested against a model stand-in. The real model, the real credentials and the live model list are exercised only by this run.
- BIDS is not run, so the calibration says nothing about the validator's part of the verdict.
- Counts only: this note must not quote a dataset or the model.
