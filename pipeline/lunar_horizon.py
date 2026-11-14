"""
lunar_horizon.py
Orizzonte topografico da DEM e visibilita' della Terra (o del Sole) dai siti lunari.

Idea:
  per ogni sito si "lancia un raggio" sul DEM lungo un azimut e si cerca l'angolo
  massimo sotto cui si vede il terreno (creste, bordi dei crateri), tenendo conto
  della curvatura lunare. Quello e' l'orizzonte locale in quella direzione.
  La Terra (o il Sole) e' visibile se la sua elevazione supera l'orizzonte
  nel suo azimut.

DEM atteso: griglia regolare in proiezione STEREOGRAFICA POLARE SUD centrata sul polo
(come i prodotti LOLA polari), altezze in metri rispetto alla sfera di riferimento
R = 1737.4 km.  Convenzione assunta (PROJ +proj=stere +lat_0=-90 +lon_0=0):
    x = rho * sin(lon),   y = rho * cos(lon),   rho = 2 R tan((90 + lat)/2)
Verificala con un punto noto del tuo DEM (funzione xy_to_latlon): se lat/lon non
tornano, adatta xy_to_latlon / latlon_to_xy.

Dipendenze: numpy, scipy (matplotlib solo per il grafico del profilo).
"""

import numpy as np
from scipy.ndimage import map_coordinates

R_MOON = 1737400.0          # [m]
EARTH_RADIUS_DEG = 0.95     # raggio apparente medio della Terra vista dalla Luna
SUN_RADIUS_DEG = 0.27


# ---------------------------------------------------------------- proiezione
def xy_to_latlon(x, y, R=R_MOON):
    rho = np.hypot(x, y)
    lat = -90.0 + 2.0 * np.degrees(np.arctan(rho / (2.0 * R)))
    lon = np.degrees(np.arctan2(x, y)) % 360.0
    return lat, lon


def latlon_to_xy(lat, lon, R=R_MOON):
    rho = 2.0 * R * np.tan(np.radians(90.0 + np.asarray(lat)) / 2.0)
    lon = np.radians(lon)
    return rho * np.sin(lon), rho * np.cos(lon)


def local_axes_xy(x, y):
    """Versori nord ed est locali nel piano della mappa (polo sud: nord = radiale verso l'esterno)."""
    rho = np.hypot(x, y)
    rho = np.where(rho < 1e-6, 1e-6, rho)
    north = np.stack([x / rho, y / rho], axis=-1)
    east = np.stack([y / rho, -x / rho], axis=-1)
    return north, east


# ---------------------------------------------------------------- angoli locali
def enu_angles(lat_deg, lon_deg, vec_hat):
    """
    Elevazione e azimut (da nord, orario verso est) [deg] di una direzione 3D
    nel frame solidale Luna, vista da siti (lat, lon).  vec_hat: (3,) versore.
    Per la Terra con parallasse passa invece il vettore sito->Terra normalizzato
    per ogni sito (shape (N,3)).
    """
    lat = np.radians(np.asarray(lat_deg, float))
    lon = np.radians(np.asarray(lon_deg, float))
    up = np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], -1)
    east = np.stack([-np.sin(lon), np.cos(lon), np.zeros_like(lon)], -1)
    north = np.stack([-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)], -1)
    v = np.asarray(vec_hat, float)
    vu = np.sum(up * v, -1)
    ve = np.sum(east * v, -1)
    vn = np.sum(north * v, -1)
    el = np.degrees(np.arcsin(np.clip(vu, -1, 1)))
    az = np.degrees(np.arctan2(ve, vn)) % 360.0
    return el, az


# ---------------------------------------------------------------- modello
class HorizonModel:
    def __init__(self, Z, x, y, R=R_MOON, observer_height=2.0):
        """
        Z : (ny, nx) quote [m]
        x : (nx,) coordinate colonne [m];  y : (ny,) coordinate righe [m]
        observer_height : altezza dell'osservatore/antenna sopra il suolo [m]
        """
        self.Z = np.asarray(Z, float)
        self.x = np.asarray(x, float)
        self.y = np.asarray(y, float)
        self.dx = self.x[1] - self.x[0]
        self.dy = self.y[1] - self.y[0]       # puo' essere negativo (righe dall'alto)
        self.R = R
        self.h_obs = observer_height
        self.pixel = min(abs(self.dx), abs(self.dy))
        self._build_pyramid()

    def _build_pyramid(self, max_levels=14):
        """
        Piramide di DEM a risoluzione dimezzata con MASSIMO sul blocco: lontano dal sito
        si campiona con passo grande senza perdere le creste (scelta conservativa).
        """
        self.levels = [self.Z]
        Z = self.Z
        for _ in range(max_levels):
            ny, nx = Z.shape
            if min(ny, nx) < 4:
                break
            ny2, nx2 = ny // 2 * 2, nx // 2 * 2
            Zc = Z[:ny2, :nx2]
            Z = Zc.reshape(ny2 // 2, 2, nx2 // 2, 2).max(axis=(1, 3))
            self.levels.append(Z)

    def _sample(self, xs, ys, level=0):
        col = (xs - self.x[0]) / self.dx
        row = (ys - self.y[0]) / self.dy
        if level == 0:
            Z, order = self.Z, 1
        else:
            f = 2 ** level
            Z, order = self.levels[level], 0
            col = col / f - 0.5 + 0.5 / f
            row = row / f - 0.5 + 0.5 / f
        return map_coordinates(Z, [row.ravel(), col.ravel()], order=order,
                               mode="constant", cval=-1e9).reshape(np.shape(xs))

    def _levels_for(self, d):
        """
        Livello di piramide per ogni distanza: blocco <= passo di campionamento.
        (Con blocco >= 2 x passo il massimo sul blocco includeva il terreno accanto al sito gia'
        al primo passo e alzava l'orizzonte sui pendii: visibilita' della Terra -0.08 rispetto a
        LOLA AVGVISIB_EARTH; con blocco <= passo l'errore e' quello del campionamento a piena
        risoluzione.)
        """
        step = np.diff(np.r_[0.0, d])
        lev = np.floor(np.log2(np.maximum(step / self.pixel, 1.0))).astype(int)
        return np.clip(lev, 0, len(self.levels) - 1)

    def height_at(self, xs, ys):
        return self._sample(np.asarray(xs, float), np.asarray(ys, float))

    def distances(self, max_dist=150e3, n_steps=300):
        """Distanze di campionamento: fitte vicino al sito, rade lontano."""
        return np.geomspace(self.pixel, max_dist, n_steps)

    def horizon(self, xs, ys, az_deg, max_dist=150e3, n_steps=300, chunk=2000):
        """
        Elevazione dell'orizzonte [deg].
        xs, ys : (N,) coordinate dei siti [m]
        az_deg : (K,) azimut comuni a tutti i siti, oppure (N, K) azimut per sito
        ritorna (N, K)
        """
        xs = np.asarray(xs, float).ravel()
        ys = np.asarray(ys, float).ravel()
        N = xs.size
        az = np.asarray(az_deg, float)
        if az.ndim == 1:
            az = np.broadcast_to(az, (N, az.size))
        K = az.shape[1]
        d = self.distances(max_dist, n_steps)                     # (M,)
        drop = d**2 / (2.0 * self.R)                              # curvatura
        lev = self._levels_for(d)
        out = np.empty((N, K))

        north, east = local_axes_xy(xs, ys)                      # (N,2)
        h0 = self.height_at(xs, ys) + self.h_obs                 # (N,)

        for s in range(0, N, chunk):
            e = slice(s, min(s + chunk, N))
            A = np.radians(az[e])                                 # (n,K)
            dirx = np.cos(A) * north[e, 0, None] + np.sin(A) * east[e, 0, None]
            diry = np.cos(A) * north[e, 1, None] + np.sin(A) * east[e, 1, None]
            best = np.full(dirx.shape, -np.pi / 2)
            for L in np.unique(lev):
                m = lev == L
                dm = d[m]
                px = xs[e, None, None] + dirx[..., None] * dm     # (n,K,m)
                py = ys[e, None, None] + diry[..., None] * dm
                ht = self._sample(px, py, L)
                ang = np.arctan2(ht - h0[e, None, None] - drop[m], dm)
                best = np.maximum(best, ang.max(axis=-1))
            out[e] = np.degrees(best)
        return out

    # ------------------------------------------------------------ profilo
    def profile(self, x0, y0, az_deg, max_dist=150e3, n_steps=600):
        """Profilo del terreno lungo un azimut, gia' corretto per la curvatura."""
        north, east = local_axes_xy(np.array([x0]), np.array([y0]))
        A = np.radians(az_deg)
        dvec = np.cos(A) * north[0] + np.sin(A) * east[0]
        d = np.linspace(0.0, max_dist, n_steps)
        h = self.height_at(x0 + dvec[0] * d, y0 + dvec[1] * d)
        return d, h - d**2 / (2.0 * self.R)

    def plot_line_of_sight(self, x0, y0, az_deg, target_el_deg, max_dist=150e3, ax=None,
                           title="Linea di vista verso la Terra"):
        """Grafico per la presentazione: terreno, orizzonte e linea di vista verso il target."""
        import matplotlib.pyplot as plt
        d, h = self.profile(x0, y0, az_deg, max_dist)
        valid = h > -1e8
        d, h = d[valid], h[valid]
        h0 = h[0] + self.h_obs
        hz = self.horizon([x0], [y0], [az_deg], max_dist)[0, 0]
        if ax is None:
            _, ax = plt.subplots(figsize=(10, 4))
        ax.fill_between(d / 1e3, h, h.min() - 200, color="0.6", label="terreno")
        ax.plot(d / 1e3, h0 + d * np.tan(np.radians(target_el_deg)), "b-",
                label=f"linea di vista Terra (el = {target_el_deg:.2f}°)")
        ax.plot(d / 1e3, h0 + d * np.tan(np.radians(hz)), "r--",
                label=f"orizzonte (el = {hz:.2f}°)")
        ax.plot(0, h0, "k^", ms=10, label="sito")
        ax.set_xlabel("distanza [km]")
        ax.set_ylabel("quota [m]")
        visible = target_el_deg > hz
        ax.set_title(f"{title} - {'VISIBILE' if visible else 'OSTRUITA'}")
        ax.legend(loc="best")
        ax.grid(alpha=0.4)
        return ax


# ---------------------------------------------------------------- visibilita'
def interp_horizon(hz_table, az_table, az_query):
    """
    Interpola l'orizzonte nell'azimut richiesto, sito per sito.
    hz_table : (N,K)  az_table : (N,K) crescente per riga (o (K,))  az_query : (N,)
    """
    hz_table = np.asarray(hz_table)
    N, K = hz_table.shape
    az_table = np.broadcast_to(np.asarray(az_table, float), (N, K))
    out = np.empty(N)
    for i in range(N):
        out[i] = np.interp(az_query[i], az_table[i], hz_table[i], period=360.0)
    return out


def earth_window_azimuths(az_E_series, half_margin_deg=3.0, step_deg=0.5):
    """
    Per ogni sito, griglia di azimut che copre solo l'intervallo spazzato dalla Terra
    (dalle effemeridi) + un margine. Molto piu' veloce che calcolare 360 gradi.
    az_E_series : (T, N) azimut della Terra nel tempo per ogni sito [deg]
    ritorna (N, K)
    """
    a = np.radians(az_E_series)
    center = np.degrees(np.arctan2(np.sin(a).mean(0), np.cos(a).mean(0)))   # media circolare
    dev = (az_E_series - center[None, :] + 180.0) % 360.0 - 180.0
    half = np.abs(dev).max(0) + half_margin_deg
    K = int(np.ceil(2 * half.max() / step_deg)) + 1
    u = np.linspace(-1.0, 1.0, K)
    return (center[:, None] + u[None, :] * half[:, None]) % 360.0
