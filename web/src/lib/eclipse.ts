/**
 * Solar eclipses seen from the Moon (= lunar eclipses seen from Earth): the Earth's disc passing in
 * front of the Sun's. Geometry only, no atmosphere on the Moon. (The Earth's own atmosphere refracts
 * a little red light into its umbra, the "blood moon"; that light is <0.1 % of sunlight and ignored.)
 *
 * Coverage is computed topocentrically: the site's position shifts the Earth by up to ~0.26 deg on
 * the sky (the Moon's radius seen from the Earth), which matters at the eclipse edges, so two sites
 * see different coverage at the same instant. Coverage = area fraction of the Sun's disc hidden by the
 * Earth (uniform disc; the Earth's disc is ~3.6x the Sun's, so a total eclipse lasts up to ~3.8 h).
 */
import { azEl, EARTH_RADIUS_KM, earthPosition, ephemerisRange, SUN_RADIUS_KM, sunPosition, topoFrame, type Ephemeris, type Vec3 } from './ephemeris'

const D2R = Math.PI / 180

/** Area fraction of a disc (radius r1) covered by another disc (radius r2), centres d apart (same units). */
export function overlapFraction(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0
  if (d <= Math.abs(r2 - r1)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1)
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1))
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
  const k = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  return (a1 + a2 - k) / (Math.PI * r1 * r1)
}

/** Fraction of the Sun's disc covered by the Earth, seen from position p (m, Moon-fixed). */
export function eclipseCoverFrom(sunP: Vec3, earthP: Vec3, p: Vec3): number {
  const sx = sunP[0] - p[0], sy = sunP[1] - p[1], sz = sunP[2] - p[2]
  const ex = earthP[0] - p[0], ey = earthP[1] - p[1], ez = earthP[2] - p[2]
  const ds = Math.hypot(sx, sy, sz), de = Math.hypot(ex, ey, ez)
  const sep = Math.acos(Math.min(1, Math.max(-1, (sx * ex + sy * ey + sz * ez) / (ds * de))))
  const rs = Math.asin((SUN_RADIUS_KM * 1000) / ds), re = Math.asin((EARTH_RADIUS_KM * 1000) / de)
  return overlapFraction(rs, re, sep)
}

/**
 * Upper bound of the coverage anywhere on the Moon at time t (0 = no eclipse for any site): the
 * Sun-Earth separation seen from the Moon's centre, widened by the largest parallax.
 */
export function eclipsePossible(eph: Ephemeris, t: number): boolean {
  const s = sunPosition(eph, t), e = earthPosition(eph, t)
  const ds = Math.hypot(...s), de = Math.hypot(...e)
  const sep = Math.acos(Math.min(1, (s[0] * e[0] + s[1] * e[1] + s[2] * e[2]) / (ds * de)))
  const parallax = Math.asin(1_740_000 / de)
  return sep < Math.asin((SUN_RADIUS_KM * 1000) / ds) + Math.asin((EARTH_RADIUS_KM * 1000) / de) + parallax
}

export interface EclipseEvent {
  /** first / last instant the Earth touches the Sun's disc anywhere on the Moon (ms UTC) */
  start: number
  end: number
}

/** Eclipse windows in [start, end]: scanned every 20 min, edges refined to ~1 min. */
export function findEclipses(eph: Ephemeris, start: number, end: number): EclipseEvent[] {
  const [e0, e1] = ephemerisRange(eph)
  const a = Math.max(start, e0), b = Math.min(end, e1)
  const STEP = 20 * 60_000
  const out: EclipseEvent[] = []
  const edge = (lo: number, hi: number, inside: boolean) => { // first time in (lo, hi] where possible === inside
    while (hi - lo > 60_000) {
      const m = (lo + hi) / 2
      if (eclipsePossible(eph, m) === inside) hi = m
      else lo = m
    }
    return hi
  }
  let prev = eclipsePossible(eph, a), runStart = prev ? a : NaN
  for (let t = a + STEP; t <= b + STEP; t += STEP) {
    const tt = Math.min(t, b)
    const cur = eclipsePossible(eph, tt)
    if (cur && !prev) runStart = edge(tt - STEP, tt, true)
    if (!cur && prev) out.push({ start: runStart, end: edge(tt - STEP, tt, false) })
    prev = cur
    if (tt === b) break
  }
  if (prev) out.push({ start: runStart, end: b })
  return out
}

export interface SiteEclipse {
  /** when the Sun's disc is (partly) covered AND above the site's horizon (ms UTC) */
  start: number
  end: number
  /** largest coverage of the Sun's disc seen from the site, 0..1 */
  maxCover: number
  /** time of the largest coverage */
  peak: number
  /** coverage >= 99.9 %: the Sun is fully hidden (darkness) */
  total: boolean
}

/**
 * Eclipses actually seen from a site in [start, end]: the Earth covers part of the Sun while the Sun
 * is above the site's horizon (`sunUp(az, el, r)` > 0, e.g. the visible share over the terrain).
 */
export function siteEclipses(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, start: number, end: number,
  sunUp: (az: number, el: number, rDeg: number) => number): SiteEclipse[] {
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  const out: SiteEclipse[] = []
  const STEP = 2 * 60_000
  // a total eclipse's peak is the middle of totality (coverage stays at 100 % throughout)
  const close = (cur: SiteEclipse, totalStart: number, totalEnd: number) => {
    cur.total = cur.maxCover >= 0.999
    if (cur.total) cur.peak = Math.round((totalStart + totalEnd) / 2 / 60_000) * 60_000
    out.push(cur)
  }
  for (const ev of findEclipses(eph, start, end)) {
    let cur: SiteEclipse | null = null
    let totalStart = NaN, totalEnd = NaN
    for (let t = Math.max(ev.start, start); t <= Math.min(ev.end, end); t += STEP) {
      const sunP = sunPosition(eph, t)
      const s = azEl(topo, sunP)
      const cover = eclipseCoverFrom(sunP, earthPosition(eph, t), topo.pos as Vec3)
      const up = sunUp(s.az, s.el, Math.asin((SUN_RADIUS_KM * 1000) / s.distM) / D2R) > 0
      if (cover > 0 && up) {
        if (!cur) cur = { start: t, end: t, maxCover: 0, peak: t, total: false }
        cur.end = t
        if (cover > cur.maxCover) { cur.maxCover = cover; cur.peak = t }
        if (cover >= 0.999) { if (!(totalStart === totalStart)) totalStart = t; totalEnd = t }
      } else if (cur) { close(cur, totalStart, totalEnd); cur = null; totalStart = totalEnd = NaN }
    }
    if (cur) close(cur, totalStart, totalEnd)
  }
  return out
}
