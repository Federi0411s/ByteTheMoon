/// <reference lib="webworker" />
/**
 * Global heatmap worker: per map tile, sunlight / Earth visibility / slope / elevation on an n x n
 * grid of sample points from the global elevation pyramid (lib/dem.ts) and the Sun/Earth ephemeris.
 *
 * Messages (main -> worker):
 *   { type: 'init', cfg: DemConfig, hz?: HorizonConfig }   hz: precomputed horizons (lib/horizonTiles.ts), if generated
 *   { type: 'window', version, window, sun, nightSun, nightEarth, nightTimes, earth, dsn, thermalSun, thermalEarth, thermalTimes }
 *        (earth / nightEarth / thermalEarth: Earth direction + angular radius at the same instants as the
 *        Sun samples, for solar eclipses: the Earth covering the Sun, see eclipseCover)
 *   { type: 'equipot', table: EquipotTable, threshold }                               charging model (pipeline/equipot_results.csv)
 *   { type: 'window', ..., thermalSun: Float32Array(T2*4), thermalCount: Uint8Array(T2), thermalDt }
 *        nightSun/nightTimes: dedicated samples for longest night (hourly up to 90 days, then every 3 h)
 *        regular steps: Sun dir xyz + distance (AU); thermalCount marks the steps that enter the
 *        statistics (the rest are warm-up before each sampled stretch)
 *   { type: 'tile', id, z, x, y, n, demMax, thermal?, g?, polar?, landing?, longestNight? }
 *        polar = pole sign (-1 / +1): x, y are then the indices of a polar block (lib/heatGrid.ts), sampled
 *        on an n x n lattice of the polar stereographic plane instead of a lon/lat grid
 *        -> { id, version, nx, ny, sun, earth, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky, link, linkGap, sunlit, dark }   (Float32Array ny*nx, row 0 = north, grid from lib/heatGrid.ts;
 *           t* empty unless thermal was requested: the regolith model is the expensive part)
 *   { type: 'horizon', id, lat, lon, azStepDeg }   -> { id, elevDeg: Float32Array, demLevel }       (radians in, degrees out)
 *
 * Sample points include the tile edges (lon = west + i*(east-west)/(n-1)), so neighbouring tiles share
 * their border samples and the bilinearly interpolated heatmap is seamless.
 *
 * Horizons: zoomed-out jobs (samples >= 666 m apart) read them from the precomputed horizon pyramid
 * (lib/horizonTiles.ts, same model) when it is available; closer ones compute them live:
 * for each of NAZ (32) azimuths, march outward on the great circle with geometrically growing
 * steps, reading the DEM at a level matched to the step size (fine near the point, coarse far away),
 * and keep the highest elevation angle including the Moon's curvature. Horizons are cached per tile,
 * so a new time window only redoes the (cheap) time integration.
 */
import { DemSampler, demLevelFor, demPixelM } from './dem'
import { fromPolar, heatGrid, polarBlockSize } from './heatGrid'
import { HorizonSampler, MAX_TILES_PER_JOB } from './horizonTiles'
import { discEdgeAz, sunDiscHorizonMargin, sunVisible } from './sunDisc'
import type { EquipotTable } from './equipot'

const R = 1737400
const R2D = 180 / Math.PI
// map tiles: 32 azimuths x 40 steps is plenty for long-term averages (the selected site's own
// panorama uses a dense 1-degree, 220-step horizon instead)
const NAZ = 32
const STEPS = 40
const MAX_DIST = 200_000
const OBSERVER_H = 2
const MAX_LAT = (89.99 / 180) * Math.PI // the exact pole has no azimuths
const SITE_MAX_LAT = (89.9999 / 180) * Math.PI

let dem: DemSampler
let hzs: HorizonSampler | null = null
let sun = new Float32Array(0)
let nightSun = new Float32Array(0)
let nightEarth = new Float32Array(0) // Earth dir + radius at nightTimes (eclipses)
let nightTimes = new Float64Array(0)
let earth = new Float32Array(0)
let dsn = new Float64Array(0)
let version = 0
let windowStart = 0
let windowEnd = 0

// Adaptive horizons (see refineHorizon): where the Sun or the Earth passes close to the coarse NAZ
// horizon during the window, rays are traced every 1 deg (FINE_NAZ) with FINE_STEPS steps toward those
// directions only. hzN is the resolution of the horizon array the lookups below are reading.
const FINE_NAZ = 360
const FINE_STEPS = 96
/** a body this close to the coarse horizon (deg, plus its own disc) triggers refinement */
const ADAPT_MARGIN_DEG = 1.5
let hzN = NAZ

const sinAz = new Float64Array(NAZ), cosAz = new Float64Array(NAZ)
for (let a = 0; a < NAZ; a++) {
  sinAz[a] = Math.sin((2 * Math.PI * a) / NAZ)
  cosAz[a] = Math.cos((2 * Math.PI * a) / NAZ)
}

interface Ray { d: Float64Array; sinD: Float64Array; cosD: Float64Array; curv: Float64Array; level: Int32Array }

/** Step distances and the DEM level used at each, for a finest level demMax. */
function makeRay(demMax: number, steps = STEPS, d0Factor = 0.75): Ray {
  const d0 = Math.max(demPixelM(demMax) * d0Factor, 50)
  const g = Math.pow(MAX_DIST / d0, 1 / (steps - 1))
  const ray: Ray = {
    d: new Float64Array(steps), sinD: new Float64Array(steps), cosD: new Float64Array(steps),
    curv: new Float64Array(steps), level: new Int32Array(steps),
  }
  for (let k = 0; k < steps; k++) {
    const d = d0 * Math.pow(g, k)
    ray.d[k] = d
    ray.sinD[k] = Math.sin(d / R)
    ray.cosD[k] = Math.cos(d / R)
    ray.curv[k] = d / (2 * R)
    // DEM pixel about half the step spacing: coarser data only where steps are long anyway
    ray.level[k] = demLevelFor(0.5 * d * (g - 1), demMax)
  }
  return ray
}

/** Fetch the DEM tiles a set of points needs, for every level the ray uses (plus `extra` level). */
async function ensureFor(west: number, south: number, east: number, north: number, ray: Ray | null, extra: number, hold: number[], extraRadiusM = 0) {
  const reach = new Map<number, number>() // level -> max distance at which it is used
  if (ray) for (let k = 0; k < ray.d.length; k++) reach.set(ray.level[k], Math.max(reach.get(ray.level[k]) ?? 0, ray.d[k]))
  reach.set(extra, Math.max(reach.get(extra) ?? 0, demPixelM(extra) * 2, extraRadiusM))
  const jobs: Promise<unknown>[] = []
  for (const [z, d] of reach) {
    const dLat = d / R + 1e-6
    const s = Math.max(-Math.PI / 2, south - dLat), n = Math.min(Math.PI / 2, north + dLat)
    const maxAbs = Math.max(Math.abs(s), Math.abs(n))
    // longitude half-span reached at distance d from the box edge: the whole ring only if the pole
    // itself is within reach (otherwise near-polar tiles fetched hundreds of fine tiles for nothing)
    const full = Math.PI / 2 - maxAbs <= dLat * 1.01
    const dLon = full ? Math.PI : Math.asin(Math.min(1, Math.sin(dLat) / Math.cos(maxAbs))) * 1.05
    jobs.push(full || east - west + 2 * dLon >= 2 * Math.PI
      ? dem.ensureBox(z, -Math.PI, s, Math.PI, n, hold)
      : dem.ensureBox(z, west - dLon, s, east + dLon, n, hold))
  }
  await Promise.all(jobs)
}

/**
 * As ensureFor, but from the sample points themselves (polar blocks): the lon/lat box of a block
 * around the pole is the whole ring, which at the finest levels meant hundreds of elevation tiles
 * no ray ever reads. Each level's tiles are taken within its reach of each sample instead.
 */
async function ensureForSamples(smp: Samples, ray: Ray | null, extra: number, hold: number[], extraRadiusM = 0) {
  const reach = new Map<number, number>()
  if (ray) for (let k = 0; k < ray.d.length; k++) reach.set(ray.level[k], Math.max(reach.get(ray.level[k]) ?? 0, ray.d[k]))
  reach.set(extra, Math.max(reach.get(extra) ?? 0, demPixelM(extra) * 2, extraRadiusM))
  const jobs: Promise<unknown>[] = []
  for (const [z, d] of reach) {
    const n = 2 ** z, step = Math.PI / n, cols = 2 * n
    const dLat = d / R + 1e-6
    const keys = new Set<number>()
    for (let c = 0; c < smp.lon.length; c++) {
      const lon = smp.lon[c], lat = smp.lat[c]
      const s = Math.max(-Math.PI / 2, lat - dLat), nn = Math.min(Math.PI / 2, lat + dLat)
      const maxAbs = Math.max(Math.abs(s), Math.abs(nn))
      const full = Math.PI / 2 - maxAbs <= dLat * 1.01
      const dLon = full ? Math.PI : Math.asin(Math.min(1, Math.sin(dLat) / Math.cos(maxAbs))) * 1.05
      const y0 = Math.max(0, Math.floor((Math.PI / 2 - nn) / step)), y1 = Math.min(n - 1, Math.floor((Math.PI / 2 - s) / step))
      const all = full || dLon >= Math.PI
      const x0 = all ? 0 : Math.floor((lon - dLon + Math.PI) / step), x1 = all ? cols - 1 : Math.floor((lon + dLon + Math.PI) / step)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.add(y * cols + (((x % cols) + cols) % cols))
    }
    for (const k of keys) {
      const lon = -Math.PI + ((k % cols) + 0.5) * step, lat = Math.PI / 2 - (Math.floor(k / cols) + 0.5) * step
      jobs.push(dem.ensureBox(z, lon, lat, lon, lat, hold))
    }
  }
  await Promise.all(jobs)
}

/**
 * Horizon elevation (deg) per azimuth for one point. Without the point's own height the result would
 * be meaningless (a guessed 0 m under a 4 km deep crater gives a horizon far below 0), so then the
 * output is NaN (drawn transparent), unless `guessHeight` (the site panorama keeps its old fallback).
 */
function horizon(lon0: number, lat0: number, ray: Ray, demMax: number, out: Float32Array, nAz = NAZ, sA = sinAz, cA = cosAz, guessHeight = false) {
  const sinP = Math.sin(lat0), cosP = Math.cos(lat0)
  const h0 = dem.sample(lon0, lat0, demMax)
  if (h0 !== h0 && !guessHeight) { out.fill(NaN); return }
  const hs = (h0 === h0 ? h0 : 0) + OBSERVER_H
  const K = ray.d.length
  for (let a = 0; a < nAz; a++) {
    const sa = sA[a], ca = cA[a]
    let best = -Infinity
    for (let k = 0; k < K; k++) {
      const sinD = ray.sinD[k], cosD = ray.cosD[k]
      const sinLat = sinP * cosD + cosP * sinD * ca
      const lat = Math.asin(sinLat)
      const lon = lon0 + Math.atan2(sa * sinD * cosP, cosD - sinP * sinLat)
      const h = dem.sample(lon, lat, ray.level[k])
      if (h !== h) continue
      const t = (h - hs) / ray.d[k] - ray.curv[k]
      if (t > best) best = t
    }
    out[a] = best === -Infinity ? 0 : Math.atan(best) * R2D
  }
}

/**
 * Fraction of the time window the body is above the horizon (partial disc, linear in height).
 * F: local frame of the point (frame()); hMin / hMax: range of its horizon (hzRange()).
 */
function visibleFraction(body: Float32Array, F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number): number {
  const T = body.length / 4
  if (!T) return NaN
  const { ux, uy, uz, ex, ey, nx, ny, nz } = F
  let acc = 0
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = body[o], sy = body[o + 1], sz = body[o + 2], r = body[o + 3]
    const el = Math.asin(sx * ux + sy * uy + sz * uz) * R2D
    if (el - hMax >= r) { acc += 1; continue }
    if (el - hMin <= -r) continue
    let az = Math.atan2(sx * ex + sy * ey, sx * nx + sy * ny + sz * nz) * R2D
    if (az < 0) az += 360
    const f = (az / 360) * hzN
    const i0 = f | 0, w = f - i0
    const h = hz[off + i0] * (1 - w) + hz[off + (i0 + 1) % hzN] * w
    const v = (el - h) / (2 * r) + 0.5
    acc += v <= 0 ? 0 : v >= 1 ? 1 : v
  }
  return acc / T
}

// ---- surface charging (EQUIPOT; same model as lunar_charging.ChargingModel, terrain horizon) ----
const SUN_RADIUS_DEG = 0.27 // as in lunar_charging.py (charging's sunlit test only)
const SUN_RADIUS_1AU_DEG = (Math.asin(695700 / 149597870.7) * 180) / Math.PI // apparent solar radius at 1 AU
let eq: EquipotTable | null = null
let chargeThreshold = -100

/** Piecewise-linear lookup (xs ascending); binary search: it runs every time step of every sample. */
function interp(x: number, xs: number[], ys: number[]) {
  const n = xs.length
  if (x <= xs[0]) return ys[0]
  if (x > xs[n - 1]) return ys[n - 1]
  // smallest i with x <= xs[i] (as the former linear scan)
  let lo = 1, hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x <= xs[mid]) hi = mid
    else lo = mid + 1
  }
  return ys[lo - 1] + ((ys[lo] - ys[lo - 1]) * (x - xs[lo - 1])) / (xs[lo] - xs[lo - 1])
}

/** Local frame (up, east, north) + surface normal m (from the terrain gradient, as in pipeline/charging.terrain_geometry). */
interface Frame { ux: number; uy: number; uz: number; ex: number; ey: number; nx: number; ny: number; nz: number; mx: number; my: number; mz: number }
function frame(lon: number, lat: number, gE: number, gN: number): Frame {
  const cl = Math.cos(lat), sl = Math.sin(lat), co = Math.cos(lon), so = Math.sin(lon)
  const ux = cl * co, uy = cl * so, uz = sl
  const ex = -so, ey = co
  const nx = -sl * co, ny = -sl * so, nz = cl
  const g1 = gE === gE ? gE : 0, g2 = gN === gN ? gN : 0
  let mx = ux - g1 * ex - g2 * nx, my = uy - g1 * ey - g2 * ny, mz = uz - g2 * nz
  const m = Math.hypot(mx, my, mz)
  mx /= m; my /= m; mz /= m
  return { ux, uy, uz, ex, ey, nx, ny, nz, mx, my, mz }
}

/** Horizon elevation (deg) toward a direction given in the local frame (only called near the horizon). */
function horizonToward(hz: Float32Array, off: number, east: number, north: number) {
  let az = Math.atan2(east, north) * R2D
  if (az < 0) az += 360
  const f = (az / 360) * hzN
  const i0 = f | 0, w = f - i0
  return hz[off + i0] * (1 - w) + hz[off + (i0 + 1) % hzN] * w
}

/** Horizon elevation (deg) at azimuth azDeg (clockwise from north), linear between the hzN azimuths. */
function horizonAtAz(hz: Float32Array, off: number, azDeg: number) {
  const f = ((((azDeg / 360) * hzN) % hzN) + hzN) % hzN
  const i0 = f | 0, w = f - i0
  return hz[off + i0] * (1 - w) + hz[off + (i0 + 1) % hzN] * w
}

// ---- solar eclipses seen from the Moon (the Earth in front of the Sun; same geometry as lib/eclipse.ts) ----
const SUN_R_KM = 695700, EARTH_R_KM = 6371, MOON_R_KM = R / 1000
/** largest shift of the Earth on the sky between sites (the Moon's radius seen from the Earth), deg */
const ECLIPSE_PARALLAX_DEG = 0.27
/**
 * Share of the Sun's disc hidden by the Earth, seen from the point of frame F (topocentric: the
 * site's offset moves the Earth by up to ~0.26 deg). s = Sun unit direction + angular radius rS (deg,
 * from the Moon's centre), e = Earth unit direction + angular radius rE (deg). Almost always 0 after
 * one dot product (Sun and Earth far apart on the sky).
 */
function eclipseCover(F: Frame, sx: number, sy: number, sz: number, rS: number, ex: number, ey: number, ez: number, rE: number): number {
  const lim = (rS + rE + ECLIPSE_PARALLAX_DEG) / R2D
  if (sx * ex + sy * ey + sz * ez < Math.cos(lim)) return 0
  const dS = SUN_R_KM / Math.sin(rS / R2D), dE = EARTH_R_KM / Math.sin(rE / R2D)
  const px = F.ux * MOON_R_KM, py = F.uy * MOON_R_KM, pz = F.uz * MOON_R_KM
  const vsx = dS * sx - px, vsy = dS * sy - py, vsz = dS * sz - pz
  const vex = dE * ex - px, vey = dE * ey - py, vez = dE * ez - pz
  const ls = Math.hypot(vsx, vsy, vsz), le = Math.hypot(vex, vey, vez)
  const d = Math.acos(Math.min(1, Math.max(-1, (vsx * vex + vsy * vey + vsz * vez) / (ls * le))))
  const r1 = Math.asin(SUN_R_KM / ls), r2 = Math.asin(EARTH_R_KM / le)
  if (d >= r1 + r2) return 0
  if (d <= r2 - r1) return 1
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1))
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
  const k = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  return Math.min(1, (a1 + a2 - k) / (Math.PI * r1 * r1))
}

function nightMargin(F: Frame, hz: Float32Array, off: number, j: number) {
  const o = j * 4
  const sx = nightSun[o], sy = nightSun[o + 1], sz = nightSun[o + 2], r = nightSun[o + 3]
  // a total eclipse is darkness: count it as night (slightly negative margin)
  if (nightEarth.length > o && eclipseCover(F, sx, sy, sz, r, nightEarth[o], nightEarth[o + 1], nightEarth[o + 2], nightEarth[o + 3]) >= 0.999) return -0.01
  const el = Math.asin(sx * F.ux + sy * F.uy + sz * F.uz) * R2D
  const east = sx * F.ex + sy * F.ey
  const north = sx * F.nx + sy * F.ny + sz * F.nz
  let az = Math.atan2(east, north) * R2D
  if (az < 0) az += 360
  const w = discEdgeAz(el, r)
  return sunDiscHorizonMargin(
    el,
    r,
    horizonAtAz(hz, off, az),
    horizonAtAz(hz, off, az - w),
    horizonAtAz(hz, off, az + w),
  )
}

function longestNightHours(F: Frame, hz: Float32Array, off: number) {
  const n = nightTimes.length
  if (n < 2) return 0
  let previousMargin = nightMargin(F, hz, off, 0)
  let previousTime = nightTimes[0]
  let darkStart = previousMargin > 0 ? NaN : windowStart
  let longestMs = 0
  for (let j = 1; j < n; j++) {
    const margin = nightMargin(F, hz, off, j)
    const t = nightTimes[j]
    const isLit = margin > 0
    if ((previousMargin > 0) !== isLit) {
      const crossing = previousTime + (-previousMargin / (margin - previousMargin)) * (t - previousTime)
      if (isLit) {
        longestMs = Math.max(longestMs, crossing - darkStart)
        darkStart = NaN
      } else {
        darkStart = crossing
      }
    }
    previousMargin = margin
    previousTime = t
  }
  if (Number.isFinite(darkStart)) longestMs = Math.max(longestMs, windowEnd - darkStart)
  return longestMs / 3600_000
}

/**
 * Visible share of the Sun's light (lib/sunDisc.ts: limb-darkened disc, horizon line across the disc)
 * for the Sun at elevation el, radius r (deg), direction (east, north) in the local frame. Only called
 * when the disc is within the horizon's range (callers handle the fully visible / hidden cases).
 */
function sunLight(hz: Float32Array, off: number, el: number, r: number, east: number, north: number) {
  let az = Math.atan2(east, north) * R2D
  if (az < 0) az += 360
  const w = discEdgeAz(el, r)
  return sunVisible(el, r, horizonAtAz(hz, off, az), horizonAtAz(hz, off, az - w), horizonAtAz(hz, off, az + w))
}

/**
 * [sinHi, sinLo]: a Sun with sin(elevation) >= sinHi is fully above the horizon (el - hMax >= 2r) and
 * one with sin(elevation) <= sinLo fully below it (el - hMin <= -2r), for any disc radius r <= rMax (deg).
 */
function sinBounds(hMin: number, hMax: number, rMax: number): [number, number] {
  const hi = hMax + 2 * rMax, lo = hMin - 2 * rMax
  return [hi >= 90 ? Infinity : Math.sin(hi / R2D), lo <= -90 ? -Infinity : Math.sin(lo / R2D)]
}
/** largest apparent solar radius (deg) of the window's Sun samples / regular thermal steps */
let sunRMax = 0.3
let thermalRMax = 0.3

function hzRange(hz: Float32Array, off: number): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (let a = 0; a < hzN; a++) {
    const v = hz[off + a]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}

/** Results of sunAndCharging() for one point (reused object: no allocation per sample). */
const sunOut = { frac: NaN, cMean: NaN, cMin: NaN, cBelow: NaN, sunlitPct: NaN }

/**
 * One pass over the window's Sun positions for a point: the Sun's visible fraction (as
 * visibleFraction) and the EQUIPOT surface charging statistics. Both need the Sun's elevation and,
 * near the horizon, the horizon height toward the Sun, so each is computed once per time step.
 * Same arithmetic as computing them separately (results are identical). charging = false skips the
 * charging part (the landing map doesn't use it; it was ~half of this loop's time).
 */
function sunAndCharging(F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number, charging = true) {
  const T = sun.length / 4
  if (!T) {
    sunOut.frac = sunOut.cMean = sunOut.cMin = sunOut.cBelow = sunOut.sunlitPct = NaN
    return
  }
  const cosTail = eq ? Math.cos(eq.tailHalfAngleDeg / R2D) : 0
  let acc = 0, sum = 0, min = Infinity, below = 0
  // sin(elevation) bounds outside which the Sun is surely fully visible / hidden for every step (largest
  // disc of the window): decided without asin, which is otherwise the bulk of the loop
  const [sinHi, sinLo] = sinBounds(hMin, hMax, sunRMax)
  const needEl = charging && !!eq
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = sun[o], sy = sun[o + 1], sz = sun[o + 2], r = sun[o + 3]
    const se = sx * F.ux + sy * F.uy + sz * F.uz
    let el = needEl ? Math.asin(se) * R2D : NaN
    let h = NaN // horizon height toward the Sun, looked up only when needed
    // visible share of the Sun's light (limb-darkened disc over the terrain horizon, lib/sunDisc.ts);
    // the 2r margin covers an oblique horizon line across the disc
    let visible = 0
    if (se >= sinHi) visible = 1
    else if (se > sinLo) {
      if (el !== el) el = Math.asin(se) * R2D
      if (el - hMax >= 2 * r) visible = 1
      else if (!(el - hMin <= -2 * r)) visible = sunLight(hz, off, el, r, sx * F.ex + sy * F.ey, sx * F.nx + sy * F.ny + sz * F.nz)
    }
    // solar eclipse: the Earth hides part of the Sun (independent of the terrain occultation)
    const ecl = eclipseCover(F, sx, sy, sz, r, earth[o], earth[o + 1], earth[o + 2], earth[o + 3])
    if (ecl) visible *= 1 - ecl
    acc += visible
    if (!eq || !charging) continue
    // surface charging
    const inTail = sx * earth[o] + sy * earth[o + 1] + sz * earth[o + 2] > cosTail
    let above: boolean
    if (el > hMax - SUN_RADIUS_DEG) above = true
    else if (el <= hMin - SUN_RADIUS_DEG) above = false
    else {
      if (h !== h) h = horizonToward(hz, off, sx * F.ex + sy * F.ey, sx * F.nx + sy * F.ny + sz * F.nz)
      above = el > h - SUN_RADIUS_DEG
    }
    const cosInc = sx * F.mx + sy * F.my + sz * F.mz
    const illuminated = above && cosInc > 0 && ecl < 0.5 // mostly eclipsed: charges as in shadow
    let V: number
    if (illuminated) {
      const inc = Math.acos(Math.min(1, cosInc)) * R2D
      V = inTail ? interp(inc, eq.psAng, eq.psV) : interp(inc, eq.swAng, eq.swV)
    } else if (inTail) V = eq.psEcl
    else V = above ? eq.swEcl : eq.wake // self-shadow vs terrain shadow
    sum += V
    if (V < min) min = V
    if (V < chargeThreshold) below++
  }
  sunOut.frac = acc / T
  // light-weighted sunlit % (an hour at 30 % of the Sun's light counts 0.3 h), as the site panel
  sunOut.sunlitPct = (100 * acc) / T
  if (eq && charging) { sunOut.cMean = sum / T; sunOut.cMin = min; sunOut.cBelow = below / T } else sunOut.cMean = sunOut.cMin = sunOut.cBelow = NaN
}

// ---- regolith temperature: Hayne et al. 2017 1D model (constants as in pipeline/lunar_thermal.py) ----
// Implicit (backward Euler) conduction with temperature-dependent K and c lagged one step, so a 6 h step
// is stable (the pipeline's explicit scheme needs ~second sub-steps). The surface radiation balance is
// solved exactly each step: eliminate the column bottom-up to get T1 = a + b*T0, then Newton on T0.
const SIGMA = 5.670374419e-8, S0 = 1361, EPS = 0.95
const A0 = 0.12, A_A = 0.06, A_B = 0.25
const RHO_S = 1100, RHO_D = 1800, K_S = 7.4e-4, K_D = 3.4e-3, H_PARAM = 0.06, CHI = 2.7, Q_GEO = 0.018
const CP = [-3.6125, 2.7431, 2.3616e-3, -1.2340e-5, 8.9093e-9]
const DEPTH: number[] = [0] // node depths (m): 4 mm at the surface, x1.2 per layer, to 1.5 m
for (let dz = 0.004; DEPTH[DEPTH.length - 1] < 1.5; dz *= 1.2) DEPTH.push(DEPTH[DEPTH.length - 1] + dz)
const NZ = DEPTH.length
const DZ = new Float64Array(NZ - 1).map((_, i) => DEPTH[i + 1] - DEPTH[i])
const RHO = new Float64Array(NZ).map((_, i) => RHO_D - (RHO_D - RHO_S) * Math.exp(-DEPTH[i] / H_PARAM))
const KC = new Float64Array(NZ).map((_, i) => K_D - ((K_D - K_S) * (RHO_D - RHO[i])) / (RHO_D - RHO_S))
const VOL = new Float64Array(NZ).map((_, i) => (i === 0 ? DZ[0] / 2 : i === NZ - 1 ? DZ[NZ - 2] / 2 : (DZ[i - 1] + DZ[i]) / 2))
const RHO_VOL = RHO.map((rho, i) => rho * VOL[i])
const HALF_INV_DZ = DZ.map((dz) => 0.5 / dz)
const [CP0, CP1, CP2, CP3, CP4] = CP
const cp = (t: number) => CP0 + t * (CP1 + t * (CP2 + t * (CP3 + t * CP4)))
const albedo = (incDeg: number) => {
  const a = incDeg / 45, b = incDeg / 90, b2 = b * b, b4 = b2 * b2
  return A0 + A_A * a * a * a + A_B * b4 * b4
}

let thermalSun = new Float32Array(0) // per regular step: unit dir xyz + Sun distance (AU)
let thermalEarth = new Float32Array(0) // per regular step: Earth unit dir xyz + angular radius (deg), for eclipses
let thermalCount = new Uint8Array(0) // per step: 1 = counted in the statistics, 0 = warm-up
let thermalTimes = new Float64Array(0)
let thermalDt = 21600
const SPIN_UP_S = 3 * 29.53 * 86400

// work buffers of thermal(), reused for every sample (no allocation per point)
let qBuf = new Float64Array(0)
const Tc = new Float64Array(NZ), Kn = new Float64Array(NZ)
const alpha = new Float64Array(NZ), beta = new Float64Array(NZ), G = new Float64Array(NZ - 1), C = new Float64Array(NZ)

function thermal(F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number, series?: Float32Array, seriesOff = 0): [number, number, number] {
  if (!thermalSun.length) return [NaN, NaN, NaN]
  return solveThermal(absorbedFlux(F, hz, off, hMin, hMax), series, seriesOff)
}

/** Absorbed solar flux (W/m2) per regular thermal step into qBuf; returns its mean over the steps. */
function absorbedFlux(F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number): number {
  const T = thermalSun.length / 4
  // absorbed flux per step (share of the Sun's light above the terrain horizon, lib/sunDisc.ts, and
  // incidence on the local slope)
  if (qBuf.length < T) qBuf = new Float64Array(T)
  const Q = qBuf
  Q.fill(0, 0, T)
  let qMean = 0, lit = 0
  const [sinHi, sinLo] = sinBounds(hMin, hMax, thermalRMax) // as in sunAndCharging
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = thermalSun[o], sy = thermalSun[o + 1], sz = thermalSun[o + 2], au = thermalSun[o + 3]
    const cosInc = sx * F.mx + sy * F.my + sz * F.mz
    if (cosInc <= 0) continue
    const se = sx * F.ux + sy * F.uy + sz * F.uz
    let vis: number
    if (se >= sinHi) vis = 1
    else if (se <= sinLo) vis = 0
    else {
      const el = Math.asin(se) * R2D
      const r = SUN_RADIUS_1AU_DEG / au
      if (el - hMax >= 2 * r) vis = 1
      else if (el - hMin <= -2 * r) vis = 0
      else vis = sunLight(hz, off, el, r, sx * F.ex + sy * F.ey, sx * F.nx + sy * F.ny + sz * F.nz)
    }
    if (vis && thermalEarth.length > o + 3) { // solar eclipse
      const ecl = eclipseCover(F, sx, sy, sz, SUN_RADIUS_1AU_DEG / au, thermalEarth[o], thermalEarth[o + 1], thermalEarth[o + 2], thermalEarth[o + 3])
      if (ecl) vis *= 1 - ecl
    }
    if (!vis) continue
    const inc = Math.acos(Math.min(1, cosInc)) * R2D
    Q[j] = (1 - albedo(inc)) * (S0 / (au * au)) * cosInc * vis
    qMean += Q[j] / T
    lit++
  }
  fluxLitFraction = lit / T
  return qMean
}
/** share of the steps with any absorbed flux in the last absorbedFlux() call */
let fluxLitFraction = 0

/** Regolith column driven by the flux in qBuf (absorbedFlux): [mean, min, max] surface temperature (K). */
function solveThermal(qMean: number, series?: Float32Array, seriesOff = 0): [number, number, number] {
  const T = thermalSun.length / 4
  const Q = qBuf
  // start near the long-term mean temperature (~0.74 x the mean-flux radiative equilibrium)
  Tc.fill(Math.max(30, 0.74 * Math.pow(qMean / (EPS * SIGMA), 0.25)))
  const spin = Math.ceil(SPIN_UP_S / thermalDt)
  let sum = 0, min = Infinity, max = -Infinity, n = 0
  // (hot loop, ~3000 steps x 25 nodes per sample: no `**` (a pow() call each, which made it 2.3x
  // slower), divisions hoisted into constants / one reciprocal per node)
  const invH = 1 / thermalDt
  for (let s = -spin; s < T; s++) {
    const q = Q[((s % T) + T) % T] // initial spin-up cycles through the start of the series
    for (let i = 0; i < NZ; i++) {
      const t = Tc[i], r = t * (1 / 350)
      C[i] = RHO_VOL[i] * cp(t) * invH
      Kn[i] = KC[i] * (1 + CHI * r * r * r) // conductivity of node i (once per step)
    }
    for (let i = 0; i < NZ - 1; i++) G[i] = (Kn[i] + Kn[i + 1]) * HALF_INV_DZ[i]
    // bottom-up elimination: T'[i] = alpha[i] + beta[i] * T'[i-1]
    let invD = 1 / (C[NZ - 1] + G[NZ - 2])
    alpha[NZ - 1] = (C[NZ - 1] * Tc[NZ - 1] + Q_GEO) * invD
    beta[NZ - 1] = G[NZ - 2] * invD
    for (let i = NZ - 2; i >= 1; i--) {
      invD = 1 / (C[i] + G[i - 1] + G[i] - G[i] * beta[i + 1])
      alpha[i] = (C[i] * Tc[i] + G[i] * alpha[i + 1]) * invD
      beta[i] = G[i - 1] * invD
    }
    // surface: C0 (T0' - T0) = q - eps sigma T0'^4 - G0 (T0' - alpha1 - beta1 T0')  -> Newton from above
    const a1 = alpha[1], b1 = beta[1], c0 = C[0], g0 = G[0]
    const lin = c0 + g0 * (1 - b1), rhs = q + c0 * Tc[0] + g0 * a1
    let t0 = Math.max(Tc[0], Math.sqrt(Math.sqrt(Math.max(rhs, 0) / (EPS * SIGMA))))
    for (let it = 0; it < 30; it++) {
      const t2 = t0 * t0
      const f = EPS * SIGMA * t2 * t2 + lin * t0 - rhs
      const d = f / (4 * EPS * SIGMA * t2 * t0 + lin)
      t0 -= d
      if (Math.abs(d) < 1e-3) break
    }
    Tc[0] = Math.max(t0, 2)
    for (let i = 1; i < NZ; i++) Tc[i] = alpha[i] + beta[i] * Tc[i - 1]
    if (s >= 0 && thermalCount[s]) {
      const v = Tc[0]
      if (series) series[seriesOff + s] = v
      sum += v
      n++
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  return [sum / n, min, max]
}

// ---- per-tile terrain cache (horizons, slope, elevation, gradient) ----
interface Terrain { hz: Float32Array; slope: Float32Array; elev: Float32Array; gE: Float32Array; gN: Float32Array; slopeLevel: number }
const hzCache = new Map<string, Terrain>()
const hzOrder: string[] = []
const HZ_CACHE = 80 // per worker; a 33 x 33 tile's horizons are ~140 KB

/** Sample points of one job (row-major, row 0 = north / top), their lon/lat bounding box and spacing (m). */
interface Samples { key: string; polar: boolean; nx: number; ny: number; lon: Float64Array; lat: Float64Array; box: [number, number, number, number]; spacing: number }

/** Geographic tile group x (g tiles wide, see heatGrid.tileGroup) of row y, level z: lon/lat grid, edges included. */
function geoSamples(z: number, x: number, y: number, n: number, g = 1): Samples {
  const step = Math.PI / 2 ** z
  const west = -Math.PI + x * g * step, north = Math.PI / 2 - y * step
  const south = north - step, east = west + g * step
  const { nx, ny } = heatGrid(z, y, n, g)
  const lon = new Float64Array(nx * ny), lat = new Float64Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, north - (j * (north - south)) / (ny - 1)))
    for (let i = 0; i < nx; i++) {
      lon[j * nx + i] = west + (i * (east - west)) / (nx - 1)
      lat[j * nx + i] = la
    }
  }
  return { key: `${z}/${x}/${y}/${n}/${g}`, polar: false, nx, ny, lon, lat, box: [west, south, east, north], spacing: ((north - south) * R) / (ny - 1) }
}

/** Polar block (bx, by) of level z around pole p: n x n lattice of the polar stereographic plane, edges included. */
function polarSamples(z: number, bx: number, by: number, n: number, p: number): Samples {
  const S = polarBlockSize(z), d = S / (n - 1)
  const x0 = bx * S, yTop = (by + 1) * S
  const lon = new Float64Array(n * n), lat = new Float64Array(n * n)
  const ll: [number, number] = [0, 0]
  let latMin = Infinity, latMax = -Infinity
  // longitude range unwrapped around the block centre (the whole ring if the block holds the pole)
  const c = fromPolar(x0 + S / 2, yTop - S / 2, p, [0, 0])[0]
  let lonMin = Infinity, lonMax = -Infinity
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    fromPolar(x0 + i * d, yTop - j * d, p, ll)
    const k = j * n + i
    lon[k] = ll[0]
    lat[k] = Math.max(-MAX_LAT, Math.min(MAX_LAT, ll[1]))
    if (ll[1] < latMin) latMin = ll[1]
    if (ll[1] > latMax) latMax = ll[1]
    let u = ll[0] - c
    if (u > Math.PI) u -= 2 * Math.PI
    else if (u < -Math.PI) u += 2 * Math.PI
    if (u < lonMin) lonMin = u
    if (u > lonMax) lonMax = u
  }
  const hasPole = x0 <= 0 && x0 + S >= 0 && yTop - S <= 0 && yTop >= 0
  if (hasPole) {
    if (p > 0) latMax = Math.PI / 2
    else latMin = -Math.PI / 2
  }
  const box: [number, number, number, number] = hasPole ? [-Math.PI, latMin, Math.PI, latMax] : [c + lonMin, latMin, c + lonMax, latMax]
  return { key: `P${p}/${z}/${bx}/${by}/${n}`, polar: true, nx: n, ny: n, lon, lat, box, spacing: d }
}

async function terrain(smp: Samples, demMax: number, footprintRadiusM = 0): Promise<Terrain> {
  const [west, south, east, north] = smp.box
  // slope/elevation at the sample spacing (coarse tiles -> coarse, honest slopes)
  const zs = demLevelFor(smp.spacing, demMax)
  // zoomed out: precomputed horizons of the level matching the sample spacing (unless that takes too
  // many tiles, e.g. the thin geographic tiles around a pole, or they can't be loaded)
  // (not inside the polar caps: the stored horizons were traced on the global DEM, which is wrong
  // near the poles; there the live horizons read the polar DEMs, see lib/dem.ts)
  const pre = hzs && !(south < dem.polarCapLat) && !(north > dem.polarCapLatNorth) ? hzs.levelFor(smp.spacing) : -1
  if (pre >= 0) {
    const key = `${smp.key}/h${pre}/${zs}/${footprintRadiusM}`
    const hit = hzCache.get(key)
    if (hit) return hit
    const list = hzs!.tilesFor(smp.lon, smp.lat, pre)
    if (list.length <= MAX_TILES_PER_JOB && (await hzs!.ensure(list))) {
      const hold: number[] = []
      try {
        // only the elevation for slope / height is still read here
        if (smp.polar) await ensureForSamples(smp, null, zs, hold, footprintRadiusM)
        else await ensureFor(west, south, east, north, null, zs, hold, footprintRadiusM)
        return computeTerrain(key, smp, demMax, null, zs, pre)
      } finally {
        dem.unpin(hold)
      }
    }
  }
  const key = `${smp.key}/${demMax}/${footprintRadiusM}`
  const hit = hzCache.get(key)
  if (hit) return hit
  const ray = makeRay(demMax)
  const hold: number[] = []
  try {
    if (smp.polar) await ensureForSamples(smp, ray, zs, hold, footprintRadiusM)
    else await ensureFor(west, south, east, north, ray, zs, hold, footprintRadiusM)
    return computeTerrain(key, smp, demMax, ray, zs)
  } finally {
    dem.unpin(hold)
  }
}

/** Horizons (live from `ray`, or precomputed level `pre` >= 0), slope, elevation and gradient per sample. */
function computeTerrain(key: string, smp: Samples, demMax: number, ray: Ray | null, zs: number, pre = -1): Terrain {
  const { nx, ny } = smp, N = nx * ny
  const hz = new Float32Array(N * NAZ)
  const slope = new Float32Array(N), elev = new Float32Array(N)
  const gE = new Float32Array(N), gN = new Float32Array(N)
  const tmp = new Float32Array(NAZ)
  const ds = demPixelM(zs)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      const lon = smp.lon[c], lat = smp.lat[c]
      if (pre >= 0) hzs!.sample(lon, lat, pre, tmp)
      else horizon(lon, lat, ray!, demMax, tmp)
      hz.set(tmp, c * NAZ)
      // gradient from central differences over one DEM pixel of level zs (east, north)
      const dLat = ds / R, dLon = dLat / Math.max(Math.cos(lat), 1e-6)
      const hE = dem.sample(lon + dLon, lat, zs), hW = dem.sample(lon - dLon, lat, zs)
      const hN = dem.sample(lon, lat + dLat, zs), hS = dem.sample(lon, lat - dLat, zs)
      gE[c] = (hE - hW) / (2 * ds)
      gN[c] = (hN - hS) / (2 * ds)
      slope[c] = Math.atan(Math.hypot(gE[c], gN[c])) * R2D
      elev[c] = dem.sample(lon, lat, zs)
    }
  }
  const out = { hz, slope, elev, gE, gN, slopeLevel: zs }
  hzCache.set(key, out)
  hzOrder.push(key)
  while (hzOrder.length > HZ_CACHE) hzCache.delete(hzOrder.shift()!)
  return out
}

function sampleSlope(lon: number, lat: number, level: number): number {
  const ds = demPixelM(level), dLat = ds / R, dLon = dLat / Math.max(Math.cos(lat), 1e-6)
  const east = (dem.sample(lon + dLon, lat, level) - dem.sample(lon - dLon, lat, level)) / (2 * ds)
  const north = (dem.sample(lon, lat + dLat, level) - dem.sample(lon, lat - dLat, level)) / (2 * ds)
  return Math.atan(Math.hypot(east, north)) * R2D
}

function maxFootprintSlope(lon: number, lat: number, baseSlope: number, level: number, footprint: [number, number, number]): number {
  const [a, b, azimuth] = footprint
  const az = azimuth / R2D
  let max = baseSlope
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
    const u = x / 2, v = y / 2
    if (u * u + v * v > 1 || (!u && !v)) continue
    const major = u * a, minor = v * b
    const east = major * Math.sin(az) + minor * Math.cos(az)
    const north = major * Math.cos(az) - minor * Math.sin(az)
    const sampleLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat + north / R))
    const sampleLon = lon + east / (R * Math.max(Math.cos(lat), 1e-6))
    const slope = sampleSlope(sampleLon, sampleLat, level)
    if (Number.isFinite(slope)) max = Math.max(max, slope)
  }
  return max
}

/**
 * DSN link statistics for one point: share of the window with at least one station in direct view
 * (station above its own horizon, Earth station above the point's terrain horizon) and the longest
 * gap (h). Same test as before, without the transcendental functions where they can't change the
 * answer: the station's own elevation >= 0 is the sign of a dot product, and el >= horizon is decided
 * from sin(el) against the sines of the horizon's min / max; asin + atan2 only inside that band.
 */
function stationLinkStats(F: Frame, hz: Float32Array, off: number, siteHeight: number, hMin: number, hMax: number): [number, number] {
  const T = earth.length / 4
  if (!T || dsn.length < T * 18) return [NaN, NaN]
  const siteX = F.ux * (R + siteHeight), siteY = F.uy * (R + siteHeight), siteZ = F.uz * (R + siteHeight)
  const stepH = (windowEnd - windowStart) / T / 3600_000
  const sinLo = Math.sin(hMin / R2D), sinHi = Math.sin(hMax / R2D)
  const { ux, uy, uz, ex, ey, nx, ny, nz } = F
  let linked = 0, gap = 0, longest = 0
  for (let j = 0; j < T; j++) {
    let any = false
    const base = j * 18
    for (let station = 0; station < 3 && !any; station++) {
      const o = base + station * 6
      const dx = dsn[o] - siteX, dy = dsn[o + 1] - siteY, dz = dsn[o + 2] - siteZ
      // the point must be above the station's horizon (station elevation of the Moon >= 0)
      if (-(dx * dsn[o + 3] + dy * dsn[o + 4] + dz * dsn[o + 5]) < 0) continue
      const sinEl = (dx * ux + dy * uy + dz * uz) / Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (sinEl >= sinHi) { any = true; break }
      if (sinEl < sinLo) continue
      any = Math.asin(sinEl) * R2D >= horizonToward(hz, off, dx * ex + dy * ey, dx * nx + dy * ny + dz * nz)
    }
    if (any) { linked++; gap = 0 } else if (++gap > longest) longest = gap
  }
  return [(100 * linked) / T, longest * stepH]
}

const fineMark = new Uint8Array(FINE_NAZ)
const fineSin = new Float64Array(FINE_NAZ), fineCos = new Float64Array(FINE_NAZ), fineOut = new Float32Array(FINE_NAZ)

/** Marks the 1-deg azimuth bins where `body` (T x [xyz, radius deg]) comes within the margin of the coarse horizon. */
function markNearHorizon(body: Float32Array, F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number): number {
  const T = body.length / 4
  let marked = 0
  // sin(elevation) outside [lo, hi] can't be near any part of the horizon (largest disc: 0.3 deg Sun, 1 deg Earth)
  const pad = ADAPT_MARGIN_DEG + 2
  const sHi = hMax + pad >= 90 ? 2 : Math.sin((hMax + pad) / R2D), sLo = hMin - pad <= -90 ? -2 : Math.sin((hMin - pad) / R2D)
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = body[o], sy = body[o + 1], sz = body[o + 2], r = body[o + 3]
    const se = sx * F.ux + sy * F.uy + sz * F.uz
    if (se > sHi || se < sLo) continue
    const el = Math.asin(se) * R2D
    let az = Math.atan2(sx * F.ex + sy * F.ey, sx * F.nx + sy * F.ny + sz * F.nz) * R2D
    if (az < 0) az += 360
    if (Math.abs(el - horizonAtAz(hz, off, az)) > ADAPT_MARGIN_DEG + 2 * r) continue
    // the disc spans about r / cos(el) of azimuth: mark it plus one bin each side
    const w = Math.ceil(r / Math.max(Math.cos(el / R2D), 0.05)) + 1
    for (let d = -w; d <= w; d++) {
      const b = ((Math.floor(az) + d) % FINE_NAZ + FINE_NAZ) % FINE_NAZ
      if (!fineMark[b]) { fineMark[b] = 1; marked++ }
    }
  }
  return marked
}

/**
 * Adaptive horizon of one sample: where the Sun or the Earth passes within ADAPT_MARGIN_DEG (plus its
 * disc) of the coarse NAZ horizon during the window, the horizon is traced every 1 deg with a denser
 * ray (FINE_STEPS) toward those directions only, so a peak between two coarse azimuths can no longer
 * hide; the other directions keep the coarse values (interpolated to 1 deg). A Sun high above the
 * horizon or deep below it triggers nothing. Returns a FINE_NAZ horizon, or null when nothing needed
 * refining (or the elevation tiles for the dense ray aren't available).
 */
function refineHorizon(lon: number, lat: number, F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number, ray: Ray, demMax: number): Float32Array | null {
  fineMark.fill(0)
  let marked = markNearHorizon(sun, F, hz, off, hMin, hMax)
  if (earth.length) marked += markNearHorizon(earth, F, hz, off, hMin, hMax)
  if (!marked) return null
  const out = new Float32Array(FINE_NAZ)
  let m = 0
  for (let b = 0; b < FINE_NAZ; b++) {
    out[b] = horizonAtAz(hz, off, b)
    if (fineMark[b]) {
      const a = (b / R2D)
      fineSin[m] = Math.sin(a)
      fineCos[m] = Math.cos(a)
      m++
    }
  }
  horizon(lon, lat, ray, demMax, fineOut, m, fineSin, fineCos)
  if (fineOut[0] !== fineOut[0]) return null
  for (let b = 0, k = 0; b < FINE_NAZ; b++) if (fineMark[b]) out[b] = fineOut[k++]
  return out
}

/** adaptive regolith model of the landing map (see tile()): max relative spread of the neighbours' k, max lit-share difference */
const ADAPT_K_TOL = 0.01
const ADAPT_LIT_TOL = 0.02

/** Landing-score request: per-sample criteria for the suitability map (classified per pixel on the main thread). */
interface LandingRequest {
  /** steepest-slope-in-footprint from the DEM, only when the slope pyramid is not available: [a m, b m, azimuth deg] */
  footprint?: [number, number, number]
  /** [lon rad, lat rad, radius m]: samples farther than this (plus 3 sample spacings) are skipped (NaN) */
  clip?: [number, number, number]
}

async function tile(m: {
  id: number; z: number; x: number; y: number; n: number; demMax: number; thermal?: boolean
  thermalSeriesIndices?: number[]; g?: number; polar?: number; longestNight?: boolean
  landing?: LandingRequest
}) {
  const demMax = Math.min(m.demMax, dem.maxLevel)
  const smp = m.polar ? polarSamples(m.z, m.x, m.y, m.n, m.polar) : geoSamples(m.z, m.x, m.y, m.n, m.g ?? 1)
  const fp = m.landing?.footprint
  const footprintRadiusM = fp ? Math.max(fp[0], fp[1]) : 0
  const t = await terrain(smp, demMax, footprintRadiusM)
  const { nx, ny } = smp, N = nx * ny
  const s = new Float32Array(N), e = new Float32Array(N)
  const cMean = new Float32Array(N), cMin = new Float32Array(N), cBelow = new Float32Array(N)
  const tMean = new Float32Array(m.thermal ? N : 0), tMin = new Float32Array(m.thermal ? N : 0), tMax = new Float32Array(m.thermal ? N : 0)
  const steps = thermalSun.length / 4
  const seriesIndices = m.thermalSeriesIndices ?? []
  const seriesIndexByCell = new Map(seriesIndices.map((index, seriesIndex) => [index, seriesIndex]))
  const tSeries = new Float32Array(m.thermal && seriesIndices.length ? seriesIndices.length * steps : 0)
  tSeries.fill(NaN)
  const dark = new Float32Array(N) // longest interval with no direct sunlight, when requested (h)
  dark.fill(NaN)
  const fSky = new Float32Array(N) // visible-sky fraction, as pipeline/lunar_radiation.py: mean(1 - sin H) / 2
  // landing criteria (empty unless requested): DSN link % and longest gap (h), sunlit % of the window
  const L = m.landing ? N : 0
  const link = new Float32Array(L), linkGap = new Float32Array(L), sunlit = new Float32Array(L)
  const slope = t.slope.slice()
  // Landing map: the regolith model (most of the cost) runs exactly on every other sample (tile edges
  // included, so neighbouring tiles agree); the samples between are predicted from their own absorbed
  // flux, T = k (q + q_geo)^(1/4), with k interpolated from the exact neighbours, where those agree
  // (k within ADAPT_K_TOL, lit-time share within ADAPT_LIT_TOL of the sample's own); elsewhere (shadow
  // edges, PSRs, data gaps) they are solved exactly too.
  const adaptive = !!m.landing && !!m.thermal && !seriesIndices.length && nx >= 3 && ny >= 3
  const coarse = (i: number, n: number) => (i & 1) === 0 || i === n - 1
  const qm = new Float64Array(adaptive ? N : 0), litF = new Float32Array(adaptive ? N : 0)
  const pending: number[] = []
  // skip samples well outside the score circle (3 spacings: the upsampling reads up to 2 samples away)
  const clip = m.landing?.clip
  const clipCos = clip ? Math.cos(Math.min(Math.PI, (clip[2] + 3 * smp.spacing) / R)) : -2
  const clipSin0 = clip ? Math.sin(clip[1]) : 0, clipCos0 = clip ? Math.cos(clip[1]) : 0
  // adaptive horizons: the dense ray's elevation tiles stay pinned while the samples are processed
  const fineRay = makeRay(demMax, FINE_STEPS)
  const fineHold: number[] = []
  const zs = demLevelFor(smp.spacing, demMax)
  if (smp.polar) await ensureForSamples(smp, fineRay, zs, fineHold)
  else await ensureFor(smp.box[0], smp.box[1], smp.box[2], smp.box[3], fineRay, zs, fineHold)
  const fine = new Map<number, Float32Array>() // refined horizon per sample (for the second pass below)
  /** horizon array, offset and range to use for sample c (refined where it matters); sets hzN */
  const hzFor = (c: number, F: Frame): [Float32Array, number, number, number] => {
    hzN = NAZ
    const off = c * NAZ
    const [hMin, hMax] = hzRange(t.hz, off)
    const f = fine.get(c) ?? refineHorizon(smp.lon[c], smp.lat[c], F, t.hz, off, hMin, hMax, fineRay, demMax)
    if (!f) return [t.hz, off, hMin, hMax]
    fine.set(c, f)
    hzN = FINE_NAZ
    const [fMin, fMax] = hzRange(f, 0)
    return [f, 0, fMin, fMax]
  }
  try {
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i
      const lon = smp.lon[c], lat = smp.lat[c]
      const outside = clip !== undefined && clipSin0 * Math.sin(lat) + clipCos0 * Math.cos(lat) * Math.cos(lon - clip[0]) < clipCos
      if (outside || t.hz[c * NAZ] !== t.hz[c * NAZ]) { // no elevation here (see horizon): leave the point transparent
        s[c] = e[c] = cMean[c] = cMin[c] = cBelow[c] = fSky[c] = dark[c] = NaN
        if (m.thermal) tMean[c] = tMin[c] = tMax[c] = NaN
        if (m.landing) link[c] = linkGap[c] = sunlit[c] = slope[c] = NaN
        continue
      }
      const F = frame(lon, lat, t.gE[c], t.gN[c])
      const [hzc, off, hMin, hMax] = hzFor(c, F)
      sunAndCharging(F, hzc, off, hMin, hMax, !m.landing) // (the score doesn't use the charging part)
      s[c] = sunOut.frac
      cMean[c] = sunOut.cMean
      cMin[c] = sunOut.cMin
      cBelow[c] = sunOut.cBelow
      if (m.longestNight) dark[c] = longestNightHours(F, hzc, off)
      e[c] = m.landing ? NaN : visibleFraction(earth, F, hzc, off, hMin, hMax) // (the score uses the DSN link instead)
      let sky = 0
      for (let a = 0; a < NAZ; a++) sky += 1 - Math.sin(t.hz[c * NAZ + a] / R2D)
      fSky[c] = sky / NAZ / 2
      const seriesIndex = seriesIndexByCell.get(c)
      if (adaptive && steps) {
        qm[c] = absorbedFlux(F, hzc, off, hMin, hMax)
        litF[c] = fluxLitFraction
        if (coarse(i, nx) && coarse(j, ny)) [tMean[c], tMin[c], tMax[c]] = solveThermal(qm[c])
        else pending.push(c)
      } else if (m.thermal && (!seriesIndices.length || seriesIndex !== undefined)) {
        [tMean[c], tMin[c], tMax[c]] = thermal(F, hzc, off, hMin, hMax, seriesIndex === undefined ? undefined : tSeries, (seriesIndex ?? 0) * steps)
      }
      if (m.landing) {
        sunlit[c] = sunOut.sunlitPct
        ;[link[c], linkGap[c]] = stationLinkStats(F, hzc, off, t.elev[c], hMin, hMax)
        slope[c] = fp ? maxFootprintSlope(lon, lat, t.slope[c], t.slopeLevel, fp) : NaN
      }
    }
  }
  for (const c of pending) {
    const i = c % nx, j = (c - i) / nx
    const i0 = coarse(i, nx) ? i : i - 1, i1 = coarse(i, nx) ? i : i + 1
    const j0 = coarse(j, ny) ? j : j - 1, j1 = coarse(j, ny) ? j : j + 1
    const corners = [j0 * nx + i0, j0 * nx + i1, j1 * nx + i0, j1 * nx + i1]
    let ok = true, kMin = Infinity, kMax = -Infinity
    const k = [0, 0, 0, 0]
    for (let q = 0; q < 4 && ok; q++) {
      const cc = corners[q]
      k[q] = tMean[cc] / Math.sqrt(Math.sqrt(qm[cc] + Q_GEO))
      if (!(k[q] === k[q]) || Math.abs(litF[cc] - litF[c]) > ADAPT_LIT_TOL) ok = false
      else { kMin = Math.min(kMin, k[q]); kMax = Math.max(kMax, k[q]) }
    }
    if (ok && kMax - kMin <= ADAPT_K_TOL * kMin) {
      const wx = i1 > i0 ? (i - i0) / (i1 - i0) : 0, wy = j1 > j0 ? (j - j0) / (j1 - j0) : 0
      const kHat = (k[0] * (1 - wx) + k[1] * wx) * (1 - wy) + (k[2] * (1 - wx) + k[3] * wx) * wy
      tMean[c] = kHat * Math.sqrt(Math.sqrt(qm[c] + Q_GEO))
      tMin[c] = tMax[c] = NaN // not predicted (the score uses the mean only)
      continue
    }
    const lon = smp.lon[c], lat = smp.lat[c]
    const F = frame(lon, lat, t.gE[c], t.gN[c])
    const [hzc, off, hMin, hMax] = hzFor(c, F)
    ;[tMean[c], tMin[c], tMax[c]] = solveThermal(absorbedFlux(F, hzc, off, hMin, hMax))
  }
  } finally {
    hzN = NAZ
    dem.unpin(fineHold)
  }
  const elev = t.elev.slice()
  const arrays = [s, e, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky, link, linkGap, sunlit, dark]
  const tTimes = seriesIndices.length ? thermalTimes.slice() : undefined
  ;(self as unknown as Worker).postMessage(
    {
      id: m.id, version, nx, ny, sun: s, earth: e, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky,
      link, linkGap, sunlit, dark,
      thermal: !!m.thermal,
      ...(seriesIndices.length ? { tSeries, tTimes, tSeriesIndices: seriesIndices } : {}),
    },
    [...arrays.map((a) => a.buffer), ...(tTimes ? [tSeries.buffer, tTimes.buffer] : [])],
  )
}

async function siteHorizon(m: { id: number; lat: number; lon: number; azStepDeg: number }) {
  const demMax = dem.maxLevel
  const ray = makeRay(demMax, 220, 0.5) // much denser than tiles: this is the site's own panorama
  // the site's own panorama: clamp only at 89.9999 deg (11 m from the pole), not MAX_LAT (89.99, ~300 m),
  // which on Shackleton's rim moved a site at the pole down onto the crater wall
  const lat = Math.max(-SITE_MAX_LAT, Math.min(SITE_MAX_LAT, m.lat))
  const hold: number[] = []
  try {
    await ensureFor(m.lon, lat, m.lon, lat, ray, demMax, hold)
  } catch (err) {
    dem.unpin(hold)
    throw err
  }
  const nAz = Math.round(360 / m.azStepDeg)
  const sA = new Float64Array(nAz), cA = new Float64Array(nAz)
  for (let a = 0; a < nAz; a++) {
    sA[a] = Math.sin((2 * Math.PI * a) / nAz)
    cA[a] = Math.cos((2 * Math.PI * a) / nAz)
  }
  const out = new Float32Array(nAz)
  horizon(m.lon, lat, ray, demMax, out, nAz, sA, cA, true)
  dem.unpin(hold)
  ;(self as unknown as Worker).postMessage({ id: m.id, elevDeg: out, demLevel: demMax }, [out.buffer])
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data
  if (m.type === 'init') {
    dem = new DemSampler(m.cfg)
    hzs = m.hz ? new HorizonSampler(m.hz) : null
  }
  else if (m.type === 'equipot') {
    eq = m.table
    chargeThreshold = m.threshold
  } else if (m.type === 'window') {
    sun = m.sun
    nightSun = m.nightSun
    nightEarth = m.nightEarth ?? new Float32Array(0)
    nightTimes = m.nightTimes
    earth = m.earth
    dsn = m.dsn
    windowStart = m.window[0]
    windowEnd = m.window[1]
    thermalSun = m.thermalSun
    thermalEarth = m.thermalEarth ?? new Float32Array(0)
    thermalDt = m.thermalDt
    thermalCount = m.thermalCount
    thermalTimes = m.thermalTimes
    version = m.version
    sunRMax = 0
    for (let j = 3; j < sun.length; j += 4) sunRMax = Math.max(sunRMax, sun[j])
    let auMin = Infinity
    for (let j = 3; j < thermalSun.length; j += 4) auMin = Math.min(auMin, thermalSun[j])
    thermalRMax = auMin < Infinity ? SUN_RADIUS_1AU_DEG / auMin : 0.3
  } else if (m.type === 'tile') {
    tile(m).catch((err) => (self as unknown as Worker).postMessage({ id: m.id, error: String(err) }))
  } else if (m.type === 'horizon') {
    siteHorizon(m).catch((err) => (self as unknown as Worker).postMessage({ id: m.id, error: String(err) }))
  }
}
