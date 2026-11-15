"""
Global slope tile pyramid (precomputed: slope does not depend on time).

Source: LOLA global LDEM 118 m (same file as dem_tiles.py). Slope is computed at the native 118 m
from central differences on the sphere (east-west spacing R cos(lat) dlon, widened near the poles so
it never gets shorter than the north-south spacing), then area-averaged into Cesium geographic tiles,
same layout as the elevation pyramid (level z: 2^(z+1) x 2^z tiles of 256 px, 167 m/px at z = 7).
A coarse pixel therefore holds the MEAN of the 118 m slopes inside it (how rough the ground is
there), not the slope of the smoothed surface, which would flatten out at coarse levels.

Two values per pixel: R = MEAN slope (display), G = MAX slope (the steepest 118 m spot inside the
pixel, so a coarse pixel can safely rule out everything below it, e.g. for the landing score).
Encoding: lossless WebP RGB, slope = (DN - 1) * 0.25 deg (0 .. 63.25 deg), B = 255 valid / 0 no data.
  - levels 0..PUBLIC_MAX (default 4, ~60 MB) -> web/public/data/slope/{z}/{x}/{y}.webp  (shipped;
    level 5 alone would add ~150 MB)
  - finer levels                      -> MOON_DATA/slope_fine/{z}/{x}/{y}.webp (bucket, like dem_fine)

    python pipeline/slope_tiles.py            # full pyramid (~20-40 min)
    python pipeline/slope_tiles.py --test     # sizes of a few tiles, writes nothing
"""
from __future__ import annotations

import argparse
import io
import json
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window

from config import DATA, GLOBAL_LDEM, MOON_R, WEB_DATA, find_local

TILE = 256
STEP_DEG = 0.25
PUBLIC_OUT = WEB_DATA / "slope"
FINE_OUT = DATA / "slope_fine"


def to_dn(v: np.ndarray, offset: float, step: float) -> np.ndarray:
    """DN = 1 + round((v - offset) / step) in 1..255, 0 = nodata (NaN)."""
    ok = np.isfinite(v)
    return np.where(ok, np.clip(np.round((np.where(ok, v, offset) - offset) / step), 0, 254) + 1, 0).astype(np.uint8)


def encode_u8(v: np.ndarray, offset: float, step: float) -> bytes:
    """One value per pixel -> lossless 8-bit grey WebP."""
    buf = io.BytesIO()
    Image.fromarray(to_dn(v, offset, step), "L").save(buf, "WEBP", lossless=True, quality=100, method=2)  # method 4 is ~20x slower for ~the same size
    return buf.getvalue()


def encode_mean_max(t: np.ndarray) -> bytes:
    """(256, 256, 2) [mean, max] slope -> RGB WebP: R mean, G max, B valid."""
    rgb = np.empty(t.shape[:2] + (3,), np.uint8)
    rgb[..., 0] = to_dn(t[..., 0], 0.0, STEP_DEG)
    rgb[..., 1] = to_dn(t[..., 1], 0.0, STEP_DEG)
    rgb[..., 2] = np.where(rgb[..., 0] > 0, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True, quality=100, method=2)  # method 4 is ~20x slower for ~the same size
    return buf.getvalue()


def down2(a: np.ndarray) -> np.ndarray:
    """2x2 reduction ignoring NaN: mean for 2-D arrays; for (h, w, 2) [mean, max] mean of channel 0, max of 1."""
    h, w = a.shape[:2]
    b = a.reshape(h // 2, 2, w // 2, 2, *a.shape[2:])
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN blocks
        if a.ndim == 2:
            return np.nanmean(b, axis=(1, 3)).astype(np.float32)
        return np.stack([np.nanmean(b[..., 0], axis=(1, 3)), np.nanmax(b[..., 1], axis=(1, 3))], -1).astype(np.float32)


class Writer:
    """Writes tile rows of a pyramid on a thread pool; levels <= public_max go to public_out."""

    def __init__(self, public_out: Path, fine_out: Path, public_max: int, encode, workers: int = 12):
        self.public_out, self.fine_out, self.public_max, self.encode = public_out, fine_out, public_max, encode
        self.pool = ThreadPoolExecutor(workers)
        self.futures = []
        self.bytes: dict[int, int] = {}
        self.count: dict[int, int] = {}

    def row(self, z: int, ty: int, band: np.ndarray):
        root = self.public_out if z <= self.public_max else self.fine_out
        for tx in range(band.shape[1] // TILE):
            tile = band[:, tx * TILE:(tx + 1) * TILE].copy()
            self.futures.append(self.pool.submit(self._write, root / str(z) / str(tx) / f"{ty}.webp", tile, z))
        if len(self.futures) > 256:  # each queued tile holds its pixels: keep memory bounded
            self.flush()

    def _write(self, path: Path, tile: np.ndarray, z: int):
        data = self.encode(tile)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return z, len(data)

    def flush(self):
        for f in self.futures:
            z, n = f.result()
            self.bytes[z] = self.bytes.get(z, 0) + n
            self.count[z] = self.count.get(z, 0) + 1
        self.futures = []


class Cascade:
    """Feeds finest-level tile rows and emits every coarser level by 2x2 means."""

    def __init__(self, writer: Writer, top: int):
        self.w, self.top = writer, top
        self.pending: dict[int, list[np.ndarray]] = {z: [] for z in range(top)}

    def push(self, ty: int, band: np.ndarray):
        self.w.row(self.top, ty, band)
        z, b, y = self.top, band, ty
        while z > 0:
            self.pending[z - 1].append(b)
            if len(self.pending[z - 1]) < 2:
                break
            b = down2(np.vstack(self.pending[z - 1]))
            self.pending[z - 1] = []
            z, y = z - 1, y // 2
            self.w.row(z, y, b)


def slope_band(src, z: int, ty: int) -> np.ndarray:
    """Tile row ty of level z: mean native-resolution slope (deg) per output pixel."""
    W, H = src.width, src.height
    out_w = TILE * 2 ** (z + 1)
    rows_per = H / 2**z / TILE * TILE  # source rows per tile row
    r0, r1 = int(round(ty * rows_per)), int(round((ty + 1) * rows_per))
    a0, a1 = max(0, r0 - 1), min(H, r1 + 1)
    dn = src.read(1, window=Window(0, a0, W, a1 - a0), masked=True)
    h = dn.astype(np.float32).filled(np.nan) * float(src.scales[0] or 1) + float(src.offsets[0] or 0)
    dphi = np.pi / H
    dy = MOON_R * dphi
    lat = np.pi / 2 - (np.arange(a0, a1) + 0.5) * dphi
    dx1 = MOON_R * np.cos(lat) * (2 * np.pi / W)
    slope = np.full((r1 - r0, W), np.nan, np.float32)
    for r in range(r0, r1):
        i = r - a0
        # east-west difference over +-k pixels with k*dx >= dy (near the poles neighbours are cm apart)
        k = int(min(W // 4, max(1, np.ceil(dy / max(dx1[i], 1e-9)))))
        gx = (np.roll(h[i], -k) - np.roll(h[i], k)) / (2 * k * dx1[i])
        up = h[i - 1] if i - 1 >= 0 else h[i]
        dn_ = h[i + 1] if i + 1 < h.shape[0] else h[i]
        span = (1 if i - 1 >= 0 else 0) + (1 if i + 1 < h.shape[0] else 0)
        gy = (up - dn_) / (span * dy)
        slope[r - r0] = np.degrees(np.arctan(np.hypot(gx, gy)))
    # mean: area average to the output grid (PIL's BOX filter on a float image)
    mean = np.asarray(Image.fromarray(slope, "F").resize((out_w, TILE), Image.BOX), np.float32)
    # max: the source pixels whose centres fall in each output pixel
    cs = np.floor(np.arange(out_w) * W / out_w).astype(np.int64)
    rs = np.floor(np.arange(TILE) * slope.shape[0] / TILE).astype(np.int64)
    mx = np.maximum.reduceat(np.maximum.reduceat(np.nan_to_num(slope, nan=-1.0), cs, axis=1), rs, axis=0)
    mx = np.where(mx < 0, np.nan, mx).astype(np.float32)
    return np.stack([mean, mx], -1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--public-max", type=int, default=4)  # level 5 is ~150 MB: bucket
    ap.add_argument("--fine-max", type=int, default=7)
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()
    path = find_local(GLOBAL_LDEM)
    if not path:
        raise SystemExit(f"{GLOBAL_LDEM} not found")
    top = a.fine_max
    enc = encode_mean_max

    with rasterio.open(path) as src:
        if a.test:
            band = slope_band(src, top, 2**top // 2 - 1)
            sizes = [len(enc(band[:, i * TILE:(i + 1) * TILE])) for i in range(0, band.shape[1] // TILE, 32)]
            print(f"z{top}: mean slope {np.nanmean(band[..., 0]):.1f} deg, max {np.nanmax(band[..., 1]):.1f}, tile ~{np.mean(sizes) / 1024:.0f} KB")
            b5 = band
            for _ in range(top - 5):
                b5 = down2(np.vstack([b5, b5]))  # just for a size estimate of a level-5-like tile
            s5 = [len(enc(b5[:, i * TILE:(i + 1) * TILE])) for i in range(0, b5.shape[1] // TILE, 4)]
            print(f"level-5-like tile ~{np.mean(s5) / 1024:.0f} KB -> level 5 ~{np.mean(s5) * 2048 / 2**20:.0f} MB")
            return
        w = Writer(PUBLIC_OUT, FINE_OUT, a.public_max, enc)
        c = Cascade(w, top)
        t0 = time.time()
        rows = 2**top
        for ty in range(rows):
            c.push(ty, slope_band(src, top, ty))
            if ty % 8 == 7:
                el = time.time() - t0
                print(f"row {ty + 1}/{rows}  {el / 60:.1f} min, ~{el / (ty + 1) * (rows - ty - 1) / 60:.1f} min left", flush=True)
        w.flush()

    meta = {
        "tiling": "geographic", "tileSize": TILE, "format": "webp", "encoding": "u8x2", "channels": ["mean", "max"],
        "scale": STEP_DEG, "offset": -STEP_DEG,  # value = offset + scale * DN (R = mean, G = max), B = 255 valid
        "units": "deg", "publicMaxLevel": a.public_max, "fineMaxLevel": a.fine_max,
        "source": "Slope from LOLA LDEM 118 m global, mean of native-resolution slope per pixel",
        "levels": {str(z): {"tiles": w.count.get(z, 0), "MB": round(w.bytes.get(z, 0) / 2**20, 1)} for z in range(top + 1)},
    }
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    (PUBLIC_OUT / "index.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta["levels"], indent=1))


if __name__ == "__main__":
    main()
