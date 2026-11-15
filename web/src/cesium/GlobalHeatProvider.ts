import { Credit, Ellipsoid, Event, GeographicTilingScheme, Rectangle } from 'cesium'
import { getLut } from '../lib/colormaps'
import { demPixelM } from '../lib/dem'
import { heatGrid, tileGroup } from '../lib/heatGrid'
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
  landingScore: number
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
  /** calculate all Landing Score criteria for the suitability heatmap */
  landing?: LandingHeatOptions
  /**
   * Refined area (e.g. around the selected site): from `minLevel` on, tiles touching it read the
   * finest elevation tiles (`demLevel`, downloaded on demand) and are sampled at that DEM's own
   * resolution (capped at `samples` per side). Everything else keeps the zoom-dependent defaults.
   */
  /**
   * Per-tile pixel mask (e.g. the score's steepest-slope-in-footprint limit), prepared once per tile
   * (rect radians [w, s, e, n], level z): pixels where it returns false are transparent.
   */
  mask?: (rect: [number, number, number, number], z: number) => Promise<(lon: number, lat: number) => boolean>
  /**
   * DEM-guided (joint bilateral) upsampling: the elevation pyramid read at the display resolution.
   * Each pixel mixes the 4 x 4 nearest samples weighted by distance AND by how close each sample's
   * elevation is to the pixel's own, so shadow edges and crater rims follow the terrain instead of
   * being smeared bilinearly. Unset = plain bilinear.
   */
  guide?: PyramidTiles
  focus?: { boundsRad: [number, number, number, number]; samples: number; demLevel: number; minLevel: number; center?: [number, number]; radiusM?: number }
}

const TILE = 256

/** Great-circle distance (m) from (lon, lat) to the nearest point of a geographic rectangle (approx.). */
function distanceToRect(lon: number, lat: number, r: Rectangle) {
  const cLat = Math.min(Math.max(lat, r.south), r.north)
  let dl = lon - Math.min(Math.max(lon, r.west), r.east)
  // longitude wrap: try the edge on the other side of the antimeridian too
  if (Math.abs(dl) > Math.PI) dl = 2 * Math.PI - Math.abs(dl)
  const cLon = lon - dl
  const s = Math.sin((cLat - lat) / 2) ** 2 + Math.cos(lat) * Math.cos(cLat) * Math.sin((cLon - lon) / 2) ** 2
  return 2 * 1737400 * Math.asin(Math.min(1, Math.sqrt(s)))
}
const MOON_R = 1737400

const FIELDS = ['sun', 'earth', 'slope', 'elev', 'cMean', 'cMin', 'cBelow', 'fSky', 'tMean', 'tMin', 'tMax', 'landingScore'] as const
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

const wX = new Float64Array(4), wY = new Float64Array(4), wK = new Float64Array(16)
/**
 * Values at fractional sample coordinates (fx, fy) of grid t into v. With a pixel elevation `gp`
 * (the guide): joint bilateral over the 4 x 4 nearest samples, spatial Gaussian (sigma = 0.6 sample
 * spacings) x range Gaussian on (sample elevation - gp) (sigma = sigR). Falls back to bilinear where
 * the guide is missing or no sample is similar enough. Samples without data (NaN) get no weight.
 * Threshold layers (PSR) threshold the interpolated sunlit fraction afterwards, in their value().
 */
function interpolate(v: HeatValues, t: HeatTile, fx: number, fy: number, gp: number, sigR: number) {
  const nx = t.nx, kx = nx - 1, ky = t.ny - 1
  const x0 = Math.min(fx | 0, kx - 1), y0 = Math.min(fy | 0, ky - 1)
  const hasT = t.tMean.length > 0
  const hasLanding = t.landingScore.length > 0
  if (gp === gp) {
    for (let a = 0; a < 4; a++) {
      const dx = fx - (x0 - 1 + a), dy = fy - (y0 - 1 + a)
      wX[a] = Math.exp(-(dx * dx) / 0.72)
      wY[a] = Math.exp(-(dy * dy) / 0.72)
    }
    const inv = 1 / (2 * sigR * sigR)
    let ws = 0
    for (let b = 0; b < 4; b++) {
      const sj = y0 - 1 + b
      for (let a = 0; a < 4; a++) {
        const si = x0 - 1 + a
        let w = 0
        if (si >= 0 && si <= kx && sj >= 0 && sj <= ky) {
          const k = sj * nx + si, e = t.elev[k]
          if (e === e && t.sun[k] === t.sun[k]) w = wX[a] * wY[b] * Math.exp(-(e - gp) * (e - gp) * inv)
        }
        wK[b * 4 + a] = w
        ws += w
      }
    }
    if (ws > 1e-6) {
      for (const f of FIELDS) {
        if (!hasT && f[0] === 't') { v[f] = NaN; continue }
        if (f === 'landingScore' && !hasLanding) { v[f] = NaN; continue }
        const arr = t[f]
        let acc = 0
        for (let b = 0; b < 4; b++) {
          const row = (y0 - 1 + b) * nx + x0 - 1
          for (let a = 0; a < 4; a++) { const w = wK[b * 4 + a]; if (w) acc += w * arr[row + a] }
        }
        v[f] = acc / ws
      }
      return
    }
  }
  // plain bilinear
  const wx = fx - x0, wy = fy - y0, i = y0 * nx + x0
  const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy
  for (const f of FIELDS) {
    if (!hasT && f[0] === 't') { v[f] = NaN; continue }
    if (f === 'landingScore' && !hasLanding) { v[f] = NaN; continue }
    const a = t[f]
    v[f] = a[i] * w00 + a[i + 1] * w10 + a[i + nx] * w01 + a[i + nx + 1] * w11
  }
}

type RawTile = { width: number; height: number; arrayBufferView: Uint8Array }
const EMPTY: RawTile = { width: 1, height: 1, arrayBufferView: new Uint8Array(4) }
/** One shared fully transparent tile (Cesium only reads it to build a texture). */
const emptyTile = () => EMPTY

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
  private disposed = false
  private readonly wanted = () => !this.disposed

  constructor(o: GlobalHeatOptions) {
    this.o = o
    this.maximumLevel = o.maximumLevel ?? 11
    this.rectangle = o.boundsRad ? new Rectangle(...o.boundsRad) : Rectangle.MAX_VALUE
    this.credit = o.credit ? new Credit(o.credit) : undefined
    this.lut = getLut(o.colormap)
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

  // Tiles are returned as raw RGBA pixels ({ width, height, arrayBufferView }, which Cesium's Texture
  // accepts as a source), not as canvases or ImageBitmaps: those live outside the JS heap, the garbage
  // collector doesn't see their size, and hundreds per burst piled up until the tab crashed.
  async requestImage(x: number, y: number, z: number): Promise<RawTile> {
    const r = this.tilingScheme.tileXYToRectangle(x, y, z)
    if (!Rectangle.intersection(r, this.rectangle)) return emptyTile()
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
      if (this.o.thermal) n = Math.min(n, 33)
    }
    // near the poles, neighbouring tiles of the row share one computation (see tileGroup)
    const g = tileGroup(z, y), gx = Math.floor(x / g)
    const [t, keep, guide] = await Promise.all([
      this.o.engine.tile(z, gx, y, n, demMax, !!this.o.thermal || !!this.o.landing, this.wanted, g, this.o.landing),
      this.prepareMask(r, z),
      this.guideFor(x, y, z),
    ])
    // failed or dropped: reject, so Cesium keeps showing the parent tile instead of a transparent hole
    if (!t) throw new Error(this.disposed ? 'layer removed' : 'heatmap tile failed')
    const px = new Uint8Array(TILE * TILE * 4)
    const step = Math.PI / 2 ** z
    const gridWest = -Math.PI + gx * g * step
    if (!this.paint(px, r, t, gridWest, g * step, keep, guide)) return emptyTile()
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
        if (this.o.thermal) n = Math.min(n, 33) // as in requestImage
      }
      jobs.push(this.o.engine.polarBlock(z, pole, bx, by, n, demMax, !!this.o.thermal || !!this.o.landing, this.wanted, this.o.landing))
    }
    const [blocks, keep, guide] = await Promise.all([Promise.all(jobs), this.prepareMask(r, z), this.guideFor(x, y, z)])
    if (blocks.some((b) => !b)) throw new Error(this.disposed ? 'layer removed' : 'heatmap tile failed')
    const px = new Uint8Array(TILE * TILE * 4)
    if (!this.paintPolar(px, r, blocks as HeatTile[], bx0, by0, nbx, nby, S, pole, keep, guide)) return emptyTile()
    return { width: TILE, height: TILE, arrayBufferView: px }
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

  private prepareMask(r: Rectangle, z: number) {
    return this.o.mask ? this.o.mask([r.west, r.south, r.east, r.north], z) : Promise.resolve(undefined)
  }

  /** As paint(), from polar blocks bx0.. (nbx) x by0.. (nby) of side S (m) around pole `pole`. */
  private paintPolar(px: Uint8Array, r: Rectangle, blocks: HeatTile[], bx0: number, by0: number, nbx: number, nby: number, S: number, pole: number, keep?: (lon: number, lat: number) => boolean, guide?: Float32Array): boolean {
    let any = false
    const { value, polar, polarBelowLat = -Math.PI / 2, min, max, contrast = 1 } = this.o
    const lut = this.lut
    const dLon = (r.east - r.west) / TILE, dLat = (r.north - r.south) / TILE
    const bounded = this.rectangle !== Rectangle.MAX_VALUE
    const v: HeatValues = { sun: 0, earth: 0, slope: 0, elev: 0, cMean: 0, cMin: 0, cBelow: 0, tMean: NaN, tMin: NaN, tMax: NaN, fSky: 0, landingScore: NaN }
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
        let val = usePolar ? polar!(lon, lat) : NaN
        if (val === -Infinity) continue // polar map says "excluded here" (e.g. too steep): transparent
        if (val !== val) {
          const x = rho * sinL[i], y = -pole * rho * cosL[i]
          const bi = Math.min(nbx - 1, Math.max(0, Math.floor(x / S) - bx0))
          const bj = Math.min(nby - 1, Math.max(0, Math.floor(y / S) - by0))
          const t = blocks[bj * nbx + bi]
          const nx = t.nx, k = nx - 1
          // block row 0 = top (largest y)
          const fx = Math.min(Math.max((x - (bx0 + bi) * S) / S, 0), 1) * k
          const fy = Math.min(Math.max(((by0 + bj + 1) * S - y) / S, 0), 1) * k
          interpolate(v, t, fx, fy, guide ? guide[j * TILE + i] : NaN, relief(t))
          val = value(v, lon, lat)
        }
        if (val !== val) continue
        if (keep && !keep(lon, lat)) continue
        const norm = 0.5 + ((val - min) / (max - min || 1) - 0.5) * contrast
        const c = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3
        const o = (j * TILE + i) * 4
        px[o] = lut[c]
        px[o + 1] = lut[c + 1]
        px[o + 2] = lut[c + 2]
        px[o + 3] = 255
        any = true
      }
    }
    return any
  }

  /** Fills px (row 0 = north); returns false if the tile is entirely transparent. */
  /** gridWest / gridWidth: longitude extent of the sample grid (the tile's group, >= the tile). */
  private paint(px: Uint8Array, r: Rectangle, t: HeatTile, gridWest = r.west, gridWidth = r.east - r.west, keep?: (lon: number, lat: number) => boolean, guide?: Float32Array): boolean {
    let any = false
    const { value, polar, polarBelowLat = -Math.PI / 2, min, max, contrast = 1 } = this.o
    const lut = this.lut
    const nx = t.nx, kx = nx - 1, ky = t.ny - 1
    const dLon = (r.east - r.west) / TILE, dLat = (r.north - r.south) / TILE
    const bounded = this.rectangle !== Rectangle.MAX_VALUE
    const v: HeatValues = {
      sun: 0, earth: 0, slope: 0, elev: 0, cMean: 0, cMin: 0, cBelow: 0,
      tMean: NaN, tMin: NaN, tMax: NaN, fSky: 0,
      landingScore: NaN,
    }
    const sigR = relief(t)
    for (let j = 0; j < TILE; j++) {
      const lat = r.north - (j + 0.5) * dLat
      const fy = ((j + 0.5) / TILE) * ky
      const usePolar = polar && lat < polarBelowLat
      for (let i = 0; i < TILE; i++) {
        const lon = r.west + (i + 0.5) * dLon
        if (bounded && (lon < this.rectangle.west || lon > this.rectangle.east || lat < this.rectangle.south || lat > this.rectangle.north)) continue
        let val = usePolar ? polar!(lon, lat) : NaN
        if (val === -Infinity) continue // polar map says "excluded here" (e.g. too steep): transparent
        if (val !== val) {
          const fx = Math.min(Math.max((lon - gridWest) / gridWidth, 0), 1) * kx
          interpolate(v, t, fx, fy, guide ? guide[j * TILE + i] : NaN, sigR)
          val = value(v, lon, lat)
        }
        if (val !== val) continue
        if (keep && !keep(lon, lat)) continue
        const norm = 0.5 + ((val - min) / (max - min || 1) - 0.5) * contrast
        const c = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3
        const o = (j * TILE + i) * 4
        px[o] = lut[c]
        px[o + 1] = lut[c + 1]
        px[o + 2] = lut[c + 2]
        px[o + 3] = 255
        any = true
      }
    }
    return any
  }
}
