import { useEffect, useMemo, useRef, useState } from 'react'
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
import { createMoonScene, flyToSite, setSunDirection, setSunLighting, type MoonScene } from './cesium/createViewer'
import { asProvider, FieldImageryProvider, levelForResolution } from './cesium/FieldImageryProvider'
import { computeHorizon, computeTimeline, summarize } from './lib/analysis'
import { loadBundle, type DataBundle, type Site } from './lib/data'
import { footprintMax, hillshade } from './lib/raster'
import { DEFAULT_FOOTPRINT, footprintAxes, SLOPE_MAX_DEG } from './lib/requirements'
import { earthPosition, ephemerisRange, sunPosition } from './lib/ephemeris'
import { LayerPanel, type LayerState, type ScoreWeights } from './components/LayerPanel'
import { SitePanel } from './components/SitePanel'
import { TimeBar } from './components/TimeBar'

const DAY = 86400_000
const D2R = Math.PI / 180

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<MoonScene | null>(null)
  const layerRefs = useRef<Record<string, ImageryLayer>>({})
  const markers = useRef<{ sun?: Entity; earth?: Entity; sites: Entity[] }>({ sites: [] })

  const [ready, setReady] = useState(false)
  const [bundle, setBundle] = useState<DataBundle | null>(null)
  const [layerState, setLayerState] = useState<Record<string, LayerState>>({})
  const [score, setScore] = useState<ScoreWeights>({ enabled: false, sun: 0.5, earth: 0.3, maxSlope: 8, footprint: DEFAULT_FOOTPRINT, opacity: 0.7 })
  const [t, setT] = useState(() => Date.parse('2027-06-01T00:00:00Z'))
  const [playing, setPlaying] = useState(false)
  const [lighting, setLighting] = useState(false)
  const [stepMs, setStepMs] = useState(3600_000)
  const [selected, setSelected] = useState<Site>()
  const [windowDays, setWindowDays] = useState(30)
  const [inspect, setInspect] = useState<{ lat: number; lon: number; values: { title: string; value: string }[] }>()

  // ---- boot: Cesium scene + static data bundle ----
  useEffect(() => {
    let destroyed = false
    Promise.all([createMoonScene(containerRef.current!), loadBundle()]).then(([scene, data]) => {
      if (destroyed) return scene.viewer.destroy()
      sceneRef.current = scene
      ;(window as unknown as { moon: MoonScene }).moon = scene // handy in the browser console: moon.viewer
      setBundle(data)
      if (data.ephemeris) {
        const [a, b] = ephemerisRange(data.ephemeris)
        setT((x) => Math.min(Math.max(x, a), b))
      }
      setReady(true)
    })
    return () => {
      destroyed = true
      sceneRef.current?.viewer.destroy()
      sceneRef.current = null
    }
  }, [])

  // ---- site markers ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !bundle) return
    markers.current.sites.forEach((e) => scene.viewer.entities.remove(e))
    markers.current.sites = bundle.sites.map((s) =>
      scene.viewer.entities.add({
        position: Cartesian3.fromDegrees(s.lon, s.lat, 0, Ellipsoid.MOON),
        point: { pixelSize: 9, color: Color.fromCssColorString('#ff8a3d'), outlineColor: Color.BLACK, outlineWidth: 2, disableDepthTestDistance: 500_000 },
        label: {
          text: s.name, font: '13px system-ui', style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3,
          verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -12),
          disableDepthTestDistance: 500_000, // always on top nearby, hidden behind the Moon from afar
        },
      }),
    )
  }, [ready, bundle])

  // ---- polar relief base layer for the Moon Trek fallback (its imagery smears near the pole) ----
  useEffect(() => {
    const scene = sceneRef.current
    const dem = bundle?.fields.dem_south
    if (!ready || !scene || !dem || scene.basemap !== 'trek') return
    const layer = new ImageryLayer(asProvider(new FieldImageryProvider({
      value: hillshade(dem), min: 0, max: 1, colormap: 'grey',
      boundsRad: dem.boundsRad(), maximumLevel: levelForResolution(dem.meta.resolutionM) + 1,
      credit: 'Relief: LOLA LDEM 80S',
    })))
    scene.overlays.add(layer, 1) // just above the basemap, below the heatmaps
    return () => { scene.overlays.remove(layer, true) }
  }, [ready, bundle])

  // ---- raster overlays (one ImageryLayer per visible layer) ----
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene || !bundle) return
    for (const meta of bundle.layers) {
      const field = bundle.fields[meta.id]
      const st = layerState[meta.id]
      let layer = layerRefs.current[meta.id]
      if (!field || !st?.visible) {
        if (layer) layer.show = false
        continue
      }
      if (!layer) {
        layer = new ImageryLayer(asProvider(new FieldImageryProvider({
          value: (lon, lat) => field.sampleNearest(lon, lat),
          min: meta.min, max: meta.max, colormap: meta.colormap,
          boundsRad: field.boundsRad(),
          maximumLevel: levelForResolution(meta.resolutionM),
          credit: meta.source,
        })))
        scene.overlays.add(layer)
        layerRefs.current[meta.id] = layer
      }
      layer.show = true
      layer.alpha = st.opacity
    }
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

  // ---- clock: Sun lighting + Sun/Earth markers ----
  useEffect(() => {
    const scene = sceneRef.current
    const eph = bundle?.ephemeris
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
  }, [ready, bundle, t])

  useEffect(() => {
    if (ready && sceneRef.current) setSunLighting(sceneRef.current, lighting)
  }, [ready, lighting])

  useEffect(() => {
    if (!playing || !bundle?.ephemeris) return
    const [, end] = ephemerisRange(bundle.ephemeris)
    const id = setInterval(() => setT((x) => (x + stepMs > end ? x : x + stepMs)), 80)
    return () => clearInterval(id)
  }, [playing, stepMs, bundle])

  // ---- click to inspect, double-click to analyse a custom site ----
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
      const values = bundle.layers.map((m) => {
        const v = bundle.fields[m.id]?.sample(p.lon * D2R, p.lat * D2R)
        return { title: m.title, value: v === undefined || Number.isNaN(v) ? '—' : `${v.toFixed(m.units === 'm' ? 0 : 2)} ${m.units}` }
      })
      setInspect({ ...p, values })
    }, ScreenSpaceEventType.LEFT_CLICK)
    handler.setInputAction((e: { position: Cartesian2 }) => {
      const p = pick(e.position)
      if (!p) return
      const dem = bundle.fields.dem_south
      const horizon = dem && !Number.isNaN(dem.sample(p.lon * D2R, p.lat * D2R)) ? computeHorizon(dem, p.lat, p.lon) : undefined
      setSelected({ id: `custom-${Date.now()}`, name: `Custom ${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°`, group: 'Custom', ...p, horizon })
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    return () => handler.destroy()
  }, [ready, bundle])

  // ---- site analysis ----
  const dayStart = Math.floor(t / DAY) * DAY
  const timeline = useMemo(() => {
    if (!selected || !bundle?.ephemeris) return []
    const step = windowDays > 90 ? 6 * 3600_000 : 3600_000
    return computeTimeline(bundle.ephemeris, selected, selected.horizon, dayStart, dayStart + windowDays * DAY, step)
  }, [selected, bundle, dayStart, windowDays])
  const summary = useMemo(() => (timeline.length ? summarize(timeline.filter((s) => s.t >= t)) : undefined), [timeline, t])
  const now = useMemo(() => (selected && bundle?.ephemeris ? computeTimeline(bundle.ephemeris, selected, selected.horizon, t, t)[0] : undefined), [selected, bundle, t])

  const selectSite = (s: Site) => {
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
          <aside className="side left">
            <SitePanel sites={bundle.sites} selected={selected} onSelect={selectSite} timeline={timeline} summary={summary}
              now={now} nowMs={t} windowDays={windowDays} onWindowDays={setWindowDays} inspect={inspect} />
          </aside>
          <aside className="side right">
            <LayerPanel layers={bundle.layers} state={layerState} onChange={(id, s) => setLayerState((x) => ({ ...x, [id]: s }))}
              score={score} onScore={setScore} scoreAvailable={!!scoreFields} slopeExact={!!scoreFields?.exact} />
            {bundle.warnings.length > 0 && (
              <section className="panel warn">
                <h2>Setup</h2>
                {bundle.warnings.map((w) => <p key={w}>{w}</p>)}
              </section>
            )}
          </aside>
          {bundle.ephemeris && (
            <TimeBar t={t} range={ephemerisRange(bundle.ephemeris)} onChange={setT} playing={playing} onPlay={setPlaying} stepMs={stepMs} onStep={setStepMs} lighting={lighting} onLighting={setLighting} />
          )}
        </>
      )}
      {!ready && <div className="loading">Loading the Moon…</div>}
    </div>
  )
}
