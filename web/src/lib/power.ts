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
import { sunVisibleOver, type HorizonMask } from './analysis'
import { eclipseCoverFrom } from './eclipse'
import { azEl, earthPosition, SUN_RADIUS_KM, sunPosition, topoFrame, type Ephemeris } from './ephemeris'

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

export function powerAt(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, mask: HorizonMask | undefined, tMs: number, panel: PanelConfig): PowerSample {
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  const sunP = sunPosition(eph, tMs), earthP = earthPosition(eph, tMs)
  const s = azEl(topo, sunP)
  const rs = Math.asin((SUN_RADIUS_KM * 1000) / s.distM) // rad
  // share of the Sun's light over the terrain (limb-darkened disc, oblique horizon: lib/sunDisc.ts)
  const terrainFrac = sunVisibleOver(mask, s.az, s.el, rs / D2R)

  // Earth in front of the Sun? (topocentric, lib/eclipse.ts)
  const eclipseFrac = eclipseCoverFrom(sunP, earthP, topo.pos)

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

export function summarizePower(tl: PowerSample[], startMs = -Infinity): PowerSummary | undefined {
  let low = 0, high = tl.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (tl[mid].t < startMs) low = mid + 1
    else high = mid
  }
  const n = tl.length - low
  if (n < 2) return undefined
  const stepH = (tl[low + 1].t - tl[low].t) / 3600_000
  let sum = 0, peak = 0, producing = 0, gap = 0, longest = 0, ecl = 0
  for (let i = low; i < tl.length; i++) peak = Math.max(peak, tl[i].power)
  const on = Math.max(peak * 0.01, 1e-6)
  for (let i = low; i < tl.length; i++) {
    const p = tl[i]
    sum += p.power
    const prod = p.power > on
    producing += +prod
    gap = prod ? 0 : gap + 1
    longest = Math.max(longest, gap)
    if (p.eclipseFrac > 0.001 && p.terrainFrac > 0) ecl++
  }
  const meanW = sum / n
  const hours = n * stepH
  return {
    meanW,
    peakW: peak,
    energyWh: meanW * hours,
    energyPerDayWh: meanW * 24,
    producingPct: (100 * producing) / n,
    longestOutageH: longest * stepH,
    eclipseH: ecl * stepH,
  }
}
