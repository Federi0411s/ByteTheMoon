"""Generate lunar surface-charging overlays from LOLA terrain and SPICE ephemerides.

    python pipeline/charging.py --csv pipeline/equipot_results.csv

The generated heatmaps use DEM-derived surface normals and a flat local horizon. They
are sampled at a configurable map resolution and ephemeris interval to keep the offline
calculation practical.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from lunar_charging import ChargingModel, surface_charging_over_ephemeris
from lunar_thermal import (
    RegolithThermal,
    ThermalStats,
    absorbed_flux,
    equilibrium_temperature,
)
from config import MOON_GEOG, MOON_R, RAW, SOUTH_STERE, WEB_DATA
from rasters import physical


MAP_LAYERS = (
    {
        "id": "charging_mean",
        "title": "Mean surface charging potential",
        "description": "Mean EQUIPOT surface potential over sampled SPICE epochs; DEM-derived normals, flat local horizon.",
        "min": -120,
        "max": 20,
        "units": "V",
        "colormap": "inferno",
    },
    {
        "id": "charging_min",
        "title": "Minimum surface charging potential",
        "description": "Minimum EQUIPOT surface potential over sampled SPICE epochs; DEM-derived normals, flat local horizon.",
        "min": -120,
        "max": 20,
        "units": "V",
        "colormap": "cividis",
    },
    {
        "id": "charging_frac_below",
        "title": "Time below threshold",
        "description": "Fraction of sampled epochs with EQUIPOT potential below -100 V; DEM-derived normals, flat local horizon.",
        "min": 0,
        "max": 1,
        "units": "fraction",
        "colormap": "ice",
    },
)

THERMAL_LAYERS = (
    {
        "id": "thermal_mean",
        "title": "Mean regolith temperature",
        "description": "Mean 1D regolith surface temperature; equilibrium estimate outside selected thermal sites.",
        "units": "K",
        "colormap": "inferno",
    },
    {
        "id": "thermal_min",
        "title": "Minimum regolith temperature",
        "description": "Minimum 1D regolith surface temperature; equilibrium estimate outside selected thermal sites.",
        "units": "K",
        "colormap": "cividis",
    },
    {
        "id": "thermal_max",
        "title": "Maximum regolith temperature",
        "description": "Maximum 1D regolith surface temperature; equilibrium estimate outside selected thermal sites.",
        "units": "K",
        "colormap": "inferno",
    },
)

AU_KM = 149_597_870.7


def terrain_geometry(
    elevation: np.ndarray,
    half_extent_m: float,
    resolution_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return valid pixel indices, DEM surface normals and local up vectors."""
    height, width = elevation.shape
    dy, dx = np.gradient(elevation, resolution_m, resolution_m)
    gx = dx
    gy = -dy  # image rows increase southward, while projected y increases northward

    rows, cols = np.indices(elevation.shape)
    x = -half_extent_m + (cols + 0.5) * resolution_m
    y = half_extent_m - (rows + 0.5) * resolution_m
    to_geo = Transformer.from_crs(SOUTH_STERE, MOON_GEOG, always_xy=True)
    lon_deg, lat_deg = to_geo.transform(x, y)
    lon, lat = np.deg2rad(lon_deg), np.deg2rad(lat_deg)

    # Polar stereographic scale factor: sec^2((90° + latitude) / 2).
    scale = 1.0 / np.cos((np.pi / 2 + lat) / 2) ** 2
    grad_east = (gx * np.cos(lon) - gy * np.sin(lon)) / scale
    grad_north = (gx * np.sin(lon) + gy * np.cos(lon)) / scale

    up = np.stack(
        (np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)),
        axis=-1,
    )
    east = np.stack((-np.sin(lon), np.cos(lon), np.zeros_like(lon)), axis=-1)
    north = np.stack(
        (-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)),
        axis=-1,
    )
    normal = up - grad_east[..., None] * east - grad_north[..., None] * north
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)

    valid = np.isfinite(elevation) & np.isfinite(normal).all(axis=-1)
    indices = np.flatnonzero(valid)
    return indices, normal.reshape(-1, 3)[indices], up.reshape(-1, 3)[indices]


def point_index_for_site(
    site: dict,
    to_map: Transformer,
    half_extent_m: float,
    resolution_m: float,
    size: int,
    point_lookup: np.ndarray,
) -> int | None:
    x, y = to_map.transform(site["lon"], site["lat"])
    col = int((x + half_extent_m) / resolution_m)
    row = int((half_extent_m - y) / resolution_m)
    if not (0 <= row < size and 0 <= col < size):
        return None
    point_index = int(point_lookup[row * size + col])
    return point_index if point_index >= 0 else None


def select_thermal_points(
    sites: list[dict],
    mode: str,
    to_map: Transformer,
    half_extent_m: float,
    resolution_m: float,
    size: int,
    point_lookup: np.ndarray,
    n_points: int,
) -> np.ndarray:
    if mode == "all":
        return np.arange(n_points, dtype=np.intp)

    candidates = [site for site in sites if "candidate" in site.get("group", "").lower()]
    if not candidates:
        raise ValueError("No candidate sites found in the --sites JSON")
    selected = {
        point_index
        for site in candidates
        if (point_index := point_index_for_site(
            site, to_map, half_extent_m, resolution_m, size, point_lookup
        )) is not None
    }
    if not selected:
        raise ValueError("No candidate sites fall on valid DEM pixels")
    print(f"Mapped {len(selected)} thermal points from {len(candidates)} candidate sites.")
    return np.asarray(sorted(selected), dtype=np.intp)


def solar_distance_au(sun_vector: np.ndarray, units: str | None) -> float:
    if units is None:
        return 1.0
    distance = float(np.linalg.norm(sun_vector))
    if not math.isfinite(distance) or distance <= 0:
        raise ValueError("Invalid Moon-Sun distance in ephemeris")
    if units.lower() == "km":
        return distance / AU_KM
    if units.lower() == "au":
        return distance
    raise ValueError(f"Unsupported ephemeris distance units: {units}")


def reproject_dem(dem_path: Path, resolution_m: float) -> tuple[np.ndarray, float]:
    half_extent = 2 * MOON_R * math.tan(math.radians(5))
    size = int(math.ceil(2 * half_extent / resolution_m))
    if size < 2:
        raise ValueError("--resolution-m is too large to produce a terrain grid")
    half_extent = size * resolution_m / 2
    elevation = np.full((size, size), np.nan, dtype=np.float32)

    if dem_path.suffix.lower() == ".png":
        index_path = dem_path.parent / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        meta = next((layer for layer in index["layers"] if layer["file"] == dem_path.name), None)
        if meta is None or meta["encoding"] != "u16":
            raise ValueError(f"No u16 raster metadata found for {dem_path}")
        encoded = np.asarray(Image.open(dem_path).convert("RGB"))
        dn = encoded[..., 0].astype(np.uint16) * 256 + encoded[..., 1].astype(np.uint16)
        source = np.where(encoded[..., 2] > 0, dn * meta["scale"] + meta["offset"], np.nan).astype(np.float32)
        source_transform = from_origin(
            -meta["halfExtentM"],
            meta["halfExtentM"],
            2 * meta["halfExtentM"] / meta["width"],
            2 * meta["halfExtentM"] / meta["height"],
        )
        source_crs = SOUTH_STERE
    else:
        with rasterio.open(dem_path) as src:
            source = physical(src, src.read(1)).astype(np.float32)
            source_transform = src.transform
            source_crs = src.crs

    reproject(
        source=source,
        destination=elevation,
        src_transform=source_transform,
        src_crs=source_crs,
        src_nodata=np.nan,
        dst_transform=from_origin(-half_extent, half_extent, resolution_m, resolution_m),
        dst_crs=SOUTH_STERE,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    return elevation, half_extent


def encode_layer(values: np.ndarray, valid: np.ndarray, lo: float, hi: float) -> tuple[np.ndarray, float, float]:
    scale = (hi - lo) / 254 if hi > lo else 1.0
    clipped = np.clip(np.where(valid, values, lo), lo, hi)
    encoded = np.where(valid, 1 + np.round((clipped - lo) / scale), 0).astype(np.uint8)
    return encoded, scale, lo - scale


def main() -> None:
    parser = argparse.ArgumentParser(description="Build lunar charging overlays from DEM and SPICE data")
    parser.add_argument("--csv", type=Path, default=Path(__file__).with_name("equipot_results.csv"))
    parser.add_argument("--dem", type=Path, help="LOLA DEM (.lbl/.tif) or the generated dem_south.png overlay")
    parser.add_argument("--ephemeris", type=Path, default=WEB_DATA / "ephemeris.json")
    parser.add_argument("--output-dir", type=Path, default=WEB_DATA)
    parser.add_argument("--sites", type=Path, default=WEB_DATA / "sites.json")
    parser.add_argument("--resolution-m", type=float, default=4000.0, help="Output grid resolution in metres")
    parser.add_argument("--step-hours", type=float, default=12.0, help="Sampling interval for ephemeris epochs")
    parser.add_argument("--threshold-v", type=float, default=-100.0)
    parser.add_argument(
        "--thermal-mode",
        choices=("sites", "all"),
        default="sites",
        help="Run the slow regolith model at candidate sites only (default) or at every DEM point",
    )
    parser.add_argument(
        "--n-spinup",
        type=int,
        default=None,
        help="Thermal spin-up in sampled epochs (default: one year at the selected step)",
    )
    args = parser.parse_args()

    dem_path = args.dem or RAW / "ldem_80s_80m.lbl"
    if args.dem is None and not dem_path.exists():
        dem_path = WEB_DATA / "overlays" / "dem_south.png"

    for path in (args.csv, dem_path, args.ephemeris):
        if not path.exists():
            raise FileNotFoundError(f"Required input not found: {path}")
    if args.resolution_m <= 0 or args.step_hours <= 0 or (args.n_spinup is not None and args.n_spinup < 0):
        parser.error("--resolution-m and --step-hours must be positive; --n-spinup cannot be negative")

    eph = json.loads(args.ephemeris.read_text(encoding="utf-8"))
    eph_step = float(eph["stepSeconds"])
    if eph_step <= 0:
        raise ValueError("Ephemeris stepSeconds must be positive")
    stride = max(1, round(args.step_hours * 3600 / eph_step))
    actual_step_hours = eph_step * stride / 3600
    dt = eph_step * stride
    eph_count = len(eph["sun"]) // 3
    sample_count = len(range(0, eph_count, stride))
    n_spinup = (
        args.n_spinup
        if args.n_spinup is not None
        else math.ceil(365.25 * 24 / actual_step_hours)
    )
    if n_spinup >= sample_count:
        raise ValueError(
            f"Thermal spin-up ({n_spinup} steps) must be shorter than the "
            f"{sample_count} sampled ephemeris epochs"
        )

    print(f"Resampling DEM at {args.resolution_m:g} m...")
    elevation, half_extent = reproject_dem(dem_path, args.resolution_m)
    valid_indices, normals, up = terrain_geometry(elevation, half_extent, args.resolution_m)
    if not len(valid_indices):
        raise ValueError(f"No valid DEM pixels found in {args.dem}")
    print(f"Computing charging for {len(valid_indices):,} DEM pixels...")

    size = elevation.shape[0]
    point_lookup = np.full(elevation.size, -1, dtype=np.int32)
    point_lookup[valid_indices] = np.arange(len(valid_indices), dtype=np.int32)
    to_map = Transformer.from_crs(MOON_GEOG, SOUTH_STERE, always_xy=True)
    sites = (
        json.loads(args.sites.read_text(encoding="utf-8")).get("sites", [])
        if args.sites.exists()
        else []
    )
    if args.thermal_mode == "sites" and not args.sites.exists():
        raise FileNotFoundError(f"Candidate-site JSON not found: {args.sites}")
    thermal_indices = select_thermal_points(
        sites,
        args.thermal_mode,
        to_map,
        half_extent,
        args.resolution_m,
        size,
        point_lookup,
        len(valid_indices),
    )
    is_thermal = np.zeros(len(valid_indices), dtype=bool)
    is_thermal[thermal_indices] = True
    equilibrium_indices = np.flatnonzero(~is_thermal)
    thermal_method = np.full(len(valid_indices), "equilibrium", dtype="<U11")
    thermal_method[thermal_indices] = "regolith"

    model = ChargingModel(args.csv)
    thermal = RegolithThermal(len(thermal_indices), T_init=100.0)
    Tstats = ThermalStats(len(valid_indices))

    def accumulate_thermal(
        sample_index: int,
        inc_deg: np.ndarray,
        lit: np.ndarray,
        sun_vector: np.ndarray,
    ) -> None:
        Q = absorbed_flux(inc_deg, lit, solar_distance_au(sun_vector, eph.get("units")))
        T_thermal = thermal.step(Q[thermal_indices], dt)
        if sample_index < n_spinup:
            return

        T = np.empty(len(valid_indices), dtype=float)
        T[thermal_indices] = T_thermal
        T[equilibrium_indices] = equilibrium_temperature(Q[equilibrium_indices])
        Tstats.add(T)

    stats = surface_charging_over_ephemeris(
        model,
        normals,
        up,
        args.ephemeris,
        threshold_V=args.threshold_v,
        step=stride,
        on_epoch=accumulate_thermal,
    )
    if not stats.n:
        raise ValueError("No ephemeris epochs were sampled")
    if not Tstats.n:
        raise ValueError("No ephemeris epochs remain after thermal spin-up")

    valid = np.zeros(elevation.size, dtype=bool)
    valid[valid_indices] = True
    outputs = {
        "charging_mean": stats.mean,
        "charging_min": stats.min,
        "charging_frac_below": stats.frac_below,
        "thermal_mean": Tstats.mean,
        "thermal_min": Tstats.min,
        "thermal_max": Tstats.max,
    }

    overlay_dir = args.output_dir / "overlays"
    overlay_dir.mkdir(parents=True, exist_ok=True)
    index_path = overlay_dir / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"layers": []}
    layer_metadata = []
    all_layers = (*MAP_LAYERS, *THERMAL_LAYERS)
    thermal_ids = {layer["id"] for layer in THERMAL_LAYERS}
    for layer in all_layers:
        values = np.full(elevation.size, np.nan, dtype=np.float32)
        values[valid_indices] = outputs[layer["id"]]
        if layer["id"] in thermal_ids:
            lo = float(np.min(outputs[layer["id"]]))
            hi = float(np.max(outputs[layer["id"]]))
        else:
            lo, hi = (-120.0, 20.0) if layer["units"] == "V" else (0.0, 1.0)
        encoded, scale, offset = encode_layer(values.reshape(elevation.shape), valid.reshape(elevation.shape), lo, hi)
        image_path = overlay_dir / f"{layer['id']}.png"
        Image.fromarray(encoded).save(image_path, optimize=True)
        if layer["id"] in thermal_ids:
            source = (
                f"Hayne 2017 regolith model + LOLA + NASA SPICE "
                f"({Tstats.n} post-spin-up epochs, mode={args.thermal_mode}, "
                f"{len(thermal_indices)} regolith points, {n_spinup} spin-up steps)"
            )
        else:
            source = f"EQUIPOT/SPENVIS + LOLA DEM + NASA SPICE ({stats.n} epochs, every {actual_step_hours:g} h)"
        description = layer["description"]
        if layer["id"] in thermal_ids and args.thermal_mode == "all":
            description = "1D regolith surface-temperature statistics for every valid DEM point."
        meta = {
            **layer,
            "title": (
                f"Time below {args.threshold_v:g} V"
                if layer["id"] == "charging_frac_below"
                else layer["title"]
            ),
            "description": (
                f"Fraction of sampled epochs with EQUIPOT potential below {args.threshold_v:g} V; "
                "DEM-derived normals, flat local horizon."
                if layer["id"] == "charging_frac_below"
                else description
            ),
            "source": source,
            "file": image_path.name,
            "projection": "polar-south",
            "width": elevation.shape[1],
            "height": elevation.shape[0],
            "halfExtentM": half_extent,
            "encoding": "u8",
            "min": lo,
            "max": hi,
            "scale": scale,
            "offset": offset,
            "resolutionM": args.resolution_m,
            "display": True,
        }
        layer_metadata.append(meta)
        print(f"  {layer['id']}: {image_path} ({image_path.stat().st_size / 1e6:.2f} MB)")

    replaced = {layer["id"] for layer in all_layers}
    index["layers"] = [layer for layer in index.get("layers", []) if layer["id"] not in replaced] + layer_metadata
    index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")

    rows, cols = np.unravel_index(valid_indices, elevation.shape)
    x = -half_extent + (cols + 0.5) * args.resolution_m
    y = half_extent - (rows + 0.5) * args.resolution_m
    to_geo = Transformer.from_crs(SOUTH_STERE, MOON_GEOG, always_xy=True)
    lon, lat = to_geo.transform(x, y)
    lon = (lon + 180.0) % 360.0 - 180.0
    points_path = args.output_dir / "charging_points.csv"
    with points_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow((
            "lat", "lon", "charging_mean_V", "charging_min_V", "charging_max_V",
            "charging_frac_below_threshold", "T_mean", "T_min", "T_max", "thermal_method",
        ))
        writer.writerows(
            (
                f"{lat[i]:.6f}",
                f"{lon[i]:.6f}",
                f"{stats.mean[i]:.3f}",
                f"{stats.min[i]:.3f}",
                f"{stats.max[i]:.3f}",
                f"{stats.frac_below[i]:.6f}",
                f"{Tstats.mean[i]:.3f}",
                f"{Tstats.min[i]:.3f}",
                f"{Tstats.max[i]:.3f}",
                thermal_method[i],
            )
            for i in range(len(valid_indices))
        )
    print(f"{len(valid_indices):,} map points -> {points_path}")

    site_path = args.sites
    if site_path.exists():
        reports = []
        for site in sites:
            point_index = point_index_for_site(
                site, to_map, half_extent, args.resolution_m, size, point_lookup
            )
            if point_index is None:
                continue
            reports.append({
                "id": site["id"],
                "name": site["name"],
                "lat": site["lat"],
                "lon": site["lon"],
                "mean_V": float(stats.mean[point_index]),
                "min_V": float(stats.min[point_index]),
                "frac_below_threshold": float(stats.frac_below[point_index]),
                "threshold_V": args.threshold_v,
                "epochs": stats.n,
                "surface_sample_resolution_m": args.resolution_m,
                "T_mean": float(Tstats.mean[point_index]),
                "T_min": float(Tstats.min[point_index]),
                "T_max": float(Tstats.max[point_index]),
                "thermal_method": str(thermal_method[point_index]),
            })
        report_path = args.output_dir / "charging_sites.csv"
        with report_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=(
                    "id",
                    "name",
                    "lat",
                    "lon",
                    "mean_V",
                    "min_V",
                    "frac_below_threshold",
                    "threshold_V",
                    "epochs",
                    "surface_sample_resolution_m",
                    "T_mean",
                    "T_min",
                    "T_max",
                    "thermal_method",
                ),
            )
            writer.writeheader()
            writer.writerows(reports)
        print(f"{len(reports)} sites -> {report_path}")

    print(
        f"Done: {stats.n} charging epochs at {actual_step_hours:g} h intervals; "
        f"{Tstats.n} thermal-stat epochs after {n_spinup} spin-up steps."
    )


if __name__ == "__main__":
    main()
