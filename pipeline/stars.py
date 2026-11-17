"""Star catalogue for the sky (web/src/cesium/stars.ts): every Hipparcos star brighter than V = 7.0.

    python pipeline/stars.py                 # query VizieR
    python pipeline/stars.py --tsv FILE      # or parse a saved answer of the same query (QUERY below)

Source: the Hipparcos Main Catalogue (ESA 1997, CDS I/239/hip_main) through VizieR: ICRS positions at
the catalogue epoch J1991.25, Johnson V, B-V and proper motions. Hipparcos is complete well past
V = 7, i.e. past the naked-eye limit under a perfectly dark sky (~7.0, see stars.ts), so every star an
eye could see from the Moon is in it. The web app applies the proper motions to the simulation date,
so positions are correct at any instant, not frozen at an epoch.

Output web/public/data/stars.bin (little-endian, structure of arrays, sorted by V, brightest first):
    header   'STR1', uint32 count, float32 epoch (Julian year, 1991.25), uint32 0
    float32  RA[n], Dec[n]                 deg, ICRS, at the epoch
    int16    V[n]                          0.01 mag
    int16    BV[n]                         0.001 mag (missing: 0.65, a solar colour)
    int16    pmRA[n], pmDec[n]             mas/yr (pmRA = mu_alpha cos(delta)); missing: 0
"""
from __future__ import annotations

import argparse
import struct
import time
import urllib.request

from config import WEB_DATA

V_LIMIT = 7.0
QUERY = ("viz-bin/asu-tsv?-source=I/239/hip_main&-out=HIP,RAICRS,DEICRS,Vmag,B-V,pmRA,pmDE"
         f"&Vmag=%3C{V_LIMIT}&-out.max=unlimited")
MIRRORS = ("https://vizier.cfa.harvard.edu/", "https://vizier.cds.unistra.fr/")


def download() -> str:
    last: Exception | None = None
    for base in MIRRORS * 3:  # the mirrors' databases drop out now and then: a few rounds
        try:
            # (a generic client name: the CDS servers answer 404 to Python's default User-Agent)
            req = urllib.request.Request(base + QUERY, headers={"User-Agent": "Mozilla/5.0 (catalogue download)"})
            with urllib.request.urlopen(req, timeout=180) as r:
                text = r.read().decode("utf-8", "replace")
            if "\nHIP\t" in text:
                return text
            last = RuntimeError(f"{base}: unexpected answer")
        except Exception as e:  # try the next mirror
            last = e
        time.sleep(2)
    raise SystemExit(f"VizieR query failed: {last}")


def parse(text: str):
    rows = []
    header_seen = False
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        f = line.split("\t")
        if f[0] == "HIP":
            header_seen = True
            continue
        if not header_seen or len(f) < 7 or not f[0].strip().isdigit():
            continue  # units / dashes lines
        ra, de, v, bv, pmra, pmde = (x.strip() for x in f[1:7])
        if not ra or not de or not v:
            continue  # no astrometric solution (a handful of components of multiple systems)
        rows.append((float(v), float(ra), float(de), float(bv) if bv else 0.65,
                     float(pmra) if pmra else 0.0, float(pmde) if pmde else 0.0))
    rows.sort()
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tsv", help="saved VizieR answer to QUERY instead of downloading")
    a = ap.parse_args()
    rows = parse(open(a.tsv, encoding="utf-8").read() if a.tsv else download())
    n = len(rows)
    out = WEB_DATA / "stars.bin"
    with open(out, "wb") as f:
        f.write(b"STR1" + struct.pack("<IfI", n, 1991.25, 0))
        f.write(struct.pack(f"<{n}f", *(r[1] for r in rows)))
        f.write(struct.pack(f"<{n}f", *(r[2] for r in rows)))
        clamp = lambda x: max(-32767, min(32767, round(x)))  # noqa: E731
        f.write(struct.pack(f"<{n}h", *(clamp(r[0] * 100) for r in rows)))
        f.write(struct.pack(f"<{n}h", *(clamp(r[3] * 1000) for r in rows)))
        f.write(struct.pack(f"<{n}h", *(clamp(r[4]) for r in rows)))
        f.write(struct.pack(f"<{n}h", *(clamp(r[5]) for r in rows)))
    print(f"{n} stars (V < {V_LIMIT}, brightest V = {rows[0][0]}) -> {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
