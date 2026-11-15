"""
Global terrain-horizon tile pyramid: the horizon elevation in 32 azimuths for every pixel, precomputed
so the browser's zoomed-out heatmaps only run the (cheap) time integration instead of tracing horizons.

Same horizon model as web/src/lib/heatWorker.ts and sky_view.py (shared code): for each of 32
azimuths (clockwise from north, a * 360/32 deg), march outward on the great circle with 40
geometrically growing steps up to 200 km, reading the elevation pyramid at a level matched to the step
size (down to --dem-max, 167 m at level 7, next to the point), observer 2 m above the ground, Moon
curvature included. The point height is read at --dem-max too, as the live worker does.
Inside the polar caps (|lat| > ~80.3 deg) every height (point and ray samples) comes from the LOLA
polar DEMs (web/public/data/dem_south, dem_north), read as lib/dem.ts does (sky_view.terrain()).

Points: the pixel centres of --level (5 = 666 m). Coarser levels average the horizons of the 2 x 2
finer pixels (per azimuth, ignoring no data), for the zoomed-out heatmaps.

Output per tile: lossless 8-bit grey WebP of 256 x (32 * 256) px, azimuth-major (rows a*256 .. a*256+255
hold azimuth a), H = offset + scale * DN degrees (-10 .. 56 in 0.26 deg steps), DN 0 = no data.
Levels 0..--public-max -> web/public/data/horizon, finer -> MOON_DATA/horizon_fine. The browser
side is web/src/lib/horizonTiles.ts.

    python pipeline/horizon_tiles.py --bench      # time a few rows, estimate the full run
    python pipeline/horizon_tiles.py              # level 5 (666 m) horizons, DEM down to 167 m
    python pipeline/horizon_tiles.py --rows polar # only the tile rows the polar DEMs affect (|lat| > ~73.7)
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

import sky_view as sv
from config import DATA, MOON_R, WEB_DATA
from polar_dem import blocks, load_poles, parse_rows, polar_rows
from slope_tiles import level_stats

TILE = 256
NAZ, STEPS = sv.NAZ, sv.STEPS
PUBLIC_OUT = WEB_DATA / "horizon"
FINE_OUT = DATA / "horizon_fine"
H_OFFSET, H_STEP = -10.0, 0.26  # DN 1..255 -> -10 .. 56 deg (steepest crater walls reach ~54)

_C: dict = {}


def _init(level: int, dem_max: int, public_max: int, polar: bool = True):
    for z in range(dem_max + 1):
        sv._M[z] = np.memmap(sv.mosaic_path(z), np.uint16, "r", shape=sv.mosaic_shape(z))
    sv._P[:] = load_poles(polar)
    d, lev = sv.make_ray(dem_max)
    W = TILE * 2 ** (level + 1)
    frac = (np.arange(W) + 0.5) / W  # longitude of each point, fraction of the circle from -180
    lon = -math.pi + 2 * math.pi * frac
    _C.update(level=level, dem_max=dem_max, public_max=public_max, d=d, lev=lev, W=W, H=TILE * 2**level, frac=frac,
              sinL=np.sin(lon).astype(np.float32), cosL=np.cos(lon).astype(np.float32),
              base={z: frac * (TILE * 2 ** (z + 1)) for z in set(lev) | {dem_max}},
              az=[(math.sin(2 * math.pi * a / NAZ), math.cos(2 * math.pi * a / NAZ)) for a in range(NAZ)])


def to_dn(h: np.ndarray) -> np.ndarray:
    ok = np.isfinite(h)
    return np.where(ok, np.clip(np.round((np.where(ok, h, H_OFFSET) - H_OFFSET) / H_STEP), 0, 254) + 1, 0).astype(np.uint8)


def horizon_row(j: int) -> np.ndarray:
    """(NAZ, W) horizon elevation (deg) of the points of row j, NaN where the point has no height."""
    c = _C
    level, dem_max, d, lev, W, H = c["level"], c["dem_max"], c["d"], c["lev"], c["W"], c["H"]
    lat = math.pi / 2 - (j + 0.5) * math.pi / H
    lat = max(-sv.MAX_LAT, min(sv.MAX_LAT, lat))
    # point height from the finest DEM level at the point (pixel containing the point centre; in a
    # polar cap bilinear from the polar DEM)
    h0 = sv.terrain(c, dem_max, lat, 0.0)
    valid0 = np.isfinite(h0)
    hs = h0 + np.float32(sv.OBSERVER_H)
    sinP, cosP = math.sin(lat), math.cos(lat)
    out = np.empty((NAZ, W), np.float32)
    best = np.empty(W, np.float32)
    for a, (sa, ca) in enumerate(c["az"]):
        best.fill(-np.inf)
        for k in range(STEPS):
            dk = d[k]
            sinD, cosD = math.sin(dk / MOON_R), math.cos(dk / MOON_R)
            sin_lat = sinP * cosD + cosP * sinD * ca
            latk = math.asin(max(-1.0, min(1.0, sin_lat)))
            dlon = math.atan2(sa * sinD * cosP, cosD - sinP * sin_lat)
            t = (sv.terrain(c, lev[k], latk, dlon) - hs) / np.float32(dk) - np.float32(dk / (2 * MOON_R))
            t[np.isnan(t)] = -np.inf
            np.maximum(best, t, out=best)
        # as heatWorker.horizon(): no terrain sample at all -> 0 deg
        out[a] = np.where(np.isfinite(best), np.degrees(np.arctan(best)), 0.0)
    out[:, ~valid0] = np.nan
    return out


def encode(dn: np.ndarray) -> bytes:
    """(NAZ, 256, 256) DN -> lossless grey WebP 256 x (NAZ * 256), azimuth-major."""
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(dn.reshape(NAZ * TILE, TILE)), "L").save(buf, "WEBP", lossless=True, quality=100, method=2)
    return buf.getvalue()


def tile_path(z: int, x: int, y: int, public_max: int) -> Path:
    return (PUBLIC_OUT if z <= public_max else FINE_OUT) / str(z) / str(x) / f"{y}.webp"


def horizon_band(ty: int) -> tuple[int, int]:
    """Tile row ty of the top level: computed and written by this process; returns (tiles, bytes)."""
    c = _C
    W, level = c["W"], c["level"]
    band = np.empty((NAZ, TILE, W), np.uint8)  # 32 x 256 x W bytes (128 MB at level 5)
    for r in range(TILE):
        band[:, r, :] = to_dn(horizon_row(ty * TILE + r))
    nbytes = 0
    for tx in range(W // TILE):
        p = tile_path(level, tx, ty, c["public_max"])
        p.parent.mkdir(parents=True, exist_ok=True)
        data = encode(band[:, :, tx * TILE:(tx + 1) * TILE])
        p.write_bytes(data)
        nbytes += len(data)
    return W // TILE, nbytes


def read_tile(p: Path) -> np.ndarray | None:
    if not p.exists():
        return None
    return np.asarray(Image.open(p).convert("L")).reshape(NAZ, TILE, TILE)


def down_tile(args) -> tuple[int, int]:
    """Level z tile (x, y) from the 2 x 2 tiles of level z + 1: per-azimuth mean ignoring no data."""
    z, x, y, public_max = args
    acc = np.zeros((NAZ, TILE, TILE), np.float32)
    cnt = np.zeros((NAZ, TILE, TILE), np.float32)
    for dy in (0, 1):
        for dx in (0, 1):
            t = read_tile(tile_path(z + 1, 2 * x + dx, 2 * y + dy, public_max))
            if t is None:
                continue
            v = t.astype(np.float32)
            ok = t > 0
            # child (2x+dx, 2y+dy) covers half of the parent in each direction; 2x2 pixel means
            vs = np.where(ok, v, 0).reshape(NAZ, TILE // 2, 2, TILE // 2, 2).sum(axis=(2, 4))
            ns = ok.reshape(NAZ, TILE // 2, 2, TILE // 2, 2).sum(axis=(2, 4))
            sl = (slice(None), slice(dy * TILE // 2, (dy + 1) * TILE // 2), slice(dx * TILE // 2, (dx + 1) * TILE // 2))
            acc[sl] += vs
            cnt[sl] += ns
    dn = np.where(cnt > 0, np.round(acc / np.maximum(cnt, 1)), 0).astype(np.uint8)
    p = tile_path(z, x, y, public_max)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = encode(dn)
    p.write_bytes(data)
    return z, len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--level", type=int, default=5)
    ap.add_argument("--dem-max", type=int, default=7)
    ap.add_argument("--public-max", type=int, default=2)
    ap.add_argument("--procs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--rows", default="", help="recompute only these tile rows of --level, e.g. '0-2,29-31', "
                    "or 'polar' (the rows the polar DEMs affect); coarser levels are rebuilt where they changed")
    ap.add_argument("--no-polar", action="store_true", help="global DEM only, also inside the polar caps")
    a = ap.parse_args()

    for z in range(a.dem_max + 1):
        sv.build_mosaic(z)
    poles = load_poles(not a.no_polar)  # builds the polar mosaics once, before the workers open them
    for p in poles:
        print(f"polar DEM {p.pole}: |lat| > {p.cap_lat_deg:.3f} deg, levels {p.ks}", flush=True)

    if a.bench:
        _init(a.level, a.dem_max, a.public_max, not a.no_polar)
        H = TILE * 2**a.level
        rows = [H // 2, H // 4, H // 16, H - 40, 3, H - 60]
        t0 = time.time()
        out = [horizon_row(j) for j in rows]
        per = (time.time() - t0) / len(rows)
        for j, h in zip(rows, out):
            print(f"row {j}: horizon mean {np.nanmean(h):.2f} min {np.nanmin(h):.2f} max {np.nanmax(h):.2f} deg")
        print(f"{per:.2f} s/row -> level {a.level}: {H} rows ~{per * H / a.procs / 60:.0f} min on {a.procs} processes (+ encoding)")
        return

    counts: dict[int, int] = {}
    sizes: dict[int, int] = {}
    n = 2**a.level
    if a.rows:
        rows = polar_rows(a.level, poles, sv.MAX_DIST) if a.rows == "polar" else parse_rows(a.rows, n)
        print(f"recomputing tile rows {blocks(rows)} of level {a.level}", flush=True)
    else:
        rows = list(range(n))
    t0 = time.time()
    with Pool(a.procs, initializer=_init, initargs=(a.level, a.dem_max, a.public_max, not a.no_polar)) as pool:
        for i, (tiles, nbytes) in enumerate(pool.imap_unordered(horizon_band, rows)):
            counts[a.level] = counts.get(a.level, 0) + tiles
            sizes[a.level] = sizes.get(a.level, 0) + nbytes
            el = time.time() - t0
            print(f"tile row {i + 1}/{len(rows)}  {el / 60:.1f} min, ~{el / (i + 1) * (len(rows) - i - 1) / 60:.0f} min left", flush=True)
        changed = set(rows)
        for z in range(a.level - 1, -1, -1):
            changed = {y // 2 for y in changed}  # coarser tile rows whose children changed
            jobs = [(z, x, y, a.public_max) for y in sorted(changed) for x in range(2 ** (z + 1))]
            for zz, nbytes in pool.imap_unordered(down_tile, jobs):
                counts[zz] = counts.get(zz, 0) + 1
                sizes[zz] = sizes.get(zz, 0) + nbytes
            print(f"level {z}: {len(jobs)} tiles, {sizes.get(z, 0) / 2**20:.1f} MB", flush=True)

    meta = {
        "tiling": "geographic", "tileSize": TILE, "format": "webp", "encoding": "u8",
        "layout": f"{NAZ} azimuths stacked vertically (row a*256 + r), azimuth a = a*360/{NAZ} deg clockwise from north",
        "azimuths": NAZ,
        "scale": H_STEP, "offset": H_OFFSET - H_STEP,  # H = offset + scale * DN (deg), DN 0 = no data
        "units": "deg",
        "publicMaxLevel": min(a.public_max, a.level), "fineMaxLevel": a.level, "demMaxLevel": a.dem_max,
        "source": f"Terrain horizons from the LOLA global DEM ({NAZ} azimuths, {STEPS} steps to {sv.MAX_DIST / 1000:.0f} km, "
                  f"DEM down to level {a.dem_max}, observer {sv.OBSERVER_H:.0f} m)",
        "levels": level_stats(PUBLIC_OUT, FINE_OUT, a.public_max, a.level) if a.rows else
                  {str(z): {"tiles": counts.get(z, 0), "MB": round(sizes.get(z, 0) / 2**20, 1)} for z in range(a.level + 1)},
    }
    if poles:
        meta["source"] = meta["source"][:-1] + (
            f"; inside the polar caps (|lat| > {poles[0].cap_lat_deg:.1f} deg) heights from the LOLA polar DEMs "
            + " / ".join(p.meta["source"].split(" (")[0].replace("LOLA ", "") for p in poles) + ")")
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    (PUBLIC_OUT / "index.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta["levels"], indent=1), f"\ntotal {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
