import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ConstantPositionProperty,
  Ellipsoid,
  type Entity,
  ImageryLayer,
  LabelStyle,
  Math as CMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
} from 'cesium'
import { createMoonScene, flyToSite, setSunDirection, setSunLighting, viewFromEarth, type MoonScene } from './cesium/createViewer'
import { asProvider, FieldImageryProvider, levelForResolution } from './cesium/FieldImageryProvider'
import { computeHorizon, computeTimeline, summarize } from './lib/analysis'
import { DATA_URL, loadBundle, type DataBundle, type Site } from './lib/data'
import { footprintMax, hillshade, loadRaster } from './lib/raster'
import { DEFAULT_FOOTPRINT, footprintAxes, SLOPE_MAX_DEG } from './lib/requirements'
import {
  earthPosition,
  ephemerisRange,
  EPHEMERIS_LAST_SELECTABLE_YEAR,
  EPHEMERIS_START_YEAR,
  EPHEMERIS_WINDOW_YEARS,
  loadEphemerisWindow,
  sunPosition,
} from './lib/ephemeris'
import { loadRadiationMetadata, radiationLayerMeta, type RadiationOverlayMetadata } from './lib/radiation'
import { BasemapPanel, type BasemapState } from './components/BasemapPanel'
import { LayerPanel, type LayerState, type ScoreWeights } from './components/LayerPanel'
import { SitePanel } from './components/SitePanel'
import { dsnAt } from './lib/dsn'
import { DEFAULT_PANEL, powerTimeline, summarizePower, type PanelConfig } from './lib/power'
import { TimeBar } from './components/TimeBar'

const DAY = 86400_000
const CSS_PIXELS_PER_CM = 96 / 2.54
const DEFAULT_TIME_START = Date.UTC(EPHEMERIS_START_YEAR, 0, 1)
const DEFAULT_TIME_END = Date.UTC(EPHEMERIS_START_YEAR + EPHEMERIS_WINDOW_YEARS, 0, 1)
const CALENDAR_RANGE: [number, number] = [
  DEFAULT_TIME_START,
  Date.UTC(EPHEMERIS_LAST_SELECTABLE_YEAR, 11, 31, 23, 59),
]
const D2R = Math.PI / 180
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

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<MoonScene | null>(null)
  const layerRefs = useRef<Record<string, ImageryLayer>>({})
  const radiationLayerRef = useRef<ImageryLayer | null>(null)
  const radiationOpacityRef = useRef(0.7)
  const markers = useRef<{ sun?: Entity; earth?: Entity; custom?: Entity; sites: Entity[] }>({ sites: [] })

  const [ready, setReady] = useState(false)
  const [bundle, setBundle] = useState<DataBundle | null>(null)
  const [ephemeris, setEphemeris] = useState<DataBundle['ephemeris']>(null)
  const [timeRange, setTimeRange] = useState<[number, number]>([DEFAULT_TIME_START, DEFAULT_TIME_END])
  const [ephemerisBusy, setEphemerisBusy] = useState(false)
  const [ephemerisError, setEphemerisError] = useState<string>()
  const [layerState, setLayerState] = useState<Record<string, LayerState>>({})
  const [score, setScore] = useState<ScoreWeights>({ enabled: false, sun: 0.5, earth: 0.3, maxSlope: 8, footprint: DEFAULT_FOOTPRINT, opacity: 0.7 })
  const [panel, setPanel] = useState<PanelConfig>(DEFAULT_PANEL) // solar arrays
  const [t, setT] = useState(() => Date.now()) // start at the current UTC time (clamped to the ephemeris on load)
  const [playing, setPlaying] = useState(false)
  const [lighting, setLighting] = useState(false)
  const [stepMs, setStepMs] = useState(3600_000)
  const [selected, setSelected] = useState<Site>()
  const [showSiteMarkers, setShowSiteMarkers] = useState(true)
  const [windowDays, setWindowDays] = useState(30)
  const [sitePanelExpanded, setSitePanelExpanded] = useState(false)
  const [inspect, setInspect] = useState<{ lat: number; lon: number; values: { title: string; value: string }[] }>()
  const [radiationMetadata, setRadiationMetadata] = useState<RadiationOverlayMetadata | null>(null)
  const [radiationLoading, setRadiationLoading] = useState(true)
  const [radiationError, setRadiationError] = useState<string>()
  const [radiationVisible, setRadiationVisible] = useState(false)
  const [radiationOpacity, setRadiationOpacity] = useState(0.7)
  const [radiationMode, setRadiationMode] = useState<'classes' | 'continuous'>('classes')

  radiationOpacityRef.current = radiationOpacity
  const [basemapState, setBasemapState] = useState<BasemapState>({ kaguya: true, nacPolar: true, nacSites: true, relief: true })
  const [viewResM, setViewResM] = useState<number>()

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
        const t0 = Math.min(Math.max(Date.now(), a), b)
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

  // ---- default overlay base: keep a readable, useful stack on first load ----
  useEffect(() => {
    if (!bundle || Object.keys(layerState).length) return
    const defaults: Record<string, LayerState> = {}
    for (const meta of bundle.layers) {
      defaults[meta.id] = { visible: meta.id === 'sun_avg', opacity: 0.65 }
    }
    setLayerState(defaults)
  }, [bundle, layerState])

  // ---- site markers ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !bundle) return
    markers.current.sites.forEach((e) => scene.viewer.entities.remove(e))
    markers.current.sites = bundle.sites.map((s) =>
      scene.viewer.entities.add({
        position: Cartesian3.fromDegrees(s.lon, s.lat, 0, Ellipsoid.MOON),
        point: {
          pixelSize: 9,
          color: FUTURE_SITE_GROUPS.has(s.group) ? Color.DODGERBLUE : Color.RED,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: 500_000,
        },
        label: {
          text: s.name, font: '13px system-ui', style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3,
          verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -12),
          disableDepthTestDistance: 500_000, // always on top nearby, hidden behind the Moon from afar
        },
      }),
    )
  }, [ready, bundle])

  useEffect(() => {
    markers.current.sites.forEach((marker) => {
      marker.show = showSiteMarkers
    })
  }, [showSiteMarkers, ready, bundle])

  // ---- photo basemap toggles (Moon Trek LOD stack) ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    for (const g of ['kaguya', 'nacPolar', 'nacSites'] as const) scene.photo[g].forEach((l) => (l.show = basemapState[g]))
  }, [ready, basemapState])

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
    })), { alpha: 0.75 })
    scene.overlays.add(layer, scene.photo.wac.length + scene.photo.kaguya.length)
    return () => { scene.overlays.remove(layer, true) }
  }, [ready, bundle, basemapState.relief])

  // ---- approximate ground resolution at the screen centre (for the basemap panel) ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    const { camera, canvas } = scene.viewer.scene
    camera.percentageChanged = 0.05
    const update = () => {
      const h = camera.positionCartographic.height
      const fovy = (camera.frustum as { fovy?: number }).fovy ?? Math.PI / 3
      setViewResM((2 * h * Math.tan(fovy / 2)) / Math.max(canvas.clientHeight, 1))
    }
    update()
    return camera.changed.addEventListener(update)
  }, [ready])

  // ---- raster overlays (one ImageryLayer per visible layer) ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !bundle) return
    bundle.layers.forEach((meta) => {
      const field = bundle.fields[meta.id]
      const st = layerState[meta.id]
      let layer = layerRefs.current[meta.id]
      if (!field || !st?.visible) {
        if (layer) layer.show = false
        return
      }
      if (!layer) {
        const contrast = meta.id.includes('sun') || meta.id.includes('earth') ? 1.25 : meta.id.includes('slope') ? 1.4 : 1.15
        layer = new ImageryLayer(asProvider(new FieldImageryProvider({
          value: (lon, lat) => field.sampleNearest(lon, lat),
          min: meta.min, max: meta.max, colormap: meta.colormap,
          boundsRad: field.boundsRad(),
          maximumLevel: levelForResolution(meta.resolutionM),
          credit: meta.source,
          contrast,
        })))
        scene.overlays.add(layer)
        layerRefs.current[meta.id] = layer
      }
      layer.show = true
      layer.alpha = st.opacity
    })
  }, [ready, bundle, layerState])

  // ---- derived "landing suitability" heatmap, rebuilt when weights change ----
  // Slope used here = MAX slope inside the chosen landing footprint (circle / ellipse) centred on each
  // point (see lib/requirements.ts). Base raster: the pipeline layer slope_max (each 100 m pixel = max of
  // the 40 m LDSM inside it); fallback: the 100 m slope layer (averaged, so steep spots are underestimated).
  // Recomputed (debounced) when the footprint changes.
  const [fpA, fpB, fpAz] = footprintAxes(score.footprint)
  const [fpKey, setFpKey] = useState(`${fpA},${fpB},${fpAz}`)
  useEffect(() => {
    const id = setTimeout(() => setFpKey(`${fpA},${fpB},${fpAz}`), 400) // wait for typing to stop
    return () => clearTimeout(id)
  }, [fpA, fpB, fpAz])
  const scoreFields = useMemo(() => {
    const f = bundle?.fields
    const base = f?.slope_max ?? f?.slope
    if (!f?.sun_avg || !f.earth_avg || !base) return null
    const [a, b, az] = fpKey.split(',').map(Number)
    return { sun: f.sun_avg, earth: f.earth_avg, slope: footprintMax(base, a, b, az), exact: !!f.slope_max }
  }, [bundle, fpKey])
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !scoreFields) return
    const old = layerRefs.current.__score
    if (old) { scene.overlays.remove(old, true); delete layerRefs.current.__score }
    if (!score.enabled) return
    const handle = setTimeout(() => {
      const { sun, earth, slope } = scoreFields
      const limit = Math.min(Math.max(score.maxSlope, 0.5), SLOPE_MAX_DEG)
      const wSum = score.sun + score.earth || 1
      const layer = new ImageryLayer(asProvider(new FieldImageryProvider({
        value: (lon, lat) => {
          const sl = slope.sampleNearest(lon, lat)
          if (!(sl <= limit)) return NaN // fails the slope requirement or no data -> transparent
          const s = sun.sampleNearest(lon, lat), e = earth.sampleNearest(lon, lat)
          if (Number.isNaN(s) || Number.isNaN(e)) return NaN
          return (score.sun * s + score.earth * e) / wSum
        },
        min: 0, max: 1, colormap: 'viridis',
        boundsRad: sun.boundsRad(),
        maximumLevel: levelForResolution(Math.max(sun.meta.resolutionM, slope.meta.resolutionM)),
      })), { alpha: score.opacity })
      scene.overlays.add(layer)
      layerRefs.current.__score = layer
    }, 150) // debounce slider drags
    return () => clearTimeout(handle)
  }, [ready, scoreFields, score])

  // ---- polar raster radiation overlay ----
  useEffect(() => {
    const scene = sceneRef.current
    const metadata = radiationMetadata
    if (!ready || !scene || !metadata || !radiationVisible) return

    let cancelled = false
    let layer: ImageryLayer | null = null
    setRadiationError(undefined)
    const meta = radiationLayerMeta(metadata, radiationMode)
    loadRaster(meta, `${import.meta.env.BASE_URL}radiation`).then((field) => {
      if (cancelled) return
      layer = new ImageryLayer(asProvider(new FieldImageryProvider({
        value: (lon, lat) => field.sampleNearest(lon, lat),
        min: meta.min,
        max: meta.max,
        colormap: meta.colormap,
        boundsRad: field.boundsRad(),
        maximumLevel: levelForResolution(meta.resolutionM),
        credit: meta.source,
      })), { alpha: radiationOpacityRef.current })
      scene.overlays.add(layer)
      radiationLayerRef.current = layer
    }).catch((error: unknown) => {
      if (!cancelled) setRadiationError(`Unable to load the radiation layer: ${error instanceof Error ? error.message : String(error)}`)
    })

    return () => {
      cancelled = true
      if (layer) {
        scene.overlays.remove(layer, true)
        if (radiationLayerRef.current === layer) radiationLayerRef.current = null
      }
    }
  }, [ready, radiationMetadata, radiationMode, radiationVisible])

  useEffect(() => {
    if (radiationLayerRef.current) radiationLayerRef.current.alpha = radiationOpacity
  }, [radiationOpacity])

  // ---- clock: Sun lighting + Sun/Earth markers ----
  useEffect(() => {
    const scene = sceneRef.current
    const eph = ephemeris
    if (!ready || !scene || !eph) return
    const sun = sunPosition(eph, t)
    const earth = earthPosition(eph, t)
    setSunDirection(scene.viewer, sun)
    const m = markers.current
    // Sun is drawn at Earth-like distance in its true direction (beyond the far plane otherwise)
    const sunDir = Cartesian3.normalize(new Cartesian3(...sun), new Cartesian3())
    const sunShown = Cartesian3.multiplyByScalar(sunDir, 4.0e8, new Cartesian3())
    if (!m.sun) {
      m.sun = scene.viewer.entities.add({ point: { pixelSize: 18, color: Color.YELLOW }, label: { text: 'Sun', font: '13px system-ui', pixelOffset: new Cartesian2(0, -18) } })
      m.earth = scene.viewer.entities.add({ point: { pixelSize: 14, color: Color.DODGERBLUE }, label: { text: 'Earth', font: '13px system-ui', pixelOffset: new Cartesian2(0, -16) } })
    }
    m.sun.position = new ConstantPositionProperty(sunShown)
    m.earth!.position = new ConstantPositionProperty(new Cartesian3(...earth))
  }, [ready, ephemeris, t])

  useEffect(() => {
    if (ready && sceneRef.current) setSunLighting(sceneRef.current, lighting)
  }, [ready, lighting])

  useEffect(() => {
    if (!playing || !ephemeris) return
    const end = timeRange[1]
    const id = setInterval(() => setT((x) => (x + stepMs > end ? x : x + stepMs)), 80)
    return () => clearInterval(id)
  }, [playing, stepMs, ephemeris, timeRange])

  const inspectCustomPoint = useCallback((lat: number, lon: number) => {
    const scene = sceneRef.current
    if (!scene || !bundle) return
    const viewer = scene.viewer
    const p = { lat, lon }
    const dem = bundle.fields.dem_south
    const elevation = dem?.sample(lon * D2R, lat * D2R)
    const heightM = elevation !== undefined && Number.isFinite(elevation) ? elevation : undefined
    const horizon = dem && heightM !== undefined ? computeHorizon(dem, lat, lon) : undefined
    const values = bundle.layers.map((m) => {
      const v = bundle.fields[m.id]?.sample(lon * D2R, lat * D2R)
      return { title: m.title, value: v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(m.units === 'm' ? 0 : 2)} ${m.units}` }
    })
    if (markers.current.custom) viewer.entities.remove(markers.current.custom)
    markers.current.custom = viewer.entities.add({
      position: Cartesian3.fromDegrees(lon, lat, 0, Ellipsoid.MOON),
      point: {
        pixelSize: 13,
        color: Color.YELLOW,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        disableDepthTestDistance: 500_000,
      },
      label: {
        text: `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`,
        font: '13px system-ui',
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -16),
        disableDepthTestDistance: 500_000,
      },
    })
    setInspect({ ...p, values })
    setSelected({
      id: `custom-${Date.now()}`,
      name: `Custom ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
      group: 'Custom',
      ...p,
      heightM,
      horizon,
    })
  }, [bundle])

  const searchCoordinates = useCallback((lat: number, lon: number) => {
    inspectCustomPoint(lat, lon)
    const scene = sceneRef.current
    if (scene) flyToSite(scene.viewer, lat, lon)
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
    handler.setInputAction((e: { position: Cartesian2 }) => {
      const p = pick(e.position)
      if (!p) return
      inspectCustomPoint(p.lat, p.lon)
    }, ScreenSpaceEventType.LEFT_CLICK)
    return () => handler.destroy()
  }, [ready, bundle, inspectCustomPoint])

  // ---- site analysis ----
  const dayStart = Math.floor(t / DAY) * DAY
  const timeline = useMemo(() => {
    if (!selected || !ephemeris) return []
    const step = windowDays > 90 ? 6 * 3600_000 : 3600_000
    return computeTimeline(ephemeris, selected, selected.horizon, dayStart, dayStart + windowDays * DAY, step)
  }, [selected, ephemeris, dayStart, windowDays])
  const summary = useMemo(() => (timeline.length ? summarize(timeline.filter((s) => s.t >= t)) : undefined), [timeline, t])
  const now = useMemo(() => (selected && ephemeris ? computeTimeline(ephemeris, selected, selected.horizon, t, t)[0] : undefined), [selected, ephemeris, t])
  // ---- DSN link: Goldstone / Madrid / Canberra, lunar terrain horizon included (lib/dsn.ts) ----
  // ---- solar power: terrain shadows, Sun elevation, distance and Earth eclipses (lib/power.ts) ----
  const powerTl = useMemo(() => {
    if (!selected || !ephemeris) return []
    const step = windowDays <= 90 ? 3600_000 : 3 * 3600_000
    return powerTimeline(ephemeris, selected, selected.horizon, dayStart, dayStart + windowDays * DAY, step, panel)
  }, [selected, ephemeris, dayStart, windowDays, panel])
  const powerSummary = useMemo(() => summarizePower(powerTl.filter((s) => s.t >= t)), [powerTl, t])
  const dsnNow = useMemo(() => (selected && ephemeris ? dsnAt(ephemeris, selected, selected.horizon, t) : undefined), [selected, ephemeris, t])

  const selectCalendarDate = async (nextTime: number) => {
    const year = new Date(nextTime).getUTCFullYear()
    if (year < EPHEMERIS_START_YEAR || year > EPHEMERIS_LAST_SELECTABLE_YEAR) return
    if (year === new Date(timeRange[0]).getUTCFullYear()) {
      setT(nextTime)
      return
    }

    setPlaying(false)
    setEphemerisBusy(true)
    setEphemerisError(undefined)
    try {
      const nextEphemeris = await loadEphemerisWindow(DATA_URL, year)
      setEphemeris(nextEphemeris)
      setTimeRange([Date.UTC(year, 0, 1), Date.UTC(year + EPHEMERIS_WINDOW_YEARS, 0, 1)])
      setT(nextTime)
    } catch (error) {
      setEphemerisError(error instanceof Error ? error.message : String(error))
    } finally {
      setEphemerisBusy(false)
    }
  }

  const resetTimeline = () => {
    if (!bundle?.ephemeris) return
    setPlaying(false)
    setEphemeris(bundle.ephemeris)
    setTimeRange([DEFAULT_TIME_START, DEFAULT_TIME_END])
    setT(DEFAULT_TIME_START)
    setEphemerisError(undefined)
  }

  const selectSite = (s: Site) => {
    setInspect(undefined)
    if (markers.current.custom && sceneRef.current) {
      sceneRef.current.viewer.entities.remove(markers.current.custom)
      markers.current.custom = undefined
    }
    setSelected(s)
    if (sceneRef.current) flyToSite(sceneRef.current.viewer, s.lat, s.lon)
  }

  return (
    <div className="app">
      <div ref={containerRef} className="globe" />
      <header className="brand">
        <h1>ByteTheMoon</h1>
        <span className="muted">Lunar Landing Site Navigator{sceneRef.current && ` · basemap: ${sceneRef.current.basemap === 'ion' ? 'Cesium Moon 3D' : 'NASA Moon Trek'}`}</span>
      </header>
      {bundle && (
        <>
          <aside className={`side left${sitePanelExpanded ? ' expanded' : ''}`}>
            <SitePanel sites={bundle.sites} selected={selected} onSelect={selectSite} onSearchCoordinates={searchCoordinates}
              timeline={timeline} summary={summary}
              now={now} nowMs={t} windowDays={windowDays} onWindowDays={setWindowDays} inspect={inspect}
              expanded={sitePanelExpanded} onToggleExpanded={() => setSitePanelExpanded((expanded) => !expanded)}
              showSiteMarkers={showSiteMarkers} onShowSiteMarkersChange={setShowSiteMarkers}
              dsn={ephemeris ? { now: dsnNow } : undefined}
              power={ephemeris ? { panel, onPanel: setPanel, summary: powerSummary } : undefined} />
          </aside>
          <aside className="side right">
            <LayerPanel layers={bundle.layers} state={layerState} onChange={(id, s) => setLayerState((x) => ({ ...x, [id]: s }))}
              score={score} onScore={setScore} scoreAvailable={!!scoreFields}
              radiationMetadata={radiationMetadata} radiationLoading={radiationLoading} radiationError={radiationError}
              radiationVisible={radiationVisible} onRadiationVisible={setRadiationVisible}
              radiationOpacity={radiationOpacity} onRadiationOpacity={setRadiationOpacity}
              radiationMode={radiationMode} onRadiationMode={setRadiationMode}
              slopeExact={!!scoreFields?.exact} />
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
            <TimeBar t={t} range={timeRange} calendarRange={CALENDAR_RANGE} onChange={setT}
              onCalendarChange={selectCalendarDate} onReset={resetTimeline} playing={playing} onPlay={setPlaying}
              stepMs={stepMs} onStep={setStepMs} lighting={lighting} onLighting={setLighting}
              busy={ephemerisBusy} error={ephemerisError} />
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
            </div>
          )}
        </>
      )}
      {!ready && <div className="loading">Loading the Moon…</div>}
    </div>
  )
}
