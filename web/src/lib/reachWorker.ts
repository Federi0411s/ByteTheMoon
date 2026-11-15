/**
 * Reachable area from a point under a maximum-slope limit, in a Web Worker.
 *
 * Model: a cell is passable when its terrain slope (the steepest gradient, i.e. the slope you face
 * driving straight up OR down it, Horn's 3 x 3 estimate on the elevation grid) is within the limit;
 * the reachable area is the set of cells connected to the start through passable cells
 * (8-neighbour moves). Using the gradient magnitude rather than the slope along the direction of
 * travel means a path can't "zig-zag" up a hill steeper than the limit, which a vehicle couldn't do
 * either (it would tip sideways).
 *
 * Algorithm: instead of one flood fill per limit, a bottleneck (minimax) search computes for every
 * cell the smallest limit that reaches it: val(n) = min over paths of the max slope along the path,
 * i.e. val(n) = max(val(c), slope(n)) relaxed from the neighbours c. Slopes are integers (0.1 deg), so
 * the priority queue is a bucket queue (Dial): O(1) push/pop, linear time overall. Then:
 *  - any lower limit is just a threshold on val: no recomputation at all;
 *  - a higher limit resumes the search where it stopped (the buckets above the old limit are kept);
 *  - cells are explored only up to the current limit, and the elevation tiles are downloaded
 *    lazily, one 64 x 64 block at a time, when the search first touches a block: a site enclosed by
 *    steep crater walls downloads almost nothing.
 * Blocks load asynchronously while the search goes on elsewhere, so a cell may be reached first
 * through a worse path; the search is label-correcting (a better value re-queues the cell and stale
 * queue entries are skipped), which keeps the result exact.
 *
 * Two passes: the shipped 666 m elevation tiles first (an answer within a fraction of a second), then
 * the finest available (167 m global tiles from the bucket and/or the 160 m south polar DEM).
 */
import { DemSampler, demPixelM, type DemConfig } from './dem'
import { MAX_Q, MOON_R, SLOPE_QUANTUM, stereoForward, stereoInverse, UNSEEN, WALL, type ReachGrid } from './reachGrid'

const BLOCK = 64
const BLOCK_SHIFT = 6
/** slope sentinels (valid slopes are 0..MAX_Q) */
const NOT_LOADED = 0xffff
const NO_DATA = 0xfffe
/** blocks loading at once (the sampler itself caps concurrent tile fetches) */
const MAX_BLOCK_LOADS = 6
const R2D = 180 / Math.PI

export type ReachRequest =
  | { type: 'start'; job: number; cfg: DemConfig; latDeg: number; lonDeg: number; radiusM: number; maxDeg: number }
  | { type: 'limit'; job: number; maxDeg: number }
  | { type: 'stop' }

export type ReachReply =
  | { type: 'result'; job: number; grid: ReachGrid; val: Uint16Array; exploredQ: number; level: number; final: boolean; ms: number }
  | { type: 'error'; job: number; error: string }

const toQ = (deg: number) => Math.max(0, Math.min(MAX_Q, Math.floor(deg * SLOPE_QUANTUM + 1e-9)))

class Pass {
  readonly grid: ReachGrid
  readonly z: number
  private readonly sampler: DemSampler
  private readonly cfg: DemConfig
  private readonly n: number
  private readonly W: number // padded row length (n + 2): a WALL frame removes all bounds checks
  readonly val: Uint16Array
  private readonly slope: Uint16Array
  private readonly off: Int32Array
  private readonly nb: number
  private readonly blockState: Uint8Array // 0 untouched, 1 loading, 2 loaded
  private readonly parked: (number[] | undefined)[]
  private readonly buckets: (Int32Array | undefined)[] = new Array(MAX_Q + 1)
  private readonly bsize = new Int32Array(MAX_Q + 1)
  private cur = 0
  exploredQ = -1
  private readonly queue: number[] = []
  private readonly ready: number[] = []
  private loading = 0
  private wake: (() => void) | null = null
  private readonly sinLat0: number
  private readonly cosLat0: number
  /** projected position of the poles in cell coordinates (to widen the tile box of a block holding one) */
  private readonly poles: [number, number, number][] = []

  constructor(sampler: DemSampler, cfg: DemConfig, z: number, lat0: number, lon0: number, radiusM: number) {
    this.sampler = sampler
    this.cfg = cfg
    this.z = z
    const cell = demPixelM(z)
    const half = Math.ceil(radiusM / cell)
    const n = 2 * half + 1
    this.n = n
    this.grid = { lat0, lon0, n, cell, radiusM }
    const W = (this.W = n + 2)
    this.val = new Uint16Array(W * W).fill(UNSEEN)
    this.slope = new Uint16Array(W * W).fill(NOT_LOADED)
    this.off = Int32Array.from([-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1])
    this.nb = Math.ceil(n / BLOCK)
    this.blockState = new Uint8Array(this.nb * this.nb)
    this.parked = new Array(this.nb * this.nb)
    this.sinLat0 = Math.sin(lat0)
    this.cosLat0 = Math.cos(lat0)

    // frame and everything outside the search circle: walls
    const val = this.val, r2 = (radiusM / cell) ** 2
    for (let j = 0; j < W; j++) {
      const dj = j - 1 - half
      for (let i = 0; i < W; i++) {
        const di = i - 1 - half
        if (i === 0 || j === 0 || i === W - 1 || j === W - 1 || di * di + dj * dj > r2) val[j * W + i] = WALL
      }
    }
    const p = new Float64Array(3)
    for (const pl of [Math.PI / 2, -Math.PI / 2]) {
      stereoForward(lat0, lon0, 0, pl, p)
      if (p[2] > -0.5) this.poles.push([p[0] / cell + half, half - p[1] / cell, pl])
    }
    // the start: reachable by definition (the lander is there), whatever its own slope
    const s0 = (half + 1) * W + half + 1
    val[s0] = 0
    this.push(0, s0)
  }

  private push(q: number, cellIdx: number) {
    let b = this.buckets[q]
    const size = this.bsize[q]
    if (!b) b = this.buckets[q] = new Int32Array(256)
    else if (size === b.length) {
      const nb = new Int32Array(size * 2)
      nb.set(b)
      b = this.buckets[q] = nb
    }
    b[size] = cellIdx
    this.bsize[q] = size + 1
    if (q < this.cur) this.cur = q
  }

  /** Explore every cell reachable within target() (re-read on every round, so it may rise meanwhile). */
  async explore(target: () => number, alive: () => boolean) {
    for (;;) {
      if (!alive()) return
      while (this.ready.length) {
        const b = this.ready.pop()!
        const list = this.parked[b]
        this.parked[b] = undefined
        if (list) for (const c of list) this.push(this.val[c], c) // re-examine with the block now loaded
      }
      const T = target()
      this.run(T)
      if (!this.loading && !this.queue.length && !this.ready.length) { this.exploredQ = T; return }
      if (!this.ready.length) await new Promise<void>((res) => (this.wake = res))
    }
  }

  /** The hot loop: bucket-queue bottleneck search up to limit T over the loaded blocks. */
  private run(T: number) {
    const val = this.val, slope = this.slope, off = this.off, bsize = this.bsize, buckets = this.buckets
    let cur = this.cur
    for (;;) {
      while (cur <= T && bsize[cur] === 0) cur++
      if (cur > T) break
      const bk = buckets[cur]!
      const c = bk[--bsize[cur]]
      if (val[c] !== cur) continue // stale entry: improved since it was queued
      for (let k = 0; k < 8; k++) {
        const m = c + off[k]
        const vm = val[m]
        if (vm <= cur || vm === WALL) continue // already as good, or never passable
        const sm = slope[m]
        if (sm === NOT_LOADED) { this.park(c, m); continue }
        if (sm === NO_DATA) { val[m] = WALL; continue }
        const nv = sm > cur ? sm : cur
        if (nv < vm) {
          val[m] = nv
          // push(nv, m), inlined (nv >= cur: never lowers the bucket pointer)
          let b = buckets[nv]
          const size = bsize[nv]
          if (!b) b = buckets[nv] = new Int32Array(256)
          else if (size === b.length) {
            const grown = new Int32Array(size * 2)
            grown.set(b)
            b = buckets[nv] = grown
          }
          b[size] = m
          bsize[nv] = size + 1
        }
      }
    }
    this.cur = cur
  }

  /** Neighbour m of c lies in a block not loaded yet: queue its load and come back to c afterwards. */
  private park(c: number, m: number) {
    const W = this.W
    const j = ((m / W) | 0) - 1, i = (m % W) - 1
    const b = (j >> BLOCK_SHIFT) * this.nb + (i >> BLOCK_SHIFT)
    let list = this.parked[b]
    if (!list) list = this.parked[b] = []
    if (list[list.length - 1] !== c) list.push(c)
    if (this.blockState[b] === 0) {
      this.blockState[b] = 1
      this.queue.push(b)
      this.pump()
    }
  }

  private pump() {
    while (this.loading < MAX_BLOCK_LOADS && this.queue.length) {
      const b = this.queue.shift()!
      this.loading++
      this.loadBlock(b).catch(() => this.fillBlock(b, null)).finally(() => {
        this.loading--
        this.blockState[b] = 2
        this.ready.push(b)
        const w = this.wake
        this.wake = null
        w?.()
        this.pump()
      })
    }
  }

  /** Elevations of block b plus a 1-cell margin (Horn needs the 3 x 3 neighbourhood), then its slopes. */
  private async loadBlock(b: number) {
    const { n, grid } = this, cell = grid.cell, half = (n - 1) / 2
    const bi = b % this.nb, bj = (b / this.nb) | 0
    const i0 = bi * BLOCK - 1, j0 = bj * BLOCK - 1 // window origin (cell coordinates, may be -1)
    const ww = Math.min(n, (bi + 1) * BLOCK) - bi * BLOCK + 2
    const wh = Math.min(n, (bj + 1) * BLOCK) - bj * BLOCK + 2
    const lon = new Float64Array(ww * wh), lat = new Float64Array(ww * wh)
    const p = new Float64Array(2), s0 = this.sinLat0, c0 = this.cosLat0, lon0 = grid.lon0
    let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity
    for (let wj = 0; wj < wh; wj++) {
      const y = (half - (j0 + wj)) * cell
      for (let wi = 0; wi < ww; wi++) {
        stereoInverse(s0, c0, lon0, (i0 + wi - half) * cell, y, p)
        const k = wj * ww + wi
        lon[k] = p[0]
        lat[k] = p[1]
        // the box comes from the window border (extremes of a convex patch without a pole lie on it)
        if (wj === 0 || wi === 0 || wj === wh - 1 || wi === ww - 1) {
          if (p[1] < latMin) latMin = p[1]
          if (p[1] > latMax) latMax = p[1]
          if (p[0] < lonMin) lonMin = p[0]
          if (p[0] > lonMax) lonMax = p[0]
        }
      }
    }
    // a pole inside (or next to) the window: every longitude, up to the pole
    for (const [px, py, pl] of this.poles) {
      if (px >= i0 - 2 && px <= i0 + ww + 1 && py >= j0 - 2 && py <= j0 + wh + 1) {
        lonMin = -Math.PI
        lonMax = Math.PI
        if (pl > 0) latMax = pl
        else latMin = pl
      }
    }
    // margin: two pixels of the sampled level for the bilinear neighbours
    const m = (2 * Math.PI) / (256 * 2 ** this.z)
    latMin = Math.max(-Math.PI / 2, latMin - m)
    latMax = Math.min(Math.PI / 2, latMax + m)
    const lm = m / Math.max(Math.cos(Math.max(Math.abs(latMin), Math.abs(latMax))), 0.01)
    lonMin -= lm
    lonMax += lm

    const hold: number[] = []
    try {
      await this.sampler.ensureBox(this.z, lonMin, latMin, lonMax, latMax, hold)
      // no fine global tiles (no bucket): read the shipped level there instead (the polar DEM still
      // supplies its fine levels inside the polar cap)
      if (this.z > this.cfg.publicMaxLevel && this.sampler.maxLevel < this.z) {
        await this.sampler.ensureBox(this.cfg.publicMaxLevel, lonMin, latMin, lonMax, latMax, hold)
      }
      const elev = new Float32Array(ww * wh)
      for (let k = 0; k < elev.length; k++) elev[k] = this.sampler.sample(lon[k], lat[k], this.z)
      this.fillBlock(b, elev, ww)
    } finally {
      this.sampler.unpin(hold)
    }
  }

  /** Horn slopes of block b's cells from its window elevations (null: no data at all). */
  private fillBlock(b: number, elev: Float32Array | null, ww = 0) {
    const { n, W, slope } = this
    const bi = b % this.nb, bj = (b / this.nb) | 0
    const ci0 = bi * BLOCK, cj0 = bj * BLOCK
    const ci1 = Math.min(n, ci0 + BLOCK), cj1 = Math.min(n, cj0 + BLOCK)
    const inv8 = 1 / (8 * this.grid.cell)
    for (let cj = cj0; cj < cj1; cj++) {
      const row = (cj + 1) * W + 1
      for (let ci = ci0; ci < ci1; ci++) {
        if (!elev) { slope[row + ci] = NO_DATA; continue }
        const wi = ci - ci0 + 1, wj = cj - cj0 + 1
        const k = wj * ww + wi
        const a = elev[k - ww - 1], bb = elev[k - ww], c = elev[k - ww + 1]
        const d = elev[k - 1], f = elev[k + 1]
        const g = elev[k + ww - 1], h = elev[k + ww], ii = elev[k + ww + 1]
        const gx = (c + 2 * f + ii - (a + 2 * d + g)) * inv8
        const gy = (g + 2 * h + ii - (a + 2 * bb + c)) * inv8
        const t = Math.sqrt(gx * gx + gy * gy)
        if (t !== t) { slope[row + ci] = NO_DATA; continue } // a NaN height in the 3 x 3 window
        // rounded up: a cell counts as passable only if its slope is surely within the limit
        const q = Math.ceil(Math.atan(t) * R2D * SLOPE_QUANTUM - 1e-6)
        slope[row + ci] = q > MAX_Q ? MAX_Q : q < 0 ? 0 : q
      }
    }
  }

  /** Interior values (n x n, row 0 = north). */
  snapshot(): Uint16Array {
    const { n, W, val } = this
    const out = new Uint16Array(n * n)
    for (let j = 0; j < n; j++) out.set(val.subarray((j + 1) * W + 1, (j + 1) * W + 1 + n), j * n)
    return out
  }
}

// ---------- job control ----------
let sampler: DemSampler | null = null
let samplerKey = ''
let job = 0
let target = 0
let current: Pass | null = null
let currentFinal = false
let busy = false
let t0 = 0

function post(p: Pass, final: boolean, j: number) {
  const val = p.snapshot()
  const msg: ReachReply = { type: 'result', job: j, grid: p.grid, val, exploredQ: p.exploredQ, level: p.z, final, ms: Math.round(performance.now() - t0) }
  ;(self as unknown as Worker).postMessage(msg, [val.buffer])
}

/**
 * Explore the current pass up to the target (again, if the target rose meanwhile), report it, then go
 * idle. The last check and `busy = false` run in one synchronous step, so a 'limit' message can't
 * slip in between and be lost.
 */
async function settle(j: number) {
  const alive = () => j === job
  for (;;) {
    if (!alive()) return
    const p = current
    if (!p || p.exploredQ >= target) { busy = false; return }
    await p.explore(() => target, alive)
    if (alive() && p === current) post(p, currentFinal, j)
  }
}

async function start(m: Extract<ReachRequest, { type: 'start' }>) {
  const j = m.job
  const alive = () => j === job
  const key = JSON.stringify(m.cfg)
  if (!sampler || key !== samplerKey) {
    sampler = new DemSampler(m.cfg, 400)
    samplerKey = key
  }
  const s = sampler
  const lat0 = (m.latDeg * Math.PI) / 180, lon0 = (m.lonDeg * Math.PI) / 180
  t0 = performance.now()
  busy = true
  try {
    // pass 1: shipped tiles
    const zc = m.cfg.publicMaxLevel
    const zf = m.cfg.fineMaxLevel
    current = new Pass(s, m.cfg, zc, lat0, lon0, m.radiusM)
    currentFinal = false
    await current.explore(() => target, alive)
    if (!alive()) return

    // pass 2: finest available, if it adds anything (fine global tiles, or the fine polar DEM
    // covering the whole circle)
    let fine = false
    if (zf > zc) {
      const d = m.radiusM / MOON_R
      // polar DEM cap latitude (absent on samplers without the south polar DEM)
      const capLat = (s as unknown as { polarCapLat?: number }).polarCapLat ?? -Math.PI / 2
      const inPolarCap = lat0 + d < capLat
      if (inPolarCap) fine = true
      else if (m.cfg.fineUrl) {
        await s.ensureBox(zf, lon0 - 1e-4, lat0 - 1e-4, lon0 + 1e-4, lat0 + 1e-4) // probe the bucket
        fine = s.maxLevel >= zf
      }
    }
    if (!alive()) return
    if (!fine) {
      currentFinal = true
      post(current, true, j)
      await settle(j) // the limit may have risen while this ran
      return
    }
    post(current, false, j)
    current = new Pass(s, m.cfg, zf, lat0, lon0, m.radiusM)
    currentFinal = true
    await settle(j)
  } catch (err) {
    if (alive()) {
      busy = false
      ;(self as unknown as Worker).postMessage({ type: 'error', job: j, error: String(err) } satisfies ReachReply)
    }
  }
}

self.onmessage = (e: MessageEvent<ReachRequest>) => {
  const m = e.data
  if (m.type === 'start') {
    job = m.job
    target = toQ(m.maxDeg)
    current = null
    void start(m)
  } else if (m.type === 'limit') {
    if (m.job !== job) return
    target = toQ(m.maxDeg)
    // a running job picks the new target up by itself; an idle one resumes its last pass
    if (!busy && current && current.exploredQ < target) {
      busy = true
      t0 = performance.now()
      void settle(job)
    }
  } else if (m.type === 'stop') {
    job++
    current = null
    busy = false
  }
}
