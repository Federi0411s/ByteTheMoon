"""
Polar elevation tile pyramids from the LOLA polar DEMs (LDEM_80S_80M / LDEM_80N_80M, polar
stereographic, 80-90 S / 80-90 N).

Why: the global DEM (dem_tiles.py, from the 118 m simple-cylindrical LDEM) is gridded in longitude /
latitude, so near the pole its pixels are 167 m long and centimetres wide; the gridding leaves a few
metres of noise between neighbouring values and up to ~300 m error within 1 km of the pole. At the
short distances where horizons are decided, that turned into horizon errors of 10-50 deg around
Shackleton (checked against LOLA AVGVISIB and an independent ray tracer on this DEM); the north cap
has the same geometry and the same problem. The polar products are LOLA's own gridding for the caps,
in a projection with no singularity at the pole.

Levels k = 1..5: pixel 80 * 2^k m (160 m .. 2.56 km), 2x2 block means of the 80 m grid (no-data
ignored); the browser picks, for a requested global level, the coarsest polar level whose pixel is
no larger than that level's pixel (lib/dem.ts), so 80 m itself is never read and not written.
Grid: polar stereographic (R = 1737.4 km, true scale at the pole), x right, y up, origin at the top
left corner (-304 km, +304 km); tile (k, x, y) covers pixels [256x, 256x+256) x [256y, 256y+256).
x = rho sin(lon) for both poles; y = rho cos(lon) south, y = -rho cos(lon) north (the PROJ / PDS
convention, the same as lib/heatGrid.ts toPolar).
Encoding as the global DEM tiles: lossless WebP, height = -10000 + 0.5 * (R * 256 + G) m, B = 255 valid.

    python pipeline/polar_dem_tiles.py                 # -> web/public/data/dem_south (~16 MB)
    python pipeline/polar_dem_tiles.py --pole north    # -> web/public/data/dem_north (needs download.py --north)
"""
from __future__ import annotations

import argparse
import io
import json
import warnings
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import transform

from config import RAW, WEB_DATA

TILE = 256
OFFSET, SCALE = -10000.0, 0.5
LEVELS = range(1, 6)


def encode(h: np.ndarray) -> bytes:
    ok = np.isfinite(h)
    dn = np.where(ok, np.clip(np.round((np.where(ok, h, OFFSET) - OFFSET) / SCALE), 1, 65535), 0).astype(np.uint32)
    rgb = np.stack([(dn >> 8).astype(np.uint8), (dn & 255).astype(np.uint8), np.where(ok, 255, 0).astype(np.uint8)], -1)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True, quality=100, method=2)
    return buf.getvalue()


def down2(a: np.ndarray) -> np.ndarray:
    h, w = a.shape
    if h % 2 or w % 2:  # pad with no data to even size
        a = np.pad(a, ((0, h % 2), (0, w % 2)), constant_values=np.nan)
        h, w = a.shape
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmean(a.reshape(h // 2, 2, w // 2, 2), axis=(1, 3)).astype(np.float32)


POLES = {  # pole -> (source label, PROJ lat_0, output folder)
    "south": ("ldem_80s_80m.lbl", "+lat_0=-90 ", "dem_south"),
    "north": ("ldem_80n_80m.lbl", "+lat_0=90 ", "dem_north"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pole", choices=sorted(POLES), default="south")
    pole = ap.parse_args().pole
    label, lat0, folder = POLES[pole]
    OUT = WEB_DATA / folder
    src = rasterio.open(RAW / label)
    proj = src.crs.to_proj4() + " "
    assert abs(src.transform.a - 80) < 1e-6 and lat0 in proj and "+lon_0=0 " in proj
    assert src.transform.c == -src.transform.f and src.transform.e == -src.transform.a  # centred, north-up
    # the x/y convention the browser assumes (lib/heatGrid.ts toPolar): x = rho sin lon, y = -p rho cos lon
    p = 1 if pole == "north" else -1
    xs, ys = transform("+proj=longlat +R=1737400 +no_defs", src.crs, [90.0, 0.0], [85.0 * p] * 2)
    rho = 2 * 1737400.0 * np.tan(np.radians(5.0) / 2)
    assert np.allclose([xs[0], ys[0], xs[1], ys[1]], [rho, 0, 0, -p * rho], atol=1e-3), (xs, ys)
    half = -src.transform.c  # 304000
    dn = src.read(1)
    h = dn.astype(np.float32) * float(src.scales[0]) + (float(src.offsets[0]) - 1737400.0)
    h[dn == src.nodata] = np.nan
    del dn
    meta = {"projection": f"polar-stereographic-{pole}", "radiusM": 1737400.0, "halfExtentM": half, "basePixelM": 80.0,
            "tileSize": TILE, "format": "webp", "encoding": "u16", "scale": SCALE, "offset": OFFSET,
            "source": f"LOLA {label[:-4].upper()} (PDS), 2x2 block means", "levels": {}}
    a = h
    total = 0
    for k in range(1, max(LEVELS) + 1):
        a = down2(a)
        if k not in LEVELS:
            continue
        H, W = a.shape
        ty, tx = -(-H // TILE), -(-W // TILE)
        nbytes = 0
        for y in range(ty):
            for x in range(tx):
                t = np.full((TILE, TILE), np.nan, np.float32)
                blk = a[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE]
                t[:blk.shape[0], :blk.shape[1]] = blk
                if not np.isfinite(t).any():
                    continue
                p = OUT / str(k) / str(x) / f"{y}.webp"
                p.parent.mkdir(parents=True, exist_ok=True)
                data = encode(t)
                p.write_bytes(data)
                nbytes += len(data)
        meta["levels"][str(k)] = {"pixelM": 80.0 * 2**k, "width": W, "height": H, "tilesX": tx, "tilesY": ty, "MB": round(nbytes / 2**20, 1)}
        total += nbytes
        print(f"level {k}: {80 * 2**k} m, {W}x{H} px, {tx}x{ty} tiles, {nbytes / 2**20:.1f} MB", flush=True)
    (OUT / "index.json").write_text(json.dumps(meta, indent=1))
    print(f"total {total / 2**20:.1f} MB -> {OUT}")


if __name__ == "__main__":
    main()
