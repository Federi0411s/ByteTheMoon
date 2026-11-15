/**
 * Thermal and radiation environment at one point, from the same global computation that draws the
 * heatmaps (lib/heatWorker.ts): Hayne 2017 regolith temperature (min / max over the selected period,
 * last year of it for long windows) and the visible-sky fraction that drives the GCR + albedo dose.
 * Sampled from a z = 10 tile (nominally 17 x 17 samples), bilinear, exactly like the click inspector.
 */
import type { HeatEngine } from './heatEngine'

export interface SiteEnvSample {
  /** regolith surface temperature over the period, K */
  tMin: number
  tMax: number
  tMean: number
  /** visible-sky fraction (0..0.5) for the radiation model */
  fSky: number
  /** terrain slope (deg) */
  slope: number
}

export async function sampleSiteEnv(heat: HeatEngine, latDeg: number, lonDeg: number): Promise<SiteEnvSample | null> {
  const z = 10, step = Math.PI / 2 ** z
  const lonR = (((lonDeg + 180) % 360 + 360) % 360 - 180) * (Math.PI / 180), latR = latDeg * (Math.PI / 180)
  const x = Math.min(2 ** (z + 1) - 1, Math.floor((lonR + Math.PI) / step))
  const y = Math.min(2 ** z - 1, Math.floor((Math.PI / 2 - latR) / step))
  const tile = await heat.tile(z, x, y, 17, heat.dem.fineMaxLevel, true)
  if (!tile || !tile.tMin.length) return null
  // the sample grid is nx x ny (not square away from the equator, see lib/heatGrid.ts)
  const n = tile.nx, kx = n - 1, ky = tile.ny - 1
  const fx = ((lonR - (-Math.PI + x * step)) / step) * kx, fy = ((Math.PI / 2 - y * step - latR) / step) * ky
  const x0 = Math.max(0, Math.min(Math.floor(fx), kx - 1)), y0 = Math.max(0, Math.min(Math.floor(fy), ky - 1))
  const wx = fx - x0, wy = fy - y0
  const at = (a: Float32Array) => {
    const i = y0 * n + x0
    return a[i] * (1 - wx) * (1 - wy) + a[i + 1] * wx * (1 - wy) + a[i + n] * (1 - wx) * wy + a[i + n + 1] * wx * wy
  }
  return { tMin: at(tile.tMin), tMax: at(tile.tMax), tMean: at(tile.tMean), fSky: at(tile.fSky), slope: at(tile.slope) }
}
