"""Lunar surface charging model driven by EQUIPOT data.

This module implements the charging model described by the uploaded
`equipot_results.csv` dataset and provides a simple interface for time-dependent
simulations driven by lunar ephemerides.

Typical usage:

    from lunar_charging import ChargingModel, ChargingStats

    model = ChargingModel("equipot_results.csv")
    stats = ChargingStats(n_points=len(normals), threshold_V=-100)

    for k in range(n_epochs):
        sun_hat = ...
        earth_hat = ...
        V = model.potential_from_geometry(
            normals,
            up,
            sun_hat,
            earth_hat,
            horizon_deg=None,
        )
        stats.add(V)

    color = stats.mean
    # or stats.min, stats.frac_below
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

SUN_RADIUS_DEG = 0.27


class ChargingModel:
    def __init__(self, csv_path: str | Path = "equipot_results.csv", tail_half_angle_deg: float = 23.0):
        tab = pd.read_csv(Path(csv_path), comment="#")
        self.table = tab
        self.tail_half_angle_deg = tail_half_angle_deg

        self.ang_SW, self.V_SW, self.V_SW_ecl = self._curve(tab, "SW")
        self.ang_PS, self.V_PS, self.V_PS_ecl = self._curve(tab, "PS")
        self.V_WAKE = self._ecl(tab, "WAKE")
        self.V_WC = self._ecl(tab, "WC") if (tab.env == "WC").any() else np.nan

    @staticmethod
    def _ecl(tab: pd.DataFrame, env: str) -> float:
        rows = tab[(tab.env == env) & (tab.condition == "eclipse")]
        if rows.empty:
            raise ValueError(f"Missing eclipse data for environment '{env}'")
        return float(rows.V.iloc[0])

    @classmethod
    def _curve(cls, tab: pd.DataFrame, env: str):
        sun = tab[(tab.env == env) & (tab.condition == "sun")].sort_values("angle_deg")
        V_ecl = cls._ecl(tab, env)
        ang = np.append(sun.angle_deg.to_numpy(float), 90.0)
        V = np.append(sun.V.to_numpy(float), V_ecl)
        return ang, V, V_ecl

    def in_magnetotail(self, sun_hat: np.ndarray, earth_hat: np.ndarray) -> bool:
        """Return True if the Moon is in the magnetotail."""
        c = np.clip(np.dot(sun_hat, earth_hat), -1.0, 1.0)
        return np.degrees(np.arccos(c)) < self.tail_half_angle_deg

    @staticmethod
    def incidence_deg(normals: np.ndarray, sun_hat: np.ndarray) -> np.ndarray:
        """Angle between surface normal and solar direction."""
        c = np.clip(normals @ sun_hat, -1.0, 1.0)
        return np.degrees(np.arccos(c))

    @staticmethod
    def elevation_deg(up: np.ndarray, sun_hat: np.ndarray) -> np.ndarray:
        """Solar elevation over a local flat horizon."""
        return np.degrees(np.arcsin(np.clip(up @ sun_hat, -1.0, 1.0)))

    def potential(
        self,
        inc_deg: np.ndarray,
        lit: np.ndarray,
        terrain_shadow: np.ndarray,
        in_tail: bool,
    ) -> np.ndarray:
        """Potential in volts for a set of surface points.

        Parameters
        ----------
        inc_deg : array-like
            Solar incidence angle in degrees.
        lit : array-like of bool
            True if the surface point is sunlit.
        terrain_shadow : array-like of bool
            True if the point is shadowed by local terrain.
        in_tail : bool
            True if the Moon is in the magnetotail.
        """
        inc_deg = np.asarray(inc_deg, float)
        lit = np.asarray(lit, bool)
        terrain_shadow = np.asarray(terrain_shadow, bool) & ~lit
        self_shadow = ~lit & ~terrain_shadow
        V = np.empty_like(inc_deg)

        if in_tail:
            inc = np.clip(inc_deg, self.ang_PS[0], 90.0)
            V[lit] = np.interp(inc[lit], self.ang_PS, self.V_PS)
            V[~lit] = self.V_PS_ecl
        else:
            inc = np.clip(inc_deg, self.ang_SW[0], 90.0)
            V[lit] = np.interp(inc[lit], self.ang_SW, self.V_SW)
            V[self_shadow] = self.V_SW_ecl
            V[terrain_shadow] = self.V_WAKE
        return V

    def potential_from_geometry(
        self,
        normals: np.ndarray,
        up: np.ndarray,
        sun_hat: np.ndarray,
        earth_hat: np.ndarray,
        horizon_deg: np.ndarray | float | None = None,
    ) -> np.ndarray:
        """Compute charging potential for a whole surface at one epoch.

        Parameters
        ----------
        normals : (N, 3) array
            Surface normals in the Moon-fixed frame.
        up : (N, 3) array
            Local zenith vectors.
        sun_hat : (3,) array
            Solar direction from the Moon.
        earth_hat : (3,) array
            Earth direction from the Moon.
        horizon_deg : (N,) array or scalar, optional
            Horizon elevation in degrees for the solar direction. If None, a flat
            horizon is assumed.
        """
        sun_hat = np.asarray(sun_hat, float)
        earth_hat = np.asarray(earth_hat, float)
        sun_hat = sun_hat / np.linalg.norm(sun_hat)
        earth_hat = earth_hat / np.linalg.norm(earth_hat)

        inc, lit, terrain_shadow = self.surface_conditions(normals, up, sun_hat, horizon_deg)
        return self.potential(inc, lit, terrain_shadow, self.in_magnetotail(sun_hat, earth_hat))

    def surface_conditions(
        self,
        normals: np.ndarray,
        up: np.ndarray,
        sun_hat: np.ndarray,
        horizon_deg: np.ndarray | float | None = None,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return incidence, illumination and terrain-shadow arrays for one epoch."""
        sun_hat = np.asarray(sun_hat, float)
        sun_hat = sun_hat / np.linalg.norm(sun_hat)
        inc = self.incidence_deg(normals, sun_hat)
        el = self.elevation_deg(up, sun_hat)
        hz = np.zeros_like(el) if horizon_deg is None else np.asarray(horizon_deg, float)

        above_horizon = el > hz - SUN_RADIUS_DEG
        lit = above_horizon & (inc < 90.0)
        terrain_shadow = ~above_horizon
        return inc, lit, terrain_shadow


class ChargingStats:
    """Accumulate temporal statistics for each surface sample."""

    def __init__(self, n_points: int, threshold_V: float = -100.0):
        self.n = 0
        self.threshold_V = threshold_V
        self._sum = np.zeros(n_points, float)
        self._min = np.full(n_points, np.inf, float)
        self._max = np.full(n_points, -np.inf, float)
        self._below = np.zeros(n_points, float)

    def add(self, V: np.ndarray) -> None:
        V = np.asarray(V, float)
        if V.shape != self._sum.shape:
            raise ValueError(f"Expected {self._sum.shape}, got {V.shape}")
        self.n += 1
        self._sum += V
        self._min = np.minimum(self._min, V)
        self._max = np.maximum(self._max, V)
        self._below += V < self.threshold_V

    @property
    def mean(self) -> np.ndarray:
        if self.n == 0:
            raise ValueError("No data has been added yet.")
        return self._sum / self.n

    @property
    def min(self) -> np.ndarray:
        if self.n == 0:
            raise ValueError("No data has been added yet.")
        return self._min

    @property
    def max(self) -> np.ndarray:
        if self.n == 0:
            raise ValueError("No data has been added yet.")
        return self._max

    @property
    def frac_below(self) -> np.ndarray:
        """Fraction of time spent below threshold_V."""
        if self.n == 0:
            raise ValueError("No data has been added yet.")
        return self._below / self.n


def normalize(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    if n == 0:
        raise ValueError("Zero-length vector cannot be normalized.")
    return v / n


def load_ephemeris(path: str | Path):
    """Read a lunar ephemeris JSON exported by pipeline/ephemeris.py."""
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        eph = json.load(f)

    sun = np.asarray(eph["sun"], dtype=float)
    earth = np.asarray(eph["earth"], dtype=float)
    if sun.size % 3 != 0 or earth.size % 3 != 0:
        raise ValueError(f"Ephemeris arrays in {p} are not length 3 * N: {sun.size}, {earth.size}")
    sun = sun.reshape(-1, 3)
    earth = earth.reshape(-1, 3)
    if len(sun) != len(earth):
        raise ValueError(f"Sun and Earth ephemerides have different lengths: {len(sun)} vs {len(earth)}")
    return {"sun": sun, "earth": earth, "stepSeconds": float(eph.get("stepSeconds", 7200.0)), "count": int(eph.get("count", len(sun)))}


def surface_charging_over_ephemeris(
    model: ChargingModel,
    normals: np.ndarray,
    up: np.ndarray,
    ephemeris: str | Path | dict,
    *,
    horizon_deg: np.ndarray | float | None = None,
    threshold_V: float = -100.0,
    start_index: int = 0,
    end_index: int | None = None,
    step: int = 1,
    on_epoch: Callable[[int, np.ndarray, np.ndarray, np.ndarray], None] | None = None,
):
    """Compute temporal statistics and optionally pass shared surface conditions per epoch.

    on_epoch receives (sample_index, incidence_deg, lit, sun_vector) after charging
    has been evaluated for that same ephemeris sample.
    """
    normals = np.asarray(normals, dtype=float)
    up = np.asarray(up, dtype=float)
    if normals.shape != up.shape:
        raise ValueError(f"normals and up shapes differ: {normals.shape} vs {up.shape}")
    if normals.ndim != 2 or normals.shape[1] != 3:
        raise ValueError(f"normals and up must have shape (N, 3), got {normals.shape}")

    if isinstance(ephemeris, dict):
        eph = ephemeris
        sun = np.asarray(eph["sun"], dtype=float).reshape(-1, 3)
        earth = np.asarray(eph["earth"], dtype=float).reshape(-1, 3)
    else:
        eph = load_ephemeris(ephemeris)
        sun = eph["sun"]
        earth = eph["earth"]

    if end_index is None:
        end_index = len(sun)
    start_index = max(0, start_index)
    end_index = min(len(sun), end_index)

    stats = ChargingStats(n_points=normals.shape[0], threshold_V=threshold_V)
    for sample_index, k in enumerate(range(start_index, end_index, step)):
        sun_hat = normalize(sun[k])
        earth_hat = normalize(earth[k])
        inc, lit, terrain_shadow = model.surface_conditions(normals, up, sun_hat, horizon_deg)
        V = model.potential(inc, lit, terrain_shadow, model.in_magnetotail(sun_hat, earth_hat))
        stats.add(V)
        if on_epoch is not None:
            on_epoch(sample_index, inc, lit, sun[k])
    return stats


def _demo(csv_path: str | Path | None = None) -> None:
    """Demonstrate charging over a short synthetic ephemeris sequence."""
    csv_path = Path(csv_path) if csv_path is not None else Path(__file__).resolve().with_name("equipot_results.csv")
    if not csv_path.exists():
        raise FileNotFoundError(
            f"CSV file not found: '{csv_path}'. Pass --csv /path/to/equipot_results.csv or place the file next to lunar_charging.py."
        )

    n = 128
    normals = np.tile(np.array([0.0, 0.0, 1.0], float), (n, 1))
    up = np.tile(np.array([0.0, 0.0, 1.0], float), (n, 1))
    sun = np.stack([
        np.array([0.0, 0.0, 1.0], float),
        np.array([0.0, 0.0, 1.0], float),
        np.array([0.0, 0.0, 1.0], float),
        np.array([0.0, 0.0, 1.0], float),
        np.array([0.0, 0.0, 1.0], float),
    ])
    earth = np.stack([
        np.array([1.0, 0.0, 0.0], float),
        np.array([1.0, 0.0, 0.0], float),
        np.array([1.0, 0.0, 0.0], float),
        np.array([1.0, 0.0, 0.0], float),
        np.array([1.0, 0.0, 0.0], float),
    ])
    eph = {"sun": sun, "earth": earth, "stepSeconds": 7200.0, "count": 5}

    model = ChargingModel(csv_path)
    stats = surface_charging_over_ephemeris(model, normals, up, eph, threshold_V=-100.0)

    print(f"mean = {stats.mean[:4]}")
    print(f"min = {stats.min[:4]}")
    print(f"frac_below = {stats.frac_below[:4]}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Lunar surface charging model from EQUIPOT tables and lunar ephemerides")
    ap.add_argument("--csv", type=str, default=str(Path(__file__).resolve().with_name("equipot_results.csv")), help="Path to the EQUIPOT CSV file")
    ap.add_argument("--ephemeris", type=str, default=None, help="Optional JSON ephemeris produced by pipeline/ephemeris.py")
    ap.add_argument("--demo", action="store_true", help="Run a small ephemeris-based sanity-check demo")
    args = ap.parse_args()

    if args.demo:
        _demo(args.csv)
        return

    model = ChargingModel(args.csv)
    print(f"Loaded charging model from {args.csv}")
    print(f"SW data points: {len(model.ang_SW)}")
    print(f"PS data points: {len(model.ang_PS)}")
    print(f"SW eclipse: {model.V_SW_ecl} V")
    print(f"PS eclipse: {model.V_PS_ecl} V")

    if args.ephemeris:
        p = Path(args.ephemeris)
        if not p.exists():
            raise FileNotFoundError(f"Ephemeris JSON not found: {p}")
        eph = load_ephemeris(p)
        print(f"Loaded ephemeris: {eph['count']} samples")


if __name__ == "__main__":
    main()
