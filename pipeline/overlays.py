"""Convert LOLA polar products into web overlays (PNG + metadata) for the 3D globe.

    python pipeline/overlays.py

Every layer is resampled onto one canonical south-polar-stereographic grid
(+proj=stere +lat_0=-90 +lon_0=0 +R=1737400), which web/src/lib/raster.ts mirrors exactly, then
quantised to 8 bits (or 16 bits as R/G bytes for elevation). The browser re-projects on the fly, so
no tile pyramids are needed and derived heatmaps (landing score) can be recomputed live.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.warp import reproject

from config import OVERLAYS_OUT, RAW, SOUTH_STERE
from rasters import physical


@dataclass
class Layer:
    id: str
    title: str
    description: str
    source: str
    product: str           # file stem in RAW
    lo: float              # encoding range (values outside are clipped)
    hi: float
    min: float             # display range
    max: float
    units: str
    colormap: str
    out_res_m: float       # output pixel size
    encoding: str = "u8"
    transparent_below: float | None = None  # values below -> nodata (e.g. PSR mask keeps only shadowed pixels)
    display: bool = True
    nodata_dn: int | None = None  # extra raw value meaning 'no data' (LDSM uses 0 for gaps between LOLA tracks)
    resample_max: bool = False  # downsample with max instead of average (conservative, e.g. for slope limits)


LAYERS = [
    Layer("sun_avg", "Average sunlight",
          "Fraction of time the Sun is visible above the local terrain horizon (multi-year average).",
          "LOLA / Mazarico et al., AVGVISIB 85S 60 m (PDS)", "avgvisib_85s_060m_201608",
          0, 1, 0, 1, "fraction", "inferno", 60),
    Layer("earth_avg", "Average Earth visibility",
          "Fraction of time the Earth is above the local terrain horizon: direct-to-Earth comms.",
          "LOLA / Mazarico et al., AVGVISIB_EARTH 85S 60 m (PDS)", "avgvisib_85s_060m_201608_earth",
          0, 1, 0, 1, "fraction", "cividis", 60),
    Layer("psr", "Permanent shadow (PSR)",
          "Permanently shadowed regions: never lit, extremely cold, possible water ice.",
          "LOLA LPSR 85S 60 m (PDS)", "lpsr_85s_060m_201608",
          0, 1, 0, 1, "", "ice", 60, transparent_below=0.5),
    Layer("slope", "Slope",
          "Surface slope from LOLA topography. Landers typically need < 8–15°.",
          "LOLA LDSM 85S 40 m (PDS)", "ldsm_85s_40m",
          0, 45, 0, 30, "°", "slope", 100, nodata_dn=0),
    # Data-only layer for the landing-suitability heatmap: each 100 m cell holds the STEEPEST 40 m slope
    # inside it; the browser then takes the max over the user's landing footprint (web/src/lib/raster.ts).
    Layer("slope_max", "Max slope per 100 m cell",
          "Steepest 40 m LOLA slope inside each 100 m cell.",
          "LOLA LDSM 85S 40 m (PDS), max-resampled to 100 m", "ldsm_85s_40m",
          0, 45, 0, 30, "°", "slope", 100, nodata_dn=0, display=False, resample_max=True),
    Layer("dem_south", "Elevation",
          "Height above the 1737.4 km reference sphere. Also used in the browser to compute horizons for custom sites.",
          "LOLA LDEM 80S 80 m (PDS), resampled to 240 m", "ldem_80s_80m",
          -10000, 22767, -5000, 5000, "m", "terrain", 240, encoding="u16"),
]

MAX_PX = 4096  # keep PNGs small enough for the browser (and for git)


def build(layer: Layer) -> dict | None:
    lbl = RAW / f"{layer.product}.lbl"
    if not lbl.exists():
        print(f"  skip {layer.id}: {lbl.name} not downloaded")
        return None
    with rasterio.open(lbl) as src:
        dn = src.read(1)
        val = physical(src, dn).astype(np.float32)
        if layer.nodata_dn is not None:
            val[dn == layer.nodata_dn] = np.nan
        half = max(abs(src.bounds.left), abs(src.bounds.right), abs(src.bounds.top), abs(src.bounds.bottom))
        size = min(int(round(2 * half / layer.out_res_m)), MAX_PX)
        half = size * max(layer.out_res_m, 2 * half / size) / 2
        res = 2 * half / size
        dst = np.full((size, size), np.nan, dtype=np.float32)
        reproject(
            val, dst,
            src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
            dst_transform=rasterio.transform.from_origin(-half, half, res, res), dst_crs=SOUTH_STERE, dst_nodata=np.nan,
            resampling=(Resampling.max if layer.resample_max else Resampling.average) if res > abs(src.transform.a) * 1.5
            else Resampling.bilinear,
        )

    if layer.transparent_below is not None:
        dst[dst < layer.transparent_below] = np.nan
    valid = ~np.isnan(dst)
    v = np.clip(np.where(valid, dst, layer.lo), layer.lo, layer.hi)
    if layer.encoding == "u8":
        scale = (layer.hi - layer.lo) / 254
        dn8 = np.where(valid, 1 + np.round((v - layer.lo) / scale), 0).astype(np.uint8)
        img = Image.fromarray(dn8, mode="L")
        offset = layer.lo - scale
    else:
        scale = 0.5
        q = np.where(valid, np.round((v - layer.lo) / scale), 0).astype(np.uint16)
        rgb = np.stack([(q >> 8).astype(np.uint8), (q & 255).astype(np.uint8), np.where(valid, 255, 0).astype(np.uint8)], -1)
        img = Image.fromarray(rgb, mode="RGB")
        offset = layer.lo
    OVERLAYS_OUT.mkdir(parents=True, exist_ok=True)
    out = OVERLAYS_OUT / f"{layer.id}.png"
    img.save(out, optimize=True)
    print(f"  {layer.id}: {size}x{size} px @ {res:.0f} m, {out.stat().st_size / 1e6:.1f} MB, "
          f"values {np.nanmin(dst):.3g}..{np.nanmax(dst):.3g} {layer.units}")

    meta = {k: v for k, v in asdict(layer).items() if k in ("id", "title", "description", "source", "min", "max", "units", "colormap", "encoding", "display")}
    meta.update(file=out.name, projection="polar-south", width=size, height=size, halfExtentM=half,
                scale=scale, offset=offset, resolutionM=res)
    return meta


def main() -> None:
    print(f"Overlays -> {OVERLAYS_OUT}")
    metas = [m for m in (build(l) for l in LAYERS) if m]
    (OVERLAYS_OUT / "index.json").write_text(json.dumps({"layers": metas}, indent=1))
    print(f"{len(metas)} layers written.")


if __name__ == "__main__":
    main()
