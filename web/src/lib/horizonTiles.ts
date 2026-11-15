/**
 * Precomputed terrain horizons (pipeline/horizon_tiles.py): 32 azimuths per pixel of a geographic
 * tile pyramid, levels 0..5 (666 m), from the same horizon model as the live computation in
 * lib/heatWorker.ts. Zoomed-out heatmap tiles (samples 666 m or more apart) read their horizons from
 * here instead of tracing them, so they only run the time integration; closer tiles keep computing
 * horizons live from the finer elevation tiles.
 *
 * Tile = lossless grey WebP 256 x (32 * 256), azimuth-major; H = offset + scale * DN deg, DN 0 = no
 * data. Levels 0..publicMaxLevel ship with the app (public/data/horizon), finer ones come from
 * fineUrl (dev: MOON_DATA/horizon_fine at /horizon-fine); without them only the public levels are
 * used and finer tiles are computed live, as before.
 *
 * Runs inside the heatmap workers, like DemSampler: ensure the tiles first (async), then sample.
 */
import { DEM_TILE as TILE, demPixelM } from './dem'

export interface HorizonConfig {
  publicUrl: string
  fineUrl: string | null
  publicMaxLevel: number
  fineMaxLevel: number
  scale: number
  offset: number
  azimuths: number
}

/** raw DN, [azimuth][row][col]; null = known missing */
type Tile = Uint8Array | null
const MAX_TILES = 24 // 2 MB each: 48 MB per worker
const FETCH_TIMEOUT_MS = 30_000
/** a job needing more tiles than this computes its horizons live (rings of thin tiles near the poles) */
export const MAX_TILES_PER_JOB = 20 // a ring of level-3 tiles around a pole is 16

export class HorizonSampler {
  private readonly cfg: HorizonConfig
  private readonly tiles = new Map<number, Tile>()
  private readonly pending = new Map<number, Promise<void>>()
  private fineBroken: boolean
  private anyFine = false
  private ctx: OffscreenCanvasRenderingContext2D | null = null

  constructor(cfg: HorizonConfig) {
    this.cfg = cfg
    this.fineBroken = !cfg.fineUrl
  }

  get maxLevel() {
    return this.fineBroken ? this.cfg.publicMaxLevel : this.cfg.fineMaxLevel
  }

  /**
   * Level to read for samples `spacingM` apart: the coarsest whose pixel is no larger than the
   * spacing; -1 if even the finest available level is coarser (-> compute live).
   */
  levelFor(spacingM: number): number {
    const max = this.maxLevel
    if (demPixelM(max) > spacingM * 1.001) return -1
    for (let z = 0; z <= max; z++) if (demPixelM(z) <= spacingM * 1.001) return z
    return max
  }

  static key(z: number, x: number, y: number) {
    return (z * 4096 + y) * 8192 + x
  }

  /** Tile keys (z, x, y) the bilinear lookups at these points read. */
  tilesFor(lon: Float64Array, lat: Float64Array, z: number): [number, number, number][] {
    const n = TILE * 2 ** z, cols = 2 * n, pix = Math.PI / n
    const seen = new Set<number>(), out: [number, number, number][] = []
    for (let i = 0; i < lon.length; i++) {
      const fx = (lon[i] + Math.PI) / pix - 0.5, fy = (Math.PI / 2 - lat[i]) / pix - 0.5
      const x0 = Math.floor(fx), y0 = Math.floor(fy)
      for (const yy of [y0, y0 + 1]) for (const xx of [x0, x0 + 1]) {
        const y = Math.min(n - 1, Math.max(0, yy)), x = ((xx % cols) + cols) % cols
        const k = HorizonSampler.key(z, x >> 8, y >> 8)
        if (seen.has(k)) continue
        seen.add(k)
        out.push([z, x >> 8, y >> 8])
      }
    }
    return out
  }

  /** Fetch the given tiles; resolves false if any could not be loaded (missing or failed). */
  async ensure(list: [number, number, number][]): Promise<boolean> {
    await Promise.all(list.map(([z, x, y]) => this.load(z, x, y)))
    return list.every(([z, x, y]) => !!this.tiles.get(HorizonSampler.key(z, x, y)))
  }

  private load(z: number, x: number, y: number): Promise<void> {
    const k = HorizonSampler.key(z, x, y)
    if (this.tiles.has(k)) {
      const t = this.tiles.get(k)!
      this.tiles.delete(k) // move to the back: recently used
      this.tiles.set(k, t)
      return Promise.resolve()
    }
    let p = this.pending.get(k)
    if (p) return p
    p = (async () => {
      const fine = z > this.cfg.publicMaxLevel
      if (fine && this.fineBroken) { this.store(k, null); return }
      try {
        const base = fine ? this.cfg.fineUrl! : this.cfg.publicUrl
        const r = await fetch(`${base}/${z}/${x}/${y}.webp`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('image/')) {
          if (fine && !this.anyFine && (r.status === 404 || r.ok)) this.fineBroken = true
          this.store(k, null)
          return
        }
        const naz = this.cfg.azimuths, H = naz * TILE
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
        const ctx = (this.ctx ??= new OffscreenCanvas(TILE, H).getContext('2d', { willReadFrequently: true })!)
        ctx.clearRect(0, 0, TILE, H)
        ctx.drawImage(bmp, 0, 0)
        bmp.close()
        const px = ctx.getImageData(0, 0, TILE, H).data
        const out = new Uint8Array(TILE * H)
        for (let i = 0; i < out.length; i++) out[i] = px[i * 4]
        if (fine) this.anyFine = true
        this.store(k, out)
      } catch {
        // transient: not cached
      } finally {
        this.pending.delete(k)
      }
    })()
    this.pending.set(k, p)
    return p
  }

  private store(k: number, t: Tile) {
    this.tiles.delete(k)
    this.tiles.set(k, t)
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value!)
  }

  /**
   * Horizon (deg) per azimuth at (lon, lat) from level z, bilinear between pixel centres (no-data
   * pixels left out); NaN-filled where there is no data. The tiles must have been ensured.
   */
  sample(lon: number, lat: number, z: number, out: Float32Array) {
    const n = TILE * 2 ** z, cols = 2 * n, pix = Math.PI / n
    const naz = this.cfg.azimuths, plane = TILE * TILE
    const fx = (lon + Math.PI) / pix - 0.5, fy = (Math.PI / 2 - lat) / pix - 0.5
    const x0 = Math.floor(fx), y0 = Math.floor(fy), wx = fx - x0, wy = fy - y0
    const t: (Tile | undefined)[] = [], o: number[] = [], w: number[] = []
    for (let j = 0; j < 4; j++) {
      const y = Math.min(n - 1, Math.max(0, y0 + (j >> 1))), x = (((x0 + (j & 1)) % cols) + cols) % cols
      t.push(this.tiles.get(HorizonSampler.key(z, x >> 8, y >> 8)))
      o.push(((y & 255) << 8) | (x & 255))
      w.push(((j & 1) ? wx : 1 - wx) * ((j >> 1) ? wy : 1 - wy))
    }
    // the point's own data decides validity, like the live horizon (no height -> no horizon)
    let wSum = 0
    for (let j = 0; j < 4; j++) {
      const tj = t[j]
      if (!tj || tj[o[j]] === 0) w[j] = 0
      wSum += w[j]
    }
    if (wSum <= 0) { out.fill(NaN); return }
    const { scale, offset } = this.cfg
    for (let a = 0; a < naz; a++) {
      let acc = 0
      for (let j = 0; j < 4; j++) if (w[j] > 0) acc += w[j] * t[j]![a * plane + o[j]]
      out[a] = offset + scale * (acc / wSum)
    }
  }
}
