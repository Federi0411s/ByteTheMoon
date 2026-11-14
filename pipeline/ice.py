"""Generate lunar south-pole ice layers from the Diviner PRP and M3 data."""

import argparse
import re
from pathlib import Path

import numpy as np
import pandas as pd

from lunar_ice import distance_to_ice, export_layer, ice_layer, load_m3_points, load_prp

PIPELINE_DIR = Path(__file__).resolve().parent
REPO_DIR = PIPELINE_DIR.parent
DATA_DIR = PIPELINE_DIR / "data"
PRP_TAB = DATA_DIR / "DLRE_PRP_SOUTH.TAB"
PRP_LABEL = DATA_DIR / "DLRE_PRP_SOUTH.LBL"
M3_CSV = DATA_DIR / "li2018_south.csv"
GRID_CSV = REPO_DIR / "web" / "public" / "data" / "charging_points.csv"
OUTPUT_DIR = REPO_DIR / "web" / "public" / "data"

# DA VERIFICARE NEL FILE .LBL: 0-based indices cross-checked against the
# PDS product field definitions for DLRE_PRP_SOUTH.
COL_LAT = 10
COL_LON = 9
COL_TMAX = 13
COL_DEPTH = 14
DEPTH_SCALE = 1.0  # PDS field unit is meter.


def _require_file(path: Path) -> None:
    if not path.is_file():
        raise SystemExit(f"Required input file is missing: {path}")


def _validate_prp_label() -> None:
    label = PRP_LABEL.read_text(encoding="ascii", errors="replace")
    if "DLRE_PRP_SOUTH.TAB" not in label.upper():
        raise ValueError(f"{PRP_LABEL} does not describe DLRE_PRP_SOUTH.TAB")
    if not re.search(r"\bCOLUMNS\s*=\s*15\b", label, flags=re.IGNORECASE):
        raise ValueError(f"{PRP_LABEL} does not describe the expected 15-column PRP table")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-subsurface", action="store_true",
                        help="also put class 1 (ice thermally stable within 0.5 m) in the web GeoJSON")
    args = parser.parse_args()

    _require_file(PRP_TAB)
    _require_file(PRP_LABEL)
    _require_file(GRID_CSV)
    _validate_prp_label()

    grid = pd.read_csv(GRID_CSV, usecols=["lat", "lon"])
    lat_grid = grid["lat"].to_numpy(dtype=float)
    lon_grid = grid["lon"].to_numpy(dtype=float)
    if not np.isfinite(lat_grid).all() or not np.isfinite(lon_grid).all():
        raise ValueError(f"{GRID_CSV} contains non-finite latitude or longitude values")

    prp = load_prp(PRP_TAB, col_lat=COL_LAT, col_lon=COL_LON,
                   col_tmax=COL_TMAX, col_depth=COL_DEPTH, depth_scale=DEPTH_SCALE)
    m3 = load_m3_points(M3_CSV) if M3_CSV.is_file() else None
    if m3 is None:
        print(f"Optional M3 data not found: {M3_CSV}; proceeding without M3 points.")

    layer = ice_layer(lat_grid, lon_grid, prp, m3)
    distance_km = distance_to_ice(lat_grid, lon_grid, layer, min_class=2) / 1000.0

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    export_layer(layer, OUTPUT_DIR / "mappa_ghiaccio", geojson_min_class=1 if args.include_subsurface else 2)
    pd.DataFrame({
        "lat": lat_grid,
        "lon": lon_grid,
        "dist_ice_km": distance_km,
    }).to_csv(OUTPUT_DIR / "distanza_ghiaccio.csv", index=False)
    print(f"Saved ice-distance grid: {OUTPUT_DIR / 'distanza_ghiaccio.csv'}")


if __name__ == "__main__":
    main()
