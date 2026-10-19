# NEMAR Neurobagel node

This directory runs the stock Neurobagel node for epic #1586 (Phase 3, #1589).
The node is Neurobagel's own `recipes` stack in graph mode: GraphDB, the node API (n-API), the federation API (f-API) and the query tool.
It runs on the NEMAR application host as one Docker Compose project, `nemar-neurobagel`, under hard memory and CPU limits.
It is fed by a loader that pulls artifacts from a private store on a schedule, so nothing is ever pushed to the host.
The decision and its reasons are architecture decision record (ADR) 0082 (`.context/decisions/`).
The host itself (its other services, ports, paths and schedules) is documented in the gated operations documentation, not here.

Nothing in this directory is a copy of Neurobagel's code.
`bin/nb-install` checks `neurobagel/recipes` out at the tag pinned in `pins.env` and verifies the commit hash.
`docker-compose.nemar.yml` is an overlay merged after recipes' own compose file.

Terms used below.
JSON-LD (JSON for Linked Data) is the format Neurobagel loads: one document per dataset.
JVM is the Java virtual machine GraphDB runs in, and OOM means out of memory.
TTL is a time to live: how long a record is kept.
`nb` is the command in `bin/`.

## Contents

| Path | What it is |
| --- | --- |
| `pins.env` | Versions, tracked in git: recipes tag and commit, and every image by tag and digest |
| `.env.example` | The host-local settings template (placeholders only); `.env` is created from it, mode 600, never tracked |
| `docker-compose.nemar.yml` | The overlay: limits, loopback ports, health checks, log caps, the optional tunnel connector |
| `index.schema.json` | The format of the artifact index: the one source of truth for it |
| `bin/nb` | The one command; every subcommand is a script `bin/nb-<name>` |
| `bin/nb-common.sh`, `bin/nb-decide.sh` | Libraries: paths, lock, atomic writes, the compose wrapper; and the safety decisions as pure functions |
| `tools/build-index.sh` | Writes `index.json` for a directory of artifacts (reference implementation of the format) |
| `tools/gen-synthetic-jsonld.ts` | Synthetic JSON-LD for footprint measurements; never for a registered or exposed node |
| `config/local_nb_nodes.json` | The one node the local f-API queries: this node, over the internal network |

Runtime directories, all created by the scripts and all untracked: `recipes/` (the checkout), `secrets/`, `data/` (releases), `state/`, `backups/`, `logs/`.

## Commands

| Command | What it does |
| --- | --- |
| `bin/nb install` | First-time setup. Idempotent; starts nothing |
| `bin/nb up` | Starts the stack from nothing and waits until it is loaded and verified. Clears a guard abort marker |
| `bin/nb down` | Stops this project's containers. Volumes and data are kept; it takes no arguments, so it cannot remove volumes |
| `bin/nb status [--json] [--deep] [--quiet]` | One read-only look. Exit 0 healthy, 1 degraded, 2 down, 3 on hold. `--quiet` prints nothing when healthy |
| `bin/nb load` | Pulls changed artifacts and reloads the graph if (and only if) something changed. Cron runs this |
| `bin/nb reload` | A deliberate, measured, verified reload of the live release, with rollback |
| `bin/nb hold "reason"` / `bin/nb unhold` | Incident mode: take the node out of the federation now, and put it back |
| `bin/nb rollback [--list] [RELEASE]` | Go back to an earlier release, reload it, and freeze the loader |
| `bin/nb guard [--watch N] [--abort-on mem,load,neighbor] [--check]` | Resource guard: sample, log, and stop this project (only) on a breach; `--check` tests its heartbeat |
| `bin/nb backup [--graph-export]` / `bin/nb restore ARCHIVE` | Back up and restore the inputs and state; a restore is followed by `bin/nb up` |
| `bin/nb compose ARGS` | `docker compose` for this project only: a global flag that would name another project, directory, file or env file (`-p`, `--project-name`, `--project-directory`, `-f`, `--env-file`) is refused before the subcommand, while a subcommand's own flags such as `logs -f` pass. It is still a raw escape hatch for this project's own resources (`compose down -v` removes its volumes) |
| `bin/nb logs [SERVICE]` | Shows the last 200 lines of this project's container logs, then follows them |
| `bin/nb cron-line` | Prints crontab lines. Installs nothing |

## How it fits together

1. The loader reads `index.json` from the artifact store, compares it with the live release, downloads only what changed, and checks every file against the index (sha256 and size) and against caps on size and count.
2. It assembles a complete new release directory, validates it with the stock initialiser (a throwaway container with no network), and swaps one symlink, `data/current`, to it with one `rename(2)`.
   A failure at any point leaves `data/current` exactly as it was and leaves no residue.
3. A reload then runs under the lock.
   The API is stopped for the load window.
   The stock init container rebuilds the data volume.
   GraphDB is stopped cleanly and restarted, and the stock setup clears the graph and uploads every file plus the vocabulary.
   The API is started again (it reads its dataset metadata once, at start), and the result is verified.
4. Verification asks the node for every dataset with the empty query and requires exactly the datasets of the release, every one marked `records_protected`, and a subject query that returns `protected` instead of participant rows.
5. If any step fails, the API is stopped again, `data/current` is pointed back at the last release that was loaded and verified, and that release is loaded instead.
   Content that failed is remembered and not retried for six hours.

Participant-level records are never exposed.
`NB_RETURN_AGG=true` is fixed in the overlay, not left to `.env`, and every reload and `nb status --deep` fails if the node returns anything else.
`NB_MIN_CELL_SIZE` is set explicitly to 0 (the stock value) in `.env.example`.
That is acceptable only because every federated dataset is public (epic #1586), and it must be raised before any non-public data is ever federated.

## Install

Run these as the account that owns the deployment.
Nothing here touches another compose project.

1. Copy this directory to `$HOME/neurobagel` on the host (from a checkout of `nemarOrg/nemar-cli`), leaving out the untracked runtime directories:

   ```bash
   rsync -a --exclude='/.env' --exclude='/secrets/' --exclude='/recipes/' --exclude='/data/' \
     --exclude='/state/' --exclude='/backups/' --exclude='/logs/' \
     deploy/neurobagel/ <host>:neurobagel/
   ```

2. Install.
   It needs `docker` with Compose 2.24 or later, `git`, `jq`, `curl`, `perl` and `openssl`.

   ```bash
   cd "$HOME/neurobagel"
   bin/nb install      # recipes at the pinned tag, .env, GraphDB credentials, first release from Neurobagel's example
   bin/nb up           # pulls the pinned images (about 5 GB), builds the init image, starts, waits, verifies
   bin/nb status --deep
   ```

   `bin/nb-install` generates the two GraphDB passwords with `openssl rand -hex 16` into `secrets/` (a mode 700 directory with mode 600 files) and creates `.env` from `.env.example` (mode 600).
   They are readable by the deployment account only, are never printed or copied by any script, are not in git, and are inside every backup archive.
   They are generated on the host the first time and exist nowhere else.
3. Review `.env`.
   The defaults are the measured ones.
   `COMPOSE_PROFILES=portal` runs the local f-API and query tool (192 MiB of limits); remove `portal` to free it.
4. Point the loader at the store: set `NB_SOURCE` (and `NB_SOURCE_AUTH_HEADER_FILE` if the store needs a header) in `.env`, then run `bin/nb load --dry-run` to see the plan.
5. Scheduling is a decision for a person.
   `bin/nb cron-line` prints the entries (a load every 20 minutes, the guard watcher at boot, a heartbeat check, a status alarm, a post-reboot adopt and a nightly backup) to paste into `crontab -e`.
   **No cron entry is installed by this change, and nothing starts the guard watcher by itself.**
   Until a person installs the lines, loads run only when someone runs `bin/nb load`, and the only guard is a watcher someone started by hand with the command under "The guard" below.

To reach the local tools from a laptop, forward local ports 13000, 18080 and 18000 to the same ports on the host's loopback with an ssh tunnel, then open the query tool at `http://localhost:13000`, the f-API documentation at `http://localhost:18080/docs` and the n-API documentation at `http://localhost:18000/docs`.

## Artifact store interface (what Phase 4 must provide)

The loader reads one JSON document, `index.json`, and then the files it lists, all relative to one base URL (or directory).
`NB_SOURCE=https://store.example/neurobagel` means `https://store.example/neurobagel/index.json` and `https://store.example/neurobagel/<name>` for each artifact.
`index.schema.json` is the format's single definition.
The loader's check, `tools/build-index.sh` and the synthetic generator all take their constants from it, and a test (`test/neurobagel-node-deploy.unit.test.ts`) fails if any of them drifts, or if the example below stops being valid.

```json
{
  "schema": "nemar-neurobagel-artifact-index/1",
  "generated_at": "2026-10-02T03:00:00Z",
  "datasets": [
    {
      "id": "nm000132",
      "fingerprint": "sha256:acd7b00c07840016c67ae625fc3de2a01e1f247694db1e2b28dabe24af7b9f95",
      "artifacts": [
        {
          "name": "nm000132.jsonld",
          "kind": "jsonld",
          "sha256": "9008cd4477758e7da24339fe4dd43ee380025a600527d7b5540e5369d59824e2",
          "bytes": 41928
        },
        {
          "name": "nm000132_annotated.json",
          "kind": "dictionary",
          "sha256": "447f64adedea5463732607800fe4dfd0ad94296ea36ee04af0e0ace0166a886a",
          "bytes": 1305
        },
        {
          "name": "nm000132_dataset_description.json",
          "kind": "description",
          "sha256": "465ce163d97fb10dbd61dfd8d12592fed07a931346f42c000cd88d62729dba9f",
          "bytes": 811
        }
      ]
    }
  ]
}
```

That is a real dataset from the Phase 1 goldens, with the hashes and sizes of its three real files.
The fingerprint is the sha256 of the three file hashes joined in the order shown.

The index is refused, with exit code 3 and nothing changed, if any of these rules is broken.

- `schema` is exactly `nemar-neurobagel-artifact-index/1`.
  `generated_at` is required: a UTC timestamp, `YYYY-MM-DDThh:mm:ssZ` (fractional seconds allowed).
  It is recorded and never used to decide anything.
- Unknown fields, at any level, are ignored.
  A producer may add what it likes.
- `datasets` holds at most 5,000 entries.
  `datasets[].id` is unique and matches `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$` without `..`.
- Each dataset has one `jsonld` artifact named `<id>.jsonld`, and optionally a `dictionary` named `<id>_annotated.json` and a `description` named `<id>_dataset_description.json`.
  Graph mode loads only the JSON-LD; the other two are kept in the release for catalog mode and for audit.
- Artifact names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and contain no `..`.
  They are unique across the index, and there is no `url` field and no sub-directory.
- `sha256` (64 lowercase hex digits) is required and verified for every file.
  `bytes`, if present, is a whole number of at least 1 and must equal the size.
- `fingerprint` is `sha256:` followed by 64 hex digits.
  Its reference form is the sha256 of the dataset's artifact hashes concatenated in the order `jsonld`, `dictionary`, `description`, and it must change whenever any artifact of the dataset changes.
  The loader decides what changed by comparing artifact hashes, so a fingerprint that stays the same while content changes is applied and reported as a warning.
- Every `jsonld` file must be a Neurobagel dataset: an `@context`, an `identifier` starting `nb:`, `schemaKey` `Dataset`, a non-empty `hasLabel`, and at least one entry in `hasSamples`.
  No two files may share an identifier, because the stock initialiser silently keeps only one.
  The stock validator must accept every file; a file it rejects fails the whole load rather than being skipped.
- Caps, so that nothing the source sends can make the host work without bound, all overridable in `.env` (`.env.example` holds the same numbers and reasons).
  The index is at most 8 MiB, one artifact at most 6 MiB (`NB_MAX_ARTIFACT_BYTES`), all artifacts together at most 192 MiB (`NB_MAX_TOTAL_BYTES`), and at least 2,048 MiB of disk must be free where releases live.
  They are set from measurements.
  The index for 800 datasets is a few hundred KB.
  The largest real dataset document is 0.44 MB, so 6 MiB is 14 times over it; and the stock validator holds a document in memory at 12 to 14 times its size (an 8.06 MB document needed 104 MiB and a 10.9 MB one 160 MiB), so 6 MiB needs about 90 MiB of its 160 MiB limit.
  The largest release the 2 GiB graph container was measured to load is 172 MB of JSON-LD (3.56 million statements, 1.57 GiB peak), and the planned scale is about 70 MB, so 192 MiB is the measured maximum plus a margin.
  Raise the per-artifact cap and the validator limit (`NB_INIT_MEM_LIMIT`) together, and the total only after loading something larger.
- Time: a whole loader run, retries included, ends by 900 seconds after it began (`NB_LOAD_BUDGET_S`), and one request by 300 seconds (`NB_FETCH_TIMEOUT_S`) or what is left of the budget, whichever is less.
  A store that is slow or stuck ends the run with exit 3 and changes nothing.
- Authentication: if the store needs it, put one complete header line (for example `Authorization: Bearer ...`) in a mode 600 file and set `NB_SOURCE_AUTH_HEADER_FILE`.
  The loader hands it to curl with `-H @file`, so the token never appears in a process listing, a log or a state file, and it warns if the file is readable by other accounts.
- The source must be an https URL (plain http only with `NB_ALLOW_HTTP=1`, for tests).
  A URL with credentials in it is refused, and the query string of a URL is never recorded.
  A redirect is refused outright, for the index and for every artifact: curl would send a credential header other than `Authorization` on to the redirect target, and every URL here is one the loader names itself, so it must answer directly (HTTP 200).
  A local directory is also accepted as a source, for tests and trials.
- The loader only reads: it sends `GET index.json` and `GET <name>`, with the user agent `nemar-neurobagel-loader/1.0`.

**Producer ordering.**
The loader may read at any moment, so the store must never show an index that names something absent.

- To add or change a dataset: write its artifacts first, then replace `index.json` (atomically, if the store allows).
- To remove a dataset: replace `index.json` first, then delete its artifacts.
- An artifact that the index names but the store cannot serve is a source failure: the load stops (exit 3), the live release is untouched, and nothing is treated as removed.
  Removal is only ever by omission from the index.
- Removal is how a dataset that becomes private, withdrawn or deleted leaves the federation, so the producer must drop it from the index at once.
  An index with zero datasets is refused, and so is one that drops more than half of at least ten datasets, unless the operator passes `--allow-mass-removal`.

**The NEMAR store (phase 4, ADR 0084).**
The producer is the NEMAR API.
Set `NB_SOURCE` to `<api origin>/neurobagel`, so the loader reads `<api origin>/neurobagel/index.json` and `<api origin>/neurobagel/<name>`, and put one header line, `Authorization: Bearer <token>`, in the mode 600 file `NB_SOURCE_AUTH_HEADER_FILE` names.
The token is the API's `NEUROBAGEL_READ_TOKEN` secret, held by the owner; it is a deployment secret, not an account credential, and the owner rotates it by changing the secret and this file together.
The route answers 401 without the right token, and 404 for any name that is not an artifact name of an eligible dataset.
It re-checks eligibility on every request and serves `index.json` without any dataset that is no longer eligible, so a dataset that goes private is absent from the very next read, before the producer has tidied the store.
Every answer is `no-store` and is served directly (HTTP 200), never as a redirect.
The producer replaces a dataset's entry in `index.json` right after that dataset's artifacts, not once at the end of a run, so a run cut off part way never leaves an artifact the index describes differently (the sha256 check would stop the whole load); the one window left is that single dataset's own three writes, healed by the next run.
A dataset whose manifest cannot be found keeps the artifacts it already has (a missing manifest must not unfederate a healthy dataset), and the NEMAR status lists it as a standing refusal with its age; so a rollback of a published dataset must confirm `deleted: true` in the answer of the delete, or withdraw the dataset first, because a delete that answers 207 keeps the row and the dataset stays in the index.
The index carries one field this document does not list, `input_fingerprint` per dataset, which the loader ignores; `fingerprint` is the reference form defined above.

**Removal latency.**
From the moment the index stops naming a dataset until the node stops answering with it is the loader's poll interval plus one reload.
With the printed cron entry (every 20 minutes) and a node of about 50,000 subjects that is at most about 25 minutes: 20 minutes of waiting, about 30 seconds of fetching and validation, and 3 to 4 minutes of reload.
`bin/nb hold` takes the whole node out in under a second if that is too slow.

## Loading, reloading, holding

`bin/nb load` is safe to run from cron.
When the index matches the live release it makes one small request and exits.
When something changed it fetches only the changed files (unchanged ones are hard-linked from the live release), validates, publishes a release, and reloads.

While the graph reloads, the node's API is stopped, so the federation sees an error from this node instead of silent partial results from a half-loaded graph.
Any change, one dataset or all of them, costs one full reload, because the stock design clears and reloads the whole graph.
The measured numbers are below; read them before choosing a schedule.
After a reboot the stock graph clears and reloads itself while its health check can already report healthy, so run `bin/nb reload --adopt` then (the printed cron entry does, 90 seconds after boot): it holds the API down until the load is done and then verifies it.

**What the federation sees after a reboot.**
The stock stack starts the API as soon as the graph reports healthy, which can be before the graph has finished loading.
From then until the adopt run starts, the node can answer from a graph that is empty or half loaded: an empty or partial answer, not an error.
That window is at most the 90 seconds of the printed `@reboot` delay, less the time the containers take to come up.
When the adopt runs it stops the API, and from then the federation sees an error from this node until the graph has finished loading and been verified: 41 seconds measured with 21 datasets, and about 175 seconds at 50,105 subjects (the graph and API phases of the reload table).
The 90 seconds was chosen to let the Docker daemon start its containers; it has not been rehearsed with a real reboot, because rebooting the deployment host was out of scope, so treat it as an upper bound to tune, and lower it if the partial-answer window matters.
The guard does not misread the reboot either: see "The guard".

A hold wins over everything.
If `bin/nb hold` is set at any point of a reload, the API is killed again and stays down, and the reload exits 7.
`bin/nb hold` itself confirms the API container is not running before it returns.
`bin/nb unhold` ends the hold it read when it started, and only that one.
If `bin/nb hold` runs again while the node is coming back (an unhold with a staged release reloads it first), the newer hold wins: the reload stops the API again, or `unhold` does when the reload had finished, the newer flag stays, and the command exits 7.

| State file | Meaning |
| --- | --- |
| `state/pending-reload` | A release is staged and not yet loaded (a reload was disabled, held, or interrupted); the next `nb load` or `nb reload` loads it |
| `state/hold` | Incident mode; no reload runs and the node API stays stopped |
| `state/freeze` | Set by `nb rollback`; the loader fetches nothing until `nb load --thaw`. A problem in `nb status` until ended |
| `state/reload-failed` | Content that failed to reload, kept so it is not retried for `NB_KNOWN_BAD_TTL_S` (six hours); `--force` overrides |
| `state/degraded` | A reload and its rollback both failed; `nb status` says so |
| `state/applied.json` | The release that is loaded and verified, and when |
| `state/previous-loaded` | The release that was loaded and verified before the applied one, for `nb rollback` |
| `state/rollback-to` | The release that was live when the newest one was published; the second choice for a rollback, after the loaded release in `applied.json` |
| `state/reload-history.jsonl` | One JSON line per reload, adopt or rollback: the seconds each phase took, how long the API was unavailable, and the lowest host memory seen |
| `state/last-load.json`, `state/last-load-ok` | How the last loader run ended, and when a run last ended well (a run that found nothing to do counts) |
| `state/guard.log`, `state/guard-heartbeat`, `state/guard-abort.json` | Tab-separated guard samples; when the guard last sampled; and why it last stopped the project |
| `state/guard-baseline.tsv` | The start time and restart count of every other container, and the boot id of the host it was taken in |
| `state/lock`, `state/lock.info` | The `flock(2)` lock, and who holds it (informative) |

A reload refuses to start unless the host has `NB_MIN_AVAILABLE_MB` available (1800).
It aborts, stopping only the graph container and skipping the rollback, if available memory falls below `NB_ABORT_AVAILABLE_MB` (1536) while it runs.
Rollback targets the last release that was loaded and verified (`applied.json`), not the last one published, because the previously published release may never have loaded.
Release directories are pruned past `NB_KEEP_RELEASES` (4), but never the live one, the loaded one, the previously loaded one, or the rollback one.

## Resource limits and monitoring

Every container has `mem_limit` equal to `memswap_limit` (no swap), a CPU limit and a low `cpu_shares`, a pids limit, `oom_score_adj` of 500 (the kernel's first choice if the whole host runs out of memory), `no-new-privileges`, and a 30 MiB log cap.
The defaults sum to 2880 MiB with the tunnel connector.
The stock initialiser (in a reload) and the loader's validator (before it) are one helper of 160 MiB that runs for seconds, under one lock, never both at once, so the peak is 3040 MiB with the tunnel connector and 2912 MiB without it, under the epic's 3 GiB (3072 MiB).

| Container | Memory limit | CPUs | Why this much (measured) |
| --- | --- | --- | --- |
| `graph` | 2048 MiB (heap 1.5 GiB) | 2.0 | Peak 1.9 GiB at 50,105 subjects |
| `api` | 512 MiB | 1.0 | 384 MiB was too small: the unrestricted subject query got the process killed; peak 355 MiB |
| `federation` | 128 MiB | 0.5 | Peak 63 MiB |
| `query_federation` | 64 MiB | 0.5 | Peak 12 MiB |
| `cloudflared` (profile `tunnel`, not started) | 128 MiB | 0.5 | A tunnel connector is small; 17 to 27 MiB is typical |
| `init_data`, and the loader's validator (run for seconds, one at a time) | 160 MiB | 1.0 | Peak 30 MiB at 800 datasets of under 1 MB each; one large document needs 12 to 14 times its size (8.06 MB: 104 MiB; 10.9 MB: 160 MiB), which is what the 6 MiB artifact cap is sized against |

The stock graph setup script polls GraphDB in a loop with no sleep while the server starts; the CPU limit contains that.

**Alarms.**
`bin/nb status` exits non-zero, and lists what is wrong, for each of the following.

- A container not running or not healthy, or killed for running out of memory.
- A failed reload, or a failed load (the newest content is not being served).
- A frozen loader.
- No successful loader run for two hours (only when `NB_SOURCE` is set).
- A guard heartbeat older than 20 minutes, or none at all while a guard is expected: `NB_GUARD_EXPECTED` is 1 unless `.env` says 0, so a node whose guard never started is a problem, and a node deliberately run without one has to say so.
- A guard abort marker.
- A node on hold whose API still answers.

Warnings (a staged release waiting, a graph restart since the last reload, host memory below the reload minimum) do not change the exit code.
`bin/nb status --quiet` prints nothing when healthy, so a cron job running it mails only when something is wrong: put `MAILTO` at the top of the crontab, and wire it to a real notifier before relying on it.

**The guard.**
`bin/nb guard` takes one sample: host memory available, load average, this project's container usage, and the start time, restart count and health of every other container on the host (state only, never their data or environment).
The breaches are host available memory below 1536 MiB, a load average above 6 for six samples, and another container restarting or turning unhealthy since the baseline.
`--abort-on mem,load,neighbor` makes a breach stop THIS project and nothing else; the default is `mem`.
The stop happens first, and the marker saying why is written afterwards, best effort.
After a change you made on purpose to another container, run `bin/nb guard --baseline`, or the `neighbor` rule reads the restart as a breach.
A reboot is not such a change and needs no action.
The baseline carries the boot id of the host it was taken in (`/proc/sys/kernel/random/boot_id`), and the guard takes it again when the boot id differs, or while the host has been up for less than `NB_GUARD_BOOT_SETTLE_S` (180 seconds) because its containers are still coming up.
Without that, every other container would have a new start time after a reboot, and the `@reboot` guard (with `neighbor` in `--abort-on`) would stop the node about 30 seconds after boot, before the adopt run.
A baseline from before boot ids existed is stamped with the current one, once.
The memory and load rules keep running during the settle time.
`bin/nb up` clears the abort marker (and logs it), because starting the node is the operator's answer to it.

The guard runs as a watcher, started at boot and supervised by its heartbeat:

```bash
cd "$HOME/neurobagel" && setsid nohup bin/nb guard --watch 10 --abort-on mem,load,neighbor --quiet \
  >> logs/guard-watch.out 2>&1 < /dev/null &
```

It writes `state/guard-heartbeat` every sample and survives a failed probe (an earlier version died silently on a vanished one-off container).
`bin/nb guard --check` exits 21 and says so when the heartbeat is missing or older than `NB_GUARD_STALE_S`, and `bin/nb status` raises a problem for the same (a missing heartbeat only while a guard is expected, as above).
`bin/nb cron-line` prints the `@reboot` start line and the `guard --check` entry that would make the watcher supervised; until they are installed, the watcher is hand-started, and a reboot ends it.
To restart the watcher, stop it and run the line above.

`bin/nb status` is the read-only check.
`--deep` adds the full verification query and should not run every minute.

## Measured footprint

Measured on the deployment host on 2026-10-01 and 2026-10-02, with the stock images pinned in `pins.env`.
Memory is `docker stats` sampled every 5 seconds.
No other container on the host restarted or became unhealthy during any measurement, and the guard's thresholds were never reached.
The reload timings below were measured while the API stayed up.
Since then the API is stopped for the load window, which is the graph and API phases: about 175 seconds at 50,105 subjects, and 48 seconds measured for the 21 real datasets.

### Idle

| State | Graph | API | f-API | Query tool | CPU (each) |
| --- | --- | --- | --- | --- | --- |
| Neurobagel's example, 1 dataset, 5 subjects | 819 MiB | 80 MiB | 50 MiB | 10 MiB | under 0.5% |
| 800 synthetic datasets, 50,105 subjects, 879,201 statements, 150 s after a reload | 1.35 GiB | 104 MiB | 62 MiB | 8 MiB | under 0.5% |

The graph's memory is the JVM heap's high-water mark; it falls back only when the container restarts, which a reload does.

### Reload, by scale

| Release | Statements | Init | Graph | API | Verify | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Neurobagel example plus 5 synthetic datasets, about 30 subjects | not counted | 2 s | 38 s | 9 s | 1 s | 50 s |
| 100 synthetic datasets, 7,190 subjects | 126,131 | 1 s | 54 s | 9 s | 6 s | 70 s |
| 18 real datasets (the Phase 1 goldens), 1,011 subjects, from a small graph | 14,811 | 2 s | 45 s | 10 s | 1 s | 58 s |
| 18 real datasets, from the 800-dataset graph (clearing it dominates) | 14,811 | 1 s | 71 s | 9 s | 2 s | 83 s |
| 21 real datasets (the merged epic's goldens), loaded by the shipped loader, API stopped for the load (unavailable 48 s) | not counted | 2 s | 44 s | 4 s | 2 s | 52 s |
| 800 synthetic datasets, 50,105 subjects, shape of a NEMAR record, shipped limits | 879,201 | 3 s | 166 s | 9 s | 55 s | 233 s |
| the same with one dataset changed (staging and validation add 31 s) | 879,201 | 3 s | 168 s | 9 s | 26 s | 206 s |
| 800 synthetic datasets, four times the density, 172 MB of JSON-LD | 3,564,819 | 10 s | 244 s | 10 s | 39 s | 303 s |
| First start of the stack, cold, with Neurobagel's example (5 subjects), including GraphDB's first-time setup | not counted | | 45 s | | | 46 s |

Stopping GraphDB cleanly matters: the stock container ignores SIGTERM, and a plain restart waited out its timeout (60 s) and then killed GraphDB.
`nb-reload` asks the JVM to shut down instead, which removed that wait and the crash recovery on the next start.

### Peak memory during those loads

| Scale | Graph | API | f-API | Query tool |
| --- | --- | --- | --- | --- |
| 100 datasets, 1 GiB heap | 899 MiB | 94 MiB | 53 MiB | 12 MiB |
| 800 datasets, 50,105 subjects, 1 GiB heap | 1,027 MiB | 172 MiB | 54 MiB | 11 MiB |
| 800 datasets, 50,105 subjects, shipped limits (1.5 GiB heap) | 1,917 MiB | 355 MiB | 44 MiB | 10 MiB |
| 800 datasets, four times the density, 1.5 GiB heap | 1,566 MiB | 196 MiB | 63 MiB | 12 MiB |
| 18 real datasets (clearing the previous 3.6 million statements) | 1,562 MiB | 141 MiB | 57 MiB | 9 MiB |
| 800 datasets, 2 GiB heap (experiment) | 1,903 MiB | 207 MiB | 63 MiB | 9 MiB |

### Queries at 50,105 subjects, 800 datasets

| Query | Time | Result |
| --- | --- | --- |
| `POST /datasets {}` (the heaviest dataset-level query) | 1.9 to 2.2 s, 14 runs | 800 datasets |
| the same with sex, age range, diagnosis or modality filters | 1.7 to 2.1 s | agrees with ground truth |
| the same at four times the density | 6.7 to 7.4 s | 800 datasets |
| 8 simultaneous `POST /datasets {}` | 6.9 to 13.1 s to finish, one after another | all 200 |
| `POST /subjects {}` (every subject) | 15 to 21 s, or HTTP 500 when GraphDB has under 250 MB of free heap | refused or `protected` |

Queries run one at a time (see the licence section).
Real data was checked against ground truth.
The 18 Phase 1 golden JSON-LD files were loaded by the stock initialiser and GraphDB without any file skipped.
Six queries (female, ages 30 to 50, healthy control, electroencephalography (EEG), a combined filter, and the empty query) returned exactly the dataset and subject counts computed independently from the files, through the node API and through the local f-API (`nodes_response_status` was `success` each time).
The merged epic's 21 goldens were then loaded and verified by the shipped loader.
Each dataset's first link, `https://nemar.org/dataset/<id>`, came back as `homepage`, and `access_email` was null.

### Disk

The pinned images are 5.1 GB (n-API 1.87 GB, f-API 1.69 GB, GraphDB 1.42 GB, init 0.23 GB, query tool 0.10 GB).
The GraphDB repository was 74 MiB at 7,190 subjects and 132 MiB at 50,105.
It keeps its high-water mark, so after the four-times-density test it stayed between 477 and 768 MiB, and a node that has once held a dense graph should be planned at up to 768 MiB.
A release is 35 MB of JSON-LD for 800 datasets at 50,105 subjects (172 MB at four times the density), and `NB_KEEP_RELEASES` (4) are kept for rollback.
Backups (`backups/`, 14 kept) are on the same disk as the node.
That protects against a bad release or an operator error, not against losing the disk: set `NB_BACKUP_HOOK` in `.env` to copy each archive off the host.

### Estimate at the planned scale

The assumptions are about 800 datasets and 30,000 to 100,000 subjects (the epic says tens of thousands), in the shape the transform produces.
The real Phase 1 goldens come to 14.6 statements per subject, and the synthetic NEMAR-shaped set to 17.5, so the estimate uses 15 to 18.

| Subjects | Statements | JSON-LD | Graph resident | Reload | Fits the shipped limits |
| --- | --- | --- | --- | --- | --- |
| 30,000 | 0.45 to 0.54 million | about 21 MB | 1.0 to 1.5 GiB | about 3 minutes | yes |
| 50,000 | 0.75 to 0.9 million | about 35 MB | 1.3 to 1.9 GiB | 3.5 to 4 minutes | yes |
| 100,000 | 1.5 to 1.8 million | about 70 MB | 1.6 to 2.0 GiB | about 5 minutes | at the limit; raise the graph limit |

Reload time is roughly 25 s of GraphDB start, a cost proportional to the number of files (about 0.14 s each) and to the size of the graph being cleared, plus 10 to 60 s of API restart and verification.
It was measured linear from 5 to 800 datasets and from 126 thousand to 3.6 million statements.
The memory estimate extrapolates a measured range and is not itself measured above 3.6 million statements.

### GraphDB Free licence

GraphDB runs here as the Free edition: its startup log says `Product: GRAPHDB_LITE`, `Licensee: Freeware`, `Expiry date: none`, `Max CPU cores: 1`.
From Ontotext's documentation (10.8 and 11.x licensing pages, read 2026-10-01):

- Statements are unlimited ("Manage unlimited number of RDF statements", where RDF is the Resource Description Framework), so the planned 1 to 2 million statements is far inside the limit.
- Concurrency is limited, and the documentation disagrees with itself: the prose says a limit of two concurrent queries, and the 10.8 feature table says one.
  What was measured agrees with the table: eight simultaneous queries finished one after another.
- There is no cluster or high availability, and support is by the community only.

Is that a problem at this scale?
Not for storage or for one user at a time.
Each dataset-level query takes about 2 seconds and queries are served one by one, so sustained throughput is about one query a second.
The Neurobagel federation API waits for every node and puts no timeout on dataset queries, so a queue at this node slows a user's federated query for all nodes.
That risk argues for a Cloudflare rate-limit rule on the hostname (below), not for a different edition.
GraphDB also refuses any group-by or distinct query while less than 250 MB of heap is free; the heap sizing above is what keeps that from affecting dataset-level queries.

## Upgrade

Versions change only by editing `pins.env` in a pull request.

1. Edit `pins.env` (recipes tag and commit, image tags and digests; the commit is the one the tag resolves to).
2. Copy the directory to the host.
3. `bin/nb install` moves the recipes checkout to the new tag and refuses to continue if the commit does not match the pin.
4. `bin/nb down`, `bin/nb compose pull`, `bin/nb up`, then `bin/nb status --deep`.
   The node is out for the length of a first start (about 45 seconds with a small graph, minutes with the full one).
5. Repeat the measurements that matter (reload time, peak memory) before the change is called done.
   GraphDB's repository format can change across minor versions, so read its release notes first.

Recipes' own changelog applies: the n-API, the f-API and the query tool are released together, and on 2026-09-14 a query endpoint was removed across n-API 0.11.0 and f-API 0.10.0 on the same day.

## Backup and restore

The graph is derived, so the backup is its inputs: `.env`, `secrets/`, the live and rollback releases, the manifests, `state/`, and `pins.env`.
`bin/nb backup` writes `backups/nb-<UTC>.tar.gz` (mode 600, in a mode 700 directory) with a checksum list, and keeps the newest 14.
`--graph-export` adds `nb-graph-<UTC>.nq.gz`, the whole graph as N-Quads, read through GraphDB's own export with no downtime, for forensics or to restore without the artifact store.
**The archive contains the GraphDB passwords.** Copy it off the host only to a place held to the same standard as any credential store.
The archive is on the same disk as the node, and `NB_BACKUP_HOOK` copies it elsewhere (a failing hook makes the backup exit 9 and is logged; the local archive is kept).

To restore on this host or a rebuilt one:

```bash
bin/nb install              # on a new host: recipes, directories (it will not overwrite anything that exists)
bin/nb down                 # restore refuses while this project's containers exist
bin/nb restore backups/nb-<stamp>.tar.gz     # verifies every checksum first; keeps an existing .env and secrets/
bin/nb up                   # loads the restored release into the graph and verifies it
```

The restore refuses an archive whose checksums do not match, and one whose release names are anything but release names (a value such as `../..` would otherwise reach a delete).
`--overwrite-config` replaces `.env` and the secrets.
Do not use it on a host whose graph volume already exists: GraphDB's passwords are fixed in the volume on first start, and replacing them locks the node out of its own graph.
If that happens, the only fix is a hard reset: `bin/nb down`, `docker volume rm nemar-neurobagel_graphdb_home` (this project's volume, named explicitly), `bin/nb up`.

## Rollback

- Automatic: a reload that fails verification restores the last release that was loaded and verified, and loads it.
  The exit code is 5 and `bin/nb status` reports the newest content as not served.
- Deliberate: `bin/nb rollback --list` shows the releases still on disk, and `bin/nb rollback [RELEASE]` makes one live (by default the release loaded before the live one), reloads it, and freezes the loader so the next scheduled run does not undo the rollback.
  `bin/nb load --thaw` ends the freeze.
- Of the stack itself: restore the previous `pins.env` and run the upgrade steps in reverse.
  The previous images stay in Docker's cache until pruned (do not run `docker system prune` on a shared host).

## Cloudflare Tunnel (for the lead)

**Status:** live, as recorded on 2026-10-16.
The node has been public at its hostname with the tunnel enabled, and it serves the production store.
It is not registered with Neurobagel's federation.
The 14-day soak counts from 2026-10-16; see `.context/epic_neurobagel_federation.md`.

The node's public path is the `tunnel` profile, and the hostname is `neurobagel.nemar.org`.
The profile adds a `cloudflared` connector on a network of its own that holds only the API, so it exposes exactly one thing, the node API, as `http://api:8000`; GraphDB is on a different network and is never one route away.
The connector token and the hostname are the lead's decision.
Where the token is stored and how the host supplies it are host specifics, kept in the gated operations documentation.

1. In the Cloudflare Zero Trust dashboard, Networks, Tunnels, create a tunnel of type Cloudflared named `nemar-neurobagel` and copy its connector token.
2. Add a public hostname to the tunnel, `neurobagel.nemar.org`, with service type HTTP and URL `api:8000`.
   No path, no Access policy (Neurobagel's federation API must reach it unauthenticated), and leave `NB_NAPI_BASE_PATH` empty.
3. On the host, make `NB_TUNNEL_TOKEN` available and set `COMPOSE_PROFILES=portal,tunnel`.
   The token does not have to live in `.env`: `bin/nb compose` passes `.env` as an env file, and a variable already in the shell environment wins over it, so a host can supply the token from its own environment, for example from a wrapper that exports it for the one command in step 4, and leave `NB_TUNNEL_TOKEN` empty in `.env`.
   `bin/nb up` refuses to start the profile while the token is in neither place.
4. Start the connector without touching the running node: `bin/nb compose --profile tunnel up -d --no-deps cloudflared`.
5. Check: `curl -s https://<hostname>/` returns the node API welcome page, `curl -s -X POST -H 'Content-Type: application/json' -d '{}' https://<hostname>/datasets` returns the datasets, each marked protected and without an access email, and `bin/nb status` shows `cloudflared` healthy.
6. Recommended edge rules: a Cloudflare rate-limiting rule on the hostname, and a rule that blocks `POST /subjects` from outside if nobody needs it.
   Confirm in the dashboard which of these rules are in place; the lead records the answer in the gated operations documentation.

Registration in Neurobagel's federation (the `neurobagel/menu` pull request) is Phase 7, and happens only after the gate in the epic.
Do not register this node before then.

To take the tunnel back down: `bin/nb compose --profile tunnel stop cloudflared`, and remove `tunnel` from `COMPOSE_PROFILES`.

## Incident: take the node out of the federation now

```bash
cd "$HOME/neurobagel" && bin/nb hold "what happened"
```

That writes `state/hold`, kills the node API container (immediately: it holds no state), confirms it is down, and keeps the loader and every reload from bringing it back.
The federation API of Neurobagel marks a node whose API does not answer as failed and returns no records from it.
Check that `curl -s -o /dev/null -w '%{http_code}' https://<hostname>/` no longer returns 200, and that `bin/nb status` says `HOLD`.

If the script is not to hand, do the same two things by hand and in this order.
First write the flag, so that no scheduled run revives the node, then kill the container:

```bash
mkdir -p "$HOME/neurobagel/state" && echo "$(date -u +%FT%TZ) by hand: <reason>" > "$HOME/neurobagel/state/hold"
docker kill nemar-neurobagel-api-1
```

If you cannot write the flag, remove the `nb load` and `nb reload --adopt` entries from the crontab first (if they were ever installed).
Put the node back with `bin/nb unhold`: it reloads a staged release first, starting the API only once the graph holds it, and otherwise starts the API and verifies it.

If the cause is a dataset that must not be federated, remove it from the artifact store's index first, so the next load drops it, then run `bin/nb load`.
The hold only buys time.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `nb status` says degraded, `the last reload failed` | `state/reload-history.jsonl` has the reason. The previous release is serving. Fix the content in the store; the loader retries in six hours, or run `bin/nb load --force` |
| Reload fails with `the graph reported upload errors` | GraphDB rejected a JSON-LD file (the stock script prints the error and still exits 0). The release was rolled back. Find the file in `logs/last-init.log` and `docker logs nemar-neurobagel-graph-1` |
| Verification says `served datasets differ from the release (missing: ...)` | GraphDB loaded a document with no usable statements, for example a broken `@context`. The identifier is in the message |
| n-API answers 500 for a subject query | GraphDB had under 250 MB of free heap. Dataset queries are unaffected. Retry; raise the heap only after reading the footprint section |
| n-API restarts by itself | The API container hit its 512 MiB limit (an unrestricted subject query at 50k subjects). It comes back in seconds |
| `nb up` refuses: `service graph is already running` | The stock init container rewrites the shared data volume on every `up`, which on a running node could put the API and the graph out of step. Use `nb reload` |
| The n-API cannot start | It fetches its vocabularies from GitHub raw at start. Check outbound access to `raw.githubusercontent.com` |
| `nb load` exits 75 | Another loader or reload holds `state/lock`. `state/lock.info` says who. The kernel drops the lock when its holder dies, so there is nothing to clean up |
| `nb status`: `the node is on hold but its API still answers` | A reload started the API after the hold was set. Run `bin/nb hold` again; it confirms the container is down |
| `nb status`: `the resource guard has never started (no heartbeat)` | No guard watcher has run since the state was created. Start it with the line under "The guard" (or `NB_GUARD_EXPECTED=0` in `.env` for a node that is deliberately run without one) |
| `nb status`: `the guard stopped the project` | The guard saw a breach and ran `compose down`. Fix the cause, then `bin/nb up` (which clears the marker) |
| Host available memory falls | `bin/nb guard` logs it and stops this project below 1.5 GiB. `bin/nb up` starts it again once memory recovers |

## Rehearsals on the deployment host (2026-10-02)

Each of these was run for real on the trial stack, with real Phase 1 datasets or the 800-dataset set loaded.
Nothing here stopped or restarted the stack: the reload rehearsals restart the graph and API processes, as every reload does.
The first group was run on the final code, in two rounds; the second group was run earlier in the trial, on a previous version of the scripts whose behaviour in those cases has not changed.

| Rehearsal | Result |
| --- | --- |
| `nb hold` 8 seconds into a reload (the API already stopped for the load window) | `nb hold` returned in 0.69 s. The reload finished its graph load, saw the hold, left the API down and exited 7; no known-bad record was written, because a hold is not the content's fault. `nb status` exited 3 and said `HOLD`. `nb unhold` brought the node back verified (21 of 21 datasets) and `nb status` was healthy again |
| A newer `nb hold` set while `nb unhold` was reloading a staged release (18 datasets) | The reload finished its graph load, saw a hold whose text was not the one being ended, left the API down and exited 7. `nb unhold` exited 7 and the newer flag stood untouched, with no stray files. `nb status` exited 3. A second `nb unhold` loaded the staged release (51 s, API unavailable 48 s) and the node came back healthy |
| A release that GraphDB rejects (a dataset with an invalid JSON-LD `@context`; the stock validator and the loader's own checks accept it), validated by the real container | The stock upload script printed the error and exited 0. The reload read it from the log and rolled back to the last release that was loaded and verified in 51 s (API unavailable 49 s), exited 5, and `nb status` said the newest content was not being served. A second `nb load` refused to retry the content, and a load from a good source cleared the problem |
| `nb rollback` | The earlier release was live again in 51 s (API unavailable 49 s) and the loader was frozen: `nb status` listed the freeze as a problem and a following `nb load` fetched nothing. `nb load --thaw` and a load went forward again |
| A real backup restored into a fresh directory, with Docker hidden from the script so the running stack is not stopped | The release came back byte for byte (63 files). A copy of that archive with `../..` as its rollback release was refused (exit 8) and the file standing at the root of the target directory was still there |
| `nb status` for a state directory with no guard heartbeat | `the resource guard has never started (no heartbeat)` is a problem, and is not with `NB_GUARD_EXPECTED=0` |
| The validator container, started from `nb_validator_args` | Inside it: `oom_score_adj` 500, a memory limit of 160 MiB, and no network (a connection attempt fails at once) |
| `nb compose -p other ps` and `nb down -v` on the host | Both refused with exit 2 before anything ran |
| The guard watcher restarted with the documented line | The first sample stamped the baseline, taken before boot ids existed, with this boot's id and kept its entries. A reboot of the host was not rehearsed: the choice between recording and judging is tested over real captured container state and with a different boot id |
| Disaster recovery: backup, `nb down`, discard `data/` and `state/`, `nb restore`, `nb up` (an earlier round) | The restore kept the existing `.env` and secrets, and the node was up and verified in 43 s (API unavailable 41 s), 21 of 21 datasets served |
| `nb up` after a guard abort (a marker planted by hand, node down; an earlier round) | `nb status` exited 2 and named the marker; `nb up` cleared it, logged that it did, and loaded and verified in 43 s |
| The guard watcher found dead (an earlier round) | The watcher had stopped when the stack was redeployed. `nb status` exited 1 with `the resource guard last sampled 37 minutes ago` and `nb guard --check` exited 21. The documented start line restarted it and both went quiet |
| An `@context` of `{}` (earlier) | GraphDB loaded it as no statements at all, and verification named the missing dataset (799 of 800); rolled back |
| A change arriving while on hold (earlier) | Staged, validated and published, not loaded, API left stopped |
| `nb unhold` with a staged release (earlier) | Loaded first, the API started only after the graph held the new release: 52 s, deep check passed |
| Mass removal, 800 datasets to 18 (earlier) | Refused until `--allow-mass-removal` |
| `nb up` on a running node (earlier) | Refused with exit 8 |
| A reload whose API was OOM-killed by the 384 MiB limit, and a heap that refused the heaviest query (earlier) | Found, and the limits and the verification query were changed (see the footprint section) |
| Load of the 21 merged goldens through the shipped loader, API stopped for the load | 52 s in all, API unavailable 48 s, both verified |

Bugs these rehearsals found and fixed: a manifest written empty after a `jq` argument-length failure on 800 datasets, a guard that died silently on a vanished one-off container, an unhold that could not restart a stopped API, a lock leaked by `exec`, a release name that collided when the same content was published twice in one second, a Docker restart that waited out a 60 s kill timeout, two backups in the same second overwriting each other, a header-file permission check that never fired (the `-perm` flag of `find` differs between GNU and BSD), a reload interrupted by a hold that kept `nb status` degraded after the node was put back, a hold set during an unhold's reload that the unhold erased, a guard baseline that read every other container as restarted after a reboot, a release-name check that accepted a valid name next to a path (`grep` matches by line), a restore that created directories before it had verified the archive, and redirects that curl would have followed with a credential header.

## Tests

`test/neurobagel-node-deploy.unit.test.ts` runs the real scripts against real directories and a real HTTP server, and parses real captured output of the stock containers and of a real node API (`test/fixtures/neurobagel-node/`, provenance in `PROVENANCE.md`).
Continuous integration (CI) runs it in the `unit-pure` job when anything under `deploy/neurobagel` changes.
It covers:

- the loader: first load, no-change run, one changed dataset, removal, sha256 mismatch, missing and truncated artifacts, a hostile name planted outside the source, mass removal at its boundaries, dry run, authentication, https-only sources, credentials and redirects, and every cap at its boundary
- the index format: the schema, the loader and both producers agree (a table of malformed indexes refused by both, the cross-field rules only the loader enforces, unknown fields ignored, the README example valid)
- each rule of the index format on its own: a table with one mutation per rule, each refused and named by its own sentence (so the dataset and artifact caps cannot hide behind other rules), the caps at their boundaries, the default byte caps, a stated size that differs from the file's, and the loader's time budget
- redirects refused for the index and for an artifact, a loader that stages but never reloads while on hold, and the sweep that spares a temp file a lock-free writer may be writing
- atomic publication seen by a concurrent reader, the symlink swap seen by a tight reader, the empty-write guard, the flock lock (two loaders, a dead holder's file, a live holder), freeze, known-bad content and its expiry
- seed, backup, restore (byte for byte, an altered archive, a forged release name, configuration kept), retention, the off-host hook
- the decisions as pure functions over real text: rollback target, memory abort, hold (including the hold an unhold must not erase), guard breaches (against real captured container state before and after a real restart, and across a reboot with a different boot id), the arguments `nb compose` refuses, the validator container's flags, status verdicts, the loader's problems (from the real loader's own records), and whether the node serves what it should (against a real node's answers for the real goldens, including a real answer from a node that returns participant rows)
- the log parsers against the stock containers' real first-start, upload-failure and initialiser output
- `docker compose config` of the overlay merged over the recipes file it pins: hard limits and no swap, OOM score and CPU shares, the 3 GiB ceiling, loopback ports, a tunnel network that holds only the API, `NB_RETURN_AGG` fixed, the init base image pinned, profiles, restart policies and health checks
- shellcheck over every script, and a scan that the public tree carries no host details

Under `CI` a missing tool (jq, curl, perl, bash, shellcheck, `docker compose`) fails the file instead of skipping it.
What the tests do not reach is Docker itself.
The reload, status, guard and hold commands drive containers, so they were exercised on the deployment host; the measurements and the rehearsals above are recorded here and in the pull request.
