import {
  Credit,
  Ellipsoid,
  Event,
  GeographicTilingScheme,
  HeightmapTerrainData,
  TerrainProvider,
  type TerrainData,
} from 'cesium'

const TILE = 256
const PUBLIC_MAX_LEVEL = 5
const FINE_MAX_LEVEL = 7
const HEIGHT_SCALE = 0.5
const HEIGHT_OFFSET = -10_000
const CACHE_SIZE = 64

class MissingDemTileError extends Error {
  constructor(url: string) {
    super(`LOLA DEM tile not found: ${url}`)
  }
}

/**
 * Builds Moon terrain meshes from the shipped LOLA height tiles. Optional fine tiles are requested
 * only when configured; absent fine tiles fall back to upsampled parent heights.
 */
export class DemTerrainProvider implements TerrainProvider {
  readonly tilingScheme = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON })
  readonly errorEvent = new Event<TerrainProvider.ErrorEvent>()
  readonly credit = new Credit('Terrain: NASA LOLA LDEM 118 m, area-averaged')
  readonly hasWaterMask = false
  readonly hasVertexNormals = false
  readonly availability = undefined

  private readonly controller = new AbortController()
  private readonly tiles = new Map<string, Promise<Uint16Array>>()
  private readonly baseUrl: string
  private readonly fineUrl: string | null
  private readonly levelZeroError: number
  private maximumAvailableLevel: number
  private poleHeightsPromise: Promise<{ north: number; south: number }> | undefined
  private disposed = false
  private decodeContext: CanvasRenderingContext2D | null = null

  constructor(baseUrl: string, fineUrl: string | null) {
    this.baseUrl = baseUrl
    this.fineUrl = fineUrl
    this.maximumAvailableLevel = fineUrl ? FINE_MAX_LEVEL : PUBLIC_MAX_LEVEL
    this.levelZeroError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this.tilingScheme.ellipsoid,
      TILE,
      this.tilingScheme.getNumberOfXTilesAtLevel(0),
    )
  }

  getTileDataAvailable(x: number, y: number, level: number) {
    const n = 2 ** level
    return level <= this.maximumAvailableLevel && x >= 0 && x < 2 * n && y >= 0 && y < n
  }

  loadTileDataAvailability(): undefined { return undefined }

  getLevelMaximumGeometricError(level: number) {
    return this.levelZeroError / 2 ** level
  }

  async requestTileGeometry(x: number, y: number, level: number): Promise<TerrainData> {
    if (this.disposed) throw new Error('LOLA terrain provider has been disposed')
    const heights = new Uint16Array(await this.tileHeights(x, y, level))
    if (y === 0 || y === 2 ** level - 1) {
      const poles = await this.poleHeights()
      if (y === 0) heights.fill(poles.north, 0, TILE)
      if (y === 2 ** level - 1) heights.fill(poles.south, (TILE - 1) * TILE)
    }

    return new HeightmapTerrainData({
      buffer: heights,
      width: TILE,
      height: TILE,
      childTileMask: level < this.maximumAvailableLevel ? 15 : 0,
      structure: {
        heightScale: HEIGHT_SCALE,
        heightOffset: HEIGHT_OFFSET,
        elementsPerHeight: 1,
        stride: 1,
        elementMultiplier: 1,
        lowestEncodedHeight: 0,
        highestEncodedHeight: 65_535,
      },
    })
  }

  async sampleHeight(longitude: number, latitude: number): Promise<number> {
    const level = this.maximumAvailableLevel
    const n = 2 ** level
    const step = Math.PI / n
    const x = Math.min(2 * n - 1, Math.max(0, Math.floor((longitude + Math.PI) / step)))
    const y = Math.min(n - 1, Math.max(0, Math.floor((Math.PI / 2 - latitude) / step)))
    const data = await this.requestTileGeometry(x, y, level) as HeightmapTerrainData
    if (this.maximumAvailableLevel < level) return this.sampleHeight(longitude, latitude)
    const rectangle = this.tilingScheme.tileXYToRectangle(x, y, level)
    return data.interpolateHeight(rectangle, longitude, latitude)
  }

  dispose() {
    this.disposed = true
    this.controller.abort()
    this.tiles.clear()
  }

  private tileHeights(x: number, y: number, level: number): Promise<Uint16Array> {
    const key = `${level}/${x}/${y}`
    const cached = this.tiles.get(key)
    if (cached) {
      this.tiles.delete(key)
      this.tiles.set(key, cached)
      return cached
    }

    let task: Promise<Uint16Array>
    if (level > this.maximumAvailableLevel) {
      task = this.upsampleParent(x, y, level)
    } else {
      task = this.loadTile(x, y, level).catch((error: unknown) => {
        if (!(error instanceof MissingDemTileError) || level <= PUBLIC_MAX_LEVEL) throw error
        this.maximumAvailableLevel = Math.min(this.maximumAvailableLevel, level - 1)
        return this.upsampleParent(x, y, level)
      })
    }
    task = task.catch((error: unknown) => {
      if (this.tiles.get(key) === task) this.tiles.delete(key)
      throw error
    })
    this.tiles.set(key, task)
    while (this.tiles.size > CACHE_SIZE) this.tiles.delete(this.tiles.keys().next().value!)
    return task
  }

  private async upsampleParent(x: number, y: number, level: number): Promise<Uint16Array> {
    if (level <= PUBLIC_MAX_LEVEL) throw new Error(`No LOLA DEM data available for ${level}/${x}/${y}`)
    const parent = await this.tileHeights(Math.floor(x / 2), Math.floor(y / 2), level - 1)
    const out = new Uint16Array(TILE * TILE)
    const xStart = (x % 2) * (TILE - 1) / 2
    const yStart = (y % 2) * (TILE - 1) / 2
    for (let row = 0; row < TILE; row++) {
      const py = yStart + row * (TILE - 1) / 2
      const y0 = Math.floor(py), y1 = Math.min(y0 + 1, TILE - 1), fy = py - y0
      for (let col = 0; col < TILE; col++) {
        const px = xStart + col * (TILE - 1) / 2
        const x0 = Math.floor(px), x1 = Math.min(x0 + 1, TILE - 1), fx = px - x0
        const a = parent[y0 * TILE + x0], b = parent[y0 * TILE + x1]
        const c = parent[y1 * TILE + x0], d = parent[y1 * TILE + x1]
        out[row * TILE + col] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy)
      }
    }
    return out
  }

  private async loadTile(x: number, y: number, level: number): Promise<Uint16Array> {
    const base = level <= PUBLIC_MAX_LEVEL ? this.baseUrl : this.fineUrl
    if (!base) return this.upsampleParent(x, y, level)
    const url = `${base}/${level}/${x}/${y}.webp`
    const response = await fetch(url, { signal: this.controller.signal })
    if (response.status === 404) throw new MissingDemTileError(url)
    if (!response.ok) throw new Error(`LOLA DEM tile ${level}/${x}/${y} failed: HTTP ${response.status}`)

    const bitmap = await createImageBitmap(await response.blob())
    try {
      if (this.disposed) throw new Error('LOLA terrain provider has been disposed')
      // one reusable canvas: drawImage + getImageData run back to back with no await in between,
      // so concurrent tile loads cannot interleave here (a canvas per tile piled up until GC)
      if (!this.decodeContext) {
        const canvas = document.createElement('canvas')
        canvas.width = TILE
        canvas.height = TILE
        this.decodeContext = canvas.getContext('2d', { willReadFrequently: true })
      }
      const context = this.decodeContext
      if (!context) throw new Error('Could not create a canvas context for LOLA terrain')
      context.clearRect(0, 0, TILE, TILE)
      context.drawImage(bitmap, 0, 0)
      return this.decode(context.getImageData(0, 0, TILE, TILE).data)
    } finally {
      bitmap.close()
    }
  }

  private decode(source: Uint8ClampedArray): Uint16Array {
    const heights = new Uint16Array(TILE * TILE)
    const valid = new Uint8Array(TILE * TILE)
    let validCount = 0
    for (let i = 0; i < heights.length; i++) {
      const j = i * 4
      if (source[j + 2] === 0) continue
      heights[i] = source[j] * 256 + source[j + 1]
      valid[i] = 1
      validCount++
    }
    if (validCount === heights.length) return heights
    if (validCount === 0) {
      heights.fill((0 - HEIGHT_OFFSET) / HEIGHT_SCALE)
      return heights
    }

    const queue = new Uint32Array(TILE * TILE)
    let tail = 0
    for (let i = 0; i < valid.length; i++) if (valid[i]) queue[tail++] = i
    for (let head = 0; head < tail; head++) {
      const i = queue[head]
      const x = i % TILE, y = (i / TILE) | 0
      if (x > 0 && !valid[i - 1]) { valid[i - 1] = 1; heights[i - 1] = heights[i]; queue[tail++] = i - 1 }
      if (x + 1 < TILE && !valid[i + 1]) { valid[i + 1] = 1; heights[i + 1] = heights[i]; queue[tail++] = i + 1 }
      if (y > 0 && !valid[i - TILE]) { valid[i - TILE] = 1; heights[i - TILE] = heights[i]; queue[tail++] = i - TILE }
      if (y + 1 < TILE && !valid[i + TILE]) { valid[i + TILE] = 1; heights[i + TILE] = heights[i]; queue[tail++] = i + TILE }
    }
    return heights
  }

  private poleHeights(): Promise<{ north: number; south: number }> {
    if (!this.poleHeightsPromise) {
      this.poleHeightsPromise = Promise.all([this.tileHeights(0, 0, 0), this.tileHeights(1, 0, 0)])
        .then(([west, east]) => {
          const average = (row: number) => {
            let total = 0
            for (let x = 0; x < TILE; x++) total += west[row * TILE + x] + east[row * TILE + x]
            return Math.round(total / (TILE * 2))
          }
          return { north: average(0), south: average(TILE - 1) }
        })
        .catch((error: unknown) => {
          this.poleHeightsPromise = undefined
          throw error
        })
    }
    return this.poleHeightsPromise
  }
}
