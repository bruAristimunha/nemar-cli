#!/usr/bin/env bash
# Compare two @bids/validator releases on reference datasets, with the gate that the central
# validation workflow (run-bids-validation.yml) applies: an error counts only when its location is
# not a git-annex pointer.
#
# Usage: compare-gating.sh --old <version> --new <version> --out <dir>
#          [--ids "<dataset ids>"] [--local <dir>]... [--canary] [--allow-partial]
#
# Each dataset is validated with the flags the central workflow passes (--json --ignoreWarnings),
# once per release, from a scratch directory so that Deno never reads a configuration file from a
# dataset. A release's result counts only when the validator exits 0 (valid) or 16 (errors found)
# and its report is a JSON object with a list of issues. Anything else is a failed validation.
#
# Writes into <dir>:
#   summary.md          the section the bump pull request body carries
#   results.tsv         one row per dataset: status, gating error counts, changed, note
#   diff-<id>.txt       the gating errors that differ, for each changed dataset
#   run/                the raw reports, stderr and annex lists, kept as evidence
#
# A dataset that cannot be cloned or validated is listed as not compared, and named with its reason
# on stderr. It is never reported as unchanged. The script then exits 1, so an incomplete comparison
# fails the job that runs it; --allow-partial accepts a partial comparison for a manual run.
set -uo pipefail

# Every default id must clone without credentials, because the monthly bump job has none. xx099904
# is not listed: its repository cannot be cloned anonymously. nm000189, the public dataset it was
# built from, stands in for it and keeps the HED-annotated EEG coverage.
REFERENCE_IDS="xx099900 xx099901 xx099902 xx099903 nm000189 xx099905 xx099906 nm000103 nm000104 nm000105 nm000106 nm000107"
VALIDATOR_ERRORS_FOUND=16
MAX_DIFF_LINES=40

OLD=""
NEW=""
OUT=""
IDS="$REFERENCE_IDS"
LOCALS=()
CANARY=0
ALLOW_PARTIAL=0

need_value() {
  if [ "$#" -lt 2 ]; then
    echo "compare-gating.sh: $1 needs a value" >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --old) need_value "$@"; OLD="$2"; shift 2 ;;
    --new) need_value "$@"; NEW="$2"; shift 2 ;;
    --out) need_value "$@"; OUT="$2"; shift 2 ;;
    --ids) need_value "$@"; IDS="$2"; shift 2 ;;
    --local) need_value "$@"; LOCALS+=("$2"); shift 2 ;;
    --canary) CANARY=1; shift ;;
    --allow-partial) ALLOW_PARTIAL=1; shift ;;
    *) echo "compare-gating.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$OLD" ] || [ -z "$NEW" ] || [ -z "$OUT" ]; then
  echo "usage: compare-gating.sh --old <version> --new <version> --out <dir> [--ids \"...\"] [--local <dir>]... [--canary] [--allow-partial]" >&2
  exit 2
fi
for tool in deno jq git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "compare-gating.sh: $tool is required" >&2
    exit 1
  fi
done

if ! mkdir -p "$OUT" 2>/dev/null || ! OUT=$(cd "$OUT" && pwd); then
  echo "compare-gating.sh: cannot use the output directory $OUT" >&2
  exit 1
fi
RUN="$OUT/run"
DATA="$OUT/data"
if ! mkdir -p "$RUN" "$DATA" || ! printf 'dataset\tstatus\tgating_old\tgating_new\tchanged\tnote\n' > "$OUT/results.tsv"; then
  echo "compare-gating.sh: cannot write into $OUT" >&2
  exit 1
fi

# Diff files left by an earlier run in the same directory would describe a comparison that no
# longer holds, so they are removed before this run writes its own.
rm -f "$OUT"/diff-*.txt

ESC=$(printf '\033')

# One line that says why a validation or clone failed, chosen the way validatorFailureReason in
# src/lib/bids-validator.ts chooses it. Colour codes, carriage returns and tabs go first, so the
# prefixes match; blank and download progress lines are dropped; then the first "error:" line wins,
# or else the last line that is not a stack frame ("at ..."). Cut to 200 characters.
failure_note() {
  local lines text
  lines=$(sed "s/${ESC}\[[0-9;]*[A-Za-z]//g" "$1" 2>/dev/null | tr -d '\r' | tr '\t' ' ' | sed -e 's/^ *//' -e 's/ *$//' | grep -v -E '^(Download|$)')
  text=$(printf '%s\n' "$lines" | grep -m 1 '^error:')
  if [ -z "$text" ]; then
    text=$(printf '%s\n' "$lines" | grep -v '^at ' | tail -n 1)
  fi
  text=$(printf '%s' "$text" | cut -c1-200)
  printf '%s' "${text:-no message on stderr}"
}

# Three layouts, each with a sidecar beside the data file. The kind says what the data file is:
#   annex-link  a link to a git-annex key, which is what git-annex writes for content that is not
#               fetched, and the layout real datasets have. The validator reads it as present.
#   bare-link   a link to no annex key. A release may report it as broken and its sidecar as
#               orphaned, so this is the detector for that change, not a layout that exists.
#   pointer     a small file holding an annex pointer, which the central gate filters.
make_canary() {
  local d="$1" kind="$2"
  rm -rf "$d"
  mkdir -p "$d/sub-01/emg" || return 1
  printf '%s\n' '{"Name":"canary","BIDSVersion":"1.10.0","DatasetType":"raw"}' > "$d/dataset_description.json"
  printf 'participant_id\nsub-01\n' > "$d/participants.tsv"
  printf '%s\n' '{"SamplingFrequency":1000,"EMGChannelCount":1,"RecordingDuration":1,"EMGReference":"Other","PowerLineFrequency":50,"SoftwareFilters":"n/a"}' > "$d/sub-01/emg/sub-01_task-x_emg.json"
  printf 'name\ttype\tunits\tsampling_frequency\nEMG1\tEMG\tuV\t1000\n' > "$d/sub-01/emg/sub-01_task-x_channels.tsv"
  local key="SHA256E-s1024--0000000000000000000000000000000000000000000000000000000000000000.bdf"
  case "$kind" in
    annex-link) ln -s "../../.git/annex/objects/00/00/$key/$key" "$d/sub-01/emg/sub-01_task-x_emg.bdf" ;;
    bare-link) ln -s ../../.git/annex/objects/missing.bdf "$d/sub-01/emg/sub-01_task-x_emg.bdf" ;;
    pointer) printf '%s\n' "/annex/objects/$key" > "$d/sub-01/emg/sub-01_task-x_emg.bdf" ;;
    *) return 1 ;;
  esac
}

# Each target is "id|absolute path".
TARGETS=()
for id in $IDS; do
  dir="$DATA/$id"
  if [ ! -d "$dir/.git" ]; then
    rm -rf "$dir"
    # A connection below 1 KB/s for two minutes is abandoned, so a stalled clone fails its own row
    # rather than holding the job until the job's timeout.
    if ! GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=120 git clone --depth 1 --quiet "https://github.com/nemarDatasets/$id.git" "$dir" 2>"$RUN/$id.clone.err"; then
      rm -rf "$dir"
      printf '%s\tnot_compared\t-\t-\t-\tclone failed: %s\n' "$id" "$(failure_note "$RUN/$id.clone.err")" >> "$OUT/results.tsv"
      continue
    fi
  fi
  TARGETS+=("$id|$dir")
done
for loc in ${LOCALS[@]+"${LOCALS[@]}"}; do
  if ! dir=$(cd "$loc" 2>/dev/null && pwd); then
    echo "compare-gating.sh: no such directory: $loc" >&2
    exit 1
  fi
  TARGETS+=("$(basename "$dir")|$dir")
done
if [ "$CANARY" = 1 ]; then
  for spec in canary-annex-link:annex-link canary-annex-pointer:pointer detector-bare-link:bare-link; do
    name="${spec%%:*}"
    kind="${spec#*:}"
    dir="$DATA/$name"
    make_canary "$dir" "$kind" || { echo "compare-gating.sh: cannot create $dir" >&2; exit 1; }
    TARGETS+=("$name|$dir")
  done
fi

# A release's report is usable only when it is a JSON object whose issues are a list.
report_ok() {
  jq -e '(.issues.issues | type) == "array"' "$1" >/dev/null 2>&1
}

# Gating errors: the error codes at locations that are not git-annex pointers, as sorted lines.
gate() {
  jq -r --slurpfile annex "$ANNEX" '
    .issues.issues[]
    | select(.severity == "error")
    | select(.location as $loc | ($annex[0] | index($loc)) | not)
    | "\(.code)\t\(.subCode // "-")\t\(.location // "-")"' "$RUN/$ID.$1.json" | sort > "$2"
}

for target in ${TARGETS[@]+"${TARGETS[@]}"}; do
  ID="${target%%|*}"
  dir="${target#*|}"
  ANNEX="$RUN/$ID.annex.json"

  # The annex-pointer list, built the way run-bids-validation.yml builds it: every symlink, and
  # every small file that holds a git-annex pointer.
  ( cd "$dir" && {
      find . -type l -not -path './.git/*' | sed 's|^\.||'
      find . -type f -not -path './.git/*' -size -1024c -exec grep -l '^/annex/objects/' {} + 2>/dev/null | sed 's|^\./|/|'
    } | sort -u ) > "$RUN/$ID.annex.txt"

  status="compared"
  note="-"
  if ! jq -R -s 'split("\n") | map(select(length > 0))' "$RUN/$ID.annex.txt" > "$ANNEX" 2>/dev/null; then
    status="not_compared"
    note="could not list the annex pointers"
  fi
  for ver in "$OLD" "$NEW"; do
    [ "$status" = "compared" ] || break
    # Run from the scratch directory, never from inside a dataset. NO_COLOR asks Deno for plain
    # output, but Deno lets FORCE_COLOR override it, so failure_note strips colour codes itself.
    ( cd "$RUN" && NO_COLOR=1 deno run --node-modules-dir=none -A "jsr:@bids/validator@$ver" "$dir" --json --ignoreWarnings > "$RUN/$ID.$ver.json" 2> "$RUN/$ID.$ver.err" )
    rc=$?
    echo "$rc" > "$RUN/$ID.$ver.rc"
    if [ "$rc" != 0 ] && [ "$rc" != "$VALIDATOR_ERRORS_FOUND" ]; then
      status="not_compared"
      note="validator $ver exited $rc: $(failure_note "$RUN/$ID.$ver.err")"
    elif ! report_ok "$RUN/$ID.$ver.json"; then
      status="not_compared"
      note="the $ver report is not a JSON object with a list of issues"
    fi
  done

  g_old="-"
  g_new="-"
  changed="-"
  if [ "$status" = "compared" ]; then
    if gate "$OLD" "$RUN/$ID.$OLD.gating" && gate "$NEW" "$RUN/$ID.$NEW.gating"; then
      g_old=$(wc -l < "$RUN/$ID.$OLD.gating" | tr -d ' ')
      g_new=$(wc -l < "$RUN/$ID.$NEW.gating" | tr -d ' ')
      if diff -q "$RUN/$ID.$OLD.gating" "$RUN/$ID.$NEW.gating" >/dev/null 2>&1; then
        changed="no"
      else
        changed="yes"
        {
          echo "Gating errors that differ: '<' is $OLD, '>' is $NEW."
          diff "$RUN/$ID.$OLD.gating" "$RUN/$ID.$NEW.gating"
        } > "$OUT/diff-$ID.txt"
      fi
    else
      status="not_compared"
      note="could not read the gating errors"
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$ID" "$status" "$g_old" "$g_new" "$changed" "$note" >> "$OUT/results.tsv"
done

# The pull request section. Counts come only from rows that were compared.
compared=$(awk -F'\t' 'NR > 1 && $2 == "compared"' "$OUT/results.tsv" | wc -l | tr -d ' ')
changed_count=$(awk -F'\t' 'NR > 1 && $5 == "yes"' "$OUT/results.tsv" | wc -l | tr -d ' ')
total=$(awk 'NR > 1' "$OUT/results.tsv" | wc -l | tr -d ' ')
not_compared_count=$((total - compared))
{
  echo "## Reference datasets"
  echo
  echo "Gating errors are the errors that survive the annex-pointer filter of \`run-bids-validation.yml\`, counted for the current pin ($OLD) and the candidate ($NEW). Both releases ran with the same flags. \"Changed\" means the set of gating errors differs."
  echo
  echo "| Dataset | Gating errors, $OLD | Gating errors, $NEW | Changed |"
  echo "|---|---|---|---|"
  awk -F'\t' 'NR > 1 && $2 == "compared" { printf "| %s | %s | %s | %s |\n", $1, $3, $4, $5 }' "$OUT/results.tsv"
  echo
  echo "Compared $compared of $total datasets; $changed_count changed."
  not_compared=$(awk -F'\t' 'NR > 1 && $2 != "compared" { printf "%s (%s); ", $1, $6 }' "$OUT/results.tsv")
  if [ -n "$not_compared" ]; then
    echo
    echo "Not compared, so not counted as unchanged: ${not_compared%; }."
  fi
  for f in "$OUT"/diff-*.txt; do
    [ -e "$f" ] || continue
    lines=$(wc -l < "$f" | tr -d ' ')
    echo
    echo "### $(basename "$f" .txt | sed 's/^diff-//')"
    echo
    echo '```diff'
    head -n "$MAX_DIFF_LINES" "$f"
    echo '```'
    if [ "$lines" -gt "$MAX_DIFF_LINES" ]; then
      echo
      echo "$((lines - MAX_DIFF_LINES)) more lines are not shown. The complete comparison is in the validator-compare artifact of this run."
    fi
  done
} > "$OUT/summary.md"

echo "compared $compared of $total datasets; $changed_count changed; summary in $OUT/summary.md"
if [ "$total" -eq 0 ]; then
  echo "compare-gating.sh: nothing to compare" >&2
  exit 1
fi
if [ "$not_compared_count" -gt 0 ]; then
  # Name each dataset and why, so the job log says which one failed without opening the artifact.
  awk -F'\t' 'NR > 1 && $2 != "compared" { printf "compare-gating.sh: %s not compared: %s\n", $1, $6 }' "$OUT/results.tsv" >&2
  if [ "$ALLOW_PARTIAL" = 0 ]; then
    echo "compare-gating.sh: $not_compared_count dataset(s) not compared; see $OUT/summary.md. Pass --allow-partial to accept a partial comparison." >&2
    exit 1
  fi
fi
exit 0
