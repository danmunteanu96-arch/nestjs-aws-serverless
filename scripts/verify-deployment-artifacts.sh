#!/usr/bin/env bash
set -euo pipefail

# Validates local Serverless ZIPs only; this never calls AWS or creates a deployment.
ARTIFACT_DIR="${1:-.serverless}"
export ARTIFACT_DIR

# Windows Git Bash commonly exposes Python as `python`; WSL often only has
# `python3`. Prefer python3, then fall back to python.
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || command -v python || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  printf 'Python 3 is required to inspect the ZIP archives.\n' >&2
  exit 1
fi

"$PYTHON_BIN" - <<'PY'
import os
from pathlib import Path
from zipfile import BadZipFile, ZipFile

artifact_dir = Path(os.environ["ARTIFACT_DIR"])
max_zip_bytes = 5 * 1024 * 1024
names = ("api.zip", "closeExpiredAuctions.zip", "sendWinnerNotification.zip")
failed = False
for name in names:
    path = artifact_dir / name
    if not path.is_file():
        print(f"MISSING {path}; package api.yml first")
        failed = True
        continue
    size = path.stat().st_size
    try:
        with ZipFile(path) as archive:
            corrupt_member = archive.testzip()
    except BadZipFile:
        print(f"INVALID {path}: not a ZIP archive")
        failed = True
        continue
    if corrupt_member:
        print(f"INVALID {path}: corrupt member {corrupt_member}")
        failed = True
    elif size >= max_zip_bytes:
        print(f"TOO LARGE {path}: {size} bytes; limit is {max_zip_bytes}")
        failed = True
    else:
        print(f"OK {path}: {size} bytes ({size / 1024:.1f} KiB)")
if failed:
    raise SystemExit(1)
PY
