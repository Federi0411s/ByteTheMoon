/**
 * Grid of the reachable-area computation (lib/reachWorker.ts) and its map layer
 * (cesium/ReachImageryProvider.ts).
 *
 * A square grid of square cells on an oblique stereographic projection centred on the start point.
 * The projection is conformal, so cells stay square on the ground in any direction, poles included,
 * and its scale error is 1 + rho^2 / 4R^2 (0.08 % at 100 km): every cell can use the same ground
 * spacing. Cell (i, j), row 0 = north, has its centre at x = (i - c) * cell, y = (c - j) * cell, where
 * c = (n - 1) / 2 is the start cell.
 *
 * Values (Uint16 per cell): the smallest "maximum slope along the way" needed to reach the cell
 * from the start, in SLOPE_QUANTUM steps (0.1 deg), or one of the sentinels below.
 */
export const MOON_R = 1737400
/** slope resolution: values are tenths of a degree */
export const SLOPE_QUANTUM = 10
export const MAX_Q = 90 * SLOPE_QUANTUM
/** not reached (yet) */
export const UNSEEN = 0xffff
/** never reachable: outside the circle, no elevation data */
export const WALL = 0xfffe

export interface ReachGrid {
  /** start point, radians */
  lat0: number
  lon0: number
  /** cells per side (odd: the start is the centre cell) */
  n: number
  /** cell size, m */
  cell: number
  /** search radius, m */
  radiusM: number
}

/** (lon, lat) radians -> projected (x, y) m around (lat0, lon0); out[2] = cos of the angular distance. */
export function stereoForward(lat0: number, lon0: number, lon: number, lat: number, out: Float64Array) {
  const s0 = Math.sin(lat0), c0 = Math.cos(lat0)
  const s = Math.sin(lat), c = Math.cos(lat), dl = lon - lon0
  const cdl = Math.cos(dl)
  const cosc = s0 * s + c0 * c * cdl
  const k = (2 * MOON_R) / (1 + cosc)
  out[0] = k * c * Math.sin(dl)
  out[1] = k * (c0 * s - s0 * c * cdl)
  out[2] = cosc
  return out
}

/** Projected (x, y) m -> (lon, lat) radians (lon not wrapped). sin/cos of lat0 passed in for speed. */
export function stereoInverse(s0: number, c0: number, lon0: number, x: number, y: number, out: Float64Array) {
  const rho = Math.sqrt(x * x + y * y)
  if (rho < 1e-6) { out[0] = lon0; out[1] = Math.asin(s0); return out }
  const t = rho / (2 * MOON_R)
  // c = 2 atan(t): sin c and cos c without the atan
  const t2 = t * t, sc = (2 * t) / (1 + t2), cc = (1 - t2) / (1 + t2)
  out[1] = Math.asin(Math.max(-1, Math.min(1, cc * s0 + (y * sc * c0) / rho)))
  out[0] = lon0 + Math.atan2(x * sc, rho * c0 * cc - y * s0 * sc)
  return out
}

/** Bounding rectangle (radians [w, s, e, n]) of the search circle, every longitude if it holds a pole. */
export function reachBounds(g: ReachGrid): [number, number, number, number] {
  const d = g.radiusM / MOON_R
  const south = Math.max(-Math.PI / 2, g.lat0 - d), north = Math.min(Math.PI / 2, g.lat0 + d)
  if (g.lat0 + d >= Math.PI / 2 || g.lat0 - d <= -Math.PI / 2) return [-Math.PI, south, Math.PI, north]
  const dLon = Math.asin(Math.min(1, Math.sin(d) / Math.cos(g.lat0)))
  if (g.lon0 - dLon < -Math.PI || g.lon0 + dLon > Math.PI) return [-Math.PI, south, Math.PI, north]
  return [g.lon0 - dLon, south, g.lon0 + dLon, north]
}

/** Reachable ground area (km^2) for a slope limit (deg). */
export function reachAreaKm2(g: ReachGrid, val: Uint16Array, maxDeg: number): number {
  const q = Math.floor(maxDeg * SLOPE_QUANTUM + 1e-9)
  let count = 0
  for (let i = 0; i < val.length; i++) if (val[i] <= q) count++
  return (count * g.cell * g.cell) / 1e6
}
