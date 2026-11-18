# ADR 0126: Search returns what the caller can see, and the live row is the guarantee

**Status:** proposed
**Date:** 2026-11-17
**Owner:** Seyed Yahya Shirazi

Issue #2200, pull request #2201.

## Context

`GET /datasets/search` used to return public datasets only, so an owner could not find their own private deposit and a collaborator could not find one shared with them, while `GET /datasets/:id` already showed both.
The Vectorize index caps one query at 100 candidates, so a private vector in an unfiltered query competes with public ones for those slots.
A vector label (`visibility`) can be stale for as long as it takes the embed drain to reach the row.

## Decision

1. **Search returns what the caller can see**, by the rule `GET /datasets/:id` enforces: anonymous sees public datasets, a signed-in user also sees those they own or collaborate on, an admin sees all.
   The rule is one SQL predicate, `buildViewerVisibilitySql`, evaluated against the live `datasets` row.
2. **Every active, non-sandbox dataset is embedded**, private included, so semantic search works for the people who can see it.
   Until `VECTORIZE_VISIBILITY_FILTER=1`, only public datasets are embedded (the drain and `POST /admin/vectorize/reindex-all` skip the rest), because an unfiltered top-100 pool would otherwise lose public candidates to private ones that are then dropped.
3. **Layer 2, the live D1 re-check of every hit, is the guarantee.**
   It always runs, whatever the index says, so a stale or missing label can cost recall and never exposes a dataset.
4. **Layer 1, narrowing the vector query by the `visibility` and `dataset_id` metadata, is an optimization behind the flag.**
   A filtered query that returns nothing is retried unfiltered, because a missing metadata index looks like an empty result.
   A visibility or status change marks the row `embedding_dirty = 2`, and the drain takes the highest value first, so a just-flipped dataset is relabeled ahead of a backlog of content edits.
5. **The list route is not yet aligned.**
   `GET /datasets` and `GET /datasets/facets` show private rows to admins only, so for a signed-in owner or collaborator list and search disagree.
   Sharing `buildViewerVisibilitySql` there is a follow-up, not part of this decision.

## Consequences

- Responses to `/datasets/search` are `no-store` for every caller.
- Turning the flag on has an order: metadata indexes, deploy, `reindex-all` until `has_more` is false, flag on, `reindex-all` again to embed the private rows.
- Anonymous deposits stay concealed (null DOI, no owner fields) in every viewer's results.

## Alternatives considered

- Filtering by the label alone: a stale label would leak a dataset; rejected.
- Embedding private rows before the flag: costs anonymous recall from deploy; rejected.
