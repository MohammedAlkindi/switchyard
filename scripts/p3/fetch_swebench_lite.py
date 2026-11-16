#!/usr/bin/env python3
"""Fetch the inputs for the P3 symbol-filter evaluation.

Downloads the SWE-bench Lite test split (300 instances) from the Hugging Face
datasets server, then, for every file the gold patch touches, the file's
contents at the instance's base commit from raw.githubusercontent.com.

Everything lands in a cache directory outside git (default
~/.cache/switchyard-p3, override with SWITCHYARD_P3_CACHE). Nothing from the
upstream repositories is committed to this repo. Re-running skips files that
are already cached, so the fetch is resumable.

Stdlib only. Usage:  python scripts/p3/fetch_swebench_lite.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DATASET = "princeton-nlp/SWE-bench_Lite"
ROWS_URL = (
    "https://datasets-server.huggingface.co/rows?dataset={ds}&config=default"
    "&split=test&offset={off}&length=100"
)
RAW_URL = "https://raw.githubusercontent.com/{repo}/{sha}/{path}"
PAUSE_S = 0.15  # be polite to raw.githubusercontent.com


def cache_dir() -> Path:
    root = os.environ.get("SWITCHYARD_P3_CACHE") or str(Path.home() / ".cache" / "switchyard-p3")
    p = Path(root)
    p.mkdir(parents=True, exist_ok=True)
    return p


def get(url: str, attempts: int = 6) -> bytes:
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "switchyard-p3-eval"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            time.sleep(2 ** i)
        except (urllib.error.URLError, OSError):  # resets, timeouts
            time.sleep(2 ** i)
    raise RuntimeError(f"failed after {attempts} attempts: {url}")


def fetch_rows(root: Path) -> list[dict]:
    out = root / "lite.json"
    if out.exists():
        return json.loads(out.read_text(encoding="utf-8"))
    rows: list[dict] = []
    for off in (0, 100, 200):
        data = json.loads(get(ROWS_URL.format(ds=DATASET.replace("/", "%2F"), off=off)))
        rows.extend(r["row"] for r in data["rows"])
    out.write_text(json.dumps(rows), encoding="utf-8")
    return rows


def main() -> int:
    root = cache_dir()
    rows = fetch_rows(root)
    print(f"{len(rows)} instances in {DATASET}")
    files_dir = root / "files"
    fetched = skipped = missing = failed = 0
    for row in rows:
        paths = re.findall(r"^diff --git a/(\S+) b/", row["patch"], re.M)
        for path in paths:
            dest = files_dir / row["instance_id"] / path
            if dest.exists():
                skipped += 1
                continue
            try:
                body = get(RAW_URL.format(repo=row["repo"], sha=row["base_commit"], path=path))
            except urllib.error.HTTPError:
                missing += 1  # file created by the patch: no base version
                continue
            except RuntimeError as e:
                failed += 1  # transient network failure: re-run to resume
                print(e, file=sys.stderr)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
            fetched += 1
            time.sleep(PAUSE_S)
    print(f"fetched={fetched} cached={skipped} absent_at_base={missing} failed={failed} -> {files_dir}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
