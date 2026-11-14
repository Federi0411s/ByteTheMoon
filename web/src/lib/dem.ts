/**
 * Global elevation from the tile pyramid made by pipeline/dem_tiles.py (LOLA 118 m, area-averaged).
 *
 * Tiles follow Cesium's GeographicTilingScheme on the Moon: level z has 2^(z+1) x 2^z tiles of
 * 256 x 256 px, x from lon -180, y from lat +90 (pixel = 180 deg / (256 * 2^z), 666 m at z = 5).
 *  - levels 0..publicMaxLevel ship with the app (public/data/dem)
 *  - finer levels are fetched on demand from `fineUrl` (dev: Vite serves MOON_DATA/dem_fine at
 *    /dem-fine; production: any static bucket, VITE_DEM_FINE_URL). If they are missing the sampler
 *    silently falls back to the coarser public levels.
 *
 * Runs inside the heatmap workers: callers `ensure()` the tiles a computation needs (async fetch),
 * then sample synchronously. Heights in metres relative to the 1737.4 km sphere.
 */
export const DEM_TILE = 256

export interface DemConfig {
  publicUrl: string // .../data/dem
  fineUrl: string | null
  publicMaxLevel: number
  fineMaxLevel: number
  scale: number
  offset: number
}

/** Ground size of one pixel at level z, metres (latitude direction). */
export const demPixelM = (z: number) => (Math.PI * 1737400) / (DEM_TILE * 2 ** z)

/** Coarsest level whose pixel is no larger than `m` metres (clamped to [0, maxLevel]). */
export function demLevelFor(m: number, maxLevel: number) {
  const z = Math.ceil(Math.log2((Math.PI * 1737400) / (DEM_TILE * Math.max(m, 1))))
  return Math.max(0, Math.min(maxLevel, z))
}

// Raw DN per pixel (height = offset + scale * DN; DN 0 = no data, which no real height maps to).
// 16-bit storage is exact and half the memory of Float32: each worker caches hundreds of tiles.
type Tile = Uint16Array | null // null = known missing
const MAX_DECODES = 4 // concurrent fetch+decode per worker: bounds the transient memory of bursts
const FETCH_TIMEOUT_MS = 20_000

export class DemSampler {
  private readonly cfg: DemConfig
  // numeric key (z, x, y) -> tile; numeric keys keep the per-pixel lookup cheap
  private readonly tiles = new Map<number, Tile>()
  private readonly pending = new Map<number, Promise<Tile>>()
  private readonly order: number[] = []
  private lastKey = -1
  private lastTile: Tile | undefined = undefined
  private fineBroken = false
  readonly maxTiles: number

  private active = 0
  private readonly queue: (() => void)[] = []
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null

  constructor(cfg: DemConfig, maxTiles = 250) {
    this.cfg = cfg
    this.maxTiles = maxTiles // 250 x 128 KB = 32 MB per worker
  }

  private async slot() {
    if (this.active >= MAX_DECODES) await new Promise<void>((res) => this.queue.push(res))
    this.active++
  }

  private release() {
    this.active--
    this.queue.shift()?.()
  }

  /** Finest level that may exist. */
  get maxLevel() {
    return this.cfg.fineUrl && !this.fineBroken ? this.cfg.fineMaxLevel : this.cfg.publicMaxLevel
  }

  private url(z: number, x: number, y: number) {
    const base = z <= this.cfg.publicMaxLevel ? this.cfg.publicUrl : this.cfg.fineUrl
    return `${base}/${z}/${x}/${y}.webp`
  }

  /** undefined = transient failure (timeout, network): not cached, retried on the next request */
  private async load(z: number, x: number, y: number): Promise<Tile | undefined> {
    const fine = z > this.cfg.publicMaxLevel
    if (fine && (!this.cfg.fineUrl || this.fineBroken)) return null
    await this.slot()
    try {
      if (fine && this.fineBroken) return null
      // a hung request must not hold one of the few decode slots forever
      const r = await fetch(this.url(z, x, y), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!r.ok) {
        // a missing fine tile on a server that has none at all -> stop asking
        if (fine && r.status === 404 && !this.anyFineLoaded) this.fineBroken = true
        return null
      }
      const type = r.headers.get('content-type') ?? ''
      if (!type.startsWith('image/')) { // e.g. an SPA fallback page instead of a 404
        if (fine) this.fineBroken = true
        return null
      }
      const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      if (!this.ctx) {
        this.canvas = new OffscreenCanvas(DEM_TILE, DEM_TILE) // one reusable canvas per worker
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
      }
      this.ctx.clearRect(0, 0, DEM_TILE, DEM_TILE)
      this.ctx.drawImage(bmp, 0, 0)
      bmp.close()
      const px = this.ctx.getImageData(0, 0, DEM_TILE, DEM_TILE).data
      const out = new Uint16Array(DEM_TILE * DEM_TILE)
      for (let i = 0; i < out.length; i++) {
        const j = i * 4
        out[i] = px[j + 2] === 0 ? 0 : px[j] * 256 + px[j + 1]
      }
      if (fine) this.anyFineLoaded = true
      return out
    } catch {
      return undefined
    } finally {
      this.release()
    }
  }

  private anyFineLoaded = false

  private key(z: number, x: number, y: number) {
    return (z * 4096 + y) * 8192 + x // x < 2^(z+1) <= 8192 up to z = 12
  }

  private store(k: number, t: Tile) {
    if (k === this.lastKey) this.lastKey = -1 // the cached lookup may have been a miss
    this.tiles.set(k, t)
    this.order.push(k)
    while (this.order.length > this.maxTiles) {
      const old = this.order.shift()!
      this.tiles.delete(old)
      if (old === this.lastKey) this.lastKey = -1
    }
  }

  /** Fetch every tile of level z overlapping the given lon/lat box (radians). */
  async ensureBox(z: number, west: number, south: number, east: number, north: number) {
    const n = 2 ** z
    const step = Math.PI / n
    const y0 = Math.max(0, Math.floor((Math.PI / 2 - north) / step))
    const y1 = Math.min(n - 1, Math.floor((Math.PI / 2 - south) / step))
    const jobs: Promise<unknown>[] = []
    const addX = (x0: number, x1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push(this.ensure(z, x, y))
    }
    const xs = (lon: number) => Math.floor((lon + Math.PI) / step)
    const nx = 2 * n
    if (east - west >= 2 * Math.PI) addX(0, nx - 1)
    else {
      const a = ((xs(west) % nx) + nx) % nx, b = ((xs(east) % nx) + nx) % nx
      if (a <= b) addX(a, b)
      else { addX(a, nx - 1); addX(0, b) }
    }
    await Promise.all(jobs)
  }

  ensure(z: number, x: number, y: number): Promise<Tile> {
    const k = this.key(z, x, y)
    if (this.tiles.has(k)) return Promise.resolve(this.tiles.get(k)!)
    let p = this.pending.get(k)
    if (!p) {
      p = this.load(z, x, y).then((t) => {
        this.pending.delete(k)
        if (t === undefined) return null
        this.store(k, t)
        return t
      })
      this.pending.set(k, p)
    }
    return p
  }

  /**
   * Bilinear height at lon/lat (radians) from level z, falling back to coarser loaded levels when a
   * tile is missing or not loaded yet. NaN only if nothing at all is available.
   */
  sample(lon: number, lat: number, z: number): number {
    for (let l = z; l >= 0; l--) {
      const v = this.sampleLevel(lon, lat, l)
      if (v === v) return v
    }
    return NaN
  }

  private sampleLevel(lon: number, lat: number, z: number): number {
    const n = 2 ** z
    const W = DEM_TILE * 2 * n, H = DEM_TILE * n
    // global pixel coordinates (pixel centres at +0.5)
    let gx = ((lon + Math.PI) / (2 * Math.PI)) * W - 0.5
    const gy = Math.min(Math.max(((Math.PI / 2 - lat) / Math.PI) * H - 0.5, 0), H - 1.0001)
    gx = ((gx % W) + W) % W
    const x0 = Math.floor(gx), y0 = Math.floor(gy)
    const fx = gx - x0, fy = gy - y0
    const lx = x0 % DEM_TILE, ly = y0 % DEM_TILE
    if (lx < DEM_TILE - 1 && ly < DEM_TILE - 1) {
      // fast path (almost always): all four corners in the same tile -> one lookup
      const t = this.tile(z, (x0 / DEM_TILE) | 0, (y0 / DEM_TILE) | 0)
      if (!t) return NaN
      const i = ly * DEM_TILE + lx
      const a = t[i], b = t[i + 1], c = t[i + DEM_TILE], d = t[i + DEM_TILE + 1]
      if (!a || !b || !c || !d) return NaN // no data at a corner
      const dn = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
      return this.cfg.offset + this.cfg.scale * dn
    }
    const x1 = (x0 + 1) % W, y1 = Math.min(y0 + 1, H - 1)
    const a = this.px(z, x0, y0), b = this.px(z, x1, y0), c = this.px(z, x0, y1), d = this.px(z, x1, y1)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
  }

  private tile(z: number, tx: number, ty: number): Tile | undefined {
    const k = this.key(z, tx, ty)
    if (k === this.lastKey) return this.lastTile
    const t = this.tiles.get(k)
    this.lastKey = k
    this.lastTile = t
    return t
  }

  private px(z: number, gx: number, gy: number): number {
    const tx = (gx / DEM_TILE) | 0, ty = (gy / DEM_TILE) | 0
    const t = this.tile(z, tx, ty)
    if (!t) return NaN
    const dn = t[(gy - ty * DEM_TILE) * DEM_TILE + (gx - tx * DEM_TILE)]
    return dn ? this.cfg.offset + this.cfg.scale * dn : NaN
  }
}
