import { Credit, Ellipsoid, Event, GeographicTilingScheme, Rectangle } from 'cesium'
import { getLut } from '../lib/colormaps'
import type { PyramidIndex } from '../lib/pyramid'

/**
 * Heatmap layer drawn straight from a precomputed tile pyramid (lib/pyramid.ts): no computation, the
 * full resolution of the data at every zoom (Cesium upsamples beyond the finest level).
 *
 * The pyramid uses the same tiling as Cesium, so map tile (z, x, y) is data tile (z, x, y). If the
 * fine levels are unavailable (no bucket configured, or it answers 404 / non-images before any fine
 * tile loaded, as in DemSampler), deeper tiles are cut out of the finest shipped level instead.
 *
 * Near the poles each map tile is returned with more rows than columns (up to 16x). Cesium chooses
 * the imagery level from the east-west texel spacing, which shrinks with cos(latitude), so polar
 * tiles come from low levels whose north-south resolution is poor: square 256 px textures there
 * smear everything along the meridians (radial streaks around the pole). The extra rows restore it.
 */
export interface PyramidImageryOptions {
  pyramid: PyramidIndex
  /** u8x2: which channel (slope: 0 = mean, 1 = max) */
  channel?: 0 | 1
  /** data value -> displayed value (default identity); NaN = transparent */
  value?: (v: number, lon: number, lat: number) => number
  /** higher-quality override where available (the 60 m LOLA polar maps); NaN = none here */
  polar?: (lon: number, lat: number) => number
  /** latitude (radians) below which `polar` is consulted */
  polarBelowLat?: number
  min: number
  max: number
  colormap: string
  contrast?: number
  credit?: string
}

const TILE = 256
const MAX_ROW_FACTOR = 16
const MAX_FETCHES = 8
const CACHE_TILES = 96

type RawTile = { width: number; height: number; arrayBufferView: Uint8Array }
const EMPTY: RawTile = { width: 1, height: 1, arrayBufferView: new Uint8Array(4) }

export class PyramidImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON })
  readonly tileWidth = TILE
  readonly tileHeight = TILE
  readonly minimumLevel = 0
  readonly maximumLevel: number
  readonly rectangle = Rectangle.MAX_VALUE
  readonly tileDiscardPolicy = undefined
  readonly errorEvent = new Event()
  readonly credit: Credit | undefined
  readonly proxy = undefined
  readonly hasAlphaChannel = true

  private readonly o: PyramidImageryOptions
  private readonly lut: Uint8ClampedArray
  private fineBroken: boolean
  private anyFine = false
  private disposed = false
  private active = 0
  private readonly waiting: (() => void)[] = []
  private readonly cache = new Map<string, Promise<Float32Array | null | undefined>>()
  private ctx: OffscreenCanvasRenderingContext2D | null = null

  constructor(o: PyramidImageryOptions) {
    this.o = o
    const p = o.pyramid
    this.fineBroken = !p.fineUrl
    this.maximumLevel = p.fineUrl ? p.fineMaxLevel : p.publicMaxLevel
    this.credit = o.credit ? new Credit(o.credit) : undefined
    this.lut = getLut(o.colormap)
    this.errorEvent.addEventListener((err: { retry: boolean; timesRetried: number }) => {
      if (!this.disposed && err.timesRetried < 2) err.retry = true
    })
  }

  dispose() { this.disposed = true }
  getTileCredits() { return [] }
  pickFeatures() { return undefined }

  private async slot() {
    if (this.active >= MAX_FETCHES) await new Promise<void>((res) => this.waiting.push(res))
    this.active++
  }

  private release() {
    this.active--
    this.waiting.shift()?.()
  }

  /** Data values of tile (z, x, y), NaN = no data. null = missing, undefined = transient failure. */
  private tileValues(z: number, x: number, y: number): Promise<Float32Array | null | undefined> {
    const key = `${z}/${x}/${y}`
    let p = this.cache.get(key)
    if (!p) {
      p = this.fetchValues(z, x, y)
      this.cache.set(key, p)
      p.then((v) => { if (v === undefined) this.cache.delete(key) })
      while (this.cache.size > CACHE_TILES) this.cache.delete(this.cache.keys().next().value!)
    }
    return p
  }

  private async fetchValues(z: number, x: number, y: number): Promise<Float32Array | null | undefined> {
    const p = this.o.pyramid
    const fine = z > p.publicMaxLevel
    if (fine && this.fineBroken) return null
    await this.slot()
    try {
      if (fine && this.fineBroken) return null
      const base = fine ? p.fineUrl! : p.publicUrl
      const r = await fetch(`${base}/${z}/${x}/${y}.webp`, { signal: AbortSignal.timeout(20_000) })
      if (!r.ok) {
        if (fine && r.status === 404 && !this.anyFine) this.fineBroken = true
        return null
      }
      if (!(r.headers.get('content-type') ?? '').startsWith('image/')) {
        if (fine) this.fineBroken = true
        return null
      }
      const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      // one reusable decode canvas (drawImage + getImageData run back to back, no await between)
      const ctx = (this.ctx ??= new OffscreenCanvas(TILE, TILE).getContext('2d', { willReadFrequently: true })!)
      ctx.clearRect(0, 0, TILE, TILE)
      ctx.drawImage(bmp, 0, 0)
      bmp.close()
      const px = ctx.getImageData(0, 0, TILE, TILE).data
      if (fine) this.anyFine = true
      const out = new Float32Array(TILE * TILE)
      const { scale, offset, encoding } = p
      const ch = this.o.channel ?? 0
      for (let i = 0; i < out.length; i++) {
        const j = i * 4
        if (encoding === 'u16') out[i] = px[j + 2] === 0 ? NaN : offset + scale * (px[j] * 256 + px[j + 1])
        else {
          const dn = encoding === 'u8x2' ? (px[j + 2] === 0 ? 0 : px[j + ch]) : px[j]
          out[i] = dn === 0 ? NaN : offset + scale * dn
        }
      }
      return out
    } catch {
      return undefined
    } finally {
      this.release()
    }
  }

  async requestImage(x: number, y: number, z: number): Promise<RawTile> {
    const p = this.o.pyramid
    // finest data tile covering this map tile
    let lz = Math.min(z, this.fineBroken ? p.publicMaxLevel : p.fineMaxLevel)
    let vals = await this.tileValues(lz, x >> (z - lz), y >> (z - lz))
    if (vals === null && lz > p.publicMaxLevel) { // fine level unavailable: fall back to the shipped levels
      lz = p.publicMaxLevel
      vals = await this.tileValues(lz, x >> (z - lz), y >> (z - lz))
    }
    if (vals === undefined) throw new Error(this.disposed ? 'layer removed' : 'tile fetch failed') // Cesium retries
    const r = this.tilingScheme.tileXYToRectangle(x, y, z)
    // rows: power of two ~ 1 / cos(mid latitude), so the ground resolution is about square
    const aspect = Math.max(Math.cos((r.north + r.south) / 2), 1e-3)
    const rows = TILE * Math.min(MAX_ROW_FACTOR, 2 ** Math.max(0, Math.round(Math.log2(1 / aspect))))
    const px = new Uint8Array(TILE * rows * 4)
    return this.paint(px, r, rows, z, x, y, lz, vals) ? { width: TILE, height: rows, arrayBufferView: px } : EMPTY
  }

  private paint(px: Uint8Array, r: Rectangle, rows: number, z: number, x: number, y: number, lz: number, vals: Float32Array | null): boolean {
    const { value, polar, polarBelowLat = -Math.PI / 2, min, max, contrast = 1 } = this.o
    const lut = this.lut
    const f = 2 ** (z - lz) // map pixels per data pixel
    const ox = (x - (x >> (z - lz)) * f) * TILE, oy = (y - (y >> (z - lz)) * f) * TILE // offset inside the data tile, map px
    const dLon = (r.east - r.west) / TILE, dLat = (r.north - r.south) / rows
    const sameGrid = f === 1 && rows === TILE
    let any = false
    for (let j = 0; j < rows; j++) {
      const lat = r.north - (j + 0.5) * dLat
      const usePolar = polar && lat < polarBelowLat
      // data pixel coordinates (centres at +0.5), bilinear when upsampling
      const sy = Math.min(Math.max((oy + ((j + 0.5) * TILE) / rows) / f - 0.5, 0), TILE - 1)
      const y0 = Math.min(sy | 0, TILE - 2), wy = sy - y0
      for (let i = 0; i < TILE; i++) {
        const lon = r.west + (i + 0.5) * dLon
        let v = usePolar ? polar!(lon, lat) : NaN
        if (v === -Infinity) continue
        if (v !== v && vals) {
          let d: number
          if (sameGrid) d = vals[j * TILE + i]
          else {
            const sx = Math.min(Math.max((ox + i + 0.5) / f - 0.5, 0), TILE - 1)
            const x0 = Math.min(sx | 0, TILE - 2), wx = sx - x0
            const k = y0 * TILE + x0
            d = (vals[k] * (1 - wx) + vals[k + 1] * wx) * (1 - wy) + (vals[k + TILE] * (1 - wx) + vals[k + TILE + 1] * wx) * wy
          }
          v = d !== d ? NaN : value ? value(d, lon, lat) : d
        }
        if (v !== v) continue
        const norm = 0.5 + ((v - min) / (max - min || 1) - 0.5) * contrast
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
