"""Shared paths and constants for the offline data pipeline.

Raw downloads (hundreds of MB) live OUTSIDE the repo, in MOON_DATA (default: the folder above the
repo, i.e. D:\\Moon\\data). Small web-ready outputs go to web/public/data and are committed, so a
plain static deploy (Vercel / GitHub Pages) needs no Python at build time.
"""
from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("MOON_DATA", REPO.parent / "data"))
RAW = DATA / "raw"          # PDS products
KERNELS = DATA / "kernels"  # NAIF SPICE kernels
WEB_DATA = REPO / "web" / "public" / "data"
OVERLAYS_OUT = WEB_DATA / "overlays"

# Files you may already have from earlier experiments (looked up in DATA and in the repo's parent folder)
NOMENCLATURE_SHP = "MOON_nomenclature_center_pts/MOON_nomenclature_center_pts.shp"
GLOBAL_LDEM = "Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif"

MOON_R = 1737400.0  # m, reference sphere of all LOLA products
MOON_GEOG = "+proj=longlat +R=1737400 +no_defs"
SOUTH_STERE = "+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"


def find_local(rel: str) -> Path | None:
    """Return an existing file from DATA, RAW or the repo's parent folder."""
    for base in (DATA, RAW, REPO.parent):
        p = base / rel
        if p.exists():
            return p
    return None


PDS = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx"
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"

# PDS3 products: each is a .lbl label + .img binary. GDAL opens the .lbl.
PRODUCTS = {
    # LOLA team average illumination / Earth visibility / permanent shadow, 85S-90S at 60 m (Mazarico et al.)
    "avgvisib_85s_060m_201608": f"{PDS}/extras/illumination/img/avgvisib_85s_060m_201608",
    "avgvisib_85s_060m_201608_earth": f"{PDS}/extras/illumination/img/avgvisib_85s_060m_201608_earth",
    "lpsr_85s_060m_201608": f"{PDS}/extras/illumination/img/lpsr_85s_060m_201608",
    # LOLA slope 85S-90S at 40 m
    "ldsm_85s_40m": f"{PDS}/data/lola_gdr/polar/img/ldsm_85s_40m",
    # LOLA elevation 80S-90S at 80 m (horizons, elevation layer)
    "ldem_80s_80m": f"{PDS}/data/lola_gdr/polar/img/ldem_80s_80m",
}
# Optional, bigger: sharper near-field horizons (460 MB) and wider illumination coverage (75S, 116 MB each)
OPTIONAL_PRODUCTS = {
    "ldem_85s_20m": f"{PDS}/data/lola_gdr/polar/img/ldem_85s_20m",
    "avgvisib_75s_120m_201608": f"{PDS}/extras/illumination/img/avgvisib_75s_120m_201608",
    "avgvisib_75s_120m_201608_earth": f"{PDS}/extras/illumination/img/avgvisib_75s_120m_201608_earth",
}

KERNEL_FILES = {
    "naif0012.tls": f"{NAIF}/lsk/naif0012.tls",
    "pck00011.tpc": f"{NAIF}/pck/pck00011.tpc",
    "moon_pa_de440_200625.bpc": f"{NAIF}/pck/moon_pa_de440_200625.bpc",
    "moon_de440_250416.tf": f"{NAIF}/fk/satellites/moon_de440_250416.tf",
    "moon_assoc_me.tf": f"{NAIF}/fk/satellites/moon_assoc_me.tf",
    "de440s.bsp": f"{NAIF}/spk/planets/de440s.bsp",
}
