#!/usr/bin/env python3
"""
pipeline/pits.py - Genera il layer "Lunar pits" per la mappa 3D.

Scarica il catalogo ufficiale LROC (NASA Lunar Reconnaissance Orbiter Camera,
Arizona State University) dal PDS, aggiunge a ogni pit la quota LOLA della superficie
(stesse tile DEM del terreno 3D della web app, vedi lunar_pits.LolaTiles) e lo converte
in un GeoJSON per Cesium.

Fonte:
  Wagner, R. V. & Robinson, M. S. (2021), "Occurrence and Origin of Lunar Pits:
  Observations from a New Catalog", LPSC 52, #2530.
  https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_LUNAR_PIT_LOCATIONS

Uso:
    python pipeline/pits.py
    python pipeline/pits.py --force          # riscarica il CSV

Output: web/public/data/pits.geojson
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

from config import WEB_DATA
from lunar_pits import DEFAULT_CATALOG, attach_lola, load_catalog

CSV_URL = (
    "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/"
    "EXTRAS/SHAPEFILE/LUNAR_PIT_LOCATIONS/LUNAR_PIT_LOCATIONS.CSV"
)
CITATION = "Wagner & Robinson (2021), LPSC 52 #2530 - NASA LRO / LROC, Arizona State University"
DEFAULT_OUT = WEB_DATA / "pits.geojson"


def download_csv(dest: Path, force: bool = False) -> Path:
    if dest.exists() and not force:
        print(f"[pits] uso la copia locale: {dest}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"[pits] scarico {CSV_URL}")
    req = urllib.request.Request(CSV_URL, headers={"User-Agent": "ByteTheMoon/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        dest.write_bytes(r.read())
    print(f"[pits] salvato in {dest} ({dest.stat().st_size / 1024:.0f} KB)")
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description="Genera pits.geojson dal catalogo LROC + quote LOLA")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="GeoJSON di output")
    ap.add_argument("--cache", type=Path, default=DEFAULT_CATALOG, help="CSV scaricato")
    ap.add_argument("--force", action="store_true", help="riscarica il CSV")
    args = ap.parse_args()

    pits = load_catalog(download_csv(args.cache, args.force))
    dem = attach_lola(pits)
    missing = [p.name for p in pits if p.surface_elev_m is None]
    if missing:
        print(f"[pits] attenzione: {len(missing)} pit senza quota LOLA: {missing[:5]}")

    gj = {
        "type": "FeatureCollection",
        "name": "lunar_pits",
        "metadata": {
            "source": CSV_URL,
            "citation": CITATION,
            "elevation": f"{dem.source}; metres above the 1737.4 km LOLA reference sphere",
            "reference_frame": "IAU MOON2000 / Moon ME (as LOLA), longitude -180..180 E",
            "count": len(pits),
        },
        "features": [p.to_feature() for p in pits],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(gj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    with_depth = sum(p.depth_m is not None for p in pits)
    print(f"[pits] {len(pits)} pit scritti in {args.out} ({args.out.stat().st_size / 1024:.0f} KB, "
          f"{with_depth} con profondita', quote da {dem.source})")


if __name__ == "__main__":
    main()
