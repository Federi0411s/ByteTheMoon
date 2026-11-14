import { Credit, Ellipsoid, Event, GeographicTilingScheme, Rectangle } from 'cesium'
import { getLut } from '../lib/colormaps'

const TILE = 256
const MAX_LEVEL = 5
const HEIGHT_SCALE = 0.5
const HEIGHT_OFFSET = -10_000
const HEIGHT_MIN = -9_000
const HEIGHT_MAX = 11_000

type RawTile = { width: number; height: number; arrayBufferView: Uint8Array }

/**
 * Colorized LOLA relief, decoded only for tiles Cesium currently needs. The shipped DEM tops out at
 * level 5 (about 666 m/px); finer requests are intentionally left to the photo basemap.
 */
export class DemReliefProvider {
  readonly tilingScheme = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON })
  readonly tileWidth = TILE
  readonly tileHeight = TILE
  readonly minimumLevel = 0
  readonly maximumLevel = MAX_LEVEL
  readonly rectangle = Rectangle.MAX_VALUE
  readonly tileDiscardPolicy = undefined
  readonly errorEvent = new Event()
  readonly credit = new Credit('Elevation: NASA LOLA LDEM 118 m, area-averaged')
  readonly proxy = undefined
  readonly hasAlphaChannel = true

  private readonly controller = new AbortController()
  private readonly lut = getLut('terrain')
  private disposed = false
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  getTileCredits() { return [] }
  pickFeatures() { return undefined }

  async requestImage(x: number, y: number, z: number): Promise<RawTile> {
    if (this.disposed) throw new Error('DEM relief layer removed')
    const response = await fetch(`${this.baseUrl}/${z}/${x}/${y}.webp`, { signal: this.controller.signal })
    if (!response.ok) throw new Error(`LOLA DEM tile ${z}/${x}/${y} failed: HTTP ${response.status}`)

    const bitmap = await createImageBitmap(await response.blob())
    try {
      if (this.disposed) throw new Error('DEM relief layer removed')
      const canvas = document.createElement('canvas')
      canvas.width = TILE
      canvas.height = TILE
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Could not create a canvas context for the LOLA DEM')
      context.drawImage(bitmap, 0, 0)
      const source = context.getImageData(0, 0, TILE, TILE).data
      return { width: TILE, height: TILE, arrayBufferView: this.colorize(source, z, y) }
    } finally {
      bitmap.close()
    }
  }

  dispose() {
    this.disposed = true
    this.controller.abort()
  }

  private colorize(source: Uint8ClampedArray, z: number, tileY: number): Uint8Array {
    const elevations = new Float32Array(TILE * TILE)
    const valid = new Uint8Array(TILE * TILE)
    for (let i = 0; i < elevations.length; i++) {
      const j = i * 4
      valid[i] = source[j + 2] === 0 ? 0 : 1
      elevations[i] = HEIGHT_OFFSET + HEIGHT_SCALE * (source[j] * 256 + source[j + 1])
    }

    const rgba = new Uint8Array(TILE * TILE * 4)
    const pixelM = (Math.PI * 1_737_400) / (TILE * 2 ** z)
    const lut = this.lut
    const at = (x: number, y: number, center: number) => {
      const i = Math.max(0, Math.min(TILE - 1, y)) * TILE + Math.max(0, Math.min(TILE - 1, x))
      return valid[i] ? elevations[i] : center
    }

    for (let y = 0; y < TILE; y++) {
      const lat = Math.PI / 2 - ((tileY * TILE + y + 0.5) * Math.PI) / (TILE * 2 ** z)
      const dx = Math.max(pixelM * Math.cos(lat), pixelM * 0.02)
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x
        if (!valid[i]) continue
        const h = elevations[i]
        const dzdx = (at(x + 1, y, h) - at(x - 1, y, h)) / (2 * dx)
        const dzdy = (at(x, y - 1, h) - at(x, y + 1, h)) / (2 * pixelM)
        const nx = -dzdx, ny = -dzdy, nz = 1
        const invLength = 1 / Math.hypot(nx, ny, nz)
        const illumination = Math.max(0, (nx * -0.58 + ny * 0.58 + nz * 0.57) * invLength)
        const shade = 0.5 + 0.5 * illumination
        const color = Math.max(0, Math.min(255, Math.round(((h - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN)) * 255))) * 3
        const j = i * 4
        rgba[j] = lut[color] * shade
        rgba[j + 1] = lut[color + 1] * shade
        rgba[j + 2] = lut[color + 2] * shade
        rgba[j + 3] = 255
      }
    }
    return rgba
  }
}
