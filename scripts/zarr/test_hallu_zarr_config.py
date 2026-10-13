#!/usr/bin/env python3
"""Tests for hallu-zarr.sh's --test / --print-config config resolution
(nemarOrg/nemar-cli#1180, epic #1181 phase 3).

Real execution of the actual script via `bash hallu-zarr.sh ...` in a
subprocess, no mocks: every assertion here is against the script's real
stdout/stderr/exit code, run against a temp HOME/ZARR_BASE so nothing touches
a real Hallu deployment or the repo's own working tree. Covers:

- `--test` resolves every documented default (API_BASE, TEST_API_URL,
  S3_BUCKET, ZARR_AWS_PROFILE, ZARR_STATE_DIR, ZARR_WORK_DIR, ZARR_DRIVER_REF,
  ZARR_JOBS) only when the variable is otherwise unset. TEST_API_URL steers
  the separate `nemar` CLI binary that convert_dataset() shells out to for
  the metadata clone -- it has its own API-base resolution independent of
  API_BASE (src/lib/api/client.ts getApiUrl()), missed by issue #1180's
  env-var inventory and found live against xx099905 during this phase's
  verification (see hallu-zarr.sh's pre-pass comment).
- Plain (non-`--test`) `--print-config` still resolves the production
  defaults -- `--test` must not leak into the untested path.
- The test-mode guard rails: each of six prod values (S3_BUCKET, API_BASE,
  TEST_API_URL, AWS_PROFILE via ZARR_AWS_PROFILE, STATE_DIR via
  ZARR_STATE_DIR, WORK_DIR via ZARR_WORK_DIR) exported alongside `--test` is
  refused with a non-zero exit and a message naming the offending value, and
  produces no stdout config dump. The STATE_DIR/WORK_DIR checks are
  normalized (trailing slash, doubled slash) and the API_BASE/TEST_API_URL
  checks are case-insensitive and host-based (scheme, port, path, and a
  trailing DNS root dot do not matter; `api-test.nemar.org` is never
  mistaken for prod) -- each covered by a dedicated variant below, not just
  the bare-string case.
- The guard rails key off the raw pre-pass scan of argv (TEST_PREPASS_SEEN),
  not the arg parser's derived TEST_MODE, so a value-taking flag that used to
  swallow `--test` as its own value (`--dataset --test`, `--limit --test`)
  cannot silently suppress them. Both flags now also refuse a value starting
  with `--` outright, the same way `--requeue` already does.
- A plain prod run (no `--test`) explicitly unsets an ambient `TEST_API_URL`
  left over from an earlier `--test` session, so the `nemar` CLI can never
  depend on stale shell state during a real prod conversion.
- Every resolved config value `--print-config` prints, including the
  operation flags (ONLY_DATASET, LIMIT, REQUEUE, BACKFILL_DIR_FORMATS,
  PREVIEW_ENGINE_BUMP, EXECUTE) alongside the environment-derived ones, and
  in every documented flag order/combination.
- The eight `--test`-defaulted variables really are `export`ed (visible to a
  child process, e.g. the `nemar` CLI binary), not merely shell-local.
- A `.zarr-secrets.env` placed under the TEST state dir (not the prod one)
  flips `NEMAR_WEBHOOK_TOKEN` to `present` in `--print-config`.
- An explicit override (ZARR_JOBS=2) still wins over the `--test` default.
- `--print-config` (with or without `--test`) creates no files under
  ZARR_BASE -- it must exit before `mkdir -p "$WORK_DIR" "$STATE_DIR"`.
- The script refuses to run under bash < 4 (asserted right after
  `set -uo pipefail`): the host guards' `${var,,}` lowercasing is a bash
  4.0+ expansion, and under bash 3.2 (macOS's stock /bin/bash) it is a "bad
  substitution" that makes `_is_prod_api_host` return non-zero -- silently
  turning every host guard into an "allow" rather than a "refuse". Skipped
  unless /bin/bash itself reports major version 3.

Run:
    cd scripts/zarr && uv run --with pytest pytest test_hallu_zarr_config.py
    uv run --with pytest pytest scripts/zarr/test_hallu_zarr_config.py
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "hallu-zarr.sh"


def base_env(zarr_base: Path, home: Path) -> dict[str, str]:
    """A minimal, isolated environment: only what bash/date/etc need to run,
    plus HOME/ZARR_BASE pointed at the test's temp dirs. Built from scratch
    rather than inheriting os.environ, so a developer's real shell (a
    lingering API_BASE, an already-sourced .zarr-secrets.env) can never leak
    into what is supposed to be an isolated run.
    """
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "ZARR_BASE": str(zarr_base),
    }


def run_script(
    args: list[str],
    zarr_base: Path,
    home: Path,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = base_env(zarr_base, home)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def parse_config(stdout: str) -> dict[str, str]:
    """--print-config prints one KEY=value per line."""
    out: dict[str, str] = {}
    for line in stdout.splitlines():
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key] = value
    return out


def tree_entries(root: Path) -> list[Path]:
    """Everything under root, recursively -- used to assert --print-config
    left no trace. root itself (created by the tmp_path fixture, not the
    script) does not count.
    """
    if not root.exists():
        return []
    return list(root.rglob("*"))


def _bin_bash_major_version() -> int | None:
    """The major version of /bin/bash, or None if it can't be determined
    (missing, or output that doesn't parse as an integer). Used to gate the
    bash-3.2 compatibility test below: it should actually run where
    /bin/bash is old (stock macOS) and skip everywhere else, rather than
    hardcoding a path-dependent assumption about what /bin/bash is.
    """
    bash_path = "/bin/bash"
    if not Path(bash_path).exists():
        return None
    try:
        proc = subprocess.run(
            [bash_path, "-c", 'echo "${BASH_VERSINFO[0]}"'],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except OSError:
        return None
    value = proc.stdout.strip()
    return int(value) if value.isdigit() else None


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    zarr_base = tmp_path / "zarr-base"
    home = tmp_path / "home"
    zarr_base.mkdir()
    home.mkdir()
    return zarr_base, home


def test_test_mode_print_config_defaults(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)

    state_dir = f"{zarr_base}/zarr-state-test"
    work_dir = f"{zarr_base}/zarr-scratch-test"

    assert cfg["TEST_MODE"] == "1"
    # The staging catalog is the xx0999NN exemplar fleet, which reconcile's
    # production id filter rejects; --test must pass --accept-exemplars or the
    # nightly run reports `rejected=7` and converts nothing (seen 2026-09-03).
    assert cfg["ACCEPT_EXEMPLARS"] == "1"
    assert cfg["API_BASE"] == "https://api-test.nemar.org"
    # The `nemar` CLI (shelled out to for the metadata clone) resolves its own
    # API base independently of API_BASE -- see the pre-pass comment in
    # hallu-zarr.sh. TEST_API_URL is that CLI's hook, and --test must set it.
    assert cfg["TEST_API_URL"] == "https://api-test.nemar.org"
    assert cfg["CALLBACK_URL"] == "https://api-test.nemar.org/webhooks/zarr-ready"
    # The base the test instance's index.json advertises as `contract_base` and
    # each store's `nemar.contract_url` (#1059/#1064). It is a SEPARATE default
    # from S3_BUCKET on purpose -- the contract URL is the one clients may
    # hardcode, so it must not be derivable from wherever the bytes happen to
    # sit -- which also means --test has to steer it explicitly or a test index
    # would publish the production host.
    assert cfg["CONTRACT_BASE"] == "https://zarr-test.nemar.org"
    # The biosigIO floor the node will install. Printed because it is the one
    # config value that decides what the CONVERSION does rather than where it
    # goes: below 1.2.7 the streaming and in-memory paths disagree about
    # channels.tsv units, which is what gates the engine bump, and below 1.2.8
    # the streaming export rewrites every shard once per channel (#1483), and
    # below 1.2.9 real EEGLAB v7.3 and BrainVision files fail to convert and
    # EDF files that repeat a channel label lose channels, and below 1.2.10 a
    # channels.tsv row that differs from its channel only in case is not
    # applied, and below 1.2.11 no writer can leave subject information out of
    # a store (#1626). The upper bound is a cap, not a floor, raised
    # deliberately per biosigIO release (requirements.txt).
    assert cfg["BIOSIGIO_SPEC"] == "biosigio[zarr,meg,mef3,hdf5]>=1.2.11,<1.2.12"
    assert cfg["S3_BUCKET"] == "nemar-dev"
    assert cfg["AWS_PROFILE"] == "nemar-zarr-dev"
    assert cfg["STATE_DIR"] == state_dir
    assert cfg["WORK_DIR"] == work_dir
    # --test's pre-pass defaults BOTH ZARR_STATE_DIR and ZARR_WORK_DIR onto a
    # dedicated *-test tree, so they are overridden together -- the sweep
    # guard (#1121) must keep sweeping here, not just at the untouched
    # production defaults.
    assert cfg["SWEEP_SCRATCH"] == "1"
    assert cfg["DRIVER_REF"] == "dev"
    assert cfg["JOBS"] == "4"
    assert cfg["DRIVER_REPO"] == f"{state_dir}/nemar-cli"
    assert cfg["VENV_DIR"] == f"{state_dir}/.zarr-venv"
    assert cfg["QUEUE_DB"] == f"{state_dir}/zarr-queue.db"
    assert cfg["LOG_FILE"] == f"{state_dir}/.nm-zarr.log"
    assert cfg["LOCK_FILE"] == f"{state_dir}/.nm-zarr.lock"
    assert cfg["ENGINE_ACK_FILE"] == f"{state_dir}/.zarr-engine-bump-ack"
    assert cfg["ENGINE_REQUEUE_LIMIT"] == "25"
    assert cfg["AWS_REGION"] == "us-east-2"
    # No secrets file exists under the temp HOME/ZARR_BASE, so the token must
    # report absent -- and never its value, since none was ever provided.
    assert cfg["NEMAR_WEBHOOK_TOKEN"] == "absent"
    # The operation flags print-config also reports, at their untouched
    # defaults for a bare `--test --print-config`.
    assert cfg["ONLY_DATASET"] == ""
    assert cfg["LIMIT"] == "0"
    assert cfg["REQUEUE"] == ""
    assert cfg["BACKFILL_DIR_FORMATS"] == "0"
    assert cfg["PREVIEW_ENGINE_BUMP"] == "0"
    assert cfg["EXECUTE"] == "0"


def test_the_biosigio_fallback_floor_matches_requirements_txt() -> None:
    """`BIOSIGIO_SPEC` is a FALLBACK for a clone that predates
    scripts/zarr/requirements.txt, which is the real pin -- so the two are two
    copies of one number, and the failure mode is silent: a node on the fallback
    would install a version the converter's code assumes it is above. Compared
    here rather than trusted, since nothing else reads both files.
    """
    root = SCRIPT.parent
    spec = None
    for line in (root / "hallu-zarr.sh").read_text().splitlines():
        if line.startswith("BIOSIGIO_SPEC="):
            spec = line.split(":-", 1)[1].rstrip('}"')
            break
    assert spec, "BIOSIGIO_SPEC default not found in hallu-zarr.sh"
    pinned = [
        ln.strip()
        for ln in (root / "requirements.txt").read_text().splitlines()
        if ln.strip().startswith("biosigio[")
    ]
    assert pinned == [spec], f"fallback {spec!r} != requirements.txt {pinned!r}"


def test_print_config_without_test_uses_prod_defaults(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)

    assert cfg["TEST_MODE"] == "0"
    assert cfg["API_BASE"] == "https://api.nemar.org"
    assert cfg["TEST_API_URL"] == ""
    assert cfg["CALLBACK_URL"] == "https://api.nemar.org/webhooks/zarr-ready"
    assert cfg["CONTRACT_BASE"] == "https://zarr.nemar.org"
    assert cfg["BIOSIGIO_SPEC"] == "biosigio[zarr,meg,mef3,hdf5]>=1.2.11,<1.2.12"
    assert cfg["S3_BUCKET"] == "nemar"
    assert cfg["AWS_PROFILE"] == "nemar-zarr"
    assert cfg["STATE_DIR"] == f"{zarr_base}/zarr-state"
    assert cfg["WORK_DIR"] == f"{zarr_base}/zarr-scratch"
    # Neither ZARR_STATE_DIR nor ZARR_WORK_DIR is overridden here -- both sit
    # at their ZARR_BASE-relative defaults, so the #1121 sweep guard must
    # leave sweeping on.
    assert cfg["SWEEP_SCRATCH"] == "1"
    assert cfg["DRIVER_REF"] == "main"
    # JOBS falls back to `nproc`, which varies by runner; just confirm it
    # resolved to a positive integer rather than being empty/non-numeric.
    assert cfg["JOBS"].isdigit() and int(cfg["JOBS"]) > 0
    # Worker anonymous-memory bounds (on004789's RLIMIT_DATA trips, biosigio#129).
    assert cfg["ZARR_ASYNC__CONCURRENCY"] == "3"
    assert cfg["MALLOC_ARENA_MAX"] == "2"
    assert cfg["ONLY_DATASET"] == ""
    assert cfg["LIMIT"] == "0"
    assert cfg["REQUEUE"] == ""
    assert cfg["BACKFILL_DIR_FORMATS"] == "0"
    assert cfg["PREVIEW_ENGINE_BUMP"] == "0"
    assert cfg["EXECUTE"] == "0"


def test_sweep_scratch_off_when_only_state_dir_overridden(
    dirs: tuple[Path, Path],
) -> None:
    """#1121: a second deployment that overrides ZARR_STATE_DIR but leaves
    ZARR_WORK_DIR at the shared default holds its own lock (under its own
    STATE_DIR) while sharing WORK_DIR with whatever else uses the default --
    so that lock proves nothing about who owns files under WORK_DIR. The
    sweep must refuse rather than delete another deployment's in-flight
    scratch.
    """
    zarr_base, home = dirs
    proc = run_script(
        ["--print-config"],
        zarr_base,
        home,
        extra_env={"ZARR_STATE_DIR": str(zarr_base / "custom-state")},
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["STATE_DIR"] == str(zarr_base / "custom-state")
    assert cfg["WORK_DIR"] == f"{zarr_base}/zarr-scratch"
    assert cfg["SWEEP_SCRATCH"] == "0"


def test_sweep_scratch_off_when_only_work_dir_overridden(
    dirs: tuple[Path, Path],
) -> None:
    """Symmetric case: ZARR_WORK_DIR overridden alone, ZARR_STATE_DIR (and
    therefore the lock) left at the shared default -- the mirror image of
    the deployment shape that destroyed an in-flight on007808 recording.
    """
    zarr_base, home = dirs
    proc = run_script(
        ["--print-config"],
        zarr_base,
        home,
        extra_env={"ZARR_WORK_DIR": str(zarr_base / "custom-scratch")},
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["WORK_DIR"] == str(zarr_base / "custom-scratch")
    assert cfg["STATE_DIR"] == f"{zarr_base}/zarr-state"
    assert cfg["SWEEP_SCRATCH"] == "0"


@pytest.mark.parametrize(
    ("extra_env", "needle"),
    [
        ({"S3_BUCKET": "nemar"}, "S3_BUCKET=nemar"),
        ({"API_BASE": "https://api.nemar.org"}, "API_BASE=https://api.nemar.org"),
        # Case-insensitive, host-based match: scheme/case/trailing-slash/port
        # must not let a prod host slip past the guard.
        ({"API_BASE": "https://API.NEMAR.ORG"}, "API_BASE=https://API.NEMAR.ORG"),
        (
            {"API_BASE": "http://api.nemar.org/"},
            "API_BASE=http://api.nemar.org/",
        ),
        (
            {"API_BASE": "https://api.nemar.org:8443"},
            "API_BASE=https://api.nemar.org:8443",
        ),
        # Trailing DNS root dot: "api.nemar.org." is DNS-identical to
        # "api.nemar.org" (an absolute FQDN), so a naive string comparison
        # that doesn't strip it would let this slip past as a "different"
        # host while it resolves to production.
        (
            {"API_BASE": "https://api.nemar.org./"},
            "API_BASE=https://api.nemar.org./",
        ),
        (
            {"TEST_API_URL": "https://api.nemar.org"},
            "TEST_API_URL=https://api.nemar.org",
        ),
        (
            {"TEST_API_URL": "https://API.NEMAR.ORG/"},
            "TEST_API_URL=https://API.NEMAR.ORG/",
        ),
        (
            {"TEST_API_URL": "https://API.NEMAR.ORG.:443/"},
            "TEST_API_URL=https://API.NEMAR.ORG.:443/",
        ),
        ({"ZARR_AWS_PROFILE": "nemar-zarr"}, "AWS_PROFILE=nemar-zarr"),
        (
            {"ZARR_STATE_DIR": "/mnt/local/zarr-state"},
            "STATE_DIR=/mnt/local/zarr-state",
        ),
        # Normalized: a trailing slash or a doubled slash must not let the
        # prod state dir slip past a bare string-equality check.
        (
            {"ZARR_STATE_DIR": "/mnt/local/zarr-state/"},
            "STATE_DIR=/mnt/local/zarr-state/",
        ),
        (
            {"ZARR_STATE_DIR": "/mnt/local//zarr-state"},
            "STATE_DIR=/mnt/local//zarr-state",
        ),
        # WORK_DIR was not guarded at all before this round -- same
        # normalization applies to it as to STATE_DIR.
        (
            {"ZARR_WORK_DIR": "/mnt/local/zarr-scratch"},
            "WORK_DIR=/mnt/local/zarr-scratch",
        ),
        (
            {"ZARR_WORK_DIR": "/mnt/local/zarr-scratch/"},
            "WORK_DIR=/mnt/local/zarr-scratch/",
        ),
    ],
    ids=[
        "s3-bucket",
        "api-base",
        "api-base-uppercase",
        "api-base-http-trailing-slash",
        "api-base-port",
        "api-base-dns-root-dot",
        "test-api-url",
        "test-api-url-uppercase-trailing-slash",
        "test-api-url-uppercase-dns-root-dot-port",
        "aws-profile",
        "state-dir",
        "state-dir-trailing-slash",
        "state-dir-double-slash",
        "work-dir",
        "work-dir-trailing-slash",
    ],
)
def test_guard_rail_refuses_prod_value_with_test(
    dirs: tuple[Path, Path], extra_env: dict[str, str], needle: str
) -> None:
    zarr_base, home = dirs
    proc = run_script(
        ["--test", "--print-config"], zarr_base, home, extra_env=extra_env
    )

    assert proc.returncode != 0
    assert needle in proc.stderr
    assert "--test is a safety boundary" in proc.stderr
    # The guard fires before the config dump: a prod value must be stopped,
    # not printed and then stopped.
    assert proc.stdout == ""


@pytest.mark.parametrize(
    "flag",
    ["--dataset", "--limit"],
    ids=["dataset", "limit"],
)
def test_value_flag_refuses_test_as_its_value(
    dirs: tuple[Path, Path], flag: str
) -> None:
    """`--dataset --test` / `--limit --test` (value missing) must not swallow
    the --test token as the flag's value -- that used to leave TEST_MODE
    unset and no guard running, while the pre-pass had already applied test
    defaults on top of an ambient prod S3_BUCKET. Refused outright now, the
    same way --requeue already refuses a `--`-prefixed value.
    """
    zarr_base, home = dirs
    proc = run_script(
        [flag, "--test", "--print-config"],
        zarr_base,
        home,
        extra_env={"S3_BUCKET": "nemar"},
    )

    assert proc.returncode != 0
    assert "requires a value" in proc.stderr
    assert proc.stdout == ""


def test_test_api_url_unset_on_plain_prod_run(dirs: tuple[Path, Path]) -> None:
    """A TEST_API_URL left exported from an earlier --test session must not
    leak into a later plain (prod) run -- the `nemar` CLI would otherwise
    keep pointing at api-test.nemar.org during a supposed prod conversion.
    """
    zarr_base, home = dirs
    proc = run_script(
        ["--print-config"],
        zarr_base,
        home,
        extra_env={"TEST_API_URL": "https://api-test.nemar.org"},
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["TEST_API_URL"] == ""
    assert "unsetting stale TEST_API_URL" in proc.stderr


def test_explicit_zarr_jobs_wins_over_test_default(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(
        ["--test", "--print-config"], zarr_base, home, extra_env={"ZARR_JOBS": "2"}
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["JOBS"] == "2"


def test_explicit_worker_memory_bounds_win(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(
        ["--print-config"],
        zarr_base,
        home,
        extra_env={"ZARR_ASYNC__CONCURRENCY": "8", "MALLOC_ARENA_MAX": "4"},
    )

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["ZARR_ASYNC__CONCURRENCY"] == "8"
    assert cfg["MALLOC_ARENA_MAX"] == "4"


@pytest.mark.parametrize("mode", [[], ["--test"]])
def test_worker_memory_bounds_reach_child_processes(
    dirs: tuple[Path, Path], mode: list[str]
) -> None:
    """The bounds only work if the Python driver and its pool workers SEE them,
    so check the exported environment of a child shell, the same way
    test_test_mode_env_vars_are_exported does, in both prod and --test mode."""
    zarr_base, home = dirs
    env = base_env(zarr_base, home)
    wrapper = (
        f'trap "env" EXIT; source {shlex.quote(str(SCRIPT))} '
        f"{' '.join(mode)} --print-config >/dev/null 2>/dev/null"
    )
    proc = subprocess.run(
        ["bash", "-c", wrapper], env=env, capture_output=True, text=True,
        timeout=30, check=False,
    )
    dumped = dict(
        line.partition("=")[::2] for line in proc.stdout.splitlines() if "=" in line
    )
    assert dumped.get("ZARR_ASYNC__CONCURRENCY") == "3"
    assert dumped.get("MALLOC_ARENA_MAX") == "2"


def test_test_mode_env_vars_are_exported(dirs: tuple[Path, Path]) -> None:
    """A regression that drops `export` from one of the pre-pass's defaults
    must fail this test: `source`s the script in a `bash -c` wrapper and
    dumps the CHILD shell's own environment (via a trap on EXIT, fired when
    --print-config's `exit 0` unwinds the sourcing shell) rather than
    hallu-zarr.sh's stdout, so this is checking real export visibility to a
    child process (the `nemar` CLI, in the real run path), not just that the
    variable has a value in the current shell.
    """
    zarr_base, home = dirs
    env = base_env(zarr_base, home)
    wrapper = (
        f'trap "env" EXIT; source {shlex.quote(str(SCRIPT))} --test --print-config '
        ">/dev/null 2>/dev/null"
    )
    proc = subprocess.run(
        ["bash", "-c", wrapper],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    dumped: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            dumped[key] = value

    for name in (
        "TEST_API_URL",
        "API_BASE",
        "S3_BUCKET",
        "ZARR_AWS_PROFILE",
        "ZARR_STATE_DIR",
        "ZARR_WORK_DIR",
        "ZARR_DRIVER_REF",
        "ZARR_JOBS",
        "ZARR_CONTRACT_BASE",
    ):
        assert name in dumped, f"{name} missing from child env -- not exported?"

    assert dumped["TEST_API_URL"] == "https://api-test.nemar.org"
    assert dumped["API_BASE"] == "https://api-test.nemar.org"
    assert dumped["S3_BUCKET"] == "nemar-dev"
    assert dumped["ZARR_AWS_PROFILE"] == "nemar-zarr-dev"
    assert dumped["ZARR_STATE_DIR"] == f"{zarr_base}/zarr-state-test"
    assert dumped["ZARR_WORK_DIR"] == f"{zarr_base}/zarr-scratch-test"
    assert dumped["ZARR_DRIVER_REF"] == "dev"
    assert dumped["ZARR_JOBS"] == "4"


def test_secrets_present_in_test_state_dir_flips_token(
    dirs: tuple[Path, Path],
) -> None:
    zarr_base, home = dirs
    test_state_dir = zarr_base / "zarr-state-test"
    test_state_dir.mkdir(parents=True)
    (test_state_dir / ".zarr-secrets.env").write_text("NEMAR_WEBHOOK_TOKEN=abc123\n")

    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["NEMAR_WEBHOOK_TOKEN"] == "present"


def test_secrets_at_prod_path_not_used_in_test_mode(
    dirs: tuple[Path, Path],
) -> None:
    """A secrets file sitting at the PROD state dir must not be read by a
    --test run -- each instance reads only its own state dir's secrets file.
    """
    zarr_base, home = dirs
    prod_state_dir = zarr_base / "zarr-state"
    prod_state_dir.mkdir(parents=True)
    (prod_state_dir / ".zarr-secrets.env").write_text("NEMAR_WEBHOOK_TOKEN=prodtoken\n")

    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["NEMAR_WEBHOOK_TOKEN"] == "absent"


@pytest.mark.parametrize(
    "args",
    [
        ["--print-config", "--test"],
        ["--test", "--dataset", "xx099905", "--print-config"],
        ["--requeue", "all", "--test", "--print-config"],
        ["--backfill-dir-formats", "--test", "--print-config"],
        ["--preview-engine-bump", "--test", "--print-config"],
    ],
    ids=[
        "print-config-before-test",
        "test-dataset-print-config",
        "requeue-all-test-print-config",
        "backfill-dir-formats-test-print-config",
        "preview-engine-bump-test-print-config",
    ],
)
def test_flag_order_and_combinations_resolve_test_defaults(
    dirs: tuple[Path, Path], args: list[str]
) -> None:
    zarr_base, home = dirs
    proc = run_script(args, zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    cfg = parse_config(proc.stdout)
    assert cfg["TEST_MODE"] == "1"
    assert cfg["S3_BUCKET"] == "nemar-dev"
    assert cfg["API_BASE"] == "https://api-test.nemar.org"
    assert cfg["TEST_API_URL"] == "https://api-test.nemar.org"

    if "--dataset" in args:
        assert cfg["ONLY_DATASET"] == "xx099905"
    if "--requeue" in args:
        assert cfg["REQUEUE"] == "all"
    if "--backfill-dir-formats" in args:
        assert cfg["BACKFILL_DIR_FORMATS"] == "1"
    if "--preview-engine-bump" in args:
        assert cfg["PREVIEW_ENGINE_BUMP"] == "1"


@pytest.mark.skipif(
    _bin_bash_major_version() != 3,
    reason="/bin/bash is not bash 3.x on this machine",
)
def test_fails_loud_under_bash_3(dirs: tuple[Path, Path]) -> None:
    """The --test host guards (_is_prod_api_host) use ${var,,} lowercasing,
    a bash 4.0+ expansion. Under bash 3.2 (macOS's stock /bin/bash) that is
    a "bad substitution": the function errors and returns non-zero, so its
    `if _is_prod_api_host ...` caller reads that as "not prod" and every
    host guard would silently PASS -- the failure this whole PR exists to
    close, just moved to a different layer. The version assertion right
    after `set -uo pipefail` has to catch this before anything else runs,
    invoked here via the real /bin/bash rather than whatever `bash` PATH
    resolves to for the other tests in this file.
    """
    zarr_base, home = dirs
    env = base_env(zarr_base, home)
    proc = subprocess.run(
        ["/bin/bash", str(SCRIPT), "--print-config"],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert proc.returncode != 0
    assert "requires bash 4+" in proc.stderr


def test_print_config_creates_no_files_in_test_mode(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--test", "--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    assert tree_entries(zarr_base) == []


def test_print_config_creates_no_files_in_prod_mode(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home)

    assert proc.returncode == 0, proc.stderr
    assert tree_entries(zarr_base) == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))


# ---------------------------------------------------------------------------
# Engine-bump ack file lifecycle (#1172, ADR 0033)
# ---------------------------------------------------------------------------

FAKE_PY = """#!/usr/bin/env python3
# Stands in for the venv's python. Records the argv of every `qpy` call so a
# test can assert which flags reconcile was given, and hands the `-c` probes
# `setup()` makes to a real interpreter. It stands in for the INTERPRETER, never
# for hallu-zarr.sh's own logic: the ack file is found, consumed and re-armed by
# the real script.
import os
import sys

argv = sys.argv[1:]
if argv[:1] == ["-c"]:
    # setup()'s biosigio probes (import guard, floor check). These run for REAL, in
    # the interpreter that runs the tests, against a `biosigio` package the test
    # wrote whose only content is a `__version__`: the script's own version
    # comparison is what is under test, not biosigIO.
    real = os.environ["FAKE_REAL_PYTHON"]
    os.execv(real, [real, *argv])

if "--check-env" in argv:
    # generate_zarr.py --check-env: the scratch-settings preflight, run once
    # before any dataset is dispatched. Ahead of the conversion branch below
    # because it is the same script, and recorded as its full argv rather than
    # as a DRIVER line, so a test asking whether a conversion ran is not
    # answered by the preflight. A test makes it fail by setting CHECK_ENV_RC
    # (and CHECK_ENV_MSG, printed as the driver does, on stderr when
    # CHECK_ENV_STREAM is "stderr", the way a traceback arrives), or runs the
    # REAL driver's check by pointing CHECK_ENV_REAL_DRIVER at it.
    with open(os.environ["QPY_LOG"], "a") as fh:
        fh.write(" ".join(argv) + chr(10))
    real_driver = os.environ.get("CHECK_ENV_REAL_DRIVER")
    if real_driver:
        real = os.environ["FAKE_REAL_PYTHON"]
        os.execv(real, [real, real_driver, "--check-env"])
    rc = int(os.environ.get("CHECK_ENV_RC", "0"))
    if rc:
        stream = sys.stderr if os.environ.get("CHECK_ENV_STREAM") == "stderr" else sys.stdout
        print(os.environ.get("CHECK_ENV_MSG", "::error::invalid scratch setting"), file=stream)
    sys.exit(rc)

if argv[:1] and argv[0].endswith("generate_zarr.py"):
    # The conversion driver. Its exit code is the one thing the drain loop
    # reads from it when it writes no callback, and that loop is what is under
    # test, so the code comes from the test (FAKE_DRIVER_RC, default 0).
    with open(os.environ["QPY_LOG"], "a") as fh:
        fh.write("DRIVER " + " ".join(argv[1:]) + chr(10))
    with open(os.environ["QPY_LOG"] + ".pids", "a") as fh:
        fh.write(str(os.getpid()) + chr(10))
    with open(os.environ["QPY_LOG"] + ".env", "a") as fh:
        fh.write("ZARR_LEDGER_DIR=" + os.environ.get("ZARR_LEDGER_DIR", "<unset>") + chr(10))
    if os.environ.get("FAKE_DRIVER_CALLBACK") and "--callback-out" in argv:
        # The callback body the driver writes on every outcome, when a test
        # wants to see what the script does with it.
        with open(argv[argv.index("--callback-out") + 1], "w") as fh:
            fh.write(os.environ["FAKE_DRIVER_CALLBACK"])
    import time

    if os.environ.get("FAKE_DRIVER_CHILD"):
        # A worker of the driver's: it must go with the driver when the driver is stopped.
        import subprocess

        child = subprocess.Popen(["sleep", "60"])
        with open(os.environ["QPY_LOG"] + ".childpids", "a") as fh:
            fh.write(str(child.pid) + chr(10))
    delay = os.environ.get("FAKE_DRIVER_TERM_DELAY")
    if delay:
        # A driver that takes its time to stop, and says when it has.
        import signal

        def _stop(signum, frame):
            time.sleep(float(delay))
            with open(os.environ["QPY_LOG"] + ".exited", "w") as fh:
                fh.write("exited")
            sys.exit(143)

        signal.signal(signal.SIGTERM, _stop)
    time.sleep(float(os.environ.get("FAKE_DRIVER_SLEEP", "0")))
    sys.exit(int(os.environ.get("FAKE_DRIVER_RC", "0")))

with open(os.environ["QPY_LOG"], "a") as fh:
    fh.write(" ".join(argv) + chr(10))

if "reconcile" in argv:
    print(os.environ.get("QPY_RECONCILE_OUT", "queued=0 parked=0"))
if "heartbeat" in argv:
    print(os.environ.get("QPY_HEARTBEAT_OUT", "1"))
if "next" in argv:
    # QPY_NEXT is the queue, one `<id>TAB<version>` per `;`, handed out one per
    # `next` call. Unset (the default) prints nothing: an empty line ends the
    # drain immediately.
    # Each row is claimed with an exclusive create, as the real queue claims one
    # inside a transaction, so two slots asking at once can never both be handed it.
    queue = [row for row in os.environ.get("QPY_NEXT", "").split(";") if row]
    claims = os.environ["QPY_LOG"] + ".claims"
    os.makedirs(claims, exist_ok=True)
    for i, row in enumerate(queue):
        try:
            os.close(os.open(os.path.join(claims, str(i)), os.O_CREAT | os.O_EXCL))
        except FileExistsError:
            continue
        print(row)
        break
sys.exit(0)
"""

FAKE_NEMAR = """#!/bin/sh
# `nemar dataset download <id> --no-data -o <dir>`, the metadata clone each
# queued dataset starts with. The drain loop's handling of the driver's exit is
# what is under test, not the clone, and the driver stand-in never reads the
# clone, so an empty directory is the whole job.
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then mkdir -p "$2"; fi
  shift
done
exit 0
"""

FAKE_UV = """#!/bin/sh
# hallu-zarr.sh installs biosigIO with `uv pip install ... || true`. The fake
# python above answers the import guard, so the install has nothing to do --
# and a real uv here would reach the network on every case.
exit 0
"""

FLOCK_SHIM = """#!/usr/bin/env python3
# util-linux flock, absent on macOS: `flock [-n] [-u] FD`, the only forms
# hallu-zarr.sh uses. It locks the descriptor bash opened and passed down, so two
# processes contend exactly as they do under the real tool.
import fcntl
import sys
import time

args = sys.argv[1:]
fd = int(args[-1])
try:
    if "-u" in args:
        fcntl.flock(fd, fcntl.LOCK_UN)
    elif "-w" in args:  # wait up to N seconds, then exit 1, as util-linux does
        deadline = time.monotonic() + float(args[args.index("-w") + 1])
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    sys.exit(1)
                time.sleep(0.02)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | (fcntl.LOCK_NB if "-n" in args else 0))
except BlockingIOError:
    sys.exit(1)
"""


def _write_exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(0o755)


@pytest.fixture
def ack_run(tmp_path: Path):
    """A runnable hallu-zarr.sh whose queue calls are recorded.

    Everything the script itself decides runs for real: setup() resets a REAL
    git clone (of a local path whose URL satisfies the nemarOrg/nemar-cli
    check), the drift guard compares real files, the lock is taken, and the ack
    file is found and consumed by the script. Only the two things this test has
    no business running are stood in for -- the interpreter that would import
    biosigIO and execute zarr_queue.py, and the installer.
    """
    zarr_base = tmp_path / "zarr-base"
    home = tmp_path / "home"
    state = zarr_base / "zarr-state"
    zarr_base.mkdir()
    home.mkdir()

    # A local "remote" whose path contains nemarOrg/nemar-cli, because setup()
    # refuses a clone whose origin URL does not.
    upstream = tmp_path / "nemarOrg" / "nemar-cli"
    (upstream / "scripts" / "zarr").mkdir(parents=True)
    for name in ("generate_zarr.py", "zarr_queue.py"):
        (upstream / "scripts" / "zarr" / name).write_text("# stub\n")
    # The clone's copy of THIS script, byte-identical, so the drift guard is the
    # no-op it is in the real deployment rather than noise on stderr.
    (upstream / "scripts" / "zarr" / "hallu-zarr.sh").write_text(SCRIPT.read_text())
    git = ["git", "-C", str(upstream)]
    subprocess.run([*git[:1], "init", "-q", "-b", "main", str(upstream)], check=True)
    subprocess.run([*git, "config", "user.email", "t@example.org"], check=True)
    subprocess.run([*git, "config", "user.name", "t"], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "stub driver"], check=True)

    driver_repo = state / "nemar-cli"
    driver_repo.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "clone", "-q", "--branch", "main", str(upstream), str(driver_repo)],
        check=True,
    )

    venv_bin = tmp_path / "venv" / "bin"
    venv_bin.mkdir(parents=True)
    _write_exec(venv_bin / "python", FAKE_PY)

    fake_bin = tmp_path / "fakebin"
    fake_bin.mkdir()
    _write_exec(fake_bin / "uv", FAKE_UV)
    _write_exec(fake_bin / "nemar", FAKE_NEMAR)
    if shutil.which("flock") is None:
        _write_exec(fake_bin / "flock", FLOCK_SHIM)

    qpy_log = tmp_path / "qpy.log"
    ack_file = state / ".zarr-engine-bump-ack"
    stubs = tmp_path / "stubs"

    def run(
        reconcile_out: str = "queued=0 parked=0",
        extra_env: dict[str, str] | None = None,
        args: list[str] | None = None,
        # In range for the two-sided check in setup(): [BIOSIGIO_FLOOR, BIOSIGIO_CAP).
        biosigio_version: str = "1.2.11",
        packaging_importable: bool = True,
        background: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        # The venv's `biosigio`: a package that is only a version, which is all
        # setup()'s floor check reads. `packaging_importable=False` shadows
        # `packaging` with a module that fails to import, which is what a venv
        # without it looks like to the check's fallback.
        shutil.rmtree(stubs, ignore_errors=True)
        (stubs / "biosigio").mkdir(parents=True)
        (stubs / "biosigio" / "__init__.py").write_text(f'__version__ = "{biosigio_version}"\n')
        if not packaging_importable:
            (stubs / "packaging").mkdir()
            (stubs / "packaging" / "__init__.py").write_text(
                'raise ImportError("packaging is not installed in this venv")\n'
            )
        env = base_env(zarr_base, home)
        env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"
        env.update(
            {
                # These cases are about one drain's handling of the queue; the slots
                # have their own cases below.
                "ZARR_SLOTS": "1",
                "ZARR_DRIVER_REF": "main",
                "ZARR_DRIVER_REPO": str(driver_repo),
                "ZARR_VENV_DIR": str(venv_bin.parent),
                "QPY_LOG": str(qpy_log),
                "QPY_RECONCILE_OUT": reconcile_out,
                "FAKE_REAL_PYTHON": sys.executable,
                "PYTHONPATH": str(stubs),
            }
        )
        if extra_env:
            env.update(extra_env)
        if background:  # the running process, for a test that signals it
            return subprocess.Popen(  # type: ignore[return-value]
                ["bash", str(SCRIPT), *(args or [])],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                # Run from a shell as a background job, pytest itself starts with SIGINT
                # ignored, and a child inherits that; a slot run directly does not.
                preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL),
            )
        return subprocess.run(
            ["bash", str(SCRIPT), *(args or [])],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def qpy_calls() -> list[str]:
        return qpy_log.read_text().splitlines() if qpy_log.exists() else []

    return run, qpy_calls, ack_file, qpy_log


def test_ack_file_is_consumed_by_exactly_one_run(ack_run) -> None:
    """The two-step engine bump (AGENTS.md, ADR 0033): merging a bump deploys
    it, so a bump over the requeue limit re-queues NOTHING until an operator
    touches the ack file -- and that file arms exactly ONE run.

    Untested in bash until now, and the failure modes are both bad and silent:
    an ack that is not consumed re-queues the whole back catalog on every
    hourly tick, and one consumed without being passed on leaves an operator
    who did the two-step procedure with nothing to show for it.
    """
    run, qpy_calls, ack_file, _ = ack_run

    ack_file.parent.mkdir(parents=True, exist_ok=True)
    ack_file.touch()
    first = run()
    assert first.returncode == 0, first.stderr
    reconciles = [c for c in qpy_calls() if "reconcile" in c]
    assert len(reconciles) == 1, qpy_calls()
    assert "--engine-requeue-ack" in reconciles[0]
    # Consumed BEFORE the run, so a crash mid-reconcile cannot leave it armed.
    assert not ack_file.exists()
    assert "consumed" in first.stdout + first.stderr

    second = run()
    assert second.returncode == 0, second.stderr
    reconciles = [c for c in qpy_calls() if "reconcile" in c]
    assert len(reconciles) == 2, qpy_calls()
    assert "--engine-requeue-ack" not in reconciles[1]


# ---------------------------------------------------------------------------
# The scratch-settings preflight runs once, before any dataset is dispatched
# ---------------------------------------------------------------------------

BAD_SETTING = "::error::invalid scratch setting: ZARR_SCRATCH_HEADROOM_BYTES='10G' is not a number"


def test_a_bad_scratch_setting_stops_the_whole_run_before_the_queue_is_touched(ack_run) -> None:
    """Checked per dataset, a typo in the crontab posts `failed` for every dataset
    the drain visits and burns a queue attempt on each. Checked here, once, it stops
    the run with the message and leaves the queue and D1 alone."""
    run, qpy_calls, _, _ = ack_run
    done = run(extra_env={"CHECK_ENV_RC": "1", "CHECK_ENV_MSG": BAD_SETTING})
    assert done.returncode != 0
    assert "ZARR_SCRATCH_HEADROOM_BYTES='10G' is not a number" in done.stderr
    assert "refusing to dispatch any dataset" in done.stderr
    calls = qpy_calls()
    assert any("--check-env" in c for c in calls), calls
    # No reconcile, no `next`, nothing that touches the queue.
    assert [c for c in calls if "--check-env" not in c] == [], calls


def test_a_bad_scratch_setting_also_stops_a_single_dataset_run(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    done = run(
        args=["--dataset", "nm000001"],
        extra_env={"CHECK_ENV_RC": "1", "CHECK_ENV_MSG": BAD_SETTING},
    )
    assert done.returncode != 0
    assert "is not a number" in done.stderr
    assert [c for c in qpy_calls() if "--check-env" not in c] == []


def test_valid_scratch_settings_let_the_run_proceed_to_the_queue(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    done = run()
    assert done.returncode == 0, done.stderr
    calls = qpy_calls()
    check = next(i for i, c in enumerate(calls) if "--check-env" in c)
    reconcile = next(i for i, c in enumerate(calls) if "reconcile" in c)
    assert check < reconcile, calls
    assert sum("--check-env" in c for c in calls) == 1, "checked once per run, not per dataset"


def test_stats_and_requeue_still_work_with_a_bad_scratch_setting(ack_run) -> None:
    """The check sits after every early exit, so an operator can still read the queue
    and revive recordings to find out what a bad setting did."""
    run, qpy_calls, _, _ = ack_run
    bad = {"CHECK_ENV_RC": "1", "CHECK_ENV_MSG": BAD_SETTING}
    stats = run(args=["--stats"], extra_env=bad)
    assert stats.returncode == 0, stats.stderr
    requeue = run(args=["--requeue", "failed"], extra_env=bad)
    assert requeue.returncode == 0, requeue.stderr
    calls = qpy_calls()
    assert any(c.endswith("stats") for c in calls), calls
    assert any("requeue" in c for c in calls), calls
    assert not any("--check-env" in c for c in calls), calls


def test_a_message_the_driver_prints_on_stderr_reaches_the_error_log(ack_run) -> None:
    """The check's stderr is merged into what the script reports, so a traceback is
    logged as an ERROR line (and teed to the log file) instead of vanishing."""
    run, _, _, _ = ack_run
    done = run(
        extra_env={
            "CHECK_ENV_RC": "1",
            "CHECK_ENV_STREAM": "stderr",
            "CHECK_ENV_MSG": "Traceback (most recent call last): ValueError: boom",
        }
    )
    assert done.returncode != 0
    assert "ERROR: Traceback (most recent call last): ValueError: boom" in done.stderr


def test_the_real_driver_refuses_a_bad_setting_through_the_real_wiring(ack_run) -> None:
    """hallu-zarr.sh runs the REAL `generate_zarr.py --check-env`: its message and its
    exit status are what stop the run, with the queue untouched."""
    run, qpy_calls, _, _ = ack_run
    done = run(
        extra_env={
            "CHECK_ENV_REAL_DRIVER": str(SCRIPT.with_name("generate_zarr.py")),
            "ZARR_SCRATCH_HEADROOM_BYTES": "10G",
        }
    )
    assert done.returncode != 0
    assert "ZARR_SCRATCH_HEADROOM_BYTES" in done.stderr
    assert "refusing to dispatch any dataset" in done.stderr
    assert [c for c in qpy_calls() if "--check-env" not in c] == []


def test_the_real_driver_accepts_the_default_settings_through_the_real_wiring(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    done = run(extra_env={"CHECK_ENV_REAL_DRIVER": str(SCRIPT.with_name("generate_zarr.py"))})
    assert done.returncode == 0, done.stderr
    assert any("reconcile" in c for c in qpy_calls()), qpy_calls()


# ---------------------------------------------------------------------------
# The run's ready body is posted as it is, and its counts reach the queue
# ---------------------------------------------------------------------------

STAND_IN_CURL = """#!/bin/sh
# Records each call as one compact JSON line: the full argv and the JSON body the
# call carries. `--data @file` is read, as curl does.
argv_json="$(printf '%s\n' "$@" | jq -R . | jq -cs .)"
payload=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--data" ]; then shift; payload="$1"; fi
  shift
done
case "$payload" in @*) payload="$(cat "${payload#@}")" ;; esac
jq -cn --argjson argv "$argv_json" --argjson payload "$payload" \
  '{argv: $argv, payload: $payload}' >> "$CURL_LOG"
"""

WEBHOOK_URL = "https://hooks.example.test/webhooks/zarr-ready"


@pytest.fixture
def drain_one(ack_run, tmp_path: Path):
    """The queue drain handling one dataset: `next` serves it once, the conversion
    driver writes the body a test chooses, `curl` records every POST, and the
    metadata clone is `ack_run`'s `FAKE_NEMAR`. The script's own handling of that
    body (what it posts, what it hands `qpy done`) is the real code."""
    run, qpy_calls, _, _ = ack_run
    stubs = tmp_path / "stubbin"
    stubs.mkdir()
    _write_exec(stubs / "curl", STAND_IN_CURL)
    curl_log = tmp_path / "curl.log"

    def go(body: dict, rc: int = 0) -> subprocess.CompletedProcess[str]:
        path = os.pathsep.join(
            [str(stubs), str(tmp_path / "fakebin"), os.environ.get("PATH", "/usr/bin:/bin")]
        )
        return run(
            extra_env={
                "PATH": path,
                "NEMAR_WEBHOOK_TOKEN": "test-token",
                "ZARR_CALLBACK_URL": WEBHOOK_URL,
                "CURL_LOG": str(curl_log),
                "QPY_NEXT": "nm000276\tv1",
                "FAKE_DRIVER_CALLBACK": json.dumps(body),
                "FAKE_DRIVER_RC": str(rc),
            }
        )

    def posts() -> list[dict]:
        """Every curl call, in order: ``{"argv": [...], "payload": {...}}``."""
        lines = curl_log.read_text().splitlines() if curl_log.exists() else []
        return [json.loads(line) for line in lines]

    return go, posts, qpy_calls


UNCHANGED_BODY = {
    "dataset_id": "nm000276",
    "status": "ready",
    "store_count": 12,
    "index_etag": "d41d8cd98f00b204e9800998ecf8427e",
    "commit": "a" * 40,
    "converted": [],
    "removed": [],
    "errors": 0,
    "failed": [],
    "failure_count": 0,
    "data_failures": [],
    "deterministic": False,
    "retryable_failures": 0,
    # Distinct, so a crossed read of the body or a crossed `qpy done` flag shows.
    "pending_count": 28,
    "discovered_count": 40,
    "not_attempted_count": 25,
}


def assert_webhook_post(call: dict) -> None:
    """One call is a POST to the configured webhook with the token and JSON headers."""
    argv = call["argv"]
    assert argv[argv.index("-X") + 1 : argv.index("-X") + 3] == ["POST", WEBHOOK_URL], argv
    headers = [argv[i + 1] for i, arg in enumerate(argv) if arg == "-H"]
    assert headers == ["Content-Type: application/json", "X-Webhook-Token: test-token"], argv
    assert "--data" in argv, argv


def test_an_unchanged_run_is_posted_as_ready_and_its_counts_reach_the_queue(drain_one) -> None:
    """A run that deferred everything and wrote nothing still ends with a `ready` body
    that is POSTed as it is (the `converting` signal before it set the dataset
    pending), and its pending and not-attempted counts go to `qpy done` so the queue
    re-queues it at the shortest delay without spending a retry round."""
    go, posts, qpy_calls = drain_one
    done = go(UNCHANGED_BODY)
    assert done.returncode == 0, done.stderr
    calls = posts()
    assert [c["payload"] for c in calls] == [
        {"dataset_id": "nm000276", "status": "converting"},
        UNCHANGED_BODY,
    ]
    for call in calls:
        assert_webhook_post(call)
    done_calls = [c for c in qpy_calls() if " done " in f" {c} "]
    assert len(done_calls) == 1, qpy_calls()
    # Each flag gets its own count: pending 28, of which 25 were never attempted.
    assert done_calls[0].endswith("done nm000276 v1 --pending-count 28 --not-attempted-count 25")
    assert "RETRYABLE reason" not in done.stdout + done.stderr


def test_a_run_with_retryable_failures_says_so_once(drain_one) -> None:
    go, _, _ = drain_one
    done = go({**UNCHANGED_BODY, "retryable_failures": 3})
    assert done.returncode == 0, done.stderr
    assert done.stderr.count("3 recording(s) failed for a RETRYABLE reason") == 1


def test_a_pending_bump_is_re_raised_as_its_own_error_line(ack_run) -> None:
    """reconcile's output is captured by a command substitution, so its
    pending-ack notice would otherwise reach the log only as part of one
    summary line. A bump waiting on a human must not be something you find by
    reading to the end of it."""
    run, qpy_calls, ack_file, _ = ack_run

    result = run(reconcile_out="queued=0 ENGINE BUMP PENDING ACK (312 rows)")
    assert result.returncode == 0, result.stderr
    assert "--engine-requeue-ack" not in " ".join(qpy_calls())
    assert "waiting for acknowledgment" in result.stderr
    # And it names both halves of the procedure.
    assert "--preview-engine-bump" in result.stderr
    assert str(ack_file) in result.stderr


def test_the_env_var_form_arms_a_run_without_touching_the_file(ack_run) -> None:
    """ZARR_ENGINE_BUMP_ACK is the one-off form. It must not create or consume
    the file: an operator using it once should not silently disarm a pending
    file-based ack, or leave one behind that arms the next cron tick."""
    run, qpy_calls, ack_file, _ = ack_run

    result = run(extra_env={"ZARR_ENGINE_BUMP_ACK": "1"})
    assert result.returncode == 0, result.stderr
    reconciles = [c for c in qpy_calls() if "reconcile" in c]
    assert "--engine-requeue-ack" in reconciles[0]
    assert "ZARR_ENGINE_BUMP_ACK" in result.stdout + result.stderr
    # No file was created, and none was needed.
    assert not ack_file.exists()


# -- the drain on the driver's subject-information refusal (#1626) --

TWO_QUEUED = "nm000901\tv1.0.0;nm000902\tv1.0.0"


def test_a_subject_info_refusal_stops_the_drain_and_fails_nothing(ack_run) -> None:
    """generate_zarr.py exits 78 when this node's biosigIO cannot leave subject
    information out of a store. That is the node, not the dataset: handled as
    an ordinary failure it would spend a retry attempt of every queued row in
    turn and leave the whole queue `failed` after a few ticks. The drain stops
    on the first one, non-zero, and claims nothing behind it."""
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(extra_env={"QPY_NEXT": TWO_QUEUED, "FAKE_DRIVER_RC": "78"})

    assert proc.returncode == 78, proc.stdout + proc.stderr
    assert "FATAL" in proc.stderr
    assert "cannot leave subject information out of a store" in proc.stderr
    assert len(_calls_for(qpy_calls, "next")) == 1, qpy_calls()
    assert [c for c in qpy_calls() if c.startswith("DRIVER ")] != []
    assert _calls_for(qpy_calls, "fail") == [], "no retry attempt may be spent"
    assert _calls_for(qpy_calls, "done") == []


def test_a_refusal_still_posts_the_drivers_callback(ack_run, tmp_path: Path) -> None:
    """Deliberate: the `converting` POST at the start of the attempt already set
    the dataset's zarr_status to pending and cleared its failure detail, so
    skipping the refusal's callback would keep nothing and leave the dashboard
    showing a conversion in progress with nothing running (#774). The callback
    goes out on exit 78 as on any other outcome."""
    run, _qpy_calls, _ack_file, _log = ack_run
    curl_log = tmp_path / "curl.log"
    _write_exec(tmp_path / "fakebin" / "curl",
                '#!/bin/sh\necho "$@" >> "$CURL_LOG"\nexit 0\n')

    proc = run(extra_env={
        "QPY_NEXT": "nm000901\tv1.0.0", "FAKE_DRIVER_RC": "78",
        "FAKE_DRIVER_CALLBACK": '{"dataset_id": "nm000901", "status": "failed"}',
        "NEMAR_WEBHOOK_TOKEN": "test-token", "CURL_LOG": str(curl_log),
    })

    assert proc.returncode == 78, proc.stdout + proc.stderr
    calls = curl_log.read_text().splitlines()
    assert any('"status":"converting"' in c for c in calls), calls
    assert any("--data @" in c and c.rstrip().endswith(".callback.json") for c in calls), calls
    assert "zarr_status in D1 reads failed" in proc.stderr


def test_an_ordinary_driver_failure_still_fails_the_row_and_drains_on(ack_run) -> None:
    """The control: any other non-zero exit is the dataset's, takes the queue's
    bounded backoff (`qpy fail`), and the drain moves on to the next row."""
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(extra_env={"QPY_NEXT": TWO_QUEUED, "FAKE_DRIVER_RC": "1"})

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "cannot leave subject information" not in proc.stderr
    assert len(_calls_for(qpy_calls, "next")) == 3, qpy_calls()  # two rows, then empty
    assert len(_calls_for(qpy_calls, "fail")) == 2, qpy_calls()


def test_a_one_off_run_reports_the_refusal_and_keeps_its_exit(ack_run) -> None:
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(
        args=["--dataset", "nm000901"],
        # A closed port, so the version lookup fails fast instead of reaching
        # the real API; the driver stand-in does not read it.
        extra_env={"FAKE_DRIVER_RC": "78", "API_BASE": "http://127.0.0.1:9"},
    )

    assert proc.returncode == 78, proc.stdout + proc.stderr
    assert "FATAL" in proc.stderr
    assert "cannot leave subject information out of a store" in proc.stderr
    assert _calls_for(qpy_calls, "fail") == []


def test_the_refusal_exit_is_the_drivers() -> None:
    """hallu-zarr.sh and generate_zarr.py spell the refusal's exit code twice;
    a change to one alone would make the drain fail every queued row again."""
    sys.path.insert(0, str(SCRIPT.parent))
    try:
        import generate_zarr  # type: ignore[import-not-found]
    finally:
        sys.path.pop(0)
    shell = _script_assignment("DRIVER_EXIT_SUBJECT_INFO_UNAVAILABLE")
    assert int(shell) == generate_zarr.EXIT_SUBJECT_INFO_UNAVAILABLE == 78


# -- setup(): the installed biosigIO must be AT the floor, not merely importable --


@pytest.mark.parametrize("packaging_importable", [True, False], ids=["packaging", "tuple"])
@pytest.mark.parametrize("stale", ["1.2.10", "1.2.9", "1.2.8", "1.2.0", "0.9.9"])
def test_setup_refuses_a_biosigio_below_the_floor(
    ack_run, stale: str, packaging_importable: bool
) -> None:
    """The install line ends `| tail -2 || true` and `tail` exits 0 whatever uv
    did, so a failed upgrade leaves the venv on its old wheel, which still
    imports. On 1.2.8 a streaming EDF with repeated labels publishes, and the
    converter's header gate cannot catch it (every channel is present, only the
    names collapse), so setup has to stop the run before it converts anything.
    On 1.2.10 no writer can leave subject information out of a store, and the
    converter refuses every dataset (#1626). Both comparison paths are driven:
    `packaging` when the venv has it, the numeric-tuple fallback when it does
    not. "1.2.9" is the case a string comparison gets wrong against the 1.2.11
    floor: as strings it sorts above."""
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(biosigio_version=stale, packaging_importable=packaging_importable)

    assert proc.returncode != 0, proc.stdout
    assert "FATAL" in proc.stderr
    assert stale in proc.stderr
    assert "1.2.11 floor" in proc.stderr
    assert qpy_calls() == [], "setup must stop before the queue is touched"


@pytest.mark.parametrize("packaging_importable", [True, False], ids=["packaging", "tuple"])
@pytest.mark.parametrize("version", ["1.2.11", "1.2.11.post1", "1.2.11+local.1"])
def test_setup_accepts_a_final_biosigio_between_the_floor_and_the_cap(
    ack_run, version: str, packaging_importable: bool
) -> None:
    """Compared AS versions: as strings "1.2.11" sorts below "1.2.9", which
    would refuse a node that is at the floor. A post release and a local label
    satisfy `>=1.2.11,<1.2.12` for the resolver, so they satisfy the check."""
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(biosigio_version=version, packaging_importable=packaging_importable)

    assert proc.returncode == 0, proc.stderr
    assert f"[setup] biosigio {version}" in proc.stdout
    assert any("reconcile" in c for c in qpy_calls()), qpy_calls()


@pytest.mark.parametrize("packaging_importable", [True, False], ids=["packaging", "tuple"])
@pytest.mark.parametrize("version", ["1.2.12", "1.2.12.post1", "1.10.0", "2.0.0"])
def test_setup_refuses_a_biosigio_at_or_above_the_cap(
    ack_run, version: str, packaging_importable: bool
) -> None:
    """The pin is `<1.2.12` because a biosigIO release is read before the
    converter takes it. An install that went wrong (a resolver conflict, a
    venv someone upgraded by hand) can leave a newer one behind, and the
    install line hides it (`| tail -2 || true`), so setup refuses it. "1.10.0"
    is the case a string comparison gets wrong: as strings it sorts below."""
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(biosigio_version=version, packaging_importable=packaging_importable)

    assert proc.returncode != 0, proc.stdout
    assert "FATAL" in proc.stderr
    assert version in proc.stderr
    assert "1.2.12 cap" in proc.stderr
    assert qpy_calls() == [], "setup must stop before the queue is touched"


@pytest.mark.parametrize("packaging_importable", [True, False], ids=["packaging", "tuple"])
@pytest.mark.parametrize(
    "version", ["1.2.11rc1", "1.2.11.dev0", "1.2.11a1", "1.2.12.dev0", "1.2.11.post1.dev0"]
)
def test_setup_refuses_a_pre_release_on_both_paths(
    ack_run, version: str, packaging_importable: bool
) -> None:
    """`1.2.11rc1` and `1.2.11.dev0` sort BELOW 1.2.11, and a tuple of leading
    digits reads both as (1, 2, 11) and would accept them: the two paths used to
    disagree. Both now refuse every pre-release and dev build."""
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(biosigio_version=version, packaging_importable=packaging_importable)

    assert proc.returncode != 0, proc.stdout
    assert "FATAL" in proc.stderr
    assert version in proc.stderr
    assert "pre-release" in proc.stderr
    assert qpy_calls() == []


@pytest.mark.parametrize("packaging_importable", [True, False], ids=["packaging", "tuple"])
def test_setup_fails_closed_on_a_version_it_cannot_read(
    ack_run, packaging_importable: bool
) -> None:
    run, qpy_calls, _ack_file, _log = ack_run

    proc = run(biosigio_version="not-a-version", packaging_importable=packaging_importable)

    assert proc.returncode != 0, proc.stdout
    assert "FATAL" in proc.stderr
    assert qpy_calls() == []


def test_the_floor_variable_is_the_floor_of_the_spec() -> None:
    """`BIOSIGIO_FLOOR` (what setup() checks) and the `>=` half of
    `BIOSIGIO_SPEC` (what setup() installs) are two spellings of one number, and
    a bump that changes only one leaves a check that either refuses a good node
    or waves a stale one through."""
    text = SCRIPT.read_text()
    floor = next(
        line.split("=", 1)[1].strip('"')
        for line in text.splitlines()
        if line.startswith("BIOSIGIO_FLOOR=")
    )
    spec = next(
        line.split(":-", 1)[1].rstrip('}"')
        for line in text.splitlines()
        if line.startswith("BIOSIGIO_SPEC=")
    )
    assert f">={floor}," in spec + ",", f"floor {floor!r} is not the >= bound of {spec!r}"


def _script_assignment(name: str) -> str:
    text = SCRIPT.read_text()
    return next(
        line.split("=", 1)[1].strip('"')
        for line in text.splitlines()
        if line.startswith(f"{name}=")
    )


def test_the_cap_variable_is_the_cap_of_the_spec() -> None:
    """`BIOSIGIO_CAP` (what setup() refuses at or above) and the `<` half of
    `BIOSIGIO_SPEC` are one number: a bump that raised only the spec would
    install the new release and then refuse to run on it."""
    cap = _script_assignment("BIOSIGIO_CAP")
    spec = _script_assignment("BIOSIGIO_SPEC").split(":-", 1)[1].rstrip('}"')
    assert spec.endswith(f",<{cap}"), f"cap {cap!r} is not the < bound of {spec!r}"


def _floor_probe() -> str:
    """The probe exactly as setup() runs it: the body of the single-quoted
    `BIOSIGIO_FLOOR_PROBE='...'` assignment, which bash passes through as is."""
    text = SCRIPT.read_text()
    start = text.index("BIOSIGIO_FLOOR_PROBE='") + len("BIOSIGIO_FLOOR_PROBE='")
    return text[start : text.index("\n'\n", start)]


def _run_probe(tmp_path: Path, version: str, packaging_importable: bool) -> int:
    """The probe under THIS interpreter (no bash involved, so it runs on any
    host), with a `biosigio` that is only a version and, for the fallback,
    a `packaging` that fails to import."""
    stubs = tmp_path / f"stubs-{packaging_importable}"
    shutil.rmtree(stubs, ignore_errors=True)
    (stubs / "biosigio").mkdir(parents=True)
    (stubs / "biosigio" / "__init__.py").write_text(f'__version__ = "{version}"\n')
    if not packaging_importable:
        (stubs / "packaging").mkdir()
        (stubs / "packaging" / "__init__.py").write_text('raise ImportError("absent")\n')
    proc = subprocess.run(
        [sys.executable, "-c", _floor_probe(),
         _script_assignment("BIOSIGIO_FLOOR"), _script_assignment("BIOSIGIO_CAP")],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": str(stubs)},
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert proc.stdout.strip() == version, proc.stderr
    return proc.returncode


# The probe's verdict per version, which BOTH comparison paths must reach:
# 0 in range, 3 below the floor or unreadable, 4 at or above the cap, 5 a
# pre-release or dev build.
PROBE_VERDICTS = {
    "1.2.11": 0, "1.2.11.0": 0, "1.2.11.post1": 0, "1.2.11+local.1": 0,
    "1.2.10": 3, "1.2.10.post1": 3, "1.2.9": 3, "1.2.8": 3, "0.9.9": 3, "not-a-version": 3,
    "1.2.12": 4, "1.2.12.0": 4, "1.2.12.post1": 4, "1.10.0": 4, "2.0.0": 4,
    "1.2.11rc1": 5, "1.2.11.dev0": 5, "1.2.11a1": 5, "1.2.11b2": 5,
    "1.2.12.dev0": 5, "1.2.12rc1": 5, "1.2.11.post1.dev0": 5, "1.2.10rc1": 5,
}


@pytest.mark.parametrize("packaging_importable", [True, False], ids=["packaging", "tuple"])
@pytest.mark.parametrize("version", sorted(PROBE_VERDICTS))
def test_both_probe_paths_reach_the_same_verdict(
    tmp_path: Path, version: str, packaging_importable: bool
) -> None:
    if packaging_importable:
        pytest.importorskip("packaging")
    assert _run_probe(tmp_path, version, packaging_importable) == PROBE_VERDICTS[version]


@pytest.mark.parametrize("version", sorted(PROBE_VERDICTS))
def test_the_driver_floor_agrees_with_the_setup_probe(version: str) -> None:
    """setup()'s probe and generate_zarr.py's `final_release` read a version
    twice, in two languages' worth of code. Wherever the probe lets a version
    through the floor (in range, or above the cap), the driver must accept it
    too, and wherever the probe refuses it as below the floor, unreadable or a
    pre-release, the driver must refuse it as well."""
    sys.path.insert(0, str(SCRIPT.parent))
    try:
        import generate_zarr  # type: ignore[import-not-found]
    finally:
        sys.path.pop(0)
    release = generate_zarr.final_release(version)
    floor = generate_zarr.final_release(generate_zarr.SUBJECT_INFO_FLOOR)
    driver_accepts = release is not None and floor is not None and release >= floor
    assert driver_accepts == (PROBE_VERDICTS[version] in (0, 4)), version
    # And the node's floor never admits a biosigIO the driver then refuses.
    node_floor = generate_zarr.final_release(_script_assignment("BIOSIGIO_FLOOR"))
    assert node_floor is not None and floor is not None and node_floor >= floor


def _calls_for(qpy_calls, subcommand: str) -> list[str]:
    # A recorded call is `<zarr_queue.py> --db <path> <subcommand> ...`.
    return [c for c in qpy_calls() if subcommand in c.split()]


def test_test_mode_passes_accept_exemplars_to_reconcile(ack_run) -> None:
    """The staging catalog is the xx0999NN exemplar fleet, which reconcile's
    production id filter rejects. `--test` has to hand reconcile
    `--accept-exemplars` or the nightly run reports `rejected=7` and converts
    nothing -- which is what it did for a day (2026-09-03). Asserted on the
    argv the real script builds, not on --print-config, so a later edit that
    drops the flag from `reconcile_args` fails here."""
    run, qpy_calls, _ack_file, _log = ack_run
    proc = run(args=["--test"])
    assert proc.returncode == 0, proc.stderr
    calls = _calls_for(qpy_calls, "reconcile")
    assert len(calls) == 1, qpy_calls()
    assert "--accept-exemplars" in calls[0].split()
    assert "--api-base https://api-test.nemar.org" in calls[0]


def test_plain_run_never_passes_accept_exemplars(ack_run) -> None:
    """Production reconcile must not admit the xx band: no flag without --test."""
    run, qpy_calls, _ack_file, _log = ack_run
    proc = run()
    assert proc.returncode == 0, proc.stderr
    calls = _calls_for(qpy_calls, "reconcile")
    assert len(calls) == 1, qpy_calls()
    assert "--accept-exemplars" not in calls[0].split()


def test_backfill_sweep_gets_accept_exemplars_only_under_test(ack_run) -> None:
    """`--backfill-dir-formats` walks the catalog with the same id filter as
    reconcile, so the staging profile has to opt it in the same way. This is
    the exact class of gap the review of #1211 found (the flag reaching one
    catalog walk and not the other), asserted on the recorded argv for both
    the --test and the plain invocation."""
    run, qpy_calls, _ack_file, _log = ack_run
    proc = run(args=["--test", "--backfill-dir-formats"])
    assert proc.returncode == 0, proc.stderr
    calls = _calls_for(qpy_calls, "backfill-dir-formats")
    assert len(calls) == 1, qpy_calls()
    assert "--accept-exemplars" in calls[0].split()
    assert "--api-base https://api-test.nemar.org" in calls[0]

    proc = run(args=["--backfill-dir-formats"])
    assert proc.returncode == 0, proc.stderr
    calls = _calls_for(qpy_calls, "backfill-dir-formats")
    assert len(calls) == 2, qpy_calls()
    assert "--accept-exemplars" not in calls[1].split()
    assert "--api-base https://api.nemar.org" in calls[1]



# -- convert_dataset: which runs ask the driver for a pending-only retry (#1483) --


def _function_source(name: str) -> str:
    """The text of one shell function in hallu-zarr.sh, from `name() {` to the
    `}` that closes it at column 0."""
    lines = SCRIPT.read_text().splitlines()
    start = lines.index(f"{name}() {{")
    end = next(i for i in range(start + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[start : end + 1])


def _driver_argv(tmp_path: Path, *call_args: str) -> list[str]:
    """Run the REAL `convert_dataset` under the script's own `set -uo pipefail`
    and return the argv it gave the driver.

    Everything around it is a stand-in: the driver is a real executable that
    records its arguments and writes the callback the function then reads, and
    `nemar`/`log`/`err`/`safe_rm` are shell functions. The function body itself,
    including the empty-array expansion that has to survive `set -u`, is the
    script's, extracted verbatim.
    """
    record = tmp_path / "argv.txt"
    venv = tmp_path / "venv"
    (venv / "bin").mkdir(parents=True)
    python = venv / "bin" / "python"
    python.write_text(
        "#!/bin/sh\n"
        f'printf "%s\\n" "$@" > {shlex.quote(str(record))}\n'
        'while [ "$#" -gt 0 ]; do\n'
        '  if [ "$1" = "--callback-out" ]; then echo "{}" > "$2"; fi\n'
        "  shift\n"
        "done\n"
    )
    python.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    harness = "\n".join(
        [
            "set -uo pipefail",
            f"WORK_DIR={shlex.quote(str(work))}",
            f"LOG_FILE={shlex.quote(str(tmp_path / 'log.txt'))}",
            f"VENV_DIR={shlex.quote(str(venv))}",
            "DRIVER=generate_zarr.py S3_BUCKET=nemar AWS_REGION=us-east-2",
            "CONTRACT_BASE=https://data.example CALLBACK_URL= NEMAR_WEBHOOK_TOKEN=",
            "API_BASE=https://api.example JOBS=2",
            "log() { :; }; err() { :; }",
            'safe_rm() { rm -rf "$1"; }',
            'nemar() { mkdir -p "${@: -1}"; }',
            'DRIVER_PID=""; STOP_REQUESTED=""; heartbeat_start() { :; }; heartbeat_stop() { :; }',
            _function_source("convert_dataset"),
            "convert_dataset " + " ".join(shlex.quote(a) for a in call_args),
        ]
    )
    proc = subprocess.run(
        ["bash", "-c", harness], capture_output=True, text=True, timeout=30, check=False
    )
    assert proc.returncode == 0, proc.stderr
    return record.read_text().splitlines()


def test_the_queue_drain_asks_for_a_pending_only_retry(tmp_path):
    argv = _driver_argv(tmp_path, "on008083", "v1.0.0", "retry-pending")
    assert "--retry-pending" in argv
    # Still a --clean run: the driver decides, and falls back to the full
    # rebuild whenever the published index is not current.
    assert "--clean" in argv


def test_a_one_off_run_is_always_a_full_rebuild(tmp_path):
    # No third argument, under `set -u`: the empty array must expand to nothing
    # rather than abort the function.
    argv = _driver_argv(tmp_path, "on008083", "v1.0.0")
    assert "--retry-pending" not in argv
    assert "--clean" in argv


def test_only_the_drain_loop_passes_the_retry_scope():
    calls = [
        line.strip()
        for line in SCRIPT.read_text().splitlines()
        if "convert_dataset_exclusive " in line and not line.lstrip().startswith("#")
    ]
    assert 'convert_dataset_exclusive "$id" "$version" retry-pending || driver_rc=$?' in calls
    assert 'convert_dataset_exclusive "$ONLY_DATASET" "$v" || only_rc=$?' in calls
    # ...and the lock wrapper is the only thing that calls convert_dataset itself.
    inner = [
        line.strip()
        for line in SCRIPT.read_text().splitlines()
        if line.strip().startswith('convert_dataset "') and not line.lstrip().startswith("#")
    ]
    assert inner == ['convert_dataset "$@"'], inner
    assert len(calls) == 2, calls


# -- the queue verdict for a failed conversion (annex_object_missing, PR #1563) --


def _failure_verdict(tmp_path: Path, callback: dict, rc: int = 1) -> list[str]:
    """Run the REAL `convert_dataset` and `record_conversion_failure`, in that
    order, over a driver that writes `callback` and exits `rc`, and return the
    argv each `qpy` call received (one line per call, arguments tab-joined).

    The driver, `qpy`, `nemar` and the logging helpers are stand-ins; the two
    functions, the jq reads of the callback, and the choice of queue call are the
    script's own, extracted verbatim.
    """
    record = tmp_path / "qpy.txt"
    cb_src = tmp_path / "callback.json"
    cb_src.write_text(json.dumps(callback))
    venv = tmp_path / "venv"
    (venv / "bin").mkdir(parents=True)
    python = venv / "bin" / "python"
    python.write_text(
        "#!/bin/sh\n"
        'while [ "$#" -gt 0 ]; do\n'
        f'  if [ "$1" = "--callback-out" ]; then cp {shlex.quote(str(cb_src))} "$2"; fi\n'
        "  shift\n"
        "done\n"
        f"exit {rc}\n"
    )
    python.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    harness = "\n".join(
        [
            "set -uo pipefail",
            f"WORK_DIR={shlex.quote(str(work))}",
            f"LOG_FILE={shlex.quote(str(tmp_path / 'log.txt'))}",
            f"VENV_DIR={shlex.quote(str(venv))}",
            "DRIVER=generate_zarr.py S3_BUCKET=nemar AWS_REGION=us-east-2",
            "CONTRACT_BASE=https://data.example CALLBACK_URL= NEMAR_WEBHOOK_TOKEN=",
            "API_BASE=https://api.example JOBS=2",
            "log() { :; }; err() { :; }",
            'safe_rm() { rm -rf "$1"; }',
            'nemar() { mkdir -p "${@: -1}"; }',
            f'qpy() {{ local IFS=$\'\\t\'; printf "%s\\n" "$*" >> {shlex.quote(str(record))}; }}',
            'DRIVER_PID=""; STOP_REQUESTED=""; heartbeat_start() { :; }; heartbeat_stop() { :; }',
            _function_source("convert_dataset"),
            _function_source("record_conversion_failure"),
            'convert_dataset nm000276 v1.0.0 retry-pending || record_conversion_failure nm000276',
        ]
    )
    proc = subprocess.run(
        ["bash", "-c", harness], capture_output=True, text=True, timeout=30, check=False
    )
    assert proc.returncode == 0, proc.stderr
    return record.read_text().splitlines() if record.exists() else []


_KEY = "SHA256E-s982--" + "ab" * 32 + ".vhdr"


def _missing(n: int, *, errors: int | None = None, deterministic: bool = False, **extra) -> dict:
    return {
        "dataset_id": "nm000276",
        "status": "failed",
        "errors": n if errors is None else errors,
        "deterministic": deterministic,
        "annex_missing_count": n,
        "annex_missing_first_path": "sub-01/eeg/sub-01_task-rest_eeg.vhdr",
        "annex_missing_first_key": _KEY,
        **extra,
    }


def test_every_recording_missing_its_object_is_a_retryable_fail(tmp_path):
    (call,) = _failure_verdict(tmp_path, _missing(3))
    argv = call.split("\t")
    assert argv[:2] == ["fail", "nm000276"]
    assert "--deterministic" not in argv, "must take the bounded backoff, not data_failed"
    message = argv[2]
    assert "storage lacks the annex object(s) of all 3 failed recording(s)" in message
    assert f"s3://nemar/nm000276/objects/{_KEY}" in message
    assert "--dataset nm000276 --requeue failed --execute" in message
    assert "fix the upload" in message


def test_a_deterministic_verdict_is_still_terminal(tmp_path):
    # A genuine data failure alongside missing objects: the driver says
    # deterministic, and that wins over the storage message.
    (call,) = _failure_verdict(tmp_path, _missing(1, errors=2, deterministic=True))
    argv = call.split("\t")
    assert argv[-1] == "--deterministic"
    assert "typed data failures" in argv[2]


def test_missing_objects_alongside_infra_failures_get_the_generic_message(tmp_path):
    (call,) = _failure_verdict(tmp_path, _missing(1, errors=2))
    argv = call.split("\t")
    assert "--deterministic" not in argv
    assert argv[2].startswith("conversion failed (see ")


def test_a_producer_error_is_not_blamed_on_storage(tmp_path):
    (call,) = _failure_verdict(tmp_path, _missing(2, error="index failed schema validation"))
    assert call.split("\t")[2].startswith("conversion failed (see ")


def test_a_run_without_a_callback_gets_the_generic_retryable_fail(tmp_path):
    # A crashed driver writes nothing; the verdict must not inherit anything.
    (call,) = _failure_verdict(tmp_path, {"dataset_id": "nm000276", "status": "failed"})
    argv = call.split("\t")
    assert "--deterministic" not in argv
    assert argv[2].startswith("conversion failed (see ")


def test_the_drain_loop_routes_every_failure_through_the_verdict():
    text = SCRIPT.read_text()
    drain = text[text.index('convert_dataset_exclusive "$id" "$version" retry-pending || driver_rc=$?') :]
    drain = drain[: drain.index("n=$((n + 1))")]
    assert 'record_conversion_failure "$id"' in drain
    assert "qpy fail" not in drain


# ---------------------------------------------------------------------------
# Slots (ADR 0101): several drains side by side, each with its own lock
# ---------------------------------------------------------------------------


def _config(dirs: tuple[Path, Path], *args: str, env: dict[str, str] | None = None) -> dict[str, str]:
    zarr_base, home = dirs
    proc = run_script([*args, "--print-config"], zarr_base, home, env)
    assert proc.returncode == 0, proc.stderr
    return parse_config(proc.stdout)


def test_four_slots_of_four_workers_are_the_default(dirs: tuple[Path, Path]) -> None:
    cfg = _config(dirs)
    assert cfg["SLOTS"] == "4"
    assert cfg["JOBS"] == "4"
    assert cfg["SLOT"] == ""


def test_zarr_jobs_lowers_the_per_slot_workers_but_never_raises_them(
    dirs: tuple[Path, Path],
) -> None:
    # The crontab of the single-drain days says ZARR_JOBS=24; four slots of 24 is not
    # what anyone meant by it.
    assert _config(dirs, env={"ZARR_JOBS": "24"})["JOBS"] == "4"
    assert _config(dirs, env={"ZARR_JOBS": "2"})["JOBS"] == "2"
    assert _config(dirs, env={"ZARR_JOBS_PER_SLOT": "3", "ZARR_JOBS": "24"})["JOBS"] == "3"
    assert _config(dirs, env={"ZARR_JOBS_PER_SLOT": "6", "ZARR_JOBS": "24"})["JOBS"] == "6"
    assert _config(dirs, env={"ZARR_JOBS_PER_SLOT": "6", "ZARR_JOBS": "2"})["JOBS"] == "2"


def test_one_slot_keeps_zarr_jobs_as_the_worker_count(dirs: tuple[Path, Path]) -> None:
    cfg = _config(dirs, env={"ZARR_SLOTS": "1", "ZARR_JOBS": "24"})
    assert cfg["SLOTS"] == "1"
    assert cfg["JOBS"] == "24"


@pytest.mark.parametrize("value", ["0", "17", "two", "-1", "2.5"])
def test_a_bad_slot_count_stops_the_script(dirs: tuple[Path, Path], value: str) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home, {"ZARR_SLOTS": value})
    assert proc.returncode == 1
    assert "ZARR_SLOTS must be an integer from 1 to 16" in proc.stderr
    assert proc.stdout == ""


@pytest.mark.parametrize("value", ["4", "x", "-1"])
def test_a_slot_outside_the_slot_count_stops_the_script(
    dirs: tuple[Path, Path], value: str
) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home, {"ZARR_SLOT": value})
    assert proc.returncode == 1
    assert "ZARR_SLOT must be an integer from 0 to 3" in proc.stderr


def test_slot_zero_keeps_the_names_the_single_drain_always_had(
    dirs: tuple[Path, Path],
) -> None:
    zarr_base, _ = dirs
    plain = _config(dirs)
    zero = _config(dirs, env={"ZARR_SLOT": "0"})
    for key in ("WORK_DIR", "LOCK_FILE", "LOG_FILE"):
        assert zero[key] == plain[key]
    assert plain["WORK_DIR"] == f"{zarr_base}/zarr-scratch"
    assert plain["LOCK_FILE"] == f"{zarr_base}/zarr-state/.nm-zarr.lock"
    assert plain["LOG_FILE"] == f"{zarr_base}/zarr-state/.nm-zarr.log"


def test_a_later_slot_has_a_lock_scratch_directory_and_log_of_its_own(
    dirs: tuple[Path, Path],
) -> None:
    zarr_base, _ = dirs
    cfg = _config(dirs, env={"ZARR_SLOT": "2"})
    assert cfg["SLOT"] == "2"
    assert cfg["WORK_DIR"] == f"{zarr_base}/zarr-scratch-slot2"
    assert cfg["LOCK_FILE"] == f"{zarr_base}/zarr-state/.nm-zarr.slot2.lock"
    assert cfg["LOG_FILE"] == f"{zarr_base}/zarr-state/.nm-zarr.slot2.log"
    # The queue, the clone and the venv are what the slots share.
    assert cfg["QUEUE_DB"] == f"{zarr_base}/zarr-state/zarr-queue.db"
    assert cfg["DRIVER_REPO"] == f"{zarr_base}/zarr-state/nemar-cli"


def test_the_staging_run_is_one_slot_that_shares_the_nodes_ledger(
    dirs: tuple[Path, Path],
) -> None:
    zarr_base, _ = dirs
    staging = _config(dirs, "--test")
    production = _config(dirs)
    assert staging["SLOTS"] == "1"
    assert staging["LEDGER_DIR"] == production["LEDGER_DIR"] == f"{zarr_base}/zarr-admission-ledger"
    assert _config(dirs, env={"ZARR_LEDGER_DIR": "/x/ledger"})["LEDGER_DIR"] == "/x/ledger"


def test_print_config_for_a_slot_creates_no_files(dirs: tuple[Path, Path]) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home, {"ZARR_SLOT": "3"})
    assert proc.returncode == 0, proc.stderr
    assert tree_entries(zarr_base) == []


def _hold(lock: Path) -> subprocess.Popen[str]:
    """A process that holds ``lock`` the way a running drain does."""
    code = (
        "import fcntl, sys, time\n"
        "fh = open(sys.argv[1], 'w')\n"
        "fcntl.flock(fh, fcntl.LOCK_EX)\n"
        "print('held', flush=True)\n"
        "time.sleep(120)\n"
    )
    lock.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [sys.executable, "-c", code, str(lock)], stdout=subprocess.PIPE, text=True
    )
    assert proc.stdout is not None and proc.stdout.readline().strip() == "held"
    return proc


@pytest.fixture
def holders():
    held: list[subprocess.Popen[str]] = []
    yield held
    for proc in held:
        proc.kill()
        proc.wait()


def _reconciles(qpy_calls) -> int:
    return sum(1 for c in qpy_calls() if "reconcile" in c.split())


def _heartbeats(qpy_calls) -> list[str]:
    # By word: the temporary directory of a test is part of every call's path.
    return [c for c in qpy_calls() if "heartbeat" in c.split()]


def test_a_tick_starts_one_drain_in_every_free_slot(ack_run) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    state = ack_file.parent
    proc = run(extra_env={"ZARR_SLOTS": "3"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _reconciles(qpy_calls) == 3
    for k in range(3):
        assert f"starting slot {k} (of 3)" in proc.stdout
    assert (state.parent / "zarr-scratch").is_dir()
    assert (state.parent / "zarr-scratch-slot1").is_dir()
    assert (state.parent / "zarr-scratch-slot2").is_dir()
    for k in (1, 2):
        text = (state / f".nm-zarr.slot{k}.log").read_text()
        assert f"[slot {k}]" in text and "run complete" in text


def test_a_slot_that_is_already_draining_is_left_alone(ack_run, holders) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    state = ack_file.parent
    holders.append(_hold(state / ".nm-zarr.slot1.lock"))
    proc = run(extra_env={"ZARR_SLOTS": "3"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _reconciles(qpy_calls) == 2
    assert "starting slot 1" not in proc.stdout
    assert not (state.parent / "zarr-scratch-slot1").exists()


def test_slot_zero_holds_the_lock_a_single_drain_always_took(ack_run, holders) -> None:
    # A drain started before this change holds .nm-zarr.lock; the new tick must treat
    # that as slot 0 being busy rather than start a second drain on it.
    run, qpy_calls, ack_file, _ = ack_run
    holders.append(_hold(ack_file.parent / ".nm-zarr.lock"))
    proc = run(extra_env={"ZARR_SLOTS": "2"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _reconciles(qpy_calls) == 1
    assert "starting slot 0" not in proc.stdout
    assert "starting slot 1 (of 2)" in proc.stdout


def test_a_tick_with_every_slot_busy_exits_3_and_touches_nothing(ack_run, holders) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    state = ack_file.parent
    holders.append(_hold(state / ".nm-zarr.lock"))
    holders.append(_hold(state / ".nm-zarr.slot1.lock"))
    proc = run(extra_env={"ZARR_SLOTS": "2"})
    assert proc.returncode == 3
    assert "all 2 slot(s) are busy" in proc.stdout
    assert qpy_calls() == []


def test_a_named_slot_that_is_busy_exits_3(ack_run, holders) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    holders.append(_hold(ack_file.parent / ".nm-zarr.slot2.lock"))
    proc = run(extra_env={"ZARR_SLOTS": "3", "ZARR_SLOT": "2"})
    assert proc.returncode == 3
    assert "this slot is already running" in proc.stdout
    assert qpy_calls() == []


def test_a_one_off_dataset_takes_the_first_free_slot(ack_run, holders) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    state = ack_file.parent
    holders.append(_hold(state / ".nm-zarr.lock"))
    proc = run(
        args=["--dataset", "nm000276"],
        extra_env={"ZARR_SLOTS": "3", "API_BASE": "http://127.0.0.1:9"},
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    driver = [c for c in qpy_calls() if c.startswith("DRIVER")]
    assert len(driver) == 1
    assert f"{state.parent}/zarr-scratch-slot1/nm000276" in driver[0]
    assert "[slot 1]" in proc.stdout


def test_a_one_off_dataset_with_every_slot_busy_says_so_and_runs_nothing(
    ack_run, holders
) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    state = ack_file.parent
    holders.append(_hold(state / ".nm-zarr.lock"))
    holders.append(_hold(state / ".nm-zarr.slot1.lock"))
    proc = run(
        args=["--dataset", "nm000276"],
        extra_env={"ZARR_SLOTS": "2", "API_BASE": "http://127.0.0.1:9"},
    )
    assert proc.returncode == 3
    assert "all 2 slot(s) are busy; not starting nm000276" in proc.stderr
    assert [c for c in qpy_calls() if c.startswith("DRIVER")] == []


def test_arguments_reach_the_drains_a_tick_starts(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    rows = "nm000001\tv1;nm000002\tv1;nm000003\tv1"
    proc = run(args=["--limit", "1"], extra_env={"ZARR_SLOTS": "2", "QPY_NEXT": rows})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # Each slot is told --limit 1 and stops after one dataset: two drivers, not three.
    assert len([c for c in qpy_calls() if c.startswith("DRIVER")]) == 2


def test_without_a_limit_the_slots_between_them_take_the_whole_queue(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    rows = "nm000001\tv1;nm000002\tv1;nm000003\tv1"
    proc = run(extra_env={"ZARR_SLOTS": "2", "QPY_NEXT": rows})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    drivers = [c for c in qpy_calls() if c.startswith("DRIVER")]
    assert len(drivers) == 3
    # Each dataset was handed to exactly one slot.
    assert sorted(re.search(r"--dataset-id (\S+)", c).group(1) for c in drivers) == [
        "nm000001", "nm000002", "nm000003",
    ]


def test_the_driver_gets_the_per_slot_worker_count(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    proc = run(extra_env={"ZARR_SLOTS": "2", "ZARR_JOBS": "24", "QPY_NEXT": "nm000001\tv1"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    driver = [c for c in qpy_calls() if c.startswith("DRIVER")]
    assert len(driver) == 1
    assert "--jobs 4" in driver[0]


def test_the_driver_inherits_the_node_ledger_directory(ack_run) -> None:
    """Exported, not merely set: --print-config prints a shell variable and cannot
    tell the difference, and without the export the ledger is silently off."""
    run, _, ack_file, qpy_log = ack_run
    zarr_base = ack_file.parent.parent
    proc = run(extra_env={"ZARR_SLOTS": "2", "QPY_NEXT": "nm000001\tv1"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    recorded = Path(str(qpy_log) + ".env").read_text().splitlines()
    assert recorded == [f"ZARR_LEDGER_DIR={zarr_base}/zarr-admission-ledger"]
    other = run(
        # The first row is already claimed by the run above, so this one gets the second.
        extra_env={
            "ZARR_SLOTS": "1",
            "QPY_NEXT": "nm000001\tv1;nm000002\tv1",
            "ZARR_LEDGER_DIR": "/x/ledger",
        }
    )
    assert other.returncode == 0, other.stdout + other.stderr
    assert Path(str(qpy_log) + ".env").read_text().splitlines()[-1] == "ZARR_LEDGER_DIR=/x/ledger"


def test_only_one_slot_updates_the_clone_at_a_time(ack_run, holders) -> None:
    """setup() rewrites the shared clone and venv; a second slot must wait for the
    first rather than run git and the installer over it."""
    import time

    run, qpy_calls, ack_file, _ = ack_run
    lock = _hold(ack_file.parent / ".nm-zarr.setup.lock")
    holders.append(lock)
    proc = run(extra_env={"ZARR_SLOTS": "2", "ZARR_SLOT": "0"}, background=True)
    try:
        time.sleep(2.0)
        assert proc.poll() is None, "it did not wait for the setup lock"
        assert qpy_calls() == []  # nothing past setup has run
        lock.kill()
        lock.wait()
        _wait_until(lambda: proc.poll() is not None, "the slot to proceed", 20)
        assert proc.returncode == 0
        assert any("reconcile" in c.split() for c in qpy_calls())
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_the_queue_hears_a_heartbeat_while_a_dataset_converts(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    proc = run(
        extra_env={
            "QPY_NEXT": "nm000276\tv1",
            "ZARR_HEARTBEAT_SECONDS": "1",
            "FAKE_DRIVER_SLEEP": "3.5",
        }
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    beats = _heartbeats(qpy_calls)
    assert 2 <= len(beats) <= 4, qpy_calls()
    assert all(c.endswith("heartbeat nm000276") for c in beats)
    calls = qpy_calls()
    last_beat = max(i for i, c in enumerate(calls) if c == beats[-1])
    assert last_beat < max(i for i, c in enumerate(calls) if " done " in c)


def test_no_heartbeat_is_sent_outside_a_conversion(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    proc = run(extra_env={"ZARR_HEARTBEAT_SECONDS": "1"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _heartbeats(qpy_calls) == []


def test_a_dataset_the_queue_took_back_is_reported(ack_run) -> None:
    run, _, _, _ = ack_run
    proc = run(
        extra_env={
            "QPY_NEXT": "nm000276\tv1",
            "ZARR_HEARTBEAT_SECONDS": "1",
            "FAKE_DRIVER_SLEEP": "2.5",
            "QPY_HEARTBEAT_OUT": "0",
        }
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "no longer lists this dataset as inprogress" in proc.stderr


def _driver_pids(qpy_log: Path) -> list[int]:
    path = Path(str(qpy_log) + ".pids")
    return [int(x) for x in path.read_text().split()] if path.exists() else []


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_until(predicate, what: str, seconds: float = 20.0) -> None:
    import time

    deadline = time.monotonic() + seconds
    while not predicate():
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        time.sleep(0.05)


@pytest.fixture
def stray_drivers():
    """Fake drivers a test may leave running; killed afterwards."""
    pids: list[int] = []
    yield pids
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def test_the_heartbeat_follows_the_driver_not_the_script(ack_run, stray_drivers) -> None:
    """A script killed with SIGKILL leaves its driver converting, and the driver is
    what the queue row is for: the heartbeat goes on while the driver lives and stops
    when it ends, so the row neither looks abandoned early nor vouches for nothing."""
    import time

    run, qpy_calls, _, qpy_log = ack_run
    proc = run(
        extra_env={
            "QPY_NEXT": "nm000276\tv1",
            "ZARR_HEARTBEAT_SECONDS": "1",
            "FAKE_DRIVER_SLEEP": "6",
        },
        background=True,
    )
    try:
        _wait_until(lambda: _heartbeats(qpy_calls), "the first heartbeat")
        stray_drivers.extend(_driver_pids(qpy_log))
        proc.kill()  # SIGKILL: the script cannot clean up after itself
        proc.wait()
        seen = len(_heartbeats(qpy_calls))
        time.sleep(2.5)
        assert len(_heartbeats(qpy_calls)) > seen, "the heartbeat stopped with the script"
        _wait_until(lambda: not any(_alive(p) for p in stray_drivers), "the driver to end", 15)
        time.sleep(1.5)
        settled = len(_heartbeats(qpy_calls))
        time.sleep(2.5)
        assert len(_heartbeats(qpy_calls)) <= settled + 1, "it kept beating for a dead driver"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_a_signal_to_a_slot_stops_its_driver_and_spends_no_attempt(
    ack_run, stray_drivers, sig
) -> None:
    run, qpy_calls, _, qpy_log = ack_run
    proc = run(
        extra_env={
            "ZARR_SLOTS": "2",
            "ZARR_SLOT": "0",
            "QPY_NEXT": "nm000276\tv1",
            "FAKE_DRIVER_SLEEP": "60",
        },
        background=True,
    )
    try:
        _wait_until(lambda: _driver_pids(qpy_log), "the driver to start")
        drivers = _driver_pids(qpy_log)
        stray_drivers.extend(drivers)
        os.kill(proc.pid, sig)
        _wait_until(lambda: proc.poll() is not None, "the script to exit", 15)
        assert proc.returncode == 143
        _wait_until(lambda: not any(_alive(p) for p in drivers), "the driver to be stopped", 15)
        calls = qpy_calls()
        assert [c for c in calls if " fail " in c or c.split()[-3:-2] == ["fail"]] == []
        assert not any(" done " in c for c in calls)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_stopping_the_tick_stops_every_slots_driver(ack_run, stray_drivers) -> None:
    run, qpy_calls, _, qpy_log = ack_run
    proc = run(
        extra_env={
            "ZARR_SLOTS": "2",
            "QPY_NEXT": "nm000276\tv1;nm000277\tv1",
            "FAKE_DRIVER_SLEEP": "60",
        },
        background=True,
    )
    try:
        _wait_until(lambda: len(_driver_pids(qpy_log)) >= 2, "both slots' drivers to start")
        drivers = _driver_pids(qpy_log)
        stray_drivers.extend(drivers)
        os.kill(proc.pid, signal.SIGTERM)
        _wait_until(lambda: proc.poll() is not None, "the tick to exit", 20)
        _wait_until(lambda: not any(_alive(p) for p in drivers), "the drivers to be stopped", 20)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_a_one_off_run_sends_no_heartbeat(ack_run) -> None:
    run, qpy_calls, _, _ = ack_run
    proc = run(
        args=["--dataset", "nm000276"],
        extra_env={
            "API_BASE": "http://127.0.0.1:9",
            "ZARR_HEARTBEAT_SECONDS": "1",
            "FAKE_DRIVER_SLEEP": "2.5",
        },
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _heartbeats(qpy_calls) == []
    assert "inprogress" not in proc.stderr


def test_a_dataset_is_converted_by_one_run_at_a_time(ack_run, holders) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    state = ack_file.parent
    holders.append(_hold(state / "dataset-locks" / "nm000276.lock"))
    refused = run(
        args=["--dataset", "nm000276"],
        extra_env={"ZARR_SLOTS": "2", "API_BASE": "http://127.0.0.1:9"},
    )
    assert refused.returncode == 3
    assert "is being converted by another slot or run" in refused.stderr
    assert [c for c in qpy_calls() if c.startswith("DRIVER")] == []
    other = run(
        args=["--dataset", "nm000277"],
        extra_env={"ZARR_SLOTS": "2", "API_BASE": "http://127.0.0.1:9"},
    )
    assert other.returncode == 0, other.stdout + other.stderr
    assert len([c for c in qpy_calls() if c.startswith("DRIVER")]) == 1


def test_a_slot_handed_a_dataset_a_one_off_holds_waits_for_it(ack_run, holders) -> None:
    import time

    run, qpy_calls, ack_file, _ = ack_run
    lock = ack_file.parent / "dataset-locks" / "nm000276.lock"
    holder = _hold(lock)
    holders.append(holder)
    proc = run(
        extra_env={"ZARR_SLOTS": "2", "ZARR_SLOT": "0", "QPY_NEXT": "nm000276\tv1"},
        background=True,
    )
    try:
        time.sleep(2.0)
        assert proc.poll() is None, "it did not wait for the lock"
        assert [c for c in qpy_calls() if c.startswith("DRIVER")] == []
        holder.kill()
        holder.wait()
        _wait_until(lambda: proc.poll() is not None, "the slot to proceed", 20)
        assert proc.returncode == 0
        assert len([c for c in qpy_calls() if c.startswith("DRIVER")]) == 1
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_stats_does_not_start_slots_or_touch_the_clone(ack_run, holders) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    holders.append(_hold(ack_file.parent / ".nm-zarr.lock"))
    proc = run(args=["--stats"], extra_env={"ZARR_SLOTS": "3"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    calls = qpy_calls()
    assert [c for c in calls if c.endswith(" stats")] != []
    assert not any("reconcile" in c.split() for c in calls)
    assert "starting slot" not in proc.stdout
    assert "[setup]" not in proc.stdout


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("ZARR_SLOTS", "08", "ZARR_SLOTS must be an integer from 1 to 16"),
        ("ZARR_SLOTS", "010", "ZARR_SLOTS must be an integer from 1 to 16"),
        ("ZARR_SLOT", "01", "ZARR_SLOT must be an integer from 0 to 3"),
        ("ZARR_SLOT", "09", "ZARR_SLOT must be an integer from 0 to 3"),
        ("ZARR_JOBS", "08", "ZARR_JOBS must be a positive integer"),
        ("ZARR_JOBS", "0", "ZARR_JOBS must be a positive integer"),
        ("ZARR_JOBS", "many", "ZARR_JOBS must be a positive integer"),
        ("ZARR_JOBS_PER_SLOT", "x", "ZARR_JOBS_PER_SLOT must be a positive integer"),
        ("ZARR_HEARTBEAT_SECONDS", "0", "ZARR_HEARTBEAT_SECONDS must be a positive integer"),
        ("ZARR_HEARTBEAT_SECONDS", "abc", "ZARR_HEARTBEAT_SECONDS must be a positive integer"),
        ("ZARR_HEARTBEAT_SECONDS", "05", "ZARR_HEARTBEAT_SECONDS must be a positive integer"),
    ],
)
def test_a_count_that_is_not_a_plain_decimal_stops_the_script(
    dirs: tuple[Path, Path], name: str, value: str, message: str
) -> None:
    zarr_base, home = dirs
    proc = run_script(["--print-config"], zarr_base, home, {name: value})
    assert proc.returncode == 1
    assert message in proc.stderr
    assert proc.stdout == ""
    assert tree_entries(zarr_base) == []


def test_the_slots_are_started_with_the_bash_that_started_the_tick() -> None:
    # `bash` from PATH could be an older one that fails the version check in every
    # child; the running interpreter is known to pass it.
    assert '"${BASH:-bash}" "$SCRIPT_PATH"' in SCRIPT.read_text()


# ---------------------------------------------------------------------------
# Stopping a slot: every wait it can be in, and what a stop must not throw away
# ---------------------------------------------------------------------------

SLOW_TERMINAL_CURL = """#!/bin/sh
# The terminal callback posts its body from a file (`--data @file`); that one is slow, so a
# test can stop the script while it is in it. The "converting" post, with an inline body,
# is not.
for a in "$@"; do
  case "$a" in @*) touch "$CURL_SLOW_MARK"; sleep 4 ;; esac
done
exit 0
"""


def _stop_and_wait(proc: subprocess.Popen, sig=signal.SIGTERM, seconds: float = 20.0) -> None:
    os.kill(proc.pid, sig)
    _wait_until(lambda: proc.poll() is not None, "the slot to exit", seconds)


def test_a_stop_reaches_the_drivers_children_too(ack_run, stray_drivers) -> None:
    run, _, _, qpy_log = ack_run
    proc = run(
        extra_env={
            "ZARR_SLOTS": "2", "ZARR_SLOT": "0", "QPY_NEXT": "nm000276\tv1",
            "FAKE_DRIVER_SLEEP": "60", "FAKE_DRIVER_CHILD": "1",
        },
        background=True,
    )
    children_file = Path(str(qpy_log) + ".childpids")
    try:
        _wait_until(lambda: children_file.exists() and children_file.read_text().strip(),
                    "the driver's child")
        children = [int(x) for x in children_file.read_text().split()]
        stray_drivers.extend(children)
        stray_drivers.extend(_driver_pids(qpy_log))
        _stop_and_wait(proc)
        _wait_until(lambda: not any(_alive(p) for p in children), "the child to stop", 10)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_the_slot_waits_for_a_driver_that_is_slow_to_stop(ack_run, stray_drivers) -> None:
    """`wait` returns early when the signal is trapped; the slot must wait again until
    the driver is really gone, or it moves on (and exits) while it is still running."""
    run, _, _, qpy_log = ack_run
    proc = run(
        extra_env={
            "ZARR_SLOTS": "2", "ZARR_SLOT": "0", "QPY_NEXT": "nm000276\tv1",
            "FAKE_DRIVER_SLEEP": "60", "FAKE_DRIVER_TERM_DELAY": "1.5",
        },
        background=True,
    )
    try:
        _wait_until(lambda: _driver_pids(qpy_log), "the driver to start")
        stray_drivers.extend(_driver_pids(qpy_log))
        import time

        time.sleep(0.5)  # let the fake driver install its handler
        _stop_and_wait(proc)
        assert Path(str(qpy_log) + ".exited").exists(), "the slot exited before its driver had"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_a_driver_outlives_a_killed_script_and_keeps_its_dataset_locked(
    ack_run, stray_drivers
) -> None:
    """The lock is on a descriptor the driver inherits: kill -9 the script and the dataset
    stays locked for as long as the driver converts, and not a moment longer (the
    heartbeat that outlives the script must not hold it)."""
    run, _, _, qpy_log = ack_run
    common = {"ZARR_SLOTS": "2", "API_BASE": "http://127.0.0.1:9"}
    proc = run(
        extra_env={**common, "ZARR_SLOT": "0", "QPY_NEXT": "nm000276\tv1",
                   "FAKE_DRIVER_SLEEP": "5", "ZARR_HEARTBEAT_SECONDS": "300"},
        background=True,
    )
    try:
        _wait_until(lambda: _driver_pids(qpy_log), "the driver to start")
        drivers = _driver_pids(qpy_log)
        stray_drivers.extend(drivers)
        proc.kill()
        proc.wait()
        assert any(_alive(p) for p in drivers)
        refused = run(args=["--dataset", "nm000276"], extra_env={**common, "FAKE_DRIVER_SLEEP": "0"})
        assert refused.returncode == 3, refused.stdout + refused.stderr
        assert "is being converted by another slot or run" in refused.stderr
        _wait_until(lambda: not any(_alive(p) for p in drivers), "the driver to finish", 15)
        free = run(args=["--dataset", "nm000276"], extra_env={**common, "FAKE_DRIVER_SLEEP": "0"})
        assert free.returncode == 0, free.stdout + free.stderr
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_a_stop_is_answered_while_waiting_for_the_setup_lock(ack_run, holders) -> None:
    import time

    run, qpy_calls, ack_file, _ = ack_run
    holders.append(_hold(ack_file.parent / ".nm-zarr.setup.lock"))
    proc = run(extra_env={"ZARR_SLOTS": "2", "ZARR_SLOT": "0"}, background=True)
    try:
        time.sleep(1.5)
        assert proc.poll() is None
        _stop_and_wait(proc, seconds=15)
        assert proc.returncode == 143
        assert qpy_calls() == []
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_a_stop_is_answered_while_waiting_behind_a_one_off(ack_run, holders) -> None:
    import time

    run, qpy_calls, ack_file, _ = ack_run
    holders.append(_hold(ack_file.parent / "dataset-locks" / "nm000276.lock"))
    proc = run(
        extra_env={"ZARR_SLOTS": "2", "ZARR_SLOT": "0", "QPY_NEXT": "nm000276\tv1"},
        background=True,
    )
    try:
        _wait_until(lambda: any("reconcile" in c.split() for c in qpy_calls()), "the drain")
        time.sleep(1.5)
        assert proc.poll() is None
        _stop_and_wait(proc, seconds=15)
        assert proc.returncode == 143
        assert [c for c in qpy_calls() if c.startswith("DRIVER")] == []
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_a_slot_waiting_behind_a_one_off_keeps_its_claim_alive(ack_run, holders) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    holder = _hold(ack_file.parent / "dataset-locks" / "nm000276.lock")
    holders.append(holder)
    proc = run(
        extra_env={
            "ZARR_SLOTS": "2", "ZARR_SLOT": "0", "QPY_NEXT": "nm000276\tv1",
            "ZARR_HEARTBEAT_SECONDS": "1",
        },
        background=True,
    )
    try:
        _wait_until(lambda: _heartbeats(qpy_calls), "a heartbeat while it waits", 25)
        assert [c for c in qpy_calls() if c.startswith("DRIVER")] == []
        holder.kill()
        holder.wait()
        _wait_until(lambda: proc.poll() is not None, "the slot to finish", 25)
        assert proc.returncode == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_a_stop_after_the_driver_has_finished_loses_nothing(ack_run, tmp_path: Path) -> None:
    """The terminal callback is the slow part: a stop that lands in it must not abandon
    the bookkeeping (`qpy done`, the scratch clean-up) of days of conversion."""
    run, qpy_calls, ack_file, _ = ack_run
    slow = tmp_path / "slowbin"
    slow.mkdir()
    _write_exec(slow / "curl", SLOW_TERMINAL_CURL)
    mark = tmp_path / "curl-slow-mark"
    path = os.pathsep.join([str(slow), str(tmp_path / "fakebin"), os.environ.get("PATH", "")])
    proc = run(
        extra_env={
            "PATH": path, "CURL_SLOW_MARK": str(mark), "NEMAR_WEBHOOK_TOKEN": "t",
            "ZARR_CALLBACK_URL": WEBHOOK_URL, "QPY_NEXT": "nm000276\tv1",
            "FAKE_DRIVER_CALLBACK": json.dumps({"dataset_id": "nm000276", "status": "ready"}),
        },
        background=True,
    )
    try:
        _wait_until(mark.exists, "the terminal callback to start")
        _stop_and_wait(proc, seconds=20)
        assert proc.returncode == 143
        calls = qpy_calls()
        assert any(c.split()[-4:-3] == ["done"] or " done " in c for c in calls), calls
        scratch = ack_file.parent.parent / "zarr-scratch"
        assert not (scratch / "nm000276").exists()
        assert not (scratch / "nm000276.callback.json").exists()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_a_slot_stops_for_a_new_origin_commit_recorded_when_it_started(ack_run) -> None:
    """Another slot's setup moves the shared clone; comparing with the clone would tell
    this drain it is current while it runs the old shell logic against the new driver."""
    run, qpy_calls, ack_file, qpy_log = ack_run
    state = ack_file.parent
    upstream = state.parent.parent / "nemarOrg" / "nemar-cli"
    clone = state / "nemar-cli"
    proc = run(
        extra_env={
            "ZARR_SLOTS": "2", "ZARR_SLOT": "0", "FAKE_DRIVER_SLEEP": "3",
            "QPY_NEXT": "nm000001\tv1;nm000002\tv1",
        },
        background=True,
    )
    try:
        _wait_until(lambda: _driver_pids(qpy_log), "the first driver to start")
        (upstream / "NEWS").write_text("a new commit on origin/main\n")
        for args in (["add", "-A"], ["commit", "-q", "-m", "origin moves on"]):
            subprocess.run(["git", "-C", str(upstream), *args], check=True)
        # ...and another slot's setup() brings the shared clone up to it.
        subprocess.run(["git", "-C", str(clone), "fetch", "-q", "origin"], check=True)
        subprocess.run(["git", "-C", str(clone), "reset", "-q", "--hard", "origin/main"], check=True)
        _wait_until(lambda: proc.poll() is not None, "the slot to finish", 30)
        assert proc.returncode == 0
        assert len([c for c in qpy_calls() if c.startswith("DRIVER")]) == 1, qpy_calls()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_the_slots_are_started_with_the_bash_that_started_the_tick(ack_run, tmp_path: Path) -> None:
    """`bash` from PATH could be an older one that fails the version check in every child.
    A stand-in first on PATH runs the tick itself and fails any slot that reaches it."""
    run, qpy_calls, _, _ = ack_run
    real = shutil.which("bash")
    bin_dir = tmp_path / "wrongbash"
    bin_dir.mkdir()
    log = tmp_path / "wrong-bash.log"
    stand_in = (
        "#!/bin/sh\n"
        'if [ -n "$ZARR_SLOT" ]; then echo "$ZARR_SLOT" >> {log}; exit 97; fi\n'
        'exec {real} "$@"\n'
    ).format(log=shlex.quote(str(log)), real=shlex.quote(str(real)))
    _write_exec(bin_dir / "bash", stand_in)
    path = os.pathsep.join([str(bin_dir), str(tmp_path / "fakebin"), os.environ.get("PATH", "")])
    proc = run(extra_env={"PATH": path, "ZARR_SLOTS": "2"})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not log.exists(), "a slot was started with `bash` from PATH"
    assert _reconciles(qpy_calls) == 2


@pytest.mark.parametrize(
    ("args", "env"),
    [(["--limit", "08"], {}), (["--limit", "abc"], {}), ([], {"ZARR_LIMIT": "010"}),
     (["--limit", "-1"], {})],
)
def test_a_limit_that_is_not_a_plain_count_stops_the_script(
    dirs: tuple[Path, Path], args: list[str], env: dict[str, str]
) -> None:
    zarr_base, home = dirs
    proc = run_script([*args, "--print-config"], zarr_base, home, env)
    assert proc.returncode == 1
    assert "must be a non-negative integer" in proc.stderr
    assert tree_entries(zarr_base) == []


def test_a_zero_limit_still_means_no_limit(dirs: tuple[Path, Path]) -> None:
    assert _config(dirs, "--limit", "0")["LIMIT"] == "0"
    assert _config(dirs, "--limit", "12")["LIMIT"] == "12"


def test_a_dataset_lock_that_cannot_be_opened_is_reported_as_that(ack_run) -> None:
    run, qpy_calls, ack_file, _ = ack_run
    state = ack_file.parent
    (state / "dataset-locks").parent.mkdir(parents=True, exist_ok=True)
    # A file where the lock directory should be: mkdir -p and the open both fail.
    (state / "dataset-locks").write_text("not a directory")
    proc = run(
        args=["--dataset", "nm000276"],
        extra_env={"ZARR_SLOTS": "2", "API_BASE": "http://127.0.0.1:9"},
    )
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "cannot open its dataset lock" in proc.stderr
    assert "is being converted" not in proc.stderr
    assert [c for c in qpy_calls() if c.startswith("DRIVER")] == []
