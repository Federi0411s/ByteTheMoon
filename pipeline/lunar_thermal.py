"""
lunar_thermal.py
1D thermal model of lunar regolith (one vertical profile per map point).

Physics (parameters from Hayne et al. 2017, JGR Planets, "Global regolith thermophysical
properties of the Moon from the Diviner Lunar Radiometer Experiment" - verify against the paper):
  - surface balance: (1-A(i)) S cos(i) + Q_extra = eps*sigma*T0^4 - K dT/dz
  - subsurface conduction: rho c dT/dt = d/dz (K dT/dz)
  - density and conductivity increase with depth (scale H)
  - conductivity includes the radiative term K = Kc (1 + chi (T/350)^3)
  - specific heat depends on T
  - geothermal flux at the base

Usage:
    from lunar_thermal import RegolithThermal, absorbed_flux
    model = RegolithThermal(n_points, T_init=150.0)
    for each epoch (time step dt in seconds):
        Q = absorbed_flux(inc_deg, lit, r_sun_AU)          # W/m2 per punto
        T_surf = model.step(Q, dt)                          # K per punto
"""

import numpy as np

SIGMA = 5.670374419e-8      # Stefan-Boltzmann [W m-2 K-4]
S0 = 1361.0                 # costante solare a 1 AU [W m-2]

# --- Hayne et al. 2017 parameters ---
EMISSIVITY = 0.95
A0, A_a, A_b = 0.12, 0.06, 0.25          # incidence-dependent albedo
RHO_S, RHO_D = 1100.0, 1800.0            # surface/deep density [kg m-3]
K_S, K_D = 7.4e-4, 3.4e-3                # surface/deep contact conductivity [W m-1 K-1]
H_PARAM = 0.06                           # depth scale [m]
CHI = 2.7                                # radiative conductivity parameter
Q_GEO = 0.018                            # geothermal flux [W m-2]
CP_COEF = (-3.6125, 2.7431, 2.3616e-3, -1.2340e-5, 8.9093e-9)   # c(T) [J kg-1 K-1]


def albedo(inc_deg):
    """Incidence-dependent albedo (Keihm 1984 / Hayne 2017)."""
    x = np.asarray(inc_deg, float)
    return A0 + A_a * (x / 45.0) ** 3 + A_b * (x / 90.0) ** 8


def absorbed_flux(inc_deg, lit, r_sun_AU=1.0, q_extra=0.0):
    """
    Flusso solare assorbito [W m-2].
    inc_deg  : solar incidence angle at the surface (from the normal) [deg]
    lit      : bool, point illuminated (above the topographic horizon and inc < 90)
    r_sun_AU : Moon-Sun distance [AU] (from ephemerides; ~1)
    q_extra  : additional flux (e.g. scattering / IR from crater walls) [W m-2]
    """
    inc = np.asarray(inc_deg, float)
    lit = np.asarray(lit, bool)
    cos_i = np.where(lit, np.cos(np.radians(np.clip(inc, 0, 90))), 0.0)
    S = S0 / r_sun_AU**2
    return (1.0 - albedo(inc)) * S * cos_i + q_extra


def equilibrium_temperature(Q_abs, T_floor=40.0):
    """
    Stima rapida senza inerzia termica: T = (Q / eps sigma)^(1/4).
    Buona per i punti illuminati a Sole quasi costante (poli), sovrastima i picchi
    e non dice nulla sulle zone in ombra (T_floor = valore assegnato al buio).
    """
    Q = np.asarray(Q_abs, float)
    T = (np.maximum(Q, 0.0) / (EMISSIVITY * SIGMA)) ** 0.25
    return np.maximum(T, T_floor)


def heat_capacity(T):
    c0, c1, c2, c3, c4 = CP_COEF
    return c0 + c1 * T + c2 * T**2 + c3 * T**3 + c4 * T**4


class RegolithThermal:
    """
    Profilo termico vettorizzato su n_points punti.
    Vertical grid with increasing spacing up to z_max (default 1.5 m; 3 m is better
    than the annual-wave penetration depth at the poles).
    """

    def __init__(self, n_points, T_init=150.0, z_max=1.5, dz0=0.002, growth=1.12):
        z = [0.0]
        dz = dz0
        while z[-1] < z_max:
            z.append(z[-1] + dz)
            dz *= growth
        self.z = np.array(z)                        # (nz,)
        self.nz = len(self.z)
        self.dz = np.diff(self.z)                   # (nz-1,)

        self.rho = RHO_D - (RHO_D - RHO_S) * np.exp(-self.z / H_PARAM)
        self.Kc = K_D - (K_D - K_S) * (RHO_D - self.rho) / (RHO_D - RHO_S)

        self.T = np.full((self.nz, n_points), float(T_init))

    def conductivity(self, T):
        return self.Kc[:, None] * (1.0 + CHI * (T / 350.0) ** 3)

    def max_stable_dt(self):
        """Maximum stable time step for the explicit scheme (with margin)."""
        K = self.conductivity(self.T)
        c = heat_capacity(self.T)
        dzc = np.minimum(np.r_[self.dz, self.dz[-1]], np.r_[self.dz[0], self.dz])
        return 0.4 * np.min(self.rho[:, None] * c * dzc[:, None] ** 2 / K)

    def step(self, Q_abs, dt):
        """
        Advance by dt seconds with absorbed flux Q_abs (n_points,).
        Substeps automatically if dt exceeds the stability limit.
        Returns the surface temperature (n_points,).
        """
        Q_abs = np.asarray(Q_abs, float)
        n_sub = max(1, int(np.ceil(dt / self.max_stable_dt())))
        h = dt / n_sub
        for _ in range(n_sub):
            self._substep(Q_abs, h)
        return self.T[0].copy()

    def _substep(self, Q, h):
        T = self.T
        K = self.conductivity(T)
        c = heat_capacity(T)
        rho = self.rho[:, None]
        dz = self.dz[:, None]

        # flussi all'interfaccia tra nodi (K medio)
        K_half = 0.5 * (K[1:] + K[:-1])
        F = -K_half * (T[1:] - T[:-1]) / dz          # downward flux [W m-2]

        Tn = T.copy()
        # Interior nodes
        vol = 0.5 * (dz[1:] + dz[:-1])
        Tn[1:-1] = T[1:-1] + h * (F[:-1] - F[1:]) / (rho[1:-1] * c[1:-1] * vol)
        # Bottom node: geothermal flux entering from below
        Tn[-1] = T[-1] + h * (F[-1] + Q_GEO) / (rho[-1] * c[-1] * 0.5 * dz[-1])

        # Surface: instantaneous balance solved with Newton's method
        # Q - eps sigma T0^4 + K0 (T1 - T0)/dz0 = 0
        T0 = T[0].copy()
        k0 = K_half[0]
        T1 = Tn[1]
        d0 = self.dz[0]
        for _ in range(20):
            f = Q - EMISSIVITY * SIGMA * T0**4 + k0 * (T1 - T0) / d0
            df = -4 * EMISSIVITY * SIGMA * T0**3 - k0 / d0
            dT = -f / df
            T0 = np.maximum(T0 + dT, 2.0)
            if np.max(np.abs(dT)) < 1e-4:
                break
        Tn[0] = T0
        self.T = Tn


class ThermalStats:
    """Time-series statistics of surface temperature for each point."""

    def __init__(self, n_points):
        self.n = 0
        self._sum = np.zeros(n_points)
        self.min = np.full(n_points, np.inf)
        self.max = np.full(n_points, -np.inf)

    def add(self, T):
        self.n += 1
        self._sum += T
        self.min = np.minimum(self.min, T)
        self.max = np.maximum(self.max, T)

    @property
    def mean(self):
        return self._sum / self.n
