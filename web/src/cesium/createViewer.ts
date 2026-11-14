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
  ShadowMode,
  UrlTemplateImageryProvider,
  Viewer,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

// All coordinates, cameras and terrain are on the Moon (must be set before creating the Viewer).
Ellipsoid.default = Ellipsoid.MOON

export interface MoonScene {
  viewer: Viewer
  /** where heatmaps are draped: the Cesium Moon tileset or the fallback globe */
  overlays: ImageryLayerCollection
  basemap: 'ion' | 'trek'
  tileset?: Cesium3DTileset
}

/** NASA Moon Trek LRO WAC global mosaic (public WMTS, geographic 2x1 tiling, levels 0-10). */
function trekImagery() {
  return new UrlTemplateImageryProvider({
    url: 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    tilingScheme: new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON }),
    maximumLevel: 10,
    credit: 'NASA Moon Trek · LRO WAC mosaic',
  })
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
  })
  const scene = viewer.scene
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
      result = { viewer, overlays: tileset.imageryLayers, basemap: 'ion', tileset }
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
    scene.globe = globe
    globe.imageryLayers.add(new ImageryLayer(trekImagery()))
    result = { viewer, overlays: globe.imageryLayers, basemap: 'trek' }
  }

  flyToSite(viewer, -89.5, 0, 250_000, 0)
  return result
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
export function setSunLighting(m: MoonScene, on: boolean) {
  if (m.tileset) m.tileset.customShader = on ? undefined : new CustomShader({ lightingModel: LightingModel.UNLIT })
  if (m.viewer.scene.globe) m.viewer.scene.globe.enableLighting = on
  m.viewer.shadows = on && !!m.tileset
}

/** Point the scene light from the Sun (position in metres, Moon-fixed). */
export function setSunDirection(viewer: Viewer, sunPosM: [number, number, number]) {
  const dir = Cartesian3.normalize(new Cartesian3(-sunPosM[0], -sunPosM[1], -sunPosM[2]), new Cartesian3())
  viewer.scene.light = new DirectionalLight({ direction: dir, intensity: 2.0 })
}
