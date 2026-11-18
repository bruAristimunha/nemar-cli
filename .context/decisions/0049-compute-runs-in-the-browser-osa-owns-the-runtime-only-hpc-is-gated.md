# ADR 0049: Compute runs in the browser by default, OSA owns the execution runtime, and only HPC submission is gated

**Status:** accepted
**Date:** 2026-09-08
**Owner:** Seyed Yahya Shirazi

**Amendment 2026-09-22:** The first-load cost under "Costs accepted" was an estimate, and it was high.
Measured on Pyodide 0.29.5 as uncompressed bytes (a compressed transfer is smaller):
the interpreter is 5.3 MB, and NEMAR's browser runtime as shipped (OpenScience-Collective/osa#448),
numpy, matplotlib, zarr and eegprep-lean with their dependencies, is 23 packages and 13.6 MB,
so a first load is 18.9 MB.
Adding scipy, the next thing a preprocessing step needs, brings it to 35.2 MB, scipy alone being 16.3 MB.
The verdict stands; the cost it accepted is smaller than it said.

**Amendment 2026-11-03:** Stage 3, HPC submission, is specified by [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md): who runs a job, who holds its record and how time is counted.
The verdict stands.

**Amendment 2026-11-13:** Stage 3 also runs on a workstation runner that polls NEMAR and writes no ledger entry, as [ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md) decides.
The verdict stands.

Supersedes ADR 0025.
The parts of 0025 that still hold are restated here so this document is the single current statement;
0025 is kept for its history.

## Context

ADR 0025 settled three things at once:
the MCP is a stateless, recipe-first broker on Cloudflare Workers;
inference compute runs on the user's device;
and the first-party chatbot is an OSA assistant hosted on nemarring.ucsd.edu.
It also recorded that eegprep depends on `oct2py`, so it "cannot run in a browser",
made MNE the browser engine, and accepted engine drift between the browser and desktop lanes.

Two of those premises did not survive contact.
eegprep 0.3.0 ships as a pure-Python wheel;
its only `oct2py` import is a lazy import inside the EEGLAB comparison bridge (`eegprep/eeglabcompat.py`),
and `psutil` is imported the same way.
What blocks a browser install is the dependency declaration in `pyproject.toml`
(`oct2py`, `pyedflib`, and `psutil`; the ICA dependency `python-picard` is pure Python and its `numexpr` use is optional), not the algorithms.
The owner maintains eegprep, so that is a packaging fix, not a constraint.
Separately, the OSA NEMAR assistant is deployed at `api.osc.earth`, not nemarring,
and OSA is gaining a browser-side code execution runtime.

The product vision has also sharpened into three stages:
the assistant writes code and runs it against streamed data;
the user tinkers with the same script and results in a notebook;
the user submits the work to a supercomputer.
The open question was where compute runs at each stage and where the login boundary sits.

## Decision

**Three stages, one engine, one login boundary.**

1. **Stage 1, assisted execution, runs in the user's browser.**
   The assistant's `execute_code` tool is executed by the widget in a Pyodide worker,
   driven from OSA's server-side LangGraph through client-executed tool calls.
   It is anonymous.
   Nothing of NEMAR's is used beyond the public data plane and the MCP recipes.
2. **Stage 2, tinkering, is the same browser runtime behind a notebook surface.**
   Scripts and results move between stage 1 and stage 2 through browser storage.
   It is anonymous.
3. **Stage 3, HPC submission, goes through a NEMAR gateway** and is the only stage that requires
   ORCID identity, the service tier, and the export-control review that website ADR 0010 reserves for compute.

**eegprep is the default engine in every lane**, browser included,
once its pure-Python core installs under Pyodide.
MNE is the fallback until then, and the assistant names the engine it used.

**OSA owns the execution runtime, and it is community-agnostic.**
NEMAR contributes a runtime configuration block, a pure-Python recipe reader, and the MCP.
The chatbot runs wherever OSA runs; nemarring is not a requirement.

**Carried forward from 0025, unchanged:**
the MCP is a stateless, recipe-first broker on Workers;
the Worker never decodes signal data beyond a capped taste;
bulk bytes go direct to S3.
NEMAR serves bytes and understanding.
It now also hands the user a place to run the science, in their own browser, but it does not run it for them.

## Consequences

- **eegprep packaging is on the critical path.**
  Move `oct2py`, `pyedflib`, and `psutil` into extras, keep the lazy imports,
  and add a CI job that installs eegprep under Pyodide and runs the EEGLAB-parity tests there.
  ICA needs no new dependency: `runica` and `eeg_picard` are pure numpy and scipy, and `python-picard`
  falls back to numpy when `numexpr` is absent. Browser ICA speed depends on routing matrix products
  through scipy's OpenBLAS, because Pyodide builds numpy without BLAS; ICLabel needs a torch-free
  inference path before it is available in the browser.
  Until it lands, the browser lane uses MNE; that is a tracked gap, not accepted drift.
- **Browser reads are HTTPS only.** WebAssembly has no sockets,
  so `boto3`-based clients (eegdash, and nemar-py as packaged today) are not browser clients.
  Recipes must carry the HTTPS `data_base`, which index v3 does,
  and a small pure-Python reader that turns a recipe into a numpy array is needed.
- **Every executing origin must be allowed to read the data plane.**
  The S3 bucket CORS policy and the `zarr.nemar.org` browser-origin allowlist must cover
  `nemar.org` for the embed and `osc.earth` if the widget executes there.
  Allowlisting an origin routes its bytes through the Worker; widening S3 CORS does not.
  Decide per origin.
- **Memory is the binding constraint, not CPU.** wasm32 tops out between 2 and 4 GB,
  so the assistant asks the MCP for a slice or the view pyramid, never a whole recording.
  The read cap and recipe design in #1065 is what makes the browser lane feasible.
- **The backend's compute-adjacent roles are exactly three:**
  recipes through the MCP, the origin allowlist, and the stage-3 gateway
  (website #6's NSG connector sketch is the prior art).
  No kernels, no sandboxes, no job runners in the Worker, and no per-user compute on the OSA host.
- **History lives in browser storage.** Syncing it for signed-in users is a later option, never a requirement.
- **Costs accepted:** a first load of roughly 50 to 60 MB for the scientific stack, cached afterward;
  no threads or GPU in the browser;
  two OSA design items, interrupt-and-resume tool calls and a checkpointer,
  precede any NEMAR-visible feature.

## Alternatives considered

- **Server-side execution as a tool on the OSA host.**
  The host is a thin CPU that orchestrates LLM calls; per-user numpy saturates it at a handful of sessions,
  model-written code on a shared host needs real sandboxing, and egress would scale with users. Lost.
- **Hosted per-user kernels behind the service tier.**
  A coherent continuum, but it makes NEMAR a compute service, adds an ops surface,
  and gates stages 1 and 2 behind login. Rejected by the owner; only stage 3 is gated.
- **Server for stage 1, Pyodide for stage 2 only.**
  Two engines, two package sets, and results that do not carry over at the handoff that matters. Lost.
- **Client-side agent loop (the QP pattern).**
  Moves the whole loop into the browser and loses server-side retrieval tools, budget enforcement, and threads.
  Kept as the fallback if interrupt-and-resume proves unworkable.
- **MNE as the permanent browser engine.**
  Accepts the drift 0025 accepted. Lost, because the `oct2py` premise was wrong and the owner controls eegprep.

## Receipts

- ADR 0025 (superseded); `.context/draft-zarr-inference-ecosystem-plan.md` sections 2 and 6.
- eegprep 0.3.0 on PyPI is `py3-none-any`; lazy `oct2py` import at `src/eegprep/eeglabcompat.py`;
  hard dependencies in `pyproject.toml` (sccn/eegprep, checked 2026-09-08).
- Pyodide's package list includes numpy, scipy, matplotlib, h5py, sympy, zarr, numcodecs, pyarrow, fsspec, sqlalchemy;
  MNE 1.12.1 and mne-bids 0.19.0 are pure Python (PyPI `requires_dist`, checked 2026-09-08).
- OSA design note: `.context/browser-execution-tool-design.md` in OpenScience-Collective/osa,
  and the client-executed `execute_python_code` prior art in its `.context/tool-system-guide.md`.
- website ADR 0010 (service tier is upload plus compute, export-control review); website #6 (NSG connector).
- nemarOrg/nemar-cli#1065 (MCP), #1063 (User-Agent convention).
  Verified 2026-09-08: `api.nemar.org` and `zarr.nemar.org` return 403 to the `Python-urllib` User-Agent only.
- Catalog on 2026-09-08: 623 datasets serve Zarr, 42 are fidelity-verified,
  so `has_zarr` is the availability filter and the verify status rides in the provenance envelope.
