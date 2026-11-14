# ByteTheMoon: implementation plan

Space Apps 2026 challenge: **Lunar Landing Site Navigator**. The goal is a fast tool for mission planners, educators and the public. It compares landing sites and dates by sunlight (power) and Earth visibility (direct-to-Earth comms), and it takes the real terrain horizon into account.

## 1. Decisions

| Topic | Decision | Why |
|---|---|---|
| App type | Static web app (no backend) | Judges open a URL. All computation runs in the browser or offline in Python. |
| 3D map | CesiumJS 1.147 with Cesium Moon 3D Tiles. Falls back to a NASA Moon Trek globe | Streams detail level by level like Google Earth. The fallback means a Cesium ion problem never blocks the demo. |
| Heatmaps / overlays | Generated in the browser by `FieldImageryProvider` and draped on the 3D surface (`tileset.imageryLayers` or `globe.imageryLayers`) | One PNG per layer in its native polar projection. Tiles are reprojected live, so derived layers (the landing score with user weights) update instantly. |
| Numbers | LOLA data from NASA PDS plus NASA SPICE ephemeris | Accurate and citable. We do not compute heights from the Cesium mesh, because users report it sits ~2.5 km off LOLA. |
| Hosting | Vercel, or GitHub Pages / Cloudflare Pages. Point the free GoDaddy Registry domain at it | See §5. |

## 2. Architecture

```
            OFFLINE (Python, pipeline/)                              BROWSER (web/)
NASA PDS LOLA ──download.py──► ../data/raw ──overlays.py──► public/data/overlays/*.png + index.json ─┐
NAIF SPICE kernels ──────────► ../data/kernels ─ephemeris.py─► public/data/ephemeris.json ──────────┤
IAU names + LOLA ─────────────────────────── build_sites.py ─► public/data/sites.json (+horizons) ──┤
                                                                                                    ▼
          Cesium Moon 3D Tiles (ion) or Moon Trek globe ◄── FieldImageryProvider (heatmaps, live score)
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

## 3. What's done and what's next

Done (scaffold):
- [x] Cesium Moon viewer with a Moon Trek fallback, site markers, fly-to
- [x] Moon Trek fallback streams a photo LOD stack: WAC ~100 m/px global, Kaguya ~21 m/px (60S-60N), NAC ~5 m/px polar caps, ~50 NAC site mosaics at 0.5-1.5 m/px
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
5. Wider coverage: the 75°S illumination products (`download.py --all`), and global layers for Apollo-era sites.
6. Performance: move `computeHorizon` and tile generation into a Web Worker if the UI stutters.

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

The app is fully static (about 30–40 MB of data), so Vercel Hobby, GitHub Pages or Cloudflare Pages all work. In Cesium ion, restrict the public token to the Moon asset and to your domain(s).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Cesium ion "Request has failed" (token, asset, network) | Automatic fallback to the Moon Trek globe. `VITE_BASEMAP=trek` forces it. |
| Venue Wi-Fi blocks NASA or Cesium | Data is bundled in the app. Test on a phone hotspot and keep a recorded demo. |
| Draping imagery on 3D Tiles is marked experimental in Cesium | It works the same on the fallback globe, so switch the basemap if needed. |
| Horizons cut short near DEM edges (sites near 80°S, ±180° longitude on the global DEM) | Documented limitation. Use the 75°S products for wider coverage. |
