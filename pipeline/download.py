"""Download the raw inputs (PDS LOLA products + NAIF SPICE kernels). Resumable: just re-run it.

    python pipeline/download.py            # ~400 MB: everything the default pipeline needs
    python pipeline/download.py --all      # + optional hi-res DEM and 75S illumination (~700 MB more)

Uses only HTTPS (NASA blocks FTP) and the standard library.
"""
from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

from config import KERNEL_FILES, KERNELS, OPTIONAL_PRODUCTS, PRODUCTS, RAW


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    head = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(head, timeout=60) as r:
        total = int(r.headers.get("Content-Length", 0))
    if dest.exists() and (total == 0 or dest.stat().st_size == total):
        print(f"  ok      {dest.name}")
        return
    req = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
    with urllib.request.urlopen(req, timeout=60) as r, open(part, "ab" if have else "wb") as f:
        if have and r.status != 206:  # server ignored Range: restart
            f.seek(0)
            f.truncate()
            have = 0
        done = have
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  get     {dest.name}: {done / 1e6:7.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()
    part.replace(dest)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="also download optional products")
    args = ap.parse_args()

    products = dict(PRODUCTS, **(OPTIONAL_PRODUCTS if args.all else {}))
    print(f"PDS products -> {RAW}")
    for name, base in products.items():
        for ext in (".lbl", ".img"):
            fetch(base + ext, RAW / (name + ext))
    print(f"SPICE kernels -> {KERNELS}")
    for name, url in KERNEL_FILES.items():
        fetch(url, KERNELS / name)
    print("Done.")


if __name__ == "__main__":
    sys.exit(main())
