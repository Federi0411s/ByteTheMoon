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
