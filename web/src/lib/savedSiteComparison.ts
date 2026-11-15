import { assessHuman, type HumanAssessment } from './human'
import { combine, scoreRadiation, scoreSlope, scoreSunlight, scoreTelecom, scoreTemperature, type LandingScore } from './landingScore'
import type { AdvancedSettings } from './advancedSettings'
import type { Ephemeris } from './ephemeris'
import { dsnTimeline } from './dsn'
import type { HeatEngine } from './heatEngine'
import { footprintMax, type RasterField } from './raster'
import { radiationDose } from './radiation'
import { siteThermalSeries } from './regolith'
import { sampleSiteEnv } from './siteEnv'
import type { Site } from './data'
import type { Footprint } from './requirements'
import { footprintAxes, footprintLabel } from './requirements'

export interface SavedSiteComparison {
  site: Site
  score: LandingScore
  human: HumanAssessment
}

export interface CompareSavedSitesOptions {
  sites: Site[]
  ephemeris: Ephemeris
  heat: HeatEngine
  period: [number, number]
  isMission: boolean
  settings: AdvancedSettings
  footprint: Footprint
  slopeField?: RasterField
  dem?: RasterField
  onProgress?: (completed: number, total: number) => void
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Comparison cancelled.', 'AbortError')
}

function siteScoreStep(start: number, end: number) {
  return Math.max(900_000, Math.ceil((end - start) / 45_000 / 900_000) * 900_000)
}

export async function compareSavedSites({
  sites,
  ephemeris,
  heat,
  period,
  isMission,
  settings,
  footprint,
  slopeField,
  dem,
  onProgress,
  signal,
}: CompareSavedSitesOptions): Promise<SavedSiteComparison[]> {
  const [start, end] = period
  if (!(end > start)) throw new Error('Choose a valid analysis interval before comparing saved sites.')
  if (heat.window[0] !== start || heat.window[1] !== end) {
    throw new Error('The heatmap engine is still preparing the selected analysis interval. Please try again in a moment.')
  }
  if (!sites.length) throw new Error('Save at least one landing site before comparing candidates.')

  const stepMs = siteScoreStep(start, end)
  const walkStepMs = Math.max(3600_000, stepMs)
  const [semiMajorM, semiMinorM, azimuthDeg] = footprintAxes(footprint)
  const slopeAt = slopeField ? footprintMaxSampler(slopeField, semiMajorM, semiMinorM, azimuthDeg) : undefined
  const evaluated: SavedSiteComparison[] = []

  for (let index = 0; index < sites.length; index++) {
    throwIfAborted(signal)
    onProgress?.(index, sites.length)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    throwIfAborted(signal)

    const site = sites[index]
    const horizon = site.horizon ?? await heat.horizon(site.lat, site.lon)
    if (!horizon) throw new Error(`Terrain horizon data are unavailable for ${site.name}.`)
    const env = await sampleSiteEnv(heat, site.lat, site.lon)
    if (!env || ![env.tMean, env.tMin, env.tMax, env.fSky, env.slope].every(Number.isFinite)) {
      throw new Error(`Temperature and radiation data are unavailable for ${site.name}.`)
    }

    const doseUGyH = radiationDose(env.fSky, heat.gcr)
    const dsn = dsnTimeline(ephemeris, site, horizon, start, end, stepMs)
    const walkSeries = siteThermalSeries(ephemeris, site, horizon, start, end, walkStepMs, dem)
    if (!dsn.length || !walkSeries.sunlit.length) throw new Error(`Mission-period data are unavailable for ${site.name}.`)

    let longestGap = 0, gap = 0
    for (const sample of dsn) {
      gap = sample.any ? 0 : gap + 1
      longestGap = Math.max(longestGap, gap)
    }
    const linkStepH = dsn.length > 1 ? (dsn[1].t - dsn[0].t) / 3600_000 : 0
    const linkPercent = (100 * dsn.filter((sample) => sample.any).length) / dsn.length
    let lit = 0, darkRun = 0, longestDark = 0
    walkSeries.sunlit.forEach((_, i) => {
      lit += walkSeries.light[i] // light-weighted sunlit % (an hour at 30 % of the Sun's light counts 0.3 h)
      darkRun = walkSeries.light[i] > 0 ? 0 : darkRun + 1
      longestDark = Math.max(longestDark, darkRun)
    })
    const sunlitPercent = (100 * lit) / walkSeries.sunlit.length
    const slope = slopeAt?.(site) ?? env.slope
    const score = combine([
      scoreTemperature(env.tMean - 273.15, env.tMin - 273.15, env.tMax - 273.15, settings),
      scoreRadiation(doseUGyH, (end - start) / 3600_000, settings),
      scoreSlope(slope, footprintLabel(footprint).replace(/^(circle|ellipse)/, 'landing $1'), settings),
      scoreTelecom(linkPercent, longestGap * linkStepH, settings),
      scoreSunlight(sunlitPercent, settings),
    ], ['temperature', 'radiation', 'slope', 'telecommunications', 'sunlight'])
    if (score.missing.length) throw new Error(`One or more score factors could not be calculated for ${site.name}.`)
    const human = assessHuman(doseUGyH, walkSeries, (end - start) / 86400_000, isMission, settings)
    evaluated.push({ site, score, human })
    onProgress?.(index + 1, sites.length)
  }

  return evaluated.sort((a, b) => Number(b.score.feasible) - Number(a.score.feasible) || b.score.score - a.score.score)
}

function footprintMaxSampler(field: RasterField, semiMajorM: number, semiMinorM: number, azimuthDeg: number) {
  const maxField = footprintMax(field, semiMajorM, semiMinorM, azimuthDeg)
  return (site: Site) => {
    const value = maxField.sampleNearest(site.lon * Math.PI / 180, site.lat * Math.PI / 180)
    return Number.isFinite(value) ? value : undefined
  }
}
