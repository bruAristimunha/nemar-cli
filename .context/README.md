# `.context/` — map

Documents accumulated here over the project's life, mixing binding decisions,
live runbooks, point-in-time research, and completed plans. Nothing distinguished them, so a
reader could not tell a current rule from a superseded one. This index does that.

**Start with [`decisions/`](decisions/README.md).** Where any document below disagrees with an
ADR, **the ADR wins** — these keep the analysis, the ADR is the verdict.

Documents that record completed work carry a `STATUS: HISTORICAL` banner. They are kept because
*how* something was decided is worth having, but they are not a current-state reference.

---

## Decisions

- [`decisions/`](decisions/README.md) — the Architecture Decision Records, index enforced by
  `test/adr-index.unit.test.ts`. Read before designing, and before "fixing" something that looks
  odd — several oddities here are deliberate.

## Where each document is headed

Every row below carries a **Destination**, the classification ADR 0058 assigns it, as groundwork for
epic #1336 phase 3. Four documents have moved, and the table below links them at their URLs: the systems inventory, the validated workflows, the staging plan and the D1 backup research now live in `nemarOrg/docs` under `/admin/`, private at source and served through the gate (epic #1336 phase 3).

| Value | Meaning |
|---|---|
| `public` | Stays here, in this public repo, and may be published to docs.nemar.org. |
| `private` | Lives in `nemarOrg/docs`, which is private at source, and is served gated at docs.nemar.org. ADR 0057 originally said "a private content repo"; ADR 0059 replaced that with one docs repo, private at source and public at the URL. |
| `stays-with-code` | Belongs next to the code it binds and is not a docs-site candidate. |

`decisions/` is `stays-with-code` as a whole, as are `.rules/*` and `AGENTS.md`'s hard rules.
Destination only: the reasoning is in ADR 0058 as a general rule and deliberately not restated
per file.

## Current reference

Trust these for how things work today.

| Document | What it is | Destination |
|---|---|---|
| [systems-inventory.md](https://docs.nemar.org/admin/operations/systems-inventory/) | Every host and service, with paths, cron schedules, and deploy procedures. Expands the map in `AGENTS.md`. | private |
| [validated_workflows.md](https://docs.nemar.org/admin/operations/validated-workflows/) | Workflows proven by prototype, with the gotchas. The git-annex and staging-to-final recipes live here. | private |
| [release-safety-playbook.md](release-safety-playbook.md) | Environments, promotion path, pre-release checks. | public |
| [recover-runbook.md](recover-runbook.md) | Recovering 0-byte imports (epic #967 Phase 5). | public |
| [access_control.md](access_control.md) | How collaborator-based access is implemented. | public |
| [dataset_workflow.md](dataset_workflow.md) | Dataset lifecycle: IDs, upload, download, versioning. | public |
| [pr_architecture.md](pr_architecture.md) | PR + staging mechanics. **The branch-protection payload it described is superseded**; see ADR 0001. | public |
| [phase5-cross-repo-owner-deploys.md](phase5-cross-repo-owner-deploys.md) | Known cross-repo gaps needing owner action. | public |
| [epic_browser_compute_state.md](epic_browser_compute_state.md) | The live map of the in-browser compute epic across osa, eegprep, nemar-cli and website: what is decided, what blocks what, what is still open. | public |
| [epic_email_cloudflare.md](epic_email_cloudflare.md) | The live map of the email epic (#1893): moving all NEMAR mail to the Cloudflare Email Service, what is decided (ADR 0110), the phases and what is still open. | public |
| [eegprep_lean_contract.md](eegprep_lean_contract.md) | What `eegprep-lean` will guarantee and where it deliberately differs from eegprep. The deliverable ADR 0069 names; drafted before the package exists. | public |
| [ideas.md](ideas.md) | Exploratory design notes. Frequently rewritten; promote settled items to an ADR. | public |
| [research.md](research.md) | Prior art from the `nemar-tools` scripts. Describes the **pre-NEMAR** Zenodo flow; DOIs are EZID now (ADR 0007). | public |

## Design notes

Longer-form design documents. Found unlisted by the phase 1 inventory sweep (#1339) and added
here, since an index that misses a document cannot classify it either.

| Document | What it is | Destination |
|---|---|---|
| [mcp-server-design.md](mcp-server-design.md) | The MCP server design, the largest document here. | public |
| [draft-zarr-inference-ecosystem-plan.md](draft-zarr-inference-ecosystem-plan.md) | Draft plan for inference over the Zarr serving copy. | public |
| [draft-817-submission-minimums-policy.md](draft-817-submission-minimums-policy.md) | Draft submission-minimums policy. | public |
| [draft-1036-validator-3x-evaluation.md](draft-1036-validator-3x-evaluation.md) | Evaluation of bids-validator 3.x. | public |
| [draft-anonymous-deposit-analysis.md](draft-anonymous-deposit-analysis.md) | Pseudonymous deposit for double-blind review: the leak inventory, and what the chosen design (public data, private repository) requires. ADR still to be written. | public |
| [draft-eegdash-zarr-issues.sh](draft-eegdash-zarr-issues.sh) | Script drafting the EEGDash Zarr issues. The one non-markdown document here, which is why a markdown-only sweep missed it. | public |
| [plans/spec-pr1.md](plans/spec-pr1.md) | Column-budget rebuild spec (issue #1182). In `plans/`, which a top-level sweep missed. | public |
| [publication-review-design.md](publication-review-design.md) | The analysis behind ADR 0102 (epic #1726): what was read, the pull-request review compared with the publication review, the data flow, the screen-first options, the cost arithmetic, the calibration plan, the initial vocabularies, the refined phase plan and the risks. Analysis, not a ruling. | public |

## Research — point-in-time findings

Measurements and investigations. Accurate as of their date; re-verify before relying on numbers.

| Document | Question it answered | Destination |
|---|---|---|
| [research-catalog-consolidation.md](research-catalog-consolidation.md) | How to collapse the two dataset tables (-> ADR 0003). | public |
| [research-d1-backup-655.md](https://docs.nemar.org/admin/disaster-recovery/d1-backup-research/) | How to back up D1 (-> ADR 0004). | private |
| [research-submission-minimums-deskreject.md](research-submission-minimums-deskreject.md) | How many datasets would trip each proposed reject rule (-> ADR 0014). | public |
| [research-archive-import-candidates.md](research-archive-import-candidates.md) | Survey of ~90 non-OpenNeuro archives (-> ADR 0013). | public |
| [research-openneuro-import-forensics.md](research-openneuro-import-forensics.md) | Why a 5-dataset import batch failed. | public |
| [openneuro-support-403-report.md](openneuro-support-403-report.md) | Objects inaccessible upstream, for reporting. | public |
| [security-fix-dataset-visibility.md](security-fix-dataset-visibility.md) | The 2026-01 private-dataset leak (-> ADR 0017). | public |
| [plan-multi-archive-importer.md](plan-multi-archive-importer.md) | Architecture RFC for multi-archive import (-> ADR 0013, **proposed**). | public |
| [research-make-vs-take-audit.md](research-make-vs-take-audit.md) | 2026-09-03 audit of bespoke code an established library or platform feature already covers, with replace / wrap / keep verdicts (-> ADR 0037). | public |
| [research-agent-findability.md](research-agent-findability.md) | 2026-09-03: how AI agents and crawlers actually find datasets (robots tokens, sitemaps, JSON-LD, registries, DataCite); evidence that llms.txt and markdown mirrors are not read; Zarr guidance for agents (-> OSCAR epic). | public |
| [research-publication-review-calibration.md](research-publication-review-calibration.md) | How often the publication review's model is judged wrong on published datasets and how many seeded defects it catches, so the model for the soak can be chosen (-> ADR 0102, call 6). Method and empty results tables; **awaiting the operator's run**. | public |

## Historical — completed work

Records of what was done. Do not use as a current-state reference.

A table rather than a list, so each carries a destination like every other document here.

| Document | Destination |
|---|---|
| [plan.md](plan.md) | public |
| [prototyping_plan.md](prototyping_plan.md) | public |
| [architecture_review.md](architecture_review.md) | public |
| [epic_central_manifest_state.md](epic_central_manifest_state.md) | public |
| [epic_browser_compute_state.md](epic_browser_compute_state.md) | public |
| [sprint_review_publication_workflow.md](sprint_review_publication_workflow.md) | public |
| [deleted-datasets-incident.md](deleted-datasets-incident.md) | public |
| [blast-radius-catalog-fold.md](blast-radius-catalog-fold.md) | public |
| [plan-923-test-staging.md](https://docs.nemar.org/admin/operations/staging-environment/) | private |
| [plan-legacy-separation-793.md](plan-legacy-separation-793.md) | public |
| [plan-import-robustness.md](plan-import-robustness.md) | public |
| [plan-phase2-retry-engine.md](plan-phase2-retry-engine.md) | public |
| [draft-1023-service-access-endpoints-plan.md](draft-1023-service-access-endpoints-plan.md) | public |

Historical does not mean harmless: a completed plan can still name things that are current, which
is why these are classified individually rather than as a block.

---

## Known stale content, deliberately kept

Left in place because the surrounding document is still useful, each annotated inline:

- **`plan.md` "Storage Strategy"** lists Zenodo for DOIs — superseded by ADR 0007.
- **`prototyping_plan.md`** shows `enforce_admins=true` protection payloads — superseded by ADR 0001.
- **`epic_central_manifest_state.md`** ops sequence references the retired personal Cloudflare
  account — superseded by ADR 0008.
- **`architecture_review.md`** item 2 is marked RESOLVED but was later reversed — see ADR 0019.
- **`draft-1023-service-access-endpoints-plan.md`** proposes separate service-access grant/revoke
  endpoints — superseded by ADR 0040, which puts the grant on approve/revoke themselves.

## Adding to this directory

- A **decision** goes in `decisions/` as an ADR, not here.
- A **runbook or reference** goes here and gets a row in "Current reference" above.
- When a plan is finished, add the `STATUS: HISTORICAL` banner and move its row to Historical
  rather than deleting it.
