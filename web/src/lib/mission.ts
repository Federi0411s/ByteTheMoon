/**
 * Mission-period averages of sunlight and Earth visibility.
 *
 * The LOLA maps (60 m) are long-term averages. For a chosen mission window we recompute visibility on
 * a 1 km grid of terrain horizon masks (pipeline/horizon_grid.py) against the SPICE ephemeris, in a
 * pool of Web Workers. The 60 m map is then rescaled cell by cell by (period average / long-term
 * average) from the same grid, which keeps the fine LOLA detail (crater rims, permanent shadows stay
 * at 0) while following the period's illumination.
 */
import { DATA_URL } from './data'
import { EARTH_RADIUS_KM, SUN_RADIUS_KM, earthPosition, sunPosition, type Ephemeris } from './ephemeris'
import { MOON_RADIUS_M, RasterField, type LayerMeta } from './raster'

interface GridIndex {
  n: number
  cellM: number
  halfExtentM: number
  azStepDeg: number
  nAz: number
  tileCols: number
  elevOffset: number
  elevScale: number
  file: string
  baseline: { file: string; scale: number; offset: number }
  source: string
}

export interface MissionResult {
  start: number
  end: number
  samples: number
  ms: number
  sun: RasterField // coarse period averages on the grid
  earth: RasterField
  baseSun: RasterField // long-term averages on the same grid
  baseEarth: RasterField
}

async function pixels(url: string) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  return { w: bmp.width, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data }
}

function gridMeta(g: GridIndex, id: string, title: string): LayerMeta {
  return {
    id, title, description: '', source: g.source, file: '', projection: 'polar-south',
    width: g.n, height: g.n, halfExtentM: g.halfExtentM, encoding: 'u8', scale: 1, offset: 0,
    units: 'fraction', min: 0, max: 1, colormap: 'inferno', resolutionM: g.cellM, display: false,
  }
}

const MAX_SAMPLES = 6000 // hourly up to ~8 months; the binned worker cost barely depends on this

export class MissionEngine {
  private workers: Worker[] = []
  private slices: [number, number][] = []
  private seq = 0
  readonly grid: GridIndex
  readonly baseSun: RasterField
  readonly baseEarth: RasterField

  private constructor(grid: GridIndex, baseSun: RasterField, baseEarth: RasterField) {
    this.grid = grid
    this.baseSun = baseSun
    this.baseEarth = baseEarth
  }

  static async load(): Promise<MissionEngine> {
    const base = `${DATA_URL}/horizons`
    const g = (await (await fetch(`${base}/index.json`)).json()) as GridIndex
    const [hzImg, baseImg] = await Promise.all([pixels(`${base}/${g.file}`), pixels(`${base}/${g.baseline.file}`)])
    const n = g.n, cells = n * n

    // long-term averages on the grid (2 tiles side by side)
    const baseSun = new Float32Array(cells), baseEarth = new Float32Array(cells)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const i = r * n + c
      const s = baseImg.data[(r * baseImg.w + c) * 4], e = baseImg.data[(r * baseImg.w + n + c) * 4]
      baseSun[i] = s === 0 ? NaN : g.baseline.offset + g.baseline.scale * s
      baseEarth[i] = e === 0 ? NaN : g.baseline.offset + g.baseline.scale * e
    }
    const engine = new MissionEngine(g, new RasterField(gridMeta(g, 'base_sun', 'Sun (long-term, grid)'), baseSun), new RasterField(gridMeta(g, 'base_earth', 'Earth (long-term, grid)'), baseEarth))

    // horizons: one tile per azimuth bin -> cell-major Float32 (degrees)
    const hz = new Float32Array(cells * g.nAz)
    for (let k = 0; k < g.nAz; k++) {
      const tr = Math.floor(k / g.tileCols), tc = k % g.tileCols
      for (let r = 0; r < n; r++) {
        const rowOff = ((tr * n + r) * hzImg.w + tc * n) * 4
        for (let c = 0; c < n; c++) {
          const dn = hzImg.data[rowOff + c * 4]
          hz[(r * n + c) * g.nAz + k] = dn === 0 ? NaN : g.elevOffset + g.elevScale * dn
        }
      }
    }
    // lon/lat of each cell centre (south polar stereographic grid, row 0 = +y)
    const lonlat = new Float64Array(cells * 2)
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const x = -g.halfExtentM + (c + 0.5) * g.cellM, y = g.halfExtentM - (r + 0.5) * g.cellM
      lonlat[(r * n + c) * 2] = Math.atan2(x, y)
      lonlat[(r * n + c) * 2 + 1] = -(Math.PI / 2 - 2 * Math.atan(Math.hypot(x, y) / (2 * MOON_RADIUS_M)))
    }

    const k = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
    for (let w = 0; w < k; w++) {
      const a = Math.floor((cells * w) / k), b = Math.floor((cells * (w + 1)) / k)
      const worker = new Worker(new URL('./missionWorker.ts', import.meta.url), { type: 'module' })
      const hzSlice = hz.slice(a * g.nAz, b * g.nAz), llSlice = lonlat.slice(a * 2, b * 2)
      worker.postMessage({ type: 'init', hz: hzSlice, lonlat: llSlice, nAz: g.nAz, azStepDeg: g.azStepDeg }, [hzSlice.buffer, llSlice.buffer])
      engine.workers.push(worker)
      engine.slices.push([a, b])
    }
    return engine
  }

  /** Average visibility over [start, end]. Resolves null if a newer request superseded this one. */
  async compute(eph: Ephemeris, start: number, end: number): Promise<MissionResult | null> {
    const id = ++this.seq
    const t0 = performance.now()
    const hours = Math.max(1, (end - start) / 3600_000)
    const N = Math.round(Math.min(MAX_SAMPLES, Math.max(24, hours)))
    const dt = (end - start) / N
    const pack = (pos: (e: Ephemeris, t: number) => number[], radiusKm: number) => {
      const out = new Float32Array(N * 4)
      for (let j = 0; j < N; j++) {
        const p = pos(eph, start + (j + 0.5) * dt)
        const d = Math.hypot(p[0], p[1], p[2])
        out.set([p[0] / d, p[1] / d, p[2] / d, (Math.asin((radiusKm * 1000) / d) * 180) / Math.PI], j * 4)
      }
      return out
    }
    const sunDirs = pack(sunPosition, SUN_RADIUS_KM), earthDirs = pack(earthPosition, EARTH_RADIUS_KM)
    const parts = await Promise.all(
      this.workers.map((w) => new Promise<{ sun: Float32Array; earth: Float32Array; workMs: number }>((resolve) => {
        const onMsg = (e: MessageEvent) => {
          if (e.data.id !== id) return
          w.removeEventListener('message', onMsg)
          resolve(e.data)
        }
        w.addEventListener('message', onMsg)
        w.postMessage({ type: 'compute', id, sun: sunDirs, earth: earthDirs })
      })),
    )
    if (id !== this.seq) return null
    const cells = this.grid.n * this.grid.n
    const sun = new Float32Array(cells), earth = new Float32Array(cells)
    parts.forEach((p, i) => { sun.set(p.sun, this.slices[i][0]); earth.set(p.earth, this.slices[i][0]) })
    console.debug(`mission averages: ${N} steps, workers ${parts.map((p) => Math.round(p.workMs)).join('/')} ms, total ${Math.round(performance.now() - t0)} ms`)
    return {
      start, end, samples: N, ms: performance.now() - t0,
      sun: new RasterField(gridMeta(this.grid, 'mission_sun', 'Sun (period, grid)'), sun),
      earth: new RasterField(gridMeta(this.grid, 'mission_earth', 'Earth (period, grid)'), earth),
      baseSun: this.baseSun,
      baseEarth: this.baseEarth,
    }
  }

  dispose() {
    this.workers.forEach((w) => w.terminate())
  }
}

/**
 * A 60 m LOLA average map rescaled to a mission period: fine x (period / long-term) from the grid.
 * Behaves like any RasterField for overlays, the score layer and click-inspect.
 */
export class PeriodField extends RasterField {
  private readonly fine: RasterField
  private readonly ratio: RasterField

  constructor(fine: RasterField, period: RasterField, base: RasterField) {
    super(fine.meta, fine.data)
    this.fine = fine
    const EPS = 0.02 // keeps the ratio stable where the long-term value is ~0
    const r = new Float32Array(period.data.length)
    for (let i = 0; i < r.length; i++) r[i] = (period.data[i] + EPS) / (base.data[i] + EPS) // NaN stays NaN
    this.ratio = new RasterField(period.meta, r)
  }

  private scale(v: number, lon: number, lat: number) {
    if (Number.isNaN(v)) return NaN
    const k = this.ratio.sample(lon, lat)
    return Number.isNaN(k) ? NaN : Math.min(1, Math.max(0, v * k))
  }

  sample(lon: number, lat: number) { return this.scale(this.fine.sample(lon, lat), lon, lat) }
  sampleNearest(lon: number, lat: number) { return this.scale(this.fine.sampleNearest(lon, lat), lon, lat) }
}
