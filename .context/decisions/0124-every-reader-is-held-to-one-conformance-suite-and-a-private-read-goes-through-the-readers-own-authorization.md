# ADR 0124: Every reader is held to one conformance suite, and a private read goes through the reader's own authorization

**Status:** proposed
**Date:** 2026-11-14
**Owner:** Seyed Yahya Shirazi

Epic #2145.
This Architecture Decision Record (ADR) records how NEMAR keeps its Zarr readers equal to one another, and how a reader is meant to read private data.
It builds on ADR 0120 (the Zarr read core and the local engine protocol), which is proposed in the collaborator's reader epic, pull request #2144, and is not on `dev` until that pull request merges, so it is named here and not linked.
It also builds on [ADR 0114](0114-an-authenticated-data-host-is-read-through-the-clis-own-remote-and-credential-helper.md) and [ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md).
It supersedes nothing, and it leaves ADR 0120's verdicts as they are: it settles, as a design goal, the one question ADR 0120 decision 9 leaves open that this program needs, how a private dataset is read, and it builds none of it.

## Context

NEMAR's Zarr serving copy is read by more than one program.
Three readers are meant to survive: the TypeScript core of ADR 0120, which serves the command-line interface (CLI), the Model Context Protocol (MCP) Worker and the local engine; eegprep-lean, the Python reader that also runs under Pyodide; and EEGDash's own reader, which that team maintains.
A decoder that has to agree with the converter byte for byte drifts when it is copied, as ADR 0120 records; three readers in three languages drift unless something holds them to the same answers.
A public store must also stay readable by stock zarr-python or xarray, with no NEMAR code.
The conversion will change (a formats contract, and shadow conversions run beside the cron's), and the review finding is that two conversions of one recording cannot be expected to be identical even apart from their timestamps, so a change needs a comparison that depends on neither bytes nor timestamps.
ADR 0123 decision 4 defines a store content digest, and every derivative key depends on it: two readers that compute different digests of one store name different derivatives.
Private data is not read this way yet.
The engine of ADR 0120 reads public Zarr only: its fetcher refuses a request that carries `Authorization`, `Cookie` or `Proxy-Authorization`, and its disk cache holds public bytes only.
ADR 0120 decision 9 leaves private access open, and decisions 10 and 11 say a private source attaches credentials per request to an origin ADR 0114's list admits and that private bytes never share the public cache.
The owner decided on 2026-11-13 that the design goal is one reader that reads public and private data by the authorization the person or job holds, and that runners ([ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md)) read public data only for now.

## Decision

1. **A job reads only what it needs, into a directory of its own, and keeps it only for the job.**
   Inputs land in the job's own directory under the runner root, mode 0700, are deleted in a `finally`, and any directory left by a crash is swept when the runner starts.
   Private bytes never enter a shared cache.
   A shared cache outlives the access that fetched what is in it, and a job's directory does not.
2. **A public store stays readable with no NEMAR code, and the three readers are held to one conformance suite.**
   Stock zarr-python or xarray reads any public store with no NEMAR code; that is the guarantee.
   The three readers (the TypeScript core, eegprep-lean and EEGDash's own) each pass the same suite, so one recording gives one answer from each.
3. **The suite lives in nemar-cli and is copied, byte for byte, into every repository outside nemar-cli that holds a reader.**
   Its cases, fixtures and goldens are in `shared/contract/zarr-conformance/`, which is where a change to them is made and the only place it is made.
   Each such repository keeps a copy with a pinned digest and a drift check against nemar-cli's, the way `nemarOrg/nemar-process` copies the launch specification schema (ADR 0118).
   A copy edited in place is a failing check, not a local fix.
   The reason is that a suite is an oracle only while every reader runs the same bytes of it, and a copy that can be edited in place stops being one.
4. **The suite includes the store content digest, so every reader computes the same digest of the same store.**
   The digest is `nemar.store-content.v1`, defined in ADR 0123 decision 4 and in `shared/contract/derivatives.ts`, and its cases are the vectors in `shared/contract/derivatives-vectors.json`.
   This ADR does not restate the definition.
   A reader whose digest of a vector differs fails the suite, and where the reader, ADR 0123, the module and the vector disagree, the rule in ADR 0123's own introduction settles it: one of them is wrong and the maintainer decides which.
5. **The suite is the comparison oracle for any conversion change.**
   Two conversions are compared by decoding both through the suite's readers and comparing the decoded values against a tolerance written down before the comparison is run, never by bytes or timestamps.
   The tolerance is fixed first so that a result cannot be argued into a pass afterwards.
6. **The design goal is one reader that reads public and private data by the authorization its person or job holds, through an authorization-aware Fetcher.**
   The Fetcher sits behind the core's existing `Fetcher` interface (`(url, init) => Promise<Response>`), so the core does not change.
   Public data is fetched anonymously.
   In the CLI and the engine, private data is fetched through the person's own credential path, on the origins ADR 0114's list admits (`src/lib/data-hosts.ts`); where a credential may go is the rule of ADR 0114 and ADR 0120 decision 10, which this ADR cites and adds no copy of.
   On a runner, later, the launcher fetches private data with a job-scoped read grant and stages it for the job (decision 7), and the job itself does not fetch it.
   The private tier's own access check decides what a person or a job may read.
   No shared cache holds private bytes; whether a person's own machine may keep any is the separate decision ADR 0120 decision 11 already requires, which must also say how revocation reaches it.
   This is a design goal and nothing in this ADR builds it.
   Until it is built the engine reads public data only: nothing in the reader epic hands it a credential, and its refusal of `Authorization`, `Cookie` and `Proxy-Authorization` is a guard against a later change that would, not behavior a person meets; an anonymous request for a private dataset fails at the index read, as an error.
7. **Runners read public data only until a launcher stages private inputs for a job with no network.**
   The launcher, not the job, fetches the bytes with a job-scoped read grant and stages them into the job's directory (decision 1); the job then holds the bytes and has no network.
   A runner is a machine outside NEMAR's control, and a job that holds both a network and private bytes can send them anywhere.
   The owner decided this on 2026-11-13, and a private read on a runner needs the launcher's staging, a no-network container, scratch that is encrypted or kept in memory, a per-dataset permission and an access record to exist first.

## Consequences

- A format or decoder change is made once in nemar-cli, with its cases and goldens, and then copied into the repositories outside nemar-cli; the price is a slower change and a drift check in each of them.
- A conversion comparison needs the suite's readers to exist, so shadow conversions cannot be judged until they do.
- The digest cases make a keying disagreement between readers a test failure instead of a set of orphaned derivatives.
- Until the Fetcher exists, a private dataset is not readable through the engine: a request for one fails with an error at the index read, and the engine's refusal of credentials is a guard, not what a person meets.
- A private job cannot run on a workstation runner until the staging exists, and that is the intended cost of the owner's decision.
- The credential rule is ADR 0114's and ADR 0120 decision 10's, and this ADR adds no new copy of it, because two copies drift.

## Alternatives considered

- **One reader everywhere, the TypeScript core:** eegprep-lean has to run inside the compute image and under Pyodide, and EEGDash's reader belongs to another team.
- **No suite, comparison in review:** that is how copies drift, and nothing would say which copy is right.
- **Compare conversions by bytes or by "identical except timestamps":** the review finding is that identical except timestamps is not attainable, so a correct conversion would fail and the check would be set aside.
- **Let the credential go to the Zarr host:** ADR 0114's list is the one list a credential follows, and ADR 0120 decision 10 already keeps the Zarr settings off it.
- **A shared on-disk cache for private bytes, one per account:** access can be revoked and cached bytes would outlive it (ADR 0120 decision 11).
- **Private reads on a runner now:** a job with a network and private bytes has no boundary yet, so the owner's decision of 2026-11-13 holds the line.

## Receipts

- [ADR 0114](0114-an-authenticated-data-host-is-read-through-the-clis-own-remote-and-credential-helper.md) (the list a credential follows) and [ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md) decision 4 (the store content digest), with `shared/contract/derivatives.ts` and `shared/contract/derivatives-vectors.json`.
- ADR 0118 (`shared/contract/compute-launch.schema.json`, copied byte for byte by `nemarOrg/nemar-process`).
- ADR 0120 decisions 9 to 11, and on the branch of pull request #2144 at head `98d273bd`: `shared/zarr/interfaces.ts` (the `Fetcher` type), `src/lib/zarr-engine/http.ts` (`createPublicFetcher`, which refuses `Authorization`, `Cookie` and `Proxy-Authorization`) and `src/lib/zarr-engine/source.ts` (the `DataSource` seam, with the public source its only implementation today).
- The owner's decisions of 2026-11-13 (the design goal and public-only runners) and of 2026-11-14 (the upstream branch and the early merge of the reader epic), and the review finding that identical except timestamps is not attainable, so conversions are compared by decoded arrays through the readers with a tolerance.
