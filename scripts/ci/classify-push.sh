#!/usr/bin/env bash
# Classify a push for the workflows that act on it: is it the release bot's
# version-only commit, and did the push change any file a dev deploy reads?
#
# The release bot pushes three kinds of commit to `dev` and `main`, all authored
# as nemar-bot with the subject "chore: bump version to ...":
#   - auto-bump-dev.yml's -devN increment on top of every merge to dev;
#   - auto-tag.yml's -dev suffix strip on main (the commit that gets the tag);
#   - sync-dev.yml's next-patch-dev0 bump, pushed together with the merge of
#     main into dev.
# Their code is the code of the commit before them, which its own push already
# tested, so Tests skips them; and the dev deploy and publish that the bump owes
# are run by auto-bump-dev.yml itself, once, so the bump's own push must not
# start them a second time.
#
# The author and the subject are not trusted alone: the push also has to change
# nothing but the `version` field of package.json and backend/package.json.
# Anything else, or anything this script cannot establish (no previous commit,
# a fetch that fails), classifies the push as ordinary, which runs everything
# as before. Failing open is the point.
#
# Usage, from the root of a checkout of the pushed commit:
#   scripts/ci/classify-push.sh >> "$GITHUB_OUTPUT"
# Reads GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_SHA. Prints:
#   version_bump=true|false  the bot's version-only push (any number of commits)
#   auto_bump=true|false     ...and exactly one commit, on top of the previous
#                            head: the shape of auto-bump-dev.yml's own push
#                            (sync-dev.yml pushes a merge commit as well)
#   deploy_paths=true|false  the push changed backend/**, shared/** or
#                            .github/workflows/deploy-backend.yml, the paths a
#                            dev deploy was triggered by before auto-bump-dev.yml
#                            took it over
# The reasoning goes to stderr.

set -uo pipefail

BOT_EMAIL="nemar-bot@users.noreply.github.com"
BUMP_PREFIX="chore: bump version to "
NULL_SHA="0000000000000000000000000000000000000000"

version_bump=false
auto_bump=false
deploy_paths=true

emit() {
  echo "version_bump=$version_bump"
  echo "auto_bump=$auto_bump"
  echo "deploy_paths=$deploy_paths"
  exit 0
}
note() { echo "classify-push: $*" >&2; }

if [ "${GITHUB_EVENT_NAME:-}" != "push" ]; then
  note "event '${GITHUB_EVENT_NAME:-}' is not a push; ordinary"
  emit
fi

event="${GITHUB_EVENT_PATH:-}"
after="${GITHUB_SHA:-}"
before=$(jq -r '.before // empty' "$event" 2>/dev/null)
email=$(jq -r '.head_commit.author.email // empty' "$event" 2>/dev/null)
message=$(jq -r '.head_commit.message // empty' "$event" 2>/dev/null)

is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
if ! is_sha "$after" || ! is_sha "$before" || [ "$before" = "$NULL_SHA" ]; then
  note "no previous commit to compare with (before='$before'); ordinary"
  emit
fi

# The pushed commit with its parent, and the previous head. GitHub serves a
# commit by id, so this works on the default depth-1 checkout.
if ! git fetch --quiet --no-tags --depth=2 origin "$after" \
  || ! git fetch --quiet --no-tags --depth=1 origin "$before"; then
  note "could not fetch $before and $after; ordinary"
  emit
fi

if ! changed=$(git diff --name-only --no-renames "$before" "$after"); then
  note "could not diff $before..$after; ordinary"
  emit
fi

if ! grep -qE '^(backend/|shared/|\.github/workflows/deploy-backend\.yml$)' <<<"$changed"; then
  deploy_paths=false
fi

if [ "$email" != "$BOT_EMAIL" ] || [[ "$message" != "$BUMP_PREFIX"* ]]; then
  note "head commit is not the release bot's version bump; ordinary"
  emit
fi

# Nothing but package.json and backend/package.json, and in them nothing but
# `version`. jq -S compares content, not formatting.
while IFS= read -r path; do
  [ -z "$path" ] && continue
  case "$path" in
    package.json | backend/package.json) ;;
    *)
      note "the bump push also changed $path; ordinary"
      emit
      ;;
  esac
  old=$(git show "$before:$path" | jq -S 'del(.version)') || old=""
  new=$(git show "$after:$path" | jq -S 'del(.version)') || new=""
  if [ -z "$old" ] || [ "$old" != "$new" ]; then
    note "$path changed beyond its version field; ordinary"
    emit
  fi
done <<<"$changed"

version_bump=true
parents=$(git rev-list --parents -n 1 "$after" 2>/dev/null) || parents=""
if [ "$parents" = "$after $before" ]; then
  auto_bump=true
fi
note "version-only push by the release bot (single commit on the previous head: $auto_bump)"
emit
