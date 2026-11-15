/**
 * Sample grid of one global heatmap tile (Cesium geographic tile z/x/y, nominal n x n samples).
 *
 * Geographic tiles are square in degrees, so away from the equator they are narrower on the ground
 * than tall (at 81 S about 6x). A square n x n grid then samples east-west 6x more densely than
 * north-south, and the bilinear interpolation smears every shadow along the meridians: radial streaks
 * around the poles. Instead the grid trades columns for rows by a power of two (so the samples of
 * neighbouring tile rows nest and their shared edges stay close), keeping about n x n samples per
 * tile with nearly square ground spacing.
 */
const MAX_ROW_FACTOR = 8

export function heatGrid(z: number, y: number, n: number, g = 1): { nx: number; ny: number } {
  const step = Math.PI / 2 ** z
  const north = Math.PI / 2 - y * step
  const latMid = north - step / 2
  const aspect = Math.min(1, g * Math.max(Math.cos(latMid), 1e-3)) // ground width / height (g tiles wide)
  const f = Math.min(MAX_ROW_FACTOR, 2 ** Math.max(0, Math.round(Math.log2(1 / Math.sqrt(aspect)))))
  const k = n - 1
  return { nx: Math.max(2, Math.round(k / f)) + 1, ny: k * f + 1 }
}

/**
 * Polar tile groups: geographic tiles converge on the poles, so with the pole in view Cesium asks for
 * a whole ring of ever thinner tiles (thousands per row at street-level zoom). Neighbouring tiles of a
 * row are therefore computed together as one group about as wide on the ground as it is tall: g tiles
 * (a power of two, so groups nest across levels), at most the whole row. Same ground resolution, a
 * fraction of the jobs. Returns g = 1 away from the poles.
 */
export function tileGroup(z: number, y: number): number {
  const step = Math.PI / 2 ** z
  const latMid = Math.PI / 2 - (y + 0.5) * step
  const g = 2 ** Math.max(0, Math.floor(Math.log2(1 / Math.max(Math.cos(latMid), 1e-6))))
  return Math.min(g, 2 ** (z + 1))
}

/**
 * Polar caps: tiles entirely poleward of POLAR_LAT are drawn from "polar blocks" instead of their own
 * lon/lat sample grid. A lon/lat grid converges on the pole, so however its columns are traded for
 * rows, its samples bunch up along the meridians near the pole and the bilinear interpolation draws
 * radial spokes, with a visible jump at every tile-row boundary. Polar blocks are squares of a polar
 * stereographic plane (conformal: square cells stay square on the ground), one tile height on a side,
 * sampled on a regular lattice whose edges are shared by neighbouring blocks. Every Cesium tile reads
 * the blocks it overlaps, so the heatmap is seamless across tiles and rows and the work follows the
 * ground area, not the number of (ever thinner) geographic tiles around the pole.
 */
export const POLAR_LAT = (67.5 / 180) * Math.PI
const MOON_R = 1737400

/**
 * Side (m, in the stereographic plane) of a polar block of level z: about the ground height of a tile
 * row, exactly the stereographic radius of the first row boundary, so the ring of tiles touching the
 * pole fits in the 4 blocks around it (Cesium loads that whole ring whenever the pole is in view).
 * Only for z >= 3 (coarser levels have no tile poleward of POLAR_LAT).
 */
export function polarBlockSize(z: number) {
  return 2 * MOON_R * Math.tan(Math.PI / 2 ** z / 2)
}

/** Pole sign of a geographic rectangle drawn from polar blocks: -1 south, +1 north, 0 = not polar. */
export function polarSign(south: number, north: number): -1 | 0 | 1 {
  return south >= POLAR_LAT ? 1 : north <= -POLAR_LAT ? -1 : 0
}

/** (lon, lat) -> polar stereographic (x, y) in m around pole p (south: y toward lon 0, as the polar maps). */
export function toPolar(lon: number, lat: number, p: number, out: [number, number] = [0, 0]): [number, number] {
  const rho = 2 * MOON_R * Math.tan((Math.PI / 2 - p * lat) / 2)
  out[0] = rho * Math.sin(lon)
  out[1] = -p * rho * Math.cos(lon)
  return out
}

/** Inverse of toPolar. */
export function fromPolar(x: number, y: number, p: number, out: [number, number] = [0, 0]): [number, number] {
  out[0] = Math.atan2(x, -p * y)
  out[1] = p * (Math.PI / 2 - 2 * Math.atan(Math.hypot(x, y) / (2 * MOON_R)))
  return out
}

/** Bounding box [xmin, ymin, xmax, ymax] (m) of a geographic rectangle of the polar cap of pole p. */
export function polarBox(west: number, south: number, east: number, north: number, p: number): [number, number, number, number] {
  const latIn = p > 0 ? north : south, latOut = p > 0 ? south : north // nearest to / farthest from the pole
  const rIn = toPolar(0, latIn, p)[1] * -p, rOut = toPolar(0, latOut, p)[1] * -p
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = (lon: number, rho: number) => {
    const x = rho * Math.sin(lon), y = -p * rho * Math.cos(lon)
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  add(west, rIn); add(east, rIn); add(west, rOut); add(east, rOut)
  // the outer arc bulges past its end points where it crosses a cardinal direction
  for (let k = Math.ceil(west / (Math.PI / 2)); k * (Math.PI / 2) <= east; k++) add(k * (Math.PI / 2), rOut)
  return [x0, y0, x1, y1]
}
