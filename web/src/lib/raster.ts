/**
 * Raster fields: gridded data (illumination, slope, elevation...) loaded from PNGs produced by
 * pipeline/overlays.py, sampled by (lon, lat). Used both for draping heatmaps on the globe and
 * for click-to-inspect / horizon computations.
 *
 * Projections (sphere R = 1737.4 km, same as the LOLA products):
 *  - "polar-south" / "polar-north": polar stereographic, true scale at the pole, lon_0 = 0.
 *    Grid is square, x in [-halfExtent, +halfExtent] left->right, y in [+halfExtent, -halfExtent] top->bottom.
 *    South: x = rho sin(lon), y =  rho cos(lon), rho = 2R tan(pi/4 + lat/2)
 *    North: x = rho sin(lon), y = -rho cos(lon), rho = 2R tan(pi/4 - lat/2)
 *    (identical to PROJ "+proj=stere +lat_0=±90 +lon_0=0 +k=1 +R=1737400", which the pipeline uses)
 *  - "equirect": plate carree, bounds [west, south, east, north] in degrees, row 0 = north.
 */

export const MOON_RADIUS_M = 1737400

export type Projection = 'polar-south' | 'polar-north' | 'equirect'

export interface LayerMeta {
  id: string
  title: string
  description: string
  source: string
  file: string
  projection: Projection
  width: number
  height: number
  /** polar: half width of the square grid in metres */
  halfExtentM?: number
  /** equirect: [west, south, east, north] degrees */
  boundsDeg?: [number, number, number, number]
  /** u8: grey PNG, DN 0 = nodata, value = offset + scale * DN. u16: RGB PNG, DN = R*256 + G, B = 0 nodata flag (B=255 valid). */
  encoding: 'u8' | 'u16'
  scale: number
  offset: number
  units: string
  /** colour range for display */
  min: number
  max: number
  colormap: string
  /** native resolution in metres per pixel, used to pick the deepest useful tile level */
  resolutionM: number
  /** if false, the layer is data-only (e.g. elevation used for horizons) and not listed in the layer panel */
  display?: boolean
}

export class RasterField {
  readonly meta: LayerMeta
  readonly data: Float32Array // NaN = nodata
  private readonly invPx: number

  constructor(meta: LayerMeta, data: Float32Array) {
    this.meta = meta
    this.data = data
    this.invPx =
      meta.projection === 'equirect'
        ? 0
        : meta.width / (2 * (meta.halfExtentM ?? 1))
  }

  /** Geographic bounds covered (radians): [west, south, east, north]. */
  boundsRad(): [number, number, number, number] {
    const m = this.meta
    if (m.projection === 'equirect') {
      const b = m.boundsDeg!
      return b.map((d) => (d * Math.PI) / 180) as [number, number, number, number]
    }
    // latitude reached at the edge midpoint of the square (corners reach a bit further)
    const rho = m.halfExtentM!
    const edgeLat = Math.PI / 2 - 2 * Math.atan(rho / (2 * MOON_RADIUS_M))
    return m.projection === 'polar-south'
      ? [-Math.PI, -Math.PI / 2, Math.PI, -edgeLat]
      : [-Math.PI, edgeLat, Math.PI, Math.PI / 2]
  }

  /** Fractional pixel coordinates (col, row) for lon/lat in radians, or null if outside. */
  pixel(lon: number, lat: number): [number, number] | null {
    const m = this.meta
    let col: number, row: number
    if (m.projection === 'equirect') {
      const [w, s, e, n] = m.boundsDeg!
      const lonD = (lon * 180) / Math.PI
      const latD = (lat * 180) / Math.PI
      col = ((lonD - w) / (e - w)) * m.width
      row = ((n - latD) / (n - s)) * m.height
    } else {
      const south = m.projection === 'polar-south'
      const rho = 2 * MOON_RADIUS_M * Math.tan(Math.PI / 4 + (south ? lat : -lat) / 2)
      const x = rho * Math.sin(lon)
      const y = south ? rho * Math.cos(lon) : -rho * Math.cos(lon)
      col = m.width / 2 + x * this.invPx
      row = m.height / 2 - y * this.invPx
    }
    if (col < 0 || row < 0 || col >= m.width || row >= m.height) return null
    return [col, row]
  }

  /** Nearest-neighbour sample (fast; used for tiles). */
  sampleNearest(lon: number, lat: number): number {
    const p = this.pixel(lon, lat)
    if (!p) return NaN
    return this.data[(p[1] | 0) * this.meta.width + (p[0] | 0)]
  }

  /** Smooth display sampling, ignoring nodata neighbours without turning valid edge pixels transparent. */
  sampleBilinear(lon: number, lat: number): number {
    const p = this.pixel(lon, lat)
    if (!p) return NaN
    const { width, height } = this.meta
    const x = Math.min(Math.max(p[0] - 0.5, 0), width - 1)
    const y = Math.min(Math.max(p[1] - 0.5, 0), height - 1)
    const x0 = Math.floor(x), x1 = Math.min(x0 + 1, width - 1), fx = x - x0
    const y0 = Math.floor(y), y1 = Math.min(y0 + 1, height - 1), fy = y - y0
    let sum = 0, total = 0
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy)
    const w01 = (1 - fx) * fy, w11 = fx * fy
    const v00 = this.data[y0 * width + x0], v10 = this.data[y0 * width + x1]
    const v01 = this.data[y1 * width + x0], v11 = this.data[y1 * width + x1]
    if (w00 > 0 && Number.isFinite(v00)) { sum += v00 * w00; total += w00 }
    if (w10 > 0 && Number.isFinite(v10)) { sum += v10 * w10; total += w10 }
    if (w01 > 0 && Number.isFinite(v01)) { sum += v01 * w01; total += w01 }
    if (w11 > 0 && Number.isFinite(v11)) { sum += v11 * w11; total += w11 }
    return total > 0 ? sum / total : NaN
  }

  /** Bilinear sample (smooth; used for horizons and inspection). */
  sample(lon: number, lat: number): number {
    const p = this.pixel(lon, lat)
    if (!p) return NaN
    const { width, height } = this.meta
    const x = Math.min(Math.max(p[0] - 0.5, 0), width - 1.001)
    const y = Math.min(Math.max(p[1] - 0.5, 0), height - 1.001)
    const x0 = x | 0, y0 = y | 0
    const fx = x - x0, fy = y - y0
    const i = y0 * width + x0
    const d = this.data
    const top = d[i] * (1 - fx) + d[i + 1] * fx
    const bot = d[i + width] * (1 - fx) + d[i + width + 1] * fx
    return top * (1 - fy) + bot * fy
  }
}

/** Decode a pipeline PNG into a RasterField. */
export async function loadRaster(meta: LayerMeta, baseUrl: string): Promise<RasterField> {
  const blob = await (await fetch(`${baseUrl}/${meta.file}`)).blob()
  // No colour management / premultiplication: we need the raw byte values.
  const bmp = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const n = bmp.width * bmp.height
  const out = new Float32Array(n)
  const { scale, offset } = meta
  if (meta.encoding === 'u8') {
    for (let i = 0; i < n; i++) {
      const dn = px[i * 4]
      out[i] = dn === 0 ? NaN : offset + scale * dn
    }
  } else {
    for (let i = 0; i < n; i++) {
      const j = i * 4
      out[i] = px[j + 2] === 0 ? NaN : offset + scale * (px[j] * 256 + px[j + 1])
    }
  }
  return new RasterField({ ...meta, width: bmp.width, height: bmp.height }, out)
}

/**
 * Footprint maximum: for each point, the max of the field over a landing ellipse centred on it
 * (semi-axes a >= b in metres, major axis at azimuth azDeg clockwise from LOCAL north).
 * NaN pixels are ignored; the result is NaN only if the whole footprint is empty.
 *
 * - The ellipse orientation is relative to local north, which on the polar-stereographic grid
 *   rotates with longitude: kernels are precomputed for NB orientations and picked per pixel.
 * - Cost is kept bounded for large ellipses by first block-maximising the field into cells of
 *   k x k pixels (conservative: a cell holds the max of its pixels), then running the kernel there.
 * - A cell belongs to the footprint if its centre lies inside the ellipse (the centre cell always does).
 * Polar-south grids only (the slope products cover 85S-90S).
 */
export function footprintMax(f: RasterField, a: number, b: number, azDeg: number, budget = 1.2e8): RasterField {
  const { width: W, height: H, resolutionM: base } = f.meta
  const cost = (k: number) => Math.PI * (a / (base * k) + 0.5) * (b / (base * k) + 0.5) * (W / k) * (H / k)
  let k = 1
  while (cost(k) > budget && k < 64) k++
  const cell = base * k
  const w = Math.ceil(W / k), h = Math.ceil(H / k)
  const px = Math.floor((w * k - W) / 2), py = Math.floor((h * k - H) / 2)

  // 1. block max (k = 1: plain copy)
  let blk: Float32Array
  if (k === 1) blk = f.data
  else {
    blk = new Float32Array(w * h).fill(NaN)
    for (let y = 0; y < H; y++) {
      const row = (((y + py) / k) | 0) * w
      for (let x = 0; x < W; x++) {
        const v = f.data[y * W + x]
        if (v !== v) continue
        const j = row + (((x + px) / k) | 0)
        if (!(v <= blk[j])) blk[j] = v
      }
    }
  }

  // 2. kernels (flat offsets into blk, plus dx/dy for bounds checks), one per orientation bucket
  const round = a === b
  const NB = round ? 1 : 36 // 5 deg steps over 180 deg (an ellipse is symmetric under 180 deg)
  const R = Math.ceil(a / cell)
  const kernels: Int32Array[] = []
  for (let n = 0; n < NB; n++) {
    const phi = (n / NB) * Math.PI // grid angle of the major axis, clockwise from grid "up"
    const ux = Math.sin(phi), uy = Math.cos(phi) // major axis
    const vx = Math.cos(phi), vy = -Math.sin(phi) // minor axis
    const offs: number[] = []
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const X = dx * cell, Y = dy * cell // dy: up
        const s = (X * ux + Y * uy) / a, t = (X * vx + Y * vy) / b
        if (s * s + t * t <= 1 + 1e-9 || (dx === 0 && dy === 0)) offs.push(dx, -dy) // row offset = -dy
      }
    }
    kernels.push(Int32Array.from(offs))
  }

  // 3. kernel max; orientation bucket from the pixel's longitude
  const out = new Float32Array(w * h)
  const az = (azDeg * Math.PI) / 180
  for (let y = 0; y < h; y++) {
    const gy = h / 2 - y - 0.5
    for (let x = 0; x < w; x++) {
      let ker = kernels[0]
      if (!round) {
        // south stereo: local north points along (sin lon, cos lon) on the grid -> grid angle = lon + az
        const lon = Math.atan2(x + 0.5 - w / 2, gy)
        let n = Math.round(((lon + az) / Math.PI) * NB) % NB
        if (n < 0) n += NB
        ker = kernels[n]
      }
      let m = NaN
      for (let i = 0; i < ker.length; i += 2) {
        const xx = x + ker[i], yy = y + ker[i + 1]
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const v = blk[yy * w + xx]
        if (v === v && !(v <= m)) m = v
      }
      out[y * w + x] = m
    }
  }
  return new RasterField({ ...f.meta, id: `${f.meta.id}_fp`, width: w, height: h, halfExtentM: (w * cell) / 2, resolutionM: cell }, out)
}

/**
 * Hillshade value (0..1) from an elevation field, light from azimuth/elevation (deg).
 * Used as a clean polar base layer (equirectangular basemaps smear badly near the poles).
 */
export function hillshade(dem: RasterField, azDeg = 315, elDeg = 35, exaggeration = 2) {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180
  const lx = Math.sin(az) * Math.cos(el), ly = Math.cos(az) * Math.cos(el), lz = Math.sin(el)
  const d = dem.meta.resolutionM
  return (lon: number, lat: number) => {
    // finite differences in local east/north directions (radians -> metres on the sphere)
    const dLat = d / MOON_RADIUS_M
    const dLon = dLat / Math.max(Math.cos(lat), 1e-6)
    const hE = dem.sample(lon + dLon, lat), hW = dem.sample(lon - dLon, lat)
    const hN = dem.sample(lon, lat + dLat), hS = dem.sample(lon, lat - dLat)
    if (Number.isNaN(hE + hW + hN + hS)) return NaN
    const gx = ((hE - hW) / (2 * d)) * exaggeration, gy = ((hN - hS) / (2 * d)) * exaggeration
    const shade = (-gx * lx - gy * ly + lz) / Math.sqrt(gx * gx + gy * gy + 1)
    return Math.max(0, shade)
  }
}
