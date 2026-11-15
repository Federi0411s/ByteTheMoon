# ByteTheMoon: Lunar Landing Site Navigator

NASA Space Apps 2026. An interactive 3D Moon for comparing landing sites by **sunlight** (power) and **Earth visibility** (communications). It takes the real terrain horizon from NASA LOLA data into account.

- Streaming 3D Moon (Cesium Moon 3D Tiles), with a NASA Moon Trek fallback
- **Global heatmaps** draped on the 3D surface, computed in the browser for the selected period (the mission period, or else the loaded 5-year window): sunlight, Earth visibility, permanent shadow, slope, elevation, surface charging, regolith temperature, radiation dose, and a live **landing-suitability score**
- **Advanced Mode** lets expert users adjust landing-score thresholds and EVA temperature/radiation limits for the current session; reloading the app restores the defaults defined in the code
- Time controls to step backward or forward by 1 minute, 30 minutes, 1 hour, 6 hours, 12 hours, or 1 day, plus a slider to set the date; Moon lighting uses the Sun's real position (NASA SPICE)
- Landing-site panel expands to half the screen for easier browsing of analysis windows from 1 day to 1 year
- Click a point on the Moon to inspect it, then save it with a custom name; saved sites persist in the browser and can be renamed or removed
- Generate a formal technical PDF report for any selected site, with its 360° terrain-horizon panorama and Sun/Earth tracks, full-period visibility analysis, terrain details, and optional close-up map images captured separately for each active filter
- Per-site horizon panorama with Sun/Earth paths, a lit/comms timeline, time to sunset/Earthset, and the longest night
- Click anywhere on the Moon to analyse a custom site (horizon computed where elevation data is available)
- Select a landing site and open its low-altitude terrain view from the left panel; return to the saved map camera with one click

See [docs/PLAN.md](docs/PLAN.md) for the architecture, the team split and next steps.

## Run the web app

```powershell
cd web
copy .env.example .env.local   # then paste your Cesium ion token
npm install
npm run dev                   # http://localhost:5173
```

Without a token, or if Cesium ion fails, the app falls back to the NASA Moon Trek basemap. Overlays work the same either way.

### Global heatmaps and the fine elevation tiles

Heatmaps are computed in the browser from a global LOLA elevation pyramid (see [How the heatmaps are computed](#how-the-heatmaps-are-computed)):

- **Levels 0–5** (666 m/px and coarser, 134 MB) ship with the app in `web/public/data/dem`.
- **Levels 6–7** (333 and 167 m/px, 1.67 GB) are too large for git. `pipeline/dem_tiles.py` writes them to `$MOON_DATA/dem_fine`, and `npm run dev` serves them at `/dem-fine` automatically.
- **In production**, upload `dem_fine/` to a static bucket that allows cross-origin requests (e.g. Cloudflare R2 with CORS open). Set its base URL in `VITE_DEM_FINE_URL`; tiles are fetched as `{z}/{x}/{y}.webp`. If it is not set, the app falls back to the 666 m tiles everywhere.
- On the **Moon Trek fallback**, **LOLA 3D elevation relief** builds terrain meshes from the shipped DEM tiles on demand and colorizes the same visible area. It is off by default to keep startup rendering light, and can be toggled in the basemap panel. Optional fine DEM tiles are used only when configured; otherwise the terrain stops at the shipped 666 m/px level. Polar mesh edges use a shared pole height to avoid spikes where longitude lines converge. The Cesium ion basemap supplies its own 3D terrain mesh.

### Precomputed layers (time-independent)

Layers that depend only on the terrain are precomputed at full resolution and drawn straight from tiles,
with no computation in the browser. They share the elevation pyramid's tile layout: the coarse levels ship in
`web/public/data/<name>` (slope 0–4, about 60 MB; sky view 0–5), and the finer ones, down to 167 m/px, go to
`$MOON_DATA/<name>_fine` and a bucket:

| Layer | Tiles | Made by |
|---|---|---|
| Elevation | `dem` (the elevation pyramid itself) | `pipeline/dem_tiles.py` |
| Slope | `slope`: R = mean, G = max of the native 118 m slopes inside each pixel | `pipeline/slope_tiles.py` |
| Radiation dose | `sky`: visible-sky fraction, with the same horizon model as the browser | `pipeline/sky_view.py` |

The radiation dose only depends on the period through the solar-cycle factor, which is applied in the
browser. Fine-level URLs:
`VITE_SLOPE_FINE_URL` / `VITE_SKY_FINE_URL`, otherwise `VITE_DEM_FINE_URL` with `dem_fine` replaced by
`slope_fine` / `sky_fine` (so one bucket with three folders is enough), otherwise `/slope-fine` and
`/sky-fine` in dev. Without fine tiles, the layers fall back to the finest shipped level.
Near the poles these tiles are drawn with extra rows, because Cesium picks polar imagery levels from the
east–west spacing; otherwise everything would be smeared along the meridians. If a pyramid is
missing entirely, the layer is computed live as before.

The older radiation layer reads `radiation_overlay.json`, `radiation_classes.png` and
`radiation_continuous.png` from `web/public/radiation`. Its controls appear in the map-layer panel only when
that metadata JSON exists.

### How the heatmaps are computed

Each heatmap tile is computed in a Web Worker (`web/src/lib/heatWorker.ts`) for the selected period:

| Layer | Method |
|---|---|
| Horizons | 32 azimuths × 40 steps out to 200 km per point. Coarser DEM levels are used further away, and lunar curvature is included. Near the poles each tile's sample grid has more rows than columns (`lib/heatGrid.ts`), so the spacing stays square on the ground |
| Sunlight / Earth visibility | Fraction of the selected mission window with the Sun / Earth above that horizon (SPICE ephemeris) |
| Permanent shadow (PSR) | Never lit during the selected period |
| Slope, elevation | Precomputed tiles (see above); computed from the DEM tiles only if those are missing |
| Surface charging | EQUIPOT model, reading `pipeline/equipot_results.csv` directly, with the terrain horizon instead of a flat one |
| Regolith temperature | Hayne et al. 2017 1-D model, implicit solver in 6 h steps. A window over 1 year is sampled as 12 lunations spread across it, each after a 1-lunation warm-up |
| Radiation dose | `(20.2·f_sky + 6.2·(1 − f_sky)) × GCR factor`, where f_sky is the visible-sky fraction (precomputed tiles, see above). The GCR factor is **approximate**: a cosine 11-year solar cycle, minimum Dec 2019, 30 % lower at solar maximum. The *classes* view shows terrain shielding: its thresholds (12.0 / 12.8 µGy/h at the 2019 minimum) scale with the same factor, and the legend shows the selected period's values |

Resolution follows the zoom level, except around the selected site: within about 15 km of it, every layer
is computed from the finest elevation tiles (167 m with the fine tiles, otherwise 666 m), with one sample per
elevation pixel, once the view is close enough (map tile level 6 or deeper).

The poles are drawn by the same engine as everywhere else. The LOLA 60 m polar maps and the pipeline's
4 km polar rasters are no longer drawn: they were long-term averages or coarser, and the per-period
computation supersedes them.

## Rebuild the data (Python, optional)

The generated data in `web/public/data` is committed, so you only need this to change or add layers.

```powershell
pip install -r pipeline/requirements.txt
python pipeline/download.py      # ~500 MB into ..\data (outside the repo), resumable
python pipeline/overlays.py      # -> web/public/data/overlays
python pipeline/lunar_radiation.py  # -> web/public/radiation (LOLA, about 2 min)
python pipeline/ephemeris.py     # -> web/public/data/ephemeris.json
python pipeline/build_sites.py   # -> web/public/data/sites.json (with horizon masks)
python pipeline/charging.py --csv pipeline/equipot_results.csv  # -> charging + thermal layers and CSVs
python pipeline/dem_tiles.py     # -> web/public/data/dem (levels 0-5) + $MOON_DATA/dem_fine (levels 6-7), ~15-30 min
python pipeline/slope_tiles.py   # -> web/public/data/slope + $MOON_DATA/slope_fine (mean + max slope), ~15 min
python pipeline/sky_view.py      # -> web/public/data/sky + $MOON_DATA/sky_fine (needs dem_tiles first), ~2-3 h on 12 cores
```

`dem_tiles.py` reads the LOLA LDEM 118 m global map and writes 256 px geographic WebP tiles. Height is
encoded as a 16-bit value `R·256 + G`, in metres `= 0.5·value − 10000`, and `B = 255` marks valid pixels.
Run `python pipeline/dem_tiles.py --test` to encode a few tiles and report sizes without writing anything.

Set `MOON_DATA` to keep raw data somewhere other than `..\data`.

The radiation pipeline uses the raw LOLA LDEM 80S when available, otherwise the generated
`dem_south.png` overlay; it computes horizons on a 500 m polar grid and writes the two Cesium PNGs
plus their metadata under `web/public/radiation`.

The pipeline's charging, thermal and radiation rasters below (south pole, 4 km) are kept for the
CSV site summaries. The map layers now come from the global computation in the browser.

The charging pipeline samples the SPICE ephemeris every 12 hours by default, derives surface normals
from the LOLA DEM, and generates low-resolution mean-potential, minimum-potential, and below-threshold
heatmaps. It uses the raw DEM if available, otherwise the generated `dem_south.png` elevation overlay.
The current model uses a flat local horizon; terrain-horizon shadows are not included in these charging
maps. Adjust the temporal and spatial sampling with `--step-hours` and `--resolution-m`. The generated
site summary is `web/public/data/charging_sites.csv`.
The charging command also generates `thermal_mean`, `thermal_min`, and `thermal_max` overlays and
per-point `charging_points.csv` data. By default, the 1D regolith model runs at Artemis candidate
sites while other pixels use the module's equilibrium-temperature estimate; use `--thermal-mode all`
to run the slower model at every pixel. CSV columns `T_mean`, `T_min`, and `T_max` are in kelvin.
Spin-up defaults to one year of sampled epochs and can be overridden with `--n-spinup`.
With the supplied environment curves, the most negative modeled value is -80.2 V, so the default
fraction below -100 V is zero; use `--threshold-v -50` to map time below -50 V instead.

## Layer ghiaccio

Download `DLRE_PRP_SOUTH.TAB` and its matching `DLRE_PRP_SOUTH.LBL` from the
[NASA PDS Geosciences Node Diviner Polar Resource Products archive](https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_prp/),
the Diviner Polar Resource Product (PRP; Paige et al. 2010), and place both files in `pipeline/data/`.
The optional M3 surface-ice point file, if available, is `pipeline/data/li2018_south.csv`.

The ice layer uses the `lat` and `lon` point grid in `web/public/data/charging_points.csv`.
The PRP columns are indexed from zero (`tri_clat` 10, `tri_clon` 9, `temp_max` 13,
`ice_depth` 14); depth is in meters, `-999` means no stable ice and `-1` (surface-stable
ice, T max < ~101 K) is read as 0 m. The optional M3 file can be omitted.

Each grid point stands for its 4 km cell and is classified from the area fraction of the ~128 PRP
elements inside it: class 2 (cold trap) when at least 25% of the cell has T max < 110 K, class 1
when at least 50% has ice thermally stable within 0.5 m, class 3 for M3 detections. Class 1 is
thermal stability, not a detection, and covers about a third of the map, so by default the web
GeoJSON only contains classes 2 and 3; `--include-subsurface` adds class 1. The command writes
`mappa_ghiaccio.csv` (all points, with `cold_trap_frac` and `subsurface_frac`),
`mappa_ghiaccio.geojson`, and `mappa_ghiaccio.png`, plus `distanza_ghiaccio.csv` (distance to the
nearest cold trap, in kilometers):

```powershell
python pipeline/ice.py [--include-subsurface]
```

To regenerate the five-year timeline data through 2205, download only the SPICE kernels and create
year-aligned chunks (the browser loads only the chunks needed for the selected window):

```powershell
python pipeline/download.py --kernels-only
python pipeline/ephemeris.py --start 2026-01-01 --end 2206-01-01 --step-hours 2 --chunk-years 5
```

## Earth visibility layer

`pipeline/earth_visibility.py` computes the fraction of time the Earth disc is above the local
terrain horizon on the same 4 km grid as `charging_points.csv` (80S-90S). Horizons come from
`pipeline/lunar_horizon.py` over the LOLA polar DEM (`ldem_80s_80m.lbl` if present, otherwise the
`dem_south.png` overlay), extended to 70S with the shipped global DEM tiles; the Earth position is
the SPICE ephemeris in `web/public/data/ephemeris.json`, with site parallax. It writes the
`earth_visibility` overlay (+ `overlays/index.json` entry), `earth_visibility_points.csv` and
`earth_visibility_sites.csv` (`earth_vis_frac`, `earth_any_frac`, `max_blackout_days`). Inside 85S
it agrees with LOLA AVGVISIB_EARTH (r = 0.95, mean difference -0.02):

```powershell
python pipeline/earth_visibility.py    # ~2 min; --step-hours, --observer-height, --dem
```

## Layer lunar pits

`pipeline/pits.py` downloads the LROC lunar pit catalog (Wagner & Robinson 2021, 278 pits) to
`pipeline/data/LUNAR_PIT_LOCATIONS.CSV` and writes `web/public/data/pits.geojson`. Each pit gets the
LOLA surface height (and floor height = surface - depth) from the same global DEM tiles the app uses
for the 3D terrain (`web/public/data/dem`, or the finer `MOON_DATA/dem_fine` tiles if present), in
metres above the 1737.4 km sphere. `pipeline/lunar_pits.py` holds the pit model and prints a report
with plots of the main LROC Atlas pits. In the app, the "Lunar pits" layer draws them (on the LOLA
terrain when 3D elevation is on); clicking one analyses it as a site and shows its catalog data.

```powershell
python pipeline/pits.py           # --force to re-download the catalog
python pipeline/lunar_pits.py     # report + pipeline/data/lunar_pits.png
```

## Data sources

- LRO LOLA topography, slope, average illumination, Earth visibility and PSR maps: NASA PDS Geosciences Node (Mazarico et al. 2011; LOLA Science Team)
- Global elevation: LOLA LDEM 118 m (`Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014`)
- Regolith thermal model: Hayne et al. 2017, *JGR Planets* 122; surface charging: EQUIPOT results (`pipeline/equipot_results.csv`)
- Ephemerides: NASA NAIF SPICE (DE440, Moon PA/ME frames)
- Feature names: IAU / USGS Gazetteer of Planetary Nomenclature
- 3D Moon: Cesium Moon Terrain (Cesium ion) · fallback imagery: NASA Moon Trek (LRO WAC global, Kaguya TC ortho, LROC NAC polar and site mosaics; list built by `pipeline/trek_catalog.py`)
