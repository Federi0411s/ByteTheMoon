/**
 * Site analysis: terrain horizon + Sun/Earth tracks -> lit / Earth-visible timelines.
 *
 * Horizon masks come either precomputed from LOLA DEMs (pipeline/horizons.py, for preset sites)
 * or are computed here from the elevation raster loaded in the browser (custom sites).
 * Both use the same method: for each azimuth, march outward along the great circle and keep the
 * highest elevation angle, including the Moon's curvature (no atmosphere -> no refraction).
 */
import { MOON_RADIUS_M, type RasterField } from './raster'
import {
  azEl,
  earthPosition,
  ephemerisRange,
  sunPosition,
  topoFrame,
  type Ephemeris,
  EARTH_RADIUS_KM,
  SUN_RADIUS_KM,
} from './ephemeris'

export interface HorizonMask {
  azStepDeg: number
  elevDeg: number[] // length 360/azStepDeg, index 0 = north
  source: string
}

export function horizonAt(mask: HorizonMask | undefined, azDeg: number): number {
  if (!mask) return 0
  const n = mask.elevDeg.length
  const f = ((azDeg / mask.azStepDeg) % n + n) % n
  const i = Math.floor(f)
  const a = f - i
  return mask.elevDeg[i] * (1 - a) + mask.elevDeg[(i + 1) % n] * a
}

const D2R = Math.PI / 180

/** Compute a horizon mask from an elevation field (heights in metres relative to 1737.4 km). */
export function computeHorizon(
  dem: RasterField,
  latDeg: number,
  lonDeg: number,
  opts: { azStepDeg?: number; maxDistM?: number; observerHeightM?: number } = {},
): HorizonMask {
  const azStep = opts.azStepDeg ?? 1
  const maxDist = opts.maxDistM ?? 250_000
  const obsH = opts.observerHeightM ?? 2
  const R = MOON_RADIUS_M
  const lat0 = latDeg * D2R
  const lon0 = lonDeg * D2R
  const h0 = dem.sample(lon0, lat0)
  const hs = (Number.isNaN(h0) ? 0 : h0) + obsH

  // distances: fine near the site, coarser far away (geometric growth)
  const res = dem.meta.resolutionM
  const dists: number[] = []
  for (let d = res; d < maxDist; d *= 1.02) dists.push(d)

  const n = Math.round(360 / azStep)
  const elev = new Array<number>(n)
  const sinLat0 = Math.sin(lat0), cosLat0 = Math.cos(lat0)
  for (let k = 0; k < n; k++) {
    const az = k * azStep * D2R
    const sinAz = Math.sin(az), cosAz = Math.cos(az)
    let best = -90
    for (const d of dists) {
      const th = d / R // central angle
      const sinTh = Math.sin(th), cosTh = Math.cos(th)
      const lat = Math.asin(sinLat0 * cosTh + cosLat0 * sinTh * cosAz)
      const lon = lon0 + Math.atan2(sinAz * sinTh * cosLat0, cosTh - sinLat0 * Math.sin(lat))
      const h = dem.sample(lon, lat)
      if (Number.isNaN(h)) break // left the DEM
      const rt = R + h
      const e = Math.atan2(rt * cosTh - (R + hs), rt * sinTh) / D2R
      if (e > best) best = e
    }
    elev[k] = best
  }
  return { azStepDeg: azStep, elevDeg: elev, source: `${dem.meta.title} (browser)` }
}

export interface TimelineSample {
  t: number
  sunAz: number
  sunEl: number
  earthAz: number
  earthEl: number
  sunVisibleFrac: number // 0..1 of the solar disc above the terrain horizon
  earthVisibleFrac: number
}

/** Fraction of a disc of angular radius r (deg) centred at height dh (deg) above the horizon line. */
export function discFraction(dh: number, r: number): number {
  if (dh >= r) return 1
  if (dh <= -r) return 0
  const x = dh / r // area of circular segment, exact
  return 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI
}

export function computeTimeline(
  eph: Ephemeris,
  site: { lat: number; lon: number; heightM?: number },
  mask: HorizonMask | undefined,
  startMs: number,
  endMs: number,
  stepMs = 3600_000,
): TimelineSample[] {
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  const out: TimelineSample[] = []
  for (let t = startMs; t <= endMs; t += stepMs) {
    const s = azEl(topo, sunPosition(eph, t))
    const e = azEl(topo, earthPosition(eph, t))
    const rs = Math.asin((SUN_RADIUS_KM * 1000) / s.distM) / D2R
    const re = Math.asin((EARTH_RADIUS_KM * 1000) / e.distM) / D2R
    out.push({
      t,
      sunAz: s.az,
      sunEl: s.el,
      earthAz: e.az,
      earthEl: e.el,
      sunVisibleFrac: discFraction(s.el - horizonAt(mask, s.az), rs),
      earthVisibleFrac: discFraction(e.el - horizonAt(mask, e.az), re),
    })
  }
  return out
}

export interface SunTransition {
  t: number
  daylight: boolean
}

/** Find day/night crossings across the loaded ephemeris, refining each crossing to one millisecond. */
export function findSunTransitions(
  eph: Ephemeris,
  site: { lat: number; lon: number; heightM?: number },
  mask: HorizonMask | undefined,
): SunTransition[] {
  const [start, end] = ephemerisRange(eph)
  if (!(end > start)) return []
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  const visibleAt = (t: number) => {
    const sun = azEl(topo, sunPosition(eph, t))
    const radius = Math.asin((SUN_RADIUS_KM * 1000) / sun.distM) / D2R
    return discFraction(sun.el - horizonAt(mask, sun.az), radius)
  }
  const stepMs = 3600_000
  const transitions: SunTransition[] = []
  let previousT = start
  let previousDaylight = visibleAt(start) > 0.5

  while (previousT < end) {
    const t = Math.min(end, previousT + stepMs)
    const daylight = visibleAt(t) > 0.5
    if (daylight !== previousDaylight) {
      let low = previousT, high = t
      while (high - low > 1) {
        const mid = (low + high) / 2
        if ((visibleAt(mid) > 0.5) === previousDaylight) low = mid
        else high = mid
      }
      transitions.push({ t: high, daylight })
    }
    previousT = t
    previousDaylight = daylight
  }
  return transitions
}

export function nextSunTransition(transitions: SunTransition[], afterMs: number): SunTransition | undefined {
  let low = 0, high = transitions.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (transitions[mid].t <= afterMs) low = mid + 1
    else high = mid
  }
  return transitions[low]
}

export interface SiteSummary {
  litPct: number
  earthPct: number
  bothPct: number
  /** ms until the Sun / Earth next drops below the terrain horizon (null if not within window) */
  nextSunsetMs: number | null
  nextEarthsetMs: number | null
  longestDarkH: number
}

export interface TimelineSummaryIndex {
  samples: TimelineSample[]
  sunlitPrefix: Uint32Array
  earthVisiblePrefix: Uint32Array
  bothVisiblePrefix: Uint32Array
  nextSunsetIndex: Int32Array
  nextEarthsetIndex: Int32Array
  longestDarkSuffix: Uint32Array
  stepH: number
}

export function indexTimeline(tl: TimelineSample[]): TimelineSummaryIndex {
  const n = tl.length
  const sunlitPrefix = new Uint32Array(n + 1)
  const earthVisiblePrefix = new Uint32Array(n + 1)
  const bothVisiblePrefix = new Uint32Array(n + 1)
  const nextSunsetIndex = new Int32Array(n + 1)
  const nextEarthsetIndex = new Int32Array(n + 1)
  const longestDarkSuffix = new Uint32Array(n + 1)
  nextSunsetIndex[n] = -1
  nextEarthsetIndex[n] = -1

  let darkRun = 0
  for (let i = n - 1; i >= 0; i--) {
    const sample = tl[i]
    const sunlit = sample.sunVisibleFrac > 0.5
    const earthVisible = sample.earthVisibleFrac > 0.5
    sunlitPrefix[i] = sunlitPrefix[i + 1] + Number(sunlit)
    earthVisiblePrefix[i] = earthVisiblePrefix[i + 1] + Number(earthVisible)
    bothVisiblePrefix[i] = bothVisiblePrefix[i + 1] + Number(sunlit && earthVisible)
    nextSunsetIndex[i] = sample.sunVisibleFrac <= 0.5 ? i : nextSunsetIndex[i + 1]
    nextEarthsetIndex[i] = sample.earthVisibleFrac <= 0.5 ? i : nextEarthsetIndex[i + 1]
    darkRun = sunlit ? 0 : darkRun + 1
    longestDarkSuffix[i] = Math.max(darkRun, longestDarkSuffix[i + 1])
  }

  return {
    samples: tl,
    sunlitPrefix,
    earthVisiblePrefix,
    bothVisiblePrefix,
    nextSunsetIndex,
    nextEarthsetIndex,
    longestDarkSuffix,
    stepH: n > 1 ? (tl[1].t - tl[0].t) / 3600_000 : 1,
  }
}

export function summarizeIndexed(index: TimelineSummaryIndex, startMs = -Infinity): SiteSummary {
  const { samples } = index
  let low = 0, high = samples.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (samples[mid].t < startMs) low = mid + 1
    else high = mid
  }
  const n = samples.length - low
  if (!n) return { litPct: 0, earthPct: 0, bothPct: 0, nextSunsetMs: null, nextEarthsetMs: null, longestDarkH: 0 }

  const first = samples[low]
  const nextSunset = index.nextSunsetIndex[low]
  const nextEarthset = index.nextEarthsetIndex[low]
  const stepH = n > 1 ? index.stepH : 1
  return {
    litPct: (100 * (index.sunlitPrefix[low] - index.sunlitPrefix[samples.length])) / n,
    earthPct: (100 * (index.earthVisiblePrefix[low] - index.earthVisiblePrefix[samples.length])) / n,
    bothPct: (100 * (index.bothVisiblePrefix[low] - index.bothVisiblePrefix[samples.length])) / n,
    nextSunsetMs: first.sunVisibleFrac <= 0.5 ? null : nextSunset > low ? samples[nextSunset].t - first.t : null,
    nextEarthsetMs: first.earthVisibleFrac <= 0.5 ? null : nextEarthset > low ? samples[nextEarthset].t - first.t : null,
    longestDarkH: index.longestDarkSuffix[low] * stepH,
  }
}

export function summarize(tl: TimelineSample[]): SiteSummary {
  return summarizeIndexed(indexTimeline(tl))
}

/**
 * Longest night (Sun mostly hidden: less than half the disc above the terrain horizon) among the nights
 * that overlap [start, end], each measured over its FULL length: nights cut by the window edges are
 * followed up to `padMs` before / after (within the loaded ephemeris), so a short window that starts
 * or ends in the middle of a night does not report a fraction of it. Hours.
 */
export function longestFullNightH(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, mask: HorizonMask | undefined,
  start: number, end: number, stepMs: number, padMs = 30 * 86400_000): number {
  const [e0, e1] = ephemerisRange(eph)
  const a = Math.max(e0, start - padMs), b = Math.min(e1, end + padMs)
  const tl = computeTimeline(eph, site, mask, a, b, stepMs)
  let longest = 0, runStart = -1
  const close = (i: number) => {
    // run = samples runStart .. i-1; keep it if it overlaps [start, end]
    if (runStart >= 0 && tl[i - 1].t >= start && tl[runStart].t <= end) longest = Math.max(longest, (i - runStart) * stepMs)
    runStart = -1
  }
  for (let i = 0; i < tl.length; i++) {
    if (tl[i].sunVisibleFrac > 0.5) close(i)
    else if (runStart < 0) runStart = i
  }
  close(tl.length)
  return longest / 3600_000
}

export interface DarkInterval {
  startMs: number
  endMs: number
  /** Sunrise is exclusive; the end of the loaded ephemeris is inclusive. */
  endInclusive: boolean
}

export function darkIntervalsFromTransitions(
  ephemerisStart: number,
  ephemerisEnd: number,
  initialDaylight: boolean,
  transitions: SunTransition[],
): DarkInterval[] {
  const intervals: DarkInterval[] = []
  let darkStart = initialDaylight ? undefined : ephemerisStart
  for (const transition of transitions) {
    if (transition.daylight) {
      if (darkStart !== undefined) intervals.push({ startMs: darkStart, endMs: transition.t, endInclusive: false })
      darkStart = undefined
    } else if (darkStart === undefined) {
      darkStart = transition.t
    }
  }
  if (darkStart !== undefined) intervals.push({ startMs: darkStart, endMs: ephemerisEnd, endInclusive: true })
  return intervals
}

export function longestFullNightHFromIntervals(
  intervals: DarkInterval[],
  ephemerisRange: [number, number],
  start: number,
  end: number,
  stepMs: number,
  padMs = 30 * 86400_000,
): number {
  if (!(stepMs > 0) || end < start) return 0
  const [e0, e1] = ephemerisRange
  const a = Math.max(e0, start - padMs), b = Math.min(e1, end + padMs)
  if (b < a) return 0
  const maxIndex = Math.floor((b - a) / stepMs)
  let longest = 0, runStart = -1, runEnd = -1
  const close = () => {
    if (runStart < 0) return
    const firstSample = a + runStart * stepMs
    const lastSample = a + runEnd * stepMs
    if (lastSample >= start && firstSample <= end) longest = Math.max(longest, (runEnd - runStart + 1) * stepMs)
    runStart = runEnd = -1
  }

  for (const interval of intervals) {
    const first = Math.max(0, Math.ceil((interval.startMs - a) / stepMs))
    const last = Math.min(maxIndex, interval.endInclusive
      ? Math.floor((interval.endMs - a) / stepMs)
      : Math.ceil((interval.endMs - a) / stepMs) - 1)
    if (first > last) continue
    // Merge runs with no sampled daylight point between them, matching computeTimeline's sampling.
    if (runStart >= 0 && first <= runEnd + 1) {
      runEnd = Math.max(runEnd, last)
    } else {
      close()
      runStart = first
      runEnd = last
    }
  }
  close()
  return longest / 3600_000
}
