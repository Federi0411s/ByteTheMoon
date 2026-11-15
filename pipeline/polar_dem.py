"""
Polar-cap elevation sampling for the precomputed terrain products (sky_view.py, horizon_tiles.py,
slope_tiles.py), with the same rules as the browser (web/src/lib/dem.ts):

- The global elevation pyramid (dem_tiles.py, lon/lat gridded) is noisy near the poles, so inside each
  polar cap heights come from LOLA's polar stereographic DEM pyramids (polar_dem_tiles.py:
  web/public/data/dem_south, dem_north; levels k = 1..5 = 160 m .. 2.56 km).
- Cap: the disc of stereographic radius halfExtent - 4 * basePixel * 2^kmax (293.76 km, |lat| > 80.33 deg),
  a disc inside the square grid with a margin for the bilinear neighbours.
- Level: for a request at global level z, the coarsest polar level whose pixel is no larger than
  z's pixel (dem.ts polarLevel()); bilinear in stereographic x / y; any no-data neighbour -> NaN, and
  the caller falls back to the global mosaic (as dem.ts sample() does).
- Projection (PROJ / PDS, R = 1737.4 km): rho = 2 R tan((90 - |lat|) / 2), x = rho sin(lon),
  y = rho cos(lon) south, y = -rho cos(lon) north.

The tiles are unpacked once into uint16 memory-mapped mosaics (DN, 0 = no data) under MOON_DATA/cache
(polar_{pole}_k{k}.u16, ~29 MB at k = 1) that all worker processes share; they are rebuilt when the
pole's index.json changes.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

from config import DATA, MOON_R, WEB_DATA

TILE = 256
CACHE = DATA / "cache"
POLES = ("south", "north")


def dem_pixel_m(z: int) -> float:
    return math.pi * MOON_R / (TILE * 2**z)


class PolarDEM:
    def __init__(self, pole: str, root: Path | None = None):
        self.pole = pole
        self.root = root or WEB_DATA / f"dem_{pole}"
        idx = (self.root / "index.json").read_bytes()
        self.meta = m = json.loads(idx)
        assert m["projection"] == f"polar-stereographic-{pole}", m["projection"]
        self.sign = -1.0 if pole == "south" else 1.0  # sign of the latitudes of this cap
        self.half = float(m["halfExtentM"])
        self.base = float(m["basePixelM"])
        self.scale, self.offset = float(m["scale"]), float(m["offset"])
        self.R = float(m.get("radiusM", MOON_R))
        self.ks = sorted(int(k) for k in m["levels"])
        self.rho_cap = self.half - 4 * self.base * 2 ** self.ks[-1]
        self.cap_lat = math.pi / 2 - 2 * math.atan(self.rho_cap / (2 * self.R))  # |lat| (rad) beyond which it is used
        self.cap_lat_deg = math.degrees(self.cap_lat)
        # rebuilt whenever polar_dem_tiles.py rewrites the pyramid (it writes index.json last)
        self.tag = hashlib.sha1(idx).hexdigest()[:16] + f"-{(self.root / 'index.json').stat().st_mtime_ns}"
        self._m: dict[int, np.ndarray] = {}
        self._flat: dict[int, np.ndarray] = {}

    @staticmethod
    def available(pole: str) -> bool:
        return (WEB_DATA / f"dem_{pole}" / "index.json").exists()

    # ---- mosaics ----
    def _path(self, k: int) -> Path:
        return CACHE / f"polar_{self.pole}_k{k}.u16"

    def _shape(self, k: int) -> tuple[int, int]:
        L = self.meta["levels"][str(k)]
        return TILE * L["tilesY"], TILE * L["tilesX"]

    def build(self):
        """Unpack the tiles of every level into the cache (once per index.json version)."""
        CACHE.mkdir(parents=True, exist_ok=True)
        for k in self.ks:
            done = self._path(k).with_suffix(".done")
            if done.exists() and done.read_text().strip() == self.tag:
                continue
            h, w = self._shape(k)
            a = np.zeros((h, w), np.uint16)
            L = self.meta["levels"][str(k)]
            for ty in range(L["tilesY"]):
                for tx in range(L["tilesX"]):
                    f = self.root / str(k) / str(tx) / f"{ty}.webp"
                    if not f.exists():
                        continue
                    t = np.asarray(Image.open(f).convert("RGB"))
                    dn = t[..., 0].astype(np.uint16) * 256 + t[..., 1]
                    a[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE] = np.where(t[..., 2] > 0, dn, 0)
            a.tofile(self._path(k))
            done.write_text(self.tag)
            print(f"polar mosaic {self.pole} k{k} ({w}x{h})", flush=True)

    def open(self):
        self.build()
        for k in self.ks:
            self._m[k] = np.memmap(self._path(k), np.uint16, "r", shape=self._shape(k))
        return self

    # ---- geometry ----
    def inside(self, lat: float) -> bool:
        """lat (rad) inside this cap."""
        return lat * self.sign > self.cap_lat

    def level_for(self, z: int) -> int:
        """dem.ts polarLevel(): the coarsest polar level whose pixel is no larger than global level z's pixel."""
        want = math.floor(math.log2(dem_pixel_m(z) / self.base))
        k = self.ks[0]
        for v in self.ks:
            if v <= want:
                k = v
        return k

    def rho(self, lat):
        return 2 * self.R * np.tan((np.pi / 2 - self.sign * np.asarray(lat, np.float64)) / 2)

    def xy(self, lon, lat):
        r = self.rho(lat)
        return r * np.sin(lon), -self.sign * r * np.cos(lon)

    # ---- sampling ----
    def sample_xy(self, k: int, x, y) -> np.ndarray:
        """Bilinear height (m, float32) from level k at stereographic x / y (m); NaN if any neighbour has no data."""
        m = self._m[k]
        flat = self._flat.get(k)
        if flat is None:
            flat = self._flat[k] = m.reshape(-1)
        px = self.base * 2**k
        c = (np.asarray(x, np.float32) + np.float32(self.half)) * np.float32(1 / px) - np.float32(0.5)  # float32: < 1e-3 px
        r = (np.float32(self.half) - np.asarray(y, np.float32)) * np.float32(1 / px) - np.float32(0.5)
        c0 = np.floor(c)
        r0 = np.floor(r)
        fx = c - c0
        fy = r - r0
        h, w = m.shape
        i0 = r0.astype(np.int64) * w + c0.astype(np.int64)
        out = None
        if c0.size and (c0.min() < 0 or r0.min() < 0 or c0.max() >= w - 1 or r0.max() >= h - 1):
            out = (c0 < 0) | (r0 < 0) | (c0 >= w - 1) | (r0 >= h - 1)
            i0[out] = 0
        a, b = flat[i0], flat[i0 + 1]
        cc, d = flat[i0 + w], flat[i0 + w + 1]
        bad = np.minimum(np.minimum(a, b), np.minimum(cc, d)) == 0
        if out is not None:
            bad |= out
        # bilinear in DN, then to metres (same values as per-corner conversion, up to float rounding)
        a, b, cc, d = (v.astype(np.float32) for v in (a, b, cc, d))
        top = a + (b - a) * fx
        v = top + ((cc + (d - cc) * fx) - top) * fy
        v *= np.float32(self.scale)
        v += np.float32(self.offset)
        v[bad] = np.nan
        return v

    def sample(self, k: int, lon, lat) -> np.ndarray:
        x, y = self.xy(lon, lat)
        return self.sample_xy(k, x, y)


def load_poles(enabled: bool = True) -> list[PolarDEM]:
    """The polar DEMs that exist (opened, mosaics built), or [] when disabled."""
    if not enabled:
        return []
    return [PolarDEM(p).open() for p in POLES if PolarDEM.available(p)]


def polar_rows(level: int, poles: list[PolarDEM], reach_m: float) -> list[int]:
    """Tile rows of geographic `level` with a point whose terrain within `reach_m` can lie in a cap:
    |lat| > cap_lat - reach. (The point height itself is read inside the cap for |lat| > cap_lat.)"""
    n = 2**level
    step = 180.0 / n
    rows = set()
    for p in poles:
        lim = p.cap_lat_deg - math.degrees(reach_m / MOON_R)
        for ty in range(n):
            north, south = 90 - ty * step, 90 - (ty + 1) * step
            far = north if p.sign > 0 else -south  # the tile row's edge nearest to the pole
            if far > lim:
                rows.add(ty)
    return sorted(rows)


def parse_rows(spec: str, n: int) -> list[int]:
    """'0-11,116-127' -> [0..11, 116..127]."""
    rows = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            rows.update(range(int(a), int(b) + 1))
        else:
            rows.add(int(part))
    bad = [r for r in rows if not 0 <= r < n]
    if bad:
        raise SystemExit(f"rows out of range 0..{n - 1}: {bad}")
    return sorted(rows)


def blocks(rows: list[int]) -> list[tuple[int, int]]:
    """Sorted rows -> contiguous [start, end) blocks."""
    out: list[tuple[int, int]] = []
    for r in rows:
        if out and out[-1][1] == r:
            out[-1] = (out[-1][0], r + 1)
        else:
            out.append((r, r + 1))
    return out
