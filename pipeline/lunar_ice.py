"""
lunar_ice.py
Layer "ghiaccio d'acqua" per la mappa del polo Sud lunare.

Fonti:
  - Diviner Polar Resource Product (PRP), file DLRE_PRP_SOUTH.TAB (PDS, Paige et al. 2010):
    temperatura massima annua e profondita' del permafrost di ghiaccio per elementi di mesh.
  - Li et al. 2018 (PNAS): posizioni dei pixel M3 (~280 m) con ghiaccio esposto in superficie.

Classi in uscita (ice_class):
  0 = nessun ghiaccio
  1 = ghiaccio stabile SOTTO la superficie (profondita' permafrost <= depth_max)
  2 = ghiaccio stabile IN superficie (T max annua < 110 K)
  3 = ghiaccio OSSERVATO in superficie (pixel M3)

Uso:
    from lunar_ice import load_prp, load_m3_points, ice_layer, export_layer
    prp = load_prp("DLRE_PRP_SOUTH.TAB", col_lat=?, col_lon=?, col_tmax=?, col_depth=?)
    m3  = load_m3_points("li2018_south.csv")          # colonne lat, lon (opzionale)
    layer = ice_layer(lat_grid, lon_grid, prp, m3)
    export_layer(layer, "mappa_ghiaccio")
"""

import json
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

R_MOON = 1737400.0
T_SURFACE_ICE = 110.0     # K: sotto questa T max annua il ghiaccio superficiale e' stabile
DEPTH_MAX = 0.5           # m: ghiaccio sotterraneo considerato "accessibile"


def latlon_to_xy(lat, lon, R=R_MOON):
    """Stereografica polare sud: x = rho sin(lon), y = rho cos(lon) [m]."""
    rho = 2.0 * R * np.tan(np.radians(90.0 + np.asarray(lat, float)) / 2.0)
    lon = np.radians(np.asarray(lon, float))
    return rho * np.sin(lon), rho * np.cos(lon)


# ------------------------------------------------------------------ lettura dati
def peek(path, n=5):
    """Stampa le prime righe del file: usala per capire quali colonne usare (vedi anche il .LBL)."""
    with open(path, "r", errors="replace") as f:
        for _ in range(n):
            print(f.readline().rstrip())


def load_prp(path, col_lat=10, col_lon=9, col_tmax=13, col_depth=14,
             depth_scale=1.0, nodata_values=(-9999.0, -999.0, 9999.0), skiprows=1):
    """
    Legge DLRE_PRP_SOUTH.TAB (Diviner PRP V2.0, 15 colonne, prima riga = intestazione):
      0-8  tri1_x..tri3_z (vertici del triangolo, km)
      9    tri_clon  longitudine del centroide [deg, -180..180]
      10   tri_clat  latitudine del centroide [deg]
      11   tri_calt  quota del centroide [km]
      12   temp_avg  T media annua [K]
      13   temp_max  T massima annua [K]
      14   ice_depth profondita' del permafrost di ghiaccio [m]
           (-999 = nessun ghiaccio stabile entro ~2 m, -1 = stabile in superficie -> 0 m)
    I default degli indici corrispondono a questo formato.
    depth_scale : fattore per convertire la profondita' in metri (es. 0.01 se e' in cm).
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
    # -1 = ghiaccio stabile gia' in superficie (tutti questi elementi hanno T max < ~101 K):
    # profondita' 0 m, non un valore negativo.
    out.loc[out.depth == -1.0 * depth_scale, "depth"] = 0.0
    out = out[out.lat < 0]                    # solo emisfero sud
    print(f"PRP: {len(out)} elementi, T max {np.nanmin(out.tmax):.0f}-{np.nanmax(out.tmax):.0f} K, "
          f"profondita' {np.nanmin(out.depth):.3g}-{np.nanmax(out.depth):.3g} m  "
          "-> controlla che range e unita' siano sensati")
    return out


def load_m3_points(path, lat_col="lat", lon_col="lon"):
    """Posizioni dei pixel M3 con ghiaccio (Li et al. 2018). CSV con colonne lat, lon."""
    df = pd.read_csv(path)
    return pd.DataFrame({"lat": df[lat_col].astype(float), "lon": df[lon_col].astype(float) % 360})


# ------------------------------------------------------------------ classificazione
def ice_layer(lat_grid, lon_grid, prp, m3=None,
              t_surface=T_SURFACE_ICE, depth_max=DEPTH_MAX,
              prp_max_dist=1000.0, m3_radius=200.0):
    """
    lat_grid, lon_grid : array (qualsiasi forma) dei punti della TUA mappa [deg]
    prp                : DataFrame da load_prp
    m3                 : DataFrame da load_m3_points (o None)
    prp_max_dist       : distanza max [m] dall'elemento PRP piu' vicino (oltre -> nessun dato)
    m3_radius          : raggio [m] attorno a ogni pixel M3 (~ meta' pixel da 280 m)
    ritorna dict con ice_class, tmax, depth, lat, lon (stessa forma della griglia)
    """
    shape = np.shape(lat_grid)
    lat = np.asarray(lat_grid, float).ravel()
    lon = np.asarray(lon_grid, float).ravel() % 360
    gx, gy = latlon_to_xy(lat, lon)

    # Diviner PRP -> griglia (elemento piu' vicino)
    px, py = latlon_to_xy(prp.lat.values, prp.lon.values)
    dist, idx = cKDTree(np.c_[px, py]).query(np.c_[gx, gy])
    tmax = prp.tmax.values[idx]
    depth = prp.depth.values[idx]
    far = dist > prp_max_dist
    tmax[far] = np.nan
    depth[far] = np.nan

    cls = np.zeros(lat.size, dtype=np.int8)
    cls[np.nan_to_num(depth, nan=np.inf) <= depth_max] = 1
    cls[np.nan_to_num(tmax, nan=np.inf) < t_surface] = 2

    # M3: ghiaccio osservato
    if m3 is not None and len(m3):
        mx, my = latlon_to_xy(m3.lat.values, m3.lon.values)
        d_m3, _ = cKDTree(np.c_[mx, my]).query(np.c_[gx, gy])
        cls[d_m3 <= m3_radius] = 3

    names = {0: "nessuno", 1: "stabile sotto superficie", 2: "stabile in superficie", 3: "osservato (M3)"}
    for k, v in names.items():
        print(f"  classe {k} ({v}): {np.sum(cls == k)} punti")

    return {"lat": lat.reshape(shape), "lon": lon.reshape(shape),
            "ice_class": cls.reshape(shape), "tmax": tmax.reshape(shape),
            "depth": depth.reshape(shape)}


def distance_to_ice(lat_grid, lon_grid, layer, min_class=2):
    """Distanza [m] di ogni punto dal ghiaccio piu' vicino di classe >= min_class (per il trade-off)."""
    gx, gy = latlon_to_xy(np.ravel(lat_grid), np.ravel(lon_grid))
    ice = np.ravel(layer["ice_class"]) >= min_class
    if not ice.any():
        return np.full(np.shape(lat_grid), np.inf)
    d, _ = cKDTree(np.c_[gx[ice], gy[ice]]).query(np.c_[gx, gy])
    return d.reshape(np.shape(lat_grid))


# ------------------------------------------------------------------ export
COLORS = {1: "#7fb3ff", 2: "#1f6fff", 3: "#00e5ff"}   # azzurro chiaro -> blu -> ciano


def export_layer(layer, basename="mappa_ghiaccio"):
    """
    Salva:
      basename.csv     tutti i punti (lat, lon, ice_class, tmax, depth)
      basename.geojson SOLO i punti con ghiaccio (classe > 0), con colore, per Cesium
      basename.png     anteprima
    """
    lat = np.ravel(layer["lat"]); lon = np.ravel(layer["lon"])
    cls = np.ravel(layer["ice_class"])
    tmax = np.ravel(layer["tmax"]); depth = np.ravel(layer["depth"])

    pd.DataFrame({"lat": lat, "lon": lon, "ice_class": cls, "tmax_K": tmax,
                  "ice_depth_m": depth}).to_csv(f"{basename}.csv", index=False)

    feats = []
    for i in np.flatnonzero(cls > 0):
        lon180 = ((lon[i] + 180) % 360) - 180
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(float(lon180), 6), round(float(lat[i]), 6)]},
            "properties": {"ice_class": int(cls[i]), "color": COLORS[int(cls[i])],
                           "tmax_K": None if np.isnan(tmax[i]) else round(float(tmax[i]), 1),
                           "ice_depth_m": None if np.isnan(depth[i]) else round(float(depth[i]), 3)},
        })
    with open(f"{basename}.geojson", "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    x, y = latlon_to_xy(lat, lon)
    fig, ax = plt.subplots(figsize=(7, 7))
    ax.scatter(x[cls == 0] / 1e3, y[cls == 0] / 1e3, s=1, c="0.85")
    cmap = ListedColormap([COLORS[1], COLORS[2], COLORS[3]])
    sc = ax.scatter(x[cls > 0] / 1e3, y[cls > 0] / 1e3, s=2, c=cls[cls > 0], cmap=cmap, vmin=0.5, vmax=3.5)
    cb = fig.colorbar(sc, ax=ax, ticks=[1, 2, 3], shrink=0.7)
    cb.ax.set_yticklabels(["sotto superficie", "stabile in sup.", "osservato M3"])
    ax.set_aspect("equal"); ax.set_xlabel("x [km]"); ax.set_ylabel("y [km]")
    ax.set_title("Ghiaccio d'acqua - polo Sud")
    fig.savefig(f"{basename}.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print(f"Salvati {basename}.csv, {basename}.geojson ({len(feats)} punti ghiaccio), {basename}.png")
