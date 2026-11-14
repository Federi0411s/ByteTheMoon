"""
Terrain horizon masks on a regular grid over the south polar illumination area (85S-90S).

With a horizon mask per grid cell plus the Sun/Earth ephemeris, the browser can compute average
sunlight and Earth visibility for ANY mission period (web/src/lib/missionWorker.ts), not just the
long-term averages that LOLA publishes.

Method (same as the per-site horizons): for every cell and azimuth, march outward over the LOLA
80 m DEM and keep the highest elevation angle, including the Moon's curvature. Rays are traced in
the polar stereographic plane (conformal, so azimuths are preserved; scale error < 1% here).

Outputs in web/public/data/horizons/:
  grid.png   8-bit grey, one tile per azimuth bin (tiles laid out in a grid). DN 0 = no data,
             elevation = offset + scale * DN degrees.
  baseline.png  2 tiles: long-term average sun / earth visibility on the same grid over the whole
             ephemeris (used to rescale the 60 m LOLA maps to the selected period).
  index.json metadata.

    python pipeline/horizon_grid.py [--cell-km 1.0] [--az-step 2]
"""
from __future__ import annotations

import argparse
import json
import math
import time

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

from config import MOON_R, RAW, WEB_DATA
from rasters import physical

OUT = WEB_DATA / "horizons"
HALF_EXTENT_M = 151_740.0  # same square as the 85S illumination overlays
OBSERVER_H = 2.0
ELEV_OFFSET, ELEV_SCALE = -10.0, 0.1  # DN 1..255 -> -9.9..15.5 deg (bodies never rise above ~13 deg here)
SUN_RADIUS_KM, EARTH_RADIUS_KM = 696_000.0, 6_371.0


def load_dem(res_m: float):
    path = RAW / "ldem_80s_80m.lbl"
    with rasterio.open(path) as src:
        f = max(1, round(res_m / abs(src.transform.a)))
        h, w = src.height // f, src.width // f
        dn = src.read(1, out_shape=(h, w), resampling=Resampling.average)
        dem = physical(src, dn).astype(np.float32)
        t = src.transform * src.transform.scale(src.width / w, src.height / h)
    # pixel centre (col,row) -> x = t.c + (col+.5)*t.a ; y = t.f + (row+.5)*t.e
    return dem, t


def bilinear(dem, t, x, y):
    col = (x - t.c) / t.a - 0.5
    row = (y - t.f) / t.e - 0.5
    h, w = dem.shape
    ok = (col >= 0) & (row >= 0) & (col < w - 1) & (row < h - 1)
    c0 = np.clip(col.astype(np.int32), 0, w - 2)
    r0 = np.clip(row.astype(np.int32), 0, h - 2)
    fc, fr = col - c0, row - r0
    v = (dem[r0, c0] * (1 - fc) + dem[r0, c0 + 1] * fc) * (1 - fr) + (dem[r0 + 1, c0] * (1 - fc) + dem[r0 + 1, c0 + 1] * fc) * fr
    return np.where(ok, v, np.nan)


def horizons(cell_m: float, az_step: float, dem_res: float):
    dem, t = load_dem(dem_res)
    n = 2 * int(round(HALF_EXTENT_M / cell_m))  # even: no cell centre exactly on the pole
    step = 2 * HALF_EXTENT_M / n
    c = -HALF_EXTENT_M + (np.arange(n) + 0.5) * step
    X, Y = np.meshgrid(c, -c)  # row 0 = top (+y), like the overlays
    x0, y0 = X.ravel(), Y.ravel()
    rho = np.hypot(x0, y0)
    lat = -(np.pi / 2 - 2 * np.arctan(rho / (2 * MOON_R)))
    k = 2 / (1 + np.abs(np.sin(lat)))  # stereographic scale factor at the cell
    h0 = bilinear(dem, t, x0, y0) + OBSERVER_H
    # local north = away from the pole, east = clockwise seen from above the south pole
    nx_, ny_ = x0 / rho, y0 / rho
    ex_, ey_ = y0 / rho, -x0 / rho

    dists = []
    d = dem_res
    while d < 250_000:
        dists.append(d)
        d *= 1.045
    dists = np.array(dists)
    th = dists / MOON_R
    n_az = int(round(360 / az_step))
    out = np.full((n_az, n * n), -90.0, dtype=np.float32)
    t0 = time.time()
    for a in range(n_az):
        az = math.radians(a * az_step)
        dx = math.cos(az) * nx_ + math.sin(az) * ex_
        dy = math.cos(az) * ny_ + math.sin(az) * ey_
        best = out[a]
        alive = np.ones(n * n, dtype=bool)
        for di, dd in zip(dists, th):
            hh = bilinear(dem, t, x0 + dx * di * k, y0 + dy * di * k)
            alive &= ~np.isnan(hh)  # stop a ray once it leaves the DEM
            rt = MOON_R + hh
            e = np.degrees(np.arctan2(rt * math.cos(dd) - (MOON_R + h0), rt * math.sin(dd)))
            np.maximum(best, np.where(alive, e, -90), out=best)
        if a % 30 == 0:
            print(f"  az {a * az_step:5.1f}  {time.time() - t0:6.1f}s")
    out[:, np.isnan(h0)] = np.nan
    return out, n, step


def disc_fraction(dh, r):
    x = np.clip(dh / r, -1, 1)
    return 1 - (np.arccos(x) - x * np.sqrt(1 - x * x)) / np.pi


def baseline(hz, n, step, az_step, every_h=6):
    """Long-term average visibility over the whole ephemeris (vectorised over cells)."""
    eph = json.loads((WEB_DATA / "ephemeris.json").read_text())
    stride = max(1, int(every_h * 3600 / eph["stepSeconds"]))
    sun = np.array(eph["sun"]).reshape(-1, 3)[::stride] * 1000
    earth = np.array(eph["earth"]).reshape(-1, 3)[::stride] * 1000
    c = -HALF_EXTENT_M + (np.arange(n) + 0.5) * step
    X, Y = np.meshgrid(c, -c)
    x0, y0 = X.ravel(), Y.ravel()
    rho = np.hypot(x0, y0)
    lat = -(np.pi / 2 - 2 * np.arctan(rho / (2 * MOON_R)))
    lon = np.arctan2(x0, y0)
    up = np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], 1)
    east = np.stack([-np.sin(lon), np.cos(lon), np.zeros_like(lon)], 1)
    north = np.stack([-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)], 1)
    n_az = hz.shape[0]
    hzT = np.nan_to_num(hz.T, nan=90.0)  # (cells, az)
    res = []
    for body, radius in ((sun, SUN_RADIUS_KM), (earth, EARTH_RADIUS_KM)):
        acc = np.zeros(len(x0))
        for p in body:
            dist = np.linalg.norm(p)
            s = p / dist
            r = math.degrees(math.asin(radius * 1000 / dist))
            el = np.degrees(np.arcsin(np.clip(up @ s, -1, 1)))
            az = np.degrees(np.arctan2(east @ s, north @ s)) % 360
            f = az / az_step
            i0 = f.astype(int) % n_az
            i1 = (i0 + 1) % n_az
            w = f - np.floor(f)
            idx = np.arange(len(x0))
            h = hzT[idx, i0] * (1 - w) + hzT[idx, i1] * w
            acc += disc_fraction(el - h, r)
        v = acc / len(body)
        v[np.isnan(hz[0])] = np.nan
        res.append(v)
    return res


def tiles_to_png(planes: np.ndarray, n: int, cols: int, path):
    rows = math.ceil(len(planes) / cols)
    img = np.zeros((rows * n, cols * n), dtype=np.uint8)
    for k, p in enumerate(planes):
        r, c = divmod(k, cols)
        img[r * n:(r + 1) * n, c * n:(c + 1) * n] = p.reshape(n, n)
    Image.fromarray(img, "L").save(path, optimize=True)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cell-km", type=float, default=1.0)
    ap.add_argument("--az-step", type=float, default=2.0)
    ap.add_argument("--dem-res", type=float, default=160.0)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"horizons: {a.cell_km} km cells, {a.az_step} deg azimuth bins, DEM at {a.dem_res} m")
    hz, n, step = horizons(a.cell_km * 1000, a.az_step, a.dem_res)
    dn = np.where(np.isnan(hz), 0, np.clip(np.round((hz - ELEV_OFFSET) / ELEV_SCALE), 1, 255)).astype(np.uint8)
    cols = int(math.ceil(math.sqrt(len(dn))))
    rows = tiles_to_png(dn, n, cols, OUT / "grid.png")

    print("baseline over the full ephemeris...")
    sun, earth = baseline(hz, n, step, a.az_step)
    base = np.stack([sun, earth])
    base_dn = np.where(np.isnan(base), 0, np.clip(np.round(base * 254), 0, 254) + 1).astype(np.uint8)
    tiles_to_png(base_dn, n, 2, OUT / "baseline.png")

    meta = dict(
        projection="polar-south", n=n, cellM=step, halfExtentM=HALF_EXTENT_M,
        azStepDeg=a.az_step, nAz=len(dn), tileCols=cols, tileRows=rows,
        elevOffset=ELEV_OFFSET, elevScale=ELEV_SCALE, file="grid.png",
        baseline=dict(file="baseline.png", tiles=["sun", "earth"], scale=1 / 254, offset=-1 / 254),
        source="Horizons from LOLA LDEM 80S (80 m, sampled at %d m); ephemeris NAIF SPICE" % a.dem_res,
    )
    (OUT / "index.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {OUT} ({n}x{n} cells)")


if __name__ == "__main__":
    main()
