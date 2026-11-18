# Probe findings: workstations A and B

Read-only probe of the two lab workstations, card DM-01 of the portable compute plan, run 2026-11-13 as the owner's own login.
Nothing was written, started or installed on either host, and nothing under the Zarr converter's directories was read.
Host identities, paths and raw output stay in the operator's scratch and are not committed.

Both scratch fields are owner-named (the owner named the scratch disk of each host).

| Field | Workstation A | Workstation B |
| --- | --- | --- |
| Operating system | Ubuntu 24.04 | Ubuntu 22.04 |
| Cores | 32 | 32 |
| Memory (GiB, rounded) | 62 | 125 |
| Scratch (owner-named): free GiB, filesystem | 244, xfs | about 2,760 (2.7 TiB), ext4 |
| Conversion cron | yes | no |
| Scratch on the converter's filesystem | pending owner | not applicable |
| Runtimes with versions | docker 28.1.1 (apptainer, singularity, podman: no) | docker 29.8.0 (apptainer, singularity, podman: no) |
| Rootless | no | no |
| `docker` group | yes | yes |
| User namespaces | yes | yes |
| cgroup v2 | yes | yes |
| Delegated `cpu` controller | yes | no |
| Delegated `memory` controller | yes | yes |
| SLURM | no | no |
| GPU (count, memory class) | 1, 24 GiB | 1, 24 GiB |
| Python | 3.12.3 | 3.10.12 |
| uv | yes | no |
| Bun | no | no |
| tmux | no | yes |
| Egress to the Zarr site | yes (200) | yes (200) |
| Egress to GHCR | yes (401, reachable) | yes (401, reachable) |
| Egress to the NEMAR API health route | yes (200) | yes (200) |
| TCP forwarding | unknown | unknown |
| Verdict | runtime: docker | runtime: docker |

## Notes

- Workstation A runs the production conversion cron (found by reading the crontab only).
  Whether its scratch disk shares the converter's filesystem is pending: the owner runs the two mount-information commands, and the demo rule below does not need the answer because workstation B qualifies first.
- Both Docker daemons are rootful and the login is in the `docker` group, which is root-equivalent on that host; no rootless runtime is available on either.
  DM-14 should treat this when it chooses how to run containers.
- Workstation B does not delegate the `cpu` cgroup controller to the user slice, so CPU limits cannot be enforced per user there without a rootful daemon.
- Workstation B's system disk is nearly full; only its separate scratch disk has room.
- TCP forwarding is unknown on both: reading the server configuration needs privilege, so it was not run.
- Rule applied: the host without the conversion cron is preferred when its runtime is not `none` and its Python is at least 3.9.
  Workstation B has `docker` and Python 3.10.12, so it is the demo workstation.

demo workstation: B
