/**
 * Sun and Earth positions in the Moon-fixed frame (MOON_ME, the frame of LOLA maps), precomputed by
 * pipeline/ephemeris.py with NASA SPICE and linearly interpolated here. With these vectors every
 * site/time question is answered in the browser — no backend needed.
 */
import { MOON_RADIUS_M } from './raster'

export interface Ephemeris {
  frame: string
  startMs: number
  stepMs: number
  count: number
  sun: Float64Array // km, xyz interleaved
  earth: Float64Array
}

export type Vec3 = [number, number, number]

export async function loadEphemeris(url: string): Promise<Ephemeris> {
  const j = await (await fetch(url)).json()
  return {
    frame: j.frame,
    startMs: Date.parse(j.startUtc),
    stepMs: j.stepSeconds * 1000,
    count: j.count,
    sun: Float64Array.from(j.sun),
    earth: Float64Array.from(j.earth),
  }
}

export function ephemerisRange(e: Ephemeris): [number, number] {
  return [e.startMs, e.startMs + (e.count - 1) * e.stepMs]
}

function interp(arr: Float64Array, e: Ephemeris, tMs: number): Vec3 {
  const f = Math.min(Math.max((tMs - e.startMs) / e.stepMs, 0), e.count - 1.000001)
  const i = Math.floor(f)
  const a = f - i
  const o = i * 3
  return [
    arr[o] * (1 - a) + arr[o + 3] * a,
    arr[o + 1] * (1 - a) + arr[o + 4] * a,
    arr[o + 2] * (1 - a) + arr[o + 5] * a,
  ]
}

/** Positions in metres, Moon-fixed (= Cesium's "fixed" frame once the ellipsoid is the Moon). */
export const sunPosition = (e: Ephemeris, tMs: number): Vec3 => interp(e.sun, e, tMs).map((v) => v * 1000) as Vec3
export const earthPosition = (e: Ephemeris, tMs: number): Vec3 => interp(e.earth, e, tMs).map((v) => v * 1000) as Vec3

// ---------- topocentric geometry ----------

const D2R = Math.PI / 180

export interface Topo {
  pos: Vec3
  east: Vec3
  north: Vec3
  up: Vec3
}

/** Local East-North-Up frame at a site (sphere; heightM above the 1737.4 km reference). */
export function topoFrame(latDeg: number, lonDeg: number, heightM = 0): Topo {
  // nudge exact poles so east/north stay defined
  const lat = Math.max(-89.9999, Math.min(89.9999, latDeg)) * D2R
  const lon = lonDeg * D2R
  const up: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
  const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0]
  const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)]
  const r = MOON_RADIUS_M + heightM
  return { pos: [up[0] * r, up[1] * r, up[2] * r], east, north, up }
}

/** Azimuth (deg, from north, clockwise) and elevation (deg) of a body at position p (metres). */
export function azEl(t: Topo, p: Vec3): { az: number; el: number; distM: number } {
  const v: Vec3 = [p[0] - t.pos[0], p[1] - t.pos[1], p[2] - t.pos[2]]
  const d = Math.hypot(v[0], v[1], v[2])
  const dot = (a: Vec3) => (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) / d
  const el = Math.asin(dot(t.up)) / D2R
  let az = Math.atan2(dot(t.east), dot(t.north)) / D2R
  if (az < 0) az += 360
  return { az, el, distM: d }
}

export const SUN_RADIUS_KM = 695700
export const EARTH_RADIUS_KM = 6371
