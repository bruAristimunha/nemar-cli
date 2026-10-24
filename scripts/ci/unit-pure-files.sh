#!/usr/bin/env bash
# Print the test files of the pure unit tier, one per line, from the root of a checkout.
#
# THE ONE CLASSIFIER. test.yml's `unit-pure-shard` and deploy-backend.yml's `test-gate` both
# run exactly this list, so the PR gate and the deploy gate cannot drift apart. A file is
# pure when it is an offline, non-e2e test that does not reach the live backend (no
# testRequest, TEST_API_URL or runCli( in it): new tests route themselves, no renames.
#
# Exits 1 with a message on stderr when nothing matches.

set -euo pipefail
shopt -s nullglob

files=()
for f in test/*.test.ts backend/test/*.test.ts backend/test/helpers/*.test.ts; do
  base="$(basename "$f")"
  case "$base" in
    e2e-sandbox.test.ts|e2e-upload.test.ts|zenodo-sandbox.test.ts|ezid.test.ts|ezid-sandbox.test.ts|auth-passwordless.test.ts) continue;;
    # *.integration.test.ts hit external networks (e.g. live DataCite/Crossref) and are
    # non-deterministic; they must NOT gate the pure (required, offline) tier or, via
    # test-gate, the prod deploy.
    *.integration.test.ts) continue;;
  esac
  if grep -Eq 'testRequest|TEST_API_URL|runCli\(' "$f"; then continue; fi
  files+=("$f")
done

if [ ${#files[@]} -eq 0 ]; then
  echo "No pure test files matched" >&2
  exit 1
fi
printf '%s\n' "${files[@]}"
