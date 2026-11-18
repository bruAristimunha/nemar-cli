# ADR 0122: One OCI image runs under Apptainer or Docker from one digest

**Status:** proposed
**Date:** 2026-11-13
**Owner:** Seyed Yahya Shirazi

Epic #2145.
This Architecture Decision Record (ADR) records how a compute job's container is built, signed and run, so that the same job runs on a lab workstation and on a cluster.
It refines [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) decision 14 (the launch specification names a digest-named Singularity image file) and goes with [ADR 0121](0121-a-job-names-its-executor-and-its-accounting-class-and-a-workstation-runner-pulls-its-work.md).
It supersedes nothing.

## Context

ADR 0118 runs a job from a Singularity Image Format (SIF) file named by its digest, and the launcher's continuous integration (CI) already exercises Apptainer.
Some lab machines run Docker, not Apptainer, and have no scheduler; host detail is in the gated systems inventory (`admin/operations/systems-inventory`).
Shared clusters generally run Apptainer and not Docker.
NEMAR needs one artifact that both can run, whose identity a result can name, without a second build that could drift from the first.
SIF builds are not byte-reproducible, so a SIF built separately on each host could never be verified against a signature.

## Decision

1. **One Open Container Initiative (OCI) image is built once, in CI, and pinned by its digest.**
   The digest is the identity a job records as `image_digest`; a tag is never an identity.
2. **The image is signed only from `main` or an `image-nemar-python-v*` tag.**
   The signing workflow's `SIGNING_IDENTITY` is the certificate identity a verifier accepts, so a branch build cannot produce a signature that verifies.
3. **The SIF is derived from the image once, in CI, and published by digest and signed.**
   The same workflow converts the image to a SIF, pushes it to the GitHub Container Registry as an OCI artifact tagged `sha256-<hex of the image digest>`, and signs it under the same identity.
   A machine that lacks `<hex>.sif` pulls that artifact and never builds one.
   As ADR 0118 decision 14 says, the file's name is what ties it to the digest; neither the launcher nor this ADR claims the file's content was verified until a runner checks the signature.
4. **Apptainer is primary where it is installed, and Docker is the supported second engine.**
   Apptainer needs no daemon and no root, and the launcher's CI already runs it.
   Some lab machines have only Docker until Apptainer is installed, which is an owner decision, so the first runs use Docker.
   Under Docker the engine pulls `image.uri` by digest and verifies it on pull, so `NEMAR_SIF_ROOT` is not required there; this changes decision 14's "required, the launcher has no fallback" for Docker only.
5. **Docker runs under pinned isolation flags and a limits rule.**
   The flags (dropped capabilities, no new privileges, a read-only root, the invoking user's ids, exactly the four binds) are in the launcher docs.
   Docker gets `--cpus` and `--memory` on every run.
   Apptainer gets them only when the runner's `doctor` has proved cgroup delegation (`NEMAR_ENFORCE_LIMITS=1`); otherwise the runner's own watchdog enforces wall time and resident memory and reports that mode.
6. **Docker is rootful only on a single-tenant lab machine recorded in the gated systems inventory, and Podman is unsupported.**
   Membership of the `docker` group is root-equivalent on its host, whoever the user is.
   Podman is unsupported until it is verified on a real host: its site-wide `containers.conf` volumes and devices and its `mounts.conf` entries reach every container, and the launcher can neither disable nor detect them.
   The launcher refuses it.
   On a shared host, where only rootless engines are allowed, Apptainer is therefore the only engine today.
7. **An operator-built image is unsigned and must say so.**
   Its source commit and image id are written into a label, a result that used it is labeled "operator-built, unsigned", and it is never presented as built in CI.
   Verifying a signature before first use is a runner feature added later; until then a runner runs the digest the Worker names, unverified.

## Consequences

- A result can name one digest that either runtime ran, so a workstation run and a cluster run are comparable by construction.
- Apptainer is the target runtime, not the first one: the first runs are on Docker, with its root-equivalence and without a cgroup guarantee for Apptainer until delegation is proved.
- A rootful daemon's group is the only guard on its host, so a new machine needs an owner decision and an inventory record, not a configuration change.
- Signing only from `main` or a tag means a pre-merge image cannot verify; a demo before a merge uses the labeled operator-built path.
- Two engines double the test matrix; the Docker backend is cut only if the probe verdict of PR #2147 is not `docker`, and the Apptainer path stays.
- Lifting the Podman refusal is a later step: inspect a container's mounts and devices against the declared binds on a real rootless Podman host.
  A Docker-only demo machine is unaffected.

## Alternatives considered

- **One image per runtime:** two builds can drift, and a digest would no longer identify a result.
- **A SIF built on each host:** not reproducible, so never verifiable.
- **Docker only:** shared clusters generally do not run it, which defeats portability.
- **Apptainer only:** some lab machines do not have it.
- **Signing from any branch:** a signature would no longer mean "reviewed and merged".
- **Rootful Docker on any host:** a root-equivalent group has no place on a shared machine.
- **An unlabeled local build:** a result would claim provenance it does not have.

## Receipts

- [ADR 0118](0118-the-compute-gateway-records-every-tenant-job-and-keeps-the-ledger-in-expanse-service-units.md) decisions 11 and 14, the two digests and the digest-named image file.
- The probe findings of 2026-11-13 (PR #2147) and the gated systems inventory.
