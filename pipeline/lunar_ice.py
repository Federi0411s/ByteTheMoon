"""
lunar_ice.py
Layer "ghiaccio d'acqua" per la mappa del polo Sud lunare.

Fonti:
  - Diviner Polar Resource Product (PRP), file DLRE_PRP_SOUTH.TAB (PDS, Paige et al. 2010):
    temperatura massima annua e profondita' del permafrost di ghiaccio per elementi di mesh.
  - Li et al. 2018 (PNAS): posizioni dei pixel M3 (~280 m) con ghiaccio esposto in superficie.

Ogni punto della griglia rappresenta una CELLA (Voronoi dei punti, 4 km x 4 km per la griglia
di charging_points.csv): si usano tutti gli elementi PRP (~0.5 km) che cadono nella cella e si
classifica in base alla FRAZIONE D'AREA, non al singolo elemento piu' vicino (che bastava a
marcare un'intera cella per una piccola sacca fredda).

Classi in uscita (ice_class):
  0 = nessun ghiaccio
  1 = ghiaccio stabile SOTTO la superficie (profondita' <= depth_max) su >= sub_frac_min della cella.
      E' STABILITA' termica (il ghiaccio sopravvivrebbe se presente), non una rilevazione:
      copre ~1/3 della mappa, quindi di default non va nel GeoJSON per la web app.
  2 = trappola fredda: T max annua < 110 K su >= surf_frac_min della cella
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
SURF_FRAC_MIN = 0.25      # classe 2 se almeno 1/4 della cella e' trappola fredda
SUB_FRAC_MIN = 0.5        # classe 1 se almeno meta' della cella ha ghiaccio stabile entro DEPTH_MAX


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
              surf_frac_min=SURF_FRAC_MIN, sub_frac_min=SUB_FRAC_MIN, m3_radius=200.0):
    """
    lat_grid, lon_grid : array (qualsiasi forma) dei punti della TUA mappa [deg], griglia ~regolare
    prp                : DataFrame da load_prp
    m3                 : DataFrame da load_m3_points (o None)
    surf_frac_min      : frazione minima della cella con T max < t_surface per la classe 2
    sub_frac_min       : frazione minima della cella con ghiaccio entro depth_max per la classe 1
    m3_radius          : raggio [m] attorno a ogni pixel M3 (~ meta' pixel da 280 m)
    ritorna dict con ice_class, cold_trap_frac, subsurface_frac, tmax (minima nella cella),
    depth (minima nella cella), lat, lon (stessa forma della griglia)
    """
    shape = np.shape(lat_grid)
    lat = np.asarray(lat_grid, float).ravel()
    lon = np.asarray(lon_grid, float).ravel() % 360
    gx, gy = latlon_to_xy(lat, lon)
    tree = cKDTree(np.c_[gx, gy])
    spacing = np.median(tree.query(np.c_[gx, gy], k=2)[0][:, 1])

    # ogni elemento PRP va alla cella (punto di griglia) piu' vicina, se ci cade dentro
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

    # M3: ghiaccio osservato
    if m3 is not None and len(m3):
        mx, my = latlon_to_xy(m3.lat.values, m3.lon.values)
        d_m3, _ = cKDTree(np.c_[mx, my]).query(np.c_[gx, gy])
        cls[d_m3 <= max(m3_radius, spacing * np.sqrt(0.5))] = 3

    print(f"  celle {spacing / 1e3:.1f} km, {np.median(count[has]):.0f} elementi PRP per cella; "
          f"{(~has).sum()} celle senza dati")
    print(f"  trappole fredde: {100 * np.nanmean(surf):.1f}% dell'area, "
          f"ghiaccio stabile entro {depth_max:g} m: {100 * np.nanmean(sub):.1f}%")
    names = {0: "nessuno", 1: "stabile sotto superficie", 2: "trappola fredda", 3: "osservato (M3)"}
    for k, v in names.items():
        print(f"  classe {k} ({v}): {np.sum(cls == k)} punti")

    def r(a):
        return a.reshape(shape)
    return {"lat": r(lat), "lon": r(lon), "ice_class": r(cls), "cold_trap_frac": r(surf),
            "subsurface_frac": r(sub), "tmax": r(tmin), "depth": r(dmin)}


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


def export_layer(layer, basename="mappa_ghiaccio", geojson_min_class=2):
    """
    Salva:
      basename.csv     tutti i punti (lat, lon, ice_class, frazioni, tmax e depth minime della cella)
      basename.geojson SOLO i punti con ice_class >= geojson_min_class, con colore, per Cesium
                       (default 2: trappole fredde e M3; 1 per includere la stabilita' sotterranea)
      basename.png     anteprima (tutte le classi)
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
    shown = cls >= geojson_min_class          # come nella web app
    ax.scatter(x[~shown] / 1e3, y[~shown] / 1e3, s=1, c="0.85")
    cmap = ListedColormap([COLORS[1], COLORS[2], COLORS[3]])
    sc = ax.scatter(x[shown] / 1e3, y[shown] / 1e3, s=2, c=cls[shown], cmap=cmap, vmin=0.5, vmax=3.5)
    cb = fig.colorbar(sc, ax=ax, ticks=[1, 2, 3], shrink=0.7)
    cb.ax.set_yticklabels(["stabile sotto sup.", "trappola fredda", "osservato M3"])
    ax.set_aspect("equal"); ax.set_xlabel("x [km]"); ax.set_ylabel("y [km]")
    ax.set_title("Ghiaccio d'acqua - polo Sud")
    fig.savefig(f"{basename}.png", dpi=200, bbox_inches="tight")
    plt.close(fig)
    print(f"Salvati {basename}.csv, {basename}.geojson ({len(feats)} punti ghiaccio), {basename}.png")
