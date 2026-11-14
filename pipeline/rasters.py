"""Small helpers to read PDS/GeoTIFF rasters by lon/lat (used by overlays.py and build_sites.py)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.windows import Window

from config import MOON_GEOG, MOON_R


def physical(src: rasterio.DatasetReader, dn: np.ndarray) -> np.ndarray:
    """DN -> physical value using the label's scale/offset. NaN for nodata.

    LOLA DEM labels use OFFSET = 1737400 (radius); we always return heights relative to that sphere.
    """
    scale = src.scales[0] or 1.0
    offset = src.offsets[0] or 0.0
    out = dn.astype(np.float64) * scale + offset
    if offset > 1e6:  # radius-based product -> height above the reference sphere
        out -= MOON_R
    nd = src.nodata
    if nd is not None:
        out[dn == nd] = np.nan
    return out


class LonLatSampler:
    """Reads a window of a raster around a point once, then samples it bilinearly at lon/lat."""

    def __init__(self, path: Path, lat: float, lon: float, radius_m: float):
        self.path = path
        with rasterio.open(path) as src:
            self.crs = src.crs
            self.to_xy = Transformer.from_crs(MOON_GEOG, src.crs, always_xy=True)
            x, y = self.to_xy.transform(lon, lat)
            inv = ~src.transform
            col, row = inv * (x, y)
            px = abs(src.transform.a)
            # metres per pixel: geographic rasters store degrees
            mpp = px if src.crs.is_projected else np.deg2rad(px) * MOON_R
            half = int(radius_m / mpp) + 2
            c0, r0 = max(int(col) - half, 0), max(int(row) - half, 0)
            c1, r1 = min(int(col) + half, src.width), min(int(row) + half, src.height)
            self.window = Window(c0, r0, c1 - c0, r1 - r0)
            self.data = physical(src, src.read(1, window=self.window))
            self.inv = ~src.window_transform(self.window)
            self.resolution_m = mpp

    def sample(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        x, y = self.to_xy.transform(lon, lat)
        col, row = self.inv * (np.asarray(x), np.asarray(y))
        col = np.asarray(col) - 0.5
        row = np.asarray(row) - 0.5
        h, w = self.data.shape
        ok = (col >= 0) & (row >= 0) & (col < w - 1) & (row < h - 1)
        c0 = np.clip(col.astype(int), 0, w - 2)
        r0 = np.clip(row.astype(int), 0, h - 2)
        fc, fr = col - c0, row - r0
        d = self.data
        v = (d[r0, c0] * (1 - fc) + d[r0, c0 + 1] * fc) * (1 - fr) + (d[r0 + 1, c0] * (1 - fc) + d[r0 + 1, c0 + 1] * fc) * fr
        return np.where(ok, v, np.nan)
