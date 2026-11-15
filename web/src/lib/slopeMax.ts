/**
 * Steepest slope inside a landing footprint, for the landing-suitability score.
 *
 * What limits a landing is the steepest terrain anywhere inside the landing ellipse (see
 * lib/requirements.ts), not the average slope. The slope pyramid (pipeline/slope_tiles.py) stores in
 * its G channel, for every pixel of every level, the max of the native 118 m LOLA slopes inside that
 * pixel. So the max over a footprint is the max of the pyramid pixels it touches, and reading a
 * coarser level can only overestimate it: always on the safe side.
 *
 * Level per map tile: the finest level (no finer than the map tile being drawn, so a zoomed-out view
 * never downloads street-level tiles) at which the footprint spans a bounded number of cells. Zoomed out,
 * or very near the poles (where geographic pixels get thin), coarser pixels make the check stricter
 * than the footprint itself; it tightens as you zoom in.
 *
 * The answer is per pyramid cell (down to 167 m), so the score map's slope criterion and slope limit
 * are drawn at that resolution, independently of the (coarser) heatmap sample grid.
 */
import type { PyramidIndex } from './pyramid'

const R = 1737400
const TILE = 256
/** footprint half-size limits in cells (north-south / east-west) when choosing the level */
const MAX_ROWS = 16
const MAX_COLS = 256
const MAX_FETCHES = 6
const CACHE_TILES = 320 // 64 KB each
/** levels whose tiles needed for one map tile exceed this are skipped (a coarser one is used) */
const MAX_TILES_PER_LEVEL = 48
const FETCH_TIMEOUT_MS = 20_000
/** latitude bands per map tile in levelsBanded */
const MAX_BANDS = 6

/** raw max-slope DN per pixel (0 = no data); null = tile missing */
type Tile = Uint8Array | null

export class SlopeMaxTiles {
  private readonly p: PyramidIndex
  private fineBroken: boolean
  private anyFine = false
  private readonly tiles = new Map<number, Tile>()
  private readonly pending = new Map<number, Promise<void>>()
  private active = 0
  private readonly waiting: (() => void)[] = []
  private ctx: OffscreenCanvasRenderingContext2D | null = null

  constructor(p: PyramidIndex) {
    this.p = p
    this.fineBroken = !p.fineUrl
  }

  get maxLevel() {
    return this.fineBroken ? this.p.publicMaxLevel : this.p.fineMaxLevel
  }

  private static key(z: number, x: number, y: number) {
    return (z * 8192 + y) * 16384 + x
  }

  private async slot() {
    if (this.active >= MAX_FETCHES) await new Promise<void>((res) => this.waiting.push(res))
    this.active++
  }

  private release() {
    this.active--
    this.waiting.shift()?.()
  }

  /** Fetch + decode one tile into the cache (missing -> null; transient failure -> not cached). */
  private load(z: number, x: number, y: number): Promise<void> {
    const k = SlopeMaxTiles.key(z, x, y)
    if (this.tiles.has(k)) return Promise.resolve()
    let p = this.pending.get(k)
    if (p) return p
    p = (async () => {
      const fine = z > this.p.publicMaxLevel
      if (fine && this.fineBroken) { this.store(k, null); return }
      await this.slot()
      try {
        const base = fine ? this.p.fineUrl! : this.p.publicUrl
        const r = await fetch(`${base}/${z}/${x}/${y}.webp`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('image/')) {
          // as PyramidImageryProvider: a fine store that answers 404 / non-images before any fine tile loaded is absent
          if (fine && !this.anyFine && (r.status === 404 || r.ok)) this.fineBroken = true
          this.store(k, null)
          return
        }
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
        const ctx = (this.ctx ??= new OffscreenCanvas(TILE, TILE).getContext('2d', { willReadFrequently: true })!)
        ctx.clearRect(0, 0, TILE, TILE)
        ctx.drawImage(bmp, 0, 0)
        bmp.close()
        const px = ctx.getImageData(0, 0, TILE, TILE).data
        if (fine) this.anyFine = true
        const out = new Uint8Array(TILE * TILE)
        for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 2] === 0 ? 0 : px[i * 4 + 1] // G = max, B = 0: no data
        this.store(k, out)
      } catch {
        // transient (timeout / network): not cached, a later request retries
      } finally {
        this.release()
        this.pending.delete(k)
      }
    })()
    this.pending.set(k, p)
    return p
  }

  private store(k: number, t: Tile) {
    this.tiles.delete(k)
    this.tiles.set(k, t)
    while (this.tiles.size > CACHE_TILES) this.tiles.delete(this.tiles.keys().next().value!)
  }

  /**
   * Finest level <= cap at which the footprint (half-size a m) at latitude lat spans at most
   * MAX_ROWS cells north-south and MAX_COLS east-west from its centre (bounds the per-tile work).
   */
  private static levelFor(lat: number, a: number, cap: number) {
    const c = Math.max(Math.cos(lat), 1e-6)
    for (let L = cap; L > 0; L--) {
      const p = (Math.PI * R) / (TILE * 2 ** L)
      if (a / p <= MAX_ROWS && a / (p * c) <= MAX_COLS) return L
    }
    return 0
  }

  /** Tiles of level L covering rows r0..r1 and (unwrapped) columns c0..c1; false if too many. */
  private async loadCells(L: number, r0: number, r1: number, c0: number, c1: number) {
    const cols = 2 * TILE * 2 ** L
    const ty0 = r0 >> 8, ty1 = r1 >> 8
    const all = c1 - c0 + 1 >= cols
    const tx0 = all ? 0 : Math.floor(c0 / TILE), tx1 = all ? cols / TILE - 1 : Math.floor(c1 / TILE)
    if ((ty1 - ty0 + 1) * (tx1 - tx0 + 1) > MAX_TILES_PER_LEVEL) return false
    const n = cols / TILE, jobs: Promise<void>[] = []
    for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) jobs.push(this.load(L, ((x % n) + n) % n, y))
    await Promise.all(jobs)
    return true
  }

  /**
   * As levels(), but the tile is split into latitude bands in which cos(latitude) varies by at most
   * 2x, each checked at its own level. levels() picks one level per tile from its most poleward
   * latitude, so a tile reaching the pole (every polar-row tile at every zoom) fell back to the coarsest
   * level, 21 km cells, and the polar regions were almost entirely excluded. Now only the band touching
   * the pole is coarse, over a few km. At most MAX_BANDS bands per tile.
   */
  async levelsBanded(rect: [number, number, number, number], z: number, a: number, b: number, azDeg: number, thresholds: number[]): Promise<(lon: number, lat: number) => number> {
    const [west, south, east, north] = rect
    // split points: latitudes where cos halves, going poleward from the equator-most edge
    const eqEdge = south <= 0 && north >= 0 ? 0 : Math.min(Math.abs(south), Math.abs(north))
    const polEdge = Math.max(Math.abs(south), Math.abs(north))
    const cuts: number[] = []
    for (let c = Math.cos(eqEdge) / 2; cuts.length < MAX_BANDS - 1; c /= 2) {
      const lat = Math.acos(c)
      if (lat >= polEdge) break
      cuts.push(lat)
    }
    if (!cuts.length) return this.levels(rect, z, a, b, azDeg, thresholds)
    // bands as [s, n] in signed latitude
    const bounds = [...new Set([south, north, ...cuts.flatMap((l) => [l, -l]).filter((l) => l > south && l < north)])].sort((x, y) => x - y)
    const bands: [number, number][] = []
    for (let i = 0; i + 1 < bounds.length; i++) bands.push([bounds[i], bounds[i + 1]])
    const checks = await Promise.all(bands.map(([s, n]) => this.levels([west, s, east, n], z, a, b, azDeg, thresholds)))
    return (lon, lat) => {
      for (let i = 0; i < bands.length; i++) if (lat <= bands[i][1] || i === bands.length - 1) return checks[i](lon, lat)
      return -1
    }
  }

  /** (lon, lat) -> true where the steepest slope in the footprint is <= limitDeg (false if steeper or unknown). */
  async checkerBanded(rect: [number, number, number, number], z: number, a: number, b: number, azDeg: number, limitDeg: number): Promise<(lon: number, lat: number) => boolean> {
    const lv = await this.levelsBanded(rect, z, a, b, azDeg, [limitDeg])
    return (lon, lat) => lv(lon, lat) === 0
  }

  /**
   * Classifier for one map tile (rect radians [w, s, e, n], level z): returns (lon, lat) -> how many of
   * `thresholds` (degrees, ascending) the steepest slope inside the footprint (semi-axes a >= b m,
   * major axis azDeg clockwise from north) centred there exceeds, 0..thresholds.length; -1 = no data.
   * One pass answers every score class boundary and the slope limit at once.
   *
   * Works on the pyramid cells of one level L for the whole tile: per threshold, cells steeper than it
   * are marked and prefix sums along each row give "any such cell in columns i..j" in O(1); the
   * ellipse is a column interval per kernel row, so each cell costs one lookup per kernel row and
   * threshold (highest threshold first: the first one exceeded decides). The footprint is centred on
   * the cell holding the point; cells count when their centre lies within the ellipse grown by half a
   * cell diagonal (i.e. cells it touches).
   */
  async levels(rect: [number, number, number, number], z: number, a: number, b: number, azDeg: number, thresholds: number[]): Promise<(lon: number, lat: number) => number> {
    const [west, south, east, north] = rect
    const K = thresholds.length
    const nearPole = Math.max(Math.abs(south), Math.abs(north))
    let L = SlopeMaxTiles.levelFor(nearPole, a, Math.min(this.maxLevel, Math.max(0, z)))
    for (; ; L--) {
      L = Math.min(L, this.maxLevel) // the fine store may turn out to be absent
      const pix = Math.PI / (TILE * 2 ** L), cellM = pix * R
      const cols = 2 * TILE * 2 ** L, rows = TILE * 2 ** L
      const h = 0.5 * cellM * Math.SQRT2
      const A = a + h, B = b + h
      const mRow = Math.ceil(A / cellM)
      const mCol = Math.min(Math.ceil(A / (cellM * Math.max(Math.cos(nearPole + mRow * pix), 1e-6))), cols)
      // output cells (those under the tile) and input cells (plus the footprint margin)
      const or0 = Math.max(0, Math.floor((Math.PI / 2 - north) / pix)), or1 = Math.min(rows - 1, Math.floor((Math.PI / 2 - south) / pix - 1e-9))
      const oc0 = Math.floor((west + Math.PI) / pix), oc1 = Math.floor((east + Math.PI) / pix - 1e-9)
      const ir0 = Math.max(0, or0 - mRow), ir1 = Math.min(rows - 1, or1 + mRow)
      const ic0 = oc0 - mCol, ic1 = oc1 + mCol
      if (!(await this.loadCells(L, ir0, ir1, ic0, ic1)) && L > 0) continue
      const nR = ir1 - ir0 + 1, nC = ic1 - ic0 + 1, W = nC + 1, plane = nR * W
      // prefix sums per input row: cells with data, and per threshold the cells steeper than it
      const data = new Int32Array(plane)
      const steep = new Int32Array(K * plane) // [threshold][row][col]
      const limitDn = thresholds.map((t) => (t - this.p.offset) / this.p.scale) // v = offset + scale * dn
      let missing = false
      for (let r = 0; r < nR && !missing; r++) {
        const row = ir0 + r, o = r * W
        let lastKey = -1, tile: Tile | undefined
        for (let c = 0; c < nC; c++) {
          const col = (((ic0 + c) % cols) + cols) % cols
          const k = SlopeMaxTiles.key(L, col >> 8, row >> 8)
          if (k !== lastKey) { tile = this.tiles.get(k); lastKey = k }
          if (tile === undefined) { missing = true; break }
          const dn = tile === null ? 0 : tile[((row & 255) << 8) | (col & 255)]
          data[o + c + 1] = data[o + c] + (dn > 0 ? 1 : 0)
          for (let q = 0; q < K; q++) {
            const so = q * plane + o
            steep[so + c + 1] = steep[so + c] + (dn > limitDn[q] ? 1 : 0)
          }
        }
      }
      if (missing) { if (L > 0) continue; return () => -1 }
      // ellipse -> column interval per kernel row (offsets in cells), per output row (cos varies)
      const az = (azDeg * Math.PI) / 180
      const ux = Math.sin(az), uy = Math.cos(az), vx = Math.cos(az), vy = -Math.sin(az)
      const qa = (ux * ux) / (A * A) + (vx * vx) / (B * B)
      const qb1 = 2 * ((ux * uy) / (A * A) + (vx * vy) / (B * B))
      const qc1 = (uy * uy) / (A * A) + (vy * vy) / (B * B)
      const oR = or1 - or0 + 1, oC = oc1 - oc0 + 1
      const out = new Int8Array(oR * oC)
      for (let r = 0; r < oR; r++) {
        const row = or0 + r
        const lo: number[] = [], hi: number[] = [], rr: number[] = []
        for (let dr = -mRow; dr <= mRow; dr++) {
          const ir = row + dr - ir0
          if (ir < 0 || ir >= nR) continue
          const dy = -dr * cellM // north positive; rows grow southward
          const qb = qb1 * dy, qc = qc1 * dy * dy - 1
          const disc = qb * qb - 4 * qa * qc
          if (disc < 0) continue
          const sq = Math.sqrt(disc)
          const cellE = cellM * Math.max(Math.cos(Math.PI / 2 - (row + dr + 0.5) * pix), 1e-9)
          let l = Math.ceil((-qb - sq) / (2 * qa) / cellE), u = Math.floor((-qb + sq) / (2 * qa) / cellE)
          if (dr === 0) { l = Math.min(l, 0); u = Math.max(u, 0) }
          l = Math.max(l, -mCol); u = Math.min(u, mCol)
          if (l > u) continue
          lo.push(l); hi.push(u + 1); rr.push(ir * W)
        }
        const nk = rr.length
        for (let c = 0; c < oC; c++) {
          const ci = oc0 + c - ic0 // input column of this output cell
          let level = -1
          for (let k = 0; k < nk; k++) {
            const o = rr[k] + ci
            if (data[o + hi[k]] - data[o + lo[k]] > 0) { level = 0; break }
          }
          // highest threshold first: the first one exceeded anywhere in the footprint decides
          for (let q = K - 1; q >= 0 && level === 0; q--) {
            const base = q * plane + ci
            for (let k = 0; k < nk; k++) {
              const o = base + rr[k]
              if (steep[o + hi[k]] - steep[o + lo[k]] > 0) { level = q + 1; break }
            }
          }
          out[r * oC + c] = level
        }
      }
      return (lon, lat) => {
        const r = Math.min(oR - 1, Math.max(0, Math.floor((Math.PI / 2 - lat) / pix) - or0))
        const c = Math.min(oC - 1, Math.max(0, Math.floor((lon + Math.PI) / pix) - oc0))
        return out[r * oC + c]
      }
    }
  }
}
