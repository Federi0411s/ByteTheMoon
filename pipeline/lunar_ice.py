"""
lunar_ice.py
"Water ice" layer for the lunar south-pole map.

Sources:
  - Diviner Polar Resource Product (PRP), file DLRE_PRP_SOUTH.TAB (PDS, Paige et al. 2010):
    annual maximum temperature and ice-permafrost depth for mesh elements.
  - Li et al. 2018 (PNAS): locations of M3 pixels (~280 m) with ice exposed at the surface.

Each grid point represents a CELL (Voronoi cell of the points, 4 km x 4 km for the
charging_points.csv grid): every PRP element (~0.5 km) falling inside the cell is used and the cell
is classified by AREA FRACTION, not by the single nearest element (which was enough to flag a
whole cell because of one small cold pocket).

Output classes (ice_class):
  0 = no ice
  1 = ice stable BELOW the surface (depth <= depth_max) over >= sub_frac_min of the cell.
      This is thermal STABILITY (ice would survive if present), not a detection:
      it covers ~1/3 of the map, so by default it is not put in the GeoJSON for the web app.
  2 = cold trap: annual max T < 110 K over >= surf_frac_min of the cell
  3 = ice OBSERVED at the surface (M3 pixels)

Usage:
    from lunar_ice import load_prp, load_m3_points, ice_layer, export_layer
    prp = load_prp("DLRE_PRP_SOUTH.TAB", col_lat=?, col_lon=?, col_tmax=?, col_depth=?)
    m3  = load_m3_points("li2018_south.csv")          # lat, lon columns (optional)
    layer = ice_layer(lat_grid, lon_grid, prp, m3)
    export_layer(layer, "mappa_ghiaccio")
"""

import json
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

R_MOON = 1737400.0
T_SURFACE_ICE = 110.0     # K: below this annual max T, surface ice is stable
DEPTH_MAX = 0.5           # m: subsurface ice considered "accessible"
SURF_FRAC_MIN = 0.25      # class 2 if at least 1/4 of the cell is a cold trap
SUB_FRAC_MIN = 0.5        # class 1 if at least half of the cell has stable ice within DEPTH_MAX


def latlon_to_xy(lat, lon, R=R_MOON):
    """South polar stereographic: x = rho sin(lon), y = rho cos(lon) [m]."""
    rho = 2.0 * R * np.tan(np.radians(90.0 + np.asarray(lat, float)) / 2.0)
    lon = np.radians(np.asarray(lon, float))
    return rho * np.sin(lon), rho * np.cos(lon)


# ------------------------------------------------------------------ data loading
def peek(path, n=5):
    """Print the first lines of the file: use it to find out which columns to use (see also the .LBL)."""
    with open(path, "r", errors="replace") as f:
        for _ in range(n):
            print(f.readline().rstrip())


def load_prp(path, col_lat=10, col_lon=9, col_tmax=13, col_depth=14,
             depth_scale=1.0, nodata_values=(-9999.0, -999.0, 9999.0), skiprows=1):
    """
    Read DLRE_PRP_SOUTH.TAB (Diviner PRP V2.0, 15 columns, first row = header):
      0-8  tri1_x..tri3_z (triangle vertices, km)
      9    tri_clon  centroid longitude [deg, -180..180]
      10   tri_clat  centroid latitude [deg]
      11   tri_calt  centroid altitude [km]
      12   temp_avg  annual mean T [K]
      13   temp_max  annual maximum T [K]
      14   ice_depth ice-permafrost depth [m]
           (-999 = no stable ice within ~2 m, -1 = stable at the surface -> 0 m)
    The default column indices match this format.
    depth_scale : factor converting the depth to metres (e.g. 0.01 if it is in cm).
    """
    cols = [col_lat, col_lon, col_tmax, col_depth]
    df = pd.read_csv(path, sep=",", skipinitialspace=True, header=None, skiprows=skiprows, usecols=cols,
                     dtype=float, engine="c")
    out = pd.DataFrame({
        "lat": df[col_lat].to_numpy(),
        "lon": df[col_lon].to_numpy() % 360.0,
        "tmax": df[col_tmax].to_numpy(),
        "depth": df[col_depth].to_numpy() * depth_scale,
    })
    for v in nodata_values:
        out.loc[out.tmax == v, "tmax"] = np.nan
        out.loc[out.depth == v * depth_scale, "depth"] = np.nan
    # -1 = ice already stable at the surface (all these elements have max T < ~101 K):
    # depth 0 m, not a negative value.
    out.loc[out.depth == -1.0 * depth_scale, "depth"] = 0.0
    out = out[out.lat < 0]                    # southern hemisphere only
    print(f"PRP: {len(out)} elements, max T {np.nanmin(out.tmax):.0f}-{np.nanmax(out.tmax):.0f} K, "
          f"depth {np.nanmin(out.depth):.3g}-{np.nanmax(out.depth):.3g} m  "
          "-> check that the ranges and units make sense")
    return out


def load_m3_points(path, lat_col="lat", lon_col="lon"):
    """Locations of M3 pixels with ice (Li et al. 2018). CSV with lat, lon columns."""
    df = pd.read_csv(path)
    return pd.DataFrame({"lat": df[lat_col].astype(float), "lon": df[lon_col].astype(float) % 360})


# ------------------------------------------------------------------ classification
def ice_layer(lat_grid, lon_grid, prp, m3=None,
              t_surface=T_SURFACE_ICE, depth_max=DEPTH_MAX,
              surf_frac_min=SURF_FRAC_MIN, sub_frac_min=SUB_FRAC_MIN, m3_radius=200.0):
    """
    lat_grid, lon_grid : arrays (any shape) of the points of YOUR map [deg], roughly regular grid
    prp                : DataFrame from load_prp
    m3                 : DataFrame from load_m3_points (or None)
    surf_frac_min      : minimum fraction of the cell with max T < t_surface for class 2
    sub_frac_min       : minimum fraction of the cell with ice within depth_max for class 1
    m3_radius          : radius [m] around each M3 pixel (~ half of a 280 m pixel)
    returns a dict with ice_class, cold_trap_frac, subsurface_frac, tmax (minimum in the cell),
    depth (minimum in the cell), lat, lon (same shape as the grid)
    """
    shape = np.shape(lat_grid)
    lat = np.asarray(lat_grid, float).ravel()
    lon = np.asarray(lon_grid, float).ravel() % 360
    gx, gy = latlon_to_xy(lat, lon)
    tree = cKDTree(np.c_[gx, gy])
    spacing = np.median(tree.query(np.c_[gx, gy], k=2)[0][:, 1])

    # each PRP element goes to the nearest cell (grid point), if it falls inside it
    px, py = latlon_to_xy(prp.lat.values, prp.lon.values)
    dist, idx = tree.query(np.c_[px, py])
    inside = dist <= spacing * np.sqrt(0.5) * 1.01
    idx = idx[inside]
    t = np.nan_to_num(prp.tmax.values[inside], nan=np.inf)
    d = np.nan_to_num(prp.depth.values[inside], nan=np.inf)
    n = lat.size
    count = np.bincount(idx, minlength=n)
    has = count > 0
    with np.errstate(invalid="ignore", divide="ignore"):
        surf = np.bincount(idx, weights=t < t_surface, minlength=n) / count
        sub = np.bincount(idx, weights=d <= depth_max, minlength=n) / count
    tmin = np.full(n, np.inf)
    np.minimum.at(tmin, idx, t)
    dmin = np.full(n, np.inf)
    np.minimum.at(dmin, idx, d)
    tmin[~np.isfinite(tmin)] = np.nan
    dmin[~np.isfinite(dmin)] = np.nan
    surf[~has] = np.nan
    sub[~has] = np.nan

    cls = np.zeros(n, dtype=np.int8)
    cls[np.nan_to_num(sub) >= sub_frac_min] = 1
    cls[np.nan_to_num(surf) >= surf_frac_min] = 2

    # M3: observed ice
    if m3 is not None and len(m3):
        mx, my = latlon_to_xy(m3.lat.values, m3.lon.values)
        d_m3, _ = cKDTree(np.c_[mx, my]).query(np.c_[gx, gy])
        cls[d_m3 <= max(m3_radius, spacing * np.sqrt(0.5))] = 3

    print(f"  cells {spacing / 1e3:.1f} km, {np.median(count[has]):.0f} PRP elements per cell; "
          f"{(~has).sum()} cells without data")
    print(f"  cold traps: {100 * np.nanmean(surf):.1f}% of the area, "
          f"ice stable within {depth_max:g} m: {100 * np.nanmean(sub):.1f}%")
    names = {0: "none", 1: "stable below the surface", 2: "cold trap", 3: "observed (M3)"}
    for k, v in names.items():
        print(f"  class {k} ({v}): {np.sum(cls == k)} points")

    def r(a):
        return a.reshape(shape)
    return {"lat": r(lat), "lon": r(lon), "ice_class": r(cls), "cold_trap_frac": r(surf),
            "subsurface_frac": r(sub), "tmax": r(tmin), "depth": r(dmin)}


def distance_to_ice(lat_grid, lon_grid, layer, min_class=2):
    """Distance [m] of each point to the nearest ice of class >= min_class (for the trade-off)."""
    gx, gy = latlon_to_xy(np.ravel(lat_grid), np.ravel(lon_grid))
    ice = np.ravel(layer["ice_class"]) >= min_class
    if not ice.any():
        return np.full(np.shape(lat_grid), np.inf)
    d, _ = cKDTree(np.c_[gx[ice], gy[ice]]).query(np.c_[gx, gy])
    return d.reshape(np.shape(lat_grid))


# ------------------------------------------------------------------ export
COLORS = {1: "#7fb3ff", 2: "#1f6fff", 3: "#00e5ff"}   # light blue -> blue -> cyan


def export_layer(layer, basename="mappa_ghiaccio", geojson_min_class=2):
    """
    Save:
      basename.csv     all points (lat, lon, ice_class, fractions, minimum tmax and depth of the cell)
      basename.geojson ONLY the points with ice_class >= geojson_min_class, with colour, for Cesium
                       (default 2: cold traps and M3; 1 to include subsurface stability)
      basename.png     preview (all classes)
    """
    lat = np.ravel(layer["lat"]); lon = np.ravel(layer["lon"])
    cls = np.ravel(layer["ice_class"])
    tmax = np.ravel(layer["tmax"]); depth = np.ravel(layer["depth"])
    surf = np.ravel(layer["cold_trap_frac"]); sub = np.ravel(layer["subsurface_frac"])

    pd.DataFrame({"lat": lat, "lon": lon, "ice_class": cls,
                  "cold_trap_frac": np.round(surf, 3), "subsurface_frac": np.round(sub, 3),
                  "tmax_min_K": tmax, "ice_depth_min_m": depth}).to_csv(f"{basename}.csv", index=False)

    feats = []
    for i in np.flatnonzero(cls >= geojson_min_class):
        lon180 = ((lon[i] + 180) % 360) - 180
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(float(lon180), 6), round(float(lat[i]), 6)]},
            "properties": {"ice_class": int(cls[i]), "color": COLORS[int(cls[i])],
                           "cold_trap_frac": None if np.isnan(surf[i]) else round(float(surf[i]), 3),
                           "tmax_min_K": None if np.isnan(tmax[i]) else round(float(tmax[i]), 1),
                           "ice_depth_min_m": None if np.isnan(depth[i]) else round(float(depth[i]), 3)},
        })
    with open(f"{basename}.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    x, y = latlon_to_xy(lat, lon)
    fig, ax = plt.subplots(figsize=(7, 7))
    shown = cls >= geojson_min_class          # as in the web app
    ax.scatter(x[~shown] / 1e3, y[~shown] / 1e3, s=1, c="0.85")
    cmap = ListedColormap([COLORS[1], COLORS[2], COLORS[3]])
    sc = ax.scatter(x[shown] / 1e3, y[shown] / 1e3, s=2, c=cls[shown], cmap=cmap, vmin=0.5, vmax=3.5)
    cb = fig.colorbar(sc, ax=ax, ticks=[1, 2, 3], shrink=0.7)
    cb.ax.set_yticklabels(["stable below surface", "cold trap", "observed M3"])
    ax.set_aspect("equal"); ax.set_xlabel("x [km]"); ax.set_ylabel("y [km]")
    ax.set_title("Water ice - south pole")
    fig.savefig(f"{basename}.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved {basename}.csv, {basename}.geojson ({len(feats)} ice points), {basename}.png")
