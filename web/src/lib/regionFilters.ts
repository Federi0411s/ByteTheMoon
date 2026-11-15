// Region filters: tick the criteria you care about, give each a range, and the map highlights the
// points that meet ALL of them (drawn by GlobalHeatProvider like the other global heatmaps).
import type { HeatValues } from '../cesium/GlobalHeatProvider'
import { DATA_URL } from './data'

const MOON_R_KM = 1737.4
const KELVIN = 273.15

export type FilterKey =
  | 'sunHours' | 'nightHours' | 'radiation' | 'temperature' | 'slope' | 'ice' | 'pits' | 'earth' | 'charging'

export interface RangeFilter { on: boolean; min: number; max: number }
export type RegionFilterState = Record<FilterKey, RangeFilter>

export interface FilterDef {
  label: string
  unit: string
  /** accepted input range; `null` = the selected period length in hours */
  limits: [number, number | null]
  help: string
}

export const FILTER_ORDER: FilterKey[] = [
  'sunHours', 'nightHours', 'radiation', 'temperature', 'slope', 'ice', 'pits', 'earth', 'charging',
]

export const FILTER_DEFS: Record<FilterKey, FilterDef> = {
  sunHours: { label: 'Sunlight', unit: 'h', limits: [0, null], help: 'Hours of sunlight in the selected period' },
  nightHours: { label: 'Longest night', unit: 'h', limits: [0, null], help: 'No direct sunlight; partial sunlight counts as day, eclipses excluded' },
  radiation: { label: 'Radiation dose', unit: 'µGy/h', limits: [0, 30], help: 'Cosmic-ray dose, lower where terrain hides the sky' },
  temperature: { label: 'Temperature (mean)', unit: '°C', limits: [-273, 150], help: 'Mean surface temperature over the selected period, matching the thermal-mean map (regolith model; slower)' },
  slope: { label: 'Slope', unit: '°', limits: [0, 90], help: 'Terrain slope' },
  ice: { label: 'Distance to water ice', unit: 'km', limits: [0, 500], help: 'Distance to the nearest cold trap (south polar map only)' },
  pits: { label: 'Distance to a lunar pit', unit: 'km', limits: [0, 5000], help: 'Distance to the nearest pit of the LROC catalog' },
  earth: { label: 'Earth visibility', unit: '%', limits: [0, 100], help: 'Share of the time Earth is above the horizon (communications)' },
  charging: { label: 'Surface charging', unit: 'V', limits: [-300, 50], help: 'Mean surface potential' },
}

/** Ranges a filter starts with when ticked (period-based ones are filled in from the period length). */
export function defaultFilters(periodHours: number): RegionFilterState {
  const p = Math.max(1, Math.round(periodHours))
  return {
    sunHours: { on: false, min: Math.round(p * 0.5), max: p },
    nightHours: { on: false, min: 0, max: Math.min(p, 240) },
    radiation: { on: false, min: 0, max: 12.8 },
    temperature: { on: false, min: -200, max: 100 },
    slope: { on: false, min: 0, max: 8 },
    ice: { on: false, min: 0, max: 20 },
    pits: { on: false, min: 0, max: 200 },
    earth: { on: false, min: 50, max: 100 },
    charging: { on: false, min: -60, max: 20 },
  }
}

export const activeFilters = (f: RegionFilterState) => FILTER_ORDER.filter((k) => f[k].on)

// ---- distance to the nearest cold trap: precomputed 4 km polar grid (pipeline/ice.py) ----
export interface IceDistance { distKm: (lon: number, lat: number) => number }

/**
 * distanza_ghiaccio.csv holds one row per point of the 4 km polar grid of charging_points.csv
 * (polar stereographic, south). `grid` = that layer's geometry (overlays/index.json, charging_mean).
 */
export async function loadIceDistance(grid: { halfExtentM: number; width: number }): Promise<IceDistance> {
  const res = await fetch(`${DATA_URL}/distanza_ghiaccio.csv`)
  if (!res.ok) throw new Error(`distanza_ghiaccio.csv unavailable (${res.status})`)
  const lines = (await res.text()).trim().split(/\r?\n/)
  const head = lines[0].split(',')
  const iLat = head.indexOf('lat'), iLon = head.indexOf('lon'), iD = head.indexOf('dist_ice_km')
  if (iLat < 0 || iLon < 0 || iD < 0) throw new Error('distanza_ghiaccio.csv: unexpected columns')
  const H = grid.halfExtentM, n = grid.width, cell = (2 * H) / n
  const dist = new Float32Array(n * n).fill(NaN)
  const index = (lon: number, lat: number) => {
    if (lat > -Math.PI / 4) return -1
    const rho = 2 * MOON_R_KM * 1000 * Math.tan((Math.PI / 2 + lat) / 2)
    const col = Math.floor((rho * Math.sin(lon) + H) / cell), row = Math.floor((H - rho * Math.cos(lon)) / cell)
    return col >= 0 && col < n && row >= 0 && row < n ? row * n + col : -1
  }
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',')
    const i = index(Number(c[iLon]) * Math.PI / 180, Number(c[iLat]) * Math.PI / 180)
    if (i >= 0) dist[i] = Number(c[iD])
  }
  return { distKm: (lon, lat) => { const i = index(lon, lat); return i < 0 ? NaN : dist[i] } }
}

// ---- distance to the nearest lunar pit (pits.geojson, pipeline/pits.py) ----
export interface PitDistance { nearestKm: (lon: number, lat: number, maxKm: number) => number }

export async function loadPitDistance(): Promise<PitDistance> {
  const res = await fetch(`${DATA_URL}/pits.geojson`)
  if (!res.ok) throw new Error(`pits.geojson unavailable (${res.status})`)
  const gj = (await res.json()) as { features?: { geometry?: { coordinates?: unknown } }[] }
  const pts: [number, number][] = [] // [lat, lon] radians, sorted by latitude
  for (const f of gj.features ?? []) {
    const c = f.geometry?.coordinates
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') pts.push([c[1] * Math.PI / 180, c[0] * Math.PI / 180])
  }
  pts.sort((a, b) => a[0] - b[0])
  const lats = Float64Array.from(pts, (p) => p[0])
  return {
    /** great-circle distance to the nearest pit, or Infinity if none is within maxKm */
    nearestKm(lon, lat, maxKm) {
      const dLat = maxKm / MOON_R_KM
      let lo = 0, hi = lats.length
      while (lo < hi) { const m = (lo + hi) >> 1; if (lats[m] < lat - dLat) lo = m + 1; else hi = m }
      let best = Infinity
      const cosLat = Math.cos(lat)
      for (let k = lo; k < lats.length && lats[k] <= lat + dLat; k++) {
        const [pLat, pLon] = pts[k]
        const s1 = Math.sin((pLat - lat) / 2), s2 = Math.sin((pLon - lon) / 2)
        const d = 2 * MOON_R_KM * Math.asin(Math.min(1, Math.sqrt(s1 * s1 + cosLat * Math.cos(pLat) * s2 * s2)))
        if (d < best) best = d
      }
      return best
    },
  }
}

export interface FilterContext {
  /** length of the selected period (mission period, or the loaded window), hours */
  periodHours: number
  /** visible-sky fraction -> dose (µGy/h), the same formula as the Radiation layer */
  dose: (fSky: number) => number
  ice: IceDistance | null
  pits: PitDistance | null
}

/**
 * value() for GlobalHeatProvider: 1 where every ticked filter is met, NaN (transparent) elsewhere.
 * Cheap checks first; the distance look-ups only run for points that already passed the rest.
 */
export function regionValue(f: RegionFilterState, ctx: FilterContext): (v: HeatValues, lon: number, lat: number) => number {
  const inRange = (x: number, r: RangeFilter) => x >= r.min && x <= r.max // NaN fails
  const checks: ((v: HeatValues, lon: number, lat: number) => boolean)[] = []
  if (f.slope.on) checks.push((v) => inRange(v.slope, f.slope))
  if (f.sunHours.on) checks.push((v) => inRange(v.sun * ctx.periodHours, f.sunHours))
  if (f.nightHours.on) checks.push((v) => inRange(v.dark, f.nightHours))
  if (f.earth.on) checks.push((v) => inRange(100 * v.earth, f.earth))
  if (f.radiation.on) checks.push((v) => inRange(ctx.dose(v.fSky), f.radiation))
  if (f.charging.on) checks.push((v) => inRange(v.cMean, f.charging))
  if (f.temperature.on) checks.push((v) => inRange(v.tMean - KELVIN, f.temperature))
  if (f.ice.on) {
    const ice = ctx.ice
    checks.push((_v, lon, lat) => !!ice && inRange(ice.distKm(lon, lat), f.ice))
  }
  if (f.pits.on) {
    const pits = ctx.pits
    checks.push((_v, lon, lat) => !!pits && inRange(pits.nearestKm(lon, lat, f.pits.max), f.pits))
  }
  return (v, lon, lat) => {
    for (const ok of checks) if (!ok(v, lon, lat)) return NaN
    return 0.2 // light green in the 'slope' colormap
  }
}
