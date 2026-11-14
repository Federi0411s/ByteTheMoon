"""Sun and Earth positions seen from the Moon, in the Moon-fixed MOON_ME frame (the frame of all LOLA
maps), computed with NASA's SPICE toolkit and exported for the browser.

    python pipeline/ephemeris.py [--start 2026-01-01 --end 2031-01-01 --step-hours 2]
    python pipeline/ephemeris.py --start 2026-01-01 --end 2206-01-01 --chunk-years 5

Output: web/public/data/ephemeris.json  {frame, startUtc, stepSeconds, count, sun[], earth[]}  (km, xyz)
Chunked output keeps the initial 2026-2031 file at that path and writes later chunks to
web/public/data/ephemeris/{start-year}.json.
The browser interpolates linearly (the Sun moves ~1° per 2 h in this frame; error is negligible).

Validation idea for the judges: compare a site's Sun azimuth/elevation with JPL Horizons
(observer = coordinates on body 301), see docs/PLAN.md.
"""
from __future__ import annotations

import argparse
import json
from datetime import date

import numpy as np
import spiceypy as sp

from config import KERNEL_FILES, KERNELS, WEB_DATA


def add_years(d: date, years: int) -> date:
    return d.replace(year=d.year + years)


def calculate(start: date, end: date, frame: str, step: float) -> dict:
    et0 = sp.str2et(f"{start.isoformat()}T00:00:00")
    et1 = sp.str2et(f"{end.isoformat()}T00:00:00")
    ets = np.arange(et0, et1 + 1, step)
    # 'LT+S': apparent direction (light time + stellar aberration), what an observer on the Moon sees
    sun, _ = sp.spkpos("SUN", ets, frame, "LT+S", "MOON")
    earth, _ = sp.spkpos("EARTH", ets, frame, "LT+S", "MOON")
    return {
        "frame": frame,
        "startUtc": sp.et2utc(et0, "ISOC", 0) + "Z",
        "stepSeconds": step,
        "count": len(ets),
        "units": "km",
        "sun": np.round(np.asarray(sun).ravel()).astype(np.int64).tolist(),
        "earth": np.round(np.asarray(earth).ravel(), 1).tolist(),
    }


def write_ephemeris(data: dict, path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"  {data['startUtc'][:10]}: {data['count']} samples -> {path} ({path.stat().st_size / 1e6:.1f} MB)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2031-01-01")
    ap.add_argument("--step-hours", type=float, default=2.0)
    ap.add_argument("--chunk-years", type=int, help="split the range into consecutive year-aligned files")
    a = ap.parse_args()

    for name in KERNEL_FILES:
        sp.furnsh(str(KERNELS / name))
    # MOON_ME is an alias defined by moon_assoc_me.tf; fall back to the explicit DE440 frame name
    frame = "MOON_ME" if sp.namfrm("MOON_ME") else "MOON_ME_DE440_ME421"

    step = a.step_hours * 3600
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    if start >= end:
        ap.error("--start must be earlier than --end")
    if a.chunk_years is not None:
        if a.chunk_years <= 0 or start.month != 1 or start.day != 1 or end.month != 1 or end.day != 1:
            ap.error("--chunk-years requires a positive size and Jan 1 start/end dates")
        chunk_start = start
        while chunk_start < end:
            chunk_end = min(add_years(chunk_start, a.chunk_years), end)
            out = calculate(chunk_start, chunk_end, frame, step)
            path = WEB_DATA / "ephemeris.json" if chunk_start == date(2026, 1, 1) else WEB_DATA / "ephemeris" / f"{chunk_start.year}.json"
            write_ephemeris(out, path)
            chunk_start = chunk_end
        return

    out = calculate(start, end, frame, step)
    write_ephemeris(out, WEB_DATA / "ephemeris.json")
    first_sun = np.asarray(out["sun"][:3], dtype=np.float64)
    first_sun /= np.linalg.norm(first_sun)
    print(f"{frame}: {a.start}..{a.end}")
    print(f"sub-solar point at start: lat {np.degrees(np.arcsin(first_sun[2])):.2f}°, lon {np.degrees(np.arctan2(first_sun[1], first_sun[0])):.2f}°")


if __name__ == "__main__":
    main()
