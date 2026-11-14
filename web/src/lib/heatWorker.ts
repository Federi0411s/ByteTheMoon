/// <reference lib="webworker" />
/**
 * Global heatmap worker: per map tile, sunlight / Earth visibility / slope / elevation on an n x n
 * grid of sample points from the global elevation pyramid (lib/dem.ts) and the Sun/Earth ephemeris.
 *
 * Messages (main -> worker):
 *   { type: 'init', cfg: DemConfig }
 *   { type: 'window', version, sun: Float32Array(T*4), earth: Float32Array(T*4) }   unit dir xyz (Moon-fixed) + angular radius (deg)
 *   { type: 'equipot', table: EquipotTable, threshold }                               charging model (pipeline/equipot_results.csv)
 *   { type: 'window', ..., thermalSun: Float32Array(T2*4), thermalCount: Uint8Array(T2), thermalDt }
 *        regular steps: Sun dir xyz + distance (AU); thermalCount marks the steps that enter the
 *        statistics (the rest are warm-up before each sampled stretch)
 *   { type: 'tile', id, z, x, y, n, demMax, thermal? }
 *        -> { id, version, n, sun, earth, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky }   (Float32Array n*n, row 0 = north;
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

let dem: DemSampler
let sun = new Float32Array(0)
let earth = new Float32Array(0)
let version = 0

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
async function ensureFor(west: number, south: number, east: number, north: number, ray: Ray, extra: number) {
  const reach = new Map<number, number>() // level -> max distance at which it is used
  for (let k = 0; k < ray.d.length; k++) reach.set(ray.level[k], Math.max(reach.get(ray.level[k]) ?? 0, ray.d[k]))
  reach.set(extra, Math.max(reach.get(extra) ?? 0, demPixelM(extra) * 2))
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
      ? dem.ensureBox(z, -Math.PI, s, Math.PI, n)
      : dem.ensureBox(z, west - dLon, s, east + dLon, n))
  }
  await Promise.all(jobs)
}

/** Horizon elevation (deg) per azimuth for one point. */
function horizon(lon0: number, lat0: number, ray: Ray, demMax: number, out: Float32Array, nAz = NAZ, sA = sinAz, cA = cosAz) {
  const sinP = Math.sin(lat0), cosP = Math.cos(lat0)
  const h0 = dem.sample(lon0, lat0, demMax)
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

/** Fraction of the time window the body is above the horizon (partial disc, linear in height). */
function visibleFraction(body: Float32Array, lon: number, lat: number, hz: Float32Array, off: number): number {
  const T = body.length / 4
  if (!T) return NaN
  const cl = Math.cos(lat), sl = Math.sin(lat), co = Math.cos(lon), so = Math.sin(lon)
  const ux = cl * co, uy = cl * so, uz = sl // up
  const ex = -so, ey = co // east (z = 0)
  const nx = -sl * co, ny = -sl * so, nz = cl // north
  let hMin = Infinity, hMax = -Infinity
  for (let a = 0; a < NAZ; a++) {
    const v = hz[off + a]
    if (v < hMin) hMin = v
    if (v > hMax) hMax = v
  }
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

/** Local frame + surface normal (from the terrain gradient, as in pipeline/charging.terrain_geometry). */
function frame(lon: number, lat: number, gE: number, gN: number) {
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

function charging(lon: number, lat: number, hz: Float32Array, off: number, gE: number, gN: number): [number, number, number] {
  const T = sun.length / 4
  if (!T || !eq) return [NaN, NaN, NaN]
  const F = frame(lon, lat, gE, gN)
  const [hMin, hMax] = hzRange(hz, off)
  const cosTail = Math.cos(eq.tailHalfAngleDeg / R2D)
  let sum = 0, min = Infinity, below = 0
  for (let j = 0; j < T; j++) {
    const o = j * 4
    const sx = sun[o], sy = sun[o + 1], sz = sun[o + 2]
    const inTail = sx * earth[o] + sy * earth[o + 1] + sz * earth[o + 2] > cosTail
    const el = Math.asin(sx * F.ux + sy * F.uy + sz * F.uz) * R2D
    let above: boolean
    if (el > hMax - SUN_RADIUS_DEG) above = true
    else if (el <= hMin - SUN_RADIUS_DEG) above = false
    else above = el > horizonToward(hz, off, sx * F.ex + sy * F.ey, sx * F.nx + sy * F.ny + sz * F.nz) - SUN_RADIUS_DEG
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
  return [sum / T, min, below / T]
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

function thermal(lon: number, lat: number, hz: Float32Array, off: number, gE: number, gN: number): [number, number, number] {
  const T = thermalSun.length / 4
  if (!T) return [NaN, NaN, NaN]
  const F = frame(lon, lat, gE, gN)
  const [hMin, hMax] = hzRange(hz, off)
  const r = SUN_RADIUS_DEG
  // absorbed flux per step (partial disc above the terrain horizon, incidence on the local slope)
  const Q = new Float64Array(T)
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
  const Tc = new Float64Array(NZ).fill(Math.max(30, 0.74 * Math.pow(qMean / (EPS * SIGMA), 0.25)))
  const alpha = new Float64Array(NZ), beta = new Float64Array(NZ), G = new Float64Array(NZ - 1), C = new Float64Array(NZ)
  const spin = Math.ceil(SPIN_UP_S / thermalDt)
  let sum = 0, min = Infinity, max = -Infinity, n = 0
  for (let s = -spin; s < T; s++) {
    const q = Q[((s % T) + T) % T] // initial spin-up cycles through the start of the series
    const h = thermalDt
    for (let i = 0; i < NZ; i++) C[i] = (RHO[i] * cp(Tc[i]) * VOL[i]) / h
    for (let i = 0; i < NZ - 1; i++) {
      const ka = KC[i] * (1 + CHI * (Tc[i] / 350) ** 3), kb = KC[i + 1] * (1 + CHI * (Tc[i + 1] / 350) ** 3)
      G[i] = (0.5 * (ka + kb)) / DZ[i]
    }
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
interface Terrain { hz: Float32Array; slope: Float32Array; elev: Float32Array; gE: Float32Array; gN: Float32Array }
const hzCache = new Map<string, Terrain>()
const hzOrder: string[] = []
const HZ_CACHE = 80 // per worker; a 33 x 33 tile's horizons are ~140 KB

function tileRect(z: number, x: number, y: number) {
  const step = Math.PI / 2 ** z
  const west = -Math.PI + x * step, north = Math.PI / 2 - y * step
  return { west, south: north - step, east: west + step, north }
}

async function terrain(z: number, x: number, y: number, n: number, demMax: number): Promise<Terrain> {
  const key = `${z}/${x}/${y}/${n}/${demMax}`
  const hit = hzCache.get(key)
  if (hit) return hit
  const { west, south, east, north } = tileRect(z, x, y)
  const ray = makeRay(demMax)
  // slope/elevation at the sample spacing (coarse tiles -> coarse, honest slopes)
  const spacing = ((north - south) * R) / (n - 1)
  const zs = demLevelFor(spacing, demMax)
  await ensureFor(west, south, east, north, ray, zs)

  const hz = new Float32Array(n * n * NAZ)
  const slope = new Float32Array(n * n), elev = new Float32Array(n * n)
  const gE = new Float32Array(n * n), gN = new Float32Array(n * n)
  const tmp = new Float32Array(NAZ)
  const ds = demPixelM(zs)
  for (let j = 0; j < n; j++) {
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, north - (j * (north - south)) / (n - 1)))
    for (let i = 0; i < n; i++) {
      const lon = west + (i * (east - west)) / (n - 1)
      const c = j * n + i
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
  const out = { hz, slope, elev, gE, gN }
  hzCache.set(key, out)
  hzOrder.push(key)
  while (hzOrder.length > HZ_CACHE) hzCache.delete(hzOrder.shift()!)
  return out
}

async function tile(m: { id: number; z: number; x: number; y: number; n: number; demMax: number; thermal?: boolean }) {
  const demMax = Math.min(m.demMax, dem.maxLevel)
  const t = await terrain(m.z, m.x, m.y, m.n, demMax)
  const { west, south, east, north } = tileRect(m.z, m.x, m.y)
  const n = m.n, N = n * n
  const s = new Float32Array(N), e = new Float32Array(N)
  const cMean = new Float32Array(N), cMin = new Float32Array(N), cBelow = new Float32Array(N)
  const tMean = new Float32Array(m.thermal ? N : 0), tMin = new Float32Array(m.thermal ? N : 0), tMax = new Float32Array(m.thermal ? N : 0)
  const fSky = new Float32Array(N) // visible-sky fraction, as pipeline/lunar_radiation.py: mean(1 - sin H) / 2
  for (let j = 0; j < n; j++) {
    const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, north - (j * (north - south)) / (n - 1)))
    for (let i = 0; i < n; i++) {
      const lon = west + (i * (east - west)) / (n - 1)
      const c = j * n + i
      s[c] = visibleFraction(sun, lon, lat, t.hz, c * NAZ)
      e[c] = visibleFraction(earth, lon, lat, t.hz, c * NAZ)
      ;[cMean[c], cMin[c], cBelow[c]] = charging(lon, lat, t.hz, c * NAZ, t.gE[c], t.gN[c])
      let sky = 0
      for (let a = 0; a < NAZ; a++) sky += 1 - Math.sin(t.hz[c * NAZ + a] / R2D)
      fSky[c] = sky / NAZ / 2
      if (m.thermal) [tMean[c], tMin[c], tMax[c]] = thermal(lon, lat, t.hz, c * NAZ, t.gE[c], t.gN[c])
    }
  }
  const slope = t.slope.slice(), elev = t.elev.slice()
  const arrays = [s, e, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky]
  ;(self as unknown as Worker).postMessage(
    { id: m.id, version, n, sun: s, earth: e, slope, elev, cMean, cMin, cBelow, tMean, tMin, tMax, fSky, thermal: !!m.thermal },
    arrays.map((a) => a.buffer),
  )
}

async function siteHorizon(m: { id: number; lat: number; lon: number; azStepDeg: number }) {
  const demMax = dem.maxLevel
  const ray = makeRay(demMax, 220, 0.5) // much denser than tiles: this is the site's own panorama
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, m.lat))
  await ensureFor(m.lon, lat, m.lon, lat, ray, demMax)
  const nAz = Math.round(360 / m.azStepDeg)
  const sA = new Float64Array(nAz), cA = new Float64Array(nAz)
  for (let a = 0; a < nAz; a++) {
    sA[a] = Math.sin((2 * Math.PI * a) / nAz)
    cA[a] = Math.cos((2 * Math.PI * a) / nAz)
  }
  const out = new Float32Array(nAz)
  horizon(m.lon, lat, ray, demMax, out, nAz, sA, cA)
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
