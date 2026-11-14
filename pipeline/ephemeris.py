"""Sun and Earth positions seen from the Moon, in the Moon-fixed MOON_ME frame (the frame of all LOLA
maps), computed with NASA's SPICE toolkit and exported for the browser.

    python pipeline/ephemeris.py [--start 2026-01-01 --end 2031-01-01 --step-hours 2]

Output: web/public/data/ephemeris.json  {frame, startUtc, stepSeconds, count, sun[], earth[]}  (km, xyz)
The browser interpolates linearly (the Sun moves ~1° per 2 h in this frame; error is negligible).

Validation idea for the judges: compare a site's Sun azimuth/elevation with JPL Horizons
(observer = coordinates on body 301), see docs/PLAN.md.
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import spiceypy as sp

from config import KERNEL_FILES, KERNELS, WEB_DATA


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2031-01-01")
    ap.add_argument("--step-hours", type=float, default=2.0)
    a = ap.parse_args()

    for name in KERNEL_FILES:
        sp.furnsh(str(KERNELS / name))
    # MOON_ME is an alias defined by moon_assoc_me.tf; fall back to the explicit DE440 frame name
    frame = "MOON_ME" if sp.namfrm("MOON_ME") else "MOON_ME_DE440_ME421"

    et0 = sp.str2et(f"{a.start}T00:00:00")
    et1 = sp.str2et(f"{a.end}T00:00:00")
    step = a.step_hours * 3600
    ets = np.arange(et0, et1 + 1, step)
    # 'LT+S': apparent direction (light time + stellar aberration), what an observer on the Moon sees
    sun, _ = sp.spkpos("SUN", ets, frame, "LT+S", "MOON")
    earth, _ = sp.spkpos("EARTH", ets, frame, "LT+S", "MOON")
    sun, earth = np.asarray(sun), np.asarray(earth)

    out = {
        "frame": frame,
        "startUtc": sp.et2utc(et0, "ISOC", 0) + "Z",
        "stepSeconds": step,
        "count": len(ets),
        "units": "km",
        "sun": np.round(sun.ravel()).astype(np.int64).tolist(),
        "earth": np.round(earth.ravel(), 1).tolist(),
    }
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    path = WEB_DATA / "ephemeris.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    sub = sun[0] / np.linalg.norm(sun[0])
    print(f"{frame}: {len(ets)} samples {a.start}..{a.end} -> {path} ({path.stat().st_size / 1e6:.1f} MB)")
    print(f"sub-solar point at start: lat {np.degrees(np.arcsin(sub[2])):.2f}°, lon {np.degrees(np.arctan2(sub[1], sub[0])):.2f}°")


if __name__ == "__main__":
    main()
