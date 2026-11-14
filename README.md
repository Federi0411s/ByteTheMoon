# ByteTheMoon: Lunar Landing Site Navigator

NASA Space Apps 2026. An interactive 3D Moon for comparing landing sites by **sunlight** (power) and **Earth visibility** (communications). It takes the real terrain horizon from NASA LOLA data into account.

- Streaming 3D Moon (Cesium Moon 3D Tiles), with a NASA Moon Trek fallback
- Heatmaps draped on the 3D surface: average sunlight, Earth visibility, permanent shadow, slope, elevation, and a live **landing-suitability score** with adjustable weights
- Time controls to step backward or forward by 1 minute, 30 minutes, 1 hour, 6 hours, 12 hours, or 1 day, plus a slider to set the date; Moon lighting uses the Sun's real position (NASA SPICE)
- Landing-site panel expands to half the screen for easier browsing of analysis windows from 1 day to 1 year
- Click a point on the Moon to inspect it, then save it with a custom name; saved sites persist in the browser and can be renamed or removed
- Per-site horizon panorama with Sun/Earth paths, a lit/comms timeline, time to sunset/Earthset, and the longest night
- Click anywhere on the Moon to analyse a custom site (horizon computed where elevation data is available)

See [docs/PLAN.md](docs/PLAN.md) for the architecture, the team split and next steps.

## Run the web app

```powershell
cd web
copy .env.example .env.local   # then paste your Cesium ion token
npm install
npm run dev                   # http://localhost:5173
```

Without a token, or if Cesium ion fails, the app falls back to the NASA Moon Trek basemap. Overlays work the same either way.

The optional radiation layer expects `radiation_overlay.json`, `radiation_classes.png`, and
`radiation_continuous.png` in `web/public/radiation`. Its controls appear in the map-layer panel when
the metadata JSON is available.

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
```

Set `MOON_DATA` to keep raw data somewhere other than `..\data`.

The radiation pipeline uses the raw LOLA LDEM 80S when available, otherwise the generated
`dem_south.png` overlay; it computes horizons on a 500 m polar grid and writes the two Cesium PNGs
plus their metadata under `web/public/radiation`.

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

To regenerate the five-year timeline data through 2205, download only the SPICE kernels and create
year-aligned chunks (the browser loads only the chunks needed for the selected window):

```powershell
python pipeline/download.py --kernels-only
python pipeline/ephemeris.py --start 2026-01-01 --end 2206-01-01 --step-hours 2 --chunk-years 5
```

## Data sources

- LRO LOLA topography, slope, average illumination, Earth visibility and PSR maps: NASA PDS Geosciences Node (Mazarico et al. 2011; LOLA Science Team)
- Ephemerides: NASA NAIF SPICE (DE440, Moon PA/ME frames)
- Feature names: IAU / USGS Gazetteer of Planetary Nomenclature
- 3D Moon: Cesium Moon Terrain (Cesium ion) · fallback imagery: NASA Moon Trek (LRO WAC global, Kaguya TC ortho, LROC NAC polar and site mosaics; list built by `pipeline/trek_catalog.py`)
