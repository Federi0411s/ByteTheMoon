"""
Fraction of time the Earth is visible above the local terrain horizon, for the south-polar map points.

Method:
  - DEM: LOLA polar DEM (RAW/ldem_80s_80m.lbl, or the web overlay dem_south.png, LOLA at 240 m),
    extended to 70S with the shipped LOLA global DEM tiles (web/public/data/dem/5, 666 m), so rays
    toward the Earth do not leave the DEM near the 80S edge of the map.
  - Horizons: lunar_horizon.HorizonModel (ray marching with Moon curvature), only over the azimuth
    window the Earth sweeps for each point (libration), not the full 360 degrees.
  - Earth: SPICE apparent Earth position in MOON_ME (web/public/data/ephemeris.json), with the
    site->Earth parallax; the visible fraction of the Earth disc counts (as in the web heatmap worker, web/src/lib/heatWorker.ts).

Outputs (same grid as charging_points.csv: 4 km, 80S-90S square, polar stereographic):
  web/public/data/overlays/earth_visibility.png   u8 layer + entry in overlays/index.json
  web/public/data/earth_visibility_points.csv     lat, lon, earth_vis_frac, earth_any_frac,
                                                  max_blackout_days (longest continuous run with the
                                                  Earth fully below the horizon)
  web/public/data/earth_visibility_sites.csv      the same metrics at the candidate sites (lat < -80)

    python pipeline/earth_visibility.py [--step-hours 6 --resolution-m 4000 --observer-height 2]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from charging import encode_layer, reproject_dem, terrain_geometry
from config import MOON_GEOG, MOON_R, RAW, SOUTH_STERE, WEB_DATA
from lunar_horizon import HorizonModel

EARTH_RADIUS_M = 6_371_000.0
HORIZON_LAT_LIMIT = -70.0   # the horizon DEM extends to this latitude
GLOBAL_TILE_LEVEL = 5       # 666 m/px, shipped with the web app
LAYER = {
    "id": "earth_visibility",
    "title": "Earth visibility (80S, terrain horizon)",
    "description": "Fraction of time the Earth disc is above the local terrain horizon (LOLA DEM + SPICE); "
                   "direct-to-Earth comms. Covers 80S-90S, unlike the 85S LOLA product.",
    "units": "fraction",
    "colormap": "cividis",
}


# ---------------------------------------------------------------- DEM for the horizons
def global_tiles_dem(level: int, lat_limit: float):
    """Mosaic of the shipped LOLA global DEM tiles south of lat_limit (equirectangular, metres)."""
    base = WEB_DATA / "dem"
    meta = json.loads((base / "index.json").read_text(encoding="utf-8"))
    size = meta["tileSize"]
    n_x, n_y = 2 ** (level + 1), 2 ** level
    tile_deg = 180.0 / n_y
    y0 = int((90.0 - lat_limit) // tile_deg)
    mosaic = np.full(((n_y - y0) * size, n_x * size), np.nan, dtype=np.float32)
    for ty in range(y0, n_y):
        for tx in range(n_x):
            path = base / str(level) / str(tx) / f"{ty}.{meta['format']}"
            if not path.exists():
                continue
            rgb = np.asarray(Image.open(path).convert("RGB"))
            dn = rgb[..., 0].astype(np.float32) * 256 + rgb[..., 1]
            tile = np.where(rgb[..., 2] > 0, dn * meta["scale"] + meta["offset"], np.nan)
            mosaic[(ty - y0) * size:(ty - y0 + 1) * size, tx * size:(tx + 1) * size] = tile
    px = tile_deg / size
    transform = from_origin(-180.0, 90.0 - y0 * tile_deg, px, px)
    return mosaic, transform


def horizon_dem(dem_path: Path, res_m: float):
    """Polar DEM at res_m, padded out to HORIZON_LAT_LIMIT and filled there from the global tiles."""
    polar, half = reproject_dem(dem_path, res_m)
    target_half = 2 * MOON_R * math.tan(math.radians((90 + HORIZON_LAT_LIMIT) / 2))
    pad = max(0, int(math.ceil((target_half - half) / res_m)))
    Z = np.full((polar.shape[0] + 2 * pad, polar.shape[1] + 2 * pad), np.nan, dtype=np.float32)
    Z[pad:pad + polar.shape[0], pad:pad + polar.shape[1]] = polar
    half += pad * res_m

    mosaic, src_t = global_tiles_dem(GLOBAL_TILE_LEVEL, HORIZON_LAT_LIMIT - 1)
    glob = np.full_like(Z, np.nan)
    reproject(source=mosaic, destination=glob, src_transform=src_t, src_crs=MOON_GEOG, src_nodata=np.nan,
              dst_transform=from_origin(-half, half, res_m, res_m), dst_crs=SOUTH_STERE, dst_nodata=np.nan,
              resampling=Resampling.bilinear)
    filled = np.isnan(Z) & np.isfinite(glob)
    Z[filled] = glob[filled]
    print(f"  horizon DEM {Z.shape[1]}x{Z.shape[0]} at {res_m:g} m, to {abs(HORIZON_LAT_LIMIT):g}S "
          f"({filled.mean():.0%} of cells from the global {GLOBAL_TILE_LEVEL}-level tiles)")
    c = -half + (np.arange(Z.shape[1]) + 0.5) * res_m
    # outside any DEM: very low, so it never raises the horizon
    return np.nan_to_num(Z, nan=-1e9), c, -c


# ---------------------------------------------------------------- Earth visibility
def disc_fraction(dh, r):
    """Visible fraction of a disc of angular radius r whose centre is dh above the horizon."""
    x = np.clip(dh / r, -1, 1)
    return 1 - (np.arccos(x) - x * np.sqrt(1 - x * x)) / np.pi


def max_run(hidden: np.ndarray) -> np.ndarray:
    """Longest run of consecutive True along axis 0. hidden: (T, N) bool -> (N,) int."""
    cur = np.zeros(hidden.shape[1], dtype=np.int32)
    best = np.zeros_like(cur)
    for row in hidden:
        cur = (cur + 1) * row
        np.maximum(best, cur, out=best)
    return best


def earth_visibility(model: HorizonModel, x, y, earth_m, az_step=0.5, margin_deg=2.0,
                     max_dist=200e3, chunk=500):
    """
    x, y    : (N,) polar stereographic coordinates [m] of the points
    earth_m : (T, 3) Moon->Earth vectors in MOON_ME [m]
    returns  mean visible disc fraction, fraction of time with any part visible, longest blackout
             in samples; all (N,)
    """
    to_geo = Transformer.from_crs(SOUTH_STERE, MOON_GEOG, always_xy=True)
    lon, lat = to_geo.transform(x, y)
    lat, lon = np.radians(lat), np.radians(lon)
    up = np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], 1)
    east = np.stack([-np.sin(lon), np.cos(lon), np.zeros_like(lon)], 1)
    north = np.stack([-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)], 1)
    h0 = model.height_at(x, y) + model.h_obs

    N = len(x)
    frac, anyv, blackout = np.zeros(N), np.zeros(N), np.zeros(N, dtype=np.int32)
    t0 = time.time()
    for s in range(0, N, chunk):
        e = slice(s, min(s + chunk, N))
        # site -> Earth in the local frame; the site sits at (R + h) * up, so only the up part changes
        vu = earth_m @ up[e].T - (MOON_R + h0[e])        # (T, n)
        ve = earth_m @ east[e].T
        vn = earth_m @ north[e].T
        dist = np.sqrt(vu * vu + ve * ve + vn * vn)
        el = np.degrees(np.arcsin(vu / dist))
        az = np.degrees(np.arctan2(ve, vn)) % 360.0
        r = np.degrees(np.arcsin(EARTH_RADIUS_M / dist))
        del ve, vn, vu, dist

        # only points where the Earth ever gets near the horizon need ray tracing (a 5 km peak dips < 4.5 deg)
        need = (el + r).max(0) > -6.0
        hz = np.full(el.shape, 90.0)
        if need.any():
            a = np.radians(az[:, need])
            center = np.degrees(np.arctan2(np.sin(a).mean(0), np.cos(a).mean(0)))
            dev = (az[:, need] - center + 180.0) % 360.0 - 180.0
            half = np.abs(dev).max(0) + margin_deg
            K = int(np.ceil(2 * half.max() / az_step)) + 1
            u = np.linspace(-1.0, 1.0, K)
            az_tab = (center[:, None] + u[None, :] * half[:, None]) % 360.0      # (m, K)
            idx = np.flatnonzero(need) + s
            table = model.horizon(x[idx], y[idx], az_tab, max_dist=max_dist)    # (m, K)
            # linear interpolation in the per-point azimuth window
            f = np.clip((dev / half + 1.0) / 2.0 * (K - 1), 0, K - 1)            # (T, m)
            i0 = np.minimum(f.astype(int), K - 2)
            w = f - i0
            cols = np.arange(len(idx))
            hz[:, need] = table[cols, i0] * (1 - w) + table[cols, i0 + 1] * w

        vis = disc_fraction(el - hz, r)
        frac[e] = vis.mean(0)
        anyv[e] = (vis > 0).mean(0)
        blackout[e] = max_run(vis <= 0)
        done = e.stop
        print(f"  {done:6d}/{N} points  {time.time() - t0:6.1f}s")
    return frac, anyv, blackout


# ---------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description="Earth visibility over the south-polar map points (LOLA DEM + SPICE)")
    ap.add_argument("--dem", type=Path, help="LOLA DEM (.lbl/.tif) or the generated dem_south.png overlay")
    ap.add_argument("--ephemeris", type=Path, default=WEB_DATA / "ephemeris.json")
    ap.add_argument("--output-dir", type=Path, default=WEB_DATA)
    ap.add_argument("--sites", type=Path, default=WEB_DATA / "sites.json")
    ap.add_argument("--resolution-m", type=float, default=4000.0, help="map grid (4000 = charging_points.csv)")
    ap.add_argument("--dem-res", type=float, default=240.0, help="DEM resolution for the horizons [m]")
    ap.add_argument("--step-hours", type=float, default=6.0, help="ephemeris sampling")
    ap.add_argument("--observer-height", type=float, default=2.0, help="antenna height above ground [m]")
    ap.add_argument("--max-dist-km", type=float, default=200.0, help="ray length for the horizons")
    a = ap.parse_args()
    if min(a.resolution_m, a.dem_res, a.step_hours, a.max_dist_km) <= 0 or a.observer_height < 0:
        ap.error("resolutions, step and ray length must be positive; observer height cannot be negative")

    dem_path = a.dem or RAW / "ldem_80s_80m.lbl"
    if a.dem is None and not dem_path.exists():
        dem_path = WEB_DATA / "overlays" / "dem_south.png"
    for p in (dem_path, a.ephemeris):
        if not p.exists():
            raise SystemExit(f"Required input not found: {p}")

    eph = json.loads(a.ephemeris.read_text(encoding="utf-8"))
    if eph.get("units", "km") != "km" or eph.get("frame") not in ("MOON_ME", "MOON_ME_DE440_ME421"):
        raise ValueError(f"Unexpected ephemeris frame/units: {eph.get('frame')} {eph.get('units')}")
    stride = max(1, round(a.step_hours * 3600 / eph["stepSeconds"]))
    step_h = eph["stepSeconds"] * stride / 3600
    earth = np.asarray(eph["earth"], dtype=float).reshape(-1, 3)[::stride] * 1000.0
    print(f"Ephemeris: {len(earth)} epochs every {step_h:g} h from {eph['startUtc']} ({eph['frame']})")

    print(f"DEM: {dem_path}")
    Z, xs, ys = horizon_dem(dem_path, a.dem_res)
    model = HorizonModel(Z, xs, ys, R=MOON_R, observer_height=a.observer_height)
    del Z

    # output grid: identical to charging.py (same extent, resolution and valid-pixel mask)
    grid, half = reproject_dem(dem_path, a.resolution_m)
    valid_indices, _, _ = terrain_geometry(grid, half, a.resolution_m)
    valid = np.zeros(grid.size, dtype=bool)
    valid[valid_indices] = True
    valid = valid.reshape(grid.shape)
    rows, cols = np.unravel_index(valid_indices, grid.shape)
    gx = -half + (cols + 0.5) * a.resolution_m
    gy = half - (rows + 0.5) * a.resolution_m
    print(f"Computing Earth visibility for {len(gx):,} map points...")
    frac, anyv, blackout = earth_visibility(model, gx, gy, earth, max_dist=a.max_dist_km * 1e3)
    blackout_days = blackout * step_h / 24.0

    # ---- overlay layer
    overlay_dir = a.output_dir / "overlays"
    overlay_dir.mkdir(parents=True, exist_ok=True)
    values = np.full(grid.shape, np.nan, dtype=np.float32)
    values[rows, cols] = frac
    encoded, scale, offset = encode_layer(values, valid, 0.0, 1.0)
    image_path = overlay_dir / f"{LAYER['id']}.png"
    Image.fromarray(encoded).save(image_path, optimize=True)
    index_path = overlay_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"layers": []}
    meta = {
        **LAYER,
        "source": f"LOLA DEM ({dem_path.name}, {a.dem_res:g} m; global LDEM tiles beyond 80S) + NASA SPICE "
                  f"({len(earth)} epochs every {step_h:g} h, {eph['startUtc'][:10]} onward), "
                  f"observer {a.observer_height:g} m",
        "file": image_path.name,
        "projection": "polar-south",
        "width": grid.shape[1],
        "height": grid.shape[0],
        "halfExtentM": half,
        "encoding": "u8",
        "min": 0.0,
        "max": 1.0,
        "scale": scale,
        "offset": offset,
        "resolutionM": a.resolution_m,
        "display": True,
    }
    index["layers"] = [layer for layer in index.get("layers", []) if layer["id"] != LAYER["id"]] + [meta]
    index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"  {LAYER['id']}: {image_path} ({image_path.stat().st_size / 1e3:.0f} kB), index updated")

    # ---- points CSV
    to_geo = Transformer.from_crs(SOUTH_STERE, MOON_GEOG, always_xy=True)
    lon, lat = to_geo.transform(gx, gy)
    lon = (lon + 180.0) % 360.0 - 180.0
    header = ("lat", "lon", "earth_vis_frac", "earth_any_frac", "max_blackout_days")
    points_path = a.output_dir / "earth_visibility_points.csv"
    with points_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows((f"{lat[i]:.6f}", f"{lon[i]:.6f}", f"{frac[i]:.4f}", f"{anyv[i]:.4f}",
                     f"{blackout_days[i]:.2f}") for i in range(len(gx)))
    print(f"{len(gx):,} map points -> {points_path}")

    # ---- candidate sites, computed at their own coordinates
    if a.sites.exists():
        sites = [s for s in json.loads(a.sites.read_text(encoding="utf-8")).get("sites", []) if s["lat"] <= -80]
        if sites:
            to_map = Transformer.from_crs(MOON_GEOG, SOUTH_STERE, always_xy=True)
            sx, sy = to_map.transform([s["lon"] for s in sites], [s["lat"] for s in sites])
            sf, sa, sb = earth_visibility(model, np.asarray(sx), np.asarray(sy), earth,
                                          max_dist=a.max_dist_km * 1e3)
            sites_path = a.output_dir / "earth_visibility_sites.csv"
            with sites_path.open("w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(("id", "name", *header))
                for s, v1, v2, v3 in zip(sites, sf, sa, sb):
                    w.writerow((s["id"], s["name"], s["lat"], s["lon"], f"{v1:.4f}", f"{v2:.4f}",
                                f"{v3 * step_h / 24.0:.2f}"))
            print(f"{len(sites)} sites -> {sites_path}")

    print(f"Done: Earth visible on average {frac.mean():.1%} of the time; "
          f"{(frac > 0.5).mean():.0%} of points see it more than half the time.")


if __name__ == "__main__":
    main()
