# Design: a mechanical change summary for the dataset pull-request review (Part A) and rules on the original authors' content (Part B)

**Status:** design for implementation, not yet an ADR.
**Date:** 2026-10-20.
**Binds on:** ADR 0092 and ADR 0107 (read both first, and the amendment of 2026-10-20 in 0107).
**Records as:** ADR 0109 when slice 1 merges (section 14 says what it must say); 0108 went to the BIDS validator's release policy on `dev` while this design was built.

This document decides how the review job describes a large change to the model without the model reading every diff, and how it protects what the original authors wrote.
A worker implements it from this file.
Every decision has a recommendation and a reason; the policy choices that belong to the owner are listed as Owner Questions in section 13, each with the default this design builds.

---

## 0. The decisions in one page

**Part A.**

1. The platform parses the before and the after of every MODIFIED `.tsv` and `.json` file in the areas the review reads (dataset description, participants, sidecars), under strict, linear parsers that refuse anything ambiguous.
   A refused file stays on the raw-diff path exactly as today.
2. It computes every difference as an atom (a row removed, a key relabeled, a cell changed from one value to another, a column added), and groups atoms into **change classes**: one class per (kind, entity-wildcarded path shape, column or key path, exact rule).
   One edit repeated over 125 subjects is one class with a count.
3. A class describes every one of its members **exactly**: a rule that is a function of the old value (a prefix added, zero padding changed, letter case changed) or the complete list of distinct value pairs (`good` to `bad`, 12 times) with counts.
   A class that cannot be shown completely within the bounds is incomplete.
4. **A modified file counts as read** when it parsed, its bytes round-trip through the parser, and every non-additive class it belongs to was shown completely.
   `readIncomplete` (and so `truncated`) is computed exactly as today, with "accounted for by the summary" added as a third way to be covered beside "shown in full as a diff" and "proven cosmetic".
   No new evidence field, no Worker parser change, no report version change.
5. Removed rows, removed columns with values, and removed JSON keys with values are **loss facts**.
   A removal whose exact content reappears in the same pull request (a row verbatim in `sourcedata/<anything>/<same path>`; a JSON key with the same value in a sidecar that applies to the file under BIDS inheritance) is **relocated** and is information only.
   An unrelocated or unkept removal adds a **platform finding** (severity `blocker`, criterion `no_degradation`, existing codes `data_removed` and `metadata_removed`), which the existing parser turns into "cannot pass", never into a pass.
6. The class table (class numbers, kinds, counts, completeness) goes into the `<facts>` block, outside every fence; the class descriptions (paths, column names, values) go into a new fenced block.
   The system prompt gains one paragraph; `V3_RULES` is untouched.
7. Exact folding (`diffSignature`) stays, and the raw-diff budget is spent first on files the summary did not account for, then on a few accounted files as illustration.

**Part B.**

8. Root prose (`README*`, `CHANGES*`), the author-owned fields of `dataset_description.json`, participant values and annexed recordings get mechanical "original preserved" facts.
9. "Original" is what the dataset held at its **first published version tag** (the lowest `vX.Y.Z` tag whose commit is an ancestor of the merge base); without such a tag, everything at the merge base is original, which is the strict fallback.
10. Altering original prose beyond a minor edit, an author-owned field, or a participant value **fails** `no_degradation` with a platform finding that tells the author what to do instead (CHANGES for the narrative, a new section for new information, an administrator for a wrong original statement).
    Replacing a recording's content needs a person (`unknown`).
11. Part B shares Part A's blob reader, budget, value renderer, facts block and platform-finding mechanism; it needs three new finding codes, which ship accept-only in slice 1 so that slice 2 has no deploy skew.

**Measured on the 86 open dataset pull requests** (section 1): the prototype accounts for 5,495 of 5,907 summarizable files; pull requests whose content is incompletely read drop from 31 to 14, and 7 of those 14 are over the 400-file name cut that this design deliberately leaves for slice 3.
`nemarDatasets/on004551` #1 is fully accounted for in 5 classes and 2,385 characters (a design-time figure, measured with the prototype's rendering; section 8.3 has the as-built text and sizes), and its numbers match its author's own README claims exactly.

---

## 1. What was measured

All numbers in this document come from a throwaway prototype run on real data, not from estimates.

- **Data.** `gh search prs --owner nemarDatasets --state open` returned 89 pull requests on 2026-10-20; 86 are dataset pull requests (three are in `.github`).
  Each was fetched the way the workflow fetches: `git init`, a promisor remote, `git fetch --no-tags --filter=blob:none` of the base and `refs/pull/N/head`, no checkout.
  65 are by the canary account, 18 by a second contributor, 4 by `nemarAdmin` or `neuromechanist` (exempt in production).
- **Prototype.** TypeScript on Bun 1.4.3, in the scratchpad (`design/proto/`): `parse.ts` (strict TSV and JSON parsers), `relabel.ts` (relabel rules and key pairing), `summary.ts` (classes, render, coverage), `run.ts` (runs the repository's real `gatherListing` and `gatherContent` beside the summary), `partb.ts` (Part B facts), `render2.ts` (the prompt format of section 8).
  It imports the worktree's `scripts/ci/pr-review-evidence.ts` read-only, so "current" numbers are the production code's.
- **Machine.** A laptop over residential network to GitHub; a GitHub-hosted runner is expected to fetch faster and parse slower.

### 1.1 Part A results

| Measure | Value |
| --- | --- |
| Dataset pull requests | 86 |
| Modified `.tsv`/`.json` files in read areas (summarizable) | 5,907 |
| Parsed without refusal | 5,514 (393 refused: 391 `invalid_utf8` on the before side, in three pull requests, 347 of them in `on006233` #2; 1 `ragged_row`; 1 `empty_column_name`) |
| Accounted for by the summary | 5,495 (93.0%) |
| Pull requests with `readIncomplete` today | 31 |
| Pull requests with `readIncomplete` with the summary | 14 (7 of them over 400 files, so `listCut` keeps them truncated anyway) |
| Pull requests that become complete | 18; 11 of them carry no blocking loss fact |
| Pull requests with an unrelocated or unkept removal (blocking by default) | 17 |
| Largest fenced summary | 6,958 characters (cap 30,000) |
| Parse, diff and classify, all 86 together | 2.6 s; largest single 567 ms (`on006910` #1, 768 files) |
| Blob read, one `git cat-file --batch` | 10 ms for 264 blobs (1.8 MB); 30 ms for 934 blobs (20.6 MB) |
| Today's content pass, largest | 14.3 s (`on007353` #1), 11.7 s (`on006910` #1); most of it is starting two `git show` processes per cosmetic check, not fetching (section 12.1) |

These are the prototype's numbers.
Phase 6 ran the real code on the same 86 frozen pull requests and measured them again; five numbers moved (accounted for 5,482, truncated 15, newly complete 17 of which 9 carry no blocking loss fact, blocking loss 20, largest fenced block 6,940 characters), each for a decided rule or a definition, and the table of section 12.4 ("Measured on the real code") lists every difference.
The prototype counted every candidate as `summarized` and folded a cut listing into `readIncomplete`; the real code keeps `summarized` (parsed without refusal, 5,514 here) apart from `refused` (393) and `listCut` apart from `readIncomplete`, so those two rows above agree with the real code only after that change of definition.

**`nemarDatasets/on004551` #1** (307 files: 125 modified `*_channels.tsv`, 124 added `coordsystem.json`, 56 added `sourcedata/channels-removed-2026-10-18/.../*_channels.tsv`, README, CHANGES).

| | Today | With the summary |
| --- | --- | --- |
| Files whose content counts as read | 9 | 127 (125 accounted for, 2 raw diffs) |
| `readIncomplete` | true | false |
| Prompt text for the 125 tables | 80,000 characters of 9 diffs | 2,385 characters (768 facts, 1,617 fenced; design-time, see section 8.3 for the as-built sizes) |
| Classes | | 5 |
| Parse, diff and classify | | 66 to 106 ms |

The five classes say: 1,203 rows removed in 56 files and found verbatim under `sourcedata/channels-removed-2026-10-18/` at the same path; 14,135 names gained the prefix `POL `; 341 names gained `EEG ` and `-Ref`; rows reordered in all 125 files; 2,043 rows added.
The author's README claims "14476 rows renamed, 2043 rows added, 1203 rows removed (kept in sourcedata/...), 125 files reordered"; 14,135 + 341 = 14,476.
The platform reproduced every number from git alone.

**Lessons the prototype taught, each now a rule of the design.**

- *The order of evidence matters, and an error in it only ever produces a spurious loss or more visible change, never a hidden one.*
  The first prototype relocated before pairing relabels, and from any file, and found 670 "removed" rows and 32 "emptied" cells in `on004551` that were not: renamed rows had been matched to identical copies in other subjects' `sourcedata` files, which left those subjects' real removals with no copy to match, and a few names had been paired with the wrong new row.
  Pairing a relabel whose other cells are all equal first, then relocation into the same path, then a relabel on the name alone, gives the exact numbers above (section 4.4).
- *Bulk relabels are not prefix-only.*
  `on004194` #1 renames `GA01` to `EEGGA_01REF` and `DCEMBRACE` to `DC EMBRACE-REF`; `on005007` #2 renames `A1` to `POL A01`.
  The relabel rules of section 4.3 (prefix and suffix, zero padding, letters and digits in order, characters in order by position) account for all of them: `on004194` went from 20,533 "removed" rows to 36 with the run rules, and to 0 once the character rule paired `DCEMBRACE` with `DC EMBRACE-REF` at the same position with every other cell equal.
- *The summary finds real losses that a reader of 40 diffs would miss.*
  `on004661` #1 removes 214 HED entries from `task-nback_events.json`; `on004849` to `on004855` remove HED entries; `on006126` #1 removes participant `sub-AlBy15` from `participants.tsv`; `on007119` #1 removes four channel rows whose copies in `sourcedata` are not verbatim (the names were redacted, `N1?硬膜外?要チェックin EEG` became `N1(redacted)`); `on003029` #1 removes the `Levels` descriptions of two `participants.json` columns; `on005522` #1 sets the coordinates of five electrodes to `n/a` (one had `z` of -364 mm) and replaces 121 others.
  Each is something a person should confirm, which is what the loss fact or the exact display asks for.
- *Key renames in JSON are common.*
  `MiscChannelCount` became `MISCChannelCount` in 72 sidecars of `on005420` #1 and in 29 of `on003194` #1; without rename detection that read as 101 removed keys.

### 1.2 Part B results

- **README deletions are mostly artifacts.** Of the 29 READMEs that GitHub shows with deleted lines, **27 are purely additive** once the comparison ignores a final-newline difference and line endings.
  `nemarDatasets/on004703` #1, cited as a rewrite, is one of them: its README went from CRLF to LF line endings, so every line shows as removed and re-added; with `git diff --ignore-space-at-eol` it is 20 inserted lines and no deletion.
  The two real ones: `nm000501` #3 replaces three lines that are in the `v1.0.0` README (an original statement corrected), and `on002578` #2 rewords 21 lines of a "NEMAR curation changes (2026-05-21)" section that `v1.0.0` does not contain (added at `v1.0.2`).
- **CHANGES** is modified or added in 64 pull requests with no deletion in any; every new entry is inserted at the top or appended.
- **`dataset_description.json`** author-owned fields: `Name` changed in 3 (all `nemarAdmin`, exempt); `Funding` typo fixed in `on007353` #1 (edit distance 7 in about 100 characters); `ReferencesAndLinks` emptied from `[""]` to `[]` in 7 (empty to empty, not an alteration); `ReferencesAndLinks` lost a placeholder link in `on006126` #1; empty `Acknowledgements`, `HowToAcknowledge` and `Funding` removed in `on004022` #1 (empty, not an alteration).
- **Recordings**: 59 annexed files with a new annex key in `on003343` #3 (BDF header repair); 41 annexed `.vhdr` turned into regular files in `on003029` #1; 5 annexed `_events.tsv` turned into regular files in `on004703` #1; 15 annexed `.fdt` pointers moved with the same key in `on004306` #1.
- **Provenance**: all five repositories sampled (`on002578`, `on004703`, `nm000501`, `on004551`, `nm000201`) carry `v1.0.0`; the tag lookup (`git ls-remote --tags origin`) takes 0.40 to 0.43 s; the tag's commit is an ancestor of the merge base and its trees are already local.
  In every pull request that changes a README, the repository's root commit has no README at all (OpenNeuro's "Dataset created" commit, or a DataLad "new dataset" commit), so the root commit is no anchor.
- **Cost**: Part B facts take about 35 ms per pull request plus the 0.4 s tag lookup.

---

# Part A: the mechanical change summary

## 2. Scope and keying

### 2.1 What is summarized

A changed path is a **summary candidate** when all of these hold:

- its status in `git diff --raw -z --no-renames --no-abbrev <mergeBase> <head>` is `M` (not `A`, `D` or `T`);
- `classifyPath` puts it in `dataset_description`, `participants` or `sidecars` (the readable areas less `readme_and_changes`, which Part B reads as prose);
- both modes are `100644` or `100755` and equal;
- the path ends in `.tsv` or `.json` (lower case, as the BIDS names are);
- the platform did not prove it cosmetic (`isCosmeticChange`, unchanged).

A path is read for the **relocation pools** (never summarized, never shown) when its status is `A` or `M`, its after mode is regular, it ends in `.tsv` or `.json`, and it sits anywhere in the tree, `sourcedata/` and `derivatives/` included.

(Phase 4, as built.
The raw listing is `git diff --raw -z --no-renames --no-abbrev`, not `--abbrev=40`: `--no-abbrev` writes full ids however long they are, so a repository whose ids are not 40-hex fails the strict parse (`parseRawEntries` refuses anything but six-digit octal modes, two 40-hex ids and a status of `A`, `M`, `D` or `T`, and a path given twice) and nothing is proven cosmetic or summarized, instead of reading abbreviations.
A candidate is a file the cosmetic check compares: modified on the change list and `M` in the raw listing, both modes regular and equal, a lower-case `.tsv` or `.json`, among the first `MAX_COSMETIC_CHECKS` (2,000) such files in review order, with both blobs read, and not proven cosmetic; then `classifyPath` must not say `readme_and_changes`.
So `README.json` and `CHANGES.tsv` are not candidates, nor is `.JSON` (wanted, but never compared), nor anything under `sourcedata/` or `derivatives/` (not wanted at all).
The pool is built in path order from the raw listing, removals left out.
An added or modified `.tsv` or `.json` whose after mode is regular is read, its before side only when it is modified.
Any other `.json` entry (a type change, a symlink or a submodule at the head) is handed to the pool as a document that cannot be read, and so is a `.json` whose after side, or whose before side when it is modified, could not be read: it still stops a key from being read as moved past it.
A `.tsv` with a side that could not be read is left out, so nothing can be found kept in it.
A before side that could not be read is never passed as missing, which would say the file was added.)

(Phase 4 review fix.
The pool is no longer every added or modified `.tsv` and `.json`: it is pruned to the files a candidate can consult, by one predicate, `poolFileMatters(candidatePaths)` in the pure module (section 4.6).
A table is read only when it is `sourcedata/<D>/<a candidate's path>`, and a JSON document only when it applies to some candidate under BIDS inheritance (`sidecarApplies`); since no candidate is under `sourcedata/` or `derivatives/`, nothing there is read but a candidate's sourcedata copy.
`changeSummary` skips the blobs of every other file before `readBlobs`, and `summarizeChanges` prunes with the same predicate, so a caller that passes more is protected too.)

**Not summarized, and why.**

- Added files: they cannot remove anything, and today an unread added file does not set `readIncomplete`; that stays.
- Removed files: any removal already lowers `no_degradation` in `factsOf`.
- Type changes and symlinks: there is no text on one side.
- `.tsv.gz` and every other extension, README and CHANGES (Part B), files over the caps, files a parser refuses, files whose bytes do not round-trip: all stay on today's raw-diff path, read if they fit, unread (and so `readIncomplete`) if they do not.

### 2.2 Table keys

A table's key column comes from its BIDS file name and nothing else.

| File | Key column |
| --- | --- |
| `participants.tsv` at the root | `participant_id` |
| `*_channels.tsv` | `name` |
| `*_electrodes.tsv` | `name` |
| `*_scans.tsv` | `filename` |
| `*_sessions.tsv` | `session_id` |
| `samples.tsv` at the root | `sample_id` |
| anything else (`*_events.tsv`, `*_beh.tsv`, phenotype tables, ...) | none |

The key is used only when the column is in both headers and its values are non-empty, not `n/a`, and unique on both sides.
Otherwise the table is diffed keyless.

**Keyless tables** are compared as a multiset of rows projected on the common columns (section 4.5).
No key is ever inferred from the data.

*Rejected:* inferring a key (the first column whose values are unique) lets the author choose the key by choosing values; an ordered line diff (LCS) is quadratic on hostile input unless capped, and describes reordering as removal plus addition; a compound key for `samples.tsv` (`sample_id` with `participant_id`) adds a case for one rare table, and the uniqueness check already falls back safely.

### 2.3 JSON documents

A JSON file is flattened to **leaves**:

- an object recurses into its keys; an empty object is a leaf;
- an array whose elements are all scalars is one leaf whose value is the array's canonical text; an empty array is a leaf;
- an array with any object or array element recurses with index paths `[0]`, `[1]`, ...;
- a scalar is a leaf.

A leaf's **path** is the sequence of keys and indices, written with `.name` when the key matches `^[A-Za-z_][A-Za-z0-9_]*$` and `["..."]` (JSON-escaped) otherwise, so the encoding is injective.
A leaf's **value** is canonical JSON text: strings decoded and re-encoded with `JSON.stringify`, numbers exactly as their token was written (`1.0` and `1` differ, `1e400` is kept as text), keys in source order.

---

## 3. Parsing

Both parsers run on the blob's bytes, are single-pass and linear, allocate at most a constant factor of the input, and either return a value or one closed **refusal** word.

### 3.1 TSV

1. More than `maxBlobBytes` (8 MiB): `too_large`.
2. Any NUL byte: `nul_byte`.
3. Decode as UTF-8 with `TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`; failure: `invalid_utf8`.
4. A leading U+FEFF is removed and recorded as `bom`.
5. Split on `\n`; an empty last element means a final newline (recorded), and is dropped.
6. On every terminated line, one trailing `\r` is removed and counted; any other `\r`, or a `\r` ending the unterminated last line: `bare_cr`.
   Line endings are recorded as `lf`, `crlf`, `mixed` or `none`.
7. No line left: `empty`.
8. Header = first line split on `\t`.
   An empty column name: `empty_column_name`; a repeated one: `duplicate_column`.
9. Every other line split on `\t` must have exactly the header's number of cells: otherwise `ragged_row`.
   More than `maxRows` (200,000): `too_many_rows`, reported only when no row was ragged.
   (Added in the Phase 1 review: in a table with ONE column an empty or all-space line is `ragged_row`, decided before the row loop, because csv readers skip an empty line and pandas a line of only spaces, so two readers would disagree about the rows; with two or more columns every reader agrees.)
10. Any cell or header name that **starts** with `"`: `quoted_cell`.
    BIDS tables do not quote, but pandas does at a field's start, so a file that two readers would split differently is refused instead of guessed.
11. **Round trip**: `serializeTsv(parse(bytes))` must equal `bytes` exactly (BOM, the recorded line endings per line, final newline); otherwise `no_round_trip`.
    This is the precondition of the coverage proof (section 6.2): the parse loses no byte.

`mixed` line endings round-trip because the serializer keeps, per line, whether it had a `\r`; the format class records only the file-level style.

### 3.2 JSON

A strict recursive-descent parser over the decoded text (same steps 1 to 4 as TSV), iterative or depth-bounded:

- RFC 8259 grammar only: `NaN`, `Infinity`, comments, trailing commas, single quotes and leading zeros are `not_json`;
- a key repeated in one object: `duplicate_key` (JSON.parse silently keeps the last one, which is how a file says two things to two readers);
- nesting deeper than `maxJsonDepth` (64): `too_deep`; more than `maxJsonNodes` (200,000) values: `too_many_nodes`;
- numbers are kept as their token text; strings are decoded (the six-character escape for a capital A and a plain capital A are the same string).

Whitespace is not a JSON difference (the cosmetic proof handles a reindent).
A file whose tree is equal but whose token text differs beyond whitespace (a respelled escape) gets the format class `json_respelled`.
(Phase 2 note: `json_respelled` is deferred to phase 3.
The parser keeps no token text to compare, so the change model's format words are `bom`, `line_endings`, `line_ending_pattern` and `final_newline`, declared as the type `FormatDetail`; phase 3 adds the fifth word with the renderer that shows it.)
(Phase 3: `summarizeChanges` adds `json_respelled` when `canonicalJson` of the two trees is equal and the two texts, without their byte order mark and with the whitespace between tokens removed by `stripJsonSpace`, differ.
It is information only, with no before or after state.
It is decided only on equal trees: a respelled escape in a document that also changed a value is not reported, since the respelled value is equal for every reader.
A JSON document's other layout atoms (`bom`, `line_endings`, `final_newline`) come from `formatAtoms` in `summarizeChanges`, outside the JSON diff's totality check; a table's come from its diff, once.)

### 3.3 Encodings

A side that is not valid UTF-8 is refused in slice 1.
Slice 4 adds one exception, for the before side only: bytes that are not UTF-8 are decoded byte for byte as Latin-1 and the file gets the format class `encoding_repaired` ("the old file was not UTF-8; its bytes are shown as Latin-1").
An after side that is not UTF-8 is always refused: making a file unreadable is never summarized away.
Measured: 391 of the 393 refusals on the open set are `invalid_utf8` on the before side (`on006233` #2 stores `μV` in Shift-JIS, bytes `83 CA`).

---

## 4. The change model

### 4.1 Atoms

Each summarized file yields atoms of these kinds, each with a **role**.

| Kind | Role | Meaning |
| --- | --- | --- |
| `column_removed` | loss | A column of the before header is not in the after header; carries the count of non-missing values lost |
| `row_removed` | loss | A before row is matched to nothing after and was not relocated |
| `json_key_removed` | loss | A leaf with a non-missing value is gone and was not renamed or moved |
| `row_relocated` | relocated | A before row was removed and appears verbatim in a row the pull request adds at `sourcedata/<one directory>/<its path>` (section 4.6) |
| `json_key_moved` | relocated | A leaf was removed, the same path and value appear in a JSON file of the pull request that applies to this file by BIDS inheritance, and this file no longer has the leaf's top-level key (section 4.6) |
| `key_relabeled` | modification | A keyed row's key changed by a relabel rule (section 4.3), with the evidence of section 4.4 |
| `cell_templated` | modification | A cell changed by a relabel rule of kind `wrap`, `strip` or `repad` (a case change in a cell is `cell_replaced`) |
| `cell_replaced` | modification | A cell changed from one non-missing value to another |
| `cell_emptied` | modification | A non-missing cell became missing |
| `json_value_changed` | modification | A leaf's value changed, type kept |
| `json_type_changed` | modification | A leaf's value changed type (`"1"` to `1`) |
| `json_emptied` | modification | A non-missing leaf became missing |
| `json_key_renamed` | modification | A leaf moved to a sibling key with the same value, unique within its parent on both sides, whose name folds to the same (case and punctuation) or matches by a relabel rule (section 4.7) |
| `json_empty_key_removed` | modification | A leaf whose value was missing was removed |
| `rows_reordered`, `columns_reordered`, `json_keys_reordered` | modification | Order changed, content kept (for tables, decided over every paired row, so a keyless row paired as an edit counts too) |
| `format` | modification | BOM, line endings, final newline, `json_respelled`, (slice 4) `encoding_repaired` |
| `column_added`, `row_added`, `cell_filled`, `json_key_added`, `json_filled` | additive | New content, or a missing value filled |

**Missing** means exactly: a TSV cell equal to `n/a` or empty; a JSON `null`, `""`, `"n/a"`, `[]`, `{}`, or an array whose every element is one of these.
The set is deliberately narrow: a wider one (`None`, `unknown`, `NA`) would turn the overwrite of a real value into "filled", which is additive and needs no display.

### 4.2 Classes and the normal form

A **class key** is the tuple `(kind, shape, field, rule)`:

- `shape` is the path with every BIDS entity value replaced by `*` in every segment (`sub-*/ses-*/ieeg/sub-*_ses-*_task-*_acq-*_run-*_channels.tsv`), computed by a new `entityPattern(path)`: replace `(^|[/_])([a-zA-Z]+)-[a-zA-Z0-9]+(?=[/_.])` with `$1$2-*`.
  It is coarser than `pathPattern` (which keeps `task-` and `acq-`), because one edit across tasks is still one edit; the class line says how many files.
- `field` is the TSV column name, the JSON leaf path with indices replaced by `[*]` for value kinds, or the JSON **parent** path for `json_key_removed` and `json_key_added` (so 214 HED entries removed from one object are one class whose pairs are the key names and values).
- `rule` is the relabel rule (section 4.3) for `key_relabeled` and `cell_templated`, the detail word for `format`, the target shape for `row_relocated`, the old and new names for `json_key_renamed`, null otherwise.

**Value pairs are not part of the key.**
A class holds the multiset of its distinct `(before, after)` value pairs with counts (for `row_removed`, the removed key or row text; for `json_key_removed`, `name = value`).
So two files with the same logical change land in the same class whatever their line offsets, unrelated rows, row counts or subject labels, and an edit that differs gets its own pair or its own class.

**The key as built (phase 3).**
The class key is the JSON text of `[kind, shape, field, rule, detail]`, built by `classKeyOf`:

- `shape` is `entityPattern` of the file's own path for every kind; a `row_relocated` atom's target shape is already its `detail`.
- `field` is the column for a table kind (never folded: a column name is the author's text) and, for a JSON kind, the atom's path with every array index written `[*]` by `foldIndices`, which passes a bracketed key (`["[0]"]`) over whole: the leaf path for the value kinds, the parent path for the key kinds (the phase 2 atom conventions).
- `rule` is the relabel rule for `key_relabeled` and `cell_templated` only, compared by its fields in a fixed order.
- `detail` is in the key for `format` (the word), `row_relocated` (the target shape) and `json_key_renamed` (`old -> new`) only.
  A removed column's count of non-missing values, a JSON key's name and every value are what a class is made of, so they are not in the key.

A pair is the text `before + U+0000 + after` for the kinds shown by pairs (`cell_replaced`, `cell_emptied`, `json_value_changed`, `json_type_changed`, `json_emptied`) and `text + U+0000` for the removals (`row_removed`: the key or the row's cells joined with a tab; `json_key_removed` and `json_empty_key_removed`: `name = value`).
No after side can hold U+0000 (a table refuses a NUL byte and canonical JSON escapes it), so the last U+0000 is the separator, while a JSON key name may hold one.
`DISPLAY_OF` records, per kind, whether it is shown by `pairs`, `removals`, `rule` or is `additive`; like `ROLE_OF` it is a `Record`, so a new kind does not compile without it.
Examples are the first atom of each of the first two files in review order, or the first two atoms when the class is in one file.
`classify` orders classes by section 5.1.

### 4.3 Relabel rules

`relabelRule(before, after, { chars })` returns the first rule that holds, or null; every rule is a function from the before string, so a class of one rule describes every member exactly.

1. `case`: equal after `toLowerCase()`.
2. Split each string into **runs**: a maximal run of letters (`\p{L}`), a maximal run of digits (`\p{N}`), or a single other character.
   At most 24 runs and 128 characters (each side checked on its own), else no rule.
3. `wrap` or `strip`: the shorter string's runs appear contiguously in the longer one's runs, digits compared by value (`01` equals `1`); the rule is the text before and after, plus `repadded` when a digit run's padding differs.
   With empty prefix and suffix and `repadded`, the rule is `repad` ("only the zero padding of numbers changed").
   **Decimals** (phase 2 review, decision D4): a digit run directly before or after a `.` or `,` is compared by its text, not its value, wherever runs are compared.
   So `0.05` to `0.5`, `A1.05` to `A1.5` and `0.05 Hz` to `0.5 Hz` get no `repad`: a tenfold change must never read as formatting.
   **Joined numbers** (phase 3 review): a digit run joined to another digit run (scanning from it in either direction over runs that are one other character each, the first run that is not one is a digit run) is part of one number written with a separator, so `5 000` to `5 0`, `1'000` to `1'0000`, `1_000` to `1_0000`, `0·05 Hz` to `0·5 Hz` and `1٫05` to `1٫5` get no `repad` either; no list of separators is kept.
   A letter anywhere between two digit runs breaks the join, so `sub-01_ses-02`, `0100 Hz`, `EEG 001` and `x_02_y` still repad.
   **The pair decides, by an allowlist** (phase 3 review, replacing the run-by-run reading of D4 and the two-character list of decimal marks): a pair compares its digit runs by VALUE only when, in BOTH strings, every digit run is ASCII and each of its two sides is one of: the edge of the string; a run of ASCII letters that is not one letter with a digit run beyond it; or one space, hyphen or underscore with the edge or such a letter run beyond it (a digit run beyond the separator joins the two, and anything else beyond it is not on the list).
   Any other neighbor (a dot, a comma, any other punctuation, symbol or space, a format or combining character, a non-ASCII letter or digit, a single letter between two numbers) puts the WHOLE pair in text mode: every digit run of both strings is compared by its text, so no rule between them can say a number kept its value.
   A list of marks could never be complete (the Arabic decimal separator, a fullwidth full stop, a letter-like apostrophe, a word joiner after a dot, `0p05` in a BIDS name each hid a tenfold change behind "zero padding changed"), so no character is named except the allowed ones.
   `sub-01_ses-02`, `0100 Hz`, `EEG 001`, `x_02_y`, `E001`, `ECOG1` and `Fp1` still repad; `0.05`, `5 000`, `1'000`, `1e05` and `05 Hz` to `.5 Hz` do not, the last because the mark can be in the text a rule adds, which is why the pair, not the run, decides.
   Compared as text, a rule that rebuilds the string exactly is still found and never carries `repadded` (`07 Hz` to `.07 Hz` is the prefix `.`).
   The lookup of section 4.4 indexes every key by its digits' values, so it finds every candidate either reading could accept, and the rule decides.
4. `insert` or `delete`: the shorter string's runs appear in order in the longer string, a digit run only as a whole digit run of the same value, a letter or other run preferably where it starts and ends on a run boundary of the longer string, else at its first occurrence after the previous match; the rule is the list of inserted texts and the shape (`L`, `D`, `O` per run).
   `GA01` to `EEGGA_01REF` is `"EEG" + letters + "_" + digits + "REF"`.
   **Anchor** (D2): the string with fewer runs must contain at least one digit run, the anchor.
   Names with no digit run get no `insert` or `delete` rule, so `Cz`/`FCz` and `Pz`/`POz` get none from this rule.
   `case`, `repad`, `wrap` and `strip` are unchanged by this.
5. Only when `chars` is true: the shorter string is a character subsequence of the longer one (`DCEMBRACE` to `DC EMBRACE-REF`); the rule is the inserted text after each character position.
   **Whole runs** (D1): every inserted or deleted text must consist of whole runs of the longer string (the leftmost subsequence is used, and a pair that only another alignment would describe in whole runs gets no rule).
   This keeps `DCEMBRACE` to and from `DC EMBRACE-REF` (the space and `-REF` are runs of the longer name) and rejects `A1`/`A10`, `sub-2`/`sub-12`, `sub-1`/`sub-10`, `Cz`/`FCz` and `Pz`/`POz`, where the inserted text would join a run that was already there.
   **No split numbers** (phase 2 delta review, D13): a non-empty gap between two kept characters that are both digits is no rule, in either direction, so `LA12`/`LA1-2`, `LA12`/`LA1-LA2`, `E10`/`E1.0` and `sub-12`/`sub-1-2` are removals and additions; the text would split one number into two or merge two into one.

**No numbers in the added or removed text** (D14).
A `wrap`, `strip`, `insert`, `delete` or character rule whose gap text holds a digit (`\p{N}`) is no rule, whichever rule found it: a number put in or taken out is never a respelling.
So `A1` and `A2` removed with `A1-A2` added are two removals and an addition, and `A1-A2` to `A2` is a removal and an addition, while `A01` to `POL A01`, `GA01` to `EEGGA_01REF`, `1` to `sub-1` and `DCEMBRACE` to `DC EMBRACE-REF` keep their rules.
This holds for cells too: a cell that gains `-A2` is `cell_replaced`.

Numeric pairs (both sides match `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`) never get a rule: `64` to `640` is a replaced value, not "suffix 0 added".
For cells, only `wrap`, `strip` and `repad` are rules (D5); `case`, `insert`, `delete` and character rules are for keys alone.
A cell's case is part of its value (`mV` to `MV` is millivolts to megavolts), so a case change in a cell is `cell_replaced` and its pair is shown.

A rule is a function of the before value except for what `case`, `repad` and the `repadded` flag leave open: they say a spelling changed (which letters are upper case, how many zeros pad a number), never what the new spelling is.

**Residual, stated plainly.**
A rule says only that a pair *could* be one name respelled.
Whether a table pairs it is decided by the evidence of section 4.4, and a pair the rules and the evidence allow is shown to the model as a relabel with its rule and its every changed cell.
The model still sees `insert`, `delete`, `wrap` and `strip` pairs it must judge, the ones whose added text holds no digit: `FC3` to `FCC3h` or `C3` to `CCP3h` (letters matched inside a longer letter run, anchored by the digit), `C3` to `C3h`, `Fz` to `Fz Cz`, each with at least one equal cell that says something and no more changed cells than equal ones.
Those are shown exactly; they are not hidden, but the platform does not decide whether they are one row.
The evidence is weak exactly where these pairs arise: in a real `channels.tsv`, columns such as `type`, `units` and the filter cutoffs are the same on every row, so a removed electrode and an unrelated new one have every other cell equal and the strict evidence holds (`FC3` removed with `FCC3h` added pairs as a relabel).
The model sees the exact pair; phase 3 decides how a small, isolated relabel class is surfaced.

### 4.4 Keyed tables: the pairing order

For a keyed table, with `gone` the before keys absent after (in before order) and `added` the after keys absent before (in after order):

1. **Strict relabel by lookup.**
   For each added key, in after order, enumerate the whole key and its substrings that start and end on run boundaries, longest first then leftmost; look each up (digits normalized, lower case) among unpaired gone keys; take the first candidate that meets the strict evidence below and for which `relabelRule(gone, added, { chars: false })` holds.
   Then the same from each gone key to the added keys (the `strip` direction).
2. **Strict relabel by position.**
   Walk the unpaired gone keys and unpaired added keys with two pointers; pair `(g, a)` when the strict evidence holds and `relabelRule(g, a, { chars: true })` holds; otherwise skip `a` if `g` pairs with the next added key, else skip `g` if the next gone key pairs with `a`, else skip both.
3. **Relocation** (section 4.6) of every still-unpaired gone row.
4. **Lenient relabel**: steps 1 and 2 again with the lenient evidence below and `chars: false`.
5. What is left: gone keys are `row_removed`, added keys are `row_added`.

**Evidence** (phase 2 review, decision D3, replacing the earlier "other common cells all equal" and the `strongEvidence` helper).
Let OTHERS be the non-key common columns; for a candidate pair, EQ is the number of OTHERS cells that are equal and not missing, DIFF the number that differ.
A cell equal only because both sides are missing proves nothing about whose row it is, so it counts toward neither.

- Rules of kind `case` and `repad` need no evidence: they change how a key is spelled, never which key it is.
  The strict passes still take them only with DIFF 0, so a row whose cells are all equal is paired before a look-alike whose cells changed; the lenient passes take them whatever the cells.
- Every other kind (`wrap`, `strip`, `insert`, `delete`, the character rule): in a strict pass DIFF is 0 and EQ is at least 1; in a lenient pass EQ is at least DIFF and EQ is at least 1.

So a table of ids alone, or of `n/a`, has no evidence, and `1` removed with `sub-1` added is a removal and an addition; `FC3 EEG uV` to `FCC3h MISC mV` and `LA1 SEEG uV 0.5` to `LA1-LA2 BIP mV 1` are removals and additions; `DCEMBRACE` to `DC EMBRACE-REF`, `A01` to `POL A01` and `GA01` to `EEGGA_01REF` with their other cells equal and not missing are relabels.

**Bounds** (D10).
A lookup looks at no more than 64 candidates, counting the ones already paired, and passes a paired prefix of a candidate list with a cursor that only moves forward, so the work of one lookup does not grow with what was paired before it.
The four relabel passes of one file share one step budget, `maxPairingSteps` (section 5.2): a substring looked up costs one step, and a candidate pair tried costs a fixed part plus one step per 8 characters of the two keys and per 8 compared cells, and one per 8 pairs of runs (the rules match the runs of one name against the runs of the other; D16).
Rule 4 finds the occurrence of a letter or other run that starts and ends on run boundaries among the runs of the longer name (such an occurrence is always a whole run), so its cost does not grow with how often the text repeats.
When the budget is spent no further pair is made, and whatever is unpaired is removed and added, exactly as if no rule had held: the budget can only show more change, it never pairs a row it did not check, and it is spent in the same order on every run.
Measured on a laptop: 100,000 case variants of one word relabel in about 0.2 s; the costliest crafted tables that fit in 8 MiB spend the whole budget in about 0.75 s (100,000 keys of 23 runs tried against keys of 24, each failing only at its last digit) and 0.76 s (keys whose every substring is looked up and missed); legitimate 200,000-row relabels use 28% of the budget (a prefix stripped) to 66% (a prefix added with every age changed, so only the lenient pass pairs them).

Every pair, kept keys included, then has its common non-key cells compared (section 4.1), and the after positions of the paired rows, taken in before order, decide `rows_reordered`.

What this order cannot rule out is a removed row paired with an unrelated new row under a rule the evidence allows (section 4.3, residual).
Such a pair is a `key_relabeled` atom with its rule and every changed cell beside it, never a silent match.

Why this order: a relabel whose every other cell is equal is the strongest evidence that a row is the same row; a verbatim copy is the next strongest evidence that a row was removed on purpose; a relabel on the name alone is the weakest.
A mistake in this order can only turn "relocated" into "relabeled with changed cells" or into "removed", that is, into more visible change or into a loss fact; it can never make content vanish from the account (section 6.2).

### 4.5 Keyless tables

1. Rows are projected on the common columns (before order) and joined with `\t` (injective, since no cell holds a tab).
2. Multiset match: each after row takes the earliest unconsumed equal before row; the matched before indices, in after order, decide `rows_reordered`.
3. Relocation of each unmatched before row (full before row).
4. Two-pointer pairing of the remaining before and after rows, in file order, accepting a pair only when **at most half** of the common columns differ **and** EQ is at least DIFF, where EQ counts only the equal common cells that are not missing (D6); a paired row's differing cells become cell atoms.
   (The first condition follows from the second, since EQ + DIFF is at most the number of common columns; it stays as the statement of what an edit is.)
   It needs no step budget: it compares at most three pairs of rows per row, each over the common columns, so its work is bounded by the size of the table (a few million cell comparisons at the 8 MiB cap).
5. What is left: `row_removed` and `row_added`.

The half-columns condition makes a deleted event and an unrelated new event a removal plus an addition (a loss fact) instead of a "changed onset and trial type".
The EQ condition does the same where the equal cells are all `n/a`: `1.0 n/a go n/a n/a n/a n/a` and `9.3 n/a stop n/a n/a n/a n/a` differ in two of seven columns, but share nothing that says something, so they are a removal and an addition (case 20 of section 11).
A pair that meets both conditions is shown as an edit, its changed cells listed; the paired rows also count toward `rows_reordered`.

### 4.6 Relocation

The **row pool** is built before any file is diffed: for every pool file, the rows its after side has that its before side did not (the multiset difference when the headers are equal; all rows otherwise), keyed by `(path, header text, row text)` with a count.

A removed row of file `F`, with before header `H`, is **relocated** when some pool file `T` satisfies all of:

- `T` is exactly `sourcedata/<D>/<F>`, where `D` is one path segment with no slash and `F` is the full path of `F`: the layout the canary uses (`sourcedata/channels-removed-2026-10-18/<F>`) and nothing looser (D9).
  `sourcedata/<F>` itself (the file's own path one level down, where a dataset may keep a real table) and any deeper nesting (`sourcedata/a/b/<F>`) do not count, and `T` is never `F`;
- `T`'s after header equals `H` (the BEFORE header of `F`) exactly;
- `T` has an unconsumed pool row equal to the removed row; that count is decremented.

Two identical removed rows and one copy give one relocated row and one removed row.
A copy that differs in one byte (a redacted name) is not a relocation.
Owner Question A2 asks whether relocation elsewhere should also count; the default is no, and every relocation on the open set uses the corresponding path.

**Order.**
Since `T` names the one file it can serve, no two different files compete for a copy, and the order the files are diffed in does not change what either is told.
The pool lists the copies of one file in sorted path order, so which of two copies is taken does not depend on the order the pool was built from.
The caller (phase 3) still diffs the candidate files in sorted path order, so nothing about a run depends on the order git listed the files in; the only consumption that depends on order is a second diff of the same path against the same pool, which the caller never makes.
(Phase 3: `summarizeChanges` sorts the candidates by path in code-unit order and diffs them in that order.
A path given twice is refused as `internal_mismatch` every time it appears, so the one order-dependent consumption cannot happen.
The pool itself is passed to `buildPools` unsorted, which gives the same pools in any order; a mutation run showed a sort there was dead code.
Phase 4 review fix: `buildPools` now reads the files in path order itself, to decide which fit `maxPoolChars`, and that sort is not dead: dropping it turns the order tests red.
Phase 3 review: a pool path listed more than once contributes nothing at all, so no row or leaf of either entry is ever a copy and the removals they would explain stay removals; keeping the first entry made the pool depend on the order of the list. A JSON path listed twice is named unreadable rather than left out, so it still stops a move past it as a nearer sidecar would: left out, a key removed from a file and set by that nearer sidecar would read as moved to a farther one.)

**JSON moves.**
A removed leaf `(p, v)` of file `F` is `json_key_moved` when some added or modified JSON file `T` (not `F`) has leaf `p` with value `v` that it did not have before, and `T` **applies to `F` under BIDS inheritance**: `T`'s directory is `F`'s directory or an ancestor of it, `T` and `F` have the same suffix and extension (everything after the first dot), and every `key-value` entity of `T`'s name is in `F`'s name.
In addition (D7), `F`'s after document must be an object that does not contain the leaf's **top-level key** at all.
The BIDS validator merges sidecars one level deep: a nearer file that has a top-level key replaces the farther file's whole value under it, so a nested leaf removed from a key `F` keeps is gone for `F` however many sidecars hold it.
A leaf with no top-level key (the root of a non-object document) and a document that is no longer an object are never moved.
**The nearest changed sidecar decides** (phase 2 delta review, D12): the pool records the top-level keys of the after document of EVERY JSON file the pull request adds or modifies, whether it adds a leaf or not, and names the ones whose after document cannot be read.
Among the files that apply to `F` and have the leaf's top-level key (an unreadable one counts as having every key), the nearest is the one whose value `F` sees: the deepest directory first, then the most name entities.
The leaf is moved only if that nearest file is a home of the leaf (it holds the same path and value as a leaf it did not have before).
A tie between two equally near files is not decidable and means not moved, and so does an unreadable nearest file.
So `F` dropping `SamplingFrequency: 500` while the root sidecar gains `500` and the subject sidecar, nearer, has `250` (new, or already there with something else changed) is `json_key_removed`.
A nearer file that already held the same value before is not a home either, so that case is a removed key too: the conservative reading, and the same answer an unchanged nearer file gets.
Otherwise it is `json_key_removed`.

**Remaining limit of the move rule.**
A nearer sidecar that the pull request CHANGED is handled above.
An UNCHANGED sidecar between `T` and `F` (nearer to `F` than `T`) that has the top-level key also overrides the moved value, and the pure module, which reads only the files the pull request changed, cannot see it.
The move is then shown as `json_key_moved` though the value no longer reaches `F`.
The model prompt (section 8.4) tells the model that a moved key reaches the file only if no nearer sidecar that the pull request did not change has the same top-level key, so the model weighs that limit instead of the platform deciding it.

**Bounds of the pools (Phase 4 review fix).**
`maxTotalBytes` bounds the bytes read, not what the pools hold: a JSON leaf repeats its whole path, so a long top-level key over many tiny children made 1.75 MB of added JSON hold about 570 MiB of strings, and eight such files under `derivatives/` took a content pass to 5 GB of memory.
Two changes close it.

1. **Pruning.** A diff consults the pools for one candidate at a time, and only in two ways: a table diff reads the rows of the tables at `sourcedata/<D>/<its path>` (`sourcedataFor`); a JSON diff asks which file that applies to the candidate under `sidecarApplies` and has the leaf's top-level key, or is unreadable, is the nearest, and whether that file is a home of the leaf (`homes.includes(decider)`).
   No other table and no JSON file that applies to no candidate is ever a copy, a decider, a blocker or a home, so `poolFileMatters(candidatePaths)` keeps exactly the tables that are a candidate's sourcedata copy and the JSON files that `sidecarApplies` to some candidate, and leaving the rest out changes no decision.
   `.JSON` and other extensions were never pooled.
   A test summarizes 400 generated pull requests (JSON and table candidates at the root, in subject and session directories, under `derivatives/` and `sourcedata/`; sidecars at every level holding the lost leaves, unreadable ones, ones listed twice, unchanged ones; copies at the corresponding path and at paths that are not one) with the pruned pool and with every pool file, and requires the whole `ChangeSummary` (outcomes, classes, facts, accounted, loss, text) to be identical; it is, in all 400, and dropping any one kind of consulted file (root sidecars, intermediate ones, tables, blockers) changes between 41 and 88 of them, so the comparison can see each.
   The predicate indexes the candidates by extension, suffix and each ancestor directory, then by entity, so a pool path costs a lookup and a scan of the candidates holding its rarest entity.
2. **`maxPoolChars`** (32 Mi UTF-16 code units, section 5.2) bounds what the pools hold, over the whole pool: a table's header and each distinct new row (cells joined with tabs); a JSON document's top-level keys and, per new leaf, its path, its value and its `byLeaf` key.
   A file whose pieces would take the total past it is left out as one that cannot be read, and the next file is tried: a table is skipped (none of its rows is a copy, so a removal it would have explained stays a removal) and a JSON document is `unreadable` (never a home, and it stops every move past it), the same fail-closed words as a file that does not parse.
   A file is counted while it is read and dropped as soon as it passes what is left; an added document's walk itself stops there, so a document whose leaves pass the room before its walk reaches a path over `maxNameChars` is `unreadable` rather than kept for its top-level keys, the stricter of the two.
   Which files fit is decided in code-unit path order whatever the order of `files`; what fits is then added in the order given, which only orders the lists, so the pools still do not depend on the order of `files` (a shuffle test).
   `summarizeChanges` checks its deadline before each pool file it reads and returns the abandoned summary when it passes there, as at every other check.

### 4.7 JSON renames

A removed leaf and an added leaf are a `json_key_renamed` pair when they have the same parent path and the same value, and their last names are equal after lower-casing and removing every character that is not a letter or digit, or when `relabelRule(oldName, newName, { chars: false })` holds.
Punctuation with a digit on both sides is part of a number and is not removed by the folding (D15): `12` to `1.2` and `0.5` to `05` are a removed key and an added one, not a rename.
In addition (D8), the shared value must be **unique within its parent** in the before document and in the after document: a shared value is no evidence of which key became which, so with `go` and `go2` both `"Go"`, `go` removed and `go3` added is `json_key_removed` plus `json_key_added`, not a rename.
A removed leaf then has at most one candidate, and a relabel rule refuses a name over 128 characters before reading it, so the pass is linear in the document and needs neither a candidate cap nor the step budget of section 4.4.

---

## 5. Aggregation, order and bounds

### 5.1 Order

Classes render in this order: loss, then relocated, then modification, then additive; within a role, more files first, then more items, then the class key in code-unit order.
A class renders whole or not at all.

### 5.2 Bounds

```ts
export const SUMMARY_LIMITS = {
  maxBlobBytes: 8 * 1024 * 1024, // per file side
  maxRows: 200_000, // per table
  maxColumns: 10_000, // phase 3 review: per table; a wider header is too_large before it is split
  maxJsonDepth: 64,
  maxJsonNodes: 200_000,
  maxKeyChars: 128, // longer keys get no relabel rule
  maxNameChars: 1024, // phase 3 review: a longer column name, JSON key or JSON path refuses the file too_large
  maxRuns: 24,
  maxPairingSteps: 12_000_000, // per file: the pairing passes' work, in steps of about one lookup (section 4.4)
  maxTotalBytes: 256 * 1024 * 1024, // all blobs the summary reads in one run
  maxPoolChars: 32 * 1024 * 1024, // phase 4 review fix: what the relocation pools hold, in code units (section 4.6)
  maxSummaryChars: 30_000, // the fenced block
  maxClasses: 120, // classes rendered
  maxTrackedClasses: 5_000, // phase 3 review: classes a run may hold; a file that would pass it is refused too_large
  maxPairsPerClass: 12, // distinct value pairs rendered per class
  maxValueChars: 300, // per rendered value
  samplesPerClass: 2,
  timeReserveMs: 40_000, // stop summarizing when less than this is left of the content pass
} as const;
```

(Phase 3 review: `maxNameChars` is counted in UTF-16 code units and checked where a name is read, a table's header and a JSON key, and where a JSON path is joined, before any atom or class key is built from it, because every atom of a file can carry its column or path and the cost of a file would otherwise be its rows times its longest name.
It is above `maxValueChars` on purpose, so a name between 301 and 1,024 units is summarized and its cut class line makes it incomplete.
A top-level JSON key of exactly 1,024 units parses, but its path is 1,025 and refuses the file.)

### 5.3 Completeness

A rendered class is **complete** when:

- for a **paired** kind (`cell_replaced`, `cell_emptied`, `json_value_changed`, `json_type_changed`, `json_emptied`, `json_key_removed`, `json_empty_key_removed`, `row_removed`): every distinct pair is rendered and no rendered value was cut at `maxValueChars`;
- for a **rule** kind (`key_relabeled`, `cell_templated`, `json_key_renamed`, `row_relocated`, `json_key_moved`, `column_removed`, the three reorder kinds, `format`): the class line is rendered (the rule is the full description; examples only illustrate);
- an **additive** kind is never needed for coverage, rendered or not.

(Phase 3, the stricter reading: a class whose class line was cut is incomplete whatever its kind, because a rule describes its members only if the reader can read which column or key it applies to.
The line is cut when its shape, a relocation's target, its field, a rename's names or a rule's added text is cut by `renderValue`.
Phase 3 review: every path is rendered by `renderValue` too, an example's file path included, and a cut example path cuts the class line as well, since a path is a token of the block's grammar; a value cut inside an example changes nothing.)

### 5.4 At the bounds

- A class that does not fit is not rendered, its number does not appear, and `classes_cut` counts it; the fenced block ends with `(N more change classes not shown)` (`(1 more change class not shown)` for one, phase 3 review).
  (Phase 3: rendering stops at the FIRST class that does not fit `maxClasses` or `maxSummaryChars`, so the shown classes are always a prefix of the order of section 5.1 and a later, smaller class is never shown in place of an earlier one; room for the closing count line is kept from the start, so the block never exceeds `maxSummaryChars`.)
- A paired class with more than 12 distinct pairs renders 12 and the line `(N more distinct values not shown)` (`(1 more distinct value not shown)` for one), and is incomplete.
- A file over a per-file cap is refused; a run over `maxTotalBytes` stops reading at the cap and the files not read are refused (`too_large`).
  (Phase 3: the pure module counts the bytes of both sides of each candidate in sorted path order; the file that would pass the cap and every later one are refused `too_large`, even a small later one. The pool's bytes are bounded by the caller's blob reader, `readBlobs`.
  Phase 4 review fix: what the pools hold is bounded by `maxPoolChars`, and only the files a candidate can consult are read at all (section 4.6).)
- **If the summary pass reaches its deadline, the whole summary is abandoned**: no file is accounted for by it, nothing of it is shown, and `change_summary.abandoned` is true in the facts.
  All-or-nothing is simpler to prove than a partial account, and an abandoned summary leaves today's behavior.
  (Phase 3: the deadline is checked before each file with the caller's clock, and since the phase 3 review also after each file is folded in and once after the last file, before rendering; an abandoned summary has no outcomes, classes or text, and its loss facts are zero.)
- **A file whose atoms would make the run hold more than `maxTrackedClasses` classes is refused `too_large`, whole, and the run goes on** (phase 3 review): no atom, class or loss fact of it is kept, it is never accounted for and stays on the raw-diff path, and since the files are folded in sorted path order, which file is refused depends on nothing else.
  (A first version abandoned the whole run, as the deadline does; one JSON document with thousands of changed leaves then cost every other file its summary.)
  The files are folded into their classes one at a time, each file's keys computed once and counted before anything of it is folded, and each file's loss facts are added as it is folded, so a run holds its classes (counts, pairs and at most three atoms each, for the examples), never every atom of every file; the examples are rendered only for the first `maxClasses` classes, the only ones that can be shown.

---

## 6. The coverage rule

### 6.1 The rule

A wanted file (a changed file in a readable area, as `readableChanges` defines it) is **covered** when it is added, or proven cosmetic, or shown in full as a raw diff (folded repeats included, as today), or **accounted for by the summary**.

A file is **accounted for by the summary** when all hold:

1. it is a summary candidate (section 2.1);
2. both sides parsed with no refusal, and the TSV round trip held;
3. the summary pass finished (was not abandoned);
4. every non-additive class that contains one of its atoms is rendered and complete.

`readIncomplete` is true exactly when some wanted file that is not added is not covered.
`truncated` stays `listCut || readIncomplete`, in `buildEvidence`, unchanged.

**Fail-closed cases**, each tested (section 12): any refusal; a mode change; a type change; a symlink; a file the pass did not reach; an abandoned pass; a cut class; a class with unshown pairs; a value cut at 300 characters; any blob that could not be read (a missing object in `cat-file --batch` output is a refusal of that file, never an empty file).

### 6.2 Why no destructive change can hide in an accounted file

Let `F` be accounted for.

1. *The parse is complete.* Both sides round-trip byte for byte (TSV) or are token-faithful (JSON: equal trees mean equal values for every conforming reader, because duplicate keys are refused, numbers are compared as written and strings as decoded).
   So every difference between the two blobs is either a format difference (which is a `format` atom) or a difference of the parsed structures.
2. *The diff is total.* Every before row is, by construction of sections 4.4 and 4.5, exactly one of: matched by key or by equality, paired by a relabel rule or by the half-columns rule, relocated, or removed.
   Every after row is matched, paired, or added.
   Every column is common, removed or added.
   Every before leaf is unchanged, changed, emptied, renamed, moved, or removed; every after leaf is unchanged, changed, filled, renamed or added.
   Nothing falls through: the implementation asserts that the counts add up (before rows = matched + paired + relocated + removed; after rows = matched + paired + added) and refuses the file (`internal_mismatch`) if they do not.
   The tallies are counted from the fate of each row or leaf, and the assertion (D11) then counts the atoms that were emitted and requires them to agree, kind by kind: one `row_removed` per removed row, one `row_added` per added row, one `row_relocated` per relocated row, one `key_relabeled` per keyed pair, one cell atom per differing cell of a paired row, one atom per removed or added column, and the same for every JSON fate, with no atom of any other kind.
   So a dropped or an extra atom is refused too, not only a row that fell through.
   A reconstruction oracle written apart from the module (`test/pr-review-change-model.unit.test.ts`) rebuilds the before version from the after version and the atoms on 6,000 generated tables and 6,000 generated documents.
3. *Every non-additive atom is in a class that was shown exactly.* A rule is a function of the before value (section 4.3), a pair list is complete (section 5.3), a relocation names the target shape and was checked byte for byte.
   So for every piece of before content the model has seen either "unchanged", or the exact rule or pair that produced its after value, or "removed" (and the platform has added a loss fact for an unrelocated or unkept removal).
4. *Additive atoms remove nothing.* They add rows, columns, keys or values where there were none.

Therefore a loss in `F` is either a `row_removed`, `column_removed` or `json_key_removed` atom (a platform loss fact), or a change shown exactly to the model (a value replaced, a cell emptied, a relabel, a relocation into `sourcedata`), which the model judges as it would judge the raw diff.
The pairing heuristics choose only *which* exact description is shown; a wrong choice makes more change visible or adds a loss fact, never less (section 4.4).

What the rule does **not** claim: that the model judged a shown change correctly.
That is the same trust the raw-diff path places in the model today, bounded by the facts.

---

## 7. Loss and relocation facts

### 7.1 Definitions

Per summarized run:

```ts
export interface LossFacts {
  /** row_removed atoms, and the number of files they are in. */
  rowsRemoved: number;
  rowsRemovedFiles: number;
  /** row_relocated atoms. */
  rowsRelocated: number;
  /** column_removed atoms whose column held at least one non-missing value. */
  columnsRemoved: number;
  /** json_key_removed atoms, and their files. */
  keysRemoved: number;
  keysRemovedFiles: number;
  /** json_key_moved atoms. */
  keysMoved: number;
  /** cell_emptied and json_emptied atoms. */
  valuesEmptied: number;
  /** The first file, in review order, with a blocking atom; for the finding's `path`. */
  firstBlockingPath: string | null;
}
```

Loss facts are computed for **every** summarized file, whether or not it was also shown as a raw diff, so a pull request is held to the same rule at 3 files and at 3,000.

### 7.2 Which facts block

| Fact | Effect (default) |
| --- | --- |
| `rowsRemoved > 0` or `columnsRemoved > 0` | platform finding `data_removed`, blocker, `no_degradation`: cannot pass (Owner Question A1) |
| `keysRemoved > 0` | platform finding `metadata_removed`, blocker, `no_degradation`: cannot pass |
| `rowsRelocated`, `keysMoved` | information in the facts and the summary |
| `valuesEmptied` | information; the exact pairs are shown (Owner Question A3) |
| relabels, replacements, reorders, format | information; shown exactly |

A removal can be right (a privacy correction, a channel that was never recorded), so it lowers to `unknown` and a person confirms it, exactly as the existing file-removal rule in `factsOf` does.

### 7.3 Platform findings, the shared mechanism

A **platform finding** is a `ReviewFinding` the job's script builds from platform facts, never from a model, just as `UNEXPLAINED_TEXT_FINDING` is today.

- It always has `severity: "blocker"` and `criterion: "no_degradation"`.
- Its note is a fixed template with numbers only, under `NOTE_MAX` (200), for example: `The platform found 62 rows removed from 14 tables and not copied unchanged into sourcedata at the same path. A person confirms a removal.` (137 characters), and for keys: `The platform found 214 keys with values removed from 1 JSON file and not kept, with the same value, in a sidecar that applies by inheritance. A person confirms a removal.` (170 characters)
- Its `path` is `LossFacts.firstBlockingPath` (passed through `safePath` by the parser like any finding's) or null.
- At most **three** platform findings exist in one report (Part A rows and columns, Part A keys, Part B), and they are placed **first** in `findings`.
- `assembleReport` becomes `[...platform, ...modelFindings.slice(0, MAX_FINDINGS - platform.length - added.length), ...added]`.
- `settle` trims the **last** findings to make room for criteria that fail with no finding; in a full report `genuine_contribution` passes, so at most five criteria can need such room, and `MAX_FINDINGS - 5 = 3` first findings always survive.
  (Phase 5 review fix: the plain cut could leave the review's only reason for a failing criterion out, and `settle` then trimmed the script's own findings to explain it, so a stored report did not parse back to itself. As built, the room is what eight leaves after the platform's and the script's findings and after one place for each failing criterion no finding names, the review's first finding on each failing criterion is kept before its others, in its order, and the dropped-finding lowering reads the findings not kept; ADR 0109 records it. Round 2 of that review: a failed text judgment's reason is the review's own only when it is on that judgment's criterion with one of its codes, and that reason is then always kept in the place of the script's finding, which closed a case where the script's finding was left out for a reason the cut then dropped.)

Why this cannot be lost or raised: `settle` lowers a criterion with a blocker finding from `pass` to `unknown` **before** it trims findings, so even a trimmed note has already done its work; the stored report holds the lowered criterion, so the Worker's re-derivation (`parseStoredPrReviewReport`, `verdictOf`) gives the same verdict; the model's output is sliced before the platform findings are added, so no model output can push one out; and a finding can only lower.

Part B uses the same mechanism and also lowers `no_degradation` to `fail` itself for its two rule facts (section B4), before calling the parser, which is a lowering the script is allowed to make.

*Rejected for slice 1:* a new evidence field for the loss counts.
It would let the check render the counts and the calibration read them, but it changes `EVIDENCE_V2_KEYS` (every reader, stored-row compatibility, a parser-first release) for no change in the verdict; it is offered as slice 4.
*Rejected:* folding an unrelocated or unkept removal into `truncated`; the check would then tell the author "some files were not shown", which is false and gives no way forward.

---

## 8. The prompt

### 8.1 Facts block additions

`buildReviewMessages` adds one key to the existing `trusted` object (outside every fence):

```ts
change_summary: {
  abandoned: boolean;
  files_summarized: number; // parsed without refusal
  files_not_summarized: number; // candidates refused, with no reason words
  files_accounted_for: number;
  classes_shown: number;
  classes_cut: number;
  rows_removed_not_found_elsewhere: number;
  rows_removed_found_verbatim_in_sourcedata: number;
  columns_with_values_removed: number;
  keys_removed_not_found_elsewhere: number;
  keys_moved_to_an_inherited_sidecar: number;
  values_emptied: number;
  /** One platform-made line per shown class: number, kind words, counts, completeness. */
  classes: string[]; // e.g. "C2 rows relabeled | 14135 items in 125 files | in full"
}
```

The kind words come from a closed table (`KIND_WORDS`), the counts from the platform, and the completeness from section 5.3 (`in full`, `not shown in full`); no attacker text is in this block.
(Phase 3 review: the incomplete word was `values not all shown`; it is `not shown in full` because a class is also incomplete when a token of its line is cut, and the word must not name a cause the block does not have.)
(Phase 3: `classTable` writes `1 item` and `1 file` in the singular; `KIND_WORDS` gives every kind its own words, so a line names its kind exactly.)
`fence()` already breaks any `<facts>` text inside fenced material, so the class table cannot be forged from a value.

The existing `changed-metadata-groups` block gains a column, `accounted for by the summary`, and `PathGroup` gains `summarized: number` (an internal type, not in the report).

### 8.2 The fenced block

A new block after the groups block and before the diffs:

```ts
fence(
  "changed-metadata-summary (class, path shape, field, rule, values, examples)",
  nonce,
  summary.text || "(none)",
)
```

Each class renders as:

```text
C<n> | "<shape>" | <column "x" | key "path" | under "parent"> | <kind words>[: <rule>]
    "<before>" -> "<after>" x<count>          (paired kinds, at most 12 lines)
    (<k> more distinct values not shown)      (when cut)
    e.g. "<path>" row "<key>" -> "<new key>"  (at most 2)
```

**Value rendering** (`renderValue`), so that what the model sees is unambiguous:

- cut to 300 code points, then quote the kept text with `JSON.stringify` (which doubles backslashes, so a value cannot imitate an escape the platform writes), then replace every remaining character in `\p{C}`, `\p{Z}` or `\p{Default_Ignorable_Code_Point}`, and U+2800, other than U+0020, with `\u{XXXX}` (this order, decided in Phase 1);
- when the value was cut, `...(cut)` follows the closing quote, so a value cannot forge it, and the class is incomplete;
- pairs that are equal after NFC normalization but not byte for byte (a precomposed letter against the letter and a combining mark) render alike and need the annotation below too (Phase 2);
- when a pair's two rendered texts are equal after the fence's own replacements, or differ only in escaped characters, append `(first difference at character k: U+XXXX to U+YYYY)`, computed on the raw values.

Paths and shapes are rendered with `renderValue` too (phase 3 review; the design first said `tidyPath`): a path is always one quoted token, so ` | `, quotes, the platform's own words or an invisible character in a path cannot add a field, a line or a look-alike path.
Nothing from the pull request can start a line: values are escaped, so a newline in a value is `\n`.

**As built (phase 3).**
The class line is `C<n> | "<shape>" | <field> | <kind words>[: <rule>]`, where the field part is `column "x"` for a table, `key "<leaf path>"` (or `the whole document`) for a JSON value kind, `under "<parent path>"` (or `top level`) for a JSON key kind, and absent for the kinds without a field; the rule part is the relabel rule's words, `to "<target shape>"` for a relocation, the quoted `old -> new` of a rename, or the format word.
An example line is `e.g. "<file path>"` and what in that file changed (`row "<key>"`, `"<before>" -> "<after>"`, `key "<name>"`, a column's count, a layout change).
The shape, a relocation's target, every example's file path, column names, JSON paths, rename names and a rule's added text are rendered with `renderValue` (a rule's added text is put where `ruleWords` puts its quotes), so each path is one quoted token and a zero-width prefix and the six characters that spell its escape read differently.
A cut in any of them, the example paths included, makes the class incomplete (section 5.3).
A pair line is `"<before>" -> "<after>" x<count>`, a removal's `"<text>" x<count>`; the twelve shown are the most frequent, then by text.
A pair gets the first-difference note when its rendered texts are equal, when its raw values differ only in characters the renderer escapes, when they are equal after NFC, or when they first differ at a character outside ASCII (so a Latin `a` and a Cyrillic one are annotated, case 10 of section 11); the last condition covers the NFC one, which is kept as the design states it.

### 8.3 The example, computed from a run shaped like `on004551` #1

Regenerated (phase 3 review) from a real run of the summary on the `on004551`-shaped test of `test/pr-review-change-summarize.unit.test.ts`, at 125 channel tables of 200 rows: names gain `POL `, four names in every table but the last are wrapped in `EEG ` and `-Ref`, three rows of every second table move verbatim to `sourcedata/channels-removed-2026-10-18/<same path>`, the kept rows are reversed, and two rows are added.
The real pull request has the same five classes with its own counts (1,203 relocated rows in 56 files, 14,135 and 341 relabels, 2,043 added rows); the text below is the synthetic run's, character for character.

Facts (774 characters):

```json
"change_summary": {
  "abandoned": false,
  "files_summarized": 125,
  "files_not_summarized": 0,
  "files_accounted_for": 125,
  "classes_shown": 5,
  "classes_cut": 0,
  "rows_removed_not_found_elsewhere": 0,
  "rows_removed_found_verbatim_in_sourcedata": 186,
  "columns_with_values_removed": 0,
  "keys_removed_not_found_elsewhere": 0,
  "keys_moved_to_an_inherited_sidecar": 0,
  "values_emptied": 0,
  "classes": [
    "C1 rows removed and found verbatim in a row this pull request adds | 186 items in 62 files | in full",
    "C2 rows relabeled | 24318 items in 125 files | in full",
    "C3 row order changed | 125 items in 125 files | in full",
    "C4 rows relabeled | 496 items in 124 files | in full",
    "C5 rows added | 250 items in 125 files | in full"
  ]
}
```

Fenced block (1,576 characters):

```text
C1 | "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv" | column "name" | rows removed and found verbatim in a row this pull request adds: to "sourcedata/channels-removed-2026-10-18/sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv"
    e.g. "sub-002/ses-01/ieeg/sub-002_ses-01_task-sleep_run-01_channels.tsv" row "B13"
    e.g. "sub-004/ses-01/ieeg/sub-004_ses-01_task-sleep_run-01_channels.tsv" row "B13"
C2 | "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv" | column "name" | rows relabeled: added prefix "POL "
    e.g. "sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_run-01_channels.tsv" row "A1" -> "POL A1"
    e.g. "sub-002/ses-01/ieeg/sub-002_ses-01_task-sleep_run-01_channels.tsv" row "A1" -> "POL A1"
C3 | "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv" | row order changed
    e.g. "sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_run-01_channels.tsv"
    e.g. "sub-002/ses-01/ieeg/sub-002_ses-01_task-sleep_run-01_channels.tsv"
C4 | "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv" | column "name" | rows relabeled: added prefix "EEG " and suffix "-Ref"
    e.g. "sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_run-01_channels.tsv" row "Fp1" -> "EEG Fp1-Ref"
    e.g. "sub-002/ses-01/ieeg/sub-002_ses-01_task-sleep_run-01_channels.tsv" row "Fp1" -> "EEG Fp1-Ref"
C5 | "sub-*/ses-*/ieeg/sub-*_ses-*_task-*_run-*_channels.tsv" | column "name" | rows added
    e.g. "sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_run-01_channels.tsv" row "POL E"
    e.g. "sub-002/ses-01/ieeg/sub-002_ses-01_task-sleep_run-01_channels.tsv" row "POL E"
```

Total 2,350 characters (about 700 tokens), against the 80,000 characters of diffs it replaces in the real pull request.
The README and CHANGES diffs are still shown raw, and the remaining patch budget shows up to three accounted files as illustration (section 8.5).

### 8.4 The system prompt

`REVIEW_SYSTEM_PROMPT` gains one paragraph, inserted after the sentence that ends "never by a heading."; `V3_RULES` and every sentence a test pins stay word for word.

> The change summary. The platform parsed the changed .tsv and .json files before and after the change and put every difference it found into change classes. The class table in the facts (change_summary.classes) is the platform's: its class numbers, kinds, counts and completeness are reliable. The changed-metadata-summary block gives, for each class number, the path shape, the column or key, the exact rule (for example a prefix added to every name, or each distinct value before and after with how many times it changed) and up to two examples; its text is the pull request's own and is material to review. A class describes every one of its items exactly, so judge the change from its rule: you do not need to see each file. A file whose changes all sit in classes shown in full counts as shown in full, and changed_metadata_not_shown_in_full already accounts for every other file. Rows, columns and keys removed without the same content appearing elsewhere in this pull request are counted in the facts and have already been reported to a person; say what was removed. Rows found verbatim in sourcedata still exist in the dataset at the place named; judge whether moving them there loses anything for a user of the dataset. A relabel, a replaced value or an emptied value is not a loss by itself: judge whether it makes the dataset less correct or less usable, and check that the CHANGES entry and the description account for it. A relabel says the platform paired a removed key with a new one under a rule and enough equal cells; judge from the rule and the changed cells beside it whether the two are one row, and treat a pair that is not as a removal. A key moved to a sidecar that applies by inheritance has been checked against every sidecar this pull request changed, nearer ones included; it still reaches the file only if no nearer sidecar that this pull request did not change has the same top-level key, which the platform cannot see, so weigh that from the path shape. A summary marked abandoned was not used.

(Phase 5 review fix.
The paragraph as built is the one above with the corrections of the Phase 5 plan, and three more from its review.
A removal is a platform blocker when it is in a file the summary summarized, at 3 files or at 3,000, whether or not that file was also shown as a diff; a removal in a file the summary refused (a ragged row, a repeated key, a file over a cap) has no atoms and no loss fact, so it is read from its diff by the model as before, and when that diff is not shown in full the pull request is incomplete as before.
So the sentence on removals ends: "Only files the summary summarized (change_summary.files_summarized) are counted there: a removal in any other file, the refused ones (change_summary.files_not_summarized) among them, is shown only in its diff, and judging it is yours."
And the coverage sentence begins "A file the summary summarized counts as shown in full", since a refused file has no classes and would otherwise read as vacuously shown in full.
The refused files are named as among the other files, not as all of them, because `files_not_summarized` counts only the candidates the summary refused: it is 0 for an abandoned summary, and the README, the change log, removed files and files past the 2,000 cosmetic checks are among the files in neither count.)

### 8.5 Interplay with the raw-diff path

`readContent` reads in this order:

1. the batched prefetch (unchanged);
2. `rawEntries` (one `git diff --raw` with object ids, replacing `modesByPath`);
3. the cosmetic proofs, now on blobs from one batched read (`cat-file --batch-check` for the sizes, then `cat-file --batch`: two processes in all) instead of two `git show` processes per file;
4. the summary, under its deadline;
5. the raw diffs: first every wanted, non-added, non-cosmetic file that the summary did **not** account for, in review order, with `diffSignature` folding exactly as today (`MAX_PATCH_FILES` 40, `MAX_PATCH_TOTAL_CHARS` 80,000, `MAX_DIFFS_EXAMINED` 500, `FOLD_TIME_RESERVE_MS`); then, while room is left, accounted files in review order, at most `MAX_ILLUSTRATION_PATCHES` (3), whose truncation does not matter;
6. `readIncomplete`, groups, the change log.

A small pull request whose every diff fits is therefore shown both its diffs and its summary, which is what the model has been calibrated on plus exact counts.

(Phase 4, as built.
The summary starts only when its clock says less than `gitDeadline - timeReserveMs` (the content pass's end less 40 seconds); otherwise it is the shared `ABANDONED_SUMMARY` and nothing of it is read.
The clock is `ContentOptions.now`, a parameter of `gatherContent` that only tests pass; every git call's timeout and the search for repeats keep the real clock.
The cosmetic batch has no deadline of its own, so a stall there is `timed_out`, as a stalled `git show` was.
The pool's batch has the summary's line as its own deadline: a read that fails, or is still running at the line, is `CallExpired` (never `timed_out`), and the summary is `ABANDONED_SUMMARY` while the pass goes on.
A summary that reaches its line while it runs is abandoned by `summarizeChanges` itself.
An abandoned summary accounts for nothing, so the raw path reads the pull request exactly as it would without one; three tests pin that by building the same 125-table pull request and checking the not-started, the abandoned-midway and the stalled-pool runs against each other and against values worked out by hand.
The raw diffs run in three lists: the removed and modified files the summary did not account for (counted toward `MAX_DIFFS_EXAMINED`, and stopped as before when the patches are full and the pass is short of time); then the first `MAX_ILLUSTRATION_PATCHES` accounted files in review order, each only while a patch slot and characters are left and the pass is not short of time, not counted toward `MAX_DIFFS_EXAMINED`, folding onto a shown diff like any other; then the added files, counted and stopped as the first list.
With nothing accounted for, the first and the last list are the old list in the old order, so the raw path is unchanged.
Added files stay after the illustrations: on a pull request like `on004551` the added files would otherwise take every slot.
`readIncomplete` adds "accounted for by the summary" as a third way a file is covered; an accounted file whose illustration is cut stays covered.
`PathGroup.summarized` counts a group's accounted files (not its parsed ones).)

---

## 9. Evidence, Worker and check text

- **No change to `ReviewEvidence`, `EVIDENCE_V2_KEYS`, `REPORT_VERSION` or `parsePrReviewReport` in slice 1.**
- `files_read` in `buildEvidence` becomes the size of the union of the files shown in full (a patch not cut, and the `same` files it carries) and the files accounted for by the summary.
  It never exceeds `files_changed` (the parser's invariant), and a file that is both shown and accounted for counts once.
- `truncated` keeps its meaning and its formula.
- The check sentence `The content of X of Y changed files was read.` stays true: the platform read every accounted file and gave the reviewer an exact account.
  Slice 4 may add `files_summarized` to the evidence so the sentence can say how many were summarized; stored rows without it would read as zero, which is only less informative.
- **Slice 1 also adds three finding codes to `FINDING_CODES`, accept-only**: `original_text_altered`, `original_field_altered`, `recording_replaced`, with their `CODE_LABEL` entries, and adds them to the exclusion list of `REVIEW_FINDING_CODES` so the model is never offered them.
  Nothing emits them until slice 2, so a job of slice 2 never meets a Worker that refuses them (ADR 0107's skew section).
- Stored version 1 and version 2 rows are untouched and re-derive the same verdict: no rule of `factsOf` changes.

### 9.1 Calibration script

`scripts/ci/pr-review-calibrate.ts` gains:

- `--evidence-only`: runs `gatherListing`, `gatherContent` and `buildEvidence` (no screen, no review, no Anthropic key needed, so it refuses nothing about keys) and prints, per pull request, `files`, `wanted`, `cosmetic`, `summarized`, `accounted`, `refused`, `classes`, `cut`, `summary chars`, `unread`, `truncated`, the loss counts, the Part B counts, and the pass timings; closed words and numbers only.
- in the normal mode, the same columns through an evidence observer passed to `reviewPullRequest` (`observeEvidence?: (s: EvidenceStats) => void`), beside the stage observer.

This is how the calibration set of section 12.4 is run without spend.

---

## 10. Types, signatures and integration points

### 10.1 New module `scripts/ci/pr-review-summary.ts` (pure: no git, no I/O)

```ts
export const SUMMARY_LIMITS: { /* section 5.2 */ };

export const SUMMARY_REFUSALS = [
  "too_large", "nul_byte", "invalid_utf8", "bare_cr", "empty", "empty_column_name",
  "duplicate_column", "ragged_row", "quoted_cell", "too_many_rows", "no_round_trip",
  "not_json", "duplicate_key", "too_deep", "too_many_nodes", "blob_missing",
  "internal_mismatch",
] as const;
export type SummaryRefusal = (typeof SUMMARY_REFUSALS)[number];

export interface TextFormat {
  bom: boolean;
  eol: "lf" | "crlf" | "mixed" | "none";
  /** Mixed tables only: one character per terminated line, "1" for CRLF and "0" for LF; "" otherwise (always "" for JSON). */
  crPattern: string;
  finalNewline: boolean;
}
export interface Table {
  format: TextFormat;
  /** Per line, whether it ended in CR, so the round trip is exact. */
  crByLine: readonly boolean[];
  header: readonly string[];
  rows: readonly (readonly string[])[];
}
export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: SummaryRefusal };

export function parseTsv(bytes: Uint8Array): Parsed<Table>;
/** parseTsv with the round-trip serializer passed in: for tests of the guard only. */
export function parseTsvWith(bytes: Uint8Array, check: (table: Table) => Uint8Array): Parsed<Table>;
export function serializeTsv(table: Table): Uint8Array;

export type JsonValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: string }
  | { t: "str"; v: string }
  | { t: "arr"; v: readonly JsonValue[] }
  | { t: "obj"; keys: readonly string[]; v: ReadonlyMap<string, JsonValue> };
export function parseJson(bytes: Uint8Array): Parsed<{ value: JsonValue; format: TextFormat }>;
export function canonicalJson(v: JsonValue): string;

export function entityPattern(path: string): string;

export const CLASS_KINDS = [/* the kinds of section 4.1 */] as const;
export type ClassKind = (typeof CLASS_KINDS)[number];
export type ClassRole = "loss" | "relocated" | "modification" | "additive";
export const ROLE_OF: Readonly<Record<ClassKind, ClassRole>>;
export const KIND_WORDS: Readonly<Record<ClassKind, string>>;

export interface RelabelRule {
  kind: "case" | "wrap" | "strip" | "repad" | "insert" | "delete";
  /** wrap/strip: [prefix, suffix]; insert/delete: one text per gap; case/repad: []. */
  gaps: readonly string[];
  /** insert/delete: run classes ("LDO...") or "c<length>" for a character rule. */
  shape: string;
  repadded: boolean;
}
export function relabelRule(before: string, after: string, opts: { chars: boolean }): RelabelRule | null;
export function ruleWords(rule: RelabelRule): string;

export interface ChangeClass {
  /** Stable within a run: the JSON text of [kind, shape, field, rule, detail]. */
  key: string;
  kind: ClassKind;
  shape: string;
  field: string | null;
  rule: RelabelRule | null;
  detail: string | null;
  files: ReadonlySet<string>;
  items: number;
  /** "before\u0000after" -> count, for paired kinds. */
  pairs: ReadonlyMap<string, number>;
  examples: readonly string[];
}

export interface SummaryCandidate {
  path: string;
  before: Uint8Array;
  after: Uint8Array;
}
export interface PoolFile {
  path: string;
  before: Uint8Array | null; // null for an added file
  after: Uint8Array;
}
export interface FileOutcome {
  path: string;
  family: "tsv" | "json";
  refusal: SummaryRefusal | null;
  keyColumn: string | null;
  classKeys: ReadonlySet<string>;
}
export interface SummaryFacts { /* section 8.1, without `classes` */ }
export interface ChangeSummary {
  abandoned: boolean;
  files: readonly FileOutcome[];
  /** In render order. */
  classes: readonly ChangeClass[];
  /** Class keys rendered, and those rendered completely. */
  shown: ReadonlySet<string>;
  complete: ReadonlySet<string>;
  accounted: ReadonlySet<string>;
  loss: LossFacts;
  facts: SummaryFacts & { classes: string[] };
  /** The fenced block's text (author text inside, escaped). */
  text: string;
}

/**
 * Summarize the modified candidates against the pools. `now` and `deadline` let the caller stop it;
 * past the deadline the result is `abandoned` and accounts for nothing.
 */
export function summarizeChanges(input: {
  candidates: readonly SummaryCandidate[];
  pool: readonly PoolFile[];
  deadline: number | null;
  now?: () => number;
}): ChangeSummary;

export function renderValue(v: string, max?: number): { text: string; cut: boolean };
export function firstDifference(a: string, b: string): string | null;
export const EMPTY_SUMMARY: ChangeSummary; // abandoned: false, nothing in it
```

Phase 3 also exports the pieces `summarizeChanges` is built from, each tested on its own: `DISPLAY_OF` (how each kind is shown completely), `foldIndices`, `classKeyOf`, `classify`, `renderClasses`, `accountedFiles`, `lossFactsOf` with `NO_LOSS`, `classTable`, `summaryFacts`, `stripJsonSpace`, and `summarizeChangesWith`, which takes the two totality checks so a test can prove that a diff the check rejects is refused (`internal_mismatch`) and accounts for nothing.
Phase 4 review fix: `poolFileMatters(candidatePaths): (path: string) => boolean` is exported (section 4.6), and `summarizeChangesWith` takes it as a third parameter, `keep`, defaulting to it, so a test can run a summary that keeps every pool file and compare.

### 10.2 `scripts/ci/pr-review-evidence.ts`

```ts
export interface RawEntry {
  status: "added" | "modified" | "removed" | "typechange";
  modeBefore: string;
  modeAfter: string;
  oidBefore: string; // 40 hex, zeros for an absent side
  oidAfter: string;
  path: string;
}
/** `git diff --raw -z --no-renames --no-abbrev`; null when git cannot say. Replaces modesByPath. */
function rawEntries(dir: string, mergeBase: string, head: string): RawEntry[] | null;

/**
 * Read blobs with two processes: `git cat-file --batch-check` for every id's size (no content),
 * then `git cat-file --batch` for the ids within `maxBytes` each and `maxTotalBytes` together, in
 * the order given. A `missing` answer, or a blob over a cap, is absent from the map, which its
 * caller treats as a refusal (`blob_missing` or `too_large`), never as an empty file. Bounded by
 * the pass budget like every git call. After the prefetch every changed blob is local; a blob that
 * is not (Part B's anchor README) is fetched lazily by git, one round trip each.
 */
export function readBlobs(
  dir: string,
  oids: readonly string[],
  caps: { maxBytes: number; maxTotalBytes: number },
): Map<string, Buffer>;
```

`runGit` gains an optional `input: Buffer` for the batch's stdin.
`ContentFacts` gains:

```ts
summary: ChangeSummary; // EMPTY_SUMMARY when there were no candidates
original: OriginalContentFacts | null; // Part B, null in slice 1
```

`PathGroup` gains `summarized: number`.
`readContent` follows section 8.5; `buildEvidence` computes `files_read` as in section 9.

**As built (phase 4).**

```ts
/** Per-call bounds of runGit; a call past its own deadline is CallExpired (module-private, not an EvidenceError). */
interface GitCallOptions { input?: Buffer; deadline?: number; maxBuffer?: number }
function runGit(dir: string, args: string[], encoding: "utf8" | "latin1" | "buffer", call?: GitCallOptions): string | Buffer;

export interface RawEntry { /* as above */ }
/** Pure: the parse of `git diff --raw -z --no-renames --no-abbrev`, by path; null for anything git did not write. */
export function parseRawEntries(raw: string): Map<string, RawEntry> | null;
function rawEntries(dir: string, mergeBase: string, head: string): Map<string, RawEntry> | null;

/** Null when the answer was not had or cannot be trusted (`deadline` is the call's own). */
export function readBlobs(
  dir: string,
  oids: readonly string[],
  caps: { maxBytes: number; maxTotalBytes: number },
  deadline?: number,
): Map<string, Buffer> | null;

export const MAX_ILLUSTRATION_PATCHES = 3;
export interface ContentOptions { now?: () => number }
export function gatherContent(dir: string, listing: Listing, options?: ContentOptions): ContentFacts;
```

- `runGit` takes the pass's time left and the call's own, and uses the smaller as the timeout; the pass running out is `timed_out` as before, the call's own deadline running out first is `CallExpired`, which `tryGit` and `tryGitBytes` turn into null.
  Standard input is closed unless the call has `input`.
- `readBlobs` drops every id that is not 40 lowercase hex and the zero id before any process starts, so `HEAD` or a `rev:path` never reaches git's input, and takes each id once, in the order first given.
  `cat-file --batch-check` answers with each id's type and size; an id that is `missing` or is not a blob is left out, and so is a blob over `maxBytes`; the first blob that would pass `maxTotalBytes` and every id after it are left out (the summary's own prefix rule).
  `cat-file --batch` then reads the rest, its output bounded by their sizes; a header, a size or a terminator that is not what the first answer said is null for the whole read.
  Left out is never an empty buffer.
- The cosmetic batch reads with `maxBytes` and `maxTotalBytes` both at `SUMMARY_LIMITS.maxTotalBytes` (256 MiB), so a cosmetic proof never depends on the summary's 8 MiB per-file cap; the pool reads with `maxBlobBytes` per blob and what is left of the 256 MiB after the cosmetic batch, never re-reading a blob the cosmetic batch read.
- `ContentFacts.summary` is in; `original` is slice 2's.
  `ABANDONED_SUMMARY` (pure module) is the one addition to `pr-review-summary.ts`: shared, frozen, abandoned and empty, so the caller says "not started" or "could not read the pool" without faking a deadline.
- `files_read` is the size of the set of the accounted paths, every patch's own path, and the `same` paths of every patch that was not cut; it is at most `files_changed` because every member is a path of the change list, and it equals the old sum when nothing is accounted for.
- The test helper `ShimRule` gains `fromCall`, so a test can stall the third `cat-file` and not the first two.
- Phase 4 review fix: `changeSummary` reads only the pool files `poolFileMatters` keeps, so a file no candidate can consult costs no `cat-file` input and none of the 256 MiB; `ShimRule` gains `stdinLog`, which records what a batch call was asked about, and a real-git test shows no blob of such a file is requested.
- Measured on the 125-table fixture of the tests (twelve rows each, 189 changed files; medians of five runs on a laptop): the content pass took 2.08 s before this phase (250 `git show` processes for the cosmetic check), 0.79 s with the batched cosmetic check alone, and 0.17 s with the summary, which accounts for the 125 tables and leaves 5 diffs to read instead of 127.
  At 200 rows a table the same three are 2.10 s, 0.81 s and 0.24 s.
  On a blob-less clone of a 20-table fixture, the content pass started 15 git processes: one `--numstat`, one `--raw`, four `cat-file`, two `ls-tree` and two `show` of `CHANGES` for the change log, and five `-U2` diffs (`README.md`, `CHANGES` and three illustrations).

### 10.3 `scripts/ci/pr-review-prompt.ts`

- `buildReviewMessages`: the `change_summary` facts, the new fenced block, the groups column.
- `REVIEW_SYSTEM_PROMPT`: the paragraph of section 8.4.
- New `platformFindings(summary: ChangeSummary, original: OriginalContentFacts | null): ReviewFinding[]` (at most three, section 7.3 and B4).
- `assembleReport(screenOutput, reviewOutput, evidence, usage, platform: readonly ReviewFinding[] = [], lowerToFail = false)`: platform findings first; `lowerToFail` sets `no_degradation` to `fail` before parsing (Part B rules only).

### 10.4 `scripts/ci/pr-review.ts`

`reviewPullRequest` passes `platformFindings(all.summary, all.original)` and the Part B rule flag to `assembleReport`, and calls `observeEvidence` when given.
Nothing else changes; the screen and facts stages read no content and get no platform findings.

### 10.5 `shared/pr-review.ts`

Slice 1: the three finding codes (accept-only) and their labels.
No other change.

---

## 11. Adversarial review of Part A

Each case names how the design answers it; the test of section 12 that pins it is in brackets.

1. **A removed row hidden among thousands of relabels.**
   Every before row ends in exactly one bucket and the counts are asserted (section 6.2); a removed row is a `row_removed` atom and a platform finding whatever surrounds it. [`removed row among 500 relabels`]
2. **A destructive relabel disguised as a harmless one.**
   A relabel class is one rule for all its members; a row relabeled differently is in another class, shown separately; a key changed to something unrelated gets no rule and becomes removed plus added.
   A rule that changes a key's text needs evidence from the rest of the row (section 4.4), and a character rule inserts only whole runs, so `A1` removed and `A10` added are never one channel. [`relabel rules`]
3. **Removing a row and "relocating" it to a junk file.**
   Relocation counts only into `sourcedata/.../<same path>` with the same header and the same bytes (default); a copy elsewhere, or a copy with one byte changed (the real `on007119` redaction), is a removal. [`relocation is exact and corresponding`]
4. **Stealing another file's relocated copy.**
   Relocation is per file into its own corresponding path; two identical removed rows need two copies. [`two removed one copy`]
5. **Duplicate keys.**
   A duplicated key value makes the table keyless (multiset), which cannot lose a row; a duplicated JSON key refuses the file. [`duplicate key value`, `duplicate JSON key`]
6. **A TSV that does not parse the way the platform thinks.**
   Quoted cells, bare CR, ragged rows, NUL, invalid UTF-8 and a failed round trip are refused and go to the raw path. [`parseTsv refusals`, `round trip`]
7. **A file that is TSV by name but binary.**
   NUL, invalid UTF-8 or ragged rows refuse it. [`binary named tsv`]
8. **Filling the summary to push a loss out of view.**
   Loss classes render first; a class that does not fit is cut whole and its files are not accounted for; additive classes, which may be cut freely, render last. [`loss classes first`, `cut loss class`]
9. **Too many distinct values.**
   More than 12 distinct pairs in a paired class make it incomplete. [`incomplete pairs`]
10. **Look-alike and invisible characters.**
    `good` to `good` with a zero-width space inside it, and a Latin `a` to a Cyrillic `a` (U+0430), render escaped or with a first-difference note; trailing spaces in cells are data and show inside the quotes. [`look-alike values`]
11. **Huge cells and huge files.**
    A value over 300 characters makes its class incomplete; a file over 8 MiB or 200,000 rows is refused; the run stops at 256 MiB read. [`caps`]
12. **Hostile JSON.**
    Depth 10,000, a million nodes, `NaN`, `1e999`, duplicate keys, a respelled escape: refused, kept as text, or a `json_respelled` format class. [`parseJson refusals`]
13. **Type change.**
    `"1"` to `1` is `json_type_changed` with the canonical texts, which show the quotes. [`type change`]
14. **Rename or case-only rename of a file.**
    `--no-renames` makes it a removal and an addition; the removal rule already applies. [existing tests]
15. **A JSON key moved somewhere it no longer applies.**
    A move counts only into a sidecar that applies by BIDS inheritance, and only when the file no longer has the key's top-level key; elsewhere, or under a top-level key the file keeps, it is a removed key. [`json moved needs inheritance`]
16. **Slow input to time out the review.**
    The summary is abandoned at its deadline (all-or-nothing) and the raw path runs as today; an abandoned summary never accounts for anything.
    Within one file, the relabel passes share a step budget and the keyless and JSON rename passes are linear (section 4.4), so no input makes one file's diff slow, and what the budget leaves unpaired is removed and added. [`deadline abandons`, `pairing budget`]
17. **A value that forges a class line or the facts.**
    Values are escaped (no newline), paths are quoted and escaped like values (phase 3 review; first `tidyPath`ed), the class table is in `<facts>`, and `fence()` breaks `<facts` and `<untrusted` in fenced text. [`forged class line`]
18. **Steering text in a cell.**
    It reaches the model only inside the fence, where the trust-boundary rule applies as to any content. [existing fence tests]
19. **A mode or type change riding on a content change.**
    Not a candidate; raw path. [`mode change is not summarized`]
20. **A keyless table where one event is deleted and another added.**
    The half-columns rule, and the rule that equal missing cells are no evidence, make it a removal plus an addition. [`keyless pairing`]

---

## 12. Cost, performance, tests and calibration

### 12.1 Partial-clone cost

- The prefetch `git diff --numstat <mergeBase> <head>` already asks for every changed blob in one batched fetch; the summary's blobs are a subset (pool files included, since they are changed files).
  Measured on a fresh blob-less clone, the first content pass of `on004551` took 3.7 s and a second one, with the blobs local, 3.2 s; for `on006910` (495 blobs, 4 MB) 13.5 s and 11.7 s.
  So the network fetch costs 0.5 to 1.8 s; the rest is today's two `git show` processes per cosmetic check (1,536 processes on `on006910`) and one `git diff` per raw read.
- After the prefetch, `cat-file --batch` reads everything from the local store: 10 to 30 ms.
  Replacing the two `git show` processes per cosmetic check with the same batch removes up to 4,000 process starts on a 2,000-file pull request, which is the largest time saving in this design.
- Parse, diff and classify are linear: 0.45 ms per file on average over the open set (2.6 s for 5,907 files), 0.74 ms on the largest (567 ms for 768 files).
  For 2,000 files expect under 2 s on a laptop and under 4 s on a runner.
- Relabel lookups are bounded by 24 runs and 128 characters per key (at most 300 substrings per key) and positional passes are linear.
  Every relabel pass of a file spends from one step budget (`maxPairingSteps`, section 4.4), and the keyless and JSON rename passes are linear, so the relabel work of one file is bounded; past the budget, what is unpaired is removed and added.
  A JSON document is the exception to a short diff: its parse, flatten and diff are linear in its leaves but each leaf repeats its path (up to 1,024 characters), so a modified document of 200,000 leaves under one long key takes 1.5 to 2 s and about 1 GB transient (see Memory).
- **Budget**: the content pass keeps its 120 s (`EVIDENCE_BUDGET_MS.content`); the summary starts only if more than `timeReserveMs` (40 s) remain and abandons itself at that line, which leaves the raw path its own 20 s reserve as today.
  No new budget enters the job's worst case (ADR 0107's 45.4 minutes are unchanged), and `test/pr-review-workflow.test.ts` needs no new term.
- **Memory**: `maxTotalBytes` (256 MiB) bounds the bytes the summary reads, and `maxPoolChars` (32 Mi code units) what its pools hold; the largest open pull request read 20.6 MB.
  (Phase 4 review fix.
  The first sentence used to say that `maxTotalBytes` bounds what the summary holds; for the pools it did not, since a JSON leaf repeats its path: eight added 1.75 MB documents under `derivatives/` took the content pass to 2.8 s and 5.1 GB of memory, and 24 to 12 GB.
  Measured after the fix with `/usr/bin/time -l` on a laptop: those eight and 24 documents are pruned unread, 70 ms and 92 ms with a peak of 24 and 25 MiB, about what the reader took before Phase 4 (63 ms and 98 ms, 22 MiB); seven documents of the same kind (a 587 KB list of empty objects under one long key) that do apply to a candidate, 173 ms and 239 MiB (4.1 GB before the fix); 32 tables of 7.6 MB at `sourcedata/<D>/<candidate>`, 2.2 s and 1.4 GB (3.0 GB before).
  The worst case of ADDED documents is 256 MiB of hostile JSON that applies to candidates (462 documents of 587 KB): 6 to 11 s and a peak of 2.4 to 2.5 GB, and the same 2.4 GB with `maxPoolChars` set to 0, so that peak is the parser's work on 256 MiB of JSON at the read cap, not what the pools hold.
  Round 2 of the review corrected the claim that this is the worst case: a MODIFIED hostile document is walked whole, as a pool file (`jsonPart` cannot know which of its leaves are new before it has walked them) and as a candidate (`diffJson`), and neither walk is bounded by `maxPoolChars`.
  Measured with a 590 KB document under one long key whose 199,996 elements all change type, through the real `gatherContent` on a 64 GB laptop: 8 modified candidates 11.6 s and a peak of 7.2 GB, 24 candidates 34.5 s and 6.8 GB, 100 candidates 81.4 s and 8.5 GB with the summary abandoned at its line; 60 such files as pool files only, 5.4 GB.
  That laptop figure is the JavaScript engine sizing its heap from the machine's memory, not live data: in a `oven/bun:1.4.3-debian` container with a memory limit equal to its swap limit, 8 and 40 candidates completed at 2.82 and 2.85 GB under a 3.5 GB cap (a plateau, since the garbage is collected between files), 8 candidates at 1.55 GB under 1.8 GB, and one under 1.2 GB.
  So memory plateaus at about 1 GB per file in flight plus the collector's slack, and time is what ends the run: the summary is abandoned at its line and the raw path takes over.
  The walk of a modified document is not bounded by characters because a bound on a candidate would refuse it `too_large`, which changes which files are summarized and is a rule for the owner, not a memory fix; no real sidecar is anywhere near it.
  The predicate of section 4.6 costs one lookup and a scan of the few candidates holding the rarest of a sidecar's entities per pool path, and it runs twice per pass (once in the evidence reader, to skip reading, and once in `summarizeChanges`, to prune whatever else is given): a contrived pull request of 2,000 candidates in two disjoint entity groups and 200,000 root sidecars that each take one entity from both costs 4.6 s per pass, which the 40 s reserve absorbs, and needs 200,000 changed JSON files.)

### 12.2 Real-git tests (no mocks; the style of `test/pr-review-evidence.test.ts`)

New `describe("the change summary")` in `test/pr-review-evidence.test.ts`, each building a repository with real `git` and running the real `gatherListing`, `gatherContent`, `buildEvidence` and `buildReviewMessages`:

- `a bulk channels.tsv relabel across 125 subjects is accounted for and read as complete`: 125 tables, rows renamed with `POL ` and with `EEG `/`-Ref`, 3 rows per file copied to `sourcedata/channels-removed-X/<same path>`, rows added and reordered; expects `readIncomplete` false, `files_read` 127, five classes, no platform finding, the class table in the facts and the values only inside the fence.
- `a removed row among 500 relabels is a blocker finding and the verdict is uncertain`.
- `a relocated copy that differs in one byte is not a relocation`.
- `two identical removed rows and one copy: one relocated, one removed`.
- `a table the parser refuses is read as a raw diff, and counts as unread when the diff does not fit`.
- `a file both shown and accounted for counts once in files_read`.
- `a summary cut by its character bound leaves the cut classes' files unread`.
- `an abandoned summary leaves the evidence exactly as without it` (budget override).
- `a mode change, a type change and a symlink are never summarized`.
- `a value that forges a class line or a facts block stays inside the fence`.
- `the platform findings come first, survive eight model findings, and only lower`.

New `test/pr-review-change-summary.unit.test.ts` for the pure module:

- `parseTsv refuses quoted cells, bare CR, ragged rows, duplicate and empty column names, NUL and invalid UTF-8, and files over the caps`;
- `parseTsv round-trips every file it accepts, byte for byte` (generated tables with BOM, CRLF, mixed endings, no final newline);
- `parseJson refuses duplicate keys at any depth, NaN, Infinity, trailing commas and depth over 64, in linear time` (a 1 MB nesting and a 200,001-node array, timed);
- `parseJson keeps numbers as written`;
- `relabel rules` (one assertion per rule kind, the real pairs `A1`/`POL A01`, `GA01`/`EEGGA_01REF`, `DCEMBRACE`/`DC EMBRACE-REF`, `'G1'    `/`'G1'`, and that `64`/`640` and `A1`/`A10` get none);
- `the same change in files with different unrelated rows and offsets is one class`;
- `keyless pairing accepts a row only when at most half its columns changed`;
- `JSON renames, empty-key removals and inherited moves`;
- `incomplete pairs, cut values and cut classes leave their files unaccounted; cut additive classes do not`;
- `look-alike values are escaped or annotated`;
- `loss classes render first and the text never exceeds 30,000 characters`;
- `the bucket counts add up for every accepted file` (the `internal_mismatch` guard is unreachable on generated input).

`test/pr-review.test.ts`: `the three new finding codes parse and render with their labels, and the review is never offered them`.
`test/pr-review-calibrate.test.ts`: `--evidence-only needs no key, reads a local repository and prints closed words and numbers`.

### 12.3 Mutations each test set must catch

Applied one at a time, each must turn a named test red (the repository's practice: mutate in the dangerous direction and confirm the mutation applied):

- treat an additive class as needed, and a loss class as not needed, for coverage;
- mark a paired class complete when pairs were cut, or when a value was cut;
- skip the round-trip check;
- accept a quoted cell, a ragged row, a duplicate column or a duplicate JSON key;
- relocate into a non-corresponding path, or relocate a row with one byte changed, or reuse one copy twice;
- drop the equal-cells condition from the strict passes;
- pair keyless rows regardless of how many columns differ;
- add a rule for numeric pairs;
- account files of an abandoned summary;
- put platform findings last, or let the model's findings be sliced after them;
- render a value without escaping `\p{Cf}`;
- count a file in `files_read` twice.

### 12.4 Calibration

- **Offline set A (real)**: the 86 open dataset pull requests listed in the scratchpad (`design/data/targets.txt`), run with `--evidence-only`.
  Expected, from the prototype: 5,495 or more files accounted for; `readIncomplete` on at most 14 (exactly the 7 list-cut ones plus `on005522` #1, `on004703` #1, `on004809` #1, `on003876` #3, `on003620` #1, `on004661` #1, `on004588` #1, each for the reason given in section 14, slice 1); `on004551` #1 with five classes and the author's numbers; blocking loss facts on exactly these 17: `on003029` #1, `on007119` #1, `on003876` #3, `on003374` #1, `on003620` #1, `on002578` #2, `on006126` #1, `on004849` #1, `on004852` #1, `on004853` #1, `on004854` #1, `on004855` #1, `on004745` #1, `on004661` #1, `on004018` #1, `on003194` #1, `on002181` #1.
  The open pull requests move on, so the expectation is re-measured from a frozen list of heads (`design/data/repos/*.shas`) rather than from whatever is open on the day.
- **Offline set B (hostile, synthetic)**: one repository per case of section 11, built by a script in `test/fixtures/pr-review-hostile/` (not data from any dataset).
  Pass criterion: **every** case ends with `readIncomplete` true, or a blocking platform finding, or the change shown exactly; zero cases accounted for with the loss hidden.
  (Phase 5 review: the set also holds a removal in a file the summary refuses, a row removed from a table a ragged row makes unreadable and a key removed from a sidecar that repeats a key. No loss fact or platform finding exists for it, so the expected outcome is the removal shown in that file's diff, or `readIncomplete` true when the diff is not shown in full; the evidence-only run of set A reports how many pull requests have such a file, and the model calibration labels at least one.)
- **Model calibration**: the ADR 0107 gate (no false pass on a blocking problem, at most 10 percent false fails among pull requests labeled pass, no screen reject and no steering flag on a legitimate pull request), run with the operator's key on a labeled subset: the 11 newly complete pull requests without loss facts, the 17 with loss facts, and 10 small pull requests whose raw diffs already fit (to show the summary does not change their outcome).
  A person labels each before the run.
- **Pass/fail for slice 1**: set B has zero lenient outcomes; set A matches the expected numbers within the stated tolerances; the model gate passes; no evidence pass takes more than 60 s on a synthetic 2,000-file partial clone.

#### Measured on the real code (Phase 6)

The expectations above are the prototype's.
Phase 6 ran the real `gatherListing`, `gatherContent` and `buildEvidence` on the frozen set A with no network and no model: `bun run scripts/ci/pr-review-calibrate.ts --evidence-only --offline --clones ~/.local/share/nemar-canary/set-a --prs test/fixtures/pr-review-canary/set-a.txt --json`.
The counts are deterministic, so the baseline `test/fixtures/pr-review-canary/set-a-evidence.json` (86 rows, no timings) is compared with tolerance 0 by a test that runs wherever the frozen clones exist; a rule change that moves one pull request turns it red and is then a decision to record the baseline again.
The clones themselves stay outside the repository (a git pack holds committer addresses).
`set-a.txt` pins each pull request's base and head, so a clone can be made again by id while GitHub still serves them; a head that was force-pushed away reads `fetch_failed`.

**Set A, 86 pull requests, 0 row errors, no summary abandoned, no class cut, no removal HIDDEN.**

| Measure | Prototype | Real code |
| --- | --- | --- |
| Files changed, wanted | 9,208, 7,356 | 9,208, 7,356 |
| Parsed without refusal (`summarized`) | 5,514 | 5,514 |
| Refused | 393 | 393 (`invalid_utf8` 391, `ragged_row` 1, `empty_column_name` 1) |
| Accounted for | 5,495 | **5,482** (all of the 13 in `on005415` #1 are gone) |
| Truncated | 14 (7 list cut) | **15** (7 list cut, 9 content not read in full, `on006233` #2 in both) |
| Content not read in full without the summary | 31 | 31 |
| Newly complete (content not read in full without the summary, read in full with it, listing not cut), of which with no blocking loss fact | 18, 11 | **17, 9** |
| Blocking loss (a platform finding) | 17 | **20** |
| Most classes in one pull request, largest fenced block | 22, 6,958 characters | 22, 6,940 characters |
| Slowest listing, slowest content pass, all 86 passes | | 0.1 to 0.2 s, 3 to 6 s (`on006233` #2), 26 to 34 s, on local blobs |

The times are of local blobs on a laptop that was loaded by other work, so they vary from run to run; the production pass also fetches (section 12.1), which this run does not measure.
The guard on time is the scale test's 60 s per pass, not these numbers.

**Every pull request that differs from the prototype, and why.**
No row is a regression: each is a rule decided in the design, reported here with the numbers it moves.

| Pull request | What moved | Cause | Class |
| --- | --- | --- | --- |
| `on005415` #1 | accounted for 13 to 0, 2,744 rows removed (0 before), blocking, content not read in full | channel names gain a suffix with digits (`LAMY1` to `LAMY1-20000`); the relabel rules refuse added text with a digit (D14, section 4.3) | decided; owner question Q1 |
| `on003876` #3 | rows removed 62 to 849 (blocking before and after) | the same, D14 | decided; Q1 |
| `on003374` #1 | rows removed 0 to 22 (blocking before and after for 9 keys) | the same, D14 | decided; Q1 |
| `on005420` #1 | keys removed 0 to 72, blocking | `MiscChannelCount` to `MISCChannelCount` beside siblings with the same value (`0`): a rename needs a value unique within its parent (D8, section 4.7) | decided; owner question Q2 |
| `on003195` #1 | keys removed 0 to 20, blocking | the same, D8 | decided; Q2 |
| `on003194` #1 | keys removed 0 to 29 (blocking before and after) | the same, D8 | decided; Q2 |
| `on006126` #1 | keys removed 3 to 93 (blocking before and after) | the same, D8 | decided; Q2 |
| `on004745` #1 | keys removed **10 to 1** (blocking before and after) | nine keys `x1` to `x10` (without the `x`) under one `Levels` object, each with a value unique in its parent, are now `json_key_renamed`: the `strip` arm of the relabel rule (section 4.7) accepts a one-letter prefix with no digit in the gap, which the prototype's rename (case and punctuation only) lacked. They are shown exactly in complete classes, so nothing is hidden; the key of a `Levels` map is the coded value, so a person may still want the rename confirmed | decided; named in Q2 |
| `on002181` #1, `on005545` #1, `on005628` #1, `on006910` #1, `on006914` #1, `on007353` #1 | prototype `new_readIncomplete` 1, real 0 | the prototype folded a cut listing (these six are list cut) into `readIncomplete`; truncated is identical | definition |
| `on003620` #1, `on003195` #1, `on004588` #1, `on006233` #2 | `summarized` 92 to 48, 22 to 21, 87 to 86, 347 to 0 | the prototype counted every candidate; the real `summarized` plus `refused` equals it, and accounted for is equal | definition |

Relocation and move counts are identical in all 86 pull requests; no cap binds; no summary is abandoned.
With `--without-summary` (the pass as it was before the summary existed) 31 pull requests have content not read in full and 32 are truncated, which is the 31 of section 1.1.

**Owner questions this run puts, with the data.**
Neither changes a rule in Phase 6.

- **Q1 (D14, digits in a relabel).**
  Three pull requests carry a bulk relabel that adds digits to a name (`on005415` #1: 2,744 rows, now a platform blocker).
  (a) Keep: a person confirms these; the author can split the pull request or say so in CHANGES. No code. **Recommended**: three of 86, and the cases the rule refuses (`A1` to `A10`, `Cz` to `FCz`) are the ones a quiet acceptance would hide.
  (b) Widen D14 for the `wrap` and `strip` rules only, when the gap is identical for every pair of the class in every file, joined to the kept text by a non-digit, and no key of either table equals the gap's letters and digits (so `A1` to `A1-A2` stays a removal and an addition).
  (c) The author splits the pull request.
- **Q2 (D8, unique value).**
  D8 as written defeats the case that motivated rename detection: `MiscChannelCount` to `MISCChannelCount` (value `0` beside other counts of `0`) is the lesson of section 1.1, and under D8 it is 72 removed keys in `on005420`, 20 in `on003195`, 29 in `on003194` and 93 in `on006126` (3 before): four of 86 pull requests, so likely common in the fleet.
  (a) Keep D8: each is a platform blocker and a person confirms. No code.
  (b) **Recommended.** Narrow D8: the shared value must be unique among the parent's removed leaves and among its added leaves, and only for names equal after folding case and punctuation. `MiscChannelCount` to `MISCChannelCount` is then a rename (the siblings with `0` are neither removed nor added), `go` and `go2` with `go3` added stays a removal and an addition, and the nine `x1` to `1` renames of `on004745` #1 return to removed keys (the safer direction; one pull request).
  (c) The author splits the pull request.
  It would be one small change to `relabelRule` and the JSON pairing with its tests, and a fresh run of this baseline.

**Removals in a file the summary refused.**
Four pull requests have a refused file that deletes a line: `on006233` #2 (1 file shown, 346 incomplete, its listing is cut too), `on003620` #1 (43 shown, 1 incomplete), `on004588` #1 (1 incomplete), `on003195` #1 (1 shown).
Across set A: 45 files are shown in full, 348 are in a pull request whose content is incomplete, 0 are HIDDEN.
HIDDEN is a tripwire, not an expected outcome: a refused file with a deleted line is either shown in full or left unread, and an unread one keeps the content incomplete.
A file counts as shown only when its patch is not cut and holds at least as many `-` lines as git's own count of deleted lines (a binary file never does).
HIDDEN appears when the pass counts such a file as read without all of them in the patch, which is how the binary-diff hole would have shown up.
The run fixes the git configuration for every git it starts (no global or system configuration), so a setting such as `diff.algorithm` in an operator's `~/.gitconfig` cannot make git's count and the patch disagree.
`on004588` #1 is the label template's case of a removal only the model can see, and `on003620` #1 and `on003195` #1 are in its blocking group.

**Set B, the hostile set.**
24 synthetic pull requests (22 cases; 16 and 21 are split in two) built by `test/fixtures/pr-review-hostile/build.ts`, each a real repository read by the real passes.
One oracle independent of the code under test (brute force on raw bytes) holds for every case: a file shown in full shows every lost line; an accounted file with a loss carries a loss class and a platform finding; a file neither shown nor accounted keeps `readIncomplete` true; a pair of values that reads as one value after the fence, first differs at a character outside ASCII, or differs only in escaped characters carries the first-difference note; the fenced block is well formed.
Through the calibration script: 10 pull requests carry a blocking loss (cases 1, 2, 3, 4, 5, 8, 12, 15, 16b, 20), 4 are truncated (7, 11, 16b, 21b), 7 have a refused file that deletes a line, 0 are HIDDEN.
Two defects were found and fixed in this phase by the cases that predicted them: a diff git writes as `Binary files differ` (a NUL byte in a table) counted as a read, so a removed row in it left `readIncomplete` false (case 7); and two values that differ only by `<facts>` against `</facts>` showed as equal text with no note (case 22).
The first fix has a side effect worth stating: a modified or removed binary file in a read area (a `README.pdf`) now keeps the content incomplete, where its one-line `Binary files differ` diff used to count as read. That fails closed, as every unknown does.
A 2,000-file partial clone (1,000 relabeled tables, 500 sidecars with a changed value, 500 ragged tables, 300 copies) reads in about 4 s.

**The model calibration is the owner's step.**
`test/fixtures/pr-review-canary/model-labels.template.txt` lists 40 reviews (9 newly complete without a loss fact, 20 with a blocking loss, 10 small, 1 removal in a refused file); the 3 pull requests of the platform's own account are left out.
It calls the Anthropic API with the operator's key, so neither CI nor an agent runs it.

---

# Part B: what a contributor may change of the original authors' content

The owner's rule: a contributor may **add** (unreported information, a clearly separate new section, a straightforward correction) but may not **alter or remove** what the original authors wrote; the narrative of a change belongs in CHANGES, which the review already requires (`changelog_entry`), not in a rewritten README.

## B1. Taxonomy and permitted edits

| Content | Original part | Permitted | Not permitted (default effect) |
| --- | --- | --- | --- |
| README (any root `README*`, one document across names) | lines present at the provenance anchor | new lines appended, prepended, or inserted between original paragraphs or sections; minor edits of an original line (B2.1) | removing or rewording an original line beyond a minor edit; moving original text; inserting lines inside an original paragraph (fail) |
| README text added after the anchor (NEMAR curation, earlier contributions) | not original | any edit (information for the model) | none by rule |
| CHANGES (root `CHANGES*`, `CHANGELOG*`) | every line at the merge base | new entries anywhere between entries, at the top or the end | removing or editing any existing line (fail) |
| `dataset_description.json` author-owned: `Name`, `Authors`, `License`, `ReferencesAndLinks`, `Funding`, `Acknowledgements`, `HowToAcknowledge`, `DatasetDOI`, `EthicsApprovals` | values at the merge base | adding a key that was absent or missing; appending array elements with the old ones kept in order; replacing a missing value; a minor edit of a string in `Funding`, `Acknowledgements`, `HowToAcknowledge`, `EthicsApprovals`, `ReferencesAndLinks` | any other change; any change of `Name`, `Authors` (order included), `License`, `DatasetDOI` (fail) |
| `dataset_description.json` tool-managed: `BIDSVersion`, `GeneratedBy`, `DatasetType`, `Version`, `HEDVersion`, `SourceDatasets`, `DatasetLinks` | | any change (Part A shows it; `Version` is the revision fact) | none by Part B |
| `participants.tsv` and `participants.json` values | values at the merge base | new rows, new columns, filling a missing value, a new `Levels` entry | a non-missing value changed (including a relabeled `participant_id`), a row removed (Part A loss), a `Levels`/`Description` entry removed (fail for a changed value; Part A for removals) |
| Sidecar technical metadata (`*_eeg.json`, `*_channels.tsv`, ...) | | corrections, shown exactly by Part A, which must be described in the CHANGES entry | none by Part B rule (the model checks the CHANGES entry, `changes_log_mismatch`) |
| Annexed recordings | the annex key at the merge base | new recordings; a pointer moved with the same key | a new key for an existing path, an annexed path turned into a git file or the reverse (`unknown`, a person confirms) |

## B2. Mechanical facts

### B2.1 Prose (`README*`, `CHANGES*`)

1. **Documents.** The README document is the concatenation, in code-unit path order, of every root file matching `^readme(\.[A-Za-z0-9]+)?$` (case-insensitive); likewise CHANGES (`^(changes|changelog)(\.(md|txt|rst))?$`).
   Comparing documents, not paths, makes `README` to `README.md` or `README.md` to `README.rst` with the same text a preserved document.
2. **Normalization.** Decode UTF-8 (a non-UTF-8 side is decoded as Latin-1 and the fact `prose_not_utf8` is set); drop a leading BOM; split on `\n`; remove `\r` and trailing spaces and tabs from every line; drop blank lines.
   Nothing else is normalized: case, inner whitespace and punctuation are significant.
   This exactly removes the two measured artifacts (a final newline added after the last original line, and CRLF to LF) and nothing more.
   The facts record `line_endings_changed` and `final_newline_added` so the model is told.
3. **Alignment.** Myers' diff of the two normalized line sequences, with the edit distance capped at 2,000 (above it, every protected line counts as altered).
4. **Protected lines.** For README, the lines of the merge-base document that are in the anchor document (multiset intersection, in order); for CHANGES, every line of the merge-base document.
5. **Facts** (per document):

```ts
export interface ProseFacts {
  document: "readme" | "changes";
  anchor: "first_version_tag" | "merge_base";
  /** Every protected line survives, in order, with only insertions around it. */
  preserved: boolean;
  /** Protected lines removed or replaced beyond a minor edit. */
  protectedAltered: number;
  /** Protected lines replaced by a minor edit. */
  minorEdits: number;
  /** Lines removed or replaced that are not protected (text added after the anchor). */
  laterAltered: number;
  /** Every protected line kept but not in its order. */
  moved: boolean;
  /** Inserted runs placed between two protected lines that were adjacent in one paragraph. */
  insertedInsideParagraph: number;
  insertedLines: number;
  lineEndingsChanged: boolean;
  finalNewlineAdded: boolean;
  /** Up to three removed protected lines, for the fenced block only. */
  examples: string[];
}
```

**Minor edit.** Inside one diff hunk, the i-th removed protected line is paired with the i-th inserted line; the pair is a minor edit when its Levenshtein distance (banded, so linear) is at most `max(3, floor(0.1 × longer length))` and at most 20.
The `Funding` fix of `on007353` (distance 7 in about 100 characters) is minor; replacing a sentence is not.

**Paragraph.** Two protected lines are adjacent in one paragraph when they were consecutive non-blank lines in the merge-base text.

### B2.2 `dataset_description.json`

```ts
export interface AuthorFieldFacts {
  /** Author-owned keys changed beyond what B1 permits: closed key names only. */
  altered: string[];
  /** Author-owned keys removed while they held a non-missing value. */
  removed: string[];
  /** Permitted: minor edits, arrays grown in order, keys added, missing values replaced. */
  minor: string[];
  grown: string[];
  added: string[];
  /** The file did not parse on one side (Part A's parser); the fact is unknown, never clean. */
  unparsed: boolean;
}
```

Key names in these arrays are only the nine author-owned names, a closed list, so they may appear in a note.

### B2.3 Participants

From Part A's classes on `participants.tsv` and `participants.json`: `participantsValuesAltered` is the count of `cell_replaced`, `cell_templated`, `key_relabeled` and `json_value_changed` atoms there, plus `cell_emptied` and `json_emptied`.
Removals are already Part A loss facts.
If either file was refused by the parser, the fact is unknown, which makes the file unaccounted (Part A) and the review cannot pass anyway.

### B2.4 Recordings

From `rawEntries`, with no blob read beyond the pointers:

```ts
export interface RecordingFacts {
  /** An annexed path (mode 120000, or a regular file whose content is an annex pointer) whose key changed. */
  replaced: number;
  /** A recordings-area path whose type changed (T): annexed to git or the reverse. */
  typeChanged: number;
  /** A removed annexed pointer whose exact key appears at an added path. */
  moved: number;
}
```

A pointer's key is the symlink target's last path component (`SHA256E-s<size>--<hash>.<ext>`), read from the symlink blob in the same `cat-file --batch`; an unlocked pointer is a regular blob under 1 KiB that starts with `/annex/objects/`.

## B3. Provenance: what is "original"

| Option | Cost in a partial clone | Robustness | Verdict |
| --- | --- | --- | --- |
| Merge base only (every line at the base is protected) | none | total, but protects NEMAR's and earlier contributors' sections too (`on002578` #2 would need a person) | **the fallback** |
| First version tag (lowest `vX.Y.Z` whose commit is an ancestor of the merge base) | one `git ls-remote --tags origin` (0.4 s measured) and one or two blobs | `v1.0.0` exists on all five datasets sampled; tags are written by the platform and protected by the tag ruleset; anything missing falls back | **recommended** |
| Blame or history walk (lines by commit author, OpenNeuro and DataLad commits as original) | one blob fetch per README version, each a round trip | depends on author strings and path continuity; `README` was renamed to `README.md` by `nemarAdmin`, which breaks path history | rejected |
| Root commit's README | one blob | in every pull request measured that changes a README, the root commit has no README at all | rejected |
| A marker NEMAR writes around its own sections | a fleet rewrite of READMEs | a marker at the merge base is trustworthy, but nothing has one, and every NEMAR curation step would have to write it | rejected for now (Owner Question B5) |

**Algorithm.**

1. In the listing pass (budget 60 s), run `git ls-remote --tags origin` with the job's existing git configuration (the read-only token is already in it); parse only lines matching `^[0-9a-f]{40}\trefs/tags/v(\d+)\.(\d+)\.(\d+)(\^\{\})?$`, preferring the peeled `^{}` id.
2. Sort by version ascending; take the first whose commit `git merge-base --is-ancestor <commit> <mergeBase>` accepts (local: `main` is fetched with full history).
3. Read the README document at that commit (its tree is local; its blobs join the content pass's batch).
4. Any failure (no tag, ls-remote error, not an ancestor, no README there) gives `anchor: "merge_base"`, the strict fallback.

Measured on the open set: `on002578` #2's 21 lines are not in `v1.0.0` (information only); `nm000501` #3's 3 lines are in `v1.0.0` (protected, fail).

## B4. Effects, codes and messages

| Fact | Criterion effect | Finding code | Note template (at most 200 characters) |
| --- | --- | --- | --- |
| `protectedAltered > 0`, `moved`, `insertedInsideParagraph > 0` (README) | `no_degradation` fail | `original_text_altered` | `{n} lines the original authors published in README were removed or reworded. Keep them; put your account in CHANGES or a new section, and ask a NEMAR administrator to fix an original statement.` |
| any CHANGES line removed or edited | `no_degradation` fail | `original_text_altered` | `{n} existing lines of CHANGES were removed or edited. CHANGES keeps its history: add a new entry for this version instead.` |
| `AuthorFieldFacts.altered` or `.removed` non-empty, or `participantsValuesAltered > 0` | `no_degradation` fail | `original_field_altered` | `The dataset description's {keys} changed. Fields the authors published are kept as published: add new information, or ask a NEMAR administrator to correct a field.` (participants: `{n} participant values changed. ...`) |
| `RecordingFacts.replaced + typeChanged > 0` | `no_degradation` unknown | `recording_replaced` | `{n} recording files have new content. A NEMAR administrator confirms a change to recorded data; describe it in CHANGES.` |
| minor edits, later-text edits, appended sections, line-ending changes, grown arrays, moved pointers | information in the facts | | |

Notes pass through `sanitizeNote`, which removes `_`, `*`, backticks and brackets, so no template names a file like `dataset_description.json` or a column like `participant_id`; `{keys}` is drawn from the nine author-owned names, none of which holds an underscore.
Every template, filled with its largest realistic numbers, stays under `NOTE_MAX` (200); a test fills each with seven-digit numbers and all nine key names and asserts the length.

The three "fail" rows set `lowerToFail` (section 10.3), so the script lowers `no_degradation` to `fail` before the parser and adds the platform finding that explains it; a model can raise neither.
`recording_replaced` is a blocker finding only, so `settle` lowers a pass to `unknown`.
All three codes are in `FINDING_CODES` from slice 1 (accept-only) and excluded from `REVIEW_FINDING_CODES`, so the model never emits them.

**`CODE_LABEL` entries:** `original_text_altered`: "Original text changed"; `original_field_altered`: "Original field changed"; `recording_replaced`: "Recorded data changed".

**What the contributor does instead** (the check's text, one paragraph under the finding, rendered by `findingLines` from the code): "Contributors add to what the original authors published and do not change it. Describe your change in the CHANGES entry for the new version. Put new information in a new, clearly separate section of the README. If something the authors wrote is wrong, open an issue for the NEMAR administrators, who can correct it; an administrator can also review this pull request by hand."

**Facts block**, beside `change_summary`:

```ts
original_content: {
  anchor: "first_version_tag" | "merge_base";
  readme_preserved: boolean | null; // null when README did not change
  readme_protected_lines_altered: number;
  readme_minor_edits: number;
  readme_later_text_altered: number;
  readme_lines_appended: number;
  readme_line_endings_changed: boolean;
  changes_history_preserved: boolean | null;
  author_fields_altered: string[]; // closed names
  author_fields_added_or_grown: string[];
  participant_values_altered: number;
  recordings_replaced: number;
  recordings_moved: number;
}
```

and one system-prompt sentence (in the paragraph of section 8.4): "The original_content facts compare the README, CHANGES, the author fields of dataset_description.json, participant values and recordings with what the dataset first published; the platform has already acted on what they report, and you do not need to repeat it, but a minor edit or a change to later text is yours to judge."

**On the open set, the defaults would act on:** `nm000501` #3 (README original text, fail), `on006126` #1 (`ReferencesAndLinks` link removed, fail; it also carries a Part A loss), `on005420` #1 (37 `sex` values `None` to `F`, fail), `on004588` #1 (5 `participant_id` values re-padded, fail), `on003343` #3 (59 recordings replaced, unknown), `on003029` #1 (41 annexed `.vhdr` became git files, unknown), `on004703` #1 (5 annexed `_events.tsv` became git files, unknown).
None of the 27 artifact READMEs and none of the 64 CHANGES changes is flagged.

## B5. What Part B shares with Part A

- **One blob read.** Part B's blobs (README and CHANGES documents at the base, the head and the anchor; `dataset_description.json`; annex pointers) join Part A's `cat-file --batch` call; the prefetch already covers the changed ones.
- **One budget.** Part B runs inside the content pass (the tag lookup in the listing pass) and, like the summary, is all-or-nothing: an abandoned Part B pass adds one platform finding with the existing code `evidence_incomplete` (blocker, `no_degradation`, note "The platform could not finish comparing this pull request with what the authors published. A person looks."), without `lowerToFail`, so `no_degradation` is unknown: never clean and never failed (Owner Question B6).
- **One parser.** `dataset_description.json` and `participants.*` go through Part A's strict parsers; participant facts are read off Part A's classes.
- **One renderer and one fence.** Removed protected lines appear only in the fenced summary block, through `renderValue`.
- **One mechanism.** `platformFindings` builds both parts' findings, at most three, first in the list.
- **One calibration path.** `--evidence-only` prints both parts' counts.

## B6. Adversarial cases for Part B

1. **Cut and paste elsewhere.** All protected lines kept but out of order: `moved`, fail.
   Pasting them into another file: the README document lost them (fail); CHANGES is a different document.
2. **Whitespace-only edits.** Trailing whitespace and line endings are normalized away (cosmetic, stated as a fact); inner whitespace and indentation are significant and count as edits, minor when small.
3. **Case-only edits.** Significant; a small one is a minor edit (information), a whole-sentence case change is not minor.
4. **Replacing text with an "equivalent".** Not detectable as equivalent; it is an alteration beyond a minor edit (fail); the author asks an administrator.
5. **Delete the README and re-add the text under a new name.** Documents are compared across root README names; a README removed with its text moved to `docs/README.md` is a removed document (the existing removal rule, plus fail).
6. **README.md to README.rst with reformatting** (Markdown headings to RST underlines). The heading lines change: alterations of protected lines; the author keeps the old file's text or asks an administrator. Accepted cost; measured 0 on the open set.
7. **License changed and called a typo.** `License` has no minor allowance: fail, whatever the description says.
8. **Reordering the author list.** `Authors` compared as an ordered array: fail; appending an author keeps the old order and is `grown`.
9. **Encoding and BOM.** A BOM is dropped before comparison; a README that was not UTF-8 is decoded as Latin-1 on that side and `prose_not_utf8` is stated; re-encoding then compares the text, not the bytes.
10. **Mass trailing-whitespace cleanup.** Normalized away; preserved; `line_endings_changed` or nothing is reported.
11. **A change split across several commits.** Facts compare the merge base with the head, never commit by commit, so splitting changes nothing.
12. **Inserting a sentence inside an original paragraph** ("The data are valid." to "The data are not valid." as a new line, or "not" inserted in a line). A new line between two adjacent protected lines: `insertedInsideParagraph`, fail; a word inserted in a line: that line is altered beyond minor or minor (one word of three characters can be minor, which is why minor edits are information the model judges and Owner Question B2 exists).
13. **Moving the anchor.** Only someone who can write tags can move it; the lowest ancestor tag is taken, so a new tag cannot hide an older original; a missing or foreign tag falls back to the stricter merge base.
14. **Editing NEMAR's own later section to remove a warning it carries.** Not protected by default (information only, Owner Question B5); the model sees the removal in the raw diff and the facts.
15. **Recording replaced with the same size.** The key holds a content hash, so any content change changes the key.

## B7. Tests for Part B

New `test/pr-review-original.unit.test.ts` (pure functions) and a `describe("original content")` in `test/pr-review-evidence.test.ts` (real git, with tags made by `git tag`):

- `a README whose last line gains a final newline and a new section is preserved` (the `on005398` shape);
- `a README converted from CRLF to LF with a section appended is preserved and says its line endings changed` (the `on004703` shape);
- `removing an original paragraph is original_text_altered and fails no_degradation`;
- `rewording a section added after v1.0.0 is information, not a finding` (the `on002578` shape);
- `with no version tag, every line at the merge base is protected`;
- `a tag whose commit is not an ancestor of the merge base is ignored`;
- `a typo fix within the minor bound is information; a sentence rewritten is altered`;
- `a line inserted between two lines of an original paragraph fails`;
- `an original section moved below a new one fails as moved`;
- `README.md renamed to README.rst with the same text is preserved`;
- `a new CHANGES entry at the top is fine; editing an old entry fails`;
- `License changed by one character fails; an author appended is grown; authors reordered fail`;
- `an empty placeholder removed or normalized is not altered` (the `on004022` and `on004855` shapes);
- `a participant value changed fails; a missing value filled is information`;
- `an annex key changed and an annexed file turned into a git file are recording_replaced; a pointer moved with its key is moved`;
- `an abandoned Part B pass is unknown, never clean`.

Mutations: drop the protected-line filter (protect nothing), widen "minor" to any edit, compare README by path instead of document, take the highest tag instead of the lowest, skip the ancestor check, treat `Authors` as a set.

---

## 13. Owner Questions

Each has the default this design builds and what each answer changes.

**Part A**

- **A1. Is an unrelocated or unkept removal (rows, columns with values, JSON keys with values) blocking?**
  Default: yes, `no_degradation` cannot pass (`unknown`), a person confirms.
  Yes: 17 of the 86 open pull requests need a person for this reason, most of them for real removals (HED entries, a participant, `Levels` descriptions, redacted channel rows).
  No: the model judges removals as it does raw diffs today; a loss the model misreads could pass, and the summary shows less than a diff does about what was removed.
- **A2. What counts as relocation?**
  Default: verbatim (same header, same bytes) into `sourcedata/<anything>/<the same path>`, and for JSON the same key and value in a sidecar that applies by BIDS inheritance.
  Wider (verbatim anywhere in the pull request): an author could move rows to any file and still pass; no open pull request needs it.
  Narrower (no relocation at all): 20 open pull requests relocate rows, and 18 of them, `on004551` included, would need a person for that alone.
- **A3. Is emptying a value (a non-missing value set to `n/a` or blank) blocking?**
  Default: no, shown exactly as pairs; the model judges.
  Yes: `on002181` #1 (226 `units` from `unknown` to `n/a`) and `on003620` #1 (48 `not` to `n/a`) would need a person for normalizations, and `on005522` #1 (five electrodes' coordinates set to `n/a`, one of them 364 mm below the origin) for a probable correction.
- **A4. Is a removed JSON key whose value was missing a loss?**
  Default: no (`on006914` and `on006910` remove 737 keys whose value was `"n/a"`).
- **A5. Should the 400-name cut stop truncating a pull request whose every changed file is covered?**
  Default: not in slice 1; slice 3 proposes it, which changes the Worker parser's invariant (`files_changed > MAX_MODEL_FILES` requires `truncated`) and so needs its own argument; 7 of the 86 open pull requests are over 400 files and cannot pass `no_degradation` until then.
- **A6. Are relabel rules (prefix and suffix, zero padding, letters and digits kept in order) an acceptable exact description of a renamed key?**
  Default: yes; without them, `on004194`, `on005007`, `on003876` and others read as thousands of removed rows.

**Part B**

- **B1. Provenance anchor.**
  Default: the first version tag, falling back to the merge base.
  Merge base only: NEMAR's own later sections become protected (`on002578` #2 fails).
- **B2. Minor edits of original text.**
  Default: allowed as information (distance at most `max(3, 10%)` and at most 20 per line), described in CHANGES; the model judges whether they are straightforward.
  Blocking: every typo fix needs an administrator.
- **B3. Severity of an alteration of original text or an author-owned field.**
  Default: fail ("Needs changes"), with the instruction; an owner or administrator can merge in the GitHub UI (ADR 0107 decision 5).
  Unknown instead: the check reads "Could not decide" and the author is not told the rule.
- **B4. Recordings replaced.**
  Default: `unknown` (a person confirms a data repair such as `on003343`'s BDF headers).
  Fail: every data repair by a contributor is refused until an administrator merges it.
- **B5. NEMAR's own sections added after the anchor.**
  Default: editable (information only).
  Protected: NEMAR would add a marker or keep them in the anchor; contributors could no longer correct them.
- **B6. A Part B pass that could not finish.**
  Default: unknown (a person looks), never fail and never clean.
- **B7. Participant values.**
  Default: any change of a non-missing participant value fails, including `None` to `F` (`on005420` #1) and re-padded `participant_id` (`on004588` #1).
  Alternative: treat `None`, `unknown` and similar as missing for participants only, which turns `on005420` into information.

---

## 14. Phasing and implementation plan

### Slice 1: the summary (Part A) and the codes, accept-only

Makes `on004551`-like pull requests readable as complete.
Measured effect: `readIncomplete` drops from 31 to 14 of 86 open pull requests; the 18 that become complete are `on006107` #1, `on005007` #2, `on004551` #1, `on005931` #1, `on007120` #1, `on007119` #1, `on007118` #1, `on005415` #1, `on004194` #1, `on003343` #3, `nm000501` #3, `on006126` #1, `on005420` #1, and `on004849` to `on004855` #1 (five); of those, `on007119`, `on006126` and the five `on0048xx` carry a blocking loss fact.
Still incomplete: the 7 over 400 files (`on006914`, `on006910`, `on006233`, `on005545`, `on007353`, `on005628`, `on002181`) and 7 for a file neither the summary nor a raw diff covers (type changes in `on004703`, a removed `electrodes.tsv` whose diff is over the per-file cap in `on004809`, non-UTF-8 tables in `on003620` and `on004588`, 13 distinct removed channel names in `on003876`, 214 removed HED keys in `on004661`, 121 replaced electrode coordinates in `on005522`).
Remember that a complete read lets `no_degradation` pass; it does not make a pull request pass: most canary pull requests still fail `advances_revision` (no version bump, an "Unreleased" CHANGES heading), which is correct and fixable by the author.

Ordered steps (one commit each, tests in the same commit):

1. `scripts/ci/pr-review-summary.ts`: `parseTsv`, `serializeTsv`, `parseJson`, `canonicalJson`, `entityPattern`, `renderValue`, `firstDifference`.
   Tests: the parser, round-trip, JSON and look-alike tests of section 12.2.
2. Same module: `relabelRule`, `ruleWords`, keyed and keyless table diff (sections 4.4 and 4.5), JSON diff (sections 4.6 and 4.7), relocation pools, the bucket-count assertion.
   Tests: relabel rules, same change one class, keyless pairing, JSON renames and moves, relocation exactness.
3. Same module: classes, order, render, completeness, `accounted`, `LossFacts`, `summarizeChanges` with the deadline.
   Tests: incomplete and cut classes, loss first, character bound, deadline abandons.
4. `pr-review-evidence.ts`: `rawEntries`, `readBlobs` (with `runGit` input), the cosmetic loop on batched blobs, the summary call, the raw-path order of section 8.5, `files_read` union.
   Tests: the real-git `describe("the change summary")` set; every existing evidence test stays green.
5. `pr-review-prompt.ts`: the facts block, the fenced block, the groups column, the system-prompt paragraph, `platformFindings`, `assembleReport`'s new parameters.
   Tests: fence and forged-line tests; platform findings first and surviving; every existing prompt pin unchanged.
6. `pr-review.ts`: pass platform findings; `observeEvidence`.
7. (Moved out of the epic: the three codes, labels and the exclusion from `REVIEW_FINDING_CODES` shipped first as S0, nemarOrg/nemar-cli#1863, so the Worker accepts them one release before anything emits them. Nothing remains to do here.)
8. `pr-review-calibrate.ts`: `--evidence-only` and the columns.
   Tests: `test/pr-review-calibrate.test.ts`.
9. Hostile fixture builder `test/fixtures/pr-review-hostile/` and its test (set B).
10. ADR 0109 ("A large change is read as an exact, platform-computed summary"; numbered 0109 because ADR 0108, the BIDS validator's release policy, reached `dev` first), added to the decisions index; it records sections 6, 7 and the Owner Question answers.
11. Run set A with `--evidence-only` and the model calibration of section 12.4 before the check is required.

Gates: `bun run typecheck`, `bun run lint`, `bun test` (root, which runs `test/` and `backend/test/` together), and the workflow parity test untouched (no workflow change in this slice).

### Slice 2: Part B

Adds rules, so it unblocks no pull request; it prevents alterations and corrects the model's reading of README diffs whose "deletions" are line-ending or final-newline artifacts (27 of 29 measured).
It is cheaper than slice 1 (no table parsing, one network call), and could be built in parallel by a second worker, but it is not on the path to passability, and it emits codes that slice 1 must have deployed first, so it ships after slice 1's release.

1. `scripts/ci/pr-review-original.ts`: documents, normalization, banded Levenshtein, Myers with the 2,000 cap, `ProseFacts`, `AuthorFieldFacts`, `RecordingFacts`, `provenanceAnchor`.
2. The tag lookup in the listing pass; the anchor's blobs in the content batch.
3. `platformFindings` and `lowerToFail` for Part B; the `original_content` facts and the prompt sentence; the check paragraph of B4.
4. Tests of section B7; calibration rerun.

### Slice 3: the 400-name cut

Proposal to argue separately: when every changed file in a readable area is covered and the shape account omits nothing (`groupsOmittedFiles` 0), `listCut` stops setting `truncated`, and the Worker's invariant becomes "`files_changed > MAX_MODEL_FILES` requires `truncated` unless the evidence says the shapes were complete", which needs one evidence field.
7 of 86 open pull requests are waiting on it.

### Slice 4: small evidence additions

`files_summarized` (check text "of which N as an exact summary"), the exact-move exemption for whole files with the same blob or annex key (`on004306` #1, `on003620` #1), and the Latin-1 before side (section 3.3).

### Deliberately out of scope

- Changes in `derivatives/`, `sourcedata/` and `code/` are not read today and are not summarized; that is ADR 0092's scope, unchanged.
- No BIDS validation: the summary says what changed, not whether the result is valid BIDS.
- No semantic equivalence (units, number formats, synonyms): `µV` to `uV` is a replaced value the model judges.
- No tool for the model, ever.

---

## 15. Rejected alternatives (summary)

- **Raise the diff budgets.** The 114 distinct diffs of 127 to 394 lines in `on004551`'s 125 modified tables do not fit any sane prompt, and the review's thinking, not its input, already fills 128,000 output tokens on large pull requests (ADR 0107 amendment).
- **Fuzzy folding of near-identical diffs.** Masking line numbers or values is exactly what lets a one-byte change hide; ADR 0107's folding is exact for that reason.
- **Let the model call a tool to inspect files.** ADR 0092 and ADR 0107: the model has no tools.
- **A per-file signature (the set of a file's classes) as the unit of aggregation.** Files of one bulk edit rarely share all classes (`on004551`'s 125 files have 56 with relocations and 69 without); per-class aggregation gives five entries where per-file gives dozens.
- **Ordered (LCS) row diffs.** Quadratic on hostile input, and they describe a reorder as a loss.
- **Store the summary in the report.** It is model input, not a verdict input; the facts that decide (loss, coverage) already reach the verdict through `truncated` and platform findings.
