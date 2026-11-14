"""
Mappa delle radiazioni sulla superficie lunare (GCR + albedo) in funzione della posizione.

Modello
-------
Il flusso di GCR/SEP nello spazio libero e' isotropo e uguale su tutta la Luna.
Cio' che cambia con la posizione e' la frazione di cielo visibile (sky-view factor),
che si ricava dal DEM calcolando l'angolo di orizzonte H(phi) in N azimut:

    f_sky = 1/(4*pi) * integrale_0^2pi (1 - sin H(phi)) dphi     (terreno piatto -> 0.5)

    D(lat, lon) = D_primari_spazio * f_sky  +  D_albedo_suolo * (1 - f_sky) * k_albedo

Calibrazione su Chang'e 4 / LND (terreno piatto, f_sky ~ 0.5, minimo solare 2019):
    dose totale in Si      = 13.2 uGy/h
    componente neutra      =  3.1 uGy/h   (albedo dal suolo)
    componente carica      = 10.1 uGy/h   -> spazio libero = 10.1 / 0.5 = 20.2 uGy/h
    albedo per frazione di suolo = 3.1 / 0.5 = 6.2 uGy/h
    dose equivalente ~ 60 uSv/h  -> rapporto Sv/Gy ~ 60/13.2

Per un evento SEP (worst case) metti in D_SEP_SPAZIO la dose nello spazio libero
che ottieni da SPENVIS (stessa schermatura): viene scalata con f_sky.

Input
-----
CSV/TXT con colonne lat, lon, elev (gradi, gradi, metri) su griglia regolare lat/lon
(es. export dei dati LOLA). Se la griglia non e' regolare viene interpolata.

Output
------
- CSV con lat, lon, elev, H_medio, f_sky, dose, classe, colore (per Cesium/web app)
- GeoJSON di punti colorati (opzionale, per sottoinsiemi non troppo grandi)
- PNG della mappa in proiezione polare stereografica

Uso
---
    python radiazioni_luna.py dem.csv --lat-max -80
    python radiazioni_luna.py --test          # DEM sintetico di prova
"""

import argparse
import json

import numpy as np
from scipy.interpolate import RegularGridInterpolator, griddata

R_LUNA = 1737.4e3  # m

# ---------------- PARAMETRI DEL MODELLO (modificabili) ----------------
D_PRIMARI_SPAZIO = 20.2   # uGy/h in Si, GCR nello spazio libero (Chang'e 4, minimo solare)
D_ALBEDO_SUOLO = 6.2      # uGy/h in Si, secondari neutri per unita' di frazione di suolo
D_SEP_SPAZIO = 0.0        # uGy/h medio da SPENVIS per evento SEP (0 = solo GCR)
SV_SU_GY = 60.0 / 13.2    # rapporto dose equivalente / dose assorbita (Chang'e 4)

# Soglie di classificazione su dose assorbita [uGy/h] -- DA DECIDERE
SOGLIA_VERDE = 12.0       # dose <= verde
SOGLIA_GIALLO = 12.8      # verde < dose <= giallo, sopra -> rosso

N_AZIMUT = 32             # direzioni per l'orizzonte
DIST_MAX = 50e3           # m, distanza massima di ricerca dell'orizzonte
N_PASSI = 60              # passi lungo ogni direzione (spaziatura logaritmica)


# ---------------- LETTURA DATI ----------------
def carica_dem(percorso):
    """Legge lat, lon, elev e restituisce griglia regolare (lat_1d, lon_1d, Z[lat, lon])."""
    dati = np.genfromtxt(percorso, delimiter=None if percorso.endswith(".txt") else ",",
                         names=True, dtype=float)
    nomi = [n.lower() for n in dati.dtype.names]
    col = lambda *chiavi: dati[dati.dtype.names[next(i for i, n in enumerate(nomi)
                                                     if any(k in n for k in chiavi))]]
    lat, lon, z = col("lat"), col("lon"), col("elev", "height", "alt", "z")
    lon = np.mod(lon, 360.0)

    lat_u, lon_u = np.unique(lat), np.unique(lon)
    if lat_u.size * lon_u.size == lat.size:          # griglia regolare
        Z = np.full((lat_u.size, lon_u.size), np.nan)
        Z[np.searchsorted(lat_u, lat), np.searchsorted(lon_u, lon)] = z
    else:                                            # punti sparsi -> interpolazione
        print("Griglia non regolare: interpolo su griglia regolare...")
        n = int(np.sqrt(lat.size))
        lat_u = np.linspace(lat.min(), lat.max(), n)
        lon_u = np.linspace(lon.min(), lon.max(), 2 * n)
        LA, LO = np.meshgrid(lat_u, lon_u, indexing="ij")
        Z = griddata((lat, lon), z, (LA, LO), method="linear")
    return lat_u, lon_u, Z


def dem_sintetico():
    """DEM di prova del polo Sud (-90..-80) con alcuni crateri e un rilievo."""
    lat = np.linspace(-90, -80, 201)
    lon = np.arange(0, 360, 0.5)
    LA, LO = np.meshgrid(lat, lon, indexing="ij")
    x, y = _stereo(LA, LO)
    Z = np.zeros_like(LA)
    crateri = [(0, 0, 10e3, 4000), (60e3, -80e3, 25e3, 3000), (-120e3, 40e3, 15e3, 2500),
               (100e3, 120e3, 40e3, 4000)]
    for cx, cy, r, prof in crateri:
        d = np.hypot(x - cx, y - cy) / r
        Z += np.where(d < 1, -prof * (1 - d**2), 0) + np.where((d >= 1) & (d < 1.6),
                                                               0.3 * prof * np.cos((d - 1) / 0.6 * np.pi / 2)**2, 0)
    Z += 5000 * np.exp(-(np.hypot(x + 60e3, y + 110e3) / 30e3) ** 2)  # montagna
    return lat, lon, Z


# ---------------- GEOMETRIA ----------------
def _destinazione(lat, lon, azimut, dist):
    """Punto a distanza dist [m] lungo il cerchio massimo con azimut dato (gradi)."""
    phi1, lam1 = np.radians(lat), np.radians(lon)
    th, dl = np.radians(azimut), dist / R_LUNA
    phi2 = np.arcsin(np.clip(np.sin(phi1) * np.cos(dl) + np.cos(phi1) * np.sin(dl) * np.cos(th), -1, 1))
    lam2 = lam1 + np.arctan2(np.sin(th) * np.sin(dl) * np.cos(phi1),
                             np.cos(dl) - np.sin(phi1) * np.sin(phi2))
    return np.degrees(phi2), np.mod(np.degrees(lam2), 360.0)


def _stereo(lat, lon):
    """Proiezione polare stereografica (polo Sud), coordinate in m."""
    rho = 2 * R_LUNA * np.tan(np.radians(90 + lat) / 2)
    return rho * np.sin(np.radians(lon)), rho * np.cos(np.radians(lon))


def sky_view_factor(lat_1d, lon_1d, Z, n_az=N_AZIMUT, dist_max=DIST_MAX, n_passi=N_PASSI,
                    blocco=50):
    """Angolo di orizzonte per ogni azimut e frazione di cielo visibile f_sky."""
    globale = lon_1d[-1] - lon_1d[0] > 350
    lon_g, Z_g = lon_1d, Z
    if globale:  # ripete le colonne per gestire il passaggio 360 -> 0
        lon_g = np.concatenate([lon_1d[-2:] - 360, lon_1d, lon_1d[:2] + 360])
        Z_g = np.concatenate([Z[:, -2:], Z, Z[:, :2]], axis=1)
    interp = RegularGridInterpolator((lat_1d, lon_g), Z_g, bounds_error=False, fill_value=np.nan)

    ris = np.radians(abs(lat_1d[1] - lat_1d[0])) * R_LUNA  # passo griglia in m
    distanze = np.geomspace(ris, dist_max, n_passi)
    azimut = np.arange(n_az) * 360.0 / n_az

    H = np.zeros((n_az,) + Z.shape)
    for r0 in range(0, lat_1d.size, blocco):          # a blocchi per la memoria
        r1 = min(r0 + blocco, lat_1d.size)
        LA, LO = np.meshgrid(lat_1d[r0:r1], lon_1d, indexing="ij")
        z0 = Z[r0:r1]
        for k, az in enumerate(azimut):
            hmax = np.full(LA.shape, -np.inf)
            for d in distanze:
                la2, lo2 = _destinazione(LA, LO, az, d)
                if not globale:
                    lo2 = np.where(lo2 > lon_1d[-1] + 1, lo2 - 360, lo2)
                z2 = interp(np.stack([la2, lo2], axis=-1))
                ang = np.arctan2(z2 - z0 - d**2 / (2 * R_LUNA), d)   # con curvatura lunare
                hmax = np.fmax(hmax, ang)
            H[k, r0:r1] = np.where(np.isfinite(hmax), hmax, 0.0)
        print(f"  orizzonte: righe {r1}/{lat_1d.size}")

    f_sky = np.mean(1 - np.sin(H), axis=0) / 2
    return H, f_sky


# ---------------- DOSE E CLASSIFICAZIONE ----------------
def dose(f_sky, k_albedo=1.0, d_sep=D_SEP_SPAZIO):
    """Dose assorbita [uGy/h in Si]. k_albedo: fattore (scalare o mappa) per la
    variazione dei neutroni di albedo, es. da mappe Lunar Prospector/LEND normalizzate."""
    return (D_PRIMARI_SPAZIO + d_sep) * f_sky + D_ALBEDO_SUOLO * (1 - f_sky) * k_albedo


def classifica(D):
    classe = np.where(D <= SOGLIA_VERDE, 0, np.where(D <= SOGLIA_GIALLO, 1, 2))
    return classe, np.array(["verde", "giallo", "rosso"])[classe], \
        np.array(["#2ca02c", "#ffcc00", "#d62728"])[classe]


# ---------------- OUTPUT ----------------
def salva(lat_1d, lon_1d, Z, H, f, D, prefisso, geojson_max=20000):
    LA, LO = np.meshgrid(lat_1d, lon_1d, indexing="ij")
    classe, nome, colore = classifica(D)
    msv_anno = D * SV_SU_GY * 24 * 365.25 / 1000

    ok = np.isfinite(Z)
    righe = np.column_stack([LA[ok], LO[ok], Z[ok], np.degrees(H.mean(0))[ok], f[ok],
                             D[ok], msv_anno[ok], classe[ok]])
    with open(f"{prefisso}.csv", "w") as fh:
        fh.write("lat,lon,elev_m,orizzonte_medio_deg,f_sky,dose_uGy_h,dose_eq_mSv_anno,classe,colore\n")
        for r, c in zip(righe, colore[ok]):
            fh.write(f"{r[0]:.4f},{r[1]:.4f},{r[2]:.1f},{r[3]:.3f},{r[4]:.4f},"
                     f"{r[5]:.3f},{r[6]:.1f},{int(r[7])},{c}\n")

    idx = np.flatnonzero(ok)
    if idx.size > geojson_max:  # sottocampiona per non appesantire Cesium
        idx = idx[:: int(np.ceil(idx.size / geojson_max))]
    feats = [{"type": "Feature",
              "geometry": {"type": "Point", "coordinates": [float(LO.flat[i] if LO.flat[i] <= 180 else LO.flat[i] - 360),
                                                            float(LA.flat[i]), float(Z.flat[i])]},
              "properties": {"dose_uGy_h": round(float(D.flat[i]), 3), "f_sky": round(float(f.flat[i]), 4),
                             "classe": str(nome.flat[i]), "marker-color": str(colore.flat[i])}}
             for i in idx]
    with open(f"{prefisso}.geojson", "w") as fh:
        json.dump({"type": "FeatureCollection", "features": feats}, fh)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap

    # chiude la griglia a 360 gradi per un disegno continuo
    chiudi = lambda A: np.concatenate([A, A[:, :1]], axis=1)
    x, y = _stereo(chiudi(LA), chiudi(LO))
    Zp, Dp, Cp = chiudi(Z), chiudi(D), chiudi(classe)
    fig, ax = plt.subplots(1, 3, figsize=(17, 5.5), constrained_layout=True)
    for a, val, tit, cm in [(ax[0], Zp / 1000, "Elevazione [km]", "gist_earth"),
                            (ax[1], Dp, "Dose assorbita [µGy/h, Si]", "inferno")]:
        m = a.pcolormesh(x / 1e3, y / 1e3, val, cmap=cm, shading="gouraud")
        fig.colorbar(m, ax=a, shrink=0.85)
        a.set_title(tit)
    m = ax[2].pcolormesh(x / 1e3, y / 1e3, Cp.astype(float), shading="gouraud",
                         cmap=ListedColormap(["#2ca02c", "#ffcc00", "#d62728"]), vmin=-0.5, vmax=2.5)
    cb = fig.colorbar(m, ax=ax[2], ticks=[0, 1, 2], shrink=0.85)
    cb.ax.set_yticklabels([f"≤ {SOGLIA_VERDE}", f"≤ {SOGLIA_GIALLO}", f"> {SOGLIA_GIALLO}"])
    ax[2].set_title("Classe radiazioni")
    for a in ax:
        a.set_aspect("equal")
        a.set_xlabel("x [km]")
        a.set_ylabel("y [km]")
    fig.suptitle("Radiazioni sulla superficie lunare - proiezione polare stereografica (polo Sud)")
    fig.savefig(f"{prefisso}.png", dpi=130)
    print(f"Salvati: {prefisso}.csv, {prefisso}.geojson, {prefisso}.png")


def salva_overlay(lat_1d, lon_1d, D, prefisso, alpha=0.6):
    """Immagini equirettangolari RGBA da drappeggiare su Cesium (ImageryLayer):
    <prefisso>_classi.png (verde/giallo/rosso), <prefisso>_continua.png (colormap)
    e <prefisso>_overlay.json con i limiti del rettangolo e la legenda."""
    import matplotlib
    import matplotlib.pyplot as plt
    lon_c = np.where(lon_1d > 180, lon_1d - 360, lon_1d)      # -> [-180, 180]
    ordine = np.argsort(lon_c)
    Dg = D[:, ordine][::-1]                                    # riga 0 = nord
    nan = ~np.isfinite(Dg)

    classe, _, _ = classifica(np.nan_to_num(Dg, nan=0))
    pal = np.array([[44, 160, 44], [255, 204, 0], [214, 39, 40]], dtype=np.uint8)
    rgba = np.zeros(Dg.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = pal[classe]
    rgba[..., 3] = np.where(nan, 0, int(alpha * 255))
    plt.imsave(f"{prefisso}_classi.png", rgba)

    vmin, vmax = float(np.nanmin(D)), float(np.nanmax(D))
    cont = (matplotlib.colormaps["inferno"]((Dg - vmin) / (vmax - vmin + 1e-12)) * 255).astype(np.uint8)
    cont[..., 3] = np.where(nan, 0, int(alpha * 255))
    plt.imsave(f"{prefisso}_continua.png", cont)

    meta = {"west": -180.0, "east": 180.0,
            "south": float(lat_1d.min()), "north": float(lat_1d.max()),
            "unita": "uGy/h (Si)", "dose_min": vmin, "dose_max": vmax,
            "legenda_classi": [{"colore": "#2ca02c", "etichetta": f"<= {SOGLIA_VERDE}"},
                               {"colore": "#ffcc00", "etichetta": f"<= {SOGLIA_GIALLO}"},
                               {"colore": "#d62728", "etichetta": f"> {SOGLIA_GIALLO}"}]}
    with open(f"{prefisso}_overlay.json", "w") as fh:
        json.dump(meta, fh, indent=2)
    print(f"Salvati overlay: {prefisso}_classi.png, {prefisso}_continua.png, {prefisso}_overlay.json")


# ---------------- MAIN ----------------
def main():
    p = argparse.ArgumentParser(description="Mappa radiazioni lunari da DEM")
    p.add_argument("dem", nargs="?", help="CSV/TXT con colonne lat, lon, elev [m]")
    p.add_argument("--test", action="store_true", help="usa un DEM sintetico del polo Sud")
    p.add_argument("--lat-max", type=float, default=None, help="tieni solo lat <= valore (es. -80)")
    p.add_argument("--sep", type=float, default=D_SEP_SPAZIO, help="dose SEP spazio libero [uGy/h] da SPENVIS")
    p.add_argument("--out", default="mappa_radiazioni")
    a = p.parse_args()

    lat, lon, Z = dem_sintetico() if a.test or not a.dem else carica_dem(a.dem)
    if a.lat_max is not None:
        sel = lat <= a.lat_max
        lat, Z = lat[sel], Z[sel]
    print(f"Griglia: {lat.size} x {lon.size} punti")

    H, f = sky_view_factor(lat, lon, Z)
    D = dose(f, d_sep=a.sep)
    print(f"f_sky: min {np.nanmin(f):.3f}  max {np.nanmax(f):.3f}")
    print(f"Dose:  min {np.nanmin(D):.2f}  max {np.nanmax(D):.2f} uGy/h  "
          f"(terreno piatto = {dose(0.5, d_sep=a.sep):.2f})")
    salva(lat, lon, Z, H, f, D, a.out)
    salva_overlay(lat, lon, D, a.out)


if __name__ == "__main__":
    main()
