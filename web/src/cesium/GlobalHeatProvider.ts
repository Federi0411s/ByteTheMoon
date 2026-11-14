import { Credit, Ellipsoid, Event, GeographicTilingScheme, Rectangle } from 'cesium'
import { getLut } from '../lib/colormaps'
import type { HeatEngine, HeatTile } from '../lib/heatEngine'

/**
 * Whole-Moon heatmap layer computed on the fly (lib/heatEngine.ts + lib/heatWorker.ts).
 *
 * Cesium asks for the tiles on screen, coarse ones first; each is computed on a small grid of sample
 * points (edges shared with the neighbours) and bilinearly interpolated to 256 x 256, so a far view is
 * a smooth, gap-free rough estimate that sharpens tile by tile as you zoom or pan. Coarse tiles also
 * read coarse terrain (demMax = z + 2), so the first answer comes back fast.
 *
 * Where a better precomputed map exists (the 60 m LOLA polar products, or their mission-period
 * version) `polar(lon, lat)` returns it and it replaces the computed value pixel by pixel.
 */
export type HeatValues = {
  sun: number; earth: number; slope: number; elev: number
  cMean: number; cMin: number; cBelow: number // EQUIPOT surface charging (V, V, fraction)
  tMean: number; tMin: number; tMax: number // regolith surface temperature (K), only with `thermal`
  fSky: number // visible-sky fraction (radiation)
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
  /**
   * Refined area (e.g. around the selected site): tiles touching it use a denser sample grid and the
   * finest elevation tiles (downloaded on demand). Everything else keeps the cheaper defaults.
   */
  focus?: { boundsRad: [number, number, number, number]; samples: number; demLevel: number }
}

const TILE = 256

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
    const f = this.o.focus
    const inFocus = !!f && Rectangle.intersection(r, new Rectangle(...f.boundsRad)) !== undefined && z >= 8
    // zoomed-out tiles: a quick rough pass (9 x 9); closer: 17 x 17; around the selected site: denser
    const n = inFocus ? f!.samples : this.o.samples ?? (z <= 4 ? 9 : 17)
    const demMax = inFocus ? f!.demLevel : this.o.demLevel ? this.o.demLevel(z) : z + 2
    const t = await this.o.engine.tile(z, x, y, n, demMax, !!this.o.thermal, this.wanted)
    // failed or dropped: reject, so Cesium keeps showing the parent tile instead of a transparent hole
    if (!t) throw new Error(this.disposed ? 'layer removed' : 'heatmap tile failed')
    const px = new Uint8Array(TILE * TILE * 4)
    if (!this.paint(px, r, t)) return emptyTile()
    return { width: TILE, height: TILE, arrayBufferView: px }
  }

  /** Fills px (row 0 = north); returns false if the tile is entirely transparent. */
  private paint(px: Uint8Array, r: Rectangle, t: HeatTile): boolean {
    let any = false
    const { value, polar, polarBelowLat = -Math.PI / 2, min, max, contrast = 1 } = this.o
    const lut = this.lut
    const n = t.n, k = n - 1
    const dLon = (r.east - r.west) / TILE, dLat = (r.north - r.south) / TILE
    const bounded = this.rectangle !== Rectangle.MAX_VALUE
    const v: HeatValues = { sun: 0, earth: 0, slope: 0, elev: 0, cMean: 0, cMin: 0, cBelow: 0, tMean: NaN, tMin: NaN, tMax: NaN, fSky: 0 }
    const hasT = t.tMean.length > 0
    const pick = (a: Float32Array, i: number, w00: number, w10: number, w01: number, w11: number) =>
      a[i] * w00 + a[i + 1] * w10 + a[i + n] * w01 + a[i + n + 1] * w11
    for (let j = 0; j < TILE; j++) {
      const lat = r.north - (j + 0.5) * dLat
      const fy = ((j + 0.5) / TILE) * k
      const y0 = Math.min(fy | 0, k - 1), wy = fy - y0
      const usePolar = polar && lat < polarBelowLat
      for (let i = 0; i < TILE; i++) {
        const lon = r.west + (i + 0.5) * dLon
        if (bounded && (lon < this.rectangle.west || lon > this.rectangle.east || lat < this.rectangle.south || lat > this.rectangle.north)) continue
        let val = usePolar ? polar!(lon, lat) : NaN
        if (val === -Infinity) continue // polar map says "excluded here" (e.g. too steep): transparent
        if (val !== val) {
          const fx = ((i + 0.5) / TILE) * k
          const x0 = Math.min(fx | 0, k - 1), wx = fx - x0
          const idx = y0 * n + x0
          const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy
          v.sun = pick(t.sun, idx, w00, w10, w01, w11)
          v.earth = pick(t.earth, idx, w00, w10, w01, w11)
          v.slope = pick(t.slope, idx, w00, w10, w01, w11)
          v.elev = pick(t.elev, idx, w00, w10, w01, w11)
          v.cMean = pick(t.cMean, idx, w00, w10, w01, w11)
          v.cMin = pick(t.cMin, idx, w00, w10, w01, w11)
          v.cBelow = pick(t.cBelow, idx, w00, w10, w01, w11)
          v.fSky = pick(t.fSky, idx, w00, w10, w01, w11)
          if (hasT) {
            v.tMean = pick(t.tMean, idx, w00, w10, w01, w11)
            v.tMin = pick(t.tMin, idx, w00, w10, w01, w11)
            v.tMax = pick(t.tMax, idx, w00, w10, w01, w11)
          }
          val = value(v, lon, lat)
        }
        if (val !== val) continue
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
