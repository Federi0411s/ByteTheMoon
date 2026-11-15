/**
 * Visible share of the Sun's light over a terrain horizon: the solar disc as a set of rays with
 * limb-darkened intensity, cut by the horizon line across the disc.
 *
 * - Intensity across the disc: linear limb darkening I(mu) = 1 - u (1 - mu), mu = cos of the angle
 *   from the disc centre seen from the Sun's surface = sqrt(1 - rho^2); u = 0.6 (visible band), so the
 *   centre is ~2.5x brighter than the limb. A grazing Sun therefore gives less light than its
 *   visible area suggests, and power / heating scale with this light fraction, not the area.
 * - Horizon across the disc (~0.53 deg wide): the straight line through the horizon heights at the
 *   disc's two side edges, shifted to pass through the height at the Sun's azimuth. On a sloping
 *   ridge the disc is cut obliquely (the previous models assumed a level horizon line).
 * - The ray integral is tabulated once over the signed distance of the disc centre from that line,
 *   so a lookup is cheap enough for every time step of every heatmap sample.
 *
 * The same function is used by the site timeline (lib/analysis.ts), solar power (lib/power.ts), the
 * site temperature model (lib/regolith.ts) and the heatmap worker (lib/heatWorker.ts), so the site
 * panel and the maps agree.
 */
export const LIMB_DARKENING_U = 0.6

const N = 400 // table intervals over d in [-1, 1]
const TABLE = new Float64Array(N + 1)
{
  // strip integral W(y) = integral over the chord at height y of I(rho), on M strips; then cumulative
  const M = 2000, K = 200
  const W = new Float64Array(M)
  let total = 0
  for (let m = 0; m < M; m++) {
    const y = -1 + (m + 0.5) * (2 / M)
    const half = Math.sqrt(Math.max(0, 1 - y * y))
    let s = 0
    for (let k = 0; k < K; k++) {
      const x = -half + (k + 0.5) * ((2 * half) / K)
      const mu = Math.sqrt(Math.max(0, 1 - x * x - y * y))
      s += 1 - LIMB_DARKENING_U * (1 - mu)
    }
    W[m] = (s * (2 * half)) / K
    total += W[m]
  }
  // TABLE[i]: share of the light above the line y = -d, d = -1 + 2 i / N (centre d radii above it)
  const cum = new Float64Array(M + 1) // cum[m] = light in strips m..M-1
  for (let m = M - 1; m >= 0; m--) cum[m] = cum[m + 1] + W[m]
  for (let i = 0; i <= N; i++) {
    const d = -1 + (2 * i) / N
    const f = ((-d + 1) / 2) * M // strip index (fractional) of y = -d
    const m0 = Math.min(M - 1, Math.max(0, Math.floor(f)))
    const part = Math.min(1, Math.max(0, f - m0))
    TABLE[i] = (cum[m0 + 1] + W[m0] * (1 - part)) / total
  }
  TABLE[0] = 0
  TABLE[N] = 1
}

/** Share of the disc's light above a straight line d disc radii below the centre (d < 0: above it). */
export function discLight(d: number): number {
  if (d >= 1) return 1
  if (d <= -1) return 0
  const f = ((d + 1) / 2) * N
  const i = Math.min(N - 1, Math.floor(f))
  return TABLE[i] + (TABLE[i + 1] - TABLE[i]) * (f - i)
}

/** Signed distance from the solar disc's lower limb to an oblique horizon, in disc radii. */
export function sunDiscHorizonMargin(el: number, r: number, hC: number, hL: number, hR: number): number {
  const slope = (hR - hL) / (2 * r)
  return (el - hC) / (r * Math.sqrt(1 + slope * slope)) + 1
}

/** Azimuth offset (deg) of the disc's side edges from its centre, for a disc of radius r at elevation el (deg). */
export function discEdgeAz(elDeg: number, rDeg: number): number {
  return rDeg / Math.max(Math.cos((elDeg * Math.PI) / 180), 1e-3)
}

/**
 * Visible share of the Sun's light (0..1). el: elevation of the disc centre, r: angular radius (deg);
 * hC: horizon elevation at the Sun's azimuth, hL / hR: at azimuth -/+ discEdgeAz(el, r).
 */
export function sunVisible(el: number, r: number, hC: number, hL: number, hR: number): number {
  return discLight(sunDiscHorizonMargin(el, r, hC, hL, hR) - 1)
}
