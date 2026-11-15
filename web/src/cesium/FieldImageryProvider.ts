import {
  Credit,
  Ellipsoid,
  Event,
  GeographicTilingScheme,
  Rectangle,
  type ImageryProvider,
} from 'cesium'
import { getLut } from '../lib/colormaps'

/**
 * A Cesium imagery provider whose tiles are generated in the browser from a function
 * value(lon, lat) -> number. This is what makes the heatmaps interactive:
 *  - source rasters stay in their native (polar stereographic) projection, one PNG each;
 *  - each 256x256 geographic tile is re-projected on the fly (≈1–3 ms per tile);
 *  - derived layers are just a different value() function — update the inputs, create a new provider,
 *    and the globe re-tiles.
 *
 * Works for both Cesium Moon 3D Tiles (tileset.imageryLayers) and a Globe (globe.imageryLayers).
 */
export interface FieldImageryOptions {
  value: (lon: number, lat: number) => number
  /** colour range */
  min: number
  max: number
  colormap: string
  /** geographic extent in radians [w, s, e, n]; no tiles are generated outside it */
  boundsRad: [number, number, number, number]
  /** deepest level worth generating (deeper levels are up-sampled by Cesium) */
  maximumLevel?: number
  credit?: string
  /** optional: values for which the pixel is drawn transparent (besides NaN) */
  transparentIf?: (v: number) => boolean
  /** global contrast enhancement, applied before colormap lookup */
  contrast?: number
  /** optional per-pixel opacity 0..1 (e.g. to feather a layer's edge); default opaque */
  alpha?: (lon: number, lat: number) => number
}

const TILE = 256

type RawTile = { width: number; height: number; arrayBufferView: Uint8Array }
/** One shared fully transparent tile (Cesium only reads it to build a texture). */
const EMPTY_TILE: RawTile = { width: 1, height: 1, arrayBufferView: new Uint8Array(4) }

export class FieldImageryProvider {
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

  private readonly opts: FieldImageryOptions
  private readonly lut: Uint8ClampedArray

  constructor(opts: FieldImageryOptions) {
    this.opts = opts
    this.maximumLevel = opts.maximumLevel ?? 10
    this.rectangle = new Rectangle(...opts.boundsRad)
    this.credit = opts.credit ? new Credit(opts.credit) : undefined
    this.lut = getLut(opts.colormap)
  }

  getTileCredits() {
    return []
  }

  pickFeatures() {
    return undefined
  }

  // Tiles are raw RGBA pixels ({ width, height, arrayBufferView }, accepted by Cesium's Texture), not
  // canvases: canvas memory lives outside the JS heap and piles up between garbage collections.
  requestImage(x: number, y: number, level: number): Promise<RawTile> {
    const r = this.tilingScheme.tileXYToRectangle(x, y, level)
    if (!Rectangle.intersection(r, this.rectangle)) return Promise.resolve(EMPTY_TILE)

    const px = new Uint8Array(TILE * TILE * 4)
    const { value, min, max, transparentIf, contrast = 1, alpha } = this.opts
    const lut = this.lut
    const dLon = (r.east - r.west) / TILE
    const dLat = (r.north - r.south) / TILE

    for (let j = 0; j < TILE; j++) {
      const lat = r.north - (j + 0.5) * dLat
      for (let i = 0; i < TILE; i++) {
        const lon = r.west + (i + 0.5) * dLon
        const a = alpha ? alpha(lon, lat) : 1
        if (!(a > 0)) continue
        const v = value(lon, lat)
        const o = (j * TILE + i) * 4
        if (Number.isNaN(v) || (transparentIf && transparentIf(v))) continue // alpha stays 0

        const normalized = (v - min) / (max - min || 1)
        const contrasted = Math.max(0, Math.min(1, 0.5 + (normalized - 0.5) * contrast))
        const k = Math.max(0, Math.min(255, Math.round(contrasted * 255))) * 3

        px[o] = lut[k]
        px[o + 1] = lut[k + 1]
        px[o + 2] = lut[k + 2]
        px[o + 3] = a >= 1 ? 255 : Math.round(a * 255)
      }
    }
    return Promise.resolve({ width: TILE, height: TILE, arrayBufferView: px })
  }
}

/** Typed view for Cesium APIs that expect an ImageryProvider. */
export const asProvider = (p: FieldImageryProvider) => p as unknown as ImageryProvider

/** Tile level at which one tile pixel ≈ the raster's native resolution (latitude direction). */
export function levelForResolution(resolutionM: number): number {
  const metresPerRadian = 1737400
  // GeographicTilingScheme: level L has 2^L rows over pi radians of latitude
  const level = Math.log2((Math.PI * metresPerRadian) / (TILE * resolutionM))
  return Math.max(0, Math.min(14, Math.ceil(level)))
}
