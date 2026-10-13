# ADR 0032: Facet filters are declared once, and report what they exclude

**Status:** accepted
**Date:** 2026-09-01
**Owner:** Seyed Yahya Shirazi

## Context

Phase 1 (#1145) moved dataset filtering into SQL; Phases 2 and 2b (#1146,
#1153) added a batch of new `datasets` columns -- recording-level duration
and channel-count ranges, signal defaults, HED/BIDS versions. None of them
were filterable. `DatasetFilterOptions` (`dataset-filters.ts`) was a flat bag
of nine bespoke fields with no structural concept of "a range filter over a
column that is only partly populated" -- the Phase 1 review deferred
redesigning it with a stated reason: the shape could not be designed without
the full filter list in hand. Phase 3 (#1147) is that filter list, so the
redesign is decided here.

Two constraints shaped the answer. First, three of the new columns are
**pairs** (`channel_count_min/max`, `recording_duration_min/max`, plus the
pre-existing `age_min/max`), not single scalars -- a filter engine built only
for one column per facet gets these three silently wrong. Second, most of the
new columns are 0% to 72% populated today (the Phase 2/2b sweeps have not
finished against production), so a NULL-excludes-by-default policy makes the
initial recall of several filters low by construction, not by bug -- that
needed to be visible to a caller, not just silently swallowed.

## Decision

**One declared table is the single source of truth for which columns are
filterable, split across two files by what each side needs.**
`shared/facets.ts` is the CLI/wire vocabulary (key, flag, value kind, enum
members) with zero SQL; `backend/src/services/dataset-facets.ts` binds each
key to column(s), an SQL kind, and a NULL test. A test asserts the two
declare the exact same set of keys in both directions, so a half-added facet
fails CI instead of a flag silently doing nothing. The existing bespoke
filters (`search`, `modality`, `author`, `task`, `hasDoi`, `hasHed`,
`dataComplete`, `recent`, `licenseTiers`) are NOT migrated into this table --
their semantics (FTS routing, LIKE-joined comma lists) are irregular enough
that forcing them in would have rewritten four passing test files for no
behavioural gain. `buildDatasetFilterClauses` runs its existing chain, then
appends one generic walk over the facet table.

**Two filter kinds, and pairs use overlap, not containment.** A `scalar`
facet is `col BETWEEN ? AND ?`. A `pair` facet is
`col_max >= ? AND col_min <= ?` -- overlap, because `--age 5..18` must match a
dataset spanning 12..25 (it does contain participants in that range);
containment is the tempting-looking wrong answer and reads identically for
any fixture whose ranges happen to nest. A `pair` facet's NULL test is
`min IS NULL OR max IS NULL`, not `AND`: either bound being unknown means the
row's range isn't fully known, so `include_unknown=1` must widen it in. `AND`
would have been indistinguishable from `OR` for `recording_duration_min/max`
and `channel_count_min/max`, which migration 0070 documents as written
together, atomically, only on a successful recording-stats sweep read -- but
it is observably wrong for `age_min`/`age_max`, which predates that sweep
entirely (migration 0020) and is backfilled independently per bound
(migration 0023's comment: "each is COALESCE-preserved independently").

**An unrecognised enum token is a 400, except for the one filter that
predates this table.** The `powerline`, `electrode-system`, `source`, and
`zarr` facets reject any token outside their declared `enumValues`, naming
the bad token and listing the valid values -- the same posture
`RangeParseError` already takes for a bad range. Silently dropping it (as an
earlier version of this table did, mirroring `parseLicenseTierFilter`) lets
`?source=opennuero` return the whole unfiltered catalog with a 200: when
every token in a facet is unrecognised, the facet vanishes rather than being
enforced, and the response looks like "no matches" when it is actually "the
filter never took effect." The pre-existing `license` param
(`parseLicenseTierFilter` in `backend/src/lib/license.ts`) keeps its
original drop-unrecognised behaviour: it predates this table, the website
already depends on its current semantics, and changing it is a breaking
change out of scope here. The asymmetry is deliberate: a newly declared
facet gets the strict contract; the filter that already shipped keeps the
contract it shipped with.

**A derived range beats a sampled exemplar, with a documented fallback.**
`--channels` binds to `COALESCE(channel_count_min/max, n_channels)` on each
side: the derived per-recording pair is authoritative but 0% populated until
the sweep runs, and the exemplar (`n_channels`, one sampled sidecar) is a
known-imperfect but already-available signal (confirmed wrong today:
nm000111 reads 19 while 70 of its 124 recordings are actually 20). Filtering
on the pair alone would return nothing for months; filtering on the exemplar
alone keeps a number already known to be wrong for some datasets. The
COALESCE collapses to the exemplar scalar when the pair is NULL and to the
true overlap once it is populated -- one clause, both states. This is the
only facet with a fallback, and it is documented as an exception, not a
precedent: no other current or near-term facet has both a derived source and
a usable interim proxy at the same time.

**Unknown is excluded by default, and the exclusion is reported, never
assumed.** A NULL never satisfies a SQL comparison, so a row with an
unpopulated filtered column drops out by default -- the correct default,
since silently including it would make `--rate 1000` return datasets of
unknown rate. `include_unknown=1` widens every ACTIVE facet's predicate with
its declared NULL test. Both catalog envelopes gain `excluded_unknown`: the
count that would have matched with unknowns included, minus the count that
did, computed only when a facet is active (an unfiltered list pays nothing),
degrading to an omitted field (never a faked or stale number) on failure --
the same posture ADR 0005 already commits to for availability: a gap is
reported out of band, never faked and never allowed to block delivery. The
two endpoints reach that degradation differently, and the difference has a
cost: `catalog.ts`'s `executeAndReturn` extends its pre-existing
`Promise.allSettled` with a third, parallel branch for the widened count, so
the extra query is concurrent with the main list/count round trip.
`dataset-search.ts` has no such fan-out to extend -- `computeExcludedUnknownCount`
is a NEW sequential `await` after `countSearchMatchesSafely` inside its own
try/catch, which is a genuine second round trip added to the request, not a
free ride on an existing one. Either way, the widened count is only computed
when the primary count itself succeeded (C1 correction, below); diffing a
real widened count against a degraded primary count would print a
confident-looking, likely-wrong number next to a warning that says the total
is unreliable. It matters immediately, not hypothetically for two of the
three columns this touches first: `--duration` and `--recordings` are
genuinely sweep-only (migration 0070's `recording_stats`, no reindex path),
so their recall is low until the Phase 2/2b sweeps finish. `--rate`
(`sampling_frequency`) is NOT sweep-gated the same way: migration 0071 and
`dataset-metadata-columns.ts#writeDatasetMetadataColumns` show it (and
`power_line_frequency`/`eeg_reference`/`placement_scheme`) is also written by
ordinary reindex traffic, independent of the `signal-defaults-sweep.ts`
backfill -- so its population climbs with everyday activity, not only with a
one-time sweep completing. `excluded_unknown` is what tells a caller which
of "no matches" and "matches excluded because unknown" they are looking at,
for whichever reason a column is still sparse.

**Amended in epic #1144 phase 4 (#1148): `excluded_unknown` is now attributed
per facet, in the SAME query, with no extra round trip.** This decision
originally deferred per-facet attribution (see "Alternatives considered"
below) on the premise that it needed one query per active facet; that premise
was wrong, and no extra ROUND TRIP is the precise claim. The per-facet SUMs
are real added computation within that one scan; what costs nothing extra is
queries, which is exactly what the deferral mispriced.
The widened count is already a single `SELECT COUNT(*) ... FROM datasets d
WHERE <base> AND <every active facet, widened>` -- turning it into a
conditional aggregation (`SELECT COUNT(*) AS total, SUM(CASE WHEN <nullTest
of facet i> THEN 1 ELSE 0 END) AS unk_i, ...`) computes the full per-facet
breakdown in the same scan, no additional round trip on either endpoint.
Both envelopes now also carry `excluded_unknown_by_facet` (`FacetKey ->
count`), gated together with `excluded_unknown` on the same
`countSucceeded` check and the same failure-omits-both posture. The two
numbers do NOT sum: a row unknown in two active facets counts once toward
`excluded_unknown` but once in EACH bucket, so
`sum(excluded_unknown_by_facet values) >= excluded_unknown`, with equality
only when no row is unknown in more than one active facet -- a consumer
must never present the buckets as a partition of the total. This closed a
real gap: the vague "a filtered field is unknown for them" message the
deferred design forced for two-or-more active facets told a user their
result set shrank and refused to say which flag did it, at exactly the
moment they had several flags to choose between.

The one structural fix this needed: `executeAndReturn`'s widened-count
query used to wrap a COMPLETE row-projection query (`SELECT COUNT(*) FROM
(<projected query>)`), which works for a plain count but cannot host the
breakdown's `SUM(CASE WHEN d.subject_count IS NULL ...)` clauses -- the
projection already COALESCEs several of those columns to a default before
the outer query ever sees them, and the `d` alias used by every `nullTest`
is out of scope there entirely. `catalog.ts`'s two prefix-builders
(`buildPublicPrefix`/the `?mine` branch) were split into a FROM/JOIN/WHERE
base and a separate SELECT column list, so the breakdown query can run
directly against `FROM datasets d ...` the way `dataset-search.ts`'s count
query already did (it never had this trap -- its `countSearchMatches` was
already a bare `SELECT COUNT(*) FROM datasets d ...`, not a wrapped
projection).

## Consequences

- Adding the twenty-first facet is one row in each of two tables, not a new
  branch in a growing if-chain -- the overlap logic, the NULL policy, and the
  unknown-count arithmetic are written once and apply to every facet
  automatically.
- `DatasetFilterOptions` gains exactly two fields (`facets`, `includeUnknown`)
  rather than twenty; the nine flat legacy fields are unchanged, so no
  existing caller or test needed to move.
- `hasActiveFilters` (`dataset-search.ts`) folds in one call
  (`isAnyFacetActive`) instead of hand-enumerating facet keys as a third
  maintained list -- closing off the exact enumeration-drift shape that left
  Phase 2b's untested OR-gate terms silently inert.
- Every facet's column must also be projected (the D7 describe block in
  `backend/test/facet-table-correspondence.unit.test.ts` enforces it), which
  surfaced and closed a pre-existing gap: the `?mine` branch of `GET
  /datasets` had never projected `num_citations` at all, even though the
  public branch has since #804. A user could have filtered `--citations` on
  their own datasets and never seen the number that justified the result.
- `excluded_unknown` costs one extra COUNT query per request, but only when a
  facet is active -- the common unfiltered browse/search path is unaffected.
  The cost is not identical on both endpoints: `GET /datasets` runs it
  concurrently with the main query and its own count inside
  `executeAndReturn`'s `Promise.allSettled`, while `GET /datasets/search`
  runs it as a genuine extra sequential round trip after
  `countSearchMatchesSafely` returns (see the M1 correction above) -- a
  facet-filtered search request is one full round trip slower than a
  facet-filtered list request for the same reason. Phase 4 (#1148) added the
  per-facet `excluded_unknown_by_facet` breakdown to this SAME query (extra
  SELECT columns, not an extra query), so this cost accounting is unchanged.
- `bids_version`/`hed_version` stay prefix/exact only in this phase (a
  lexicographic `>=` is already wrong on production data: `'1.9.0' >
  '1.10.0'` as strings). A true semver range needs either a derived sortable
  column or the distinct-value list Phase 5's facets endpoint will expose;
  tracked as a follow-up rather than shipped as a known-wrong comparison.

## Alternatives considered

- **Add each new column as its own bespoke field on `DatasetFilterOptions`,
  the way the original nine were added.** Fastest to ship one facet at a
  time; rejected because it repeats, twenty times, the exact copy-paste
  surface that let Phase 2b's OR-gate regression through untested, and
  because it has no structural place to put the pair/overlap logic without
  duplicating it three times (age, channels, recording-length).
- **Contain instead of overlap for pair facets.** Simpler mental model
  ("only show datasets entirely inside my range"), but wrong per the issue's
  own worked example and silently so: any fixture whose dataset range nests
  inside the query range can't distinguish the two implementations, which is
  exactly why the plan calls for a fixture built to make them disagree.
- **Filter `--channels` on `n_channels` only, deferring the derived pair
  until the sweep finishes.** Simpler, and correct once the sweep completes,
  but ships a filter using a value already known wrong for some datasets with
  no path to improve without another migration later. Rejected in favour of
  one COALESCE that upgrades itself for free as the sweep runs.
- **Make `include_unknown` the default (include unless asked not to).**
  Would have kept recall high while columns are still sparsely populated,
  but silently returns rows with no relationship to the filter value the
  caller asked for -- worse than low recall, because it looks like a match.
  Rejected; the explicit escape hatch plus the reported count is the honest
  version of the same convenience.
- **Compute `excluded_unknown` per-facet.** Originally deferred here on the
  premise that it needed one query per active facet rather than one
  aggregate query. That premise was wrong -- a conditional aggregation
  (`SUM(CASE WHEN ... THEN 1 ELSE 0 END)` per active facet) computes the
  full breakdown in the SAME aggregate query, no extra round trip. Built in
  epic #1144 phase 4 (#1148); see the amendment above. No longer deferred.

## Receipts

- Epic #1144, issue #1147 (this phase); #1145 (Phase 1, the deferred
  restructure), #1146 / #1153 (Phase 2 / 2b, the columns this phase makes
  filterable).
- Issue #1148 (Phase 4): the per-facet-attribution amendment above --
  `buildExcludedUnknownBreakdownSql` (`dataset-facets.ts`), and the
  FROM/WHERE-vs-SELECT-column split in `catalog.ts`'s prefix builders.
- ADR 0005 (availability is reported, never a precondition for serving) --
  the precedent `excluded_unknown` follows.
- Migration 0070 (`recording_stats`) and 0071 (`signal_defaults`) column
  comments, for the exact NULL semantics each facet reads.
- `backend/src/lib/license.ts#parseLicenseTierFilter` -- the drop-unrecognised
  idiom an earlier version of the `enum` facet kind mirrored; `license` keeps
  it, the declared facets no longer do (#1165 review P1, see the asymmetry
  note above).
- Migration 0020 (`age_min`/`age_max`) and 0023 (its backfill, "each is
  COALESCE-preserved independently") -- why that pair's NULL test is `OR`,
  unlike the atomically-written pairs from migration 0070.
- nm000111: confirmed live case where `n_channels` (19) disagrees with the
  true per-recording distribution (70/124 recordings actually at 20).

## Amendment 2026-10-12 (#1711): `modality` is a whole-token match, and stays a bespoke filter

The Decision keeps `modality` out of the facet table because its semantics are
irregular, "LIKE-joined comma lists". For `modality` that irregularity was a defect:
`datasets.modalities` is a comma-joined list (`eeg,ieeg,meg`) and the filter was
`LOWER(modalities) LIKE '%<value>%'`, so `modality=EEG` also returned datasets whose
modalities were only `ieeg`, `%` matched every row, and `_eg` matched `meg`. Production
showed it: a search for `ieeg` with `modality=EEG` returned 97 of 100 rows with no `eeg`
token.

What is now decided:

- **One definition, in `buildDatasetFilterClauses`.** `GET /datasets` (both branches),
  every tier of `GET /datasets/search` and the MCP `search_datasets` tool all build their
  filter through it, so the fix is one clause and no caller carries its own.
- **Whole token, case-insensitive, tokenized once.** The stored list is lower-cased, split
  on every comma in SQL and each token trimmed, so the first, middle and last token are
  found the same way, `eeg` is not found inside `ieeg`, and whitespace inside a token stays
  inside it (`e eg` is one token, never `eeg`). That is the same split, trim and
  lower-case the vocabulary endpoint tallies with (`parseTokenList`), so a value the
  vocabulary advertises filters to exactly its advertised count; a route test holds the two
  together because either can be changed alone.
- **A comma-separated value matches a dataset holding ANY of its tokens**, the same OR the
  `license` filter and the enum facets use. Before, `eeg,meg` matched only a dataset whose
  stored list happened to contain those two tokens adjacent and in that order.
- **At most 32 distinct tokens per request, refused and not truncated.** A request over
  the limit is a 400 on both HTTP endpoints and a refused tool call on MCP, the way a
  malformed facet range is; truncating would answer a different question than the one
  asked. Tokens are counted after normalising, so `eeg,EEG,eeg` is one. This is an input
  contract, not a cost guard. The clause's cost is flat in the number of wanted tokens,
  because the wanted set is probed through an index: on bun:sqlite over 1,000 synthetic
  rows, one statement, about 1.3 ms for 1 to 100 distinct tokens and 3.4 ms for 8,000 (D1
  was not measured). The limit keeps a request, which is an anonymous caller's URL, small
  and predictable and gives clients one documented bound; BIDS defines 14 datatypes and
  the production vocabulary holds 12, so 32 is wider than any real request. The old `LIKE`
  was subject to the 50-byte pattern limit Cloudflare documents for D1, which bounded the
  value as a side effect; the limit here replaces that bound by declaration. It is
  declared once (`MAX_MODALITY_FILTER_TOKENS`, `shared/`), checked at the parse step of
  every entry point, enforced again in the clause builder, and can be raised by changing
  that constant.
- **The wanted tokens are one `json_each` parameter**, not one placeholder per token and
  not a LIKE pattern, so a list costs one bound parameter (the D1 ceiling,
  `MAX_BOUND_PARAMS`) and there is nothing to escape.
- **A supplied value that names no token (whitespace, bare commas) matches nothing.** It
  binds an empty list. It is not dropped, which would turn a filter the caller asked for
  into the whole catalog, and it is not a 400: `modality` predates the table and keeps the
  contract it shipped with, under which such a value narrowed to nothing. (`license` is not
  the analogy for this: it DROPS an unrecognised value and returns the whole catalog, the
  opposite of matching nothing. The only thing the two share is that neither refuses.) An
  EMPTY value is still no filter.

Not decided here: `task` and `author` remain substring filters. Their documented contract
is "substring match", and `task` has over a thousand distinct labels that people search by
fragment; they are a separate decision if the same complaint is made of them. Moving
`modality` into the facet table as a token-list kind remains possible, but it would change
`FACETS.length`, the `search_datasets` filter cap that is sized from it, and the generated
MCP and CLI flags, for no change in behavior. The admin sweep selector that reads
`modalities LIKE '%eeg%'` is not this filter: it is a substring match on purpose, because
the channel-montage probe also takes `ieeg`, and the sweep's remaining-count statement
carries a note to keep the two in step.

Receipt: `backend/test/modality-exact-token.test.ts`.
