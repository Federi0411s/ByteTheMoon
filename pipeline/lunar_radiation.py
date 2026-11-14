"""Map lunar surface radiation (GCR + albedo) as a function of location.

The free-space GCR/SEP flux is isotropic and uniform across the Moon. The
location-dependent quantity is the visible-sky fraction (sky-view factor),
computed from the DEM horizon angle H(phi) across N azimuths:

    f_sky = 1/(4*pi) * integral_0^2pi (1 - sin H(phi)) dphi  (flat terrain -> 0.5)

    D(lat, lon) = D_primary_space * f_sky + D_soil_albedo * (1 - f_sky) * k_albedo

Calibration to Chang'e 4 / LND (flat terrain, f_sky ~ 0.5, 2019 solar minimum):
    total dose in Si      = 13.2 uGy/h
    neutral component     =  3.1 uGy/h (soil albedo)
    charged component    = 10.1 uGy/h -> free space = 10.1 / 0.5 = 20.2 uGy/h
    albedo per soil fraction = 3.1 / 0.5 = 6.2 uGy/h
    equivalent dose ~ 60 uSv/h -> Sv/Gy ratio ~ 60/13.2

For a worst-case SEP event, set SEP_SPACE_DOSE to the free-space dose from
SPENVIS using the same shielding; it is scaled by f_sky.

With no arguments, use the pipeline's LOLA LDEM 80S DEM. A CSV/TXT with lat,
lon, elev columns (degrees, degrees, meters) is also accepted as explicit input.

Outputs include CSV, GeoJSON, and a polar-stereographic PNG.

Usage:
    python pipeline/lunar_radiation.py
    python pipeline/lunar_radiation.py dem.csv --lat-max -80
    python pipeline/lunar_radiation.py --test  # synthetic test DEM
"""

import argparse
import csv
import json
import math
from pathlib import Path

import numpy as np
from scipy.interpolate import RegularGridInterpolator, griddata
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import Window, from_bounds

from config import MOON_GEOG, RAW, REPO, SOUTH_STERE, WEB_DATA
from rasters import physical

MOON_RADIUS_M = 1737.4e3

# ---------------- MODEL PARAMETERS (configurable) ----------------
PRIMARY_SPACE_DOSE = 20.2   # uGy/h in Si, free-space GCR (Chang'e 4, solar minimum)
SOIL_ALBEDO_DOSE = 6.2      # uGy/h in Si, neutral secondaries per unit soil fraction
SEP_SPACE_DOSE = 0.0        # mean SEP free-space dose [uGy/h] from SPENVIS (0 = GCR only)
SV_PER_GY = 60.0 / 13.2     # equivalent-to-absorbed dose ratio (Chang'e 4)

# Classification thresholds for absorbed dose [uGy/h]
GREEN_THRESHOLD = 12.0       # dose <= green
YELLOW_THRESHOLD = 12.8      # green < dose <= yellow; above -> red

N_AZIMUTHS = 32
MAX_DISTANCE = 50e3
N_STEPS = 60
CALCULATION_RESOLUTION_M = 500.0
MARGIN_DEGREES = 2.0
RADIATION_OUTPUT = REPO / "web" / "public" / "radiation"


# ---------------- DATA INPUT ----------------
def load_dem(path):
    """Load lat, lon, elevation and return a regular (lat, lon) grid."""
    data = np.genfromtxt(path, delimiter=None if path.endswith(".txt") else ",",
                         names=True, dtype=float)
    names = [n.lower() for n in data.dtype.names]
    column = lambda *keys: data[data.dtype.names[next(i for i, n in enumerate(names)
                                                      if any(key in n for key in keys))]]
    lat, lon, elevation = column("lat"), column("lon"), column("elev", "height", "alt", "z")
    lon = np.mod(lon, 360.0)

    unique_lat, unique_lon = np.unique(lat), np.unique(lon)
    if unique_lat.size * unique_lon.size == lat.size:
        Z = np.full((unique_lat.size, unique_lon.size), np.nan)
        Z[np.searchsorted(unique_lat, lat), np.searchsorted(unique_lon, lon)] = elevation
    else:
        print("Input is not a regular grid; interpolating to a regular grid...")
        n = int(np.sqrt(lat.size))
        unique_lat = np.linspace(lat.min(), lat.max(), n)
        unique_lon = np.linspace(lon.min(), lon.max(), 2 * n)
        lon_grid, lat_grid = np.meshgrid(unique_lon, unique_lat, indexing="xy")
        Z = griddata((lat, lon), elevation, (lat_grid, lon_grid), method="linear")
    return unique_lat, unique_lon, Z


def synthetic_dem():
    """Create a test DEM for the south pole (-90..-80) with craters and a mountain."""
    lat = np.linspace(-90, -80, 201)
    lon = np.arange(0, 360, 0.5)
    lon_grid, lat_grid = np.meshgrid(lon, lat, indexing="xy")
    x, y = _polar_stereographic(lat_grid, lon_grid)
    Z = np.zeros_like(lat_grid)
    craters = [(0, 0, 10e3, 4000), (60e3, -80e3, 25e3, 3000), (-120e3, 40e3, 15e3, 2500),
               (100e3, 120e3, 40e3, 4000)]
    for cx, cy, r, profile_depth in craters:
        d = np.hypot(x - cx, y - cy) / r
        Z += np.where(d < 1, -profile_depth * (1 - d**2), 0) + np.where((d >= 1) & (d < 1.6),
                                                               0.3 * profile_depth * np.cos((d - 1) / 0.6 * np.pi / 2)**2, 0)
    Z += 5000 * np.exp(-(np.hypot(x + 60e3, y + 110e3) / 30e3) ** 2)  # mountain
    return lat, lon, Z


# ---------------- GEOMETRY ----------------
def _destination_point(lat, lon, azimuth, distance):
    """Point at distance [m] along a great circle at the given azimuth [degrees]."""
    phi1, lam1 = np.radians(lat), np.radians(lon)
    th, dl = np.radians(azimuth), distance / MOON_RADIUS_M
    phi2 = np.arcsin(np.clip(np.sin(phi1) * np.cos(dl) + np.cos(phi1) * np.sin(dl) * np.cos(th), -1, 1))
    lam2 = lam1 + np.arctan2(np.sin(th) * np.sin(dl) * np.cos(phi1),
                             np.cos(dl) - np.sin(phi1) * np.sin(phi2))
    return np.degrees(phi2), np.mod(np.degrees(lam2), 360.0)


def _polar_stereographic(lat, lon):
    """South-polar stereographic projection, coordinates in meters."""
    rho = 2 * MOON_RADIUS_M * np.tan(np.radians(90 + lat) / 2)
    return rho * np.sin(np.radians(lon)), rho * np.cos(np.radians(lon))


def sky_view_factor(lat_1d, lon_1d, Z, n_az=N_AZIMUTHS, dist_max=MAX_DISTANCE, n_steps=N_STEPS,
                    block_rows=50):
    """Compute horizon angle for each azimuth and visible-sky fraction f_sky."""
    global_grid = lon_1d[-1] - lon_1d[0] > 350
    extended_lon, extended_elevation = lon_1d, Z
    if global_grid:  # Repeat columns to handle the 360 -> 0 transition.
        extended_lon = np.concatenate([lon_1d[-2:] - 360, lon_1d, lon_1d[:2] + 360])
        extended_elevation = np.concatenate([Z[:, -2:], Z, Z[:, :2]], axis=1)
    interpolator = RegularGridInterpolator((lat_1d, extended_lon), extended_elevation, bounds_error=False, fill_value=np.nan)

    grid_spacing = np.radians(abs(lat_1d[1] - lat_1d[0])) * MOON_RADIUS_M
    distances = np.geomspace(grid_spacing, dist_max, n_steps)
    azimuth = np.arange(n_az) * 360.0 / n_az

    H = np.zeros((n_az,) + Z.shape)
    for r0 in range(0, lat_1d.size, block_rows):
        r1 = min(r0 + block_rows, lat_1d.size)
        lat_grid, lon_grid = np.meshgrid(lat_1d[r0:r1], lon_1d, indexing="ij")
        start_elevation = Z[r0:r1]
        for k, az in enumerate(azimuth):
            max_horizon = np.full(lat_grid.shape, -np.inf)
            for d in distances:
                la2, lo2 = _destination_point(lat_grid, lon_grid, az, d)
                if not global_grid:
                    lo2 = np.where(lo2 > lon_1d[-1] + 1, lo2 - 360, lo2)
                sampled_elevation = interpolator(np.stack([la2, lo2], axis=-1))
                horizon_angle = np.arctan2(
                    sampled_elevation - start_elevation - d**2 / (2 * MOON_RADIUS_M), d
                )
                max_horizon = np.fmax(max_horizon, horizon_angle)
            H[k, r0:r1] = np.where(np.isfinite(max_horizon), max_horizon, 0.0)
        print(f"  Horizon: rows {r1}/{lat_1d.size}")

    f_sky = np.mean(1 - np.sin(H), axis=0) / 2
    return H, f_sky


# ---------------- DOSE AND CLASSIFICATION ----------------
def dose(f_sky, k_albedo=1.0, d_sep=SEP_SPACE_DOSE):
    """Absorbed dose [uGy/h in Si].

    k_albedo is a scalar or map scaling factor for albedo neutron variation,
    e.g. from normalized Lunar Prospector/LEND maps.
    """
    return (PRIMARY_SPACE_DOSE + d_sep) * f_sky + SOIL_ALBEDO_DOSE * (1 - f_sky) * k_albedo


def classify_dose(D):
    class_index = np.where(D <= GREEN_THRESHOLD, 0, np.where(D <= YELLOW_THRESHOLD, 1, 2))
    return class_index, np.array(["green", "yellow", "red"])[class_index], \
        np.array(["#2ca02c", "#ffcc00", "#d62728"])[class_index]


# ---------------- OUTPUT ----------------
def save_outputs(lat_1d, lon_1d, Z, H, f, D, prefix, geojson_max=20000):
    lon_grid, lat_grid = np.meshgrid(lon_1d, lat_1d, indexing="xy")
    class_index, class_name, color = classify_dose(D)
    annual_mSv = D * SV_PER_GY * 24 * 365.25 / 1000

    ok = np.isfinite(Z)
    rows = np.column_stack([lat_grid[ok], lon_grid[ok], Z[ok], np.degrees(H.mean(0))[ok], f[ok],
                             D[ok], annual_mSv[ok], class_index[ok]])
    with open(f"{prefix}.csv", "w") as fh:
        fh.write("lat,lon,elevation_m,mean_horizon_deg,f_sky,dose_uGy_h,equivalent_dose_mSv_year,class,color\n")
        for r, c in zip(rows, color[ok]):
            fh.write(f"{r[0]:.4f},{r[1]:.4f},{r[2]:.1f},{r[3]:.3f},{r[4]:.4f},"
                     f"{r[5]:.3f},{r[6]:.1f},{int(r[7])},{c}\n")

    idx = np.flatnonzero(ok)
    if idx.size > geojson_max:  # Subsample to keep the Cesium payload small.
        idx = idx[:: int(np.ceil(idx.size / geojson_max))]
    features = [{"type": "Feature",
              "geometry": {"type": "Point", "coordinates": [float(lon_grid.flat[i] if lon_grid.flat[i] <= 180 else lon_grid.flat[i] - 360),
                                                            float(lat_grid.flat[i]), float(Z.flat[i])]},
              "properties": {"dose_uGy_h": round(float(D.flat[i]), 3), "f_sky": round(float(f.flat[i]), 4),
                             "class": str(class_name.flat[i]), "marker-color": str(color.flat[i])}}
             for i in idx]
    with open(f"{prefix}.geojson", "w") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap

    # Close the 360-degree grid for a continuous plot.
    close_seam = lambda A: np.concatenate([A, A[:, :1]], axis=1)
    x, y = _polar_stereographic(close_seam(lat_grid), close_seam(lon_grid))
    Zp, Dp, Cp = close_seam(Z), close_seam(D), close_seam(class_index)
    fig, ax = plt.subplots(1, 3, figsize=(17, 5.5), constrained_layout=True)
    for a, val, tit, cm in [(ax[0], Zp / 1000, "Elevation [km]", "gist_earth"),
                            (ax[1], Dp, "Absorbed dose [µGy/h, Si]", "inferno")]:
        m = a.pcolormesh(x / 1e3, y / 1e3, val, cmap=cm, shading="gouraud")
        fig.colorbar(m, ax=a, shrink=0.85)
        a.set_title(tit)
    m = ax[2].pcolormesh(x / 1e3, y / 1e3, Cp.astype(float), shading="gouraud",
                         cmap=ListedColormap(["#2ca02c", "#ffcc00", "#d62728"]), vmin=-0.5, vmax=2.5)
    cb = fig.colorbar(m, ax=ax[2], ticks=[0, 1, 2], shrink=0.85)
    cb.ax.set_yticklabels([f"≤ {GREEN_THRESHOLD}", f"≤ {YELLOW_THRESHOLD}", f"> {YELLOW_THRESHOLD}"])
    ax[2].set_title("Radiation class")
    for a in ax:
        a.set_aspect("equal")
        a.set_xlabel("x [km]")
        a.set_ylabel("y [km]")
    fig.suptitle("Lunar surface radiation - south-polar stereographic projection")
    fig.savefig(f"{prefix}.png", dpi=130)
    print(f"Saved: {prefix}.csv, {prefix}.geojson, {prefix}.png")


def save_geographic_overlay(lat_1d, lon_1d, D, prefix, alpha=0.6):
    """Write equirectangular RGBA images for Cesium and their extent/legend metadata."""
    import matplotlib
    import matplotlib.pyplot as plt
    lon_c = np.where(lon_1d > 180, lon_1d - 360, lon_1d)      # -> [-180, 180]
    order = np.argsort(lon_c)
    dose_grid = D[:, order][::-1]                                    # Row 0 is north.
    nan = ~np.isfinite(dose_grid)

    class_index, _, _ = classify_dose(np.nan_to_num(dose_grid, nan=0))
    palette = np.array([[44, 160, 44], [255, 204, 0], [214, 39, 40]], dtype=np.uint8)
    rgba = np.zeros(dose_grid.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = palette[class_index]
    rgba[..., 3] = np.where(nan, 0, int(alpha * 255))
    plt.imsave(f"{prefix}_classes.png", rgba)

    vmin, vmax = float(np.nanmin(D)), float(np.nanmax(D))
    cont = (matplotlib.colormaps["inferno"]((dose_grid - vmin) / (vmax - vmin + 1e-12)) * 255).astype(np.uint8)
    cont[..., 3] = np.where(nan, 0, int(alpha * 255))
    plt.imsave(f"{prefix}_continuous.png", cont)

    meta = {"west": -180.0, "east": 180.0,
            "south": float(lat_1d.min()), "north": float(lat_1d.max()),
            "units": "uGy/h (Si)", "doseMin": vmin, "doseMax": vmax,
            "classLegend": [{"color": "#2ca02c", "label": f"<= {GREEN_THRESHOLD}"},
                            {"color": "#ffcc00", "label": f"<= {YELLOW_THRESHOLD}"},
                            {"color": "#d62728", "label": f"> {YELLOW_THRESHOLD}"}]}
    with open(f"{prefix}_overlay.json", "w") as fh:
        json.dump(meta, fh, indent=2)
    print(f"Saved overlays: {prefix}_classes.png, {prefix}_continuous.png, {prefix}_overlay.json")


def _read_overlay_metadata():
    index_path = WEB_DATA / "overlays" / "index.json"
    if not index_path.exists():
        raise FileNotFoundError(f"{index_path} not found; run python pipeline/overlays.py first")
    layers = json.loads(index_path.read_text(encoding="utf-8")).get("layers", [])
    by_id = {layer["id"]: layer for layer in layers}
    if "sun_avg" not in by_id or "dem_south" not in by_id:
        raise ValueError(f"{index_path} must contain the sun_avg and dem_south layers")
    return by_id["sun_avg"], by_id["dem_south"]


def _decode_elevation_overlay(path, metadata):
    """Decode the existing u16 elevation PNG when raw LOLA files are unavailable."""
    pixels = np.asarray(Image.open(path).convert("RGB"))
    if pixels.shape[:2] != (metadata["height"], metadata["width"]):
        raise ValueError(f"Dimensions of {path.name} do not match index.json")
    dn = pixels[..., 0].astype(np.uint16) * 256 + pixels[..., 1].astype(np.uint16)
    elevation = np.where(pixels[..., 2] > 0, dn * metadata["scale"] + metadata["offset"], np.nan)
    transform = from_origin(
        -metadata["halfExtentM"],
        metadata["halfExtentM"],
        2 * metadata["halfExtentM"] / metadata["width"],
        2 * metadata["halfExtentM"] / metadata["height"],
    )
    return elevation.astype(np.float32), transform, SOUTH_STERE, metadata["halfExtentM"]


def _read_dem_buffer(dem_path, dem_metadata, buffer_size, buffer_half, resolution):
    """Read/reproject LOLA heights with rasters.physical, retaining the 2-degree margin."""
    destination = np.full((buffer_size, buffer_size), np.nan, dtype=np.float32)
    destination_transform = from_origin(-buffer_half, buffer_half, resolution, resolution)

    if dem_path.suffix.lower() == ".png":
        source, source_transform, source_crs, source_half = _decode_elevation_overlay(dem_path, dem_metadata)
        if source_half + 1e-6 < buffer_half:
            raise ValueError("dem_south.png does not cover the required margin; download the LOLA LDEM 80S")
        reproject(
            source=source,
            destination=destination,
            src_transform=source_transform,
            src_crs=source_crs,
            src_nodata=np.nan,
            dst_transform=destination_transform,
            dst_crs=SOUTH_STERE,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
        return destination

    with rasterio.open(dem_path) as src:
        source_bounds = transform_bounds(src.crs, SOUTH_STERE, *src.bounds, densify_pts=21)
        if (
            source_bounds[0] > -buffer_half
            or source_bounds[1] > -buffer_half
            or source_bounds[2] < buffer_half
            or source_bounds[3] < buffer_half
        ):
            raise ValueError(
                f"DEM {dem_path} does not cover the required 2-degree margin around the overlay"
            )
        bounds = transform_bounds(
            SOUTH_STERE, src.crs, -buffer_half, -buffer_half, buffer_half, buffer_half, densify_pts=21
        )
        window = from_bounds(*bounds, transform=src.transform)
        window = window.round_offsets().round_lengths().intersection(Window(0, 0, src.width, src.height))
        if window.width <= 0 or window.height <= 0:
            raise ValueError(f"No data from DEM {dem_path} in the requested area")
        raw = src.read(1, window=window)
        elevation = physical(src, raw).astype(np.float32)
        reproject(
            source=elevation,
            destination=destination,
            src_transform=src.window_transform(window),
            src_crs=src.crs,
            src_nodata=np.nan,
            dst_transform=destination_transform,
            dst_crs=SOUTH_STERE,
            dst_nodata=np.nan,
            resampling=Resampling.bilinear,
        )
    return destination


def sky_view_factor_stereo(dem, target_mask, offset, resolution, n_az=N_AZIMUTHS,
                           dist_max=MAX_DISTANCE, n_steps=N_STEPS):
    """Calculate sky view directly on the polar x/y grid, including lunar curvature."""
    target_size = target_mask.shape[0]
    rows, cols = np.nonzero(target_mask & np.isfinite(dem[offset:offset + target_size, offset:offset + target_size]))
    if not rows.size:
        raise ValueError("No valid DEM pixels in the sun_avg overlay extent")

    local_dem = dem[offset:offset + target_size, offset:offset + target_size]
    start_elevation = local_dem[rows, cols].astype(np.float64)
    start_rows = rows.astype(np.float64) + offset
    start_cols = cols.astype(np.float64) + offset
    distances = np.geomspace(resolution, dist_max, n_steps)
    sky_sum = np.zeros(rows.size, dtype=np.float64)
    horizon_sum = np.zeros(rows.size, dtype=np.float64)
    height, width = dem.shape

    for k, azimuth in enumerate(np.arange(n_az) * 2 * np.pi / n_az):
        max_horizon = np.full(rows.size, -np.inf, dtype=np.float64)
        dx, dy = np.sin(azimuth), np.cos(azimuth)
        for distance in distances:
            col = start_cols + dx * distance / resolution
            row = start_rows - dy * distance / resolution
            c0, r0 = np.floor(col).astype(np.int32), np.floor(row).astype(np.int32)
            inside = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < width) & (r0 + 1 < height)
            c = np.clip(c0, 0, width - 2)
            r = np.clip(r0, 0, height - 2)
            fc, fr = col - c0, row - r0
            z00, z01 = dem[r, c], dem[r, c + 1]
            z10, z11 = dem[r + 1, c], dem[r + 1, c + 1]
            valid = inside & np.isfinite(z00) & np.isfinite(z01) & np.isfinite(z10) & np.isfinite(z11)
            sampled_elevation = (z00 * (1 - fc) + z01 * fc) * (1 - fr) + (z10 * (1 - fc) + z11 * fc) * fr
            angle = np.arctan2(
                sampled_elevation - start_elevation - distance**2 / (2 * MOON_RADIUS_M), distance
            )
            max_horizon = np.fmax(max_horizon, np.where(valid, angle, -np.inf))

        max_horizon = np.where(np.isfinite(max_horizon), max_horizon, 0.0)
        horizon_sum += max_horizon
        sky_sum += 1 - np.sin(max_horizon)
        print(f"  Horizon x/y: azimuth {k + 1}/{n_az}")

    sky_factor = sky_sum / (2 * n_az)
    mean_horizon = horizon_sum / n_az
    shape = target_mask.shape
    f = np.full(shape, np.nan, dtype=np.float32)
    h = np.full(shape, np.nan, dtype=np.float32)
    f[rows, cols] = sky_factor
    h[rows, cols] = mean_horizon
    z = np.where(target_mask, local_dem, np.nan).astype(np.float32)
    return z, h, f


def _save_projected_outputs(x, y, z, h, f, dose_map, prefix):
    """Save the legacy CSV/GeoJSON/plot products from the polar computation grid."""
    xx, yy = np.meshgrid(x, y)
    from pyproj import Transformer
    to_geo = Transformer.from_crs(SOUTH_STERE, MOON_GEOG, always_xy=True)
    lon, lat = to_geo.transform(xx, yy)
    valid = np.isfinite(dose_map)
    classes, names, colors = classify_dose(np.nan_to_num(dose_map, nan=0.0))
    yearly = dose_map * SV_PER_GY * 24 * 365.25 / 1000

    with open(f"{prefix}.csv", "w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(("lat", "lon", "elevation_m", "mean_horizon_deg", "f_sky", "dose_uGy_h",
                         "equivalent_dose_mSv_year", "class", "color"))
        for r, c in zip(*np.nonzero(valid)):
            writer.writerow((f"{lat[r, c]:.4f}", f"{lon[r, c] % 360:.4f}", f"{z[r, c]:.1f}",
                             f"{np.degrees(h[r, c]):.3f}", f"{f[r, c]:.4f}", f"{dose_map[r, c]:.3f}",
                             f"{yearly[r, c]:.1f}", int(classes[r, c]), colors[r, c]))

    indexes = np.flatnonzero(valid)
    if indexes.size > 20000:
        indexes = indexes[::int(np.ceil(indexes.size / 20000))]
    features = []
    for i in indexes:
        r, c = np.unravel_index(i, valid.shape)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float((lon[r, c] + 180) % 360 - 180),
                                                              float(lat[r, c]), float(z[r, c])]},
            "properties": {"dose_uGy_h": round(float(dose_map[r, c]), 3),
                           "f_sky": round(float(f[r, c]), 4), "class": str(names[r, c]),
                           "marker-color": str(colors[r, c])},
        })
    with open(f"{prefix}.geojson", "w", encoding="utf-8") as file:
        json.dump({"type": "FeatureCollection", "features": features}, file)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap

    fig, axes = plt.subplots(1, 3, figsize=(17, 5.5), constrained_layout=True)
    for ax, values, title, cmap in (
        (axes[0], z / 1000, "Elevation [km]", "gist_earth"),
        (axes[1], dose_map, "Absorbed dose [uGy/h, Si]", "inferno"),
    ):
        mesh = ax.pcolormesh(x / 1000, y / 1000, values, cmap=cmap, shading="auto")
        fig.colorbar(mesh, ax=ax, shrink=0.85)
        ax.set_title(title)
    class_plot = np.ma.masked_where(~valid, classes)
    mesh = axes[2].pcolormesh(x / 1000, y / 1000, class_plot, shading="auto",
                              cmap=ListedColormap(["#2ca02c", "#ffcc00", "#d62728"]), vmin=-0.5, vmax=2.5)
    colorbar = fig.colorbar(mesh, ax=axes[2], ticks=[0, 1, 2], shrink=0.85)
    colorbar.ax.set_yticklabels([f"≤ {GREEN_THRESHOLD}", f"≤ {YELLOW_THRESHOLD}", f"> {YELLOW_THRESHOLD}"])
    axes[2].set_title("Radiation class")
    for ax in axes:
        ax.set_aspect("equal")
        ax.set_xlabel("x [km]")
        ax.set_ylabel("y [km]")
    fig.suptitle("Lunar radiation - south-polar stereographic projection")
    fig.savefig(f"{prefix}.png", dpi=130)
    plt.close(fig)
    print(f"Saved: {prefix}.csv, {prefix}.geojson, {prefix}.png")


def _encode_u8(values, valid, lo, hi):
    scale = (hi - lo) / 254 if hi > lo else 1.0
    encoded = np.where(valid, 1 + np.round((np.clip(values, lo, hi) - lo) / scale), 0).astype(np.uint8)
    return encoded, scale, lo - scale


def save_polar_overlay(dose_map, calc_resolution, calc_half, target_meta, output_dir=RADIATION_OUTPUT):
    """Write numeric PNG overlays on the same polar grid and extent as pipeline heatmaps."""
    output_dir.mkdir(parents=True, exist_ok=True)
    width, height = target_meta["width"], target_meta["height"]
    half = target_meta["halfExtentM"]
    target_transform = from_origin(-half, half, 2 * half / width, 2 * half / height)
    source_transform = from_origin(-calc_half, calc_half, calc_resolution, calc_resolution)

    dose_out = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        source=dose_map.astype(np.float32),
        destination=dose_out,
        src_transform=source_transform,
        src_crs=SOUTH_STERE,
        src_nodata=np.nan,
        dst_transform=target_transform,
        dst_crs=SOUTH_STERE,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )

    # Keep exactly the same valid footprint as the existing sunlight heatmap.
    sun_meta = json.loads((WEB_DATA / "overlays" / "index.json").read_text(encoding="utf-8"))
    sun_layer = next(layer for layer in sun_meta["layers"] if layer["id"] == "sun_avg")
    sun_pixels = np.asarray(Image.open(WEB_DATA / "overlays" / sun_layer["file"]).convert("L"))
    valid = (sun_pixels > 0) & np.isfinite(dose_out)
    if not valid.any():
        raise ValueError("No valid dose values in the sun_avg overlay extent")
    dose_min, dose_max = float(np.nanmin(dose_out[valid])), float(np.nanmax(dose_out[valid]))
    dose_png, dose_scale, dose_offset = _encode_u8(dose_out, valid, dose_min, dose_max)
    Image.fromarray(dose_png, mode="L").save(output_dir / "radiation_continuous.png", optimize=True)

    class_coarse = np.full(dose_map.shape, np.nan, dtype=np.float32)
    coarse_valid = np.isfinite(dose_map)
    classes, _, _ = classify_dose(np.nan_to_num(dose_map, nan=0.0))
    class_coarse[coarse_valid] = classes[coarse_valid]
    class_out = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        source=class_coarse,
        destination=class_out,
        src_transform=source_transform,
        src_crs=SOUTH_STERE,
        src_nodata=np.nan,
        dst_transform=target_transform,
        dst_crs=SOUTH_STERE,
        dst_nodata=np.nan,
        resampling=Resampling.nearest,
    )
    valid &= np.isfinite(class_out)
    class_png, class_scale, class_offset = _encode_u8(class_out, valid, 0.0, 2.0)
    Image.fromarray(class_png, mode="L").save(output_dir / "radiation_classes.png", optimize=True)

    metadata = {
        "projection": "polar-south",
        "width": width,
        "height": height,
        "halfExtentM": half,
        "resolutionM": target_meta["resolutionM"],
        "encoding": "u8",
        "classScale": class_scale,
        "classOffset": class_offset,
        "doseScale": dose_scale,
        "doseOffset": dose_offset,
        "doseMin": dose_min,
        "doseMax": dose_max,
        "units": "uGy/h (Si)",
        "classLegend": [
            {"color": "#2ca02c", "label": f"<= {GREEN_THRESHOLD}"},
            {"color": "#ffcc00", "label": f"<= {YELLOW_THRESHOLD}"},
            {"color": "#d62728", "label": f"> {YELLOW_THRESHOLD}"},
        ],
    }
    (output_dir / "radiation_overlay.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Cesium overlays -> {output_dir} ({width}x{height}, halfExtent {half:.0f} m)")


def calculate_from_lola_dem(lat_max=None, prefix="lunar_radiation", sep=SEP_SPACE_DOSE):
    """Compute from the LOLA DEM on a buffered polar-stereographic grid."""
    sun_meta, dem_meta = _read_overlay_metadata()
    half = float(sun_meta["halfExtentM"])
    corner_rho = np.sqrt(2) * half
    edge_lat = -90 + np.degrees(2 * np.arctan(corner_rho / (2 * MOON_RADIUS_M)))
    margin_lat = edge_lat + MARGIN_DEGREES
    margin_half = 2 * MOON_RADIUS_M * np.tan(np.radians(90 + margin_lat) / 2)
    margin_half = max(margin_half, corner_rho + MAX_DISTANCE)

    raw_dem = RAW / "ldem_80s_80m.lbl"
    dem_png = WEB_DATA / "overlays" / "dem_south.png"
    dem_path = raw_dem if raw_dem.exists() else dem_png
    if not dem_path.exists():
        raise FileNotFoundError(
            f"LOLA DEM not found: {raw_dem}. Run python pipeline/download.py and python pipeline/overlays.py"
        )

    resolution = max(CALCULATION_RESOLUTION_M, float(dem_meta["resolutionM"]))
    calc_size = int(math.ceil(2 * half / resolution))
    calc_half = calc_size * resolution / 2
    buffer_size = int(math.ceil(2 * margin_half / resolution))
    if (buffer_size - calc_size) % 2:
        buffer_size += 1
    buffer_half = buffer_size * resolution / 2
    offset = (buffer_size - calc_size) // 2
    print(
        f"LOLA DEM: {dem_path} | calculation resolution {resolution:.1f} m; "
        f"margin {margin_lat:.2f}° ({buffer_half - calc_half:.0f} m)"
    )
    dem = _read_dem_buffer(dem_path, dem_meta, buffer_size, buffer_half, resolution)

    calc_transform = from_origin(-calc_half, calc_half, resolution, resolution)
    target_mask = np.zeros((calc_size, calc_size), dtype=np.uint8)
    sun_path = WEB_DATA / "overlays" / sun_meta["file"]
    sun_pixels = np.asarray(Image.open(sun_path).convert("L"))
    reproject(
        source=(sun_pixels > 0).astype(np.uint8),
        destination=target_mask,
        src_transform=from_origin(
            -half, half, 2 * half / sun_meta["width"], 2 * half / sun_meta["height"]
        ),
        src_crs=SOUTH_STERE,
        src_nodata=0,
        dst_transform=calc_transform,
        dst_crs=SOUTH_STERE,
        dst_nodata=0,
        resampling=Resampling.nearest,
    )
    target_mask = target_mask.astype(bool)

    from pyproj import Transformer
    x = -calc_half + (np.arange(calc_size) + 0.5) * resolution
    y = calc_half - (np.arange(calc_size) + 0.5) * resolution
    if lat_max is not None:
        xx, yy = np.meshgrid(x, y)
        _, lat = Transformer.from_crs(SOUTH_STERE, MOON_GEOG, always_xy=True).transform(xx, yy)
        target_mask &= lat <= lat_max

    z, horizon, f_sky = sky_view_factor_stereo(dem, target_mask, offset, resolution)
    dose_map = dose(f_sky, d_sep=sep)
    print(f"f_sky: min {np.nanmin(f_sky):.3f}, max {np.nanmax(f_sky):.3f}")
    print(f"Dose: min {np.nanmin(dose_map):.2f}, max {np.nanmax(dose_map):.2f} uGy/h")
    _save_projected_outputs(x, y, z, horizon, f_sky, dose_map, prefix)
    save_polar_overlay(dose_map, resolution, calc_half, sun_meta)
    return dose_map


# ---------------- MAIN ----------------
def main():
    p = argparse.ArgumentParser(description="Calculate lunar radiation from a DEM")
    p.add_argument("dem", nargs="?", help="CSV/TXT with lat, lon, elev columns [m]")
    p.add_argument("--test", action="store_true", help="use a synthetic south-pole DEM")
    p.add_argument("--lat-max", type=float, default=None, help="keep latitudes <= this value (e.g. -80)")
    p.add_argument("--sep", type=float, default=SEP_SPACE_DOSE, help="free-space SEP dose [uGy/h] from SPENVIS")
    p.add_argument("--out", default="lunar_radiation")
    a = p.parse_args()

    if not a.test and not a.dem:
        calculate_from_lola_dem(a.lat_max, a.out, a.sep)
        return

    lat, lon, Z = synthetic_dem() if a.test else load_dem(a.dem)
    if a.lat_max is not None:
        sel = lat <= a.lat_max
        lat, Z = lat[sel], Z[sel]
    print(f"Grid: {lat.size} x {lon.size} points")

    H, f = sky_view_factor(lat, lon, Z)
    D = dose(f, d_sep=a.sep)
    print(f"f_sky: min {np.nanmin(f):.3f}, max {np.nanmax(f):.3f}")
    print(f"Dose: min {np.nanmin(D):.2f}, max {np.nanmax(D):.2f} uGy/h "
          f"(flat terrain = {dose(0.5, d_sep=a.sep):.2f})")
    save_outputs(lat, lon, Z, H, f, D, a.out)
    save_geographic_overlay(lat, lon, D, a.out)


if __name__ == "__main__":
    main()
