"""
Build the list of NASA Moon Trek image mosaics the web app streams as its photographic basemap.

Moon Trek serves every mosaic as a WMTS layer in a geographic (equirectangular) 2x1 tiling, so
Cesium can stack them: a global low-res layer at the bottom, sharper layers on top, each one only
requested where it has data (its bounding box) and when the camera is close enough to need it.

Output: web/src/cesium/trekLayers.json  (committed; re-run only to refresh the list)

    python pipeline/trek_catalog.py
"""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "web" / "src" / "cesium" / "trekLayers.json"
TREK = "https://trek.nasa.gov/tiles/Moon/EQ"
SEARCH = "https://trek.nasa.gov/moon/TrekServices/ws/index/eq/searchItems"

# Global layers, bottom to top. minLevel = first level at which the layer is drawn (below it the
# layer underneath shows through), so a sharper but patchier mosaic only kicks in once zoomed in.
GLOBAL = [
    # LRO WAC: clean, uniform, ~100 m/px. The base everywhere.
    dict(id="LRO_WAC_Mosaic_Global_303ppd_v02", title="LRO WAC global mosaic", minLevel=0, latRange=None),
    # Kaguya Terrain Camera: ~21 m/px served, but low-sun polar strips are unusable -> clip to +-60.
    dict(id="Kaguya_TCortho_Mosaic_Global_4096ppd", title="Kaguya TC global ortho mosaic", minLevel=7, latRange=(-60, 60)),
    # LROC NAC polar caps: ~5 m/px down to 83.6 deg.
    dict(id="LRO_NAC_AvgMosaic_SPole855_1mp_EQ", title="LROC NAC south pole mosaic", minLevel=5, latRange=None),
    dict(id="LRO_NAC_AvgMosaic_NPole855_1mp_EQ", title="LROC NAC north pole mosaic", minLevel=5, latRange=None),
]

# Regional high-res (0.5-1.5 m/px) NAC mosaics and orthoimages, picked from the catalogue by name.
REGIONAL = re.compile(r"^LRO_NAC_(Mosaic|Ortho|Post_Landing_OrthoMosaic)_")


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "trek-catalog-script"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def capabilities(layer: str) -> dict:
    xml = get(f"{TREK}/{layer}/1.0.0/WMTSCapabilities.xml").decode("utf-8", "replace")
    lo = re.search(r"<ows:LowerCorner>([-\d.]+) ([-\d.]+)", xml)
    hi = re.search(r"<ows:UpperCorner>([-\d.]+) ([-\d.]+)", xml)
    fmt = re.search(r"<Format>image/(\w+)", xml).group(1)
    # the default028mm TileMatrixSet is the 2x1 geographic one; count its levels
    sets = re.findall(r"<TileMatrixSet>(.*?)</TileMatrixSet>", xml, re.S)
    tms = next(s for s in sets if "default028mm" in s and "<TileMatrix>" in s)
    levels = len(re.findall(r"<TileMatrix>", tms))
    return dict(
        ext="jpg" if fmt == "jpeg" else fmt,
        # The capabilities list two more matrices than are actually served (probed: WAC tiles stop
        # at 8 of a declared 10, Kaguya at 10 of 12, NAC at 12-15 of 14-17).
        maxLevel=levels - 3,
        bbox=[float(lo.group(1)), float(lo.group(2)), float(hi.group(1)), float(hi.group(2))],
    )


def regional_products() -> list[dict]:
    found = {}
    for start in range(0, 3000, 400):
        q = f"{SEARCH}?start={start}&rows=400&key=*&itemType=product"
        for d in json.loads(get(q))["response"]["docs"]:
            label = d.get("productLabel") or ""
            if REGIONAL.match(label) and "Pre_Landing" not in label:
                found[label] = d.get("title", label)
    return [dict(id=k, title=v) for k, v in sorted(found.items())]


def main():
    out = []
    for g in GLOBAL:
        c = capabilities(g["id"])
        bbox = c["bbox"]
        if g["latRange"]:
            bbox = [bbox[0], max(bbox[1], g["latRange"][0]), bbox[2], min(bbox[3], g["latRange"][1])]
        out.append(dict(id=g["id"], title=g["title"], kind="global", minLevel=g["minLevel"], **{**c, "bbox": bbox}))
        print(f"{g['id']}: levels 0-{c['maxLevel']} {c['ext']}")
    for p in regional_products():
        try:
            c = capabilities(p["id"])
        except Exception as e:  # some catalogue entries have no tile service
            print(f"skip {p['id']}: {e}")
            continue
        out.append(dict(id=p["id"], title=p["title"].replace("LRO LROC ", "").replace("LRO ", ""), kind="regional", minLevel=11, **c))  # past Kaguya's best level
        print(f"{p['id']}: levels 0-{c['maxLevel']}")
    OUT.write_text(json.dumps(out, indent=1))
    print(f"wrote {len(out)} layers -> {OUT}")


if __name__ == "__main__":
    main()
