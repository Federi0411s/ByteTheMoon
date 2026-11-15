/**
 * Landing-site slope requirement: max slope inside the landing footprint (circle or ellipse, see Footprint).
 *   0–5°  safe          (goal)
 *   5–8°  intermediate  (threshold)
 *   8–10° at the limit
 * The user picks the max acceptable slope with a slider, capped at SLOPE_MAX_DEG.
 */
export const SLOPE_GOAL_DEG = 5
export const SLOPE_THRESHOLD_DEG = 8
export const SLOPE_MAX_DEG = 10

export interface SlopeClass {
  label: string
  upTo: number
  color: string
}

export const SLOPE_CLASSES: SlopeClass[] = [
  { label: 'Safe', upTo: SLOPE_GOAL_DEG, color: '#1a9850' },
  { label: 'Intermediate', upTo: SLOPE_THRESHOLD_DEG, color: '#fdae61' },
  { label: 'At the limit', upTo: SLOPE_MAX_DEG, color: '#d73027' },
]

export const slopeClass = (deg: number): SlopeClass => SLOPE_CLASSES.find((c) => deg <= c.upTo) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1]

/** Landing footprint (landing ellipse) over which the max slope is evaluated. */
export interface Footprint {
  shape: 'circle' | 'ellipse'
  /** circle radius, m */
  radiusM: number
  /** ellipse semi-axes, m */
  semiMajorM: number
  semiMinorM: number
  /** ellipse major-axis azimuth, degrees clockwise from local north (0..180) */
  azimuthDeg: number
}

export const FOOTPRINT_MIN_M = 10
export const FOOTPRINT_MAX_M = 20000

export const DEFAULT_FOOTPRINT: Footprint = { shape: 'circle', radiusM: 100, semiMajorM: 200, semiMinorM: 100, azimuthDeg: 0 }

const clampM = (m: number) => Math.min(Math.max(Number.isFinite(m) ? m : FOOTPRINT_MIN_M, FOOTPRINT_MIN_M), FOOTPRINT_MAX_M)

/** [semi-major m, semi-minor m, azimuth deg], validated. */
export function footprintAxes(fp: Footprint): [number, number, number] {
  if (fp.shape === 'circle') {
    const r = clampM(fp.radiusM)
    return [r, r, 0]
  }
  const a = clampM(fp.semiMajorM), b = clampM(fp.semiMinorM)
  const azimuth = fp.azimuthDeg + (b > a ? 90 : 0)
  return [Math.max(a, b), Math.min(a, b), ((azimuth % 180) + 180) % 180]
}

export function footprintLabel(fp: Footprint): string {
  const [a, b, az] = footprintAxes(fp)
  const m = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(2)} km` : `${v} m`)
  return fp.shape === 'circle' ? `circle r = ${m(a)}` : `ellipse ${m(a)} × ${m(b)}, az ${az}°`
}
