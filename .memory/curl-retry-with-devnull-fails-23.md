---
name: curl-retry-with-devnull-fails-23
description: curl --retry together with -o /dev/null exits 23 on the first retried transfer (curl 8.5), so a workflow step that retries a POST and keeps the status code must loop in bash instead
metadata:
  type: project
---

Found on nemarOrg/nemar-cli#1682 (2026-10-09) while giving the PR-review workflow's claim step a retry. `curl -sS -o /dev/null -w '%{http_code}' --retry 2 --retry-delay 1 -X POST ...` against a server answering 503 then 200 made one request, printed nothing, and exited 23 (curl 8.5.0). Retrying a transfer makes curl truncate the output file, and `/dev/null` cannot be truncated. The step's `|| code=000` then turned a real status into "unreachable".

**Why:** the failure is silent in the useful direction: the script still ran and still chose a branch, just the wrong one, and a run against a healthy server (no retry) behaves.

**How to apply:** in a workflow `run:` block, do not combine `--retry` with `-o /dev/null`. Loop in bash (`for attempt in 1 2 3; do code=$(curl ... -w '%{http_code}') || code=000; case "$code" in 2??|3??|4??) break ;; esac; sleep ...; done`), and run the step for real in a test against a `Bun.serve` stand-in that answers 503 then 200, which is how this was found. The same test file needs `Bun.spawn` and `await proc.exited`: `Bun.spawnSync` blocks the event loop the in-process stand-in server runs on, and the test hangs until its timeout.
