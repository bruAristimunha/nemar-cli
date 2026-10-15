# ADR 0106: An owner may attest an ORCID iD on an account, marked verified with no sign-in record behind it

**Status:** accepted
**Date:** 2026-10-15
**Owner:** Seyed Yahya Shirazi

Partially supersedes [ADR 0096](0096-admins-find-an-account-by-any-field-and-edit-a-closed-set-of-fields.md),
decision on the ORCID iD only: the admin edit now carries an owner's attestation of an iD, and still never
replaces one the person proved.

## Context

An account can carry an ORCID iD in `users.orcid` that the person never proved by signing in. DOI enrichment
fills that column as a citation value (ADR 0041), and `orcid_verified` stays 0 with no `oauth_identities` row.
The ORCID link flow is the only way to prove it, and it can get stuck: a link intent expires unconsumed, the
browser round trip is abandoned, or the person cannot be reached. Account 19 (2026-10-15) is the case that
forced this: its iD is accurate, the citations name it, and the account could not be shown as verified.

ADR 0096 excluded the ORCID iD from the admin edit on purpose ("proven by signing in, never typed in"), so an
owner had no route to finish a stuck link. The one direct database write made for account 19 was recorded by
hand in the audit log and was not a path anyone could repeat.

## Decision

**An owner may attest an ORCID iD on an account with `nemar admin users edit --orcid <iD>`, which sets
`users.orcid`, sets `orcid_verified = 1`, and writes no `oauth_identities` row.** The audit row carries
`orcid_attested: true`, so every attestation is findable.

The attestation is refused, and nothing is written, when:

- another live account holds the iD in `users.orcid` or in an `oauth_identities` row (ADR 0043);
- the account already holds an iD the person proved by signing in (`orcid_already_proven`). Replacing it is the
  person's act, through relink (ADR 0022), because an admin replacing it would discard the proof;
- the target is an owner account, or the owner is editing their own account (ADR 0096's owner rules);
- the same request edits a name that the verified iD would then own (`name_is_orcid_canonical`, ADR 0041).

The verdict on what counts as proof does not change. A person's sign-in record is still the only proof, and
the attestation is recorded as an attestation. When the person later links the same iD through ORCID, the
callback finds the account already on that iD and adds the sign-in record; nothing else changes.

## Consequences

- **Easier:** a stuck link can be finished by an owner who has confirmed the iD for that person, without the
  person having to retry the browser flow. Citations and the verified badge stop waiting on one round trip.
- **Harder:** `orcid_verified = 1` no longer implies a sign-in record. Every reader of the flag trusts an
  attestation as much as a proof: upload access (ADR 0045), the profile-gap matrix (ADR 0048), and names. A name
  on an attested account is not refreshed from ORCID until the person signs in with ORCID, and the admin edit
  refuses to change it in the meantime.
- **Obligation:** an owner attests only an iD they have confirmed belongs to that person. The system cannot
  check that. The help text and the audit note say what the flag means.
- **Provenance is in the audit log, not on the row.** Finding attested accounts is a query over
  `admin_user_edited` rows with `orcid_attested` set. A column on `users` would make that a filter, at the cost
  of a migration and every reader of the row; that is a follow-up if the attested set grows.
- **No bulk attestation.** One account per command, each audited. A sweep over every unverified iD would be a
  decision about many people at once and needs its own design.

## Alternatives considered

- **Keep the iD out of the admin edit (ADR 0096 as written).** It keeps the rule simple and makes every verified
  iD come from a sign-in. It also leaves a stuck link stuck until the person retries, which may never happen.
- **Write an `oauth_identities` row from the attestation.** Rejected: that row claims a sign-in that did not
  happen, and unlink and relink would then act on a proof that does not exist.
- **A separate `orcid_attested` column now.** Rejected for this change: it needs a migration and a change to
  every reader of the verified state, and the audit row already records the provenance. Revisit with the first
  query that needs it as a filter.
- **Bulk attestation for every unverified iD.** Rejected here (see above).

## Receipts

- Account 19 (`bruaristimunha`), 2026-10-15: iD `0000-0001-5258-2995` on the account from DOI enrichment,
  `orcid_verified` 0, no `oauth_identities` row, one link intent expired unconsumed. Attested by hand before this
  route existed; the audit row's `details` carries the reason.
- ADR 0022 (relink needs a post-minted intent), ADR 0041 (ORCID owns names once verified), ADR 0043 (one iD, one
  live account), ADR 0044 (the browser flow stays the only proof the person gives), ADR 0045 (`orcid_verified`
  gates upload access), ADR 0048 (account kinds), ADR 0096 (the admin edit this amends).
- `backend/src/routes/auth-orcid.ts` `linkIdentity` and `decideVerifiedFlag` (`backend/src/services/orcid-auth.ts`):
  the link after an attestation takes the same-iD branch and only adds the sign-in record.
