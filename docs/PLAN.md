# ByteTheMoon: implementation plan

Space Apps 2026 challenge: **Lunar Landing Site Navigator**. The goal is a fast tool for mission planners, educators and the public. It compares landing sites and dates by sunlight (power) and Earth visibility (direct-to-Earth comms), and it takes the real terrain horizon into account.

## 1. Decisions

| Topic | Decision | Why |
|---|---|---|
| App type | Static web app (no backend) | Judges open a URL. All computation runs in the browser or offline in Python. |
| 3D map | CesiumJS 1.147 with Cesium Moon 3D Tiles. Falls back to a NASA Moon Trek globe | Streams detail level by level like Google Earth. The fallback means a Cesium ion problem never blocks the demo. |
| Heatmaps / overlays | Global layers are computed per tile in Web Workers (`GlobalHeatProvider` → `heatEngine.ts` → `heatWorker.ts`) from a LOLA elevation pyramid and the SPICE ephemeris, for the selected period. South of 85°S the 60 m LOLA maps take over (`FieldImageryProvider`). Everything is draped on the 3D surface | No backend, any place on the Moon, any date range. Changing the mission period recomputes the layers. The polar maps keep the best resolution where the landing sites are. |
| Numbers | LOLA data from NASA PDS plus NASA SPICE ephemeris | Accurate and citable. We do not compute heights from the Cesium mesh, because users report it sits ~2.5 km off LOLA. |
| Hosting | Vercel, or GitHub Pages / Cloudflare Pages. Point the free GoDaddy Registry domain at it | See §5. |

## 2. Architecture

```
            OFFLINE (Python, pipeline/)                              BROWSER (web/)
NASA PDS LOLA ──download.py──► ../data/raw ──overlays.py──► public/data/overlays/*.png + index.json ─┐
NAIF SPICE kernels ──────────► ../data/kernels ─ephemeris.py─► public/data/ephemeris.json ──────────┤
LOLA LDEM 118 m global ─────────────────── dem_tiles.py ─► public/data/dem (L0-5) + dem_fine (L6-7) ┤
LOLA LDEM 80S ───────────────────────── horizon_grid.py ─► public/data/horizons (1 km masks) ───────┤
IAU names + LOLA ─────────────────────────── build_sites.py ─► public/data/sites.json (+horizons) ──┤
                                                                                                    ▼
          Cesium Moon 3D Tiles (ion) or Moon Trek globe ◄── GlobalHeatProvider (global layers, heatWorker.ts)
                                                     ◄── FieldImageryProvider (60 m polar maps, live score)
          Mission-period sun/Earth averages ◄────────────── mission.ts + missionWorker.ts (1 km horizon grid)
          Sun light direction + Sun/Earth markers ◄──────── ephemeris.ts (interpolates SPICE vectors)
          Panorama, timeline, stats ◄───────────────────── analysis.ts (horizon mask × Sun/Earth tracks)
          Custom site (double-click) ─► computeHorizon() on the elevation layer, in the browser
```

### Data layers (south pole, 85°S–90°S unless noted)

| id | What | Source |
|---|---|---|
| `sun_avg` | Fraction of time the Sun is above the terrain horizon | LOLA AVGVISIB 60 m (Mazarico et al.) |
| `earth_avg` | Fraction of time the Earth is above the terrain horizon | LOLA AVGVISIB_EARTH 60 m |
| `psr` | Permanently shadowed regions | LOLA LPSR 60 m |
| `slope` | Surface slope | LOLA LDSM 40 m |
| `dem_south` | Elevation, 80°S–90°S, 240 m (also used for custom-site horizons) | LOLA LDEM 80 m |
| (derived) landing score | `(w_sun·sun + w_earth·earth) / (w_sun + w_earth)`, transparent where the max slope inside the landing footprint > limit (≤ 10°) | computed live |

Adding a layer means adding one entry to `LAYERS` in `pipeline/overlays.py` and running it again. The UI picks it up automatically.

### Global layers (whole Moon, computed in the browser for the selected period)

The selected period is the mission period when it is set, otherwise the loaded 5-year ephemeris window.

| Layer | Method (`web/src/lib/heatWorker.ts`) |
|---|---|
| Horizons | 32 azimuths × 40 steps to 200 km per point. Coarser DEM levels are used further away; curvature is included |
| Sunlight / Earth visibility | Fraction of the period with the Sun / Earth above the horizon |
| PSR | Never lit during the period |
| Slope, elevation | DEM pyramid |
| Charging | EQUIPOT (`pipeline/equipot_results.csv`, read directly), with the terrain horizon instead of a flat one |
| Regolith temperature | Hayne et al. 2017, implicit solver, 6 h steps. Periods over 1 year: 12 sampled lunations, each after a 1-lunation warm-up |
| Radiation dose | `(20.2·f_sky + 6.2·(1 − f_sky))` × GCR factor. **Approximate** factor: cosine 11-year solar cycle, minimum Dec 2019, −30 % at maximum |

DEM pyramid (`pipeline/dem_tiles.py`): 256 px geographic WebP tiles. Height = `0.5·(R·256 + G) − 10000` m, and `B = 255` marks valid pixels.
- Levels 0–5 (≥ 666 m/px, 134 MB) ship in `web/public/data/dem`.
- Levels 6–7 (333 / 167 m/px, 1.67 GB) go to `$MOON_DATA/dem_fine`. They are served at `/dem-fine` in dev, and in production from a CORS-open static bucket set in `VITE_DEM_FINE_URL`. Without it, the app falls back to 666 m.

South of 85°S the 60 m LOLA maps (sun, Earth, PSR, slope, elevation) override the computed values. Sun and Earth are rescaled to the period by `MissionEngine`. The global computation supersedes the pipeline's 4 km polar charging, thermal and radiation rasters.

## 3. What's done and what's next

Done (scaffold):
- [x] Cesium Moon viewer with a Moon Trek fallback, site markers, fly-to
- [x] Moon Trek fallback streams a photo LOD stack: WAC ~100 m/px global, Kaguya ~21 m/px (60S-60N), NAC ~5 m/px polar caps, ~50 NAC site mosaics at 0.5-1.5 m/px
- [x] Mission period (top-right inputs + draggable blue range under the timeline): every heatmap and the score cover the chosen window; when it is empty they cover the whole loaded 5-year window. South of 85°S the 60 m LOLA sun/Earth maps are rescaled by period/long-term, using a 1 km grid of horizon masks (pipeline/horizon_grid.py) and the SPICE ephemeris in Web Workers
- [x] Global heatmaps (sunlight, Earth, PSR, slope, elevation, charging, temperature, radiation) computed in Web Workers for the selected period. The workers have a tile scheduler, cancellation, worker restart and fetch timeouts, so toggling layers never stalls them
- [x] Interactive heatmaps (toggle, opacity, legend) and a live landing-score layer with weight sliders
- [x] Click to inspect all layer values; double-click to analyse a custom site (horizon computed in the browser)
- [x] Time slider and play: the Sun lights the scene from its real direction; Sun/Earth markers
- [x] Site panel: horizon panorama with Sun/Earth tracks, sunlit / Earth-visible timeline, % lit, % comms, time to sunset/Earthset, longest night
- [x] Python pipeline: download → overlays → ephemeris → sites with horizons

Next, in priority order:
1. **Compare mode** (the core ask of the brief): pick 2–4 sites and show their timelines stacked, plus a "slip launch by N days" control that shows the delta.
2. **Validation**: check Sun az/el against JPL Horizons for 2–3 sites (observer `coord@301`, API `https://ssd.jpl.nasa.gov/api/horizons.api`). Show "matches JPL to within X°" in an About panel.
3. **Shadows**: try `viewer.shadows = true` with the Sun light on the 3D tiles at close range (a strong demo moment). If the Cesium Moon tiles turn out to be unlit, test `tileset.customShader` with `LightingModel.PBR`.
4. **UI polish**: onboarding tooltip, presets "Compare Artemis regions", mobile layout, URL state (`?site=haworth&t=2027-06-01`) so links can be shared.
5. Deploy the fine DEM tiles (levels 6–7) to a bucket and set `VITE_DEM_FINE_URL`.
6. Replace the approximate GCR solar-cycle factor with measured neutron-monitor or CRaTER data.

## 4. Team split (adapt to team size)

| Person | Owns | Main files |
|---|---|---|
| A: frontend/3D | Cesium scene, overlays, shadows, camera, performance | `web/src/cesium/*`, `App.tsx` |
| B: science/Python | Ephemeris, JPL validation, new layers | `pipeline/*` |
| C: analysis/UI | Compare mode, charts, site panel | `web/src/lib/analysis.ts`, `web/src/components/*` |
| D: story | Demo video, slides, project page, About/credits panel | `docs/` |

Milestones: **Sat evening**: deployed URL with presets, heatmaps, panorama and timeline. **Sun midday**: compare mode and validation. **Sun afternoon**: freeze features, record the demo, write the project page.

## 5. Hosting: GoDaddy offer vs Vercel

They aren't really alternatives. The NASA/GoDaddy Registry offer is mainly a **free domain** (registered through Porkbun) with SSL, plus 1 year of basic hosting. Vercel is a **deployment platform**. Best of both:

1. Deploy `web/` on **Vercel**: import the GitHub repo, set *Root Directory* = `web`, and add the env vars from `.env.example`. Every push deploys, and every PR gets a preview URL the team can test.
2. Claim the free domain (e.g. `bytethemoon.space`, if it's non-premium) and add it in Vercel → Domains. Vercel then shows the DNS records to create at Porkbun.
3. Skip the bundled GoDaddy/Porkbun hosting. It has no git-push deploys and no preview URLs, and you'd upload files by hand.

The app is fully static (about 220 MB of data, including the 134 MB elevation pyramid; the 1.67 GB fine tiles live in a separate bucket), so Vercel Hobby, GitHub Pages or Cloudflare Pages all work. In Cesium ion, restrict the public token to the Moon asset and to your domain(s).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Cesium ion "Request has failed" (token, asset, network) | Automatic fallback to the Moon Trek globe. `VITE_BASEMAP=trek` forces it. |
| Venue Wi-Fi blocks NASA or Cesium | Data is bundled in the app. Test on a phone hotspot and keep a recorded demo. |
| Draping imagery on 3D Tiles is marked experimental in Cesium | It works the same on the fallback globe, so switch the basemap if needed. |
| Horizons cut short near DEM edges (sites near 80°S, ±180° longitude on the global DEM) | Documented limitation. Use the 75°S products for wider coverage. |
| Fine DEM bucket missing or blocked (CORS) | Heatmaps fall back to the shipped 666 m tiles; they are coarser but still work. |
| Radiation GCR factor is a model, not a measurement | Labelled approximate in the docs; see next step 6. |
