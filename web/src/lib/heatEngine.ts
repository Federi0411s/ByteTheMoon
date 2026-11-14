/**
 * Main-thread side of the global heatmaps: a pool of lib/heatWorker.ts workers, the time window
 * (Sun/Earth directions over the mission period, or the whole loaded ephemeris window), and a cache
 * of computed tiles shared by every heatmap layer (sunlight, Earth visibility, PSR, slope, elevation,
 * score, EQUIPOT surface charging, sky-view factor for radiation and, on request, the Hayne 2017
 * regolith temperature all come from the same per-tile computation).
 *
 * Scheduling: requests queue here and are handed to the workers newest-first, at most MAX_INFLIGHT
 * per worker, so the tiles of what is on screen now overtake work queued for views (or layers) that
 * are gone; a request whose `wanted()` turns false is dropped before it starts. A worker that crashes
 * or hangs is replaced and its requests fail (nothing waits forever), and failed results are never
 * cached, so the next request for that tile simply recomputes it.
 */
import { EARTH_RADIUS_KM, SUN_RADIUS_KM, earthPosition, sunPosition, type Ephemeris } from './ephemeris'
import type { DemConfig } from './dem'
import type { HorizonMask } from './analysis'
import { DATA_URL } from './data'
import { loadEquipot, type EquipotTable } from './equipot'

export interface HeatTile {
  /** sample grid (edges included, row 0 = north): see lib/heatGrid.ts */
  nx: number
  ny: number
  sun: Float32Array
  earth: Float32Array
  slope: Float32Array
  elev: Float32Array
  /** EQUIPOT surface charging over the window: mean / min potential (V), fraction below the threshold */
  cMean: Float32Array
  cMin: Float32Array
  cBelow: Float32Array
  /** regolith surface temperature (K) over the window; empty unless requested */
  tMean: Float32Array
  tMin: Float32Array
  tMax: Float32Array
  /** visible-sky fraction (radiation layer) */
  fSky: Float32Array
}

interface DemIndex {
  scale: number
  offset: number
  publicMaxLevel: number
  fineMaxLevel: number
}

/** Time samples per window: enough for multi-year averages, still cheap per tile. */
const MAX_STEPS = 3000
/** "Time below" threshold of the charging layer (same default as pipeline/charging.py) */
export const CHARGE_THRESHOLD_V = -100
/** Regolith model: regular steps of <= 6 h; windows longer than a year are sampled (see setWindow) */
const THERMAL_STEP_S = 6 * 3600
const THERMAL_FULL_MAX_S = 365.25 * 86400
const LUNATION_S = 29.530589 * 86400
const THERMAL_SEGMENTS = 12
const AU_KM = 149597870.7

/**
 * Galactic cosmic rays follow the ~11-year solar cycle (more solar activity -> fewer GCRs). The
 * radiation model (pipeline/lunar_radiation.py) is calibrated to Chang'e 4 at the 2019 solar
 * minimum; this factor scales it to a time window. APPROXIMATE: a cosine cycle with its minimum at
 * the December 2019 solar minimum and a 30 % dose reduction at solar maximum (LRO/CRaTER saw roughly
 * that much between the 2009 minimum and the 2014 maximum). Real cycles vary in length and strength.
 */
const GCR_MIN_EPOCH = Date.UTC(2019, 11, 1)
const SOLAR_CYCLE_MS = 11.0 * 365.25 * 86400_000
const GCR_SOLAR_MAX_REDUCTION = 0.3
export function gcrFactor(start: number, end: number) {
  const n = 64
  let acc = 0
  for (let i = 0; i < n; i++) {
    const t = start + ((i + 0.5) / n) * (end - start)
    acc += 1 - (GCR_SOLAR_MAX_REDUCTION * (1 - Math.cos((2 * Math.PI * (t - GCR_MIN_EPOCH)) / SOLAR_CYCLE_MS))) / 2
  }
  return acc / n
}

// 1 per worker: a worker runs its jobs one at a time, and the stuck-worker timer starts at dispatch, so a
// queued second job counted its waiting time and heavy polar tiles tripped restarts that killed both
const MAX_INFLIGHT = 1
const TILE_TIMEOUT_MS = 180_000 // a tile that takes longer than this means a stuck worker

interface Job {
  msg: Record<string, unknown>
  affinity: number // preferred worker (its horizon cache)
  wanted: () => boolean
  resolve: (d: unknown) => void
  fail: () => void
  seq: number
}

interface Slot {
  worker: Worker
  inflight: Map<number, { job: Job; timer: ReturnType<typeof setTimeout> }>
}

export class HeatEngine {
  private readonly slots: Slot[] = []
  private readonly queue: Job[] = []
  private readonly cache = new Map<string, Promise<HeatTile | null>>()
  private readonly order: string[] = []
  private seq = 0
  private lastWindow: Record<string, unknown> | null = null
  private readonly equipot: EquipotTable
  /** bumps whenever the time window changes; layers rebuild their imagery on change */
  version = 0
  /** [start, end] ms of the current window */
  window: [number, number] = [0, 0]
  /** mean GCR scale factor over the window (1 = 2019 solar minimum), for the radiation layer */
  gcr = 1
  /** restarts so far (stuck or crashed workers), for the console */
  restarts = 0
  readonly dem: DemConfig

  private constructor(dem: DemConfig) {
    this.dem = dem
    this.equipot = loadEquipot()
    // at most 4: each worker holds its own elevation cache (~30 MB) and horizon cache; the mission engine has a pool too
    const k = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 2))
    for (let i = 0; i < k; i++) this.slots.push(this.spawn())
  }

  private spawn(): Slot {
    const worker = new Worker(new URL('./heatWorker.ts', import.meta.url), { type: 'module' })
    const slot: Slot = { worker, inflight: new Map() }
    worker.onmessage = (e) => {
      const entry = slot.inflight.get(e.data.id)
      if (!entry) return
      clearTimeout(entry.timer)
      slot.inflight.delete(e.data.id)
      entry.job.resolve(e.data)
      this.pump()
    }
    worker.onerror = (e) => {
      console.warn('heatmap worker crashed, restarting it:', e.message)
      e.preventDefault()
      this.restart(slot)
    }
    worker.postMessage({ type: 'init', cfg: this.dem })
    worker.postMessage({ type: 'equipot', table: this.equipot, threshold: CHARGE_THRESHOLD_V })
    if (this.lastWindow) worker.postMessage(this.lastWindow)
    return slot
  }

  /** Replace a crashed or stuck worker; its in-flight requests fail (and are not cached). */
  private restart(slot: Slot) {
    const i = this.slots.indexOf(slot)
    if (i < 0) return
    this.restarts++
    slot.worker.terminate()
    for (const { job, timer } of slot.inflight.values()) {
      clearTimeout(timer)
      job.fail()
    }
    slot.inflight.clear()
    this.slots[i] = this.spawn()
    this.pump()
  }

  /** null if the elevation pyramid has not been generated (pipeline/dem_tiles.py). */
  static async load(): Promise<HeatEngine | null> {
    try {
      const r = await fetch(`${DATA_URL}/dem/index.json`)
      if (!r.ok) return null
      const ix = (await r.json()) as DemIndex
      const env = import.meta.env.VITE_DEM_FINE_URL as string | undefined
      const fineUrl = env === '' || env === 'none' ? null : env ?? (import.meta.env.DEV ? '/dem-fine' : null)
      const origin = new URL(DATA_URL, location.href).href // workers resolve relative URLs against the worker script
      return new HeatEngine({
        publicUrl: `${origin}/dem`,
        fineUrl: fineUrl ? new URL(fineUrl, location.href).href.replace(/\/$/, '') : null,
        publicMaxLevel: ix.publicMaxLevel,
        fineMaxLevel: ix.fineMaxLevel,
        scale: ix.scale,
        offset: ix.offset,
      })
    } catch {
      return null
    }
  }

  /** Set the averaging window (ms UTC). Cached tiles are dropped; horizons stay cached in the workers. */
  setWindow(eph: Ephemeris, start: number, end: number) {
    const N = Math.max(48, Math.min(MAX_STEPS, Math.round((end - start) / 3600_000)))
    const dt = (end - start) / N
    // golden-ratio jitter inside each step: avoids aliasing between the step and the lunar day
    const pack = (pos: (e: Ephemeris, t: number) => number[], radiusKm: number) => {
      const out = new Float32Array(N * 4)
      for (let j = 0; j < N; j++) {
        const f = (j * 0.6180339887) % 1
        const p = pos(eph, start + (j + f) * dt)
        const d = Math.hypot(p[0], p[1], p[2])
        out[j * 4] = p[0] / d
        out[j * 4 + 1] = p[1] / d
        out[j * 4 + 2] = p[2] / d
        out[j * 4 + 3] = (Math.asin((radiusKm * 1000) / d) * 180) / Math.PI
      }
      return out
    }
    const sun = pack(sunPosition, SUN_RADIUS_KM), earth = pack(earthPosition, EARTH_RADIUS_KM)

    // Regolith model: needs a regular time series (thermal inertia). Windows up to a year are run
    // whole; longer ones as THERMAL_SEGMENTS lunations spread evenly over the window, each preceded
    // by one lunation of warm-up (not counted), so the statistics cover the whole selected period.
    const dtS = Math.min(THERMAL_STEP_S, Math.max(600, (end - start) / 1000 / 24))
    const segments: [number, number, number][] = [] // [warm-up start, stats start, stats end] ms
    if ((end - start) / 1000 <= THERMAL_FULL_MAX_S) segments.push([start, start, end])
    else {
      const span = end - start - LUNATION_S * 1000
      for (let k = 0; k < THERMAL_SEGMENTS; k++) {
        const s0 = start + (span * (k + 0.5)) / THERMAL_SEGMENTS
        segments.push([Math.max(start, s0 - LUNATION_S * 1000), s0, s0 + LUNATION_S * 1000])
      }
    }
    const steps: { t: number; count: number }[] = []
    for (const [w0, s0, s1] of segments) {
      for (let t = w0; t < s0; t += dtS * 1000) steps.push({ t, count: 0 })
      for (let t = s0; t < s1; t += dtS * 1000) steps.push({ t, count: 1 })
    }
    const thermalSun = new Float32Array(steps.length * 4), thermalCount = new Uint8Array(steps.length)
    steps.forEach(({ t, count }, j) => {
      const p = sunPosition(eph, t + (dtS * 1000) / 2)
      const d = Math.hypot(p[0], p[1], p[2])
      thermalSun.set([p[0] / d, p[1] / d, p[2] / d, d / 1000 / AU_KM], j * 4)
      thermalCount[j] = count
    })

    this.window = [start, end]
    this.gcr = gcrFactor(start, end)
    this.version++
    this.lastWindow = { type: 'window', version: this.version, sun, earth, thermalSun, thermalCount, thermalDt: dtS }
    for (const s of this.slots) s.worker.postMessage(this.lastWindow)
    this.cache.clear()
    this.order.length = 0
    // queued work for the old window is useless now
    for (const job of this.queue.splice(0)) job.fail()
  }

  private hash(key: string) {
    let h = 0
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
    return Math.abs(h) % this.slots.length
  }

  private enqueue<T>(msg: Record<string, unknown>, affinityKey: string, wanted: () => boolean = () => true): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      this.queue.push({ msg, affinity: this.hash(affinityKey), wanted, resolve: resolve as (d: unknown) => void, fail: () => resolve(null), seq: ++this.seq })
      this.pump()
    })
  }

  /** Hand queued requests to free workers: newest first, preferring each job's own worker. */
  private pump() {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (!this.queue[i].wanted()) this.queue.splice(i, 1)[0].fail()
    }
    for (let pass = 0; pass < 2 && this.queue.length; pass++) {
      for (let w = 0; w < this.slots.length; w++) {
        const slot = this.slots[w]
        while (slot.inflight.size < MAX_INFLIGHT && this.queue.length) {
          // pass 0: newest job routed to this worker; pass 1: steal the newest job of any worker
          let pick = -1
          for (let i = this.queue.length - 1; i >= 0; i--) {
            if (pass === 1 || this.queue[i].affinity === w) { pick = i; break }
          }
          if (pick < 0) break
          const job = this.queue.splice(pick, 1)[0]
          const id = job.seq
          const timer = setTimeout(() => {
            console.warn('heatmap worker stuck, restarting it')
            this.restart(slot)
          }, TILE_TIMEOUT_MS)
          slot.inflight.set(id, { job, timer })
          slot.worker.postMessage({ ...job.msg, id })
        }
      }
    }
  }

  /** Requests queued or running, for the console: moonHeat.stats() */
  stats() {
    return { queued: this.queue.length, inflight: this.slots.map((s) => s.inflight.size), cached: this.cache.size, restarts: this.restarts }
  }

  /**
   * Values for Cesium geographic tile (z, x, y) on about n x n samples (nx x ny, lib/heatGrid.ts). `demMax` caps the elevation
   * level used (coarse tiles use coarse terrain: a rough first answer, refined as you zoom in).
   * `wanted` lets the caller drop the request while it is still queued (e.g. its layer was removed).
   * Resolves null on failure; failures are not cached.
   */
  tile(z: number, x: number, y: number, n: number, demMax: number, thermal = false, wanted?: () => boolean, g = 1): Promise<HeatTile | null> {
    // x is the group index when g > 1 (g tiles of row y computed together, see heatGrid.tileGroup)
    const key = `${this.version}/${z}/${x}/${y}/${n}/${demMax}/g${g}/${thermal ? 't' : ''}`
    let p = this.cache.get(key)
    // a tile computed with the regolith model also answers requests without it
    if (!p && !thermal) p = this.cache.get(`${key}t`)
    if (p) return p
    const version = this.version
    p = this.enqueue<HeatTile & { version: number; error?: string }>({ type: 'tile', z, x, y, n, demMax, thermal, g }, `${z}/${x}/${y}/${g}`, wanted)
      .then((d) => {
        const ok = d && !d.error && d.version === version
        if (!ok) this.cache.delete(key) // never keep a failure: the next request recomputes
        if (d?.error) console.warn('heatmap tile failed:', d.error)
        return ok ? d : null
      })
    this.cache.set(key, p)
    this.order.push(key)
    while (this.order.length > 1500) this.cache.delete(this.order.shift()!)
    return p
  }

  /** Terrain horizon of one point from the finest elevation available (downloads what it needs). */
  async horizon(latDeg: number, lonDeg: number, azStepDeg = 1): Promise<HorizonMask | null> {
    const d = await this.enqueue<{ elevDeg?: Float32Array; demLevel: number; error?: string }>(
      { type: 'horizon', lat: (latDeg * Math.PI) / 180, lon: (lonDeg * Math.PI) / 180, azStepDeg },
      `h${latDeg.toFixed(3)},${lonDeg.toFixed(3)}`,
    )
    if (!d?.elevDeg) return null
    const m = Math.round((Math.PI * 1737400) / (256 * 2 ** d.demLevel))
    return { azStepDeg, elevDeg: Array.from(d.elevDeg), source: `LOLA global DEM tiles (${m} m)` }
  }

  dispose() {
    this.slots.forEach((s) => {
      s.worker.terminate()
      s.inflight.forEach(({ timer }) => clearTimeout(timer))
    })
    for (const job of this.queue.splice(0)) job.fail()
  }
}
