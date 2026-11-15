"""Download the raw inputs (PDS LOLA products + NAIF SPICE kernels). Resumable: just re-run it.

    python pipeline/download.py                 # data products + full DE440 SPICE kernels
    python pipeline/download.py --kernels-only   # SPICE kernels only
    python pipeline/download.py --all            # + optional hi-res DEM and 75S illumination
    python pipeline/download.py --north          # + north polar DEM (80N, 80 m) and 85N illumination

Uses only HTTPS (NASA blocks FTP) and the standard library.
"""
from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

from config import KERNEL_FILES, KERNELS, NORTH_PRODUCTS, OPTIONAL_PRODUCTS, PRODUCTS, RAW


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
    ap.add_argument("--north", action="store_true", help="also download the north polar products")
    ap.add_argument("--kernels-only", action="store_true", help="download only SPICE kernels")
    args = ap.parse_args()

    if not args.kernels_only:
        products = dict(PRODUCTS, **(OPTIONAL_PRODUCTS if args.all else {}), **(NORTH_PRODUCTS if args.north else {}))
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
