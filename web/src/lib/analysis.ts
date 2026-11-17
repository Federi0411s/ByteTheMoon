/**
 * Site analysis: terrain horizon + Sun/Earth tracks -> lit / Earth-visible timelines.
 *
 * Horizon masks come either precomputed from LOLA DEMs (pipeline/lunar_horizon.py, for preset sites)
 * or from the global elevation tiles by the heatmap workers (HeatEngine.horizon, custom sites).
 * Both use the same method: for each azimuth, march outward along the great circle and keep the
 * highest elevation angle, including the Moon's curvature (no atmosphere -> no refraction).
 */
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
import { discEdgeAz, sunVisible } from './sunDisc'
import { eclipseCoverFrom } from './eclipse'

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

export interface TimelineSample {
  t: number
  sunAz: number
  sunEl: number
  earthAz: number
  earthEl: number
  sunVisibleFrac: number // 0..1 share of the Sun's (limb-darkened) light above the terrain horizon, lib/sunDisc.ts, less any eclipse
  /** 0..1 share of the Sun's disc hidden by the Earth (solar eclipse seen from the site, lib/eclipse.ts) */
  eclipseFrac: number
  earthVisibleFrac: number
}

/** Fraction of a disc of angular radius r (deg) centred at height dh (deg) above the horizon line. */
export function discFraction(dh: number, r: number): number {
  if (dh >= r) return 1
  if (dh <= -r) return 0
  const x = dh / r // area of circular segment, exact
  return 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI
}

/** Visible share of the Sun's light over a horizon mask (lib/sunDisc.ts: limb-darkened disc, oblique horizon). */
export function sunVisibleOver(mask: HorizonMask | undefined, azDeg: number, elDeg: number, rDeg: number): number {
  const w = discEdgeAz(elDeg, rDeg)
  return sunVisible(elDeg, rDeg, horizonAt(mask, azDeg), horizonAt(mask, azDeg - w), horizonAt(mask, azDeg + w))
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
    const sunP = sunPosition(eph, t), earthP = earthPosition(eph, t)
    const s = azEl(topo, sunP)
    const e = azEl(topo, earthP)
    const rs = Math.asin((SUN_RADIUS_KM * 1000) / s.distM) / D2R
    const re = Math.asin((EARTH_RADIUS_KM * 1000) / e.distM) / D2R
    // the Earth in front of the Sun takes its share off the light over the terrain (independent occultations)
    const eclipseFrac = eclipseCoverFrom(sunP, earthP, topo.pos)
    out.push({
      t,
      sunAz: s.az,
      sunEl: s.el,
      earthAz: e.az,
      earthEl: e.el,
      sunVisibleFrac: sunVisibleOver(mask, s.az, s.el, rs) * (1 - eclipseFrac),
      eclipseFrac,
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
  visibleThreshold = 0.5,
): SunTransition[] {
  const [start, end] = ephemerisRange(eph)
  if (!(end > start)) return []
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  const visibleAt = (t: number) => {
    const sunP = sunPosition(eph, t)
    const sun = azEl(topo, sunP)
    const radius = Math.asin((SUN_RADIUS_KM * 1000) / sun.distM) / D2R
    // a deep eclipse is night too (the Earth hides the Sun for up to ~4 h)
    return discFraction(sun.el - horizonAt(mask, sun.az), radius) * (1 - eclipseCoverFrom(sunP, earthPosition(eph, t), topo.pos))
  }
  const stepMs = 3600_000
  const transitions: SunTransition[] = []
  let previousT = start
  let previousDaylight = visibleAt(start) > visibleThreshold

  while (previousT < end) {
    const t = Math.min(end, previousT + stepMs)
    const daylight = visibleAt(t) > visibleThreshold
    if (daylight !== previousDaylight) {
      let low = previousT, high = t
      while (high - low > 1) {
        const mid = (low + high) / 2
        if ((visibleAt(mid) > visibleThreshold) === previousDaylight) low = mid
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
  /** light-weighted: sum of the Sun's visible share (an hour at 30 % counts 0.3 h) */
  sunlitPrefix: Float64Array
  earthVisiblePrefix: Uint32Array
  bothVisiblePrefix: Float64Array
  nextSunsetIndex: Int32Array
  nextEarthsetIndex: Int32Array
  longestDarkSuffix: Uint32Array
  stepH: number
}

export function indexTimeline(tl: TimelineSample[]): TimelineSummaryIndex {
  const n = tl.length
  const sunlitPrefix = new Float64Array(n + 1)
  const earthVisiblePrefix = new Uint32Array(n + 1)
  const bothVisiblePrefix = new Float64Array(n + 1)
  const nextSunsetIndex = new Int32Array(n + 1)
  const nextEarthsetIndex = new Int32Array(n + 1)
  const longestDarkSuffix = new Uint32Array(n + 1)
  nextSunsetIndex[n] = -1
  nextEarthsetIndex[n] = -1

  let darkRun = 0
  for (let i = n - 1; i >= 0; i--) {
    const sample = tl[i]
    const sunlit = sample.sunVisibleFrac > 0
    const earthVisible = sample.earthVisibleFrac > 0.5
    // sunlit % is light-weighted; longest night counts only intervals with no direct sunlight.
    sunlitPrefix[i] = sunlitPrefix[i + 1] + sample.sunVisibleFrac
    earthVisiblePrefix[i] = earthVisiblePrefix[i + 1] + Number(earthVisible)
    bothVisiblePrefix[i] = bothVisiblePrefix[i + 1] + (earthVisible ? sample.sunVisibleFrac : 0)
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
