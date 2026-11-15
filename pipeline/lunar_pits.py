#!/usr/bin/env python3
"""
Lunar pits: descrizione quantitativa a partire dai dati NASA LRO / LROC, riportati sul DEM LOLA
usato dalla web app.

FONTI DEI DATI
--------------
- Catalogo completo (278 pit, IAU MOON2000 = stesso frame Moon ME dei prodotti LOLA):
  Wagner & Robinson (2021), "Occurrence and Origin of Lunar Pits: Observations from a New
  Catalog", LPSC 52, abstract #2530.  CSV nel PDS LROC (EXTRAS/SHAPEFILE/LUNAR_PIT_LOCATIONS).
- LROC Pits Atlas (NASA / Arizona State University): https://www.lroc.asu.edu/atlases/pits
- Quote: LOLA LDEM 118 m globale (Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014), letto dalle stesse
  tile di web/public/data/dem che la web app usa per il terreno 3D (dem_tiles.py), quindi i pit
  stanno esattamente sulla superficie disegnata. Quote in metri rispetto alla sfera di
  riferimento LOLA R = 1737.4 km.

ADATTAMENTI AL CATALOGO REALE
-----------------------------
- Le colonne del CSV si chiamano "Host Feature", "Longitude_180", "Funnel Max Diam",
  "Entrance Ramp?", ... (non HostFeatur/Longitude/FunMaxDiam come nello shapefile).
- Il CSV e' UTF-8 con alcuni byte Mac Roman (es. "Schl\\x9fter" = Schlüter): vedi read_catalog_text.
- "Depth" e' testo (">25" = fondo non visibile, profondita' minima); "Depth_Num" e' il numero.

Uso:
    python pipeline/lunar_pits.py                       # report + grafici dei pit dell'Atlas
    python pipeline/lunar_pits.py --catalog F.CSV --out pits.png
"""

from __future__ import annotations

import argparse
import codecs
import csv
import io
import json
import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

from config import DATA, MOON_R, WEB_DATA

R_MOON_M = MOON_R  # raggio della sfera di riferimento LOLA (m)
DEFAULT_CATALOG = Path(__file__).resolve().parent / "data" / "LUNAR_PIT_LOCATIONS.CSV"
ATLAS_PITS = (  # i pit principali delle schede dell'Atlas, usati per report e grafici
    "Mare Tranquillitatis Pit",
    "Marius Hills Pit",
    "West Marius Hills Pit",
    "Mare Ingenii Pit",
    "Southwest Mare Tranquillitatis Pit",
)


# --------------------------------------------------------------------------- #
# Modello dati
# --------------------------------------------------------------------------- #
@dataclass
class LunarPit:
    name: str
    host: str
    lat: float                      # gradi N
    lon: float                      # gradi E, dominio -180..180 (come Cesium e la web app)
    terrain: str = ""               # Mare / Impact Melt / Highland
    type: str = ""                  # Large Bowl / Fracture / Uncertain / ""
    funnel_min_m: Optional[float] = None
    funnel_max_m: Optional[float] = None
    inner_min_m: Optional[float] = None
    inner_max_m: Optional[float] = None
    azimuth_deg: Optional[float] = None   # orientamento asse maggiore, da Nord in senso orario
    depth_m: Optional[float] = None       # profondita' dalla superficie circostante
    depth_is_lower_bound: bool = False    # True se il catalogo riporta ">X" (fondo non visibile)
    entry_ramp: Optional[str] = None      # Y / N / Y? / N? / ?
    overhang: Optional[str] = None
    image_id: Optional[str] = None        # immagine NAC di riferimento
    dtm: Optional[str] = None
    warnings: Optional[str] = None
    notes: str = ""                       # descrizione del catalogo
    surface_elev_m: Optional[float] = None  # quota LOLA della superficie attorno al pit
    source: str = "LROC lunar pit catalog (Wagner & Robinson 2021)"

    # --- geografia ------------------------------------------------------- #
    @property
    def lon360(self) -> float:
        return self.lon % 360.0

    @property
    def floor_elev_m(self) -> Optional[float]:
        """Quota del fondo: superficie LOLA - profondita' (minima se depth_is_lower_bound)."""
        if self.surface_elev_m is None or self.depth_m is None:
            return None
        return self.surface_elev_m - self.depth_m

    # --- geometria ------------------------------------------------------- #
    @property
    def inner_area_m2(self) -> Optional[float]:
        """Area ellittica della bocca verticale interna: pi/4 * Dmax * Dmin."""
        if self.inner_min_m and self.inner_max_m:
            return math.pi / 4 * self.inner_min_m * self.inner_max_m
        return None

    @property
    def funnel_area_m2(self) -> Optional[float]:
        if self.funnel_min_m and self.funnel_max_m:
            return math.pi / 4 * self.funnel_min_m * self.funnel_max_m
        return None

    @property
    def inner_mean_diam_m(self) -> Optional[float]:
        if self.inner_min_m and self.inner_max_m:
            return (self.inner_min_m + self.inner_max_m) / 2
        return None

    @property
    def ellipticity(self) -> Optional[float]:
        """Rapporto asse maggiore / asse minore della bocca interna."""
        if self.inner_min_m and self.inner_max_m:
            return self.inner_max_m / self.inner_min_m
        return None

    @property
    def depth_to_diameter(self) -> Optional[float]:
        d = self.inner_mean_diam_m
        if d and self.depth_m:
            return self.depth_m / d
        return None

    @property
    def inner_volume_m3(self) -> Optional[float]:
        """
        STIMA di massima: cilindro ellittico (pareti verticali, fondo piatto).
        Ignora funnel, detriti sul fondo ed eventuali cavita' laterali
        (che radar e immagini suggeriscono per alcuni pit), quindi e' solo
        un ordine di grandezza.
        """
        if self.inner_area_m2 and self.depth_m:
            return self.inner_area_m2 * self.depth_m
        return None

    @property
    def radius_m(self) -> Optional[float]:
        """Raggio di riferimento per la visualizzazione (funnel, altrimenti bocca interna)."""
        d = self.funnel_max_m or self.inner_max_m or self.inner_min_m or self.funnel_min_m
        return d / 2 if d else None

    # --- stampa ---------------------------------------------------------- #
    def describe(self) -> str:
        def f(x, unit="m", nd=0):
            return "n/d" if x is None else f"{x:,.{nd}f} {unit}"

        depth = f(self.depth_m)
        if self.depth_m is not None and self.depth_is_lower_bound:
            depth = "> " + depth
        lines = [
            f"{self.name}  [{self.host}, {self.terrain}]",
            f"  Posizione      : {self.lat:+.4f}° N, {self.lon:+.4f}° E ({self.lon360:.4f}° E nel dominio 0-360)",
            f"  Quota LOLA     : {f(self.surface_elev_m)} (fondo {f(self.floor_elev_m)})",
            f"  Funnel         : {f(self.funnel_min_m)} x {f(self.funnel_max_m)}",
            f"  Pit interno    : {f(self.inner_min_m)} x {f(self.inner_max_m)}"
            + (f"  (ellitticita' {self.ellipticity:.2f})" if self.ellipticity else ""),
            f"  Azimuth asse   : {f(self.azimuth_deg, '°')}",
            f"  Profondita'    : {depth}"
            + (f"  (depth/diam = {self.depth_to_diameter:.2f})" if self.depth_to_diameter else ""),
            f"  Area bocca int.: {f(self.inner_area_m2, 'm²')}",
            f"  Vol. int. stima: {f(self.inner_volume_m3, 'm³')}",
        ]
        if self.notes:
            lines.append(f"  Note           : {self.notes}")
        return "\n".join(lines)

    # --- export ---------------------------------------------------------- #
    def to_feature(self, nd: int = 2) -> dict:
        """Feature GeoJSON per la web app (coordinate lon -180..180, lat; quote in metri)."""
        def r(x, n=nd):
            return None if x is None else round(float(x), n)

        props = {k: v for k, v in asdict(self).items() if k not in ("lat", "lon", "source")}
        props.update({
            "surface_elev_m": r(self.surface_elev_m, 1),
            "floor_elev_m": r(self.floor_elev_m, 1),
            "inner_area_m2": r(self.inner_area_m2, 0),
            "funnel_area_m2": r(self.funnel_area_m2, 0),
            "inner_volume_m3": r(self.inner_volume_m3, -2),
            "depth_to_diameter": r(self.depth_to_diameter),
            "ellipticity": r(self.ellipticity),
            "radius_m": r(self.radius_m, 1),
        })
        return {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(self.lon, 5), round(self.lat, 5)]},
            "properties": props,
        }


# --------------------------------------------------------------------------- #
# Lettura del catalogo LROC
# --------------------------------------------------------------------------- #
codecs.register_error("pits_macroman", lambda e: (e.object[e.start:e.end].decode("mac_roman"), e.end))


def read_catalog_text(path: Path) -> str:
    """UTF-8, ma i byte non validi (es. 0x9F = ü) vengono letti come Mac Roman."""
    return path.read_bytes().decode("utf-8-sig", "pits_macroman")


_num = re.compile(r"[-+]?\d*\.?\d+")


def parse_num(raw: Optional[str]) -> tuple[Optional[float], bool]:
    """
    Converte campi numerici del catalogo. Restituisce (valore, e_un_limite_inferiore).
    Gestisce 'N/A', vuoti e profondita' tipo '>25' (nessun fondo visibile).
    """
    if raw is None:
        return None, False
    s = raw.strip()
    if not s or s.upper() in {"N/A", "NA", "NAN", "?"}:
        return None, False
    m = _num.search(s)
    return (float(m.group()), s.startswith(">")) if m else (None, False)


def parse_flag(raw: Optional[str]) -> Optional[str]:
    """Y, N, Y?, N?, ? -> stringa pulita (oppure None)."""
    s = (raw or "").strip().upper()
    return s or None


def _key(name: str) -> str:
    """'Host Feature' / 'HostFeatur' / 'Entrance Ramp?' -> 'hostfeature' / 'hostfeatur' / 'entranceramp'."""
    return re.sub(r"[^a-z0-9]", "", name.lower())


def load_catalog(path: Path = DEFAULT_CATALOG) -> list[LunarPit]:
    """Legge il CSV LUNAR_PIT_LOCATIONS (anche con i nomi di colonna abbreviati dello shapefile)."""
    reader = csv.DictReader(io.StringIO(read_catalog_text(path)))
    cols = {_key(c): c for c in (reader.fieldnames or [])}

    def get(row: dict, *names: str) -> Optional[str]:
        for n in names:
            c = cols.get(_key(n))
            if c is not None:
                return row.get(c)
        return None

    for needed in (("Latitude",), ("Longitude_180", "Longitude_360", "Longitude"), ("Name",)):
        if not any(_key(n) in cols for n in needed):
            raise SystemExit(f"[pits] colonna {needed[0]!r} non trovata. Colonne: {reader.fieldnames}")

    def text(row, *names):
        return (get(row, *names) or "").strip() or None

    pits: list[LunarPit] = []
    for row in reader:
        lat, _ = parse_num(get(row, "Latitude"))
        lon, _ = parse_num(get(row, "Longitude_180", "Longitude_360", "Longitude"))
        if lat is None or lon is None:
            continue
        depth, _ = parse_num(get(row, "Depth_Num", "Depth"))
        _, depth_lb = parse_num(get(row, "Depth"))   # il campo testuale usa ">X"
        az, _ = parse_num(get(row, "Azimuth"))
        pits.append(LunarPit(
            name=text(row, "Name") or "",
            host=text(row, "Host Feature", "HostFeatur") or "",
            terrain=text(row, "Terrain") or "",
            type=text(row, "Type") or "",
            lat=lat,
            lon=((lon + 180.0) % 360.0) - 180.0,
            funnel_max_m=parse_num(get(row, "Funnel Max Diam", "FunMaxDiam"))[0],
            funnel_min_m=parse_num(get(row, "Funnel Min Diam", "FunMinDiam"))[0],
            inner_max_m=parse_num(get(row, "Inner Max Diam", "InMaxDiam"))[0],
            inner_min_m=parse_num(get(row, "Inner Min Diam", "InMinDiam"))[0],
            azimuth_deg=az if az else None,            # 0 = nessun asse lungo
            depth_m=depth,
            depth_is_lower_bound=depth_lb,
            entry_ramp=parse_flag(get(row, "Entrance Ramp?", "EntryRamp")),
            overhang=parse_flag(get(row, "Overhangs?", "Overhang")),
            image_id=text(row, "Image 1", "Image1"),
            dtm=text(row, "DTM", "DTMs"),
            warnings=text(row, "Warnings"),
            notes=text(row, "Description") or "",
        ))
    return pits


# --------------------------------------------------------------------------- #
# DEM LOLA (tile della web app)
# --------------------------------------------------------------------------- #
class LolaTiles:
    """
    Campiona il DEM LOLA globale dalle tile della web app (dem_tiles.py): tiling geografico,
    livello z = 2^(z+1) x 2^z tile da 256 px, tile (x, y) contate da lon -180 e lat +90,
    pixel = media d'area (centro a +0.5 px), quota = (R*256 + G) * scale + offset, B = 0 nessun dato.
    Usa il livello piu' fine disponibile: le tile fini in MOON_DATA/dem_fine se ci sono
    (fino a ~167 m), altrimenti quelle pubblicate (livello 5, ~666 m).
    """

    def __init__(self, public_dir: Path = WEB_DATA / "dem", fine_dir: Path = DATA / "dem_fine"):
        self.meta = json.loads((public_dir / "index.json").read_text(encoding="utf-8"))
        self.size = self.meta["tileSize"]
        self.dirs = {z: public_dir for z in range(self.meta["publicMaxLevel"] + 1)}
        for z in range(self.meta["publicMaxLevel"] + 1, self.meta.get("fineMaxLevel", -1) + 1):
            if (fine_dir / str(z)).is_dir():
                self.dirs[z] = fine_dir
        self.level = max(self.dirs)
        self._cache: dict[tuple[int, int, int], Optional[np.ndarray]] = {}

    @property
    def resolution_m(self) -> float:
        return math.radians(180.0 / (self.size * 2 ** self.level)) * R_MOON_M

    @property
    def source(self) -> str:
        return f"{self.meta['source']}; tiles z={self.level} (~{self.resolution_m:.0f} m/px)"

    def _tile(self, z: int, tx: int, ty: int) -> Optional[np.ndarray]:
        key = (z, tx, ty)
        if key not in self._cache:
            path = self.dirs[z] / str(z) / str(tx) / f"{ty}.{self.meta['format']}"
            if path.exists():
                rgb = np.asarray(Image.open(path).convert("RGB"))
                dn = rgb[..., 0].astype(np.float64) * 256 + rgb[..., 1]
                self._cache[key] = np.where(rgb[..., 2] > 0, dn * self.meta["scale"] + self.meta["offset"], np.nan)
            else:
                self._cache[key] = None
        return self._cache[key]

    def _pixel(self, z: int, px: int, py: int) -> float:
        n_x, n_y = 2 ** (z + 1) * self.size, 2 ** z * self.size
        px %= n_x                                  # continuita' sull'antimeridiano
        py = min(max(py, 0), n_y - 1)
        tile = self._tile(z, px // self.size, py // self.size)
        return np.nan if tile is None else float(tile[py % self.size, px % self.size])

    def sample(self, lat: float, lon: float) -> Optional[float]:
        """Quota bilineare [m] rispetto alla sfera di 1737.4 km (None fuori dai dati)."""
        z = self.level
        deg = 180.0 / (self.size * 2 ** z)
        fx = (((lon + 180.0) % 360.0) / deg) - 0.5
        fy = ((90.0 - lat) / deg) - 0.5
        x0, y0 = math.floor(fx), math.floor(fy)
        wx, wy = fx - x0, fy - y0
        v = ((self._pixel(z, x0, y0) * (1 - wx) + self._pixel(z, x0 + 1, y0) * wx) * (1 - wy)
             + (self._pixel(z, x0, y0 + 1) * (1 - wx) + self._pixel(z, x0 + 1, y0 + 1) * wx) * wy)
        return None if math.isnan(v) else v


def attach_lola(pits: list[LunarPit], dem: Optional[LolaTiles] = None) -> LolaTiles:
    """Aggiunge a ogni pit la quota LOLA della superficie circostante."""
    dem = dem or LolaTiles()
    for p in pits:
        p.surface_elev_m = dem.sample(p.lat, p.lon)
    return dem


# --------------------------------------------------------------------------- #
# Funzioni di analisi
# --------------------------------------------------------------------------- #
def great_circle_km(a: LunarPit, b: LunarPit) -> float:
    """Distanza ortodromica sulla Luna (formula di haversine, R = 1737.4 km)."""
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dphi = p2 - p1
    dlam = math.radians(b.lon - a.lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * R_MOON_M * math.asin(math.sqrt(h)) / 1000.0


def print_report(pits: list[LunarPit], showcase=ATLAS_PITS) -> None:
    print("=" * 78)
    print("LUNAR PITS - catalogo LROC (NASA / Arizona State University) + quote LOLA")
    print("=" * 78)
    by_name = {p.name: p for p in pits}
    for name in showcase:
        if name in by_name:
            print(by_name[name].describe())
            print("-" * 78)

    if "Marius Hills Pit" in by_name and "West Marius Hills Pit" in by_name:
        d = great_circle_km(by_name["Marius Hills Pit"], by_name["West Marius Hills Pit"])
        print(f"Distanza Marius Hills <-> West Marius Hills: {d:.1f} km (l'Atlas riporta ~45 km)")

    terrains = {}
    for p in pits:
        terrains[p.terrain] = terrains.get(p.terrain, 0) + 1
    diam = [p.inner_mean_diam_m for p in pits if p.inner_mean_diam_m]
    depth = [p.depth_m for p in pits if p.depth_m is not None]
    elev = [p.surface_elev_m for p in pits if p.surface_elev_m is not None]
    print(f"\nCatalogo: {len(pits)} pit {terrains}")
    if diam:
        print(f"Diametro interno medio: {np.mean(diam):.0f} m (mediana {np.median(diam):.0f}, "
              f"min {min(diam):.0f}, max {max(diam):.0f}; n={len(diam)})")
    if depth:
        lb = sum(p.depth_is_lower_bound for p in pits)
        print(f"Profondita' mediana: {np.median(depth):.0f} m (max {max(depth):.0f}; {lb} solo limite inferiore)")
    if elev:
        print(f"Quota LOLA: {min(elev):.0f} .. {max(elev):.0f} m ({len(elev)}/{len(pits)} pit con quota)")


# --------------------------------------------------------------------------- #
# Grafici
# --------------------------------------------------------------------------- #
def plot_pits(pits: list[LunarPit], outfile: str = "lunar_pits.png", showcase=ATLAS_PITS) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Ellipse

    by_name = {p.name: p for p in pits}
    full = [by_name[n] for n in showcase if n in by_name]
    full = [p for p in full if p.inner_min_m and p.inner_max_m and p.funnel_min_m and p.funnel_max_m]
    if not full:
        print("Nessun pit con geometria completa da disegnare")
        return
    n = len(full)
    fig, axes = plt.subplots(2, n, figsize=(4.2 * n, 8), squeeze=False)

    for i, p in enumerate(full):
        # ---- vista dall'alto: funnel + pit interno (azimuth: dal Nord, orario) ----
        ax = axes[0][i]
        angle = 90 - (p.azimuth_deg or 90)  # azimuth geografico -> angolo matplotlib
        ax.add_patch(Ellipse((0, 0), p.funnel_max_m, p.funnel_min_m, angle=angle,
                             fc="#d9d2c5", ec="#6b6354", lw=1.2, label="funnel"))
        ax.add_patch(Ellipse((0, 0), p.inner_max_m, p.inner_min_m, angle=angle,
                             fc="#2b2b2b", ec="k", lw=1.2, label="pit interno"))
        lim = p.funnel_max_m * 0.7
        ax.set(xlim=(-lim, lim), ylim=(-lim, lim), aspect="equal",
               title=p.name.replace(" Pit", ""), xlabel="m", ylabel="m (N ↑)")
        if i == 0:
            ax.legend(loc="lower left", fontsize=8)

        # ---- sezione schematica (cilindro + funnel, senza cavita' laterali), in quota LOLA ----
        ax = axes[1][i]
        if p.depth_m:
            r_in, r_fn, d = p.inner_max_m / 2, p.funnel_max_m / 2, p.depth_m
            z0 = p.surface_elev_m or 0.0
            ax.fill([-r_fn, -r_in, -r_in, r_in, r_in, r_fn],
                    [z0, z0, z0 - d, z0 - d, z0, z0], color="#8a8170", alpha=0.6)
            ax.plot([-r_fn - 20, -r_in, -r_in, r_in, r_in, r_fn + 20],
                    [z0, z0, z0 - d, z0 - d, z0, z0], "k", lw=1.5)
            ax.set(xlim=(-lim, lim), ylim=(z0 - d * 1.15, z0 + d * 0.2), aspect="equal",
                   title=f"Sezione (prof. {'>' if p.depth_is_lower_bound else ''}{d:.0f} m)",
                   xlabel="m", ylabel="quota LOLA [m]" if p.surface_elev_m is not None else "m")
        else:
            ax.text(0.5, 0.5, "profondita'\nnon disponibile", ha="center", va="center")
            ax.set_axis_off()

    fig.suptitle("Lunar pits - geometria dal catalogo LROC, quote LOLA (schema semplificato)", y=0.99)
    fig.tight_layout()
    fig.savefig(outfile, dpi=150)
    plt.close(fig)
    print(f"Grafico salvato in {outfile}")


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description="Descrizione dei lunar pits (dati NASA/LROC + LOLA)")
    ap.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG,
                    help="LUNAR_PIT_LOCATIONS.CSV (scaricalo con pipeline/pits.py)")
    ap.add_argument("--out", default=str(DEFAULT_CATALOG.with_name("lunar_pits.png")), help="immagine di output")
    args = ap.parse_args()
    if not args.catalog.exists():
        raise SystemExit(f"Catalogo non trovato: {args.catalog} (esegui prima python pipeline/pits.py)")

    pits = load_catalog(args.catalog)
    dem = attach_lola(pits)
    print(f"DEM: {dem.source}")
    print_report(pits)
    plot_pits(pits, args.out)


if __name__ == "__main__":
    main()
