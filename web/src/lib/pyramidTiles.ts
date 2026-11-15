/**
 * Shared fetch + decode + cache of precomputed pyramid tiles (lib/pyramid.ts), one instance per
 * pyramid, so every consumer (the precomputed layers, the heatmaps' DEM guide) reuses the same decoded
 * tiles instead of downloading them again.
 *
 * Fine levels (> publicMaxLevel) come from the bucket; if it answers 404 before any fine tile has
 * loaded, or returns non-images, they are marked unavailable and callers fall back to the shipped
 * levels (as DemSampler does).
 */
import type { PyramidIndex } from './pyramid'

export const PYR_TILE = 256
const MAX_FETCHES = 8
const CACHE_TILES = 160 // x 256 KB of RGBA

/** RGBA pixels of a tile; null = missing, undefined = transient failure (retry later). */
export type TilePixels = Uint8ClampedArray | null | undefined

export class PyramidTiles {
  readonly ix: PyramidIndex
  fineBroken: boolean
  private anyFine = false
  private active = 0
  private readonly waiting: (() => void)[] = []
  private readonly cache = new Map<string, Promise<TilePixels>>()
  private ctx: OffscreenCanvasRenderingContext2D | null = null

  constructor(ix: PyramidIndex) {
    this.ix = ix
    this.fineBroken = !ix.fineUrl
  }

  /** Finest level that can currently be fetched. */
  get maxLevel() { return this.fineBroken ? this.ix.publicMaxLevel : this.ix.fineMaxLevel }

  pixels(z: number, x: number, y: number): Promise<TilePixels> {
    const key = `${z}/${x}/${y}`
    let p = this.cache.get(key)
    if (p) { // refresh LRU position
      this.cache.delete(key)
      this.cache.set(key, p)
      return p
    }
    p = this.fetchPixels(z, x, y)
    this.cache.set(key, p)
    p.then((v) => { if (v === undefined) this.cache.delete(key) })
    while (this.cache.size > CACHE_TILES) this.cache.delete(this.cache.keys().next().value!)
    return p
  }

  /** Data tile covering map tile (z, x, y) at the finest available level: [level, pixels]. */
  async covering(z: number, x: number, y: number): Promise<[number, TilePixels]> {
    let lz = Math.min(z, this.maxLevel)
    let px = await this.pixels(lz, x >> (z - lz), y >> (z - lz))
    if (px === null && lz > this.ix.publicMaxLevel) {
      lz = this.ix.publicMaxLevel
      px = await this.pixels(lz, x >> (z - lz), y >> (z - lz))
    }
    return [lz, px]
  }

  private async slot() {
    if (this.active >= MAX_FETCHES) await new Promise<void>((res) => this.waiting.push(res))
    this.active++
  }

  private release() {
    this.active--
    this.waiting.shift()?.()
  }

  private async fetchPixels(z: number, x: number, y: number): Promise<TilePixels> {
    const fine = z > this.ix.publicMaxLevel
    if (fine && this.fineBroken) return null
    await this.slot()
    try {
      if (fine && this.fineBroken) return null
      const base = fine ? this.ix.fineUrl! : this.ix.publicUrl
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
      const ctx = (this.ctx ??= new OffscreenCanvas(PYR_TILE, PYR_TILE).getContext('2d', { willReadFrequently: true })!)
      ctx.clearRect(0, 0, PYR_TILE, PYR_TILE)
      ctx.drawImage(bmp, 0, 0)
      bmp.close()
      if (fine) this.anyFine = true
      return ctx.getImageData(0, 0, PYR_TILE, PYR_TILE).data
    } catch {
      return undefined
    } finally {
      this.release()
    }
  }

  /** Data value of pixel i (RGBA index i*4); NaN = no data. `channel` for u8x2 (0 = R, 1 = G). */
  value(px: Uint8ClampedArray, i: number, channel = 0): number {
    const j = i * 4, { encoding, scale, offset } = this.ix
    if (encoding === 'u16') return px[j + 2] === 0 ? NaN : offset + scale * (px[j] * 256 + px[j + 1])
    const dn = encoding === 'u8x2' ? (px[j + 2] === 0 ? 0 : px[j + channel]) : px[j]
    return dn === 0 ? NaN : offset + scale * dn
  }
}

const shared = new Map<string, PyramidTiles>()
/** The shared loader of a pyramid (one per pyramid name and URL). */
export function pyramidTiles(ix: PyramidIndex): PyramidTiles {
  const key = `${ix.name}|${ix.publicUrl}|${ix.fineUrl}`
  let t = shared.get(key)
  if (!t) shared.set(key, (t = new PyramidTiles(ix)))
  return t
}
