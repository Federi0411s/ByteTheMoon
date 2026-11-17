/**
 * Hour-by-hour regolith surface temperature at one site, for the crew-walk check.
 *
 * Same Hayne et al. 2017 1D model, constants and numerical scheme as the global heatmaps
 * (lib/heatWorker.ts `thermal()`, itself from pipeline/lunar_thermal.py): implicit conduction with
 * temperature-dependent conductivity and heat capacity, exact surface radiation balance (Newton), spin-up
 * of 3 lunations through the start of the series. The worker only returns mean/min/max per map pixel;
 * here the full time series is kept so walks can be checked against the suit limits hour by hour.
 * The surface is tilted by the local terrain gradient from the elevation raster when one covers the site
 * (as the heatmaps do with the DEM slope); otherwise it is flat. The site's own horizon mask gives the shadows,
 * and solar eclipses (the Earth in front of the Sun, lib/eclipse.ts) dim the Sun as everywhere else.
 */
import { sunVisibleOver, type HorizonMask } from './analysis'
import { MOON_RADIUS_M, type RasterField } from './raster'
import { SUN_RADIUS_KM, earthPosition, sunPosition, topoFrame, type Ephemeris } from './ephemeris'
import { eclipseCoverFrom } from './eclipse'

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
const SPIN_UP_S = 3 * 29.53 * 86400
const AU_M = 149_597_870_700
const R2D = 180 / Math.PI

/** Surface temperature (K) for a series of absorbed fluxes Q (W/m²) on a regular step dtS. */
export function surfaceTemperature(Q: Float64Array, dtS: number): Float64Array {
  const T = Q.length
  const out = new Float64Array(T)
  if (!T) return out
  let qMean = 0
  for (let j = 0; j < T; j++) qMean += Q[j] / T
  const Tc = new Float64Array(NZ).fill(Math.max(30, 0.74 * Math.pow(qMean / (EPS * SIGMA), 0.25)))
  const alpha = new Float64Array(NZ), beta = new Float64Array(NZ), G = new Float64Array(NZ - 1), C = new Float64Array(NZ)
  const spin = Math.ceil(SPIN_UP_S / dtS)
  for (let s = -spin; s < T; s++) {
    const q = Q[((s % T) + T) % T]
    for (let i = 0; i < NZ; i++) C[i] = (RHO[i] * cp(Tc[i]) * VOL[i]) / dtS
    for (let i = 0; i < NZ - 1; i++) {
      const ka = KC[i] * (1 + CHI * (Tc[i] / 350) ** 3), kb = KC[i + 1] * (1 + CHI * (Tc[i + 1] / 350) ** 3)
      G[i] = (0.5 * (ka + kb)) / DZ[i]
    }
    let D = C[NZ - 1] + G[NZ - 2]
    alpha[NZ - 1] = (C[NZ - 1] * Tc[NZ - 1] + Q_GEO) / D
    beta[NZ - 1] = G[NZ - 2] / D
    for (let i = NZ - 2; i >= 1; i--) {
      D = C[i] + G[i - 1] + G[i] - G[i] * beta[i + 1]
      alpha[i] = (C[i] * Tc[i] + G[i] * alpha[i + 1]) / D
      beta[i] = G[i - 1] / D
    }
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
    if (s >= 0) out[s] = Tc[0]
  }
  return out
}

export interface SiteThermalSeries {
  stepH: number
  /** 1 where the Sun is (mostly) above the terrain horizon */
  sunlit: Uint8Array
  /** share of the Sun's light above the terrain horizon per step (0..1, lib/sunDisc.ts): light-weighted sunlit % */
  light: Float32Array
  /** surface temperature, °C */
  tC: Float64Array
}

/** Hourly (or stepMs) sunlight + surface temperature at a site over [start, end]. */
export function siteThermalSeries(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, mask: HorizonMask | undefined,
  start: number, end: number, stepMs: number, dem?: RasterField): SiteThermalSeries {
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  // surface normal: local level tilted by the terrain gradient (central differences on the DEM, ~2 px)
  let nrm = topo.up
  if (dem) {
    const d = 2 * dem.meta.resolutionM, lat = site.lat / R2D, lon = site.lon / R2D
    const dLat = d / MOON_RADIUS_M, dLon = dLat / Math.max(Math.cos(lat), 1e-6)
    const hE = dem.sample(lon + dLon, lat), hW = dem.sample(lon - dLon, lat), hN = dem.sample(lon, lat + dLat), hS = dem.sample(lon, lat - dLat)
    if (Number.isFinite(hE + hW + hN + hS)) {
      const gE = (hE - hW) / (2 * d), gN = (hN - hS) / (2 * d)
      const v = [0, 1, 2].map((k) => topo.up[k] - gE * topo.east[k] - gN * topo.north[k])
      const L = Math.hypot(v[0], v[1], v[2])
      nrm = [v[0] / L, v[1] / L, v[2] / L]
    }
  }
  const n = Math.max(1, Math.floor((end - start) / stepMs) + 1)
  const Q = new Float64Array(n), sunlit = new Uint8Array(n), light = new Float32Array(n)
  for (let j = 0; j < n; j++) {
    const t = start + j * stepMs
    const p = sunPosition(eph, t)
    const v = [p[0] - topo.pos[0], p[1] - topo.pos[1], p[2] - topo.pos[2]]
    const d = Math.hypot(v[0], v[1], v[2])
    const el = Math.asin(Math.max(-1, Math.min(1, (v[0] * topo.up[0] + v[1] * topo.up[1] + v[2] * topo.up[2]) / d))) * R2D
    const cosInc = (v[0] * nrm[0] + v[1] * nrm[1] + v[2] * nrm[2]) / d // incidence on the (tilted) surface
    let az = Math.atan2((v[0] * topo.east[0] + v[1] * topo.east[1] + v[2] * topo.east[2]) / d,
      (v[0] * topo.north[0] + v[1] * topo.north[1] + v[2] * topo.north[2]) / d) * R2D
    if (az < 0) az += 360
    // share of the Sun's light above the terrain horizon (same disc model as the worker: lib/sunDisc.ts)
    let vis = sunVisibleOver(mask, az, el, Math.asin((SUN_RADIUS_KM * 1000) / d) * R2D)
    // solar eclipse: the Earth hides part of the Sun (as the timeline, power and the heatmaps)
    if (vis > 0) vis *= 1 - eclipseCoverFrom(p, earthPosition(eph, t), topo.pos)
    sunlit[j] = vis > 0.5 ? 1 : 0
    light[j] = vis
    if (cosInc <= 0 || !vis) continue
    const au = d / AU_M
    Q[j] = (1 - albedo(Math.acos(Math.min(1, cosInc)) * R2D)) * (S0 / (au * au)) * cosInc * vis
  }
  const tK = surfaceTemperature(Q, stepMs / 1000)
  return { stepH: stepMs / 3600_000, sunlit, light, tC: tK.map((k) => k - 273.15) }
}
