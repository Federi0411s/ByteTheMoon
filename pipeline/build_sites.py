"""Preset landing sites + their terrain horizon masks -> web/public/data/sites.json

    python pipeline/build_sites.py

- Historic / recent landing sites: fixed coordinates (published values; double-check before quoting).
- South-pole regions: for each named feature (IAU gazetteer), the pipeline picks the best-lit spot
  within the feature's neighbourhood that is flat enough to land (LOLA average illumination + slope).
  This is data-driven and reproducible, and the method is explainable to judges.
- Horizon masks: for each azimuth, march outward along the great circle over the LOLA DEM and keep the
  highest elevation angle, including lunar curvature (no atmosphere, so no refraction).
"""
from __future__ import annotations

import json

import numpy as np
import rasterio
import shapefile
from pyproj import Transformer

from config import GLOBAL_LDEM, MOON_GEOG, MOON_R, NOMENCLATURE_SHP, RAW, WEB_DATA, find_local
from rasters import LonLatSampler, physical

AZ_STEP = 0.5
MAX_DIST_M = 200_000
OBSERVER_H = 2.0

FIXED_SITES = [
    # id, name, lat, lon, group, note
    ("apollo11", "Apollo 11 · Tranquility Base", 0.6741, 23.4730, "Apollo"),
    ("apollo12", "Apollo 12", -3.0124, -23.4216, "Apollo"),
    ("apollo14", "Apollo 14", -3.6453, -17.4714, "Apollo"),
    ("apollo15", "Apollo 15 · Hadley–Apennine", 26.1322, 3.6339, "Apollo"),
    ("apollo16", "Apollo 16 · Descartes", -8.9730, 15.5002, "Apollo"),
    ("apollo17", "Apollo 17 · Taurus–Littrow", 20.1908, 30.7717, "Apollo"),
    ("change3", "Chang'e 3", 44.1214, -19.5116, "Other missions"),
    ("change4", "Chang'e 4 · von Kármán", -45.4446, 177.5991, "Other missions"),
    ("change6", "Chang'e 6 · Apollo basin", -41.6385, -153.9852, "Other missions"),
    ("chandrayaan3", "Chandrayaan-3 · Shiv Shakti", -69.3733, 32.3191, "Other missions"),
    ("im1", "IM-1 Odysseus · Malapert A", -80.13, 1.44, "CLPS"),
    ("blueghost1", "Blue Ghost M1 · Mare Crisium", 18.56, 61.81, "CLPS"),
]

# (IAU feature name, label, group, search radius km). Names match NASA's announced Artemis III regions
# where applicable; the exact candidate polygons are not public as data, so we pick spots by data.
POLAR_FEATURES = [
    ("Shackleton", "Shackleton rim", "South pole (best-lit spot near feature)", 18),
    ("de Gerlache", "de Gerlache rim", "Artemis III candidate regions", 22),
    ("Haworth", "Haworth", "Artemis III candidate regions", 35),
    ("Mons Malapert", "Malapert Massif", "Artemis III candidate regions", 30),
    ("Mons Mouton", "Mons Mouton", "Artemis III candidate regions", 30),
    ("Nobile", "Nobile rim", "Artemis III candidate regions", 45),
    ("Slater", "Slater plain", "Artemis III candidate regions", 25),
    ("Cabeus", "Cabeus region", "Artemis III candidate regions", 40),
    ("Faustini", "Faustini rim", "South pole (best-lit spot near feature)", 30),
]


def iau_features() -> dict[str, tuple[float, float, float]]:
    shp = find_local(NOMENCLATURE_SHP)
    if not shp:
        print("  IAU nomenclature shapefile not found; skipping polar features")
        return {}
    r = shapefile.Reader(str(shp))
    out = {}
    for rec in r.iterRecords():
        d = rec.as_dict()
        lon = d["center_lon"] - 360 if d["center_lon"] > 180 else d["center_lon"]
        out[d["clean_name"]] = (d["center_lat"], lon, d["diameter"])
    return out


def best_lit_spot(lat: float, lon: float, radius_km: float, exclude=(), max_slope=10.0, min_sep_km=8.0):
    """Max average illumination within radius, restricted to slope <= max_slope and at least
    min_sep_km away from spots already chosen for other features (exclude = [(lat, lon), ...])."""
    sun_p, slope_p = RAW / "avgvisib_85s_060m_201608.lbl", RAW / "ldsm_85s_40m.lbl"
    if not sun_p.exists():
        return None
    with rasterio.open(sun_p) as src:
        tr = Transformer.from_crs(MOON_GEOG, src.crs, always_xy=True)
        x0, y0 = tr.transform(lon, lat)
        inv = ~src.transform
        c, r = inv * (x0, y0)
        half = int(radius_km * 1000 / abs(src.transform.a))
        win = rasterio.windows.Window(int(c) - half, int(r) - half, 2 * half, 2 * half)
        sun = physical(src, src.read(1, window=win, boundless=True, fill_value=src.nodata or 0))
        wt = src.window_transform(win)
    rows, cols = np.mgrid[0 : sun.shape[0], 0 : sun.shape[1]]
    xs, ys = wt * (cols + 0.5, rows + 0.5)
    inside = (xs - x0) ** 2 + (ys - y0) ** 2 <= (radius_km * 1000) ** 2
    if slope_p.exists():
        with rasterio.open(slope_p) as s2:
            raw = s2.read(1)
            sl = physical(s2, raw)
            sl[raw == 0] = np.nan  # LDSM: 0 = no data
            cc, rr = (~s2.transform) * (xs, ys)
            cc = np.clip(cc.astype(int), 0, s2.width - 1)
            rr = np.clip(rr.astype(int), 0, s2.height - 1)
            inside &= sl[rr, cc] <= max_slope
    for ela, elo in exclude:
        ex, ey = tr.transform(elo, ela)
        inside &= (xs - ex) ** 2 + (ys - ey) ** 2 > (min_sep_km * 1000) ** 2
    score = np.where(inside & ~np.isnan(sun), sun, -1)
    k = np.unravel_index(np.argmax(score), score.shape)
    if score[k] < 0:
        return None
    lon_b, lat_b = Transformer.from_crs(src.crs, MOON_GEOG, always_xy=True).transform(xs[k], ys[k])
    return float(lat_b), float(lon_b), float(sun[k])


def dem_for(lat: float) -> list:
    """DEMs to use, finest first."""
    cands = []
    if lat < -80:
        for stem in ("ldem_85s_20m", "ldem_80s_80m"):
            p = RAW / f"{stem}.lbl"
            if p.exists():
                cands.append(p)
    g = find_local(GLOBAL_LDEM)
    if g and abs(lat) < 75:
        cands.append(g)
    return cands


def horizon(lat: float, lon: float) -> tuple[list[float], str, float] | None:
    paths = dem_for(lat)
    if not paths:
        return None
    samplers = []
    for p in paths:
        try:
            samplers.append(LonLatSampler(p, lat, lon, MAX_DIST_M))
        except Exception as e:  # e.g. partially downloaded file
            print(f"    {p.name}: {e}")
    if not samplers:
        return None

    def sample(lo, la):
        v = np.full(np.shape(lo), np.nan)
        for s in samplers:  # finest first, coarser DEMs fill the gaps
            m = np.isnan(v)
            if m.any():
                v[m] = s.sample(lo[m], la[m])
        return v

    az = np.deg2rad(np.arange(0, 360, AZ_STEP))[:, None]
    d = samplers[0].resolution_m * 1.02 ** np.arange(0, 2000)
    d = d[d < MAX_DIST_M][None, :]
    th = d / MOON_R
    la0, lo0 = np.deg2rad(lat), np.deg2rad(lon)
    la = np.arcsin(np.sin(la0) * np.cos(th) + np.cos(la0) * np.sin(th) * np.cos(az))
    lo = lo0 + np.arctan2(np.sin(az) * np.sin(th) * np.cos(la0), np.cos(th) - np.sin(la0) * np.sin(la))
    h = sample(np.rad2deg(lo), np.rad2deg(la))
    h0 = sample(np.array([lon]), np.array([lat]))[0]
    hs = (0.0 if np.isnan(h0) else h0) + OBSERVER_H
    rt = MOON_R + h
    el = np.degrees(np.arctan2(rt * np.cos(th) - (MOON_R + hs), rt * np.sin(th)))
    # stop at the first missing sample along each ray (left the DEM)
    valid = np.cumprod(~np.isnan(h), axis=1).astype(bool)
    el = np.where(valid, el, -90).max(axis=1)
    return [round(float(e), 3) for e in el], " + ".join(s.path.stem for s in samplers), float(hs - OBSERVER_H)


def main() -> None:
    sites = [dict(id=i, name=n, lat=la, lon=lo, group=g) for i, n, la, lo, g in FIXED_SITES]
    feats = iau_features()
    for name, label, group, rad in POLAR_FEATURES:
        if name not in feats:
            continue
        flat, flon, _ = feats[name]
        spot = best_lit_spot(flat, flon, rad, exclude=[(x["lat"], x["lon"]) for x in sites if x["lat"] < -80])
        if spot:
            la, lo, lit = spot
            sites.append(dict(id=name.lower().replace(" ", "-"), name=label, lat=round(la, 4), lon=round(lo, 4), group=group,
                              note=f"Best-lit spot (avg. {lit * 100:.0f}% sunlit, slope ≤ 10°) within {rad} km of {name} (IAU)."))
        else:
            print(f"  {name}: illumination data missing, using IAU centre")
            sites.append(dict(id=name.lower().replace(" ", "-"), name=f"{label} (centre)", lat=flat, lon=flon, group=group))

    for s in sites:
        hz = horizon(s["lat"], s["lon"])
        if hz:
            s["horizon"] = {"azStepDeg": AZ_STEP, "elevDeg": hz[0], "source": hz[1]}
            s["heightM"] = round(hz[2], 1)
            print(f"  {s['name']:<32} {s['lat']:9.4f} {s['lon']:9.4f}  horizon max {max(hz[0]):5.2f}°  ({hz[1]})")
        else:
            print(f"  {s['name']:<32} {s['lat']:9.4f} {s['lon']:9.4f}  no DEM -> flat horizon")
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "sites.json").write_text(json.dumps({"sites": sites}, separators=(",", ":")))
    print(f"{len(sites)} sites -> {WEB_DATA / 'sites.json'}")


if __name__ == "__main__":
    main()
