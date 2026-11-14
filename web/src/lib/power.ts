/**
 * Solar power generation at a lunar site.
 *
 *   P(t) = S(t) · A · η · f_terrain(t) · (1 − f_eclipse(t)) · cos θ(t)
 *
 *  - S(t): solar irradiance, 1361 W/m² at 1 AU scaled by the true Sun distance (SPICE ephemeris);
 *  - A, η: panel area and efficiency (user inputs);
 *  - f_terrain: fraction of the solar disc above the site's TERRAIN horizon (LOLA horizon mask:
 *    crater rims, ridges and massifs cast the shadows; no atmosphere, so no diffuse light);
 *  - f_eclipse: fraction of the (remaining) solar disc hidden by the EARTH as seen from the site
 *    (solar eclipses seen from the Moon = lunar eclipses seen from Earth);
 *  - cos θ: incidence on the panel. Sun-tracking (2-axis): θ = 0. Fixed, parallel to the local
 *    surface (horizontal): cos θ = sin(Sun elevation).
 * Treating terrain and Earth occultations as independent is exact unless the Earth sets behind the
 * same ridge during an eclipse (rare). No temperature derating, dust or degradation.
 */
import { discFraction, horizonAt, type HorizonMask } from './analysis'
import { azEl, EARTH_RADIUS_KM, earthPosition, SUN_RADIUS_KM, sunPosition, topoFrame, type Ephemeris } from './ephemeris'

const D2R = Math.PI / 180
const AU_M = 149_597_870_700
export const SOLAR_CONSTANT = 1361 // W/m² at 1 AU (TSI)

export type PanelMode = 'tracking' | 'fixed'

export interface PanelConfig {
  mode: PanelMode
  areaM2: number
  /** 0..1 */
  efficiency: number
}

/** Plausible defaults: a few m² of triple-junction GaAs cells (~30% efficient), like a small CLPS lander. */
export const DEFAULT_PANEL: PanelConfig = { mode: 'tracking', areaM2: 4, efficiency: 0.3 }

export interface PowerSample {
  t: number
  /** W */
  power: number
  sunEl: number
  /** fraction of the solar disc above the terrain horizon */
  terrainFrac: number
  /** fraction of the solar disc covered by the Earth */
  eclipseFrac: number
  /** cos of the incidence angle on the panel */
  incidence: number
  /** W/m² at the Moon right now (distance-scaled) */
  irradiance: number
}

/** Area fraction of a disc (radius r1) covered by another disc (radius r2), centres d apart (same units). */
export function overlapFraction(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0
  if (d <= Math.abs(r2 - r1)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1)
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1))
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
  const k = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  return (a1 + a2 - k) / (Math.PI * r1 * r1)
}

export function powerAt(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, mask: HorizonMask | undefined, tMs: number, panel: PanelConfig): PowerSample {
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  const sunP = sunPosition(eph, tMs), earthP = earthPosition(eph, tMs)
  const s = azEl(topo, sunP)
  const rs = Math.asin((SUN_RADIUS_KM * 1000) / s.distM) // rad
  const terrainFrac = discFraction(s.el - horizonAt(mask, s.az), rs / D2R)

  // Earth in front of the Sun?
  const e = azEl(topo, earthP)
  const re = Math.asin((EARTH_RADIUS_KM * 1000) / e.distM)
  const vs = [sunP[0] - topo.pos[0], sunP[1] - topo.pos[1], sunP[2] - topo.pos[2]]
  const ve = [earthP[0] - topo.pos[0], earthP[1] - topo.pos[1], earthP[2] - topo.pos[2]]
  const cosSep = (vs[0] * ve[0] + vs[1] * ve[1] + vs[2] * ve[2]) / (s.distM * e.distM)
  const sep = Math.acos(Math.min(1, Math.max(-1, cosSep)))
  const eclipseFrac = overlapFraction(rs, re, sep)

  const irradiance = SOLAR_CONSTANT * (AU_M / s.distM) ** 2
  const incidence = panel.mode === 'tracking' ? 1 : Math.max(0, Math.sin(s.el * D2R))
  const power = irradiance * panel.areaM2 * panel.efficiency * terrainFrac * (1 - eclipseFrac) * incidence
  return { t: tMs, power, sunEl: s.el, terrainFrac, eclipseFrac, incidence, irradiance }
}

export function powerTimeline(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, mask: HorizonMask | undefined,
  startMs: number, endMs: number, stepMs: number, panel: PanelConfig): PowerSample[] {
  const out: PowerSample[] = []
  for (let t = startMs; t <= endMs; t += stepMs) out.push(powerAt(eph, site, mask, t, panel))
  return out
}

export interface PowerSummary {
  /** W, time average over the window */
  meanW: number
  peakW: number
  /** Wh over the window and per Earth day (meanW is also the mean energy per hour, Wh/h) */
  energyWh: number
  energyPerDayWh: number
  /** % of time producing (> 1% of peak) */
  producingPct: number
  /** longest stretch without production, hours (battery sizing) */
  longestOutageH: number
  /** hours with the Sun at least partly eclipsed by the Earth */
  eclipseH: number
}

export function summarizePower(tl: PowerSample[]): PowerSummary | undefined {
  if (tl.length < 2) return undefined
  const stepH = (tl[1].t - tl[0].t) / 3600_000
  let sum = 0, peak = 0, producing = 0, gap = 0, longest = 0, ecl = 0
  for (const p of tl) peak = Math.max(peak, p.power)
  const on = Math.max(peak * 0.01, 1e-6)
  for (const p of tl) {
    sum += p.power
    const prod = p.power > on
    producing += +prod
    gap = prod ? 0 : gap + 1
    longest = Math.max(longest, gap)
    if (p.eclipseFrac > 0.001 && p.terrainFrac > 0) ecl++
  }
  const meanW = sum / tl.length
  const hours = tl.length * stepH
  return {
    meanW,
    peakW: peak,
    energyWh: meanW * hours,
    energyPerDayWh: meanW * 24,
    producingPct: (100 * producing) / tl.length,
    longestOutageH: longest * stepH,
    eclipseH: ecl * stepH,
  }
}
