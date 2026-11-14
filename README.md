# ByteTheMoon: Lunar Landing Site Navigator

NASA Space Apps 2026. An interactive 3D Moon for comparing landing sites by **sunlight** (power) and **Earth visibility** (communications). It takes the real terrain horizon from NASA LOLA data into account.

- Streaming 3D Moon (Cesium Moon 3D Tiles), with a NASA Moon Trek fallback
- Heatmaps draped on the 3D surface: average sunlight, Earth visibility, permanent shadow, slope, elevation, and a live **landing-suitability score** with adjustable weights
- Time controls to step backward or forward by 1 hour, 6 hours, 12 hours, or 1 day, plus a slider to set the date; Moon lighting uses the Sun's real position (NASA SPICE)
- Landing-site panel expands to half the screen for easier browsing of analysis windows from 1 day to 1 year
- Per-site horizon panorama with Sun/Earth paths, a lit/comms timeline, time to sunset/Earthset, and the longest night
- Double-click anywhere at the south pole to analyse a custom site (horizon computed in the browser)

See [docs/PLAN.md](docs/PLAN.md) for the architecture, the team split and next steps.

## Run the web app

```powershell
cd web
copy .env.example .env.local   # then paste your Cesium ion token
npm install
npm run dev                   # http://localhost:5173
```

Without a token, or if Cesium ion fails, the app falls back to the NASA Moon Trek basemap. Overlays work the same either way.

## Rebuild the data (Python, optional)

The generated data in `web/public/data` is committed, so you only need this to change or add layers.

```powershell
pip install -r pipeline/requirements.txt
python pipeline/download.py      # ~500 MB into ..\data (outside the repo), resumable
python pipeline/overlays.py      # -> web/public/data/overlays
python pipeline/ephemeris.py     # -> web/public/data/ephemeris.json
python pipeline/build_sites.py   # -> web/public/data/sites.json (with horizon masks)
```

Set `MOON_DATA` to keep raw data somewhere other than `..\data`.

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
