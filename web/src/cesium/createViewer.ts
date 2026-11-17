import {
  Cartesian3,
  Cesium3DTileset,
  CustomShader,
  Color,
  DirectionalLight,
  Ellipsoid,
  GeographicTilingScheme,
  Globe,
  ImageryLayer,
  type ImageryLayerCollection,
  Ion,
  LightingModel,
  Math as CMath,
  Rectangle,
  ShadowMode,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import trekLayers from './trekLayers.json'
import { crispText, keepCreditsClear } from './screenPolish'

// All coordinates, cameras and terrain are on the Moon (must be set before creating the Viewer).
Ellipsoid.default = Ellipsoid.MOON

export type PhotoGroup = 'wac' | 'kaguya' | 'nacPolar' | 'nacSites'

export interface MoonScene {
  viewer: Viewer
  /** where heatmaps are draped: the Cesium Moon tileset or the fallback globe */
  overlays: ImageryLayerCollection
  basemap: 'ion' | 'trek'
  tileset?: Cesium3DTileset
  /** Moon Trek photo layers by group (trek basemap only), bottom of the imagery stack */
  photo: Record<PhotoGroup, ImageryLayer[]>
}

interface TrekLayer {
  id: string
  title: string
  kind: 'global' | 'regional'
  minLevel: number
  maxLevel: number
  ext: string
  bbox: [number, number, number, number]
}

const TREK = 'https://trek.nasa.gov/tiles/Moon/EQ'

function photoGroup(l: TrekLayer): PhotoGroup {
  if (l.id.startsWith('LRO_WAC')) return 'wac'
  if (l.id.startsWith('Kaguya')) return 'kaguya'
  return l.kind === 'global' ? 'nacPolar' : 'nacSites'
}

/**
 * NASA Moon Trek mosaics stacked as a level-of-detail pyramid (list built by pipeline/trek_catalog.py):
 *   LRO WAC global, ~100 m/px  ->  Kaguya TC global (+-60 deg), ~21 m/px  ->  LROC NAC polar caps,
 *   ~5 m/px  ->  ~50 LROC NAC site mosaics, 0.5-1.5 m/px.
 * Cesium only requests a tile when it is on screen at the needed resolution, and only inside each
 * layer's bounding box; below a layer's minLevel the layer underneath shows through. Missing data is
 * transparent in the PNG mosaics, so gaps fall back to the coarser layer automatically.
 */
function addTrekPhotoLayers(collection: ImageryLayerCollection): Record<PhotoGroup, ImageryLayer[]> {
  const tiling = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON })
  const groups: Record<PhotoGroup, ImageryLayer[]> = { wac: [], kaguya: [], nacPolar: [], nacSites: [] }
  for (const l of trekLayers as TrekLayer[]) {
    const provider = new UrlTemplateImageryProvider({
      url: `${TREK}/${l.id}/1.0.0/default/default028mm/{z}/{y}/{x}.${l.ext}`,
      tilingScheme: tiling,
      maximumLevel: l.maxLevel,
      rectangle: Rectangle.fromDegrees(...l.bbox),
      credit: `NASA Moon Trek · ${l.title}`,
    })
    const group = photoGroup(l)
    const layer = new ImageryLayer(provider, {
      // Zoom gating only where a coarser layer underneath is just as good from afar (Kaguya over
      // WAC, NAC site mosaics). The NAC polar caps are NOT gated: Moon Trek serves them from level 0,
      // and the WAC/Kaguya equirectangular mosaics smear radially near the poles, so gating them
      // made oblique polar views a patchwork (sharp NAC wedge close by, smeared WAC further out).
      minimumTerrainLevel: group === 'nacPolar' ? undefined : l.minLevel || undefined,
      // Kaguya TC is darker and flatter than the photometrically normalised WAC mosaic
      ...(group === 'kaguya' ? { brightness: 1.9, contrast: 1.25 } : {}),
      // the NAC polar AvgMosaic averages many low-Sun images and is much darker than WAC/Kaguya
      ...(group === 'nacPolar' ? { brightness: 1.6, contrast: 1.1, gamma: 0.85 } : {}),
    })
    collection.add(layer)
    groups[group].push(layer)
  }
  return groups
}

export async function createMoonScene(container: HTMLElement): Promise<MoonScene> {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined
  const assetId = Number(import.meta.env.VITE_CESIUM_MOON_ASSET_ID ?? 2684829)
  const wantIon = (import.meta.env.VITE_BASEMAP ?? 'ion') !== 'trek' && !!token
  if (token) Ion.defaultAccessToken = token

  const viewer = new Viewer(container, {
    globe: false,
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    skyAtmosphere: false,
    shadows: false,
    // the fast GPU where the browser lets the page choose (macOS, Linux; on Windows the browser /
    // OS setting decides, see lib/gpu.ts)
    contextOptions: { webgl: { powerPreference: 'high-performance' } },
    // render on demand (see renderOnDemand): an idle globe no longer redraws 60 times a second at
    // device-pixel resolution, which left less GPU and CPU for the heatmap computations
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  })
  renderOnDemand(viewer)
  crispText(viewer) // device-pixel rendering + supersampled labels
  keepCreditsClear(viewer) // Cesium ion credits bottom-left, sliding right of the left panel when needed
  const scene = viewer.scene
  // Cesium's default global-Z constraint becomes singular when orbiting directly over either pole.
  scene.camera.constrainedAxis = undefined
  const controls = scene.screenSpaceCameraController
  controls.inertiaSpin = 0.82
  controls.inertiaTranslate = 0.82
  controls.inertiaZoom = 0.75
  controls.maximumTiltAngle = Math.PI / 2
  // farthest zoom: the Moon and the Earth (up to ~406,000 km away) both still fit in the view, the
  // Earth within ~22 deg of the centre (clear of the side panels; the default view is 60 deg tall)
  controls.maximumZoomDistance = (406_000e3 + 6378e3) / Math.tan((22 * Math.PI) / 180)
  if (scene.sun) scene.sun.show = false
  if (scene.moon) scene.moon.show = false
  scene.backgroundColor = Color.BLACK
  // Overridden every time the app clock moves (see setSunDirection).
  scene.light = new DirectionalLight({ direction: new Cartesian3(1, 0, 0) })

  let result: MoonScene | undefined
  if (wantIon) {
    try {
      const tileset = await Cesium3DTileset.fromIonAssetId(assetId)
      tileset.shadows = ShadowMode.ENABLED
      scene.primitives.add(tileset)
      result = { viewer, overlays: tileset.imageryLayers, basemap: 'ion', tileset, photo: { wac: [], kaguya: [], nacPolar: [], nacSites: [] } }
    } catch (err) {
      console.warn('Cesium Moon tileset failed, falling back to Moon Trek globe:', err)
    }
  }
  if (!result) {
    // Fallback: smooth Moon ellipsoid + NASA imagery. Overlays work identically.
    const globe = new Globe(Ellipsoid.MOON)
    globe.baseColor = Color.fromCssColorString('#222')
    globe.enableLighting = false // see setSunLighting
    globe.showGroundAtmosphere = false
    // objects are hidden by the Moon's surface in front of them (the Sun / Earth behind the limb or
    // behind hills in the first-person view); Cesium's default draws them on top of the globe
    globe.depthTestAgainstTerrain = true
    // keep zooming until the deepest photo level is actually on screen
    globe.maximumScreenSpaceError = 1.5
    globe.tileCacheSize = 400
    scene.globe = globe
    const photo = addTrekPhotoLayers(globe.imageryLayers)
    result = { viewer, overlays: globe.imageryLayers, basemap: 'trek', photo }
  }

  // Initial camera is set by the app with viewFromEarth() once the ephemeris has loaded.
  return result
}

/**
 * Cesium itself redraws when the camera moves, while globe / imagery tiles are still loading and when
 * layers change. On top of that: input on the canvas keeps frames coming for a moment (hover
 * animations of the markers are CallbackProperties), the app calls scene.requestRender() after every
 * React render (App.tsx), and a once-a-second frame catches any other change made outside both.
 */
function renderOnDemand(viewer: Viewer) {
  const scene = viewer.scene
  let until = 0
  const kick = () => { until = performance.now() + 400; scene.requestRender() }
  for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown'] as const) {
    viewer.canvas.addEventListener(ev, kick, { passive: true })
  }
  scene.postRender.addEventListener(() => { if (performance.now() < until) scene.requestRender() })
  const heartbeat = setInterval(() => { if (!viewer.isDestroyed()) scene.requestRender(); else clearInterval(heartbeat) }, 1000)
}

/**
 * Look at the whole Moon from the direction of the Earth (positions in metres, Moon-fixed), i.e. the
 * disc as seen from Earth at that moment, libration included. The Moon is centred on screen, lunar
 * north up, and the camera sits just close enough for the full disc to fill ~85% of the view height.
 */
export function viewFromEarth(viewer: Viewer, earthPosM: [number, number, number], fill = 0.85, duration = 0) {
  const toEarth = Cartesian3.normalize(new Cartesian3(...earthPosM), new Cartesian3())
  const fovy = (viewer.camera.frustum as { fovy?: number }).fovy ?? CMath.toRadians(60)
  const halfAngle = Math.atan(fill * Math.tan(fovy / 2)) // angular radius the disc should have
  const dist = Ellipsoid.MOON.maximumRadius / Math.sin(halfAngle)
  const destination = Cartesian3.multiplyByScalar(toEarth, dist, new Cartesian3())
  const direction = Cartesian3.negate(toEarth, new Cartesian3())
  // lunar north (+Z) projected perpendicular to the view direction
  const z = Cartesian3.UNIT_Z
  const up = Cartesian3.normalize(
    Cartesian3.subtract(z, Cartesian3.multiplyByScalar(direction, Cartesian3.dot(z, direction), new Cartesian3()), new Cartesian3()),
    new Cartesian3(),
  )
  if (duration > 0) viewer.camera.flyTo({ destination, orientation: { direction, up }, duration })
  else viewer.camera.setView({ destination, orientation: { direction, up } })
}

export function flyToSite(viewer: Viewer, latDeg: number, lonDeg: number, rangeM = 60_000, duration = 2.5) {
  // Look at the site from the "north" side, tilted, like an approach view.
  const back = Math.min(rangeM * 0.9, 300_000) / 1737400
  const camLat = Math.max(-89.9, Math.min(89.9, latDeg + (latDeg < 0 ? 1 : -1) * CMath.toDegrees(back)))
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(lonDeg, camLat, rangeM),
    orientation: { heading: latDeg < 0 ? Math.PI : 0, pitch: CMath.toRadians(-40), roll: 0 },
    duration,
  })
}

/**
 * Realistic Sun lighting on/off. At the poles the Sun grazes the horizon, so realistic lighting
 * leaves most terrain black: great for the shadow demo, bad for reading heatmaps.
 */
export function setSunLighting(m: MoonScene, on: boolean, firstPerson = false) {
  if (m.tileset) m.tileset.customShader = on ? undefined : new CustomShader({ lightingModel: LightingModel.UNLIT })
  const globe = m.viewer.scene.globe
  if (globe) globe.enableLighting = on
  // shadow map: only for the 3D tileset. The first-person terrain traces its own shadows in its shader
  // (cesium/fpvTerrain.ts); a shadow map on that 150 km mesh shadowed it onto itself (black ground
  // under a high Sun), and the Moon Trek globe from orbit does not need one
  const shadows = on && !!m.tileset
  m.viewer.shadows = shadows
  if (globe) globe.shadows = shadows ? ShadowMode.ENABLED : ShadowMode.DISABLED
  if (shadows) {
    const sm = m.viewer.shadowMap
    // no atmosphere: shadows are almost black (Cesium's default leaves 30 % light), and with the Sun a
    // degree above the polar horizon they run for tens of km (default range: 5 km)
    sm.darkness = 0.04
    sm.maximumDistance = firstPerson ? 60_000 : 5_000 // the tileset seen from the ground: shadows run for km
    sm.size = 4096
    sm.softShadows = false
  }
  m.viewer.scene.requestRender()
}

/** Night exposure (like a dark-adapted eye or a long photo exposure): earthshine is ~1e-5..1e-4 of sunlight. */
export const NIGHT_EXPOSURE = 4000

/**
 * Earthshine on the Moon as a share of direct sunlight: (2/3) A (R_E / d)^2 Phi(alpha), the Earth as a
 * Lambert sphere of Bond albedo A = 0.30 at distance d, Phi = (sin a + (pi - a) cos a) / pi with a the
 * Sun-Earth-Moon phase angle (full Earth: ~5.5e-5, i.e. ~6 lux under 110,000 lux of sunlight).
 */
export function earthshineRatio(sunPosM: [number, number, number], earthPosM: [number, number, number]) {
  const [ex, ey, ez] = earthPosM
  const sx = sunPosM[0] - ex, sy = sunPosM[1] - ey, sz = sunPosM[2] - ez // Earth -> Sun
  const d = Math.hypot(ex, ey, ez), ds = Math.hypot(sx, sy, sz)
  const a = Math.acos(Math.max(-1, Math.min(1, -(sx * ex + sy * ey + sz * ez) / (ds * d)))) // Earth -> Moon is -earthPos
  const phi = (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI
  return (2 / 3) * 0.3 * (6371e3 / d) ** 2 * phi
}

/**
 * Earthshine reaching the camera as a share of direct sunlight: only the part of the Earth's disc
 * (radius ~0.95 deg) above the camera's horizon lights the ground (with the Earth set too, the lunar
 * night is dark: starlight only, kept as a 0.2 % floor so the ground stays faintly visible).
 */
export function earthshineAtCamera(viewer: Viewer, sunPosM: [number, number, number], earthPosM: [number, number, number]) {
  const c = viewer.camera.positionWC
  const up = Cartesian3.normalize(c, new Cartesian3())
  const toEarth = Cartesian3.normalize(Cartesian3.subtract(new Cartesian3(...earthPosM), c, new Cartesian3()), new Cartesian3())
  const el = Math.asin(Cartesian3.dot(up, toEarth)) * (180 / Math.PI)
  const above = Math.min(1, Math.max(0, (el + 0.95) / 1.9))
  return earthshineRatio(sunPosM, earthPosM) * Math.max(above, 0.002)
}

/** Light the scene by earthshine only (night side), at its physical share of sunlight x the camera exposure. */
export function setEarthLight(viewer: Viewer, sunPosM: [number, number, number], earthPosM: [number, number, number], exposure = NIGHT_EXPOSURE) {
  const dir = Cartesian3.normalize(new Cartesian3(-earthPosM[0], -earthPosM[1], -earthPosM[2]), new Cartesian3())
  const intensity = 2.0 * earthshineAtCamera(viewer, sunPosM, earthPosM) * exposure
  viewer.scene.light = new DirectionalLight({ direction: dir, color: new Color(0.86, 0.92, 1.0, 1), intensity })
}

/**
 * First-person camera exposure for a Sun whose disc is a share sunVisible (0..1) above the terrain
 * horizon, with earthshine (share of sunlight) as the darkest scene: 1 in full sunlight, NIGHT_EXPOSURE
 * once the Sun is dimmer than the earthshine, and in between sunVisible^-g, the power g joining the two
 * ends. Continuous, so sunrise / sunset fade instead of jumping x NIGHT_EXPOSURE (the jump, with the
 * Sun's glare raised by the same factor while a sliver of it still showed over the terrain, flashed).
 * The apparent brightness (exposure x sunVisible) falls smoothly from 1 to the night level, never above.
 */
export function fpvExposure(sunVisible: number, earthshine: number) {
  const night = Math.min(Math.max(earthshine, 1e-9), 0.5 / NIGHT_EXPOSURE)
  if (sunVisible <= night) return NIGHT_EXPOSURE
  const g = Math.log(NIGHT_EXPOSURE) / Math.log(1 / night)
  return Math.min(NIGHT_EXPOSURE, Math.max(1, sunVisible ** -g))
}

/**
 * Sunlight left by a solar eclipse (the Earth covering a share `cover` of the Sun's disc, as seen from
 * the camera): the uncovered part of the disc, plus sunlight refracted through the Earth's atmosphere
 * into its shadow - in totality ~1.5e-4 of full sunlight and copper red (Danjon L ~2-3; why the Moon
 * turns red in a lunar eclipse seen from Earth), negligible until the disc is almost covered.
 */
export function eclipseSunlight(cover: number) {
  const refracted = 1.5e-4 * cover ** 8
  return { level: 1 - cover + refracted, refracted }
}

/**
 * Point the scene light from the Sun (position in metres, Moon-fixed), at 2 x the camera exposure.
 * cover: share of the Sun's disc hidden by the Earth (first-person view; from orbit the eclipse overlay
 * in App darkens each point by its own coverage instead): the light dims with it and turns copper red
 * in totality (eclipseSunlight).
 */
export function setSunDirection(viewer: Viewer, sunPosM: [number, number, number], exposure = 1, cover = 0) {
  const dir = Cartesian3.normalize(new Cartesian3(-sunPosM[0], -sunPosM[1], -sunPosM[2]), new Cartesian3())
  const { level, refracted } = eclipseSunlight(cover)
  const red = refracted / Math.max(level, 1e-12) // share of the light that is refracted
  const color = new Color(1, 1 - 0.58 * red, 1 - 0.8 * red, 1) // white -> copper (1, 0.42, 0.2)
  viewer.scene.light = new DirectionalLight({ direction: dir, color, intensity: 2.0 * exposure * level })
}
