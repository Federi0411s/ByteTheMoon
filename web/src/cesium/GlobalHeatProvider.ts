import { Credit, Ellipsoid, Event, GeographicTilingScheme, Rectangle } from 'cesium'
import { getLut } from '../lib/colormaps'
import { demPixelM } from '../lib/dem'
import { fromPolar, heatGrid, tileGroup } from '../lib/heatGrid'
import { polarBlockSize, polarBox, polarSign, toPolar } from '../lib/heatGrid'
import type { HeatEngine, HeatTile, LandingHeatOptions } from '../lib/heatEngine'
import { PYR_TILE, type PyramidTiles } from '../lib/pyramidTiles'

/**
 * Whole-Moon heatmap layer computed on the fly (lib/heatEngine.ts + lib/heatWorker.ts).
 *
 * Cesium asks for the tiles on screen, coarse ones first; each is computed on a small grid of sample
 * points (edges shared with the neighbours) and bilinearly interpolated to 256 x 256, so a far view is
 * a smooth, gap-free rough estimate that sharpens tile by tile as you zoom or pan. Coarse tiles also
 * read coarse terrain (demMax = z + 2), so the first answer comes back fast.
 *
 * Tiles poleward of 67.5 degrees are drawn from shared polar blocks sampled evenly on the ground
 * instead (see heatGrid.POLAR_LAT): a lon/lat grid there drew radial spokes around the poles.
 *
 * Where a better precomputed map exists (the 60 m LOLA polar products, or their mission-period
 * version) `polar(lon, lat)` returns it and it replaces the computed value pixel by pixel.
 */
export type HeatValues = {
  sun: number; earth: number; slope: number; elev: number
  cMean: number; cMin: number; cBelow: number // EQUIPOT surface charging (V, V, fraction)
  tMean: number; tMin: number; tMax: number // regolith surface temperature (K), only with `thermal`
  fSky: number // visible-sky fraction (radiation)
  dark: number // longest continuous night in the window (h)
  link: number; linkGap: number; sunlit: number // landing criteria (DSN link %, longest gap h, sunlit %), only with `landing`
  /** per-pixel value from the `pixel` option (NaN without it) */
  pixel: number
}

export interface GlobalHeatOptions {
  engine: HeatEngine
  /** value to draw from the interpolated samples (NaN = transparent) */
  value: (v: HeatValues, lon: number, lat: number) => number
  /** higher-quality override where available; NaN = none here */
  polar?: (lon: number, lat: number) => number
  /** latitude (radians) below which `polar` is consulted */
  polarBelowLat?: number
  min: number
  max: number
  colormap: string
  credit?: string
  /** samples per tile side (edges included) */
  samples?: number
  maximumLevel?: number
  /** restrict to a rectangle (radians [w, s, e, n]), e.g. the refined patch around a selected site */
  boundsRad?: [number, number, number, number]
  /** finest elevation level to use: (tile level) -> level; default z + 2 */
  demLevel?: (z: number) => number
  /** contrast around mid-range, as in FieldImageryProvider */
  contrast?: number
  /** also run the regolith temperature model (expensive: only for the temperature layers) */
  thermal?: boolean
  /** calculate the Landing Score criteria for the suitability heatmap */
  landing?: LandingHeatOptions
  /**
   * The fields `value` reads (default: all). Only these are interpolated per pixel, which is most of
   * the drawing cost: the score layer needs 5-7 of the 16.
   */
  fields?: readonly Field[]
  /**
   * Draw only inside this circle ([lon rad, lat rad, radius m]): tiles wholly outside it are not
   * computed at all, partly covered ones skip the samples outside it (with `landing`), and pixels
   * outside it are transparent.
   */
  circle?: [number, number, number]
  /**
   * Compute order: nearest the focus centre first (tiles on screen before the others, coarser before
   * finer at the same distance), instead of the engine's newest-first. `inView` tells which tiles are
   * on screen now; it is re-read whenever work is handed out.
   */
  prioritize?: { inView?: (rect: Rectangle) => boolean }
  /**
   * Per-tile pixel mask (e.g. the score's steepest-slope-in-footprint limit), prepared once per tile
   * (rect radians [w, s, e, n], level z): pixels where it returns false are transparent.
   */
  mask?: (rect: [number, number, number, number], z: number) => Promise<(lon: number, lat: number) => boolean>
  /**
   * Per-tile, per-pixel input prepared once per tile (e.g. the score's footprint slope class at the
   * slope pyramid's resolution): its value is passed to `value` as v.pixel.
   */
  pixel?: (rect: [number, number, number, number], z: number) => Promise<(lon: number, lat: number) => number>
  /**
   * DEM-guided (joint bilateral) upsampling: the elevation pyramid read at the display resolution.
   * Each pixel mixes the 4 x 4 nearest samples weighted by distance AND by how close each sample's
   * elevation is to the pixel's own, so shadow edges and crater rims follow the terrain instead of
   * being smeared bilinearly. Unset = plain bilinear.
   */
  guide?: PyramidTiles
  /** Precomputed sky view, when the radiation filter must use the same source as its map layer. */
  sky?: PyramidTiles
  /**
   * Refined area (e.g. around the selected site): from `minLevel` on, tiles touching it read the
   * finest elevation tiles (`demLevel`, downloaded on demand) and are sampled at that DEM's own
   * resolution (capped at `samples` per side). Everything else keeps the zoom-dependent defaults.
   */
  focus?: { boundsRad: [number, number, number, number]; samples: number; demLevel: number; minLevel: number; center?: [number, number]; radiusM?: number }
}

const TILE = 256
const MOON_R = 1737400

/** Great-circle distance (m) from (lon, lat) to the nearest point of a geographic rectangle (approx.). */
function distanceToRect(lon: number, lat: number, r: Rectangle) {
  const cLat = Math.min(Math.max(lat, r.south), r.north)
  let dl = lon - Math.min(Math.max(lon, r.west), r.east)
  // longitude wrap: try the edge on the other side of the antimeridian too
  if (Math.abs(dl) > Math.PI) dl = 2 * Math.PI - Math.abs(dl)
  const cLon = lon - dl
  const s = Math.sin((cLat - lat) / 2) ** 2 + Math.cos(lat) * Math.cos(cLat) * Math.sin((cLon - lon) / 2) ** 2
  return 2 * MOON_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** cos of the angular distance between two points (radians). */
const cosDist = (lon0: number, lat0: number, lon: number, lat: number) =>
  Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(lon - lon0)

/** True if every point of the (lon, lat) region sampled by `pts` lies within radius m of the centre. */
function allWithin(c: [number, number, number], pts: [number, number][]) {
  const cosR = Math.cos(c[2] / MOON_R)
  return pts.every(([lon, lat]) => cosDist(c[0], c[1], lon, lat) >= cosR)
}

/** 5 x 5 points over a geographic rectangle (edges included): enough to tell "wholly inside a circle". */
function rectPoints(w: number, s: number, e: number, n: number): [number, number][] {
  const out: [number, number][] = []
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) out.push([w + ((e - w) * i) / 4, s + ((n - s) * j) / 4])
  return out
}

const FIELDS = ['sun', 'earth', 'slope', 'elev', 'cMean', 'cMin', 'cBelow', 'fSky', 'dark', 'tMean', 'tMin', 'tMax', 'link', 'linkGap', 'sunlit'] as const
export type Field = (typeof FIELDS)[number]

const reliefCache = new WeakMap<HeatTile, number>()
/**
 * Range scale (m) of the guided upsampling for one sample grid: the typical elevation change between
 * neighbouring samples, so the kernel adapts to flat maria and to rugged highlands alike.
 */
function relief(t: HeatTile): number {
  let r = reliefCache.get(t)
  if (r !== undefined) return r
  let sum = 0, n = 0
  const e = t.elev, nx = t.nx, ny = t.ny
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = e[j * nx + i]
    if (i + 1 < nx) { const d = Math.abs(e[j * nx + i + 1] - c); if (d === d) { sum += d; n++ } }
    if (j + 1 < ny) { const d = Math.abs(e[(j + 1) * nx + i] - c); if (d === d) { sum += d; n++ } }
  }
  r = Math.max(10, n ? sum / n : 10)
  reliefCache.set(t, r)
  return r
}

// exp(-x) for x >= 0 from a table (linear interpolation, ~1e-4 relative): the guided upsampling needs
// 24 of these per pixel, which made Math.exp a large part of each tile's main-thread time
const EXP_MAX = 16, EXP_N = 2048, EXP_STEP = EXP_N / EXP_MAX
const EXP_LUT = new Float64Array(EXP_N + 2).map((_, i) => Math.exp(-i / EXP_STEP))
function expNeg(x: number) {
  if (x >= EXP_MAX) return 0
  const f = x * EXP_STEP, i = f | 0
  return EXP_LUT[i] + (EXP_LUT[i + 1] - EXP_LUT[i]) * (f - i)
}

/** The fields of one sample grid that a layer interpolates: names + arrays (present ones only). */
interface FieldSet { names: Field[]; arrays: Float32Array[] }
const fieldSets = new WeakMap<HeatTile, Map<readonly Field[], FieldSet>>()
function fieldSet(t: HeatTile, want: readonly Field[]): FieldSet {
  let m = fieldSets.get(t)
  if (!m) fieldSets.set(t, (m = new Map()))
  let fs = m.get(want)
  if (!fs) {
    const names = want.filter((f) => t[f].length > 0)
    fs = { names, arrays: names.map((f) => t[f]) }
    m.set(want, fs)
  }
  return fs
}
/** Fields the layer wants that no sample grid provides (e.g. temperatures without `thermal`): NaN. */
function clearAbsent(v: HeatValues, t: HeatTile, want: readonly Field[]) {
  for (const f of want) if (!t[f].length) v[f] = NaN
}

const wX = new Float64Array(4), wY = new Float64Array(4), wK = new Float64Array(16)
/** spatial weight below which a kernel sample is skipped (the 4 x 4 corners are ~1e-4 of the centre) */
const W_MIN = 2e-3

/** Spatial weights of the guided kernel for fractional coordinate f, first sample index i0 - 1, into w[o..o+3]. */
function axisWeights(f: number, i0: number, w: Float64Array, o: number) {
  for (let a = 0; a < 4; a++) {
    const d = f - (i0 - 1 + a)
    w[o + a] = expNeg((d * d) / 0.72)
  }
}

/**
 * The joint bilateral part of interpolate(), with the spatial weights given (wx[ox..ox+3], wy[oy..]):
 * in a geographic tile they depend only on the pixel column / row, so paint() computes them once per
 * column and row instead of per pixel. Returns false where no sample is similar enough (-> bilinear).
 */
function bilateral(v: HeatValues, t: HeatTile, x0: number, y0: number, wx: Float64Array, ox: number, wy: Float64Array, oy: number, gp: number, sigR: number, fs: FieldSet): boolean {
  const nx = t.nx, kx = nx - 1, ky = t.ny - 1
  const scale = EXP_STEP / (2 * sigR * sigR) // range exponent straight in table units
  const elev = t.elev, sun = t.sun
  // the kernel's non-zero entries (sample index, weight), then each field over that short list
  let ws = 0, m = 0
  for (let b = 0; b < 4; b++) {
    const sj = y0 - 1 + b
    if (sj < 0 || sj > ky) continue
    const wb = wy[oy + b], rowK = sj * nx
    for (let a = 0; a < 4; a++) {
      const si = x0 - 1 + a
      const w0 = wx[ox + a] * wb
      if (!(w0 > W_MIN) || si < 0 || si > kx) continue
      const k = rowK + si, e = elev[k]
      if (!(e === e && sun[k] === sun[k])) continue
      const de = e - gp, f = de * de * scale
      if (f >= EXP_N) continue
      const i = f | 0
      const w = w0 * (EXP_LUT[i] + (EXP_LUT[i + 1] - EXP_LUT[i]) * (f - i))
      kIdx[m] = k
      wK[m++] = w
      ws += w
    }
  }
  if (!(ws > 1e-6)) return false
  const names = fs.names, arrays = fs.arrays, nf = names.length, rs = 1 / ws
  for (let q = 0; q < nf; q++) {
    const arr = arrays[q]
    let acc = 0
    for (let n = 0; n < m; n++) acc += wK[n] * arr[kIdx[n]]
    v[names[q]] = acc * rs
  }
  return true
}
const kIdx = new Int32Array(16)

/** Plain bilinear interpolation of the fields of `fs` at (fx, fy), cell (x0, y0). */
function bilinear(v: HeatValues, t: HeatTile, fx: number, fy: number, x0: number, y0: number, fs: FieldSet) {
  const nx = t.nx, names = fs.names, arrays = fs.arrays, nf = names.length
  const wx = fx - x0, wy = fy - y0, i = y0 * nx + x0
  const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy
  for (let q = 0; q < nf; q++) {
    const a = arrays[q]
    v[names[q]] = a[i] * w00 + a[i + 1] * w10 + a[i + nx] * w01 + a[i + nx + 1] * w11
  }
}

/**
 * Values at fractional sample coordinates (fx, fy) of grid t into v (the fields of `fs` only). With a
 * pixel elevation `gp` (the guide): joint bilateral over the 4 x 4 nearest samples, spatial Gaussian
 * (sigma = 0.6 sample spacings) x range Gaussian on (sample elevation - gp) (sigma = sigR). Falls back
 * to bilinear where the guide is missing or no sample is similar enough. Samples without data (NaN)
 * get no weight. Threshold layers (PSR) threshold the interpolated sunlit fraction afterwards, in
 * their value().
 */
function interpolate(v: HeatValues, t: HeatTile, fx: number, fy: number, gp: number, sigR: number, fs: FieldSet) {
  const x0 = Math.min(fx | 0, t.nx - 2), y0 = Math.min(fy | 0, t.ny - 2)
  if (gp === gp) {
    axisWeights(fx, x0, wX, 0)
    axisWeights(fy, y0, wY, 0)
    if (bilateral(v, t, x0, y0, wX, 0, wY, 0, gp, sigR, fs)) return
  }
  bilinear(v, t, fx, fy, x0, y0, fs)
}

type RawTile = { width: number; height: number; arrayBufferView: Uint8Array }
const EMPTY: RawTile = { width: 1, height: 1, arrayBufferView: new Uint8Array(4) }
/** One shared fully transparent tile (Cesium only reads it to build a texture). */
const emptyTile = () => EMPTY

/** Per-tile inputs prepared alongside the sample grid(s). */
interface TileExtras {
  keep?: (lon: number, lat: number) => boolean
  pixel?: (lon: number, lat: number) => number
  guide?: Float32Array
  skyValues?: Float32Array | null
}

const newValues = (): HeatValues => ({
  sun: 0, earth: 0, slope: 0, elev: 0, cMean: 0, cMin: 0, cBelow: 0,
  tMean: NaN, tMin: NaN, tMax: NaN, fSky: 0, dark: 0, link: NaN, linkGap: NaN, sunlit: NaN, pixel: NaN,
})

export class GlobalHeatProvider {
  readonly tilingScheme = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON })
  readonly tileWidth = TILE
  readonly tileHeight = TILE
  readonly minimumLevel = 0
  readonly maximumLevel: number
  readonly rectangle: Rectangle
  readonly tileDiscardPolicy = undefined
  readonly errorEvent = new Event()
  readonly credit: Credit | undefined
  readonly proxy = undefined
  readonly hasAlphaChannel = true

  private readonly o: GlobalHeatOptions
  private readonly lut: Uint8ClampedArray
  private readonly fields: readonly Field[]
  private readonly circleCos: number
  private readonly invRange: number
  private readonly contrast: number
  private disposed = false
  private readonly wanted = () => !this.disposed

  constructor(o: GlobalHeatOptions) {
    this.o = o
    this.maximumLevel = o.maximumLevel ?? 11
    this.rectangle = o.boundsRad ? new Rectangle(...o.boundsRad) : Rectangle.MAX_VALUE
    this.credit = o.credit ? new Credit(o.credit) : undefined
    this.lut = getLut(o.colormap)
    // a provider-wide array identity, so the per-grid field sets are cached by it
    this.fields = o.fields ? [...new Set(o.fields)] : FIELDS
    this.circleCos = o.circle ? Math.cos(Math.min(Math.PI, o.circle[2] / MOON_R)) : -2
    this.invRange = 1 / (o.max - o.min || 1)
    this.contrast = o.contrast ?? 1
    // a listener also stops Cesium from logging every failed tile; retry real failures (a restarted
    // worker), not the requests dropped because the layer was removed
    this.errorEvent.addEventListener((err: { retry: boolean; timesRetried: number }) => {
      if (!this.disposed && err.timesRetried < 2) err.retry = true
    })
  }

  /** Call when the layer is removed: its requests still queued in the engine are dropped. */
  dispose() { this.disposed = true }

  getTileCredits() { return [] }
  pickFeatures() { return undefined }

  /** Engine priority of a tile (see GlobalHeatOptions.prioritize); undefined = newest first. */
  private priorityFor(r: Rectangle, z: number): (() => number) | undefined {
    const pr = this.o.prioritize
    const c = this.o.circle ?? (this.o.focus?.center ? [...this.o.focus.center, 0] : undefined)
    if (!pr || !c) return undefined
    // metres from the centre, + 1 m per level (coarser first where the distance ties, e.g. 0 for every
    // tile holding the centre), + a large penalty for tiles that are no longer on screen
    const d = distanceToRect(c[0], c[1], r) + z
    const inView = pr.inView
    return inView ? () => (inView(r) ? d : d + 1e9) : () => d
  }

  /** Landing options for samples covering `pts`: clipped to the circle unless they lie wholly inside it. */
  private landingFor(pts: () => [number, number][]): LandingHeatOptions | undefined {
    const l = this.o.landing, c = this.o.circle
    if (!l || !c || allWithin(c, pts())) return l
    return { ...l, clip: c }
  }

  // Tiles are returned as raw RGBA pixels ({ width, height, arrayBufferView }, which Cesium's Texture
  // accepts as a source), not as canvases or ImageBitmaps: those live outside the JS heap, the garbage
  // collector doesn't see their size, and hundreds per burst piled up until the tab crashed.
  async requestImage(x: number, y: number, z: number): Promise<RawTile> {
    const r = this.tilingScheme.tileXYToRectangle(x, y, z)
    if (!Rectangle.intersection(r, this.rectangle)) return emptyTile()
    const c = this.o.circle
    if (c && distanceToRect(c[0], c[1], r) > c[2]) return emptyTile()
    const pole = polarSign(r.south, r.north)
    if (pole) return this.requestPolar(r, z, pole, x, y)
    const f = this.o.focus
    // in focus = the tile comes within radiusM of the site (a lon/lat box is useless near the poles: at
    // 89.7 S, +-15 km spans ~180 deg of longitude, which made nearly every polar tile a dense one)
    const inFocus = !!f && z >= f.minLevel && (f.center && f.radiusM
      ? distanceToRect(f.center[0], f.center[1], r) <= f.radiusM
      : Rectangle.intersection(r, new Rectangle(...f.boundsRad)) !== undefined)
    // zoomed-out tiles: a quick rough pass (9 x 9); closer: 17 x 17
    let n = this.o.samples ?? (z <= 4 ? 9 : 17)
    let demMax = this.o.demLevel ? this.o.demLevel(z) : z + 2
    if (inFocus) {
      // around the selected site: one sample per finest-DEM pixel (e.g. 167 m), as far as the cap allows
      // (rows per nominal sample from heatGrid: near the poles the grid has more rows than columns)
      const tileM = (r.north - r.south) * MOON_R
      const rowFactor = (heatGrid(z, y, 17, tileGroup(z, y)).ny - 1) / 16
      n = Math.max(n, Math.min(f!.samples, Math.ceil(tileM / demPixelM(f!.demLevel) / rowFactor) + 1))
      demMax = Math.max(demMax, f!.demLevel)
      // the regolith model costs ~1 ms per sample: a 65 x 65 thermal tile took ~2 min and tripped the
      // stuck-worker timeout, so temperature layers refine to 33 x 33 at most
      if (this.o.thermal || this.o.landing) n = Math.min(n, 33)
    }
    // near the poles, neighbouring tiles of the row share one computation (see tileGroup)
    const g = tileGroup(z, y), gx = Math.floor(x / g)
    const step = Math.PI / 2 ** z
    const gridWest = -Math.PI + gx * g * step
    const landing = this.landingFor(() => rectPoints(gridWest, r.south, gridWest + g * step, r.north))
    const [t, extras] = await Promise.all([
      this.o.engine.tile(z, gx, y, n, demMax, !!this.o.thermal || !!this.o.landing, this.wanted, g, landing, undefined, this.priorityFor(r, z)),
      this.extrasFor(r, x, y, z),
    ])
    // failed or dropped: reject, so Cesium keeps showing the parent tile instead of a transparent hole
    if (!t) throw new Error(this.disposed ? 'layer removed' : 'heatmap tile failed')
    const px = new Uint8Array(TILE * TILE * 4)
    if (!this.paint(px, r, t, gridWest, g * step, extras)) return emptyTile()
    return { width: TILE, height: TILE, arrayBufferView: px }
  }

  /**
   * Tile of a polar cap (see heatGrid.POLAR_LAT): drawn from the polar blocks it overlaps, so the
   * samples are evenly spaced on the ground and shared with every neighbouring tile.
   */
  private async requestPolar(r: Rectangle, z: number, pole: -1 | 1, x: number, y: number): Promise<RawTile> {
    const S = polarBlockSize(z)
    const [x0, y0, x1, y1] = polarBox(r.west, r.south, r.east, r.north, pole)
    // a sliver of a few % of a block past the tile's main blocks is drawn from their (clamped) edge
    // instead of computing a whole extra block: tile rows and blocks don't line up exactly
    const tol = 0.03 * S
    // [first block, count] along one axis; a tile thinner than the tolerance (the slivers around the
    // pole) takes the block holding its centre
    const span = (a: number, b: number): [number, number] => {
      const lo = Math.floor((a + tol) / S), hi = Math.ceil((b - tol) / S) - 1
      if (hi >= lo) return [lo, hi - lo + 1]
      return [Math.floor((a + b) / 2 / S), 1]
    }
    const [bx0, nbx] = span(x0, x1), [by0, nby] = span(y0, y1)
    const f = this.o.focus
    const fc = f?.center && f.radiusM ? toPolar(f.center[0], f.center[1], pole) : undefined
    const focusRect = f && !fc ? new Rectangle(...f.boundsRad) : undefined
    const priority = this.priorityFor(r, z)
    const jobs: Promise<HeatTile | null>[] = []
    for (let by = by0; by < by0 + nby; by++) for (let bx = bx0; bx < bx0 + nbx; bx++) {
      let n = this.o.samples ?? (z <= 4 ? 9 : 17)
      let demMax = this.o.demLevel ? this.o.demLevel(z) : z + 2
      // focus is decided per block (not per tile), so every tile reading a block reads the same samples
      const inFocus = !!f && z >= f.minLevel && (fc
        ? Math.hypot(Math.max(bx * S - fc[0], 0, fc[0] - (bx + 1) * S), Math.max(by * S - fc[1], 0, fc[1] - (by + 1) * S)) <= f.radiusM!
        : Rectangle.intersection(r, focusRect!) !== undefined)
      if (inFocus) {
        n = Math.max(n, Math.min(f!.samples, Math.ceil(S / demPixelM(f!.demLevel)) + 1))
        demMax = Math.max(demMax, f!.demLevel)
        if (this.o.thermal || this.o.landing) n = Math.min(n, 33) // as in requestImage
      }
      // the block's corners and edge midpoints (a square of the stereographic plane)
      const landing = this.landingFor(() => {
        const pts: [number, number][] = []
        for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) pts.push(fromPolar((bx + i / 2) * S, (by + j / 2) * S, pole))
        return pts
      })
      jobs.push(this.o.engine.polarBlock(z, pole, bx, by, n, demMax, !!this.o.thermal || !!this.o.landing, this.wanted, landing, priority))
    }
    const [blocks, extras] = await Promise.all([Promise.all(jobs), this.extrasFor(r, x, y, z)])
    if (blocks.some((b) => !b)) throw new Error(this.disposed ? 'layer removed' : 'heatmap tile failed')
    const px = new Uint8Array(TILE * TILE * 4)
    if (!this.paintPolar(px, r, blocks as HeatTile[], bx0, by0, nbx, nby, S, pole, extras)) return emptyTile()
    return { width: TILE, height: TILE, arrayBufferView: px }
  }

  /** The per-tile inputs besides the samples: mask, per-pixel input, DEM guide, sky view. */
  private async extrasFor(r: Rectangle, x: number, y: number, z: number): Promise<TileExtras> {
    const rect: [number, number, number, number] = [r.west, r.south, r.east, r.north]
    const [keep, pixel, guide, skyValues] = await Promise.all([
      this.o.mask ? this.o.mask(rect, z) : undefined,
      this.o.pixel ? this.o.pixel(rect, z) : undefined,
      this.guideFor(x, y, z),
      this.o.sky?.mapTileValues(z, x, y),
    ])
    if (this.o.sky && skyValues === undefined) throw new Error('sky-view tile fetch failed')
    return { keep, pixel, guide, skyValues }
  }

  /** Elevation (m) of every pixel of map tile (z, x, y), from the DEM pyramid (shared decoded tiles). */
  private async guideFor(x: number, y: number, z: number): Promise<Float32Array | undefined> {
    const gt = this.o.guide
    if (!gt) return undefined
    const [lz, px] = await gt.covering(z, x, y)
    if (!px) return undefined
    const out = new Float32Array(TILE * TILE)
    const f = 2 ** (z - lz)
    const ox = (x - (x >> (z - lz)) * f) * TILE, oy = (y - (y >> (z - lz)) * f) * TILE
    for (let j = 0; j < TILE; j++) {
      const sy = Math.min(Math.max((oy + j + 0.5) / f - 0.5, 0), PYR_TILE - 1)
      const y0 = Math.min(sy | 0, PYR_TILE - 2), wy = sy - y0
      for (let i = 0; i < TILE; i++) {
        if (f === 1) { out[j * TILE + i] = gt.value(px, j * PYR_TILE + i); continue }
        const sx = Math.min(Math.max((ox + i + 0.5) / f - 0.5, 0), PYR_TILE - 1)
        const x0 = Math.min(sx | 0, PYR_TILE - 2), wx = sx - x0
        const k = y0 * PYR_TILE + x0
        out[j * TILE + i] = (gt.value(px, k) * (1 - wx) + gt.value(px, k + 1) * wx) * (1 - wy)
          + (gt.value(px, k + PYR_TILE) * (1 - wx) + gt.value(px, k + PYR_TILE + 1) * wx) * wy
      }
    }
    return out
  }

  /** Colour of value `val` into px at pixel o (RGBA index / 4), unless masked; true if drawn. */
  private put(px: Uint8Array, o: number, val: number, lon: number, lat: number, keep?: (lon: number, lat: number) => boolean): boolean {
    if (val !== val) return false
    if (keep && !keep(lon, lat)) return false
    const norm = 0.5 + ((val - this.o.min) * this.invRange - 0.5) * this.contrast
    const c = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3
    const lut = this.lut, k = o * 4
    px[k] = lut[c]
    px[k + 1] = lut[c + 1]
    px[k + 2] = lut[c + 2]
    px[k + 3] = 255
    return true
  }

  /** As paint(), from polar blocks bx0.. (nbx) x by0.. (nby) of side S (m) around pole `pole`. */
  private paintPolar(px: Uint8Array, r: Rectangle, blocks: HeatTile[], bx0: number, by0: number, nbx: number, nby: number, S: number, pole: number, x: TileExtras): boolean {
    let any = false
    const { value, polar, polarBelowLat = -Math.PI / 2, circle } = this.o
    const { keep, pixel, guide, skyValues } = x
    const dLon = (r.east - r.west) / TILE, dLat = (r.north - r.south) / TILE
    const bounded = this.rectangle !== Rectangle.MAX_VALUE
    const v = newValues()
    for (const t of blocks) clearAbsent(v, t, this.fields)
    const sets = blocks.map((t) => fieldSet(t, this.fields)), reliefs = blocks.map(relief)
    const sinL = new Float64Array(TILE), cosL = new Float64Array(TILE)
    for (let i = 0; i < TILE; i++) {
      const lon = r.west + (i + 0.5) * dLon
      sinL[i] = Math.sin(lon)
      cosL[i] = Math.cos(lon)
    }
    for (let j = 0; j < TILE; j++) {
      const lat = r.north - (j + 0.5) * dLat
      const rho = 2 * MOON_R * Math.tan((Math.PI / 2 - pole * lat) / 2)
      const usePolar = polar && lat < polarBelowLat
      for (let i = 0; i < TILE; i++) {
        const lon = r.west + (i + 0.5) * dLon
        if (bounded && (lon < this.rectangle.west || lon > this.rectangle.east || lat < this.rectangle.south || lat > this.rectangle.north)) continue
        if (circle && cosDist(circle[0], circle[1], lon, lat) < this.circleCos) continue
        let val = usePolar ? polar!(lon, lat) : NaN
        if (val === -Infinity) continue // polar map says "excluded here" (e.g. too steep): transparent
        if (val !== val) {
          const x = rho * sinL[i], y = -pole * rho * cosL[i]
          const bi = Math.min(nbx - 1, Math.max(0, Math.floor(x / S) - bx0))
          const bj = Math.min(nby - 1, Math.max(0, Math.floor(y / S) - by0))
          const b = bj * nbx + bi, t = blocks[b]
          const k = t.nx - 1
          // block row 0 = top (largest y)
          const fx = Math.min(Math.max((x - (bx0 + bi) * S) / S, 0), 1) * k
          const fy = Math.min(Math.max(((by0 + bj + 1) * S - y) / S, 0), 1) * k
          interpolate(v, t, fx, fy, guide ? guide[j * TILE + i] : NaN, reliefs[b], sets[b])
          if (skyValues !== undefined) v.fSky = skyValues?.[j * TILE + i] ?? NaN
          if (pixel) v.pixel = pixel(lon, lat)
          val = value(v, lon, lat)
        }
        if (this.put(px, j * TILE + i, val, lon, lat, keep)) any = true
      }
    }
    return any
  }

  /** Fills px (row 0 = north); returns false if the tile is entirely transparent. */
  /** gridWest / gridWidth: longitude extent of the sample grid (the tile's group, >= the tile). */
  private paint(px: Uint8Array, r: Rectangle, t: HeatTile, gridWest: number, gridWidth: number, x: TileExtras): boolean {
    let any = false
    const { value, polar, polarBelowLat = -Math.PI / 2, circle } = this.o
    const { keep, pixel, guide, skyValues } = x
    const kx = t.nx - 1, ky = t.ny - 1
    const dLon = (r.east - r.west) / TILE, dLat = (r.north - r.south) / TILE
    const bounded = this.rectangle !== Rectangle.MAX_VALUE
    const v = newValues()
    clearAbsent(v, t, this.fields)
    const fs = fieldSet(t, this.fields)
    const sigR = relief(t)
    // the sample coordinates and spatial kernel weights of each pixel column (the same on every row)
    const colF = new Float64Array(TILE), colX0 = new Int32Array(TILE), colW = new Float64Array(TILE * 4)
    for (let i = 0; i < TILE; i++) {
      const lon = r.west + (i + 0.5) * dLon
      const fx = Math.min(Math.max((lon - gridWest) / gridWidth, 0), 1) * kx
      colF[i] = fx
      colX0[i] = Math.min(fx | 0, kx - 1)
      axisWeights(fx, colX0[i], colW, i * 4)
    }
    for (let j = 0; j < TILE; j++) {
      const lat = r.north - (j + 0.5) * dLat
      const fy = ((j + 0.5) / TILE) * ky
      const y0 = Math.min(fy | 0, ky - 1)
      axisWeights(fy, y0, wY, 0)
      const usePolar = polar && lat < polarBelowLat
      for (let i = 0; i < TILE; i++) {
        const lon = r.west + (i + 0.5) * dLon
        if (bounded && (lon < this.rectangle.west || lon > this.rectangle.east || lat < this.rectangle.south || lat > this.rectangle.north)) continue
        if (circle && cosDist(circle[0], circle[1], lon, lat) < this.circleCos) continue
        let val = usePolar ? polar!(lon, lat) : NaN
        if (val === -Infinity) continue // polar map says "excluded here" (e.g. too steep): transparent
        if (val !== val) {
          const gp = guide ? guide[j * TILE + i] : NaN
          if (!(gp === gp && bilateral(v, t, colX0[i], y0, colW, i * 4, wY, 0, gp, sigR, fs))) bilinear(v, t, colF[i], fy, colX0[i], y0, fs)
          if (skyValues !== undefined) v.fSky = skyValues?.[j * TILE + i] ?? NaN
          if (pixel) v.pixel = pixel(lon, lat)
          val = value(v, lon, lat)
        }
        if (this.put(px, j * TILE + i, val, lon, lat, keep)) any = true
      }
    }
    return any
  }
}
