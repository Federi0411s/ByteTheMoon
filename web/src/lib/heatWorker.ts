/// <reference lib="webworker" />
/**
 * Global heatmap worker: per map tile, sunlight / Earth visibility / slope / elevation on an n x n
 * grid of sample points from the global elevation pyramid (lib/dem.ts) and the Sun/Earth ephemeris.
 *
 * Messages (main -> worker):
 *   { type: 'init', cfg: DemConfig }
 *   { type: 'window', version, window, sun, earth, dsn }                            time window and Sun/Earth + DSN sample geometry
 *   { type: 'equipot', table: EquipotTable, threshold }                               charging model (pipeline/equipot_results.csv)
 *   { type: 'window', ..., thermalSun: Float32Array(T2*4), thermalCount: Uint8Array(T2), thermalDt }
 *        regular steps: Sun dir xyz + distance (AU); thermalCount marks the steps that enter the
 *        statistics (the rest are warm-up before each sampled stretch)
 *   { type: 'tile', id, z, x, y, n, demMax, thermal?, landing? }
 *        -> { id, version, nx, ny, sun, earth, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky, landingScore }   (Float32Array ny*nx, row 0 = north, grid from lib/heatGrid.ts;
 *           t* empty unless thermal was requested: the regolith model is the expensive part)
 *   { type: 'horizon', id, lat, lon, azStepDeg }   -> { id, elevDeg: Float32Array, demLevel }       (radians in, degrees out)
 *
 * Sample points include the tile edges (lon = west + i*(east-west)/(n-1)), so neighbouring tiles share
 * their border samples and the bilinearly interpolated heatmap is seamless.
 *
 * Horizon: for each of NAZ (32) azimuths, march outward on the great circle with geometrically growing
 * steps, reading the DEM at a level matched to the step size (fine near the point, coarse far away),
 * and keep the highest elevation angle including the Moon's curvature. Horizons are cached per tile,
 * so a new time window only redoes the (cheap) time integration.
 */
import { DemSampler, demLevelFor, demPixelM } from './dem'
import { heatGrid } from './heatGrid'
import type { EquipotTable } from './equipot'
import { scoreLandingCell } from './landingScore'

const R = 1737400
const R2D = 180 / Math.PI
// map tiles: 32 azimuths x 40 steps is plenty for long-term averages (the selected site's own
// panorama uses a dense 1-degree, 220-step horizon instead)
const NAZ = 32
const STEPS = 40
const MAX_DIST = 200_000
const OBSERVER_H = 2
const MAX_LAT = (89.99 / 180) * Math.PI // the exact pole has no azimuths

let dem: DemSampler
let sun = new Float32Array(0)
let earth = new Float32Array(0)
let dsn = new Float64Array(0)
let version = 0
let windowStart = 0
let windowEnd = 0

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
async function ensureFor(west: number, south: number, east: number, north: number, ray: Ray, extra: number, hold: number[], extraRadiusM = 0) {
  const reach = new Map<number, number>() // level -> max distance at which it is used
  for (let k = 0; k < ray.d.length; k++) reach.set(ray.level[k], Math.max(reach.get(ray.level[k]) ?? 0, ray.d[k]))
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
    const f = (az / 360) * NAZ
    const i0 = f | 0, w = f - i0
    const h = hz[off + i0] * (1 - w) + hz[off + (i0 + 1) % NAZ] * w
    const v = (el - h) / (2 * r) + 0.5
    acc += v <= 0 ? 0 : v >= 1 ? 1 : v
  }
  return acc / T
}

// ---- surface charging (EQUIPOT; same model as lunar_charging.ChargingModel, terrain horizon) ----
const SUN_RADIUS_DEG = 0.27 // as in lunar_charging.py
let eq: EquipotTable | null = null
let chargeThreshold = -100

function interp(x: number, xs: number[], ys: number[]) {
  if (x <= xs[0]) return ys[0]
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1])
  }
  return ys[ys.length - 1]
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
  const f = (az / 360) * NAZ
  const i0 = f | 0, w = f - i0
  return hz[off + i0] * (1 - w) + hz[off + (i0 + 1) % NAZ] * w
}

function hzRange(hz: Float32Array, off: number): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (let a = 0; a < NAZ; a++) {
    const v = hz[off + a]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}

/** Results of sunAndCharging() for one point (reused object: no allocation per sample). */
const sunOut = { frac: NaN, cMean: NaN, cMin: NaN, cBelow: NaN }

/**
 * One pass over the window's Sun positions for a point: the Sun's visible fraction (as
 * visibleFraction) and the EQUIPOT surface charging statistics. Both need the Sun's elevation and,
 * near the horizon, the horizon height toward the Sun, so each is computed once per time step.
 * Same arithmetic as computing them separately (results are identical).
 */
function sunAndCharging(F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number) {
  const T = sun.length / 4
  if (!T) { sunOut.frac = sunOut.cMean = sunOut.cMin = sunOut.cBelow = NaN; return }
  const cosTail = eq ? Math.cos(eq.tailHalfAngleDeg / R2D) : 0
  let acc = 0, sum = 0, min = Infinity, below = 0
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = sun[o], sy = sun[o + 1], sz = sun[o + 2], r = sun[o + 3]
    const el = Math.asin(sx * F.ux + sy * F.uy + sz * F.uz) * R2D
    let h = NaN // horizon height toward the Sun, looked up only when needed
    // visible fraction (partial disc, linear in height)
    if (el - hMax >= r) acc += 1
    else if (!(el - hMin <= -r)) {
      h = horizonToward(hz, off, sx * F.ex + sy * F.ey, sx * F.nx + sy * F.ny + sz * F.nz)
      const v = (el - h) / (2 * r) + 0.5
      acc += v <= 0 ? 0 : v >= 1 ? 1 : v
    }
    if (!eq) continue
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
    const lit = above && cosInc > 0
    let V: number
    if (lit) {
      const inc = Math.acos(Math.min(1, cosInc)) * R2D
      V = inTail ? interp(inc, eq.psAng, eq.psV) : interp(inc, eq.swAng, eq.swV)
    } else if (inTail) V = eq.psEcl
    else V = above ? eq.swEcl : eq.wake // self-shadow vs terrain shadow
    sum += V
    if (V < min) min = V
    if (V < chargeThreshold) below++
  }
  sunOut.frac = acc / T
  if (eq) { sunOut.cMean = sum / T; sunOut.cMin = min; sunOut.cBelow = below / T } else sunOut.cMean = sunOut.cMin = sunOut.cBelow = NaN
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
const cp = (t: number) => CP[0] + t * (CP[1] + t * (CP[2] + t * (CP[3] + t * CP[4])))
const albedo = (incDeg: number) => A0 + A_A * (incDeg / 45) ** 3 + A_B * (incDeg / 90) ** 8

let thermalSun = new Float32Array(0) // per regular step: unit dir xyz + Sun distance (AU)
let thermalCount = new Uint8Array(0) // per step: 1 = counted in the statistics, 0 = warm-up
let thermalDt = 21600
const SPIN_UP_S = 3 * 29.53 * 86400

// work buffers of thermal(), reused for every sample (no allocation per point)
let qBuf = new Float64Array(0)
const Tc = new Float64Array(NZ), Kn = new Float64Array(NZ)
const alpha = new Float64Array(NZ), beta = new Float64Array(NZ), G = new Float64Array(NZ - 1), C = new Float64Array(NZ)

function thermal(F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number): [number, number, number] {
  const T = thermalSun.length / 4
  if (!T) return [NaN, NaN, NaN]
  const r = SUN_RADIUS_DEG
  // absorbed flux per step (partial disc above the terrain horizon, incidence on the local slope)
  if (qBuf.length < T) qBuf = new Float64Array(T)
  const Q = qBuf
  Q.fill(0, 0, T)
  let qMean = 0
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = thermalSun[o], sy = thermalSun[o + 1], sz = thermalSun[o + 2], au = thermalSun[o + 3]
    const cosInc = sx * F.mx + sy * F.my + sz * F.mz
    if (cosInc <= 0) continue
    const el = Math.asin(sx * F.ux + sy * F.uy + sz * F.uz) * R2D
    let vis: number
    if (el - hMax >= r) vis = 1
    else if (el - hMin <= -r) vis = 0
    else {
      const v = (el - horizonToward(hz, off, sx * F.ex + sy * F.ey, sx * F.nx + sy * F.ny + sz * F.nz)) / (2 * r) + 0.5
      vis = v <= 0 ? 0 : v >= 1 ? 1 : v
    }
    if (!vis) continue
    const inc = Math.acos(Math.min(1, cosInc)) * R2D
    Q[j] = (1 - albedo(inc)) * (S0 / (au * au)) * cosInc * vis
    qMean += Q[j] / T
  }
  // start near the long-term mean temperature (~0.74 x the mean-flux radiative equilibrium)
  Tc.fill(Math.max(30, 0.74 * Math.pow(qMean / (EPS * SIGMA), 0.25)))
  const spin = Math.ceil(SPIN_UP_S / thermalDt)
  let sum = 0, min = Infinity, max = -Infinity, n = 0
  for (let s = -spin; s < T; s++) {
    const q = Q[((s % T) + T) % T] // initial spin-up cycles through the start of the series
    const h = thermalDt
    for (let i = 0; i < NZ; i++) {
      C[i] = (RHO[i] * cp(Tc[i]) * VOL[i]) / h
      Kn[i] = KC[i] * (1 + CHI * (Tc[i] / 350) ** 3) // conductivity of node i (once per step)
    }
    for (let i = 0; i < NZ - 1; i++) G[i] = (0.5 * (Kn[i] + Kn[i + 1])) / DZ[i]
    // bottom-up elimination: T'[i] = alpha[i] + beta[i] * T'[i-1]
    let D = C[NZ - 1] + G[NZ - 2]
    alpha[NZ - 1] = (C[NZ - 1] * Tc[NZ - 1] + Q_GEO) / D
    beta[NZ - 1] = G[NZ - 2] / D
    for (let i = NZ - 2; i >= 1; i--) {
      D = C[i] + G[i - 1] + G[i] - G[i] * beta[i + 1]
      alpha[i] = (C[i] * Tc[i] + G[i] * alpha[i + 1]) / D
      beta[i] = G[i - 1] / D
    }
    // surface: C0 (T0' - T0) = q - eps sigma T0'^4 - G0 (T0' - alpha1 - beta1 T0')  -> Newton from above
    const a1 = alpha[1], b1 = beta[1], c0 = C[0], g0 = G[0]
    const lin = c0 + g0 * (1 - b1), rhs = q + c0 * Tc[0] + g0 * a1
    let t0 = Math.max(Tc[0], Math.pow(Math.max(rhs, 0) / (EPS * SIGMA), 0.25))
    for (let it = 0; it < 30; it++) {
      const f = EPS * SIGMA * t0 ** 4 + lin * t0 - rhs
      const d = f / (4 * EPS * SIGMA * t0 ** 3 + lin)
      t0 -= d
      if (Math.abs(d) < 1e-3) break
    }
    Tc[0] = Math.max(t0, 2)
    for (let i = 1; i < NZ; i++) Tc[i] = alpha[i] + beta[i] * Tc[i - 1]
    if (s >= 0 && thermalCount[s]) {
      const v = Tc[0]
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

/** Rectangle of tile group x (g tiles wide, see heatGrid.tileGroup) in row y of level z. */
function tileRect(z: number, x: number, y: number, g = 1) {
  const step = Math.PI / 2 ** z
  const west = -Math.PI + x * g * step, north = Math.PI / 2 - y * step
  return { west, south: north - step, east: west + g * step, north }
}

async function terrain(z: number, x: number, y: number, n: number, demMax: number, g = 1, footprintRadiusM = 0): Promise<Terrain> {
  const key = `${z}/${x}/${y}/${n}/${demMax}/${g}/${footprintRadiusM}`
  const hit = hzCache.get(key)
  if (hit) return hit
  const { west, south, east, north } = tileRect(z, x, y, g)
  const ray = makeRay(demMax)
  // slope/elevation at the sample spacing (coarse tiles -> coarse, honest slopes)
  const { ny } = heatGrid(z, y, n, g)
  const spacing = ((north - south) * R) / (ny - 1)
  const zs = demLevelFor(spacing, demMax)
  const hold: number[] = []
  try {
    await ensureFor(west, south, east, north, ray, zs, hold, footprintRadiusM)
    return computeTerrain(key, west, south, east, north, heatGrid(z, y, n, g), demMax, ray, zs)
  } finally {
    dem.unpin(hold)
  }
}

function computeTerrain(key: string, west: number, south: number, east: number, north: number, g: { nx: number; ny: number }, demMax: number, ray: Ray, zs: number): Terrain {
  const { nx, ny } = g, N = nx * ny
  const hz = new Float32Array(N * NAZ)
  const slope = new Float32Array(N), elev = new Float32Array(N)
  const gE = new Float32Array(N), gN = new Float32Array(N)
  const tmp = new Float32Array(NAZ)
  const ds = demPixelM(zs)
  for (let j = 0; j < ny; j++) {
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, north - (j * (north - south)) / (ny - 1)))
    for (let i = 0; i < nx; i++) {
      const lon = west + (i * (east - west)) / (nx - 1)
      const c = j * nx + i
      horizon(lon, lat, ray, demMax, tmp)
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

function stationLinkStats(F: Frame, hz: Float32Array, off: number, siteHeight: number): [number, number] {
  const T = earth.length / 4
  if (!T || dsn.length < T * 18) return [NaN, NaN]
  const siteX = F.ux * (R + siteHeight), siteY = F.uy * (R + siteHeight), siteZ = F.uz * (R + siteHeight)
  const stepH = (windowEnd - windowStart) / T / 3600_000
  let linked = 0, gap = 0, longest = 0
  for (let j = 0; j < T; j++) {
    let any = false
    const base = j * 18
    for (let station = 0; station < 3 && !any; station++) {
      const o = base + station * 6
      const dx = dsn[o] - siteX, dy = dsn[o + 1] - siteY, dz = dsn[o + 2] - siteZ
      const dist = Math.hypot(dx, dy, dz)
      const el = Math.asin((dx * F.ux + dy * F.uy + dz * F.uz) / dist) * R2D
      let az = Math.atan2(dx * F.ex + dy * F.ey, dx * F.nx + dy * F.ny + dz * F.nz) * R2D
      if (az < 0) az += 360
      const h = horizonToward(hz, off, Math.sin(az / R2D), Math.cos(az / R2D))
      const stationEl = Math.asin(((siteX - dsn[o]) * dsn[o + 3] + (siteY - dsn[o + 1]) * dsn[o + 4] + (siteZ - dsn[o + 2]) * dsn[o + 5]) / dist) * R2D
      any = el >= h && stationEl >= 0
    }
    if (any) { linked++; gap = 0 } else gap++
    longest = Math.max(longest, gap)
  }
  return [(100 * linked) / T, longest * stepH]
}

function discOverlap(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0
  if (d <= Math.abs(r2 - r1)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1)
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1))
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
  const k = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))
  return (a1 + a2 - k) / (Math.PI * r1 * r1)
}

const powerValues = new Float64Array(3000)
function powerStats(F: Frame, hz: Float32Array, off: number, hMin: number, hMax: number, siteHeight: number, panelMode: 'tracking' | 'fixed'): [number, number] {
  const T = sun.length / 4
  if (!T) return [NaN, NaN]
  const siteX = F.ux * (R + siteHeight), siteY = F.uy * (R + siteHeight), siteZ = F.uz * (R + siteHeight)
  let peak = 0
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = sun[o], sy = sun[o + 1], sz = sun[o + 2], sunRadius = sun[o + 3] / R2D
    const earthRadius = earth[o + 3] / R2D
    const sunDist = 695700_000 / Math.sin(sunRadius)
    const earthDist = 6371_000 / Math.sin(earthRadius)
    const svx = sx * sunDist - siteX, svy = sy * sunDist - siteY, svz = sz * sunDist - siteZ
    const ex = earth[o] * earthDist - siteX, ey = earth[o + 1] * earthDist - siteY, ez = earth[o + 2] * earthDist - siteZ
    const sd = Math.hypot(svx, svy, svz), ed = Math.hypot(ex, ey, ez)
    const sunX = svx / sd, sunY = svy / sd, sunZ = svz / sd
    const el = Math.asin(sunX * F.ux + sunY * F.uy + sunZ * F.uz)
    const elDeg = el * R2D
    const east = sunX * F.ex + sunY * F.ey
    const north = sunX * F.nx + sunY * F.ny + sunZ * F.nz
    let terrain = 0
    if (elDeg - hMax >= sun[o + 3]) terrain = 1
    else if (!(elDeg - hMin <= -sun[o + 3])) {
      const v = (elDeg - horizonToward(hz, off, east, north)) / (2 * sun[o + 3]) + 0.5
      terrain = v <= 0 ? 0 : v >= 1 ? 1 : v
    }
    const incidence = panelMode === 'tracking' ? 1 : Math.max(0, Math.sin(el))
    const sep = Math.acos(Math.min(1, Math.max(-1, (svx * ex + svy * ey + svz * ez) / (sd * ed))))
    const eclipse = discOverlap(sunRadius, earthRadius, sep)
    const relativePower = terrain * (1 - eclipse) * incidence * Math.sin(sunRadius) ** 2
    powerValues[j] = relativePower
    peak = Math.max(peak, relativePower)
  }
  const on = peak * 0.01
  const stepH = (windowEnd - windowStart) / T / 3600_000
  let producing = 0, gap = 0, longest = 0
  for (let j = 0; j < T; j++) {
    if (powerValues[j] > on && peak > 0) { producing++; gap = 0 } else gap++
    longest = Math.max(longest, gap)
  }
  return [(100 * producing) / T, longest * stepH]
}

async function tile(m: {
  id: number; z: number; x: number; y: number; n: number; demMax: number; thermal?: boolean; g?: number
  landing?: { footprint: [number, number, number]; panelMode: 'tracking' | 'fixed'; gcr: number }
}) {
  const demMax = Math.min(m.demMax, dem.maxLevel)
  const g = m.g ?? 1
  const footprintRadiusM = m.landing ? Math.max(m.landing.footprint[0], m.landing.footprint[1]) : 0
  const t = await terrain(m.z, m.x, m.y, m.n, demMax, g, footprintRadiusM)
  const { west, south, east, north } = tileRect(m.z, m.x, m.y, g)
  const { nx, ny } = heatGrid(m.z, m.y, m.n, g), N = nx * ny
  const s = new Float32Array(N), e = new Float32Array(N)
  const cMean = new Float32Array(N), cMin = new Float32Array(N), cBelow = new Float32Array(N)
  const tMean = new Float32Array(m.thermal ? N : 0), tMin = new Float32Array(m.thermal ? N : 0), tMax = new Float32Array(m.thermal ? N : 0)
  const fSky = new Float32Array(N) // visible-sky fraction, as pipeline/lunar_radiation.py: mean(1 - sin H) / 2
  const landingScore = new Float32Array(m.landing ? N : 0)
  const slope = t.slope.slice()
  for (let j = 0; j < ny; j++) {
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, north - (j * (north - south)) / (ny - 1)))
    for (let i = 0; i < nx; i++) {
      const lon = west + (i * (east - west)) / (nx - 1)
      const c = j * nx + i
      if (t.hz[c * NAZ] !== t.hz[c * NAZ]) { // no elevation here (see horizon): leave the point transparent
        s[c] = e[c] = cMean[c] = cMin[c] = cBelow[c] = fSky[c] = NaN
        if (m.thermal) tMean[c] = tMin[c] = tMax[c] = NaN
        if (m.landing) landingScore[c] = slope[c] = NaN
        continue
      }
      const off = c * NAZ
      const F = frame(lon, lat, t.gE[c], t.gN[c])
      const [hMin, hMax] = hzRange(t.hz, off)
      sunAndCharging(F, t.hz, off, hMin, hMax)
      s[c] = sunOut.frac
      cMean[c] = sunOut.cMean
      cMin[c] = sunOut.cMin
      cBelow[c] = sunOut.cBelow
      e[c] = visibleFraction(earth, F, t.hz, off, hMin, hMax)
      let sky = 0
      for (let a = 0; a < NAZ; a++) sky += 1 - Math.sin(t.hz[c * NAZ + a] / R2D)
      fSky[c] = sky / NAZ / 2
      if (m.thermal) [tMean[c], tMin[c], tMax[c]] = thermal(F, t.hz, off, hMin, hMax)
      if (m.landing && m.thermal) {
        const maxSlope = maxFootprintSlope(lon, lat, t.slope[c], t.slopeLevel, m.landing.footprint)
        const [linkPct, longestLinkGapH] = stationLinkStats(F, t.hz, off, t.elev[c])
        const [producingPct, longestPowerOutageH] = powerStats(F, t.hz, off, hMin, hMax, t.elev[c], m.landing.panelMode)
        const doseRate = (20.2 * fSky[c] + 6.2 * (1 - fSky[c])) * m.landing.gcr
        const values = [tMean[c], tMin[c], tMax[c], doseRate, linkPct, longestLinkGapH, producingPct, longestPowerOutageH, maxSlope]
        if (values.every(Number.isFinite)) {
          landingScore[c] = scoreLandingCell({
            tMeanC: tMean[c] - 273.15,
            doseRateUGyH: doseRate,
            periodHours: (windowEnd - windowStart) / 3600_000,
            maxSlopeDeg: maxSlope,
            linkPct,
            longestLinkGapH,
            producingPct,
            longestPowerOutageH,
          })
          slope[c] = maxSlope
        } else {
          landingScore[c] = slope[c] = NaN
        }
      } else if (m.landing) {
        landingScore[c] = slope[c] = NaN
      }
    }
  }
  const elev = t.elev.slice()
  const arrays = [s, e, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky, landingScore]
  ;(self as unknown as Worker).postMessage(
    { id: m.id, version, nx, ny, sun: s, earth: e, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky, landingScore, thermal: !!m.thermal },
    arrays.map((a) => a.buffer),
  )
}

async function siteHorizon(m: { id: number; lat: number; lon: number; azStepDeg: number }) {
  const demMax = dem.maxLevel
  const ray = makeRay(demMax, 220, 0.5) // much denser than tiles: this is the site's own panorama
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, m.lat))
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
  if (m.type === 'init') dem = new DemSampler(m.cfg)
  else if (m.type === 'equipot') {
    eq = m.table
    chargeThreshold = m.threshold
  } else if (m.type === 'window') {
    sun = m.sun
    earth = m.earth
    dsn = m.dsn
    windowStart = m.window[0]
    windowEnd = m.window[1]
    thermalSun = m.thermalSun
    thermalDt = m.thermalDt
    thermalCount = m.thermalCount
    version = m.version
  } else if (m.type === 'tile') {
    tile(m).catch((err) => (self as unknown as Worker).postMessage({ id: m.id, error: String(err) }))
  } else if (m.type === 'horizon') {
    siteHorizon(m).catch((err) => (self as unknown as Worker).postMessage({ id: m.id, error: String(err) }))
  }
}
