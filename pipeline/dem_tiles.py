"""
Global elevation tile pyramid for the browser (horizons, slope and global heatmaps).

Source: LOLA global LDEM 118 m (Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif, simple cylindrical,
int16 x 0.5 m above the 1737.4 km sphere). Output tiles follow Cesium's GeographicTilingScheme on
the Moon: level z has 2^(z+1) x 2^z tiles of 256 x 256 px, tile (x, y) counted from lon -180 and
lat +90, so pixel size = 180 deg / (256 * 2^z):

    z:      0      1      2      3      4      5      6      7
    m/px: 21300  10700   5330   2670   1330    666    333    167

  - levels 0..PUBLIC_MAX (default 5) -> web/public/data/dem/{z}/{x}/{y}.webp  (shipped, ~135 MB)
  - levels PUBLIC_MAX+1..FINE_MAX    -> MOON_DATA/dem_fine/{z}/{x}/{y}.webp  (~2 GB, downloaded on demand,
    e.g. when a site is selected; served by the Vite dev server, or any static bucket in production)

Encoding: lossless WebP (~28% smaller than PNG), 8-bit RGB, DN = R*256 + G, B = 255 valid / 0 no
data, height = DN * SCALE + OFFSET metres (same convention as the overlay DEM). Each pixel is the area
average of the source pixels. Shipped levels are rounded to 2 m (irrelevant at >= 666 m pixels, and
it compresses much better); fine levels keep the full 0.5 m.

The source is read in horizontal bands, one finest-level tile row at a time; coarser levels are
2x2 means accumulated row by row, so memory stays at a few hundred MB.

    python pipeline/dem_tiles.py                 # full pyramid (~15-30 min)
    python pipeline/dem_tiles.py --test          # encode a few tiles and report sizes only
"""
from __future__ import annotations

import argparse
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window

from config import DATA, GLOBAL_LDEM, WEB_DATA, find_local

TILE = 256
OFFSET, SCALE = -10000.0, 0.5  # DN 0..65535 -> -10000..+22767 m in 0.5 m steps (Moon: -9.1..+10.8 km)
PUBLIC_OUT = WEB_DATA / "dem"
FINE_OUT = DATA / "dem_fine"


def encode(h: np.ndarray, quant: float) -> bytes:
    """Heights (m, NaN = nodata) -> lossless WebP bytes. `quant` rounds heights to a coarser step (m) first:
    coarse levels don't need 0.5 m precision and compress much better without the noise."""
    ok = np.isfinite(h)
    hq = np.where(ok, np.round(np.where(ok, h, 0) / quant) * quant, 0)
    dn = np.clip(np.round((hq - OFFSET) / SCALE), 0, 65535).astype(np.uint16)
    rgb = np.empty(h.shape + (3,), np.uint8)
    rgb[..., 0] = dn >> 8
    rgb[..., 1] = dn & 255
    rgb[..., 2] = np.where(ok, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True, quality=100, method=4)
    return buf.getvalue()


PUBLIC_QUANT = 2.0


def quant_for(z: int, public_max: int = 5) -> float:
    return PUBLIC_QUANT if z <= public_max else SCALE


def down2(a: np.ndarray) -> np.ndarray:
    """2x2 mean ignoring NaN."""
    h, w = a.shape
    b = a.reshape(h // 2, 2, w // 2, 2)
    with np.errstate(invalid="ignore"):
        return np.nanmean(b, axis=(1, 3)).astype(np.float32)


class Writer:
    def __init__(self, public_max: int, workers: int = 12):
        self.public_max = public_max
        self.pool = ThreadPoolExecutor(workers)
        self.futures = []
        self.bytes = {}
        self.count = {}

    def row(self, z: int, ty: int, band: np.ndarray):
        """Write one full tile row (256 x 512*2^z) of level z."""
        root = PUBLIC_OUT if z <= self.public_max else FINE_OUT
        q = quant_for(z, self.public_max)
        for tx in range(band.shape[1] // TILE):
            tile = band[:, tx * TILE:(tx + 1) * TILE]
            self.futures.append(self.pool.submit(self._write, root / str(z) / str(tx) / f"{ty}.webp", tile.copy(), q, z))
        if len(self.futures) > 4000:
            self.flush()

    def _write(self, path: Path, tile: np.ndarray, q: float, z: int):
        data = encode(tile, q)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return z, len(data)

    def flush(self):
        for f in self.futures:
            z, n = f.result()
            self.bytes[z] = self.bytes.get(z, 0) + n
            self.count[z] = self.count.get(z, 0) + 1
        self.futures = []


def read_band(src, z: int, ty: int) -> np.ndarray:
    """Tile row ty of level z, area-averaged from the source (heights in m, NaN = nodata)."""
    W, H = src.width, src.height
    out_w, out_h = TILE * 2 ** (z + 1), TILE * 2**z
    r0 = ty * TILE * H / out_h
    r1 = (ty + 1) * TILE * H / out_h
    # whole source rows; the fractional edge is negligible (<1 source px = 118 m)
    win = Window(0, int(round(r0)), W, int(round(r1)) - int(round(r0)))
    dn = src.read(1, window=win, out_shape=(TILE, out_w), resampling=Resampling.average, masked=True)
    h = dn.astype(np.float32).filled(np.nan) * float(src.scales[0] or 1) + float(src.offsets[0] or 0)
    return h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--public-max", type=int, default=5)
    ap.add_argument("--fine-max", type=int, default=7)
    ap.add_argument("--test", action="store_true", help="encode a few tiles, report sizes, write nothing")
    a = ap.parse_args()

    path = find_local(GLOBAL_LDEM)
    if not path:
        raise SystemExit(f"{GLOBAL_LDEM} not found in {DATA} or the repo's parent folder")
    top = a.fine_max

    with rasterio.open(path) as src:
        if a.test:
            for z in (3, 5, 7):
                band = read_band(src, z, (2**z) // 2 - 1)  # a row just north of the equator
                sizes = [len(encode(band[:, i * TILE:(i + 1) * TILE], quant_for(z))) for i in range(0, band.shape[1] // TILE, max(1, band.shape[1] // TILE // 8))]
                n_tiles = 2 ** (z + 1) * 2**z
                print(f"z{z}: quant {quant_for(z)} m, mean tile {np.mean(sizes) / 1024:.0f} KB -> level total ~{np.mean(sizes) * n_tiles / 2**20:.0f} MB ({n_tiles} tiles)")
            return

        w = Writer(a.public_max)
        pending: dict[int, list[np.ndarray]] = {z: [] for z in range(top)}
        t0 = time.time()
        rows = 2**top
        for ty in range(rows):
            band = read_band(src, top, ty)
            w.row(top, ty, band)
            # cascade 2x2 means: two rows of level z make one row of level z-1
            z, b, y = top, band, ty
            while z > 0:
                pending[z - 1].append(b)
                if len(pending[z - 1]) < 2:
                    break
                b = down2(np.vstack(pending[z - 1]))
                pending[z - 1] = []
                z, y = z - 1, y // 2
                w.row(z, y, b)
            if ty % 8 == 7:
                el = time.time() - t0
                print(f"row {ty + 1}/{rows}  {el / 60:.1f} min elapsed, ~{el / (ty + 1) * (rows - ty - 1) / 60:.1f} min left", flush=True)
        w.flush()

    meta = {
        "tiling": "geographic", "tileSize": TILE, "format": "webp", "encoding": "u16", "scale": SCALE, "offset": OFFSET,
        "publicMaxLevel": a.public_max, "fineMaxLevel": a.fine_max,
        "source": "LOLA LDEM 118 m global (Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014), area-averaged",
        "levels": {str(z): {"tiles": w.count.get(z, 0), "MB": round(w.bytes.get(z, 0) / 2**20, 1)} for z in range(top + 1)},
    }
    PUBLIC_OUT.mkdir(parents=True, exist_ok=True)
    (PUBLIC_OUT / "index.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta["levels"], indent=1))


if __name__ == "__main__":
    main()
