/**
 * Sun and Earth positions in the Moon-fixed frame (MOON_ME, the frame of LOLA maps), precomputed by
 * pipeline/ephemeris.py with NASA SPICE and linearly interpolated here. With these vectors every
 * site/time question is answered in the browser — no backend needed.
 */
import { MOON_RADIUS_M } from './raster'

export const EPHEMERIS_START_YEAR = 2026
export const EPHEMERIS_LAST_SELECTABLE_YEAR = 2200
export const EPHEMERIS_WINDOW_YEARS = 5

export interface Ephemeris {
  frame: string
  startMs: number
  stepMs: number
  count: number
  sun: Float64Array // km, xyz interleaved
  earth: Float64Array
}

export type Vec3 = [number, number, number]

interface EphemerisJson {
  frame: string
  startUtc: string
  stepSeconds: number
  count: number
  sun: number[]
  earth: number[]
}

export async function loadEphemeris(url: string): Promise<Ephemeris> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load ephemeris (${response.status}): ${url}`)
  const j = (await response.json()) as EphemerisJson
  return {
    frame: j.frame,
    startMs: Date.parse(j.startUtc),
    stepMs: j.stepSeconds * 1000,
    count: j.count,
    sun: Float64Array.from(j.sun),
    earth: Float64Array.from(j.earth),
  }
}

const chunkCache = new Map<number, Promise<Ephemeris>>()

function loadChunk(baseUrl: string, chunkYear: number): Promise<Ephemeris> {
  const cached = chunkCache.get(chunkYear)
  if (cached) return cached
  const path = chunkYear === EPHEMERIS_START_YEAR
    ? `${baseUrl}/ephemeris.json`
    : `${baseUrl}/ephemeris/${chunkYear}.json`
  const request = loadEphemeris(path)
  chunkCache.set(chunkYear, request)
  request.catch(() => chunkCache.delete(chunkYear))
  return request
}

function joinChunks(chunks: Ephemeris[]): Ephemeris {
  const first = chunks[0]
  let count = first.count
  for (let i = 1; i < chunks.length; i++) {
    const previous = chunks[i - 1]
    const current = chunks[i]
    if (current.frame !== first.frame || current.stepMs !== first.stepMs) {
      throw new Error('Ephemeris chunks use inconsistent frames or time steps')
    }
    const expectedStart = previous.startMs + (previous.count - 1) * previous.stepMs
    if (Math.abs(current.startMs - expectedStart) > 1000) {
      throw new Error('Ephemeris chunks are not contiguous')
    }
    count += current.count - 1
  }

  const sun = new Float64Array(count * 3)
  const earth = new Float64Array(count * 3)
  let offset = 0
  chunks.forEach((chunk, index) => {
    const firstValue = index === 0 ? 0 : 3
    const values = (chunk.count - (index === 0 ? 0 : 1)) * 3
    sun.set(chunk.sun.subarray(firstValue, firstValue + values), offset)
    earth.set(chunk.earth.subarray(firstValue, firstValue + values), offset)
    offset += values
  })

  return { ...first, count, sun, earth }
}

export async function loadEphemerisWindow(baseUrl: string, startYear: number): Promise<Ephemeris> {
  if (!Number.isInteger(startYear) || startYear < EPHEMERIS_START_YEAR || startYear > EPHEMERIS_LAST_SELECTABLE_YEAR) {
    throw new RangeError(`Unsupported ephemeris window start year: ${startYear}`)
  }

  const firstChunkYear =
    EPHEMERIS_START_YEAR +
    Math.floor((startYear - EPHEMERIS_START_YEAR) / EPHEMERIS_WINDOW_YEARS) * EPHEMERIS_WINDOW_YEARS
  const endYear = startYear + EPHEMERIS_WINDOW_YEARS
  const chunkYears: number[] = []
  for (let year = firstChunkYear; year < endYear; year += EPHEMERIS_WINDOW_YEARS) chunkYears.push(year)

  const combined = joinChunks(await Promise.all(chunkYears.map((year) => loadChunk(baseUrl, year))))
  const startMs = Date.UTC(startYear, 0, 1)
  const endMs = Date.UTC(endYear, 0, 1)
  const startIndex = Math.round((startMs - combined.startMs) / combined.stepMs)
  const endIndex = Math.round((endMs - combined.startMs) / combined.stepMs)
  if (startIndex < 0 || endIndex >= combined.count || Math.abs(combined.startMs + startIndex * combined.stepMs - startMs) > 1000) {
    throw new Error(`Ephemeris data does not cover ${startYear}-${endYear}`)
  }
  const valueStart = startIndex * 3
  const valueEnd = (endIndex + 1) * 3
  return {
    ...combined,
    startMs,
    count: endIndex - startIndex + 1,
    sun: combined.sun.slice(valueStart, valueEnd),
    earth: combined.earth.slice(valueStart, valueEnd),
  }
}

export async function loadEphemerisRange(baseUrl: string, startMs: number, endMs: number): Promise<Ephemeris> {
  const minMs = Date.UTC(EPHEMERIS_START_YEAR, 0, 1)
  const maxMs = Date.UTC(EPHEMERIS_LAST_SELECTABLE_YEAR + 1, 0, 1)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < minMs || endMs <= startMs || endMs > maxMs) {
    throw new RangeError('Unsupported ephemeris date range')
  }

  const firstYear = new Date(startMs).getUTCFullYear()
  const lastYear = new Date(endMs).getUTCFullYear()
  const firstChunkYear = EPHEMERIS_START_YEAR +
    Math.floor((firstYear - EPHEMERIS_START_YEAR) / EPHEMERIS_WINDOW_YEARS) * EPHEMERIS_WINDOW_YEARS
  const lastChunkYear = EPHEMERIS_START_YEAR +
    Math.floor((lastYear - EPHEMERIS_START_YEAR) / EPHEMERIS_WINDOW_YEARS) * EPHEMERIS_WINDOW_YEARS
  const chunkYears: number[] = []
  for (let year = firstChunkYear; year <= lastChunkYear; year += EPHEMERIS_WINDOW_YEARS) chunkYears.push(year)

  const combined = joinChunks(await Promise.all(chunkYears.map((year) => loadChunk(baseUrl, year))))
  const startIndex = Math.max(0, Math.floor((startMs - combined.startMs) / combined.stepMs))
  const endIndex = Math.min(combined.count - 1, Math.ceil((endMs - combined.startMs) / combined.stepMs))
  if (startIndex >= endIndex || endIndex >= combined.count) {
    throw new Error(`Ephemeris data does not cover ${new Date(startMs).getUTCFullYear()}-${new Date(endMs).getUTCFullYear()}`)
  }
  const valueStart = startIndex * 3
  const valueEnd = (endIndex + 1) * 3
  return {
    ...combined,
    startMs: combined.startMs + startIndex * combined.stepMs,
    count: endIndex - startIndex + 1,
    sun: combined.sun.slice(valueStart, valueEnd),
    earth: combined.earth.slice(valueStart, valueEnd),
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
