"""
lunar_horizon.py
Topographic horizon from a DEM and visibility of the Earth (or the Sun) from lunar sites.

Idea:
  for each site a "ray is cast" over the DEM along an azimuth, looking for the maximum
  angle under which terrain is seen (ridges, crater rims), taking the Moon's curvature
  into account. That is the local horizon in that direction.
  The Earth (or the Sun) is visible if its elevation is above the horizon at its
  azimuth.

Expected DEM: regular grid in SOUTH POLAR STEREOGRAPHIC projection centred on the pole
(like the LOLA polar products), heights in metres relative to the reference sphere
R = 1737.4 km.  Assumed convention (PROJ +proj=stere +lat_0=-90 +lon_0=0):
    x = rho * sin(lon),   y = rho * cos(lon),   rho = 2 R tan((90 + lat)/2)
Check it with a known point of your DEM (function xy_to_latlon): if lat/lon don't
match, adapt xy_to_latlon / latlon_to_xy.

Dependencies: numpy, scipy (matplotlib only for the profile plot).
"""

import numpy as np
from scipy.ndimage import map_coordinates

R_MOON = 1737400.0          # [m]
EARTH_RADIUS_DEG = 0.95     # mean apparent radius of the Earth seen from the Moon
SUN_RADIUS_DEG = 0.27


# ---------------------------------------------------------------- projection
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
    """Local north and east unit vectors in the map plane (south pole: north = radially outward)."""
    rho = np.hypot(x, y)
    rho = np.where(rho < 1e-6, 1e-6, rho)
    north = np.stack([x / rho, y / rho], axis=-1)
    east = np.stack([y / rho, -x / rho], axis=-1)
    return north, east


# ---------------------------------------------------------------- local angles
def enu_angles(lat_deg, lon_deg, vec_hat):
    """
    Elevation and azimuth (from north, clockwise towards east) [deg] of a 3D direction
    in the Moon-fixed frame, seen from sites (lat, lon).  vec_hat: (3,) unit vector.
    For the Earth with parallax, pass instead the normalised site->Earth vector
    for each site (shape (N,3)).
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


# ---------------------------------------------------------------- model
class HorizonModel:
    def __init__(self, Z, x, y, R=R_MOON, observer_height=2.0):
        """
        Z : (ny, nx) heights [m]
        x : (nx,) column coordinates [m];  y : (ny,) row coordinates [m]
        observer_height : height of the observer/antenna above the ground [m]
        """
        self.Z = np.asarray(Z, float)
        self.x = np.asarray(x, float)
        self.y = np.asarray(y, float)
        self.dx = self.x[1] - self.x[0]
        self.dy = self.y[1] - self.y[0]       # may be negative (rows from the top)
        self.R = R
        self.h_obs = observer_height
        self.pixel = min(abs(self.dx), abs(self.dy))
        self._build_pyramid()

    def _build_pyramid(self, max_levels=14):
        """
        Pyramid of half-resolution DEMs taking the block MAXIMUM: far from the site we
        sample with long steps without losing the ridges (a conservative choice).
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
        Pyramid level for each distance: block <= sampling step.
        (With block >= 2 x step, the block maximum already included the terrain next to the site
        at the first step and raised the horizon on slopes: Earth visibility -0.08 compared to
        LOLA AVGVISIB_EARTH; with block <= step the error is that of full-resolution
        sampling.)
        """
        step = np.diff(np.r_[0.0, d])
        lev = np.floor(np.log2(np.maximum(step / self.pixel, 1.0))).astype(int)
        return np.clip(lev, 0, len(self.levels) - 1)

    def height_at(self, xs, ys):
        return self._sample(np.asarray(xs, float), np.asarray(ys, float))

    def distances(self, max_dist=150e3, n_steps=300):
        """Sampling distances: dense near the site, sparse far away."""
        return np.geomspace(self.pixel, max_dist, n_steps)

    def horizon(self, xs, ys, az_deg, max_dist=150e3, n_steps=300, chunk=2000):
        """
        Horizon elevation [deg].
        xs, ys : (N,) site coordinates [m]
        az_deg : (K,) azimuths shared by all sites, or (N, K) azimuths per site
        returns (N, K)
        """
        xs = np.asarray(xs, float).ravel()
        ys = np.asarray(ys, float).ravel()
        N = xs.size
        az = np.asarray(az_deg, float)
        if az.ndim == 1:
            az = np.broadcast_to(az, (N, az.size))
        K = az.shape[1]
        d = self.distances(max_dist, n_steps)                     # (M,)
        drop = d**2 / (2.0 * self.R)                              # curvature
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

    # ------------------------------------------------------------ profile
    def profile(self, x0, y0, az_deg, max_dist=150e3, n_steps=600):
        """Terrain profile along an azimuth, already corrected for curvature."""
        north, east = local_axes_xy(np.array([x0]), np.array([y0]))
        A = np.radians(az_deg)
        dvec = np.cos(A) * north[0] + np.sin(A) * east[0]
        d = np.linspace(0.0, max_dist, n_steps)
        h = self.height_at(x0 + dvec[0] * d, y0 + dvec[1] * d)
        return d, h - d**2 / (2.0 * self.R)

    def plot_line_of_sight(self, x0, y0, az_deg, target_el_deg, max_dist=150e3, ax=None,
                           title="Line of sight to the Earth"):
        """Presentation plot: terrain, horizon and line of sight to the target."""
        import matplotlib.pyplot as plt
        d, h = self.profile(x0, y0, az_deg, max_dist)
        valid = h > -1e8
        d, h = d[valid], h[valid]
        h0 = h[0] + self.h_obs
        hz = self.horizon([x0], [y0], [az_deg], max_dist)[0, 0]
        if ax is None:
            _, ax = plt.subplots(figsize=(10, 4))
        ax.fill_between(d / 1e3, h, h.min() - 200, color="0.6", label="terrain")
        ax.plot(d / 1e3, h0 + d * np.tan(np.radians(target_el_deg)), "b-",
                label=f"line of sight to Earth (el = {target_el_deg:.2f}°)")
        ax.plot(d / 1e3, h0 + d * np.tan(np.radians(hz)), "r--",
                label=f"horizon (el = {hz:.2f}°)")
        ax.plot(0, h0, "k^", ms=10, label="site")
        ax.set_xlabel("distance [km]")
        ax.set_ylabel("height [m]")
        visible = target_el_deg > hz
        ax.set_title(f"{title} - {'VISIBLE' if visible else 'BLOCKED'}")
        ax.legend(loc="best")
        ax.grid(alpha=0.4)
        return ax


# ---------------------------------------------------------------- visibility
def interp_horizon(hz_table, az_table, az_query):
    """
    Interpolate the horizon at the requested azimuth, site by site.
    hz_table : (N,K)  az_table : (N,K) increasing along each row (or (K,))  az_query : (N,)
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
    For each site, an azimuth grid covering only the range swept by the Earth
    (from the ephemeris) plus a margin. Much faster than computing all 360 degrees.
    az_E_series : (T, N) Earth azimuth over time for each site [deg]
    returns (N, K)
    """
    a = np.radians(az_E_series)
    center = np.degrees(np.arctan2(np.sin(a).mean(0), np.cos(a).mean(0)))   # circular mean
    dev = (az_E_series - center[None, :] + 180.0) % 360.0 - 180.0
    half = np.abs(dev).max(0) + half_margin_deg
    K = int(np.ceil(2 * half.max() / step_deg)) + 1
    u = np.linspace(-1.0, 1.0, K)
    return (center[:, None] + u[None, :] * half[:, None]) % 360.0
