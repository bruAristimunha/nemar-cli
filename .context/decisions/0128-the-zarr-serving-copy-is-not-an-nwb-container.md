# ADR 0128: The Zarr serving copy is not an NWB container

**Status:** accepted
**Date:** 2026-11-18
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR was asked to adopt Neurodata Without Borders (NWB) on Zarr, written by `hdmf-zarr`, for its Zarr serving copy.
The options were: adopt it as the store format; produce a compatible export; embed more NWB- or BIDS-shaped metadata in NEMAR's own stores; or decline.
The question will come back, from users and from funders, so this record holds the whole answer.
External facts below were true on 2026-11-18 and will age; recheck them before relying on them.

**NEMAR's store.**
A derived, latest-only Zarr v3 store per raw recording, at the BIDS path with the data file's extension replaced by `.zarr`, rewritten in place on re-conversion and generated from the BIDS dataset at `source_commit`.
It is a frequency-capped, minimally lossy alternative to the data file, not to the dataset: the BIDS dataset and its sidecars stay the record.

- Normalization: rate caps (EEG and MEG 250 Hz, iEEG and EMG 1000 Hz; `min(native, cap)`, never upsampled; anti-aliased, zero-phase polyphase resampling);
  `int16` with a per-channel `scale` and `offset` spanning each channel's own range (`physical = digital * scale + offset`);
  modality from the BIDS filename suffix; `channels.tsv` units applied; MaxShield MEG corrected or declined.
- Layout: channel groups `<modality>_<rate>hz`; level 0 shaped `[n_channels, n_samples]`, sharded, blosc zstd; a min/max `view/` pyramid; a light `events` group (onset, duration, code, label map); no consolidated metadata.
- Embedded metadata: channel labels, types and units, rates, power line frequency, electrode positions, and a `nemar` provenance block (`dataset_id`, `doi`, `license`, `citation`, `source_commit`, `engine_version`, ...).
  Subject information is excluded (`subject_info_excluded: true`); participants stay in `participants.tsv`.
- Dataset level: `index.json` (format version 3, layout paths `const` in its schema) and `events.parquet` (full event columns across recordings).
- Readers: the MCP server, the browser runtime, the website viewer, the catalog sweep, and the local reader in progress (#2144).

**NWB on Zarr.**

- Layout: `hdmf-zarr` writes Zarr v3 only since release 0.14, a change older readers cannot open.
  `neurodata_type`, `namespace` and `object_id` are attributes; links and object references use reserved attributes (`_LINKS`, `_DTYPE`, `_REFERENCE_FIELDS`, `.specloc`);
  compound types use the v3 `struct` type with `fixed_length_utf32`, which needs Zarr extension data types;
  the schema is cached in the file; consolidated metadata is on by default and must be re-consolidated after any update; writing goes to a local store only.
- Data model: `TimeSeries` data is time-first, with one `conversion` and `offset` per series.
  A file requires `identifier`, `session_description` and `session_start_time`, and an electrodes table needs an `ElectrodeGroup` and a `Device`.
  Events use `TimeIntervals` and the newer `EventsTable`; `ndx-hed` maps BIDS `events.tsv` and `events.json` onto them.
- Maturity: the maintainers call the backend under development and experimental; NWB Inspector skipped Zarr validation because of `hdmf-zarr` bugs, and PyNWB path validation opens HDF5 only; DANDI upload of Zarr NWB was an open issue.
- Fit: `ElectricalSeries` is framed around extracellular recordings, though scalp EEG is commonly stored in it; no core MEG type was found; MNE has no NWB reader or writer.

OME-Zarr (Open Microscopy Environment) was considered too: it is built around multidimensional images, with no model for multichannel recordings with events.

## Decision

The serving copy is not an NWB container and will not be made NWB-conformant, for three reasons:

1. **Separate scope.** NWB is the complete archival record of a session; a store is one recording's normalized signal, and BIDS is the record.
   Conformance would need session, subject and device fields that stores omit on purpose, and would copy metadata BIDS already holds; a second copy of mutable metadata drifts.
2. **Technical incompatibility.** Time-first arrays and per-series scaling against channels-first arrays and per-channel scaling;
   typed objects linked by references, a cached schema, compound types on extension data types;
   consolidated metadata that goes stale under NEMAR's in-place re-conversion.
3. **The NWB Zarr specification is not settled.** Under development, a recent change that older readers cannot open, and incomplete validation.

Stores embed only derived technical metadata needed to decode and interpret the signal.
Any NWB output NEMAR ever produces is a stateless export generated on request from the store and the BIDS dataset at `source_commit`, never a second stored copy.

**One copy, and how drift is refused.**

- The BIDS repository at a commit is authoritative; every store is a function of `source_commit`, `engine_version` and the pinned biosigIO release.
- Embedded metadata is written in the same pass as the samples and never patched afterward; changing what is embedded bumps the engine version, which re-queues the archive.
- A store whose `source_commit` or `engine_version` differs from the index is stale; the index build already refuses a commit mismatch.
- Never embedded: participant or session fields, verbatim sidecar JSON, an NWB-shaped hint block, NWB object identifiers.
- Not built yet: a `metadata_digest` of the canonicalized embedded attributes, recomputed by the sweep from the sidecars at `source_commit` for a sample of stores, with a mismatch as a failure.
  The store content digest of ADR 0123 covers level-0 values only, so this would be new, defined byte for byte in `shared/contract/` with shared test vectors, as ADR 0123 does.

## Consequences

- Two NWB ideas are aligned on purpose so a conversion stays straightforward:
  `physical = digital * scale + offset` is NWB's `conversion` and `offset` given per channel,
  and event columns follow BIDS and Hierarchical Event Descriptors (HED), which `ndx-hed` maps onto NWB.
- The layout stays NEMAR's own and is specified as its own format, `biosig-zarr`, with biosigIO as one exemplar implementation, not its definition:
  a pre-beta specification (nemarOrg/docs#122), the tag renamed from `biosigio-zarr` with `format_version` unchanged (#2217), and beta tracked in neuromechanist/biosigio#179.
  Its license follows OME-NGFF's model (specification text under the W3C Software and Document License; software, schemas and test vectors under Apache 2.0);
  it lives on docs.nemar.org while pre-beta, moves to a public repository at beta, and gets its own organization only when a second institution co-maintains it.
- A store is distributed as an alternative to a data file: `nemar dataset download --zarr` (#2216) writes a file snapshot of the BIDS tree with each data file swapped for a single-file `.bzx` package (OME-Zarr RFC-9 packing rules) and the rate-dependent sidecar fields rewritten mechanically.
  The events group stays deliberately light, like a data file's own annotations; the full events stay in `events.tsv`, and `events.parquet` is never packed into a `.bzx`.
- Revisit when any two hold: a named consumer needs NWB with a concrete tool that reads it; DANDI accepts Zarr NWB uploads and NWB Inspector validates Zarr; `hdmf-zarr` drops its under-development status; MNE gains NWB read and write; NWB gains core scalp EEG or MEG types.
  Revisiting means building the stateless export, not changing the store.

## Alternatives considered

- **Adopt NWB-Zarr as the store format:** rejected for the three reasons above.
- **Store an NWB export alongside each store:** rejected; a second stored copy of metadata that drifts from BIDS.
- **Embed an NWB-shaped hint block, or verbatim BIDS sidecars, in each store:** rejected; another mutable copy, with no reader that needs it.
- **Two arguments considered and dropped:** that no JavaScript reader exists for NWB Zarr (not a reason of principle, and one was in progress),
  and that conforming would mean rebuilding the converter and every reader (it invites the question of why that was not done sooner).

## Receipts

- `hdmf-zarr` storage specification and status: https://hdmf-zarr.readthedocs.io/en/stable/storage.html, https://github.com/hdmf-dev/hdmf-zarr
- NWB schema: https://nwb-schema.readthedocs.io/en/latest/format.html; HED in NWB: https://www.hedtags.org/hed-resources/HedAnnotationInNWB.html
- NWB Inspector Zarr validation: https://github.com/NeurodataWithoutBorders/nwbinspector/issues/513; DANDI Zarr NWB upload: https://github.com/dandi/dandi-cli/issues/1310
- OME-Zarr zipped form, RFC-9: https://ngff.openmicroscopy.org/rfc/9/
- docs.nemar.org Zarr serving copy overview, sections on the data-file alternative, lossiness, and the format choice (nemarOrg/docs#121).
- Issues #2216 and #2217; neuromechanist/biosigio#179; the local reader, #2144.
