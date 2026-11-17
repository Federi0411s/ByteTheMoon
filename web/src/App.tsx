import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  Ellipsoid,
  CallbackPositionProperty,
  CallbackProperty,
  type Entity,
  ImageryLayer,
  LabelStyle,
  Math as CMath,
  Rectangle,
  ScreenSpaceEventHandler,
  PerspectiveFrustum,
  NearFarScalar,
  ScreenSpaceEventType,
  VerticalOrigin,
} from 'cesium'
import { createCelestial, type Celestial } from './cesium/celestial'
import { FpvHud } from './components/FpvHud'
import { EYE_HEIGHT_M, FPV_AZIMUTHS, buildFpvTerrain, fpvRings, type FpvTerrain } from './cesium/fpvTerrain'
import { NIGHT_EXPOSURE, eclipseSunlight, earthshineAtCamera, earthshineRatio, fpvExposure, setEarthLight } from './cesium/createViewer'
import { createMoonScene, flyToSite, setSunDirection, setSunLighting, viewFromEarth, type MoonScene } from './cesium/createViewer'
import { asProvider, FieldImageryProvider, levelForResolution } from './cesium/FieldImageryProvider'
import { PyramidImageryProvider } from './cesium/PyramidImageryProvider'
import { loadPyramid, type PyramidIndex, type PyramidName } from './lib/pyramid'
import { pyramidTiles } from './lib/pyramidTiles'
import { DemReliefProvider } from './cesium/DemReliefProvider'
import { DemTerrainProvider } from './cesium/DemTerrainProvider'
import { PitsLayer, pitInfoRows, type PitProps } from './cesium/PitsLayer'
import { RegionFiltersPanel } from './components/RegionFiltersPanel'
import { activeFilters, defaultFilters, loadIceDistance, loadPitDistance, regionValue, type IceDistance, type PitDistance, type RegionFilterState } from './lib/regionFilters'
import { WelcomeModal } from './components/WelcomeModal'
import { SettingsDialog } from './components/SettingsDialog'
import { welcomeHidden } from './lib/welcomeStorage'
import { Tutorial } from './components/Tutorial'
import { INSIGHTS_BUTTON } from './content/insights'
import { GlobalHeatProvider, type GlobalHeatOptions, type HeatValues } from './cesium/GlobalHeatProvider'
import { HeatEngine } from './lib/heatEngine'
import type { GpuInfo } from './lib/gpu'
import { sampleSiteEnv } from './lib/siteEnv'
import type { SiteEnv } from './components/EnvPanel'
import {
  computeTimeline,
  darkIntervalsFromTransitions,
  findSunTransitions,
  horizonAt,
  indexTimeline,
  longestFullNightHFromIntervals,
  nextSunTransition,
  summarizeIndexed,
  sunVisibleOver,
} from './lib/analysis'
import { eclipseCoverFrom, eclipsePossible, siteEclipses } from './lib/eclipse'
import { DATA_URL, loadBundle, type DataBundle, type Site } from './lib/data'
import { hillshade } from './lib/raster'
import { DEFAULT_FOOTPRINT, SLOPE_MAX_DEG, footprintAxes, footprintLabel } from './lib/requirements'
import { SlopeMaxTiles } from './lib/slopeMax'
import {
  earthPosition,
  ephemerisRange,
  EPHEMERIS_LAST_SELECTABLE_YEAR,
  EPHEMERIS_START_YEAR,
  EPHEMERIS_WINDOW_YEARS,
  loadEphemerisRange,
  loadEphemerisWindow,
  sunPosition,
} from './lib/ephemeris'
import { loadRadiationMetadata, radiationDose, radiationLayerMeta, type RadiationOverlayMetadata } from './lib/radiation'
import { BasemapPanel, type BasemapState } from './components/BasemapPanel'
import { LayerPanel, type LayerState, type ReachConfig, type ScoreConfig } from './components/LayerPanel'
import { SitePanel } from './components/SitePanel'
import { compareSavedSites } from './lib/savedSiteComparison'
import { dsnAt, dsnTimeline } from './lib/dsn'
import { assessHuman } from './lib/human'
import { siteThermalSeries } from './lib/regolith'
import { combine, scoreLandingCell, scoreRadiation, scoreSlope, scoreSunlight, scoreTelecom, scoreTemperature } from './lib/landingScore'
import { DEFAULT_PANEL, powerAt, powerTimeline, summarizePower, type PanelConfig } from './lib/power'
import { TimeBar } from './components/TimeBar'
import { MissionPanel, type Mission } from './components/MissionPanel'
import { TechnicalReportDialog } from './components/TechnicalReportDialog'
import type { ReportFilterImage, ReportOverlay } from './lib/technicalReport'
import { copyAdvancedSettings, DEFAULT_ADVANCED_SETTINGS, DEFAULT_DISPLAY_SETTINGS, type AdvancedSettings, type DisplaySettings } from './lib/advancedSettings'
import { asReachProvider, ReachImageryProvider } from './cesium/ReachImageryProvider'
import { ReachEngine, type ReachResult } from './lib/reach'
import { reachAreaKm2, SLOPE_QUANTUM } from './lib/reachGrid'

const DAY = 86400_000
const CSS_PIXELS_PER_CM = 96 / 2.54
const DEFAULT_TIME_START = Date.UTC(EPHEMERIS_START_YEAR, 0, 1)
const DEFAULT_TIME_END = Date.UTC(EPHEMERIS_START_YEAR + EPHEMERIS_WINDOW_YEARS, 0, 1)
const CALENDAR_RANGE: [number, number] = [
  DEFAULT_TIME_START,
  Date.UTC(EPHEMERIS_LAST_SELECTABLE_YEAR, 11, 31, 23, 59),
]
const D2R = Math.PI / 180
const MOON_RADIUS_M = 1737400
const FOCUS_RADIUS_M = 15_000 // refined heatmaps around the selected site
const SCORE_RADIUS_KM = 500 // default radius of the landing-suitability map around the selected site (Settings)
const RELIEF_EDGE_RAD = 80 * D2R // the relief basemap (LOLA LDEM 80S) ends here
const RELIEF_FADE_RAD = 1 * D2R
const SAVED_SITES_KEY = 'bytethemoon.saved-sites'
/**
 * Every map layer is drawn by the global engine, the poles included: computed for the selected period
 * (lib/heatWorker.ts) or, for time-independent layers, read from precomputed tile pyramids. The old
 * polar rasters (LOLA 60 m long-term maps, 4 km pipeline products) are no longer drawn.
 *  - thermal: needs the regolith temperature model (only run while such a layer is shown).
 *  - range: display range when global (the polar-only ranges would saturate at the equator).
 */
/**
 * Radiation (GCR + albedo), same model as pipeline/lunar_radiation.py, computed everywhere from the
 * terrain horizons: D = PRIMARY * f_sky + ALBEDO * (1 - f_sky), f_sky = mean(1 - sin H) / 2, scaled by
 * the solar-cycle GCR factor of the selected period (lib/heatEngine.gcrFactor; 1 = 2019 minimum).
 */
const RAD_CONTINUOUS_RANGE: [number, number] = [8, 14.5] // covers solar minimum to maximum
/** class thresholds from the overlay legend ("<= 12.0", "<= 12.8", "> 12.8"); pipeline defaults otherwise */
function radiationThresholds(m: RadiationOverlayMetadata): [number, number] {
  const nums = m.classLegend.map((c) => Number(/([\d.]+)/.exec(c.label)?.[1])).filter(Number.isFinite)
  return nums.length >= 2 ? [nums[0], nums[1]] : [12.0, 12.8]
}
/**
 * Radiation classes = terrain shielding. The legend thresholds were set at the 2019 solar minimum
 * (open flat terrain: 13.2 uGy/h), so they are scaled by the period's solar-cycle factor: the classes
 * keep meaning "well shielded / partly shielded / open terrain" whatever the period (with fixed
 * thresholds the whole Moon flipped class with the solar cycle). Returns the period's thresholds.
 */
function radiationClassThresholds(m: RadiationOverlayMetadata, gcr: number): [number, number] {
  const [a, b] = radiationThresholds(m)
  return [a * gcr, b * gcr]
}
const RAD_CLASS_NAMES = ['well shielded', 'partly shielded', 'open terrain']

const GLOBAL_LAYERS: Record<string, {
  value: (v: HeatValues) => number
  thermal?: boolean
  range?: [number, number]
  method: string
  /** replaces the bundle title when the layer is drawn globally */
  title?: string
  /** time-independent: drawn from a precomputed tile pyramid (lib/pyramid.ts) when it exists */
  pyramid?: { name: PyramidName; channel?: 0 | 1; method: string }
}> = {
  // time-dependent layers: computed for the selected period everywhere, the pole included
  sun_avg: { value: (v) => v.sun, method: 'terrain horizons + SPICE Sun' },
  earth_avg: { value: (v) => v.earth, method: 'terrain horizons + SPICE Earth' },
  earth_visibility: { value: (v) => v.earth, title: 'Earth visibility (terrain horizon)', method: 'terrain horizons + SPICE Earth' },
  // shadowed through the whole selected period (LOLA's PSR map is "never lit", long-term)
  psr: { value: (v) => (v.sun < 0.002 ? 1 : NaN), method: 'never lit during the selected period' },
  slope: {
    value: (v) => v.slope, method: 'LOLA global DEM gradient',
    pyramid: { name: 'slope', channel: 0, method: 'precomputed mean slope of the LOLA 118 m DEM' },
  },
  dem_south: {
    value: (v) => v.elev, range: [-9000, 10000], method: 'LOLA global DEM',
    pyramid: { name: 'dem', method: 'LOLA 118 m global DEM tiles (167 m)' },
  },
  charging_mean: { value: (v) => v.cMean, method: 'EQUIPOT model + terrain horizon' },
  charging_min: { value: (v) => v.cMin, method: 'EQUIPOT model + terrain horizon' },
  charging_frac_below: { value: (v) => v.cBelow, method: 'EQUIPOT model + terrain horizon' },
  thermal_mean: { value: (v) => v.tMean, thermal: true, range: [40, 260], method: 'Hayne 2017 regolith model, last year of the window' },
  thermal_min: { value: (v) => v.tMin, thermal: true, range: [20, 130], method: 'Hayne 2017 regolith model, last year of the window' },
  thermal_max: { value: (v) => v.tMax, thermal: true, range: [80, 400], method: 'Hayne 2017 regolith model, last year of the window' },
}
/** Remove an imagery layer; computed (GlobalHeatProvider) layers also drop their queued tile requests. */
function removeLayer(scene: MoonScene, layer: ImageryLayer) {
  ;(layer.imageryProvider as unknown as { dispose?: () => void }).dispose?.()
  scene.overlays.remove(layer, true)
}

/** landmark tags: fully shown up to ~32,000 km from the camera, gone by ~50,000 km */
const LANDMARK_FADE = new NearFarScalar(3.2e7, 1, 5.0e7, 0)

const FUTURE_SITE_GROUPS = new Set([
  'Artemis III candidate regions',
  'South pole (best-lit spot near feature)',
])

function formatScaleDistance(meters: number) {
  if (meters >= 1000) return `${Number((meters / 1000).toPrecision(2))} km`
  if (meters >= 1) return `${Number(meters.toPrecision(2))} m`
  if (meters >= 0.01) return `${Number((meters * 100).toPrecision(2))} cm`
  return `${Number((meters * 1000).toPrecision(2))} mm`
}

function fineDemBaseUrl() {
  const env = import.meta.env.VITE_DEM_FINE_URL as string | undefined
  const url = env === '' || env === 'none' ? null : env ?? (import.meta.env.DEV ? '/dem-fine' : null)
  return url ? new URL(url, location.href).href.replace(/\/$/, '') : null
}

interface IceGeoJsonPoint {
  lat: number
  lon: number
  color: Color
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseIceGeoJson(value: unknown): IceGeoJsonPoint[] {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new Error('Invalid ice GeoJSON FeatureCollection')
  }

  return value.features.map((feature: unknown, index: number) => {
    if (!isRecord(feature) || !isRecord(feature.geometry) || !isRecord(feature.properties) ||
        feature.geometry.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) {
      throw new Error(`Invalid ice GeoJSON feature at index ${index}`)
    }

    const [lon, lat] = feature.geometry.coordinates
    const colorValue = feature.properties.color
    if (typeof lon !== 'number' || !Number.isFinite(lon) ||
        typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        typeof colorValue !== 'string') {
      throw new Error(`Invalid coordinates or color in ice GeoJSON feature ${index}`)
    }
    const color = Color.fromCssColorString(colorValue)
    if (!color) throw new Error(`Invalid color in ice GeoJSON feature ${index}`)
    return { lat, lon, color }
  })
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<MoonScene | null>(null)
  const layerRefs = useRef<Record<string, ImageryLayer>>({})
  const radiationLayerRef = useRef<ImageryLayer | null>(null)
  const radiationOpacityRef = useRef(0.7)
  const iceEntitiesRef = useRef<Entity[]>([])
  const iceLoadedRef = useRef(false)
  const pitsRef = useRef<PitsLayer | null>(null)
  const markers = useRef<{ custom?: Entity; sites: Entity[] }>({ sites: [] })
  const celestialRef = useRef<Celestial | undefined>(undefined)
  // first-person view: markers are depth-tested against the terrain (hidden behind it); from orbit they stay on top
  const terrainViewRef = useRef(false)
  // from orbit: never depth-tested (on the reference sphere, the terrain cut them in half) and hidden on the
  // Moon's far side instead; first person: depth-tested against the terrain mesh, so hills hide them
  const markerDepthTest = useMemo(() => new CallbackProperty(() => (terrainViewRef.current ? 0 : Number.POSITIVE_INFINITY), false), [])
  /** the point faces the camera (in front of the Moon's limb) */
  const onNearSide = useCallback((latDeg: number, lonDeg: number) => {
    const c = sceneRef.current?.viewer.camera.positionWC
    if (!c) return true
    const la = latDeg * D2R, lo = lonDeg * D2R, cl = Math.cos(la)
    return cl * Math.cos(lo) * c.x + cl * Math.sin(lo) * c.y + Math.sin(la) * c.z > MOON_RADIUS_M
  }, [])
  // first person: not the site you stand on, and only the landmarks on the local terrain mesh (150 km);
  // the rest are beyond the horizon and, with the globe hidden, nothing else would hide them
  const markerInView = useCallback((s: { id?: string; lat: number; lon: number }) => {
    if (!terrainViewRef.current) return onNearSide(s.lat, s.lon)
    if (s.id !== undefined && s.id === terrainSiteId.current) return false
    const fpv = fpvTerrainRef.current
    return !fpv || Number.isFinite(fpv.heightAt(s.lat, s.lon))
  }, [onNearSide])
  // site marker -> site (click to select) and the marker under the mouse (grows a little, animated)
  const siteByMarker = useRef(new Map<Entity, Site>())
  // latest selection actions for the map click handler (registered once per scene)
  const clickActions = useRef<{ selectSite: (s: Site) => void; clearSelection: () => void; hasSelection: boolean }>({ selectSite: () => {}, clearSelection: () => {}, hasSelection: false })
  const hover = useRef<{ entity?: Entity; since: number; prev?: Entity; prevSince: number }>({ since: 0, prevSince: 0 })

  const [ready, setReady] = useState(false)
  const [bundle, setBundle] = useState<DataBundle | null>(null)
  const [savedSitesState, setSavedSitesState] = useState<{ sites: Site[]; error?: string }>(() => {
    try {
      localStorage.removeItem(SAVED_SITES_KEY)
      return { sites: [] }
    } catch (error) {
      console.error('Could not clear saved landing sites from the previous app session.', error)
      return { sites: [], error: 'Saved landing sites from the previous session could not be cleared from this browser.' }
    }
  })
  const { sites: savedSites, error: savedSitesError } = savedSitesState
  const [ephemeris, setEphemeris] = useState<DataBundle['ephemeris']>(null)
  const [timeRange, setTimeRange] = useState<[number, number]>([DEFAULT_TIME_START, DEFAULT_TIME_END])
  const [ephemerisBusy, setEphemerisBusy] = useState(false)
  const [ephemerisError, setEphemerisError] = useState<string>()
  const [layerState, setLayerState] = useState<Record<string, LayerState>>({})
  const [score, setScore] = useState<ScoreConfig>({ enabled: false, maxSlope: 8, footprint: DEFAULT_FOOTPRINT, radiusKm: SCORE_RADIUS_KM, opacity: 0.7 })
  const [advancedSettings, setAdvancedSettings] = useState<AdvancedSettings>(() => copyAdvancedSettings(DEFAULT_ADVANCED_SETTINGS))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panel, setPanel] = useState<PanelConfig>(DEFAULT_PANEL) // solar arrays
  const [t, setT] = useState(() => Math.floor(Date.now() / 1000) * 1000) // current UTC time, whole seconds (clamped to the ephemeris on load)
  const [playing, setPlaying] = useState(false)
  const [lighting, setLighting] = useState(false)
  const [stepMs, setStepMs] = useState(3600_000)
  const [selected, setSelected] = useState<Site>()
  const [showSiteMarkers, setShowSiteMarkers] = useState(true)
  const [sitePanelExpanded, setSitePanelExpanded] = useState(false)
  const [inspect, setInspect] = useState<{ lat: number; lon: number; values: { title: string; value: string }[] }>()
  const [radiationMetadata, setRadiationMetadata] = useState<RadiationOverlayMetadata | null>(null)
  // precomputed time-independent layers (pipeline/dem_tiles.py, slope_tiles.py, sky_view.py)
  const [pyramids, setPyramids] = useState<Partial<Record<PyramidName, PyramidIndex>>>({})
  // Settings: movement slope limit and distance (reachable-area layer) and DEM-guided upsampling of
  // the computed heatmaps (GlobalHeatProvider `guide`; off = plain bilinear)
  const [display, setDisplay] = useState<DisplaySettings>(() => ({ ...DEFAULT_DISPLAY_SETTINGS }))
  const guided = display.guided
  // the graphics card the heatmap workers compute on (lib/gpu.ts), reported once they start
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null | undefined>(undefined)
  const guide = useMemo(() => (guided && pyramids.dem ? pyramidTiles(pyramids.dem) : undefined), [guided, pyramids])
  useEffect(() => {
    let cancelled = false
    Promise.all((['dem', 'slope', 'sky'] as const).map(async (n) => [n, await loadPyramid(n)] as const)).then((list) => {
      if (cancelled) return
      const out: Partial<Record<PyramidName, PyramidIndex>> = {}
      for (const [n, ix] of list) if (ix) out[n] = ix
      setPyramids(out)
    })
    return () => { cancelled = true }
  }, [])
  const [radiationLoading, setRadiationLoading] = useState(true)
  const [radiationError, setRadiationError] = useState<string>()
  const [radiationVisible, setRadiationVisible] = useState(false)
  const [radiationOpacity, setRadiationOpacity] = useState(0.7)
  const [radiationMode, setRadiationMode] = useState<'classes' | 'continuous'>('classes')
  const [terrainViewActive, setTerrainViewActive] = useState(false)
  /** first person at night: earthshine share of sunlight (null by day / from orbit) */
  const [nightView, setNightView] = useState<number | null>(null)
  /** first-person HUD: camera heading / elevation and field of view (deg) */
  const [hud, setHud] = useState<{ heading: number; pitch: number; fovx: number; fovy: number } | null>(null)
  // bumped when the camera stops in the terrain view: the day / night test depends on where it is
  const [terrainCamTick, setTerrainCamTick] = useState(0)
  useEffect(() => {
    const viewer = sceneRef.current?.viewer
    if (!terrainViewActive || !viewer) return
    return viewer.camera.moveEnd.addEventListener(() => setTerrainCamTick((n) => n + 1))
  }, [terrainViewActive])
  useEffect(() => { terrainViewRef.current = terrainViewActive; sceneRef.current?.viewer.scene.requestRender() }, [terrainViewActive])
  const [terrainViewLoading, setTerrainViewLoading] = useState(false)
  const [terrainViewError, setTerrainViewError] = useState<string>()
  const [reportOpen, setReportOpen] = useState(false)
  const [reportFormat, setReportFormat] = useState<'pdf' | 'csv'>('pdf')
  const ephemerisRequest = useRef(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const terrainCamera = useRef<{ position: Cartesian3; direction: Cartesian3; up: Cartesian3 } | null>(null)
  const terrainSiteId = useRef<string | undefined>(undefined)
  const terrainRequest = useRef(0)
  const fpvTerrainRef = useRef<FpvTerrain | null>(null)
  // first-person ground texture (Settings): orbital photo + procedural detail, or the procedural surrogate only
  const fpvPhoto = display.fpvGround === 'photo'
  const fpvPhotoRef = useRef(fpvPhoto)
  useEffect(() => {
    fpvPhotoRef.current = fpvPhoto
    fpvTerrainRef.current?.setPhoto(fpvPhoto)
  }, [fpvPhoto])
  const lightingRef = useRef(false)
  const restoreElevationOnExit = useRef(false)
  // the first-person view opens with realistic Sun lighting; the map gets its own setting back on exit
  const lightingBeforeFpv = useRef<boolean | null>(null)
  const [iceVisible, setIceVisible] = useState(false)
  const [iceError, setIceError] = useState<string>()
  const [pitsVisible, setPitsVisible] = useState(false)
  const [pitsError, setPitsError] = useState<string>()
  // region filters: highlight the points that meet every ticked criterion (lib/regionFilters.ts)
  const [regionFilters, setRegionFilters] = useState<RegionFilterState>(() => defaultFilters(5 * 8766))
  const regionFilterPeriodHours = useRef(5 * 8766)
  const [iceDistance, setIceDistance] = useState<IceDistance | null>(null)
  const [pitDistance, setPitDistance] = useState<PitDistance | null>(null)
  const [filterDataError, setFilterDataError] = useState<string>()
  // welcome screen / tutorial ("Insights"); the welcome opens on start unless the user hid it
  const [insights, setInsights] = useState<'welcome' | 'tutorial' | null>(() => (welcomeHidden() ? null : 'welcome'))

  radiationOpacityRef.current = radiationOpacity
  const [basemapState, setBasemapState] = useState<BasemapState>({ kaguya: true, nacPolar: true, nacSites: true, elevation: false, relief: true })
  const [viewResM, setViewResM] = useState<number>()
  /** camera height above the terrain below it (m), shown next to the scale */
  const [cameraAltM, setCameraAltM] = useState<number>()
  const allSites = useMemo(() => [...(bundle?.sites ?? []), ...savedSites], [bundle, savedSites])
  const [mission, setMission] = useState<Mission>({})
  // whole-Moon heatmaps computed on the fly from the global elevation tiles (null: tiles not generated)
  const [heat, setHeat] = useState<HeatEngine | null>(null)
  const [heatVersion, setHeatVersion] = useState(0)
  /** temperature range + radiation dose at the selected site, tagged with what it was computed for */
  const [siteEnv, setSiteEnv] = useState<{ key: string; env: SiteEnv | null }>()
  const heatRef = useRef<HeatEngine | null>(null)
  heatRef.current = heat

  const stopTerrainView = useCallback((restoreCamera: boolean) => {
    terrainRequest.current++
    const pose = terrainCamera.current
    const viewer = sceneRef.current?.viewer
    viewer?.camera.cancelFlight()
    if (restoreCamera && pose && viewer) {
      viewer.camera.flyTo({
        destination: pose.position,
        orientation: { direction: pose.direction, up: pose.up },
        duration: 1.2,
      })
    }
    terrainCamera.current = null
    terrainSiteId.current = undefined
    fpvTerrainRef.current?.destroy()
    fpvTerrainRef.current = null
    const globe = sceneRef.current?.viewer.scene.globe
    if (globe) globe.show = true
    setTerrainViewActive(false)
    setTerrainViewLoading(false)
    setTerrainViewError(undefined)
    if (lightingBeforeFpv.current !== null) {
      setLighting(lightingBeforeFpv.current)
      lightingBeforeFpv.current = null
    }
    if (restoreElevationOnExit.current) {
      setBasemapState((state) => ({ ...state, elevation: false }))
      restoreElevationOnExit.current = false
    }
  }, [])
  const closeReport = useCallback(() => setReportOpen(false), [])
  const captureMapForReport = useCallback(async (site: Site, overlays: ReportOverlay[]): Promise<ReportFilterImage[]> => {
    const moonScene = sceneRef.current
    const viewer = moonScene?.viewer
    if (!viewer || viewer.isDestroyed()) throw new Error('The lunar map is not available.')
    const scene = viewer.scene
    if (!overlays.length) return []

    const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const photoLayers = new Set(Object.values(moonScene.photo).flat())
    const layerStates = Array.from({ length: moonScene.overlays.length }, (_, index) => {
      const layer = moonScene.overlays.get(index)
      return { layer, show: layer.show, alpha: layer.alpha }
    })
    const iceVisibility = new Map(iceEntitiesRef.current.map((entity) => [entity, entity.show]))
    const cameraPose = {
      position: Cartesian3.clone(viewer.camera.positionWC, new Cartesian3()),
      direction: Cartesian3.clone(viewer.camera.directionWC, new Cartesian3()),
      up: Cartesian3.clone(viewer.camera.upWC, new Cartesian3()),
    }

    const waitForIce = async () => {
      const deadline = Date.now() + 10_000
      while (!iceLoadedRef.current && Date.now() < deadline) await delay(100)
      if (iceError) throw new Error(iceError)
      if (!iceLoadedRef.current || !iceEntitiesRef.current.length) {
        throw new Error('The water-ice layer is not ready to capture yet.')
      }
    }

    const waitForMap = async () => {
      const tileset = moonScene.tileset
      if (!scene.globe && !tileset) {
        await delay(1_500)
      } else {
        const startedAt = Date.now()
        const deadline = startedAt + 2_500
        let stableFrames = 0
        while (Date.now() < deadline && (stableFrames < 3 || Date.now() - startedAt < 900)) {
          scene.requestRender()
          await nextFrame()
          const tilesLoaded = scene.globe ? scene.globe.tilesLoaded : tileset?.tilesLoaded ?? true
          if (tilesLoaded) stableFrames++
          else stableFrames = 0
          if (stableFrames < 3 || Date.now() - startedAt < 900) await delay(100)
        }
        await delay(scene.globe ? 250 : 800)
      }
      scene.render()
      await nextFrame()
    }

    const captureCenter = () => {
      const source = scene.canvas
      const side = Math.floor(Math.min(source.width, source.height))
      if (!side) throw new Error('The map view has no rendered image to capture.')
      const outputSide = Math.min(side, 1_200)
      const canvas = document.createElement('canvas')
      canvas.width = outputSide
      canvas.height = outputSide
      const context = canvas.getContext('2d')
      if (!context) throw new Error('A temporary canvas could not be created for the map image.')
      context.drawImage(
        source,
        Math.floor((source.width - side) / 2),
        Math.floor((source.height - side) / 2),
        side,
        side,
        0,
        0,
        outputSide,
        outputSide,
      )
      return canvas.toDataURL('image/jpeg', 0.9)
    }

    try {
      if (overlays.some((overlay) => overlay.id === '__ice')) await waitForIce()
      for (const entity of iceEntitiesRef.current) {
        if (!iceVisibility.has(entity)) iceVisibility.set(entity, entity.show)
      }
      for (const layerState of layerStates) {
        if (!photoLayers.has(layerState.layer)) layerState.layer.show = false
      }
      iceEntitiesRef.current.forEach((entity) => { entity.show = false })

      const surface = Cartesian3.fromDegrees(site.lon, site.lat, site.heightM ?? 0, Ellipsoid.MOON)
      const normal = Ellipsoid.MOON.geodeticSurfaceNormal(surface, new Cartesian3())
      const latitude = site.lat * D2R
      const longitude = site.lon * D2R
      const north = new Cartesian3(
        -Math.sin(latitude) * Math.cos(longitude),
        -Math.sin(latitude) * Math.sin(longitude),
        Math.cos(latitude),
      )
      const destination = Cartesian3.add(
        surface,
        Cartesian3.multiplyByScalar(normal, 8_000, new Cartesian3()),
        new Cartesian3(),
      )
      viewer.camera.setView({
        destination,
        orientation: { direction: Cartesian3.negate(normal, new Cartesian3()), up: north },
      })

      const images: ReportFilterImage[] = []
      for (const overlay of overlays) {
        if (overlay.id === '__ice') {
          iceEntitiesRef.current.forEach((entity) => { entity.show = true })
        } else {
          const layer = overlay.id === '__radiation'
            ? radiationLayerRef.current
            : layerRefs.current[overlay.id]
          if (!layer || !moonScene.overlays.contains(layer)) {
            throw new Error(`The active filter “${overlay.title}” is not ready to capture yet.`)
          }
          layer.show = true
          layer.alpha = overlay.opacity
        }
        await waitForMap()
        images.push({ ...overlay, image: captureCenter() })
        if (overlay.id === '__ice') iceEntitiesRef.current.forEach((entity) => { entity.show = false })
        else {
          const layer = overlay.id === '__radiation' ? radiationLayerRef.current : layerRefs.current[overlay.id]
          if (layer) layer.show = false
        }
      }
      return images
    } finally {
      for (const layerState of layerStates) {
        layerState.layer.show = layerState.show
        layerState.layer.alpha = layerState.alpha
      }
      for (const entity of iceEntitiesRef.current) {
        if (iceVisibility.has(entity)) entity.show = iceVisibility.get(entity) ?? true
      }
      viewer.camera.setView({
        destination: cameraPose.position,
        orientation: { direction: cameraPose.direction, up: cameraPose.up },
      })
      scene.requestRender()
      scene.render()
    }
  }, [iceError])

  const toggleTerrainView = useCallback(async () => {
    if (terrainCamera.current) {
      stopTerrainView(true)
      return
    }
    const site = selectedRef.current
    const scene = sceneRef.current
    if (!site || !scene) return

    const viewer = scene.viewer
    viewer.camera.cancelFlight()
    terrainCamera.current = {
      position: Cartesian3.clone(viewer.camera.positionWC, new Cartesian3()),
      direction: Cartesian3.clone(viewer.camera.directionWC, new Cartesian3()),
      up: Cartesian3.clone(viewer.camera.upWC, new Cartesian3()),
    }
    terrainSiteId.current = site.id
    const requestId = ++terrainRequest.current
    setTerrainViewLoading(true)
    setTerrainViewError(undefined)

    try {
      // one terrain mesh around the site from the same samples as the computed horizon (cesium/fpvTerrain.ts)
      const engine = heatRef.current
      if (!engine) throw new Error('Elevation data is unavailable (no elevation tiles).')
      const rings = fpvRings()
      const field = await engine.heightField(site.lat, site.lon, FPV_AZIMUTHS, rings)
      if (requestId !== terrainRequest.current || selectedRef.current?.id !== site.id || sceneRef.current !== scene) return
      if (!field || !Number.isFinite(field.heights[0])) throw new Error('Elevation data is unavailable for this point.')
      const lat = (field.lat * 180) / Math.PI
      fpvTerrainRef.current?.destroy()
      const terrain = buildFpvTerrain(viewer.scene, lat, site.lon, field.heights, rings, fpvPhotoRef.current)
      fpvTerrainRef.current = terrain
      terrain.setAmbient(lightingRef.current ? 0 : 0.9)
      viewer.scene.globe.show = false // the mesh is the ground now
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(site.lon, lat, terrain.centerHeight + EYE_HEIGHT_M, Ellipsoid.MOON),
        orientation: { heading: 0, pitch: 0, roll: 0 },
      })
      if (lightingBeforeFpv.current === null) lightingBeforeFpv.current = lightingRef.current
      setLighting(true)
      setTerrainViewActive(true)
    } catch (error) {
      if (requestId !== terrainRequest.current) return
      terrainCamera.current = null
      terrainSiteId.current = undefined
      if (restoreElevationOnExit.current) {
        setBasemapState((state) => ({ ...state, elevation: false }))
        restoreElevationOnExit.current = false
      }
      setTerrainViewError(`Could not open terrain view: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (requestId === terrainRequest.current) setTerrainViewLoading(false)
    }
  }, [stopTerrainView])

  useEffect(() => {
    if (terrainSiteId.current && terrainSiteId.current !== selected?.id) stopTerrainView(true)
  }, [selected?.id, stopTerrainView])

  // ---- boot: Cesium scene + static data bundle ----
  useEffect(() => {
    let destroyed = false
    Promise.all([createMoonScene(containerRef.current!), loadBundle()]).then(([scene, data]) => {
      if (destroyed) return scene.viewer.destroy()
      sceneRef.current = scene
      ;(window as unknown as { moon: MoonScene }).moon = scene // handy in the browser console: moon.viewer
      setBundle(data)
      if (data.ephemeris) {
        setEphemeris(data.ephemeris)
        const [a, b] = ephemerisRange(data.ephemeris)
        setTimeRange([a, b])
        const t0 = Math.min(Math.max(Math.floor(Date.now() / 1000) * 1000, a), b)
        setT(t0)
        // opening view: the full Moon disc as seen from Earth right now
        viewFromEarth(scene.viewer, earthPosition(data.ephemeris, t0))
      } else {
        flyToSite(scene.viewer, -89.5, 0, 250_000, 0)
      }
      setReady(true)
    })
    return () => {
      destroyed = true
      sceneRef.current?.viewer.destroy()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadRadiationMetadata(`${import.meta.env.BASE_URL}radiation/radiation_overlay.json`)
      .then((metadata) => {
        if (!cancelled) {
          setRadiationMetadata(metadata)
          setRadiationError(undefined)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setRadiationError(`Radiation: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        if (!cancelled) setRadiationLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // ---- keep all data overlays off by default ----
  useEffect(() => {
    if (!bundle || Object.keys(layerState).length) return
    const defaults: Record<string, LayerState> = {}
    for (const meta of bundle.layers) {
      defaults[meta.id] = { visible: false, opacity: 0.65 }
    }
    setLayerState(defaults)
  }, [bundle, layerState])

  // ---- site markers ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !bundle) return
    markers.current.sites.forEach((e) => scene.viewer.entities.remove(e))
    siteByMarker.current.clear()
    // hover animation: 9 px -> 13 px over 150 ms when the mouse is on the marker, back when it leaves
    const sizeOf = (e: () => Entity | undefined) => new CallbackProperty(() => {
      const h = hover.current, me = e(), now = performance.now()
      const k = (t: number) => { const x = Math.min(1, (now - t) / 150); return x * (2 - x) }
      if (me && h.entity === me) return 9 + 4 * k(h.since)
      if (me && h.prev === me) return 13 - 4 * k(h.prevSince)
      return 9
    }, false)
    markers.current.sites = allSites.map((s) => {
      let self: Entity | undefined
      const entity = scene.viewer.entities.add({
        // at the site's terrain height (from 0 m they sat under the ground, so from the ground view they
        // either hid or, with depth testing off, showed through hills)
        // from orbit: on the reference sphere and drawn on top (within 500 km); first person: 3 m above
        // the first-person mesh (its own heights, so hills hide it correctly), hidden beyond the mesh
        position: new CallbackPositionProperty(() => {
          const fpv = terrainViewRef.current ? fpvTerrainRef.current : null
          const h = fpv ? fpv.heightAt(s.lat, s.lon) : 0
          return Cartesian3.fromDegrees(s.lon, s.lat, Number.isFinite(h) ? h + 3 : 0, Ellipsoid.MOON)
        }, false),
        point: {
          show: new CallbackProperty(() => markerInView(s), false),
          pixelSize: sizeOf(() => self),
          color: s.group === 'Saved'
            ? Color.fromCssColorString('#32cd32')
            : FUTURE_SITE_GROUPS.has(s.group) ? Color.DODGERBLUE : Color.RED,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: markerDepthTest,
          // zooming out past the Moon's scale, the landmarks fade out (a "Moon" tag fades in, cesium/celestial.ts)
          translucencyByDistance: LANDMARK_FADE,
        },
        label: {
          text: s.name, font: '13px system-ui', style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3,
          verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -12),
          show: new CallbackProperty(() => markerInView(s), false),
          disableDepthTestDistance: markerDepthTest, // on top nearby from orbit, hidden behind the Moon from afar / terrain on the ground
          translucencyByDistance: LANDMARK_FADE,
        },
      })
      self = entity
      siteByMarker.current.set(entity, s)
      return entity
    })
  }, [ready, bundle, allSites, markerInView, markerDepthTest])

  useEffect(() => {
    markers.current.sites.forEach((marker) => {
      marker.show = showSiteMarkers
    })
  }, [showSiteMarkers, ready, bundle, allSites])

  // ---- photo basemap toggles (Moon Trek LOD stack) ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    for (const g of ['kaguya', 'nacPolar', 'nacSites'] as const) scene.photo[g].forEach((l) => (l.show = basemapState[g]))
  }, [ready, basemapState])

  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !basemapState.elevation) return
    const provider = new DemReliefProvider(`${DATA_URL}/dem`)
    const layer = new ImageryLayer(provider as unknown as import('cesium').ImageryProvider, { alpha: 0.38 })
    const index = scene.basemap === 'trek'
      ? scene.photo.wac.length + scene.photo.kaguya.length + scene.photo.nacPolar.length + scene.photo.nacSites.length
      : undefined
    scene.overlays.add(layer, index)
    return () => removeLayer(scene, layer)
  }, [ready, basemapState.elevation])

  useEffect(() => {
    const scene = sceneRef.current
    const globe = scene?.viewer.scene.globe
    if (!ready || !scene || scene.basemap !== 'trek' || !globe || !basemapState.elevation) return
    const baseTerrain = globe.terrainProvider
    const terrain = new DemTerrainProvider(`${DATA_URL}/dem`, fineDemBaseUrl())
    globe.terrainProvider = terrain
    return () => {
      if (globe.terrainProvider === terrain) globe.terrainProvider = baseTerrain
      terrain.dispose()
    }
  }, [ready, basemapState.elevation])

  // ---- LOLA relief shading south of 80S: above the WAC/Kaguya photos (which smear near the pole)
  //      but below the sharper NAC mosaics, so it fills the gaps without hiding the best imagery ----
  useEffect(() => {
    const scene = sceneRef.current
    const dem = bundle?.fields.dem_south
    if (!ready || !scene || !dem || scene.basemap !== 'trek' || !basemapState.relief) return
    const layer = new ImageryLayer(asProvider(new FieldImageryProvider({
      value: hillshade(dem), min: 0, max: 1, colormap: 'grey',
      boundsRad: dem.boundsRad(), maximumLevel: levelForResolution(dem.meta.resolutionM) + 1,
      credit: 'Relief: LOLA LDEM 80S',
      // fade out over the last degree before its 80S edge, so the edge isn't a hard line on the map
      alpha: (_lon, lat) => Math.min(1, Math.max(0, (-lat - RELIEF_EDGE_RAD) / RELIEF_FADE_RAD)),
    })), { alpha: 0.75 })
    scene.overlays.add(layer, scene.photo.wac.length + scene.photo.kaguya.length)
    return () => { scene.overlays.remove(layer, true) }
  }, [ready, bundle, basemapState.relief])

  // render on demand (cesium/createViewer.ts): any state change may change the scene (time, layers,
  // opacity, selection...), so a frame is requested after every render of the app
  useEffect(() => { sceneRef.current?.viewer.scene.requestRender() })

  // ---- approximate ground resolution at the screen centre (for the basemap panel) ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    const { camera, canvas } = scene.viewer.scene
    camera.percentageChanged = 0.05
    // terrain height under the camera from the elevation tiles (the globe's own terrain is flat unless
    // 3D terrain is on), refreshed at most ~3 times a second
    const sampler = new DemTerrainProvider(`${DATA_URL}/dem`, fineDemBaseUrl())
    let ground = 0, pending = false, last = 0, disposed = false
    const update = () => {
      const position = camera.positionCartographic
      // first person: the ground is the local mesh (globe hidden)
      const fpv = fpvTerrainRef.current
      const globeH = fpv ? fpv.centerHeight : scene.viewer.scene.globe?.getHeight(position)
      const h = Math.max(0, position.height - (globeH ?? ground))
      const fovy = (camera.frustum as { fovy?: number }).fovy ?? Math.PI / 3
      setViewResM((2 * h * Math.tan(fovy / 2)) / Math.max(canvas.clientHeight, 1))
      setCameraAltM(h)
      const now = performance.now()
      if (pending || now - last < 300 || position.height > 2_000_000) return // far away: ground is negligible
      pending = true
      last = now
      sampler.sampleHeight(position.longitude, position.latitude)
        .then((g) => { if (!disposed && g !== undefined && Number.isFinite(g)) { ground = g; update() } })
        .catch(() => undefined)
        .finally(() => { pending = false })
    }
    update()
    const off = camera.changed.addEventListener(update)
    // 'changed' only fires after a 5 % move: refresh when a flight / drag ends too
    const offEnd = camera.moveEnd.addEventListener(() => { last = 0; update() })
    return () => { disposed = true; off(); offEnd(); sampler.dispose() }
  }, [ready])

  // ---- mission period: recompute sunlight / Earth averages over [start, end] (debounced) ----
  const missionValid = mission.start !== undefined && mission.end !== undefined && mission.end > mission.start
  const landingDay = mission.landingDayEnabled && mission.landingDay !== undefined
    ? Math.floor(mission.landingDay / DAY) * DAY
    : undefined
  const missionInWindow = missionValid && mission.start! >= timeRange[0] && mission.end! <= timeRange[1]
  const periodLabel = landingDay !== undefined
    ? 'landing day'
    : missionValid ? 'mission period' : 'loaded period (no mission period set)'
  const scorePeriod = useMemo<[number, number]>(
    () => landingDay !== undefined
      ? [landingDay, landingDay + DAY]
      : missionValid ? [mission.start!, mission.end!] : timeRange,
    [landingDay, missionValid, mission.start, mission.end, timeRange],
  )
  const analysisPeriodInWindow = scorePeriod[0] >= timeRange[0] && scorePeriod[1] <= timeRange[1]
  const navigationRange = useMemo<[number, number]>(
    () => analysisPeriodInWindow ? scorePeriod : timeRange,
    [analysisPeriodInWindow, scorePeriod, timeRange],
  )
  useEffect(() => {
    setT((current) => Math.min(Math.max(current, navigationRange[0]), navigationRange[1]))
  }, [navigationRange])

  // ---- global heatmap engine + its averaging window ----
  useEffect(() => {
    if (!ready) return
    let engine: HeatEngine | null = null
    let disposed = false
    HeatEngine.load().then((e) => {
      if (disposed) return e?.dispose()
      engine = e
      setHeat(e)
      ;(window as unknown as { moonHeat: HeatEngine | null }).moonHeat = e // console debugging, like window.moon
      if (!e) console.info('Global heatmaps off: run pipeline/dem_tiles.py to generate web/public/data/dem')
      if (e) {
        e.onGpu = (g) => {
          setGpuInfo(g)
          console.info(g ? `Heatmaps compute on the GPU: ${g.vendor} ${g.architecture} (${g.integrated ? 'integrated' : 'dedicated'})` : 'Heatmaps compute on the CPU (WebGPU unavailable)')
        }
        if (e.gpu !== undefined) setGpuInfo(e.gpu)
      }
    })
    return () => { disposed = true; engine?.dispose() }
  }, [ready])
  // Settings > Computation: graphics card + processor, or processor only
  useEffect(() => { heat?.setBackend(display.compute === 'cpu' ? 'cpu' : 'auto') }, [heat, display.compute])
  useEffect(() => {
    if (!heat || !ephemeris || !analysisPeriodInWindow) return
    const [a, b] = scorePeriod
    const id = setTimeout(() => { heat.setWindow(ephemeris, a, b); setHeatVersion(heat.version) }, 200)
    return () => clearTimeout(id)
  }, [heat, ephemeris, analysisPeriodInWindow, scorePeriod])

  useEffect(() => {
    if (!heat || !selected || selected.horizon) return
    let cancelled = false
    const id = selected.id
    heat.horizon(selected.lat, selected.lon).then((horizon) => {
      if (cancelled || !horizon) return
      setSelected((s) => (s && s.id === id ? { ...s, horizon } : s))
    })
    return () => { cancelled = true }
  }, [heat, selected])

  // ---- temperature range + radiation at the selected site (same global model as the heatmaps) ----
  const envLat = selected?.lat, envLon = selected?.lon
  const siteEnvKey = envLat !== undefined && heat && heatVersion ? `${heatVersion}|${envLat}|${envLon}` : ''
  useEffect(() => {
    if (!heat || !heatVersion || envLat === undefined || envLon === undefined) return
    let cancelled = false
    const key = `${heatVersion}|${envLat}|${envLon}`
    sampleSiteEnv(heat, envLat, envLon).then((v) => {
      if (cancelled) return
      const ok = v && Number.isFinite(v.tMin) && Number.isFinite(v.tMax) && Number.isFinite(v.tMean) && Number.isFinite(v.fSky)
      setSiteEnv({ key, env: ok ? { tMinK: v.tMin, tMaxK: v.tMax, tMeanK: v.tMean, doseUGyH: radiationDose(v.fSky, heat.gcr), slopeDeg: v.slope } : null })
    }).catch(() => { if (!cancelled) setSiteEnv({ key, env: null }) })
    return () => { cancelled = true }
  }, [heat, heatVersion, envLat, envLon])
  const siteEnvReady = siteEnv && siteEnv.key === siteEnvKey ? siteEnv : undefined
  const heatWindowMatchesPeriod = !heat || (heat.window[0] === scorePeriod[0] && heat.window[1] === scorePeriod[1])
  const siteEnvForPeriod = heatWindowMatchesPeriod ? siteEnvReady : undefined

  // Refined area around the selected site (~15 km around it): every layer is computed there from the
  // finest elevation tiles, sampled at their own resolution, once the view is close enough (map tile
  // level >= 6, ~85 km tiles). Elsewhere the resolution follows the zoom level as usual.
  const selLat = selected?.lat, selLon = selected?.lon
  const focus = useMemo<GlobalHeatOptions['focus']>(() => {
    if (selLat === undefined || selLon === undefined || !heat) return undefined
    const dLat = FOCUS_RADIUS_M / MOON_RADIUS_M, dLon = Math.min(Math.PI, dLat / Math.max(Math.cos(selLat * D2R), 0.02))
    const lat = selLat * D2R, lon = selLon * D2R
    return {
      boundsRad: [lon - dLon, Math.max(-Math.PI / 2, lat - dLat), lon + dLon, Math.min(Math.PI / 2, lat + dLat)],
      samples: 65,
      demLevel: heat.dem.fineMaxLevel,
      minLevel: 6,
      center: [lon, lat],
      radiusM: FOCUS_RADIUS_M,
    }
  }, [selLat, selLon, heat])


  // layer metadata as displayed: global range + source when the layer is computed on the fly
  // radiation legend as displayed: the global computation's dose range, and the class thresholds of
  // the selected period (scaled by its solar-cycle factor, see radiationClassThresholds)
  const radiationDisplayMeta = useMemo(() => {
    if (!radiationMetadata || !heat || !heatVersion) return radiationMetadata
    const [a, b] = radiationClassThresholds(radiationMetadata, heat.gcr)
    const cut = [`≤ ${a.toFixed(1)}`, `≤ ${b.toFixed(1)}`, `> ${b.toFixed(1)}`]
    return {
      ...radiationMetadata,
      doseMin: RAD_CONTINUOUS_RANGE[0], doseMax: RAD_CONTINUOUS_RANGE[1],
      classLegend: radiationMetadata.classLegend.map((c, i) => ({ ...c, label: `${cut[i] ?? c.label} ${radiationMetadata.units} · ${RAD_CLASS_NAMES[i] ?? ''}` })),
    }
  }, [radiationMetadata, heat, heatVersion])

  const displayLayers = useMemo(() => (bundle?.layers ?? []).map((m) => {
    const gAll = GLOBAL_LAYERS[m.id]
    const pyr = gAll?.pyramid && pyramids[gAll.pyramid.name]
    const g = pyr || (heat && heatVersion) ? gAll : undefined
    if (!g) return m
    const [min, max] = g.range ?? [m.min, m.max]
    return { ...m, title: g.title ?? m.title, min, max, source: pyr ? g.pyramid!.method : g.method }
  }), [bundle, heat, heatVersion, pyramids])
  const reportOverlays = useMemo<ReportOverlay[]>(() => {
    const active: ReportOverlay[] = displayLayers
      .filter((layer) => layerState[layer.id]?.visible)
      .map((layer) => ({
        id: layer.id,
        title: layer.title,
        source: layer.source,
        opacity: layerState[layer.id].opacity,
      }))
    if (score.enabled) {
      active.push({
        id: '__score',
        title: 'Landing suitability',
        source: `Equal-weight temperature, radiation, slope, telecommunications and sunlight score; maximum slope ${score.maxSlope}°`,
        opacity: score.opacity,
      })
    }
    if (radiationVisible) {
      active.push({
        id: '__radiation',
        title: 'Radiation',
        source: `Lunar GCR and regolith-albedo model, ${radiationMode} display`,
        opacity: radiationOpacity,
      })
    }
    if (iceVisible) active.push({ id: '__ice', title: 'Water ice South Pole', source: 'Diviner PRP cold traps (Paige et al. 2010)', opacity: 1 })
    return active
  }, [displayLayers, layerState, score, radiationVisible, radiationMode, radiationOpacity, iceVisible])
  const reportPeriod = scorePeriod
  const reportPeriodSource = landingDay !== undefined
    ? 'Landing day'
    : missionValid ? 'Configured mission period' : 'Loaded ephemeris window'

  // ---- map layers (one ImageryLayer per visible layer; rebuilt when the period or the focus changes) ----
  const layerKeys = useRef<Record<string, string>>({})
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !bundle) return
    bundle.layers.forEach((meta) => {
      const st = layerState[meta.id]
      let layer = layerRefs.current[meta.id]
      // time-independent layers with a precomputed pyramid don't depend on the period or the focus
      const gAll = GLOBAL_LAYERS[meta.id]
      const pyr = gAll?.pyramid ? pyramids[gAll.pyramid.name] : undefined
      const g = pyr || (heat && heatVersion) ? gAll : undefined
      const key = pyr ? `pyramid:${pyr.name}` : `${heatVersion}|${focus?.boundsRad.join(',') ?? ''}|${guide ? 'g' : ''}`
      if (layer && layerKeys.current[meta.id] !== key) {
        // new period / focus: keep the old heatmap visible while the new tiles render
        const old = layer
        setTimeout(() => removeLayer(scene, old), 2500)
        delete layerRefs.current[meta.id]
        layer = undefined as unknown as ImageryLayer
      }
      if (!g || !st?.visible) {
        // drop hidden layers so their tiles and textures are freed (computed values stay cached)
        if (layer) {
          removeLayer(scene, layer)
          delete layerRefs.current[meta.id]
        }
        return
      }
      if (!layer) {
        layerKeys.current[meta.id] = key
        const contrast = meta.id.includes('sun') || meta.id.includes('earth') ? 1.25 : meta.id.includes('slope') ? 1.4 : 1.15
        const [lo, hi] = g.range ?? [meta.min, meta.max]
        layer = new ImageryLayer(asProvider((pyr
          ? new PyramidImageryProvider({
            pyramid: pyr, channel: g.pyramid!.channel,
            min: lo, max: hi, colormap: meta.colormap, contrast,
            credit: `${g.title ?? meta.title}: ${g.pyramid!.method}`,
          })
          : new GlobalHeatProvider({
            engine: heat!, value: g.value,
            min: lo, max: hi, colormap: meta.colormap, contrast,
            thermal: g.thermal, focus, guide,
            credit: `${g.title ?? meta.title}: ${g.method} (LOLA global DEM)`,
          })) as unknown as FieldImageryProvider))
        scene.overlays.add(layer)
        layerRefs.current[meta.id] = layer
      }
      layer.show = true
      layer.alpha = st.opacity
    })
  }, [ready, bundle, layerState, heat, heatVersion, focus, pyramids, guide])

  // ---- derived landing-suitability score across all five Landing Score criteria ----
  const slopeMax = useMemo(() => (pyramids.slope?.encoding === 'u8x2' ? new SlopeMaxTiles(pyramids.slope) : null), [pyramids.slope])
  // Numeric footprint slope for the selected site's Landing Score: steepest slope inside the landing
  // footprint from the slope pyramid (the same source as the score map).
  const [fpA, fpB, fpAz] = footprintAxes(score.footprint)
  const [fpKey, setFpKey] = useState(`${fpA},${fpB},${fpAz}`)
  useEffect(() => {
    const id = setTimeout(() => setFpKey(`${fpA},${fpB},${fpAz}`), 400) // wait for typing to stop
    return () => clearTimeout(id)
  }, [fpA, fpB, fpAz])
  const fpSiteKey = slopeMax && selLat !== undefined && selLon !== undefined ? `${selLat},${selLon},${fpKey}` : ''
  const [siteFpSlope, setSiteFpSlope] = useState<{ key: string; deg: number }>()
  useEffect(() => {
    if (!fpSiteKey || !slopeMax) return
    let cancelled = false
    const [lat, lon, a, b, az] = fpSiteKey.split(',').map(Number)
    slopeMax.maxAt(lon * D2R, lat * D2R, a, b, az)
      .then((deg) => { if (!cancelled) setSiteFpSlope({ key: fpSiteKey, deg }) })
      .catch(() => { if (!cancelled) setSiteFpSlope({ key: fpSiteKey, deg: NaN }) })
    return () => { cancelled = true }
  }, [fpSiteKey, slopeMax])
  const footprintSlopeDeg = siteFpSlope?.key === fpSiteKey ? siteFpSlope.deg : undefined
  // what is on screen, for the score map's compute order (tiles in view first); updated on camera moves
  const viewRectRef = useRef<Rectangle | undefined>(undefined)
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    const s = scene.viewer.scene
    const update = () => { viewRectRef.current = s.camera.computeViewRectangle(s.globe.ellipsoid) ?? undefined }
    update()
    return s.camera.changed.addEventListener(update)
  }, [ready])
  const scoreOpacityRef = useRef(score.opacity)
  const scoreSky = useMemo(() => (pyramids.sky ? pyramidTiles(pyramids.sky) : undefined), [pyramids.sky])
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !(heat && heatVersion)) return
    const old = layerRefs.current.__score
    if (old) { removeLayer(scene, old); delete layerRefs.current.__score }
    // not global: only around the selected site / point, so the whole area gets refined quality
    if (!score.enabled || selLat === undefined || selLon === undefined) return
    const handle = setTimeout(() => {
      const limit = Math.min(Math.max(score.maxSlope, 0.5), SLOPE_MAX_DEG)
      const lat0 = selLat * D2R, lon0 = selLon * D2R
      const radiusM = score.radiusKm * 1000
      const dLat = radiusM / MOON_RADIUS_M
      const south = Math.max(-Math.PI / 2, lat0 - dLat), north = Math.min(Math.PI / 2, lat0 + dLat)
      // a pole inside the circle, or a box crossing the antimeridian: take every longitude
      const polar = lat0 + dLat >= Math.PI / 2 || lat0 - dLat <= -Math.PI / 2
      const dLon = polar ? Math.PI : Math.asin(Math.min(1, Math.sin(dLat) / Math.cos(lat0)))
      const wrap = lon0 - dLon < -Math.PI || lon0 + dLon > Math.PI
      const boundsRad: [number, number, number, number] = polar || wrap ? [-Math.PI, south, Math.PI, north] : [lon0 - dLon, south, lon0 + dLon, north]
      // Per-pixel classification (sharp class boundaries): the worker returns the raw criteria per
      // sample; they are interpolated along the terrain (DEM-guided) and classified per pixel here. The
      // slope criterion and the slope limit come per pixel from the slope pyramid (steepest slope in the
      // footprint, one pass for every class boundary), radiation from the sky-view pyramid. So changing
      // thresholds, the slope limit or the footprint only repaints: nothing is recomputed.
      const st = advancedSettings
      const [periodStart, periodEnd] = heat.window
      const periodHours = (periodEnd - periodStart) / 3600_000
      const gcr = heat.gcr
      const thresholds = [st.slope.recommendedDeg, st.slope.feasibleDeg, st.slope.difficultDeg, limit].sort((x, y) => x - y)
      const top = thresholds[thresholds.length - 1]
      const provider = new GlobalHeatProvider({
        engine: heat,
        thermal: true,
        landing: slopeMax ? {} : { footprint: [fpA, fpB, fpAz] },
        fields: ['tMean', 'link', 'linkGap', 'sunlit', 'dark', ...(scoreSky ? [] : ['fSky' as const]), ...(slopeMax ? [] : ['slope' as const])],
        sky: scoreSky,
        pixel: slopeMax ? (rect, z) => slopeMax.levelsBanded(rect, z, fpA, fpB, fpAz, thresholds) : undefined,
        value: (v) => {
          // steepest slope in the footprint: from the pyramid class (count of thresholds exceeded ->
          // the upper bound of its interval, which classifies identically), else the worker's DEM value
          let maxSlope: number
          if (slopeMax) {
            const c = v.pixel
            if (!(c >= 0)) return NaN
            maxSlope = c < thresholds.length ? thresholds[c] : top + 1
          } else maxSlope = v.slope
          if (!(maxSlope <= limit)) return NaN
          const { tMean, fSky, link, linkGap, sunlit } = v
          if (!(tMean === tMean && fSky === fSky && link === link && linkGap === linkGap && sunlit === sunlit)) return NaN
          return scoreLandingCell({
            tMeanC: tMean - 273.15,
            doseRateUGyH: radiationDose(fSky, gcr),
            periodHours,
            maxSlopeDeg: maxSlope,
            linkPct: link,
            longestLinkGapH: linkGap,
            sunlitPct: sunlit,
          }, st)
        },
        circle: [lon0, lat0, radiusM],
        // nearest the selected point first, tiles on screen before the rest
        prioritize: { inView: (r) => { const v = viewRectRef.current; return !v || !!Rectangle.intersection(r, v) } },
        boundsRad,
        maximumLevel: 13,
        // the whole circle at the selected site's refined quality: finest elevation tiles, one sample
        // per elevation pixel (capped at 33 per tile side for the regolith model) from tile level 5 on
        focus: { boundsRad, center: [lon0, lat0], radiusM, samples: 33, demLevel: heat.dem.fineMaxLevel, minLevel: 5 },
        min: 0, max: 100, colormap: 'viridis', guide,
        credit: 'Landing suitability: equal-weight Landing Score criteria (temperature, radiation, LOLA slope, DSN and sunlight)',
      }) as unknown as FieldImageryProvider
      const layer = new ImageryLayer(asProvider(provider), { alpha: scoreOpacityRef.current })
      scene.overlays.add(layer)
      layerRefs.current.__score = layer
    }, 150) // debounce slider drags
    return () => clearTimeout(handle)
  }, [ready, score.enabled, score.maxSlope, score.radiusKm, fpA, fpB, fpAz, heat, heatVersion, selLat, selLon, slopeMax, scoreSky, guide, advancedSettings])
  // opacity only changes the layer's alpha (rebuilding it repainted every tile)
  useEffect(() => {
    scoreOpacityRef.current = score.opacity
    const layer = layerRefs.current.__score
    if (layer) layer.alpha = score.opacity
  }, [score.opacity])

  // ---- reachable area from the selected site / point (lib/reachWorker.ts) ----
  // One search per start point; the slope limit is applied afterwards (a lower limit is a pure redraw,
  // a higher one resumes the search in the worker).
  const [reach, setReach] = useState<ReachConfig>({ enabled: false, opacity: 0.6 })
  const [reachResult, setReachResult] = useState<ReachResult | null>(null)
  const [reachError, setReachError] = useState<string>()
  const [reachEngine, setReachEngine] = useState<ReachEngine | null>(null)
  const reachKey = useRef('')
  const reachOpacity = useRef(reach.opacity) // read when the layer is rebuilt; changes alone don't rebuild it
  const moveSlope = display.moveSlopeDeg
  const reachRadiusKm = display.reachRadiusKm
  useEffect(() => {
    if (!heat || !reach.enabled) return
    const engine = new ReachEngine(heat.dem)
    engine.onResult = (r) => { setReachError(undefined); setReachResult(r) }
    engine.onError = (e) => setReachError(e)
    reachKey.current = ''
    setReachEngine(engine)
    return () => { engine.dispose(); setReachEngine(null); setReachResult(null) }
  }, [heat, reach.enabled])
  useEffect(() => {
    if (!reachEngine) return
    if (selLat === undefined || selLon === undefined) {
      reachEngine.stop()
      reachKey.current = ''
      setReachResult(null)
      return
    }
    const key = `${selLat},${selLon},${reachRadiusKm}`
    if (reachKey.current === key) { reachEngine.setLimit(moveSlope); return }
    reachKey.current = key
    setReachResult(null)
    setReachError(undefined)
    reachEngine.start(selLat, selLon, reachRadiusKm * 1000, moveSlope)
  }, [reachEngine, selLat, selLon, moveSlope, reachRadiusKm])
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    const old = layerRefs.current.__reach
    delete layerRefs.current.__reach
    if (reach.enabled && reachResult) {
      const layer = new ImageryLayer(asReachProvider(new ReachImageryProvider(reachResult, moveSlope)), { alpha: reachOpacity.current })
      scene.overlays.add(layer)
      layerRefs.current.__reach = layer
    }
    if (old) removeLayer(scene, old) // after adding the new one: no empty frame in between
  }, [ready, reach.enabled, reachResult, moveSlope])
  useEffect(() => {
    reachOpacity.current = reach.opacity
    const layer = layerRefs.current.__reach
    if (layer) layer.alpha = reach.opacity
  }, [reach.opacity])
  const reachStatus = useMemo(() => {
    if (reachError) return `Could not compute: ${reachError}`
    if (!reachResult) return 'Computing…'
    const q = Math.min(Math.floor(moveSlope * SLOPE_QUANTUM + 1e-9), reachResult.exploredQ)
    const area = reachAreaKm2(reachResult.grid, reachResult.val, q / SLOPE_QUANTUM)
    const more = !reachResult.final ? ' · refining…' : q < Math.floor(moveSlope * SLOPE_QUANTUM + 1e-9) ? ' · extending…' : ''
    return `${area.toLocaleString('en-US', { maximumFractionDigits: 0 })} km² reachable · ${Math.round(reachResult.grid.cell)} m grid · ${reachResult.ms} ms${more}`
  }, [reachError, reachResult, moveSlope])

  // ---- region filters ----
  const filterPeriod = useMemo(() => {
    const [start, end] = scorePeriod
    const hours = end > start ? (end - start) / 3600_000 : 0
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const ready = !!heat && heatVersion === heat.version &&
      heat.window[0] === start && heat.window[1] === end && analysisPeriodInWindow
    return { hours, label: hours ? `${day(start)} → ${day(end)} (${Math.round(hours).toLocaleString('en-US')} h)` : '—', ready }
  }, [scorePeriod, heat, heatVersion, analysisPeriodInWindow])

  useEffect(() => {
    if (!filterPeriod.ready) return
    const previousHours = regionFilterPeriodHours.current
    const limit = Math.max(1, Math.round(filterPeriod.hours))
    const scale = filterPeriod.hours / previousHours
    setRegionFilters((current) => {
      let changed = false
      const next = { ...current }
      const sunMin = Math.round(Math.min(limit, Math.max(0, current.sunHours.min * scale)) * 10) / 10
      const sunMax = Math.max(sunMin, Math.round(Math.min(limit, current.sunHours.max * scale) * 10) / 10)
      if (sunMin !== current.sunHours.min || sunMax !== current.sunHours.max) {
        next.sunHours = { ...current.sunHours, min: sunMin, max: sunMax }
        changed = true
      }
      const nightMax = Math.min(current.nightHours.max, limit)
      const nightMin = Math.min(current.nightHours.min, nightMax)
      if (nightMin !== current.nightHours.min || nightMax !== current.nightHours.max) {
        next.nightHours = { ...current.nightHours, min: nightMin, max: nightMax }
        changed = true
      }
      return changed ? next : current
    })
    regionFilterPeriodHours.current = filterPeriod.hours
  }, [filterPeriod.ready, filterPeriod.hours])

  // distance data, loaded the first time the water-ice / pit filters are ticked
  useEffect(() => {
    const needIce = regionFilters.ice.on && !iceDistance, needPits = regionFilters.pits.on && !pitDistance
    if (!needIce && !needPits) return
    const grid = bundle?.layers.find((l) => l.id === 'charging_mean')
    let cancelled = false
    Promise.all([
      needIce ? (grid?.halfExtentM ? loadIceDistance({ halfExtentM: grid.halfExtentM, width: grid.width }) : Promise.reject(new Error('the 4 km polar grid metadata is missing'))) : null,
      needPits ? loadPitDistance() : null,
    ]).then(([ice, pits]) => {
      if (cancelled) return
      setFilterDataError(undefined)
      if (ice) setIceDistance(ice)
      if (pits) setPitDistance(pits)
    }).catch((error: unknown) => {
      if (!cancelled) setFilterDataError(`Distance data unavailable: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { cancelled = true }
  }, [regionFilters.ice.on, regionFilters.pits.on, iceDistance, pitDistance, bundle])

  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    const old = layerRefs.current.__filters
    if (old) { removeLayer(scene, old); delete layerRefs.current.__filters }
    const on = activeFilters(regionFilters)
    if (!heat || !on.length || !filterPeriod.ready) return
    const handle = setTimeout(() => {
      const gcr = heat.gcr
      const provider = new GlobalHeatProvider({
        engine: heat,
        thermal: regionFilters.temperature.on, // the regolith model only when temperature is filtered
        longestNight: regionFilters.nightHours.on,
        sky: pyramids.sky ? pyramidTiles(pyramids.sky) : undefined,
        value: regionValue(regionFilters, {
          periodHours: filterPeriod.hours,
          dose: (fSky) => radiationDose(fSky, gcr),
          ice: iceDistance,
          pits: pitDistance,
        }),
        min: 0, max: 1, colormap: 'slope', focus, guide,
        credit: `Region filters: ${on.join(', ')}`,
      }) as unknown as FieldImageryProvider
      const layer = new ImageryLayer(asProvider(provider), { alpha: 0.65 })
      scene.overlays.add(layer)
      layerRefs.current.__filters = layer
    }, 250) // debounce typing in the range boxes
    return () => clearTimeout(handle)
  }, [ready, regionFilters, heat, heatVersion, filterPeriod, iceDistance, pitDistance, focus, guide, pyramids.sky])

  // ---- radiation overlay (global engine / precomputed sky view) ----
  useEffect(() => {
    const scene = sceneRef.current
    const metadata = radiationMetadata
    if (!ready || !scene || !metadata || !radiationVisible) return

    let layer: ImageryLayer | null = null
    setRadiationError(undefined)
    const meta = radiationLayerMeta(metadata, radiationMode)
    if (heat && heatVersion) {
      const gcr = heat.gcr
      const [green, yellow] = radiationClassThresholds(metadata, gcr)
      const classes = radiationMode === 'classes'
      const [lo, hi] = classes ? [meta.min, meta.max] : RAD_CONTINUOUS_RANGE
      const doseOf = (fSky: number) => {
        const d = radiationDose(fSky, gcr)
        return classes ? (d <= green ? 0 : d <= yellow ? 1 : 2) : d
      }
      const credit = `Radiation: GCR + albedo model (pipeline/lunar_radiation.py) on the LOLA global DEM, solar-cycle factor ${gcr.toFixed(2)}`
      // the visible-sky fraction depends only on the terrain: precomputed tiles when available
      layer = new ImageryLayer(asProvider((pyramids.sky
        ? new PyramidImageryProvider({ pyramid: pyramids.sky, value: doseOf, min: lo, max: hi, colormap: meta.colormap, credit: `${credit}; precomputed sky view` })
        : new GlobalHeatProvider({ engine: heat, value: (v) => doseOf(v.fSky), min: lo, max: hi, colormap: meta.colormap, focus, guide, credit })
      ) as unknown as FieldImageryProvider), { alpha: radiationOpacityRef.current })
      scene.overlays.add(layer)
      radiationLayerRef.current = layer
      return () => {
        if (layer) {
          removeLayer(scene, layer)
          if (radiationLayerRef.current === layer) radiationLayerRef.current = null
        }
      }
    }
    return undefined
  }, [ready, radiationMetadata, radiationMode, radiationVisible, heat, heatVersion, focus, pyramids, guide])

  useEffect(() => {
    if (radiationLayerRef.current) radiationLayerRef.current.alpha = radiationOpacity
  }, [radiationOpacity])

  useEffect(() => {
    iceEntitiesRef.current.forEach((entity) => {
      entity.show = iceVisible
    })
  }, [ready, iceVisible])

  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !iceVisible || iceLoadedRef.current) return

    let cancelled = false
    setIceError(undefined)
    const loadIceLayer = async () => {
      const url = `${DATA_URL}/mappa_ghiaccio.geojson`
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Ice GeoJSON unavailable (${response.status} ${response.statusText})`)
      const points = parseIceGeoJson(await response.json())
      if (cancelled) return

      iceEntitiesRef.current = points.map(({ lat, lon, color }) => scene.viewer.entities.add({
        position: Cartesian3.fromDegrees(lon, lat, 0, Ellipsoid.MOON),
        point: {
          pixelSize: 7,
          color,
          outlineColor: Color.WHITE,
          outlineWidth: 1,
          disableDepthTestDistance: 500_000,
        },
      }))
      iceLoadedRef.current = true
    }
    void loadIceLayer().catch((error: unknown) => {
      if (!cancelled) setIceError(`Unable to load the ice layer: ${error instanceof Error ? error.message : String(error)}`)
    })

    return () => { cancelled = true }
  }, [ready, iceVisible])

  // ---- clock: Sun lighting + Sun/Earth markers ----
  useEffect(() => {
    const scene = sceneRef.current
    const eph = ephemeris
    if (!ready || !scene || !eph) return
    const sun = sunPosition(eph, t)
    const earth = earthPosition(eph, t)
    // (during a solar eclipse the shadow overlay below darkens each point by its own coverage)
    // first person with Sun lighting: the camera exposure follows the share of the Sun's disc above the
    // terrain horizon (fpvExposure: continuous, so sunrise / sunset fade instead of flashing); the light
    // is the Sun until it is dimmer than the earthshine, then the Earth (both equal at the switch). The
    // ground shader dims each pixel by its own share of the disc, so the light carries only the exposure.
    // Solar eclipse (the Earth in front of the Sun): the share of the disc it covers from the camera
    // goes into the Sun's visible share, so the light, the exposure and the night switch all follow
    // it continuously; in totality only copper-red refracted sunlight is left (eclipseSunlight), and
    // the auto-exposure rises until the red ground and the Earth's red-rimmed black disc show.
    const fpv = lighting && terrainViewActive ? fpvTerrainRef.current : null
    const cam = scene.viewer.camera.positionWC
    const cover = fpv ? eclipseCoverFrom(sun, earth, [cam.x, cam.y, cam.z]) : 0
    const eclipse = eclipseSunlight(cover)
    const terrainVis = fpv ? fpv.sunVisible(sun) : 1
    const sunVis = terrainVis * eclipse.level
    const earthshine = fpv ? earthshineAtCamera(scene.viewer, sun, earth) : 0
    // the refracted light counts as the darkest scene in totality (as the earthshine at night: the
    // Earth's night side faces us then, so its earthshine is ~0)
    const exposure = fpv ? fpvExposure(sunVis, Math.max(earthshine, terrainVis * eclipse.refracted)) : 1
    const night = !!fpv && sunVis <= earthshine
    if (night) setEarthLight(scene.viewer, sun, earth, exposure)
    else setSunDirection(scene.viewer, sun, exposure, cover)
    setNightView(night ? earthshineRatio(sun, earth) : null)
    // the real Earth (size, texture, rotation, phase) and Sun (at infinity, true angular size): cesium/celestial.ts
    if (!celestialRef.current) celestialRef.current = createCelestial(scene.viewer, (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL ?? '/cesiumStatic')
    celestialRef.current.update(t, sun, earth)
    // the camera's exposure: raised for earthshine at night, and the Earth / Sun with it
    celestialRef.current.setExposure(exposure)
    if (terrainViewActive) celestialRef.current.loadDetail()
  }, [ready, ephemeris, t, lighting, terrainViewActive, terrainCamTick])
  useEffect(() => () => { celestialRef.current?.dispose(); celestialRef.current = undefined }, [])

  useEffect(() => {
    // shadows from the Sun only: at night (earthshine) there is no shadow map
    lightingRef.current = lighting
    fpvTerrainRef.current?.setAmbient(lighting ? 0 : 0.9)
    if (ready && sceneRef.current) setSunLighting(sceneRef.current, lighting, terrainViewActive && nightView === null)
  }, [ready, lighting, terrainViewActive, nightView])

  // ---- solar-eclipse shadow on the globe (with Sun lighting on): darkness = share of the Sun the Earth
  //      hides at each point (topocentric, lib/eclipse.ts), so umbra and penumbra show where they fall.
  //      Rebuilt every 5 simulated minutes while an eclipse is under way. ----
  const eclipseKey = ephemeris && lighting && eclipsePossible(ephemeris, t) ? Math.round(t / 300_000) : null
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !ephemeris || eclipseKey === null) return
    const tk = eclipseKey * 300_000
    const sun = sunPosition(ephemeris, tk), earth = earthPosition(ephemeris, tk)
    const R = MOON_RADIUS_M
    const coverAt = (lon: number, lat: number) => {
      const c = Math.cos(lat)
      return eclipseCoverFrom(sun, earth, [R * c * Math.cos(lon), R * c * Math.sin(lon), R * Math.sin(lat)])
    }
    const layer = new ImageryLayer(asProvider(new FieldImageryProvider({
      value: () => 0, min: 0, max: 1, colormap: 'grey',
      alpha: (lon, lat) => 0.95 * coverAt(lon, lat),
      boundsRad: [-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2], maximumLevel: 4,
      credit: 'Solar eclipse: Earth shadow (SPICE ephemeris)',
    })))
    scene.overlays.add(layer)
    return () => { scene.overlays.remove(layer, true) }
  }, [ready, ephemeris, eclipseKey])

  useEffect(() => {
    if (!playing || !ephemeris) return
    const end = navigationRange[1]
    const id = setInterval(() => setT((x) => (x + stepMs > end ? x : x + stepMs)), 80)
    return () => clearInterval(id)
  }, [playing, stepMs, ephemeris, navigationRange])

  const inspectCustomPoint = useCallback((lat: number, lon: number) => {
    const scene = sceneRef.current
    if (!scene || !bundle) return
    const viewer = scene.viewer
    const p = { lat, lon }
    // every value comes from the global engine (filled in below when its tile is ready)
    const heightM: number | undefined = undefined
    const horizon = undefined
    const values = bundle.layers.map((m) => ({ title: GLOBAL_LAYERS[m.id]?.title ?? m.title, value: '—' }))
    if (markers.current.custom) viewer.entities.remove(markers.current.custom)
    markers.current.custom = viewer.entities.add({
      position: Cartesian3.fromDegrees(lon, lat, 0, Ellipsoid.MOON),
      // the point you inspect: hidden in the first-person view (you stand on it) and behind the Moon's limb
      point: {
        show: new CallbackProperty(() => !terrainViewRef.current && onNearSide(lat, lon), false),
        pixelSize: 13,
        color: Color.YELLOW,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        show: new CallbackProperty(() => !terrainViewRef.current && onNearSide(lat, lon), false),
        text: `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`,
        font: '13px system-ui',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    setInspect({ ...p, values })
    const heat = heatRef.current
    if (heat && heat.version) {
      // value at the point from a z = 10 tile (~10 km) of the global computation
      const z = 10, step = Math.PI / 2 ** z
      const lonR = lon * D2R, latR = lat * D2R
      const x = Math.min(2 ** (z + 1) - 1, Math.floor((lonR + Math.PI) / step)), y = Math.min(2 ** z - 1, Math.floor((Math.PI / 2 - latR) / step))
      heat.tile(z, x, y, 17, heat.dem.fineMaxLevel, true).then((tile) => {
        if (!tile) return
        const n = tile.nx, kx = n - 1, ky = tile.ny - 1
        const fx = ((lonR - (-Math.PI + x * step)) / step) * kx, fy = ((Math.PI / 2 - y * step - latR) / step) * ky
        const x0 = Math.min(Math.floor(fx), kx - 1), y0 = Math.min(Math.floor(fy), ky - 1), wx = fx - x0, wy = fy - y0
        const at = (a: Float32Array) => {
          const i = y0 * n + x0
          return a[i] * (1 - wx) * (1 - wy) + a[i + 1] * wx * (1 - wy) + a[i + n] * (1 - wx) * wy + a[i + n + 1] * wx * wy
        }
        const g: Record<string, number> = {
          sun_avg: at(tile.sun), earth_avg: at(tile.earth), earth_visibility: at(tile.earth), slope: at(tile.slope), dem_south: at(tile.elev),
          psr: at(tile.sun) < 0.002 ? 1 : 0,
            charging_mean: at(tile.cMean), charging_min: at(tile.cMin), charging_frac_below: at(tile.cBelow),
            ...(tile.tMean.length ? { thermal_mean: at(tile.tMean), thermal_min: at(tile.tMin), thermal_max: at(tile.tMax) } : {}),
        }
        setInspect((cur) => {
          if (!cur || cur.lat !== lat || cur.lon !== lon) return cur
          return {
            ...cur,
            values: cur.values.map((v, i) => {
              const m = bundle.layers[i]
              if (!m) return v // extra rows (e.g. lunar pit details) are not layers
              const gv = g[m.id]
              // fill gaps; for layers the global computation supersedes, prefer it everywhere
              if (gv === undefined || !Number.isFinite(gv)) return v
              return { title: GLOBAL_LAYERS[m.id]?.title ?? m.title, value: `${gv.toFixed(m.units === 'm' ? 0 : 2)} ${m.units}` }
            }),
          }
        })
        if (!Number.isFinite(heightM ?? NaN)) {
          const h = at(tile.elev)
          setSelected((s) => (s && s.lat === lat && s.lon === lon && s.heightM === undefined && Number.isFinite(h) ? { ...s, heightM: h } : s))
        }
      })
    }
    setSelected({
      id: `custom-${Date.now()}`,
      name: `Custom ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
      group: 'Custom',
      ...p,
      heightM,
      horizon,
    })
  }, [bundle, onNearSide])

  const searchCoordinates = useCallback((lat: number, lon: number) => {
    stopTerrainView(false)
    inspectCustomPoint(lat, lon)
    const scene = sceneRef.current
    if (scene) flyToSite(scene.viewer, lat, lon)
  }, [inspectCustomPoint, stopTerrainView])

  // ---- lunar pits (LROC catalog + LOLA heights, pipeline/pits.py) ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    const layer = new PitsLayer(scene.viewer)
    pitsRef.current = layer
    return () => {
      layer.destroy()
      if (pitsRef.current === layer) pitsRef.current = null
    }
  }, [ready])

  useEffect(() => {
    const layer = pitsRef.current
    if (!ready || !layer) return
    let cancelled = false
    setPitsError(undefined)
    layer.setVisible(pitsVisible).catch((error: unknown) => {
      if (!cancelled) setPitsError(`Unable to load the pits layer: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { cancelled = true }
  }, [ready, pitsVisible])

  // pits sit on the LOLA 3D terrain when it is on (same DEM tiles as their heights)
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    pitsRef.current?.setTerrain(scene.basemap === 'trek' && basemapState.elevation)
  }, [ready, basemapState.elevation, pitsVisible])

  /** Analyse a pit like a custom site and add its catalog data to the inspect panel. */
  const inspectPit = useCallback((pit: PitProps) => {
    inspectCustomPoint(pit.lat, pit.lon)
    setSelected((s) => (s && s.lat === pit.lat && s.lon === pit.lon
      ? { ...s, name: pit.name, group: 'Lunar pit', heightM: pit.surface_elev_m ?? s.heightM }
      : s))
    setInspect((cur) => (cur && cur.lat === pit.lat && cur.lon === pit.lon
      ? { ...cur, values: [...cur.values, ...pitInfoRows(pit)] }
      : cur))
  }, [inspectCustomPoint])

  // ---- click to inspect and analyse a custom site ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !bundle) return
    const viewer = scene.viewer
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    const pick = (pos: Cartesian2) => {
      const c = (viewer.scene.pickPositionSupported && viewer.scene.pickPosition(pos)) || viewer.camera.pickEllipsoid(pos, Ellipsoid.MOON)
      if (!c) return null
      const g = Cartographic.fromCartesian(c, Ellipsoid.MOON)
      return g ? { lat: CMath.toDegrees(g.latitude), lon: CMath.toDegrees(g.longitude) } : null
    }
    const siteAt = (pos: Cartesian2) => {
      const picked = viewer.scene.pick(pos) as { id?: unknown } | undefined
      return picked && picked.id ? siteByMarker.current.get(picked.id as Entity) : undefined
    }
    handler.setInputAction((e: { position: Cartesian2 }) => {
      // first person: clicks are part of looking around (dragging), not new selections
      if (terrainViewRef.current) return
      // a site marker: select it (one click)
      const site = siteAt(e.position)
      if (site) { clickActions.current.selectSite(site); return }
      const pit = pitsRef.current?.pitFromPick(viewer.scene.pick(e.position))
      if (pit) {
        inspectPit(pit)
        return
      }
      // empty map while something is selected: deselect, instead of jumping to a new point
      if (clickActions.current.hasSelection) { clickActions.current.clearSelection(); return }
      const p = pick(e.position)
      if (!p) return
      inspectCustomPoint(p.lat, p.lon)
    }, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      const site = siteAt(e.endPosition)
      const entity = site ? markers.current.sites.find((m) => siteByMarker.current.get(m) === site) : undefined
      const h = hover.current
      if (entity !== h.entity) {
        h.prev = h.entity
        h.prevSince = performance.now()
        h.entity = entity
        h.since = performance.now()
        viewer.scene.canvas.style.cursor = entity ? 'pointer' : ''
      }
    }, ScreenSpaceEventType.MOUSE_MOVE)
    return () => handler.destroy()
  }, [ready, bundle, inspectCustomPoint, inspectPit])

  // ---- site analysis ----
  const timeline = useMemo(() => {
    if (!selected || !ephemeris || !analysisPeriodInWindow) return []
    const duration = scorePeriod[1] - scorePeriod[0]
    const step = duration > 90 * DAY ? 6 * 3600_000 : 3600_000
    const samples = computeTimeline(ephemeris, selected, selected.horizon, scorePeriod[0], scorePeriod[1], step)
    if (samples.length && samples[samples.length - 1].t < scorePeriod[1]) {
      samples.push(...computeTimeline(ephemeris, selected, selected.horizon, scorePeriod[1], scorePeriod[1]))
    }
    return samples
  }, [selected, ephemeris, scorePeriod, analysisPeriodInWindow])
  const timelineSummaryIndex = useMemo(() => indexTimeline(timeline), [timeline])
  const sunCycle = useMemo(() => {
    if (!selected || !ephemeris) return undefined
    const range = ephemerisRange(ephemeris)
    const transitions = findSunTransitions(ephemeris, selected, selected.horizon)
    const nightTransitions = findSunTransitions(ephemeris, selected, selected.horizon, 0)
    const initialSunlight = nightTransitions.length
      ? !nightTransitions[0].daylight
      : computeTimeline(ephemeris, selected, selected.horizon, range[0], range[0])[0]?.sunVisibleFrac > 0
    return {
      range,
      transitions,
      darkIntervals: darkIntervalsFromTransitions(range[0], range[1], initialSunlight, nightTransitions),
    }
  }, [selected, ephemeris])
  const summaryStart = landingDay !== undefined ? scorePeriod[0] : t
  const summary = useMemo(() => {
    if (!timeline.length || !selected || !ephemeris || !sunCycle) return undefined
    const s = summarizeIndexed(timelineSummaryIndex, summaryStart)
    const step = timeline.length > 1 ? timeline[1].t - timeline[0].t : 3600_000
    return {
      ...s,
      longestDarkH: longestFullNightHFromIntervals(
        sunCycle.darkIntervals, sunCycle.range, summaryStart, scorePeriod[1], step,
      ),
    }
  }, [timeline, timelineSummaryIndex, summaryStart, selected, ephemeris, scorePeriod, sunCycle])
  const now = useMemo(() => (selected && ephemeris && analysisPeriodInWindow ? computeTimeline(ephemeris, selected, selected.horizon, t, t)[0] : undefined), [selected, ephemeris, t, analysisPeriodInWindow])
  // first person: "look at" buttons for the Sun / Earth, offered when the body is above the local
  // terrain horizon or within 2 deg of clearing it
  const lookTargets = useMemo(() => {
    if (!terrainViewActive || !now || !selected) return { sun: false, earth: false }
    const margin = (el: number, az: number) => el - horizonAt(selected.horizon, az)
    return { sun: margin(now.sunEl, now.sunAz) > -2, earth: margin(now.earthEl, now.earthAz) > -2 }
  }, [terrainViewActive, now, selected])
  const lookAt = useCallback((body: 'sun' | 'earth') => {
    const viewer = sceneRef.current?.viewer
    if (!viewer || !ephemeris) return
    const camera = viewer.camera
    const p = body === 'sun' ? sunPosition(ephemeris, t) : earthPosition(ephemeris, t)
    const cam = camera.positionWC
    const dir = Cartesian3.normalize(Cartesian3.subtract(new Cartesian3(...p), cam, new Cartesian3()), new Cartesian3())
    // heading / elevation of the body in the camera's local east-north-up frame
    const up = Cartesian3.normalize(cam, new Cartesian3())
    const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, new Cartesian3()), new Cartesian3())
    const north = Cartesian3.cross(up, east, new Cartesian3())
    const h1 = Math.atan2(Cartesian3.dot(dir, east), Cartesian3.dot(dir, north))
    const p1 = Math.asin(Math.max(-1, Math.min(1, Cartesian3.dot(dir, up))))
    const h0 = camera.heading, p0 = camera.pitch
    const dh = ((h1 - h0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI // shortest way round
    const start = performance.now()
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / 600), e = k * k * (3 - 2 * k)
      camera.setView({ orientation: { heading: h0 + dh * e, pitch: p0 + (p1 - p0) * e, roll: 0 } })
      viewer.scene.requestRender()
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }, [ephemeris, t])

  // ---- first-person controls: the eye stays EYE_HEIGHT_M above the rendered terrain; dragging turns
  //      the view (heading) and tilts it up / down (elevation), never rolls; the wheel zooms (field of view).
  //      Cesium's own camera controls and collision push-up are off meanwhile. ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!terrainViewActive || !scene) return
    const viewer = scene.viewer, camera = viewer.camera, ctrl = viewer.scene.screenSpaceCameraController
    const saved = { inputs: ctrl.enableInputs, collision: ctrl.enableCollisionDetection }
    ctrl.enableInputs = false
    ctrl.enableCollisionDetection = false
    const frustum = camera.frustum as PerspectiveFrustum
    const fov0 = frustum.fov
    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    let last: Cartesian2 | null = null
    handler.setInputAction((e: { position: Cartesian2 }) => { last = Cartesian2.clone(e.position) }, ScreenSpaceEventType.LEFT_DOWN)
    handler.setInputAction(() => { last = null }, ScreenSpaceEventType.LEFT_UP)
    handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      if (!last) return
      const k = (frustum.fovy ?? Math.PI / 3) / Math.max(viewer.scene.canvas.clientHeight, 1) // the scene follows the pointer
      const dx = e.endPosition.x - last.x, dy = e.endPosition.y - last.y
      last = Cartesian2.clone(e.endPosition)
      const pitch = Math.max(-1.55, Math.min(1.55, camera.pitch + dy * k))
      camera.setView({ orientation: { heading: camera.heading - dx * k, pitch, roll: 0 } })
      viewer.scene.requestRender()
    }, ScreenSpaceEventType.MOUSE_MOVE)
    let lastHud = ''
    const offHud = viewer.scene.postRender.addEventListener(() => {
      const fovy = frustum.fovy ?? Math.PI / 3
      const fovx = 2 * Math.atan(Math.tan(fovy / 2) * (frustum.aspectRatio ?? 1.6))
      const next = { heading: CMath.toDegrees(camera.heading), pitch: CMath.toDegrees(camera.pitch), fovx: CMath.toDegrees(fovx), fovy: CMath.toDegrees(fovy) }
      const key = `${next.heading.toFixed(1)}|${next.pitch.toFixed(1)}|${next.fovy.toFixed(1)}`
      if (key !== lastHud) { lastHud = key; setHud(next) }
    })
    handler.setInputAction((delta: number) => {
      // down to 0.5 deg: the Earth (1.9 deg across) can fill the view, the Sun's disc shows its size
      frustum.fov = Math.max(CMath.toRadians(0.5), Math.min(CMath.toRadians(100), (frustum.fov ?? Math.PI / 3) * (delta > 0 ? 0.9 : 1.1)))
      viewer.scene.requestRender()
    }, ScreenSpaceEventType.WHEEL)
    return () => {
      handler.destroy()
      offHud()
      setHud(null)
      ctrl.enableInputs = saved.inputs
      ctrl.enableCollisionDetection = saved.collision
      frustum.fov = fov0
    }
  }, [terrainViewActive])
  // solar eclipses seen from the selected site during the analysis period (Earth in front of the Sun, Sun above the horizon)
  const eclipses = useMemo(() => (selected && ephemeris && analysisPeriodInWindow
    ? siteEclipses(ephemeris, selected, scorePeriod[0], scorePeriod[1], (az, el, r) => sunVisibleOver(selected.horizon, az, el, r))
    : []), [selected, ephemeris, analysisPeriodInWindow, scorePeriod])
  const sunlightCountdown = useMemo(() => {
    if (!now) return undefined
    // during a solar eclipse (Earth in front of the Sun, Sun above the terrain horizon) the status says so,
    // with the time until the Earth uncovers the Sun at this site
    if (selected && ephemeris && now.eclipseFrac > 0) {
      const ev = siteEclipses(ephemeris, selected, t - 8 * 3600_000, t + 8 * 3600_000, (az, el, r) => sunVisibleOver(selected.horizon, az, el, r))
        .find((e) => e.start <= t && t <= e.end + 120_000)
      if (ev) return { daylight: false, eclipse: { cover: now.eclipseFrac, total: ev.total }, remainingMs: Math.max(0, ev.end + 120_000 - t) }
    }
    const next = nextSunTransition(sunCycle?.transitions ?? [], t)
    return { daylight: now.sunVisibleFrac > 0.5, remainingMs: next ? next.t - t : undefined }
  }, [now, sunCycle, t, selected, ephemeris])
  // ---- DSN link: Goldstone / Madrid / Canberra, lunar terrain horizon included (lib/dsn.ts) ----
  // ---- solar power: terrain shadows, Sun elevation, distance and Earth eclipses (lib/power.ts) ----
  const powerTl = useMemo(() => {
    if (!selected || !ephemeris || !analysisPeriodInWindow) return []
    const duration = scorePeriod[1] - scorePeriod[0]
    const step = duration > 90 * DAY ? 3 * 3600_000 : 3600_000
    const samples = powerTimeline(ephemeris, selected, selected.horizon, scorePeriod[0], scorePeriod[1], step, panel)
    if (samples.length && samples[samples.length - 1].t < scorePeriod[1]) {
      samples.push(powerAt(ephemeris, selected, selected.horizon, scorePeriod[1], panel))
    }
    return samples
  }, [selected, ephemeris, scorePeriod, panel, analysisPeriodInWindow])
  const powerSummary = useMemo(() => summarizePower(powerTl, summaryStart), [powerTl, summaryStart])
  const dsnNow = useMemo(() => (selected && ephemeris && analysisPeriodInWindow ? dsnAt(ephemeris, selected, selected.horizon, t) : undefined), [selected, ephemeris, t, analysisPeriodInWindow])
  // ---- landing score (lib/landingScore.ts): temperature, radiation, slope, telecom, sunlight ----
  // The score refers to the same period as the global heatmaps (temperature, radiation).
  // Samples are capped at about 45 000 over long intervals and never finer than 15 min.
  const scoreStep = Math.max(900_000, Math.ceil((scorePeriod[1] - scorePeriod[0]) / 45_000 / 900_000) * 900_000)
  const dsnTl = useMemo(() => {
    if (!selected || !ephemeris || !analysisPeriodInWindow) return []
    return dsnTimeline(ephemeris, selected, selected.horizon, scorePeriod[0], scorePeriod[1], scoreStep)
  }, [selected, ephemeris, scorePeriod, scoreStep, analysisPeriodInWindow])
  // Hourly sunlight + surface temperature at the site over the period (lib/regolith.ts).
  const walkSeries = useMemo(() => {
    if (!selected || !ephemeris || !analysisPeriodInWindow) return undefined
    return siteThermalSeries(ephemeris, selected, selected.horizon, scorePeriod[0], scorePeriod[1], 3600_000, bundle?.fields.dem_south)
  }, [selected, ephemeris, scorePeriod, bundle, analysisPeriodInWindow])
  // sunlight criterion: share of the period sunlit, weighted by the share of the Sun's light visible
  // (an hour at 30 % counts 0.3 h), and longest night (no direct sunlight above the horizon)
  const sunStats = useMemo(() => {
    if (!walkSeries) return undefined
    let lit = 0, run = 0, longest = 0
    walkSeries.sunlit.forEach((_, i) => {
      lit += walkSeries.light[i]
      run = walkSeries.light[i] > 0 ? 0 : run + 1
      longest = Math.max(longest, run)
    })
    return { pct: (100 * lit) / walkSeries.sunlit.length, longestDarkH: longest * walkSeries.stepH }
  }, [walkSeries])
  const landing = useMemo(() => {
    if (!selected || !analysisPeriodInWindow) return undefined
    const env = siteEnvForPeriod?.env ?? undefined
    // slope: max inside the landing footprint (slope pyramid); without it the terrain slope at the point
    const fp = footprintSlopeDeg
    const slope = fp !== undefined && Number.isFinite(fp)
      ? scoreSlope(fp, footprintLabel(score.footprint).replace(/^(circle|ellipse)/, 'landing $1'), advancedSettings)
      : env && Number.isFinite(env.slopeDeg) ? scoreSlope(env.slopeDeg, 'terrain (global estimate, no footprint)', advancedSettings) : undefined
    let telecom
    if (dsnTl.length > 1) {
      const stepH = (dsnTl[1].t - dsnTl[0].t) / 3600_000
      let gap = 0, longest = 0
      for (const x of dsnTl) { gap = x.any ? 0 : gap + 1; longest = Math.max(longest, gap) }
      telecom = scoreTelecom((100 * dsnTl.filter((x) => x.any).length) / dsnTl.length, longest * stepH, advancedSettings)
    }
    return combine([
      env ? scoreTemperature(env.tMeanK - 273.15, env.tMinK - 273.15, env.tMaxK - 273.15, advancedSettings) : undefined,
      env ? scoreRadiation(env.doseUGyH, (scorePeriod[1] - scorePeriod[0]) / 3600_000, advancedSettings) : undefined,
      slope,
      telecom,
      sunStats ? scoreSunlight(sunStats.pct, advancedSettings) : undefined,
    ], ['temperature', 'radiation', 'slope', 'telecommunications', 'sunlight'])
  }, [selected, siteEnvForPeriod, footprintSlopeDeg, score.footprint, dsnTl, sunStats, scorePeriod, analysisPeriodInWindow, advancedSettings])

  // ---- crew outside the habitat: AxEMU suit + NASA-STD-3001 limits (lib/human.ts), same period ----
  const human = useMemo(() => {
    const env = siteEnvForPeriod?.env
    if (!env || !walkSeries || !analysisPeriodInWindow) return undefined
    return assessHuman(env.doseUGyH, walkSeries, (scorePeriod[1] - scorePeriod[0]) / 86400_000, missionInWindow || landingDay !== undefined, advancedSettings)
  }, [siteEnvForPeriod, walkSeries, scorePeriod, missionInWindow, landingDay, analysisPeriodInWindow, advancedSettings])

  const loadEphemerisData = async (load: () => Promise<NonNullable<DataBundle['ephemeris']>>) => {
    const request = ++ephemerisRequest.current
    setPlaying(false)
    setEphemerisBusy(true)
    setEphemerisError(undefined)
    try {
      const nextEphemeris = await load()
      if (request !== ephemerisRequest.current) return false
      setEphemeris(nextEphemeris)
      setTimeRange(ephemerisRange(nextEphemeris))
      return true
    } catch (error) {
      if (request === ephemerisRequest.current) setEphemerisError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (request === ephemerisRequest.current) setEphemerisBusy(false)
    }
  }

  const cancelEphemerisLoad = () => {
    ephemerisRequest.current++
    setEphemerisBusy(false)
    setEphemerisError(undefined)
  }

  const selectCalendarDate = async (nextTime: number) => {
    const year = new Date(nextTime).getUTCFullYear()
    if (year < EPHEMERIS_START_YEAR || year > EPHEMERIS_LAST_SELECTABLE_YEAR) return
    if (nextTime >= timeRange[0] && nextTime <= timeRange[1]) {
      cancelEphemerisLoad()
      setT(nextTime)
      return
    }

    if (await loadEphemerisData(() => loadEphemerisWindow(DATA_URL, year))) setT(nextTime)
  }

  const changeMission = (missionUpdate: Mission) => {
    const next = { ...missionUpdate }
    if (next.landingDayEnabled && next.landingDay !== undefined &&
      next.start !== undefined && next.end !== undefined && next.end > next.start) {
      const firstDay = Math.floor(next.start / DAY) * DAY
      const lastDay = Math.floor(next.end / DAY) * DAY
      next.landingDay = Math.min(Math.max(Math.floor(next.landingDay / DAY) * DAY, firstDay), lastDay)
    }
    setMission(next)

    const withinLoadedRange = (start: number, end: number) => start >= timeRange[0] && end <= timeRange[1]
    if (next.landingDayEnabled && next.landingDay !== undefined) {
      const dayStart = Math.floor(next.landingDay / DAY) * DAY
      const dayEnd = dayStart + DAY
      if (withinLoadedRange(dayStart, dayEnd)) { cancelEphemerisLoad(); return }
      const year = new Date(dayStart).getUTCFullYear()
      void loadEphemerisData(() => loadEphemerisWindow(DATA_URL, year))
      return
    }
    if (next.start !== undefined && next.end !== undefined && next.end > next.start) {
      if (withinLoadedRange(next.start, next.end)) { cancelEphemerisLoad(); return }
      void loadEphemerisData(() => loadEphemerisRange(DATA_URL, next.start!, next.end!))
      return
    }

    const target = next.start ?? next.end
    if (target !== undefined && !withinLoadedRange(target, target)) {
      const year = new Date(target).getUTCFullYear()
      if (year >= EPHEMERIS_START_YEAR && year <= EPHEMERIS_LAST_SELECTABLE_YEAR) {
        void loadEphemerisData(() => loadEphemerisWindow(DATA_URL, year))
        return
      }
    }
    cancelEphemerisLoad()
  }

  const resetTimeline = () => {
    if (!bundle?.ephemeris) return
    ephemerisRequest.current++
    setEphemerisBusy(false)
    setPlaying(false)
    setMission({})
    setEphemeris(bundle.ephemeris)
    setTimeRange([DEFAULT_TIME_START, DEFAULT_TIME_END])
    setT(DEFAULT_TIME_START)
    setEphemerisError(undefined)
  }

  const selectSite = (s: Site) => {
    stopTerrainView(false)
    setInspect(undefined)
    if (markers.current.custom && sceneRef.current) {
      sceneRef.current.viewer.entities.remove(markers.current.custom)
      markers.current.custom = undefined
    }
    setSelected(s)
    if (sceneRef.current) flyToSite(sceneRef.current.viewer, s.lat, s.lon)
  }

  // ✕ in the left panel: close the analysis of the selected point / site
  const clearSelection = () => {
    stopTerrainView(false)
    setInspect(undefined)
    if (markers.current.custom && sceneRef.current) {
      sceneRef.current.viewer.entities.remove(markers.current.custom)
      markers.current.custom = undefined
    }
    setSelected(undefined)
    setSitePanelExpanded(false)
  }
  clickActions.current = { selectSite, clearSelection, hasSelection: !!selected }

  const saveSelectedSite = (name: string) => {
    if (!selected || (selected.group !== 'Custom' && selected.group !== 'Saved')) return
    const saved: Site = { ...selected, name: name.trim(), group: 'Saved' }
    const nextSites = savedSites.some((site) => site.id === saved.id)
      ? savedSites.map((site) => site.id === saved.id ? saved : site)
      : [...savedSites, saved]
    if (markers.current.custom && sceneRef.current) {
      sceneRef.current.viewer.entities.remove(markers.current.custom)
      markers.current.custom = undefined
    }
    setSavedSitesState({ sites: nextSites })
    setSelected(saved)
  }

  const removeSavedSite = (site: Site) => {
    const nextSites = savedSites.filter((saved) => saved.id !== site.id)
    setSavedSitesState({ sites: nextSites })
    if (selected?.id === site.id) {
      setSelected(undefined)
      setInspect(undefined)
    }
  }

  const removeSelectedSite = () => {
    if (selected?.group === 'Saved') removeSavedSite(selected)
  }

  const comparisonDisabledReason = savedSites.length < 2 ? undefined
    : !ephemeris ? 'Ephemeris data are required for a mission-site comparison.'
      : !heat ? 'Global terrain tiles are not available; saved-site scores cannot be calculated.'
        : !analysisPeriodInWindow ? 'The selected analysis interval is outside the loaded ephemeris window.'
          : !heatWindowMatchesPeriod ? 'The heatmap engine is still preparing the selected analysis interval.'
            : undefined
  const runSavedSitesComparison = async (
    onProgress: (completed: number, total: number) => void,
    signal: AbortSignal,
  ) => {
    if (!ephemeris || !heat || !analysisPeriodInWindow || !heatWindowMatchesPeriod) {
      throw new Error(comparisonDisabledReason ?? 'Site comparison data are not ready.')
    }
    return compareSavedSites({
      sites: savedSites,
      ephemeris,
      heat,
      period: scorePeriod,
      isMission: missionInWindow || landingDay !== undefined,
      settings: advancedSettings,
      footprint: score.footprint,
      slopeMax,
      dem: bundle?.fields.dem_south,
      onProgress,
      signal,
    })
  }

  return (
    <div className="app">
      <div ref={containerRef} className="globe" />
      <header className={`brand${terrainViewActive ? (sitePanelExpanded ? ' fpv beside-expanded' : ' fpv') : ''}`}>
        <div className="brand-title">
          <h1>ByteTheMoon</h1>
          {!terrainViewActive && (
            <button type="button" className="insights-button" title={INSIGHTS_BUTTON.title}
              onClick={() => setInsights('welcome')}>{INSIGHTS_BUTTON.label}</button>
          )}
        </div>
        <span className="muted">Lunar Landing Site Navigator{sceneRef.current && ` · basemap: ${sceneRef.current.basemap === 'ion' ? 'Cesium Moon 3D' : 'NASA Moon Trek'}`}</span>
      </header>
      {bundle && (
        <>
          <aside className={`side left${sitePanelExpanded ? ' expanded' : ''}`}>
            <SitePanel sites={allSites} selected={selected} onSelect={selectSite} onSearchCoordinates={searchCoordinates}
              regionFiltersPanel={
                <RegionFiltersPanel filters={regionFilters} onChange={setRegionFilters}
                  periodHours={filterPeriod.hours} periodLabel={filterPeriod.label}
                  available={!!heat} periodReady={filterPeriod.ready} error={filterDataError}
                  busy={!filterDataError && ((regionFilters.ice.on && !iceDistance) || (regionFilters.pits.on && !pitDistance))} />
              }
              onGenerateReport={() => { setPlaying(false); setReportFormat('pdf'); setReportOpen(true) }}
              onGenerateCsv={() => { setPlaying(false); setReportFormat('csv'); setReportOpen(true) }}
              reportDisabled={!ephemeris || !analysisPeriodInWindow || !heatWindowMatchesPeriod || (!!heat && !siteEnvForPeriod)}
              timeline={timeline} summary={summary}
              now={now} nowMs={t} sunlightCountdown={sunlightCountdown} eclipses={eclipses}
              periodLabel={landingDay !== undefined ? 'Landing day' : missionValid ? 'Mission interval' : 'Loaded ephemeris interval'} inspect={inspect}
              expanded={sitePanelExpanded} onToggleExpanded={() => setSitePanelExpanded((expanded) => !expanded)} onClose={clearSelection}
              showSiteMarkers={showSiteMarkers} onShowSiteMarkersChange={setShowSiteMarkers}
              onSaveSite={saveSelectedSite} onRemoveSite={removeSelectedSite}
              onRemoveSavedSite={removeSavedSite}
              savedSites={savedSites} comparisonPeriod={scorePeriod} comparisonPeriodLabel={periodLabel}
              comparisonDisabledReason={comparisonDisabledReason} compareSavedSites={runSavedSitesComparison}
              savedSitesError={savedSitesError}
              env={analysisPeriodInWindow && siteEnvKey ? { env: siteEnvForPeriod?.env ?? undefined, loading: !siteEnvForPeriod } : undefined}
              dsn={ephemeris ? { now: dsnNow } : undefined}
              power={ephemeris ? { panel, onPanel: setPanel, summary: powerSummary } : undefined}
              landing={landing ? { result: landing, period: scorePeriod, periodLabel, human, settings: advancedSettings } : undefined}
              terrainViewActive={terrainViewActive} terrainViewLoading={terrainViewLoading}
              terrainViewError={terrainViewError} onToggleTerrainView={() => void toggleTerrainView()} />
          </aside>
          {/* first person: Back, just right of the left panel (follows it when expanded) */}
          {terrainViewActive && (
            <button type="button" className={`terrain-view-controls fpv-back${sitePanelExpanded ? ' beside-expanded' : ''}`} onClick={() => stopTerrainView(true)}
              title={nightView !== null ? `Back to the map · night: lit by earthshine only (${(nightView * 110_000).toFixed(1)} lux, ${(nightView * 1e5).toFixed(2)}e-5 of sunlight), shown brightened ×${NIGHT_EXPOSURE} like a dark-adapted eye` : 'Back to the map'}>
              ← Back{nightView !== null && <span className="fpv-night"> · night (earthshine)</span>}
            </button>
          )}
          {settingsOpen && (
            <SettingsDialog
              settings={advancedSettings}
              footprint={score.footprint}
              mapRadiusKm={score.radiusKm}
              display={display}
              gpu={gpuInfo}
              onSave={(settings, footprint, radiusKm, nextDisplay) => {
                setAdvancedSettings(settings)
                setScore((current) => ({ ...current, footprint, radiusKm }))
                setDisplay(nextDisplay)
                setSettingsOpen(false)
              }}
              onCancel={() => setSettingsOpen(false)}
            />
          )}
          {/* outside the scrolling column, so it stays visible at the top */}
          <button type="button" className="settings-button floating" onClick={() => setSettingsOpen(true)}
            aria-label="Open settings" title="Settings" data-tour="advanced-settings-button">
            <span aria-hidden="true">⚙</span>
          </button>
          <aside className="side right">
            {bundle.ephemeris && (
              <MissionPanel mission={mission} onChange={changeMission} range={timeRange} calendarRange={CALENDAR_RANGE}
                status={{
                  state: ephemerisBusy ? 'loading'
                    : !missionValid && landingDay === undefined ? 'idle'
                      : analysisPeriodInWindow ? 'ready' : 'outside',
                }} />
            )}
            <LayerPanel layers={displayLayers} state={layerState} onChange={(id, s) => setLayerState((x) => ({ ...x, [id]: s }))}
              score={score} onScore={setScore} scoreAvailable={!!(heat && heatVersion)}
              radiationMetadata={radiationDisplayMeta}
              radiationLoading={radiationLoading} radiationError={radiationError}
              radiationVisible={radiationVisible} onRadiationVisible={setRadiationVisible}
              radiationOpacity={radiationOpacity} onRadiationOpacity={setRadiationOpacity}
              radiationMode={radiationMode} onRadiationMode={setRadiationMode}
              iceVisible={iceVisible} onIceVisible={setIceVisible} iceError={iceError}
              pitsVisible={pitsVisible} onPitsVisible={setPitsVisible} pitsError={pitsError}
              reach={reach} onReach={setReach}
              reachInfo={{ available: !!heat && selLat !== undefined, maxDeg: moveSlope, radiusKm: display.reachRadiusKm, status: reachStatus }} />
            {sceneRef.current && (
              <BasemapPanel basemap={sceneRef.current.basemap} state={basemapState} onChange={setBasemapState} viewResM={viewResM} />
            )}
            {bundle.warnings.length > 0 && (
              <section className="panel warn">
                <h2>Setup</h2>
                {bundle.warnings.map((w) => <p key={w}>{w}</p>)}
              </section>
            )}
          </aside>
          {bundle.ephemeris && ephemeris && (
            <TimeBar t={t} range={timeRange} navigationRange={navigationRange}
              calendarRange={landingDay !== undefined ? navigationRange : missionInWindow ? navigationRange : CALENDAR_RANGE} onChange={setT}
              onCalendarChange={selectCalendarDate} onReset={resetTimeline} playing={playing} onPlay={setPlaying}
              stepMs={stepMs} onStep={setStepMs} lighting={lighting} onLighting={setLighting}
              busy={ephemerisBusy} error={ephemerisError} mission={mission} onMission={setMission} />

          )}
          {terrainViewActive && hud && (
            <FpvHud heading={hud.heading} pitch={hud.pitch} fovxDeg={hud.fovx} fovyDeg={hud.fovy}
              bodies={now ? [
                { name: 'Sun', icon: '☀', az: now.sunAz, el: now.sunEl, color: '#ffd76a' },
                { name: 'Earth', icon: '◐', az: now.earthAz, el: now.earthEl, color: '#8fc4ff' },
              ] : []} />
          )}
          {terrainViewActive && (lookTargets.sun || lookTargets.earth) && (
            <div className="look-at-buttons" role="group" aria-label="Turn the camera toward">
              {lookTargets.sun && <button type="button" onClick={() => lookAt('sun')} title="Turn the camera toward the Sun">☀ Sun</button>}
              {lookTargets.earth && <button type="button" onClick={() => lookAt('earth')} title="Turn the camera toward the Earth">◐ Earth</button>}
            </div>
          )}
          {viewResM !== undefined && Number.isFinite(viewResM) && viewResM > 0 && (
            <div className="map-scale" role="img"
              aria-label={`1 cm on screen corresponds to about ${formatScaleDistance(viewResM * CSS_PIXELS_PER_CM)} on the Moon`}
              title="Estimate at the map center; 1 cm uses the standard CSS scale.">
              <span>≈ {formatScaleDistance(viewResM * CSS_PIXELS_PER_CM)} on the Moon</span>
              <div className="map-scale-ruler" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              {cameraAltM !== undefined && <span className="map-altitude">Altitude {formatScaleDistance(cameraAltM)} above terrain</span>}
            </div>
          )}
          {reportOpen && selected && ephemeris && (
            <TechnicalReportDialog
              key={selected.id}
              site={selected}
              format={reportFormat}
              ephemeris={ephemeris}
              heat={heat}
              panel={panel}
              env={siteEnvForPeriod?.env ?? undefined}
              temperatureSeries={walkSeries}
              panoramaTimeline={timeline}
              panoramaNow={now}
              currentMs={t}
              period={reportPeriod}
              periodSource={reportPeriodSource}
              overlays={reportOverlays}
              captureMap={captureMapForReport}
              onClose={closeReport}
            />
          )}
        </>
      )}
      {!ready && <div className="loading">Loading the Moon…</div>}
      {insights === 'welcome' && (
        <WelcomeModal onStartTutorial={() => setInsights('tutorial')} onClose={() => setInsights(null)} />
      )}
      {insights === 'tutorial' && <Tutorial onClose={() => setInsights(null)} />}
    </div>
  )
}
