/**
 * Direct-to-Earth link with NASA's Deep Space Network: Goldstone (DSS-14), Madrid (DSS-63), Canberra (DSS-43).
 *
 * A station is "in link" when station and site are in mutual line of sight: the station is above the
 * site's TERRAIN horizon in its exact direction (crater rims, massifs and ridges from the LOLA horizon
 * mask block it) AND the Moon is above the station's own horizon (the antenna can point anywhere above
 * it; no minimum-elevation mask). The station position (not just the Earth's centre: ~1° of parallax)
 * is used.
 *
 * Geometry, all in the browser:
 *  - Earth centre seen from the Moon (MOON_ME frame): the SPICE ephemeris already shipped (ephemeris.json);
 *  - Moon-fixed <-> ICRF: IAU/WGCCRE rotation model of the Moon (approximates the ME frame to ~0.005°);
 *  - Earth-fixed <-> ICRF: GMST (IAU 1982) + IAU 1976 precession (nutation ≤ 0.005° and polar motion ignored);
 *  - stations: WGS84 geodetic coordinates.
 * Resulting pointing accuracy ~0.01°, far below the terrain-mask uncertainty.
 */
import { horizonAt, type HorizonMask } from './analysis'
import { azEl, earthPosition, topoFrame, type Ephemeris, type Vec3 } from './ephemeris'

const D2R = Math.PI / 180
const AS2R = D2R / 3600
const TT_MINUS_UTC_S = 69.184 // 37 leap s + 32.184 s (valid since 2017)

export interface Station {
  id: string
  name: string
  antenna: string
  latDeg: number
  lonDeg: number
  heightM: number
  color: string
}

export const DSN_STATIONS: Station[] = [
  { id: 'gds', name: 'Goldstone', antenna: 'DSS-14 (70 m)', latDeg: 35.42590, lonDeg: -116.88950, heightM: 1002, color: '#ff9f43' },
  { id: 'mad', name: 'Madrid', antenna: 'DSS-63 (70 m)', latDeg: 40.43121, lonDeg: -4.24801, heightM: 865, color: '#54a0ff' },
  { id: 'cbr', name: 'Canberra', antenna: 'DSS-43 (70 m)', latDeg: -35.40242, lonDeg: 148.98127, heightM: 689, color: '#1dd1a1' },
]

// ---------- small vector / rotation helpers ----------
type M3 = [number, number, number, number, number, number, number, number, number] // row-major

const rx = (a: number): M3 => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c] }
const ry = (a: number): M3 => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c] }
const rz = (a: number): M3 => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1] }
const mul = (a: M3, b: M3): M3 => {
  const o = new Array(9) as M3
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return o
}
const tr = (a: M3): M3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]
const apply = (m: M3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0) - TT_MINUS_UTC_S * 1000 // J2000.0 = 2000-01-01 12:00 TT

/** Moon-fixed (≈ME) -> ICRF rotation, IAU/WGCCRE 2009 model. */
export function moonFixedToIcrf(tMs: number): M3 {
  const d = (tMs + TT_MINUS_UTC_S * 1000 - Date.UTC(2000, 0, 1, 12)) / 86400_000 // TDB≈TT days from J2000
  const T = d / 36525
  const E = [0,
    125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.064993 * d, 276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d].map((x) => x * D2R)
  const s = (k: number) => Math.sin(E[k]), c = (k: number) => Math.cos(E[k])
  const a0 = 269.9949 + 0.0031 * T - 3.8787 * s(1) - 0.1204 * s(2) + 0.07 * s(3) - 0.0172 * s(4) + 0.0072 * s(6) - 0.0052 * s(10) + 0.0043 * s(13)
  const d0 = 66.5392 + 0.013 * T + 1.5419 * c(1) + 0.0239 * c(2) - 0.0278 * c(3) + 0.0068 * c(4) - 0.0029 * c(6) + 0.0009 * c(7) + 0.0008 * c(10) - 0.0009 * c(13)
  const W = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.561 * s(1) + 0.1208 * s(2) - 0.0642 * s(3) + 0.0158 * s(4) + 0.0252 * s(5)
    - 0.0066 * s(6) - 0.0047 * s(7) - 0.0046 * s(8) + 0.0028 * s(9) + 0.0052 * s(10) + 0.004 * s(11) + 0.0019 * s(12) - 0.0044 * s(13)
  // r_fixed = Rz(W) Rx(90-δ0) Rz(90+α0) r_icrf
  return tr(mul(rz(W * D2R), mul(rx((90 - d0) * D2R), rz((90 + a0) * D2R))))
}

/** Earth-fixed (ITRF, approx.) -> ICRF rotation: GMST + IAU 1976 precession. */
export function earthFixedToIcrf(tMs: number): M3 {
  const Tu = (tMs - Date.UTC(2000, 0, 1, 12)) / 86400_000 / 36525 // UT1≈UTC centuries
  let gmstS = 67310.54841 + (876600 * 3600 + 8640184.812866) * Tu + 0.093104 * Tu * Tu - 6.2e-6 * Tu ** 3
  gmstS = ((gmstS % 86400) + 86400) % 86400
  const gmst = (gmstS / 86400) * 2 * Math.PI
  const T = (tMs - J2000_MS) / 86400_000 / 36525 // TT centuries
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * AS2R
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * AS2R
  const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * AS2R
  const P = mul(rz(-z), mul(ry(th), rz(-zeta))) // mean J2000 -> mean of date
  // r_of_date = Rz(-gmst) r_fixed ; r_icrf = P^T r_of_date
  return mul(tr(P), rz(-gmst))
}

function stationEcef(s: Station): { pos: Vec3; up: Vec3 } {
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f)
  const lat = s.latDeg * D2R, lon = s.lonDeg * D2R
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  const up: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
  return { pos: [(N + s.heightM) * up[0], (N + s.heightM) * up[1], ((1 - e2) * N + s.heightM) * up[2]], up }
}
const ECEF = Object.fromEntries(DSN_STATIONS.map((s) => [s.id, stationEcef(s)]))

export type LinkBlock = 'ok' | 'terrain' | 'below-lunar-horizon' | 'below-station-horizon'

export interface StationLink {
  /** station seen from the lunar site (deg) */
  az: number
  el: number
  /** terrain horizon elevation in that azimuth (deg) */
  horizonEl: number
  /** site elevation above the station's local horizon (deg); < 0: the Earth itself is in the way */
  stationEl: number
  link: boolean
  block: LinkBlock
}

export interface DsnSample {
  t: number
  st: Record<string, StationLink>
  any: boolean
}

/**
 * Mutual line of sight between the lunar site and each station at time t. The antenna is assumed to
 * point anywhere above its horizon (no minimum-elevation mask), so a link needs:
 *  - 'below-lunar-horizon': the station is below the site's geometric horizon (Earth set);
 *  - 'terrain': above the geometric horizon but behind a ridge / crater rim (LOLA horizon mask);
 *  - 'below-station-horizon': the Moon is below the station's horizon (the Earth itself is in the way:
 *    at any time only the stations on the Moon-facing side of the Earth can see it);
 *  - 'ok': clear line of sight both ways.
 */
export function dsnAt(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, mask: HorizonMask | undefined, tMs: number): DsnSample {
  const topo = topoFrame(site.lat, site.lon, site.heightM ?? 0)
  const Mt = tr(moonFixedToIcrf(tMs))      // icrf -> moon-fixed
  const Ef = earthFixedToIcrf(tMs)         // earth-fixed -> icrf
  const earthMf = earthPosition(eph, tMs)  // Earth centre from the Moon, Moon-fixed (m)
  const st: Record<string, StationLink> = {}
  let any = false
  for (const s of DSN_STATIONS) {
    // station position in the Moon-fixed frame (~1 deg of parallax vs. the Earth's centre)
    const toMf = (v: Vec3) => apply(Mt, apply(Ef, v))
    const stMf = add(earthMf, toMf(ECEF[s.id].pos))
    const { az, el } = azEl(topo, stMf)
    const horizonEl = horizonAt(mask, az)
    // Earth side: elevation of the site above the station's local horizon
    const up = toMf(ECEF[s.id].up)
    const v: Vec3 = [topo.pos[0] - stMf[0], topo.pos[1] - stMf[1], topo.pos[2] - stMf[2]]
    const stationEl = Math.asin((v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / Math.hypot(v[0], v[1], v[2])) / D2R
    const block: LinkBlock =
      el < horizonEl ? (el < 0 ? 'below-lunar-horizon' : 'terrain') : stationEl < 0 ? 'below-station-horizon' : 'ok'
    const link = block === 'ok'
    any ||= link
    st[s.id] = { az, el, horizonEl, stationEl, link, block }
  }
  return { t: tMs, st, any }
}

export function dsnTimeline(eph: Ephemeris, site: { lat: number; lon: number; heightM?: number }, mask: HorizonMask | undefined,
  startMs: number, endMs: number, stepMs: number): DsnSample[] {
  const out: DsnSample[] = []
  for (let t = startMs; t <= endMs; t += stepMs) out.push(dsnAt(eph, site, mask, t))
  return out
}
