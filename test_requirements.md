# Remaining real-test requirements for #1642

The copy, resume, and save tests use the real Git and git-annex executables, real
temporary repositories, and git-annex's real `directory` special remote. The Git
wrapper only adds per-command environment variables or records arguments; it never
changes command output or status.

These narrow failure branches had only been exercised by invented command results.
Those tests were removed rather than kept as false confidence:

- Copy-error formatting for successful JSON records paired with a failing exit, and
  for output that is not JSON records, needs a real git-annex invocation that produces
  each output shape. Current captures cover successful copy, partial output, a
  mid-transfer failure, a missing remote, and a many-file failure.
- An unreadable annex location log at a specific post-copy or later hint walk needs a
  real repository/log state that makes that git-annex read fail after setup succeeds.
  The damaged-index case fails closed through real git-annex, but may fail during copy
  rather than the final verification walk; it does not establish every later-walk branch.
- `git annex find` termination and the exact signal/exit text need a real process
  failure. A corrupt-index test covers `git ls-files`; it does not simulate a killed
  git-annex child or a failing `git grep`.
- A failure on a later `git rm --cached` chunk, or a re-add failure after blocked
  tracking recovery, needs a real index or annex write failure at that exact point.
  A persistent real `.git/index.lock` covers the first unstage failure.
- The signal handler's hung-Git timeout, stopping an in-flight Git child, and a signal
  arriving during the final unmark need a real long-running Git operation with a
  controllable lock. Current signal coverage uses a real pre-commit hook and real
  index-lock files, including one that clears during the retry window.
- The save's one-failed-unmark-then-success retry branch needs a real transient lock
  that clears between the two synchronous attempts; the persistent-lock failure and
  next-save recovery are covered with real Git state.
- The sandbox save/push tests exercise `saveAndPush` with a real repository and bare
  origin, but do not drive `sandboxCommand` through dataset creation, finalization, and
  cleanup. That entrypoint calls the real backend and mutates the shared
  `nemarDatasets` GitHub org and S3-backed fixture; there is no safe local real-service
  environment for this path. Do not add a stub API. Close this gap only with an
  isolated staging fixture and an owner-approved run, and verify that a failed
  save/push never finalizes the sandbox.

Do not restore command shims that substitute stdout, stderr, exit codes, or process
signals to close these gaps. Add coverage when a deterministic real Git/git-annex or
OS-level fixture can produce the required condition without changing the command's
result.

# Temporary PR-review test exception for epic #1671

Owner authorized continuing the dev-sync PR on 2026-10-09 while this test gap stays
documented. `backend/test/pr-review-flow.test.ts` drives a real local D1 schema and
real WebCrypto, but uses synthetic dataset rows, deterministic D1 interleavings for
claim-race coverage, and a `Bun.serve()` GitHub API stand-in;
`test/pr-review-evidence.test.ts` uses real temporary Git repositories and
the real Anthropic SDK against a `Bun.serve()` API stand-in. These suites are retained
as a temporary exception so the PR-review flow remains exercised in CI. They do not
prove behavior against GitHub or Anthropic, and the local stand-ins remain outside the
repository's normal NO MOCKS policy.

The flow fixture marks its rows published with a fixed `first_published_at` so it
reaches the same eligibility predicate used by production. Replace this exception
with isolated, owner-approved GitHub and Anthropic test endpoints before treating
the PR-review flow as real-service acceptance. Until then, report stand-in suite
results separately from real-service verification.

# Remaining real-test requirements for #1455

The inactivity warning is covered at the subprocess boundary with real Bun child
processes: the test verifies the 120-second production constant, output on either
stream resets the interval, later quiet intervals warn again, the child exits normally,
and a warning-callback exception is reported without changing the child's result. The
existing focused annex-add suite continues to exercise list-form `gitAnnexAdd` against
real git-annex repositories.

`test/upload-data-steps.unit.test.ts` drives `uploadDataToS3` with a local real-git-annex
repository and a real `directory` special remote. The checked-in BIDS dataset and the
test's generated upload inputs are synthetic, so this test cannot establish real-dataset
warning persistence. Separately, an owner-authorized
offline NFS benchmark used a checksum-verified non-synthetic sample of 1,021 files
(2,268,523,934 bytes) on one host. It covered a 12-cell raw-add matrix (argv and batch
at J1/J4/J8) and a six-cell production-chunk-shaped batch matrix. Those results support
the selected bounded upload-local worker setting, but the benchmark did not drive the
upload entry point and does not establish real-upload warning persistence.

Real upload/save acceptance remains open for the full 4,711-file/~550-GB corpus, files
larger than 1 GiB, authenticated S3 transfer, and the later NFS-backed `git add -A`
final save. The offline sample benchmark and local directory-remote test do not close
these gaps. Keep #1455 open until that acceptance is completed. Close the warning
persistence test gap only when an owner-approved isolated upload environment is
available: drive the real upload entry point and verify the warning is persisted while
its spinner continues. Do not substitute an invented dataset, mocked subprocess, or
mocked S3 service.

# Remaining real-test requirements for #1644

There is no automated regression test for renewed credentials during recorded-file checks or
pending copies against real S3. In particular, retry transfer reporting must retain unique
positive `git-annex copy --json` send records when the location log has not caught up yet. The
available local directory remote does not reproduce that lag/retry condition, so a counting-helper
test or ordinary repeated local copy would not cover it. The former
`test/upload-sts-refresh.integration.test.ts` used a loopback S3 stand-in and injected
`ExpiredToken`; it was removed because `.rules/testing.md`
excludes stub services. That test exercised API-issued leases through real git-annex, but it could
not establish AWS SigV4 acceptance or real credential expiry. `test/upload-recorded-check.unit.test.ts`
covers recorded-file presence behavior, but not expiry during copy or `fsck`, stale partial-result
replacement, retry progress, or the one-path handling for unknown-size recorded checks.

Under ADR 0094, recorded paths missing from the current upload plan have unknown sizes and are
checked one at a time. That conservative batching path has no dedicated regression assertion. The
resumed-copy size-map case also remains untested: a pending location-log path can be absent from
the current `addTargets` list, so its current size must come from the complete data-file
inventory. The available generated upload files and EDF stand-ins do not satisfy the strict
NO FAKE DATA rule for this regression, and an empty upload-progress state with a hand-picked
`filesToUpload` list would not represent the production resume path. Add coverage only when a
non-synthetic sample and realistic interrupted-run state are available.

S3 `HeadObject` failures are generic, so the implementation uses the known lease timestamp when a
failed check returns after expiry rather than expecting a specific AWS error code.

The owner selected “Keep gap documented” for the `sandboxCommand` end-to-end run and live-S3
expiry acceptance. Close this gap only with an isolated, owner-approved staging fixture and
verified S3-side expiry behavior; do not run the live path from this phase or treat a generic
`e2e-sandbox` CI pass as equivalent evidence. Add real coverage only when the test can exercise
the affected path without synthetic lease state or a stub service.

# Remaining real-test requirements for #1565

The shared key parser and completeness rules establish that a chunk set is recoverable,
but do not prove that the Worker can deliver its bytes. Existing route tests use the S3
manifest stand-in and do not drive a real chunk-only object through the manifest URL and
data-plane file route. No non-synthetic chunked sample in an isolated non-production S3
environment was identified during phase setup. Do not use live S3 or `nm000276` for this
acceptance.

Close this gap with an owner-approved real chunked sample and isolated non-production S3
environment. Fetch the URL emitted by `manifest.json` through the production route and
verify the full-body checksum, a range within one chunk, a range crossing a chunk boundary,
a range in the final short chunk, an unsatisfiable range, and missing or short chunk
behavior. Exercise the real route and manifest entry point; a stand-in service, generated
payload, pure helper test, or CI sandbox result is not this acceptance. Until that
environment exists, report local and CI checks separately and keep real chunk-byte
acceptance open. This real sample must also confirm a manifest-listed file with no backing
plain object or complete chunk set fails as a storage error, not as a manifest-path 404
that a downstream gather could treat as an optional table.
