"""
Global slope tile pyramid (precomputed: slope does not depend on time).

Source: LOLA global LDEM 118 m (same file as dem_tiles.py). Slope is computed at the native 118 m
from central differences on the sphere (east-west spacing R cos(lat) dlon, widened near the poles so
it never gets shorter than the north-south spacing), then area-averaged into Cesium geographic tiles,
same layout as the elevation pyramid (level z: 2^(z+1) x 2^z tiles of 256 px, 167 m/px at z = 7).
A coarse pixel therefore holds the MEAN of the 118 m slopes inside it (how rough the ground is
there), not the slope of the smoothed surface, which would flatten out at coarse levels.

Polar caps (|lat| > ~80.3 deg, where lib/dem.ts reads the polar DEMs): the lon/lat-gridded global DEM
is noisy there, so the slopes come from LOLA's polar stereographic 80 m DEMs instead (LDEM_80S_80M /
LDEM_80N_80M in MOON_DATA/raw): native slope from central differences on the 80 m grid (corrected for
the stereographic scale factor), then per output pixel the mean / max of the 80 m slopes whose centres
fall inside it; pixels too narrow to contain one (close to the pole) take the nearest 80 m slope.

Two values per pixel: R = MEAN slope (display), G = MAX slope (the steepest 118 m spot inside the
pixel, so a coarse pixel can safely rule out everything below it, e.g. for the landing score).
Encoding: lossless WebP RGB, slope = (DN - 1) * 0.25 deg (0 .. 63.25 deg), B = 255 valid / 0 no data.
  - levels 0..PUBLIC_MAX (default 4, ~60 MB) -> web/public/data/slope/{z}/{x}/{y}.webp  (shipped;
    level 5 alone would add ~150 MB)
  - finer levels                      -> MOON_DATA/slope_fine/{z}/{x}/{y}.webp (bucket, like dem_fine)

    python pipeline/slope_tiles.py            # full pyramid (~20-40 min)
    python pipeline/slope_tiles.py --test     # sizes of a few tiles, writes nothing
    python pipeline/slope_tiles.py --rows polar   # only the tile rows inside the polar caps, in place
"""
from __future__ import annotations

import argparse
import io
import json
import os
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window

from config import DATA, GLOBAL_LDEM, MOON_R, RAW, WEB_DATA, find_local

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


def splice_write(path: Path, tile: np.ndarray, r0: int, r1: int, encode, mode: str) -> int:
    """Replace pixel rows [r0, r1) of an existing tile with those of `tile` (float values, encoded with
    `encode`); the other rows keep their stored DNs exactly. mode 'L' (grey) or 'RGB'. Returns bytes."""
    new = np.asarray(Image.open(io.BytesIO(encode(tile))).convert(mode))
    if path.exists():
        out = np.asarray(Image.open(path).convert(mode)).copy()
    else:
        out = np.zeros_like(new)
    out[r0:r1] = new[r0:r1]
    buf = io.BytesIO()
    Image.fromarray(out, mode).save(buf, "WEBP", lossless=True, quality=100, method=2)
    data = buf.getvalue()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data)


class PartialCascade:
    """Cascade for a contiguous block of finest-level tile rows (recomputing part of a pyramid in place).

    Finest rows are pushed in order; each is written and 2x2-reduced into the next coarser level at once
    (a 256-row band reduces on its own: block edges are tile aligned, so no 2x2 block straddles new and
    old rows). Coarser tile rows that the block covers only partly are spliced into the existing tiles,
    keeping the pixels outside the block exactly as stored. Same values as a full run for the new rows."""

    def __init__(self, writer: Writer, top: int, mode: str):
        self.w, self.top, self.mode = writer, top, mode
        self.buf: dict[int, tuple[int, np.ndarray] | None] = {z: None for z in range(top + 1)}
        self.spliced: list[tuple[int, int]] = []  # (z, ty) tile rows written by splicing

    def push(self, ty: int, band: np.ndarray):
        self._add(self.top, ty * TILE, band)

    def _add(self, z: int, r0: int, arr: np.ndarray):
        b = self.buf[z]
        if b is None:
            start, data = r0, arr
        else:
            assert b[0] + b[1].shape[0] == r0, "rows must be pushed in order, without gaps"
            start, data = b[0], np.concatenate([b[1], arr])
        while True:
            off = start % TILE
            end = start - off + TILE  # next tile boundary
            if start + data.shape[0] < end:
                break
            n = end - start
            ty = start // TILE
            if off == 0:
                self.w.row(z, ty, data[:TILE])
            else:
                self._splice(z, ty, off, data[:n])
            start, data = end, data[n:]
        self.buf[z] = (start, data) if data.shape[0] else None
        if z > 0:
            self._add(z - 1, r0 // 2, down2(arr))

    def _splice(self, z: int, ty: int, off: int, rows: np.ndarray):
        """Rows [off, off + len) of tile row ty of level z are new."""
        full = np.full((TILE,) + rows.shape[1:], np.nan, np.float32)
        full[off:off + rows.shape[0]] = rows
        root = self.w.public_out if z <= self.w.public_max else self.w.fine_out
        for tx in range(rows.shape[1] // TILE):
            p = root / str(z) / str(tx) / f"{ty}.webp"
            n = splice_write(p, full[:, tx * TILE:(tx + 1) * TILE], off, off + rows.shape[0], self.w.encode, self.mode)
            self.w.bytes[z] = self.w.bytes.get(z, 0) + n
            self.w.count[z] = self.w.count.get(z, 0) + 1
        self.spliced.append((z, ty))

    def finish(self):
        """Splice the leftover rows (a block ending inside a coarse tile row)."""
        for z in range(self.top, -1, -1):
            b = self.buf[z]
            if b is not None:
                start, data = b
                self._splice(z, start // TILE, start % TILE, data)
                self.buf[z] = None
        self.w.flush()


def affected_rows(top: int, rows: list[int]) -> dict[int, list[int]]:
    """Tile rows of every level 0..top touched when rows of level top change."""
    return {z: sorted({r >> (top - z) for r in rows}) for z in range(top + 1)}


def level_stats(public_out: Path, fine_out: Path, public_max: int, top: int) -> dict:
    """{z: {"tiles", "MB"}} from the files on disk (for index.json after a partial run)."""
    out = {}
    for z in range(top + 1):
        d = (public_out if z <= public_max else fine_out) / str(z)
        n = size = 0
        if d.exists():
            for col in os.scandir(d):
                if col.is_dir():
                    for f in os.scandir(col.path):
                        if f.name.endswith(".webp"):
                            n += 1
                            size += f.stat().st_size
        out[str(z)] = {"tiles": n, "MB": round(size / 2**20, 1)}
    return out


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


class PolarSlope:
    """Slopes inside one polar cap from the LOLA polar 80 m DEM, binned into geographic output pixels."""

    LABELS = {"south": "ldem_80s_80m.lbl", "north": "ldem_80n_80m.lbl"}

    def __init__(self, dem, z: int):
        self.dem, self.z = dem, z  # polar_dem.PolarDEM (cap, projection), output level
        self.label = RAW / self.LABELS[dem.pole]
        self.H, self.W = TILE * 2**z, TILE * 2 ** (z + 1)
        cap = dem.cap_lat
        # output pixel rows whose centre lies inside the cap
        lat_c = np.pi / 2 - (np.arange(self.H) + 0.5) * np.pi / self.H
        rows = np.flatnonzero(lat_c * dem.sign > cap)
        self.r0, self.r1 = int(rows.min()), int(rows.max()) + 1
        self.ready = False

    def available(self) -> bool:
        return self.label.exists()

    def tile_rows(self) -> list[int]:
        return list(range(self.r0 // TILE, (self.r1 - 1) // TILE + 1))

    def prepare(self):
        """Native slope on the 80 m grid and the output pixel of every source pixel (~0.5 GB)."""
        if self.ready:
            return
        t0 = time.time()
        d = self.dem
        with rasterio.open(self.label) as src:
            px = float(src.transform.a)
            half = -float(src.transform.c)
            assert abs(half - d.half) < 1 and src.transform.e == -px
            dn = src.read(1)
            h = dn.astype(np.float32) * np.float32(src.scales[0]) + np.float32(float(src.offsets[0]) - d.R)
            h[dn == src.nodata] = np.nan
            del dn
        n = h.shape[0]
        slope = np.full(h.shape, np.nan, np.float32)
        rows_out, cols_out, vals = [], [], []
        xs = -half + (np.arange(n) + 0.5) * px
        CH = 400
        for i0 in range(0, n, CH):
            i1 = min(n, i0 + CH)
            gx = np.full((i1 - i0, n), np.nan, np.float32)  # central differences; grid edges (outside the cap) NaN
            gx[:, 1:-1] = (h[i0:i1, 2:] - h[i0:i1, :-2]) / (2 * px)
            gy = np.full((i1 - i0, n), np.nan, np.float32)
            lo, hi = max(i0, 1), min(i1, n - 1)
            gy[lo - i0:hi - i0] = (h[lo - 1:hi - 1] - h[lo + 1:hi + 1]) / (2 * px)
            ys = half - (np.arange(i0, i1) + 0.5) * px
            X, Y = np.meshgrid(xs, ys)
            rho = np.hypot(X, Y)
            colat = 2 * np.arctan(rho / (2 * d.R))
            k = (2 / (1 + np.cos(colat))).astype(np.float32)  # stereographic scale factor (ground = map / k)
            sl = np.degrees(np.arctan(k * np.hypot(gx, gy))).astype(np.float32)
            slope[i0:i1] = sl
            lat = d.sign * (np.pi / 2 - colat)
            lon = np.arctan2(X, -d.sign * Y)
            r = np.floor((np.pi / 2 - lat) / np.pi * self.H).astype(np.int64)
            c = np.floor((lon + np.pi) / (2 * np.pi) * self.W).astype(np.int64) % self.W
            ok = np.isfinite(sl) & (r >= self.r0) & (r < self.r1)
            rows_out.append((r[ok] - self.r0).astype(np.int16))
            cols_out.append(c[ok].astype(np.int32))
            vals.append(sl[ok])
        del h
        self.slope, self.px, self.half = slope, px, half
        self.rows, self.cols, self.vals = np.concatenate(rows_out), np.concatenate(cols_out), np.concatenate(vals)
        self.ready = True
        print(f"polar slope {d.pole}: {self.vals.size / 1e6:.1f} M native 80 m slopes in output rows "
              f"{self.r0}..{self.r1 - 1}, {time.time() - t0:.0f} s", flush=True)

    def release(self):
        for k in ("slope", "rows", "cols", "vals"):
            self.__dict__.pop(k, None)
        self.ready = False

    def apply(self, band: np.ndarray, ty: int):
        """Overwrite the cap rows of tile row ty (level z band (256, W, 2) [mean, max]) with polar slopes."""
        b0, b1 = max(self.r0, ty * TILE), min(self.r1, (ty + 1) * TILE)
        if b0 >= b1:
            return
        self.prepare()
        d, W = self.dem, self.W
        sel = np.flatnonzero((self.rows >= b0 - self.r0) & (self.rows < b1 - self.r0))
        flat = (self.rows[sel].astype(np.int64) + self.r0 - ty * TILE) * W + self.cols[sel]
        v = self.vals[sel]
        cnt = np.bincount(flat, minlength=TILE * W)
        mean = (np.bincount(flat, weights=v, minlength=TILE * W) / np.maximum(cnt, 1)).astype(np.float32)
        mx = np.full(TILE * W, -1.0, np.float32)
        np.maximum.at(mx, flat, v)
        mean, mx, cnt = mean.reshape(TILE, W), mx.reshape(TILE, W), cnt.reshape(TILE, W)
        # pixels containing no 80 m centre: the nearest 80 m slope at the pixel centre
        lon = -np.pi + (np.arange(W) + 0.5) * 2 * np.pi / W
        sinL, cosL = np.sin(lon), np.cos(lon)
        n = self.slope.shape[0]
        for r in range(b0, b1):
            i = r - ty * TILE
            empty = cnt[i] == 0
            if empty.any():
                lat = np.pi / 2 - (r + 0.5) * np.pi / self.H
                rho = 2 * d.R * np.tan((np.pi / 2 - d.sign * lat) / 2)
                x, y = rho * sinL[empty], -d.sign * rho * cosL[empty]
                cc = np.clip(np.floor((x + self.half) / self.px).astype(np.int64), 0, n - 1)
                rr = np.clip(np.floor((self.half - y) / self.px).astype(np.int64), 0, n - 1)
                s = self.slope[rr, cc]
                mean[i, empty] = s
                mx[i, empty] = s
            m, x_ = mean[i], np.where(mx[i] < 0, np.nan, mx[i])
            ok = np.isfinite(m)  # no polar data -> keep the global slope
            band[i, ok, 0] = m[ok]
            band[i, ok, 1] = np.where(np.isfinite(x_[ok]), x_[ok], m[ok])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--public-max", type=int, default=4)  # level 5 is ~150 MB: bucket
    ap.add_argument("--fine-max", type=int, default=7)
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--rows", default="", help="recompute only these tile rows of --fine-max, e.g. '0-6,121-127', "
                    "or 'polar' (the rows inside the polar caps); coarser levels are updated in place")
    ap.add_argument("--no-polar", action="store_true", help="global DEM only, also inside the polar caps")
    a = ap.parse_args()
    from polar_dem import blocks, load_poles, parse_rows
    polar = [ps for ps in (PolarSlope(d, a.fine_max) for d in load_poles(not a.no_polar)) if ps.available()]
    for ps in polar:
        print(f"polar slope {ps.dem.pole}: output rows {ps.r0}..{ps.r1 - 1} (tile rows {ps.tile_rows()}) from {ps.label.name}", flush=True)
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
        def band_for(ty: int) -> np.ndarray:
            b = slope_band(src, top, ty)
            for ps in polar:
                ps.apply(b, ty)
                if ps.ready and ty >= max(ps.tile_rows()):
                    ps.release()  # done with this cap
            return b

        w = Writer(PUBLIC_OUT, FINE_OUT, a.public_max, enc)
        t0 = time.time()
        rows = 2**top
        if not a.rows:
            c = Cascade(w, top)
            for ty in range(rows):
                c.push(ty, band_for(ty))
                if ty % 8 == 7:
                    el = time.time() - t0
                    print(f"row {ty + 1}/{rows}  {el / 60:.1f} min, ~{el / (ty + 1) * (rows - ty - 1) / 60:.1f} min left", flush=True)
        else:
            sel = sorted({r for ps in polar for r in ps.tile_rows()}) if a.rows == "polar" else parse_rows(a.rows, rows)
            print(f"recomputing tile rows {blocks(sel)} of level {top}", flush=True)
            for b0, b1 in blocks(sel):
                pc = PartialCascade(w, top, "RGB")
                for ty in range(b0, b1):
                    pc.push(ty, band_for(ty))
                    el = time.time() - t0
                    print(f"row {ty}  {el / 60:.1f} min", flush=True)
                pc.finish()
        w.flush()

    meta = {
        "tiling": "geographic", "tileSize": TILE, "format": "webp", "encoding": "u8x2", "channels": ["mean", "max"],
        "scale": STEP_DEG, "offset": -STEP_DEG,  # value = offset + scale * DN (R = mean, G = max), B = 255 valid
        "units": "deg", "publicMaxLevel": a.public_max, "fineMaxLevel": a.fine_max,
        "source": "Slope from LOLA LDEM 118 m global, mean of native-resolution slope per pixel",
        "levels": level_stats(PUBLIC_OUT, FINE_OUT, a.public_max, top) if a.rows else
                  {str(z): {"tiles": w.count.get(z, 0), "MB": round(w.bytes.get(z, 0) / 2**20, 1)} for z in range(top + 1)},
    }
    if polar:
        meta["source"] += (f"; inside the polar caps (|lat| > {polar[0].dem.cap_lat_deg:.1f} deg) from the LOLA polar 80 m DEMs "
                           + " / ".join(ps.label.stem.upper() for ps in polar))
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    (PUBLIC_OUT / "index.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta["levels"], indent=1))


if __name__ == "__main__":
    main()
