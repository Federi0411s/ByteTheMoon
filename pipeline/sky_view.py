"""
Global visible-sky fraction (sky-view factor) tile pyramid: precomputed, since it depends only on the
terrain. The radiation layer is dose = (20.2 f_sky + 6.2 (1 - f_sky)) x (solar-cycle factor of the
period), so with f_sky stored the browser needs no horizon computation for it.

Same horizon model as web/src/lib/heatWorker.ts (so the precomputed and the live values agree):
for each of 32 azimuths, march outward on the great circle with 40 geometrically growing steps from
0.75 px to 200 km, reading the elevation pyramid at a level matched to the step size, observer 2 m
above the ground, Moon curvature included; f_sky = mean over azimuths of (1 - sin H) / 2.

Input: the elevation pyramid from dem_tiles.py (web/public/data/dem levels 0-5, MOON_DATA/dem_fine
levels 6-7), unpacked once into uint16 memory-mapped mosaics under MOON_DATA/cache (~5.7 GB for
level 7) that all worker processes share.

Output: lossless 8-bit grey WebP, f_sky = 0.1 + 0.002 * (DN - 1) (0.1 .. 0.608), DN 0 = no data, in
the usual geographic tile layout. Levels 0..PUBLIC_MAX -> web/public/data/sky, finer -> MOON_DATA/sky_fine.

    python pipeline/sky_view.py --bench           # time a few rows, estimate the full run
    python pipeline/sky_view.py --level 7         # full run at 167 m (finest), all CPU cores
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

from config import DATA, MOON_R, WEB_DATA
from slope_tiles import Cascade, Writer, encode_u8

TILE = 256
DEM_PUBLIC = WEB_DATA / "dem"
DEM_FINE = DATA / "dem_fine"
CACHE = DATA / "cache"
PUBLIC_OUT = WEB_DATA / "sky"
FINE_OUT = DATA / "sky_fine"
OFFSET, STEP = 0.1, 0.002

# horizon model: keep in step with web/src/lib/heatWorker.ts
NAZ, STEPS, MAX_DIST, OBSERVER_H = 32, 40, 200_000.0, 2.0
MAX_LAT = math.radians(89.99)
DEM_OFFSET, DEM_SCALE = -10000.0, 0.5


def dem_pixel_m(z: int) -> float:
    return math.pi * MOON_R / (TILE * 2**z)


def dem_level_for(m: float, max_level: int) -> int:
    z = math.ceil(math.log2(math.pi * MOON_R / (TILE * max(m, 1.0))))
    return max(0, min(max_level, z))


def make_ray(dem_max: int):
    d0 = max(dem_pixel_m(dem_max) * 0.75, 50.0)
    g = (MAX_DIST / d0) ** (1 / (STEPS - 1))
    d = d0 * g ** np.arange(STEPS)
    level = [dem_level_for(0.5 * dk * (g - 1), dem_max) for dk in d]
    return d, level


# ---- mosaics ----
def mosaic_path(z: int) -> Path:
    return CACHE / f"dem_z{z}.u16"


def mosaic_shape(z: int) -> tuple[int, int]:
    return TILE * 2**z, TILE * 2 ** (z + 1)


def build_mosaic(z: int):
    path, done = mosaic_path(z), CACHE / f"dem_z{z}.done"
    if done.exists():
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    root = DEM_PUBLIC if (DEM_PUBLIC / str(z)).exists() else DEM_FINE
    h, w = mosaic_shape(z)
    m = np.memmap(path, np.uint16, "w+", shape=(h, w))
    t0 = time.time()

    def load(xy):
        x, y = xy
        f = root / str(z) / str(x) / f"{y}.webp"
        if not f.exists():
            return
        a = np.asarray(Image.open(f).convert("RGB"))
        dn = a[..., 0].astype(np.uint16) * 256 + a[..., 1]
        m[y * TILE:(y + 1) * TILE, x * TILE:(x + 1) * TILE] = np.where(a[..., 2] > 0, dn, 0)

    with ThreadPoolExecutor(16) as ex:
        list(ex.map(load, [(x, y) for y in range(2**z) for x in range(2 ** (z + 1))]))
    m.flush()
    del m
    done.write_text("ok")
    print(f"mosaic z{z} ({w}x{h}) from {root}: {time.time() - t0:.0f} s", flush=True)


# ---- per-process state ----
_M: dict[int, np.ndarray] = {}
_CFG: dict = {}


def _init(level: int):
    for z in range(level + 1):
        _M[z] = np.memmap(mosaic_path(z), np.uint16, "r", shape=mosaic_shape(z))
    d, lev = make_ray(level)
    W = TILE * 2 ** (level + 1)
    frac = (np.arange(W) + 0.5) / W  # longitude of each output column, fraction of the circle from -180
    _CFG.update(level=level, d=d, lev=lev, W=W, H=TILE * 2**level,
                base={z: frac * (TILE * 2 ** (z + 1)) for z in set(lev)},
                az=[(math.sin(2 * math.pi * a / NAZ), math.cos(2 * math.pi * a / NAZ)) for a in range(NAZ)])


def sky_row(j: int) -> np.ndarray:
    c = _CFG
    level, d, lev, W, H = c["level"], c["d"], c["lev"], c["W"], c["H"]
    lat = math.pi / 2 - (j + 0.5) * math.pi / H
    lat = max(-MAX_LAT, min(MAX_LAT, lat))
    dn0 = np.asarray(_M[level][j])
    valid0 = dn0 > 0
    hs = dn0.astype(np.float32) * DEM_SCALE + DEM_OFFSET + OBSERVER_H
    sinP, cosP = math.sin(lat), math.cos(lat)
    sky = np.zeros(W, np.float32)
    best = np.empty(W, np.float32)
    for sa, ca in c["az"]:
        best.fill(-np.inf)
        for k in range(STEPS):
            dk = d[k]
            sinD, cosD = math.sin(dk / MOON_R), math.cos(dk / MOON_R)
            sin_lat = sinP * cosD + cosP * sinD * ca
            latk = math.asin(max(-1.0, min(1.0, sin_lat)))
            dlon = math.atan2(sa * sinD * cosP, cosD - sinP * sin_lat)
            z = lev[k]
            hz = TILE * 2**z
            wz = 2 * hz
            yk = min(hz - 1, max(0, int((math.pi / 2 - latk) / math.pi * hz)))
            row = np.asarray(_M[z][yk])
            xk = (c["base"][z] + dlon / (2 * math.pi) * wz).astype(np.int64) & (wz - 1)
            dn = row[xk]
            t = (dn.astype(np.float32) * DEM_SCALE + DEM_OFFSET - hs) / np.float32(dk) - np.float32(dk / (2 * MOON_R))
            t[dn == 0] = -np.inf
            np.maximum(best, t, out=best)
        h = np.where(np.isfinite(best), np.arctan(best), 0.0)
        sky += 1 - np.sin(h).astype(np.float32)
    f = sky / NAZ / 2
    f[~valid0] = np.nan
    return f


def sky_band(ty: int) -> tuple[int, np.ndarray]:
    return ty, np.stack([sky_row(ty * TILE + r) for r in range(TILE)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", type=int, default=7)
    ap.add_argument("--public-max", type=int, default=4)  # level 5 is ~56 MB: bucket
    ap.add_argument("--procs", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    ap.add_argument("--bench", action="store_true")
    a = ap.parse_args()

    for z in range(a.level + 1):
        build_mosaic(z)

    if a.bench:
        _init(a.level)
        H = TILE * 2**a.level
        rows = [H // 2, H // 4, H // 16, H - 40]
        t0 = time.time()
        out = [sky_row(j) for j in rows]
        per = (time.time() - t0) / len(rows)
        for j, f in zip(rows, out):
            print(f"row {j}: f_sky mean {np.nanmean(f):.3f} min {np.nanmin(f):.3f} max {np.nanmax(f):.3f}")
        print(f"{per:.2f} s/row -> level {a.level}: {H} rows ~{per * H / a.procs / 3600:.1f} h on {a.procs} processes")
        return

    enc = lambda t: encode_u8(t, OFFSET, STEP)  # noqa: E731
    w = Writer(PUBLIC_OUT, FINE_OUT, a.public_max, enc)
    c = Cascade(w, a.level)
    n = 2**a.level
    t0 = time.time()
    with Pool(a.procs, initializer=_init, initargs=(a.level,)) as pool:
        for i, (ty, band) in enumerate(pool.imap(sky_band, range(n))):
            c.push(ty, band)
            el = time.time() - t0
            print(f"tile row {ty + 1}/{n}  {el / 60:.1f} min, ~{el / (i + 1) * (n - i - 1) / 60:.0f} min left", flush=True)
    w.flush()
    meta = {
        "tiling": "geographic", "tileSize": TILE, "format": "webp", "encoding": "u8",
        "scale": STEP, "offset": OFFSET - STEP,  # f_sky = offset + scale * DN, DN 0 = no data
        "units": "fraction", "publicMaxLevel": min(a.public_max, a.level), "fineMaxLevel": a.level,
        "source": f"Visible-sky fraction from LOLA LDEM 118 m horizons ({NAZ} azimuths, {STEPS} steps to {MAX_DIST / 1000:.0f} km)",
        "levels": {str(z): {"tiles": w.count.get(z, 0), "MB": round(w.bytes.get(z, 0) / 2**20, 1)} for z in range(a.level + 1)},
    }
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    (PUBLIC_OUT / "index.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta["levels"], indent=1))


if __name__ == "__main__":
    main()
