import { computeTimeline, type TimelineSample } from './analysis'
import type { Ephemeris } from './ephemeris'
import type { Site } from './data'
import { DSN_STATIONS, dsnAt, type DsnSample } from './dsn'
import { fitPanoramaRange } from './panorama'
import { powerAt, type PanelConfig, type PowerSample } from './power'
import type { SiteTemperatureSample } from './siteEnv'
import { fmtDate, fmtDateTime } from './time'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface ReportOverlay {
  id: string
  title: string
  source: string
  opacity: number
}

export interface ReportFilterImage extends ReportOverlay {
  image: string
}

export interface TechnicalReportRequest {
  site: Site
  ephemeris: Ephemeris
  panel: PanelConfig
  env?: { tMinK: number; tMaxK: number; doseUGyH: number }
  temperatureTimeline?: SiteTemperatureSample[]
  panoramaTimeline: TimelineSample[]
  panoramaNow?: TimelineSample
  currentMs: number
  startMs: number
  endMs: number
  periodSource: string
  includeSiteDetails: boolean
  includeMap: boolean
  filterImages: ReportFilterImage[]
  overlays: ReportOverlay[]
}

function periodStats(samples: TimelineSample[], endMs: number) {
  let totalHours = 0, sunHours = 0, earthHours = 0, bothHours = 0
  let currentDarkHours = 0, longestDarkHours = 0
  for (let i = 0; i + 1 < samples.length; i++) {
    const sample = samples[i]
    const hours = Math.max(0, Math.min(endMs, samples[i + 1].t) - sample.t) / HOUR_MS
    const sun = sample.sunVisibleFrac > 0.5
    const earth = sample.earthVisibleFrac > 0.5
    totalHours += hours
    if (sun) { sunHours += hours; currentDarkHours = 0 }
    else {
      currentDarkHours += hours
      longestDarkHours = Math.max(longestDarkHours, currentDarkHours)
    }
    if (earth) earthHours += hours
    if (sun && earth) bothHours += hours
  }
  return {
    sunPct: totalHours ? 100 * sunHours / totalHours : 0,
    earthPct: totalHours ? 100 * earthHours / totalHours : 0,
    bothPct: totalHours ? 100 * bothHours / totalHours : 0,
    longestDarkHours,
  }
}

function sampleTimes(startMs: number, endMs: number, maxSamples: number, minimumStepMs: number): number[] {
  const step = Math.max(minimumStepMs, Math.ceil((endMs - startMs) / (maxSamples - 1)))
  const times = [startMs]
  for (let t = startMs + step; t < endMs; t += step) times.push(t)
  if (endMs > startMs) times.push(endMs)
  return times
}

function powerStats(samples: PowerSample[], endMs: number) {
  let energyWh = 0, totalHours = 0, producingHours = 0, outageHours = 0, longestOutageHours = 0, eclipseHours = 0
  const peakW = Math.max(...samples.map((sample) => sample.power))
  const thresholdW = Math.max(peakW * 0.01, 1e-6)
  for (let i = 0; i + 1 < samples.length; i++) {
    const sample = samples[i]
    const hours = Math.max(0, Math.min(endMs, samples[i + 1].t) - sample.t) / HOUR_MS
    totalHours += hours
    energyWh += sample.power * hours
    if (sample.power > thresholdW) {
      producingHours += hours
      outageHours = 0
    } else {
      outageHours += hours
      longestOutageHours = Math.max(longestOutageHours, outageHours)
    }
    if (sample.eclipseFrac > 0.001 && sample.terrainFrac > 0) eclipseHours += hours
  }
  return {
    meanW: totalHours ? energyWh / totalHours : 0,
    peakW,
    energyWh,
    producingPct: totalHours ? 100 * producingHours / totalHours : 0,
    longestOutageHours,
    eclipseHours,
  }
}

function dsnStats(samples: DsnSample[], endMs: number) {
  let totalHours = 0, contactHours = 0, noContactHours = 0, longestNoContactHours = 0
  let noStationHours = 0, oneStationHours = 0, twoStationHours = 0, allThreeHours = 0
  const stationHours = Object.fromEntries(DSN_STATIONS.map((station) => [station.id, 0])) as Record<string, number>
  const windows: { start: number; end: number }[] = []
  for (let i = 0; i + 1 < samples.length; i++) {
    const sample = samples[i], hours = Math.max(0, Math.min(endMs, samples[i + 1].t) - sample.t) / HOUR_MS
    totalHours += hours
    const linkedCount = DSN_STATIONS.filter((station) => sample.st[station.id]?.link).length
    for (const station of DSN_STATIONS) if (sample.st[station.id]?.link) stationHours[station.id] += hours
    if (linkedCount === 0) noStationHours += hours
    if (linkedCount === 1) oneStationHours += hours
    if (linkedCount === 2) twoStationHours += hours
    if (linkedCount === 3) allThreeHours += hours
    if (sample.any) {
      contactHours += hours
      noContactHours = 0
      const last = windows[windows.length - 1]
      if (last && last.end === sample.t) last.end = samples[i + 1].t
      else windows.push({ start: sample.t, end: samples[i + 1].t })
    } else {
      noContactHours += hours
      longestNoContactHours = Math.max(longestNoContactHours, noContactHours)
    }
  }
  windows.sort((a, b) => (b.end - b.start) - (a.end - a.start))
  return {
    contactPct: totalHours ? 100 * contactHours / totalHours : 0,
    longestNoContactHours,
    noStationPct: totalHours ? 100 * noStationHours / totalHours : 0,
    oneStationPct: totalHours ? 100 * oneStationHours / totalHours : 0,
    twoStationPct: totalHours ? 100 * twoStationHours / totalHours : 0,
    allThreePct: totalHours ? 100 * allThreeHours / totalHours : 0,
    stationPct: Object.fromEntries(Object.entries(stationHours).map(([id, hours]) => [id, totalHours ? 100 * hours / totalHours : 0])) as Record<string, number>,
    bestWindows: windows.slice(0, 3),
  }
}

function timeUntilSet(samples: TimelineSample[], key: 'sunVisibleFrac' | 'earthVisibleFrac', currentMs: number): number | null {
  if (!samples.length || currentMs < samples[0].t || currentMs > samples[samples.length - 1].t) return null
  const currentIndex = samples.findIndex((sample) => sample.t >= currentMs)
  if (currentIndex < 0 || samples[currentIndex][key] <= 0.5) return null
  const set = samples.slice(currentIndex + 1).find((sample) => sample[key] <= 0.5)
  return set ? set.t - currentMs : null
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  const hours = ms / HOUR_MS
  return hours >= 48 ? `${(hours / 24).toFixed(1)} d` : `${hours.toFixed(1)} h`
}

export async function downloadTechnicalReport(request: TechnicalReportRequest): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 18
  const contentWidth = pageWidth - margin * 2
  let y = margin

  const newPage = () => {
    doc.addPage()
    y = margin
  }
  const reserve = (height: number) => {
    if (y + height > pageHeight - margin) newPage()
  }
  const paragraph = (text: string, indent = 0) => {
    const lines = doc.splitTextToSize(text, contentWidth - indent)
    const lineHeight = 5
    reserve(lines.length * lineHeight + 2)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text(lines, margin + indent, y)
    y += lines.length * lineHeight + 2
  }
  const section = (title: string) => {
    reserve(13)
    y += 3
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(33, 54, 80)
    doc.text(title, margin, y)
    y += 2
    doc.setDrawColor(170, 184, 201)
    doc.setLineWidth(0.35)
    doc.line(margin, y, pageWidth - margin, y)
    y += 6
  }
  const table = (rows: [string, string][]) => {
    const labelWidth = 62, valueWidth = contentWidth - labelWidth
    for (let i = 0; i < rows.length; i++) {
      const [label, value] = rows[i]
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8.5)
      const labelLines = doc.splitTextToSize(label, labelWidth - 5)
      const valueLines = doc.splitTextToSize(value, valueWidth - 5)
      const height = Math.max(6, Math.max(labelLines.length, valueLines.length) * 4 + 2)
      reserve(height)
      doc.setFillColor(i % 2 ? 247 : 239, i % 2 ? 249 : 244, i % 2 ? 251 : 248)
      doc.rect(margin, y - 3.5, contentWidth, height, 'F')
      doc.setTextColor(72, 83, 96)
      doc.text(labelLines, margin + 2, y)
      doc.setTextColor(30, 42, 56)
      doc.text(valueLines, margin + labelWidth + 2, y)
      y += height
    }
    y += 3
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(20, 38, 61)
  doc.text('ByteTheMoon', margin, y)
  y += 7
  doc.setFontSize(12)
  doc.text('LUNAR MISSION SITE REPORT', margin, y)
  y += 6
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(85, 98, 116)
  doc.text(`Generated ${fmtDateTime(Date.now())} UTC`, margin, y)
  y += 7

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(28, 38, 50)
  doc.text(request.site.name, margin, y)
  y += 5

  const spanMs = request.endMs - request.startMs
  if (!(spanMs > 0)) throw new Error('The selected analysis interval must have a positive duration.')
  const timelineStep = Math.min(spanMs, Math.max(HOUR_MS, Math.ceil(spanMs / 12000)))
  const samples = computeTimeline(
    request.ephemeris,
    request.site,
    request.site.horizon,
    request.startMs,
    request.endMs,
    timelineStep,
  )
  if (samples.length < 2) throw new Error('The selected interval is too short to analyse.')
  if (samples[samples.length - 1].t < request.endMs) {
    samples.push(...computeTimeline(request.ephemeris, request.site, request.site.horizon, request.endMs, request.endMs))
  }
  const stats = periodStats(samples, request.endMs)
  const powerTimes = sampleTimes(request.startMs, request.endMs, 2400, HOUR_MS)
  const powerSamples = powerTimes.map((time) => powerAt(request.ephemeris, request.site, request.site.horizon, time, request.panel))
  const powerSummary = powerStats(powerSamples, request.endMs)
  const dsnTimes = sampleTimes(request.startMs, request.endMs, 12000, HOUR_MS)
  const dsnStepMs = dsnTimes[1] - dsnTimes[0]
  const dsnSamples = dsnTimes.map((time) => dsnAt(request.ephemeris, request.site, request.site.horizon, time))
  const dsnSummary = dsnStats(dsnSamples, request.endMs)
  const current = request.panoramaNow ?? computeTimeline(
    request.ephemeris, request.site, request.site.horizon, request.currentMs, request.currentMs,
  )[0]
  const currentDsn = dsnAt(request.ephemeris, request.site, request.site.horizon, request.currentMs)
  const currentPower = powerAt(request.ephemeris, request.site, request.site.horizon, request.currentMs, request.panel)

  const latHemisphere = request.site.lat < 0 ? 'S' : 'N'
  const lonHemisphere = request.site.lon < 0 ? 'W' : 'E'
  const landingDayReport = request.periodSource === 'Landing day'
  section(landingDayReport ? 'Landing-day summary' : 'Mission summary')
  const rows: [string, string][] = [
    ['Coordinates', `${Math.abs(request.site.lat).toFixed(5)}° ${latHemisphere}, ${Math.abs(request.site.lon).toFixed(5)}° ${lonHemisphere}`],
    ['Site category / elevation', `${request.site.group} / ${request.site.heightM === undefined ? 'Unavailable' : `${request.site.heightM.toFixed(1)} m`}`],
    [request.periodSource === 'Landing day' ? 'Landing day (UTC)' : 'Analysis interval (UTC)', `${fmtDateTime(request.startMs)} – ${fmtDateTime(request.endMs)}`],
    ['Interval source', request.periodSource],
    ['Analysis duration', `${(spanMs / DAY_MS).toFixed(2)} days`],
    ['Terrain horizon', request.site.horizon?.source ?? 'Unavailable; flat horizon assumed'],
    ['Sun visible (>50% disc)', `${stats.sunPct.toFixed(1)}% of interval`],
    ['Earth visible (>50% disc)', `${stats.earthPct.toFixed(1)}% of interval`],
    ['Sun and Earth both visible', `${stats.bothPct.toFixed(1)}% of interval`],
    ['Longest estimated night', `${stats.longestDarkHours.toFixed(1)} h`],
    ['Now: Sun elevation / visible', `${current ? `${current.sunEl.toFixed(1)}° / ${(current.sunVisibleFrac * 100).toFixed(0)}%` : 'Unavailable'}`],
    ['Now: Earth elevation / visible', `${current ? `${current.earthEl.toFixed(1)}° / ${(current.earthVisibleFrac * 100).toFixed(0)}%` : 'Unavailable'}`],
    ['Time to sunset / Earthset', `${formatDuration(timeUntilSet(samples, 'sunVisibleFrac', request.currentMs))} / ${formatDuration(timeUntilSet(samples, 'earthVisibleFrac', request.currentMs))}`],
    ['Surface temperature range', request.env ? `${(request.env.tMinK - 273.15).toFixed(0)} to ${(request.env.tMaxK - 273.15).toFixed(0)} °C` : 'Unavailable'],
    ['Thermal excursion', request.env ? `${(request.env.tMaxK - request.env.tMinK).toFixed(1)} °C` : 'Unavailable'],
    ['Radiation dose rate', request.env ? `${request.env.doseUGyH.toFixed(1)} µGy/h` : 'Unavailable'],
    ['Solar-array setup', `${request.panel.mode === 'tracking' ? 'Sun-tracking' : 'Fixed horizontal'}; ${request.panel.areaM2} m²; ${(request.panel.efficiency * 100).toFixed(0)}% efficiency`],
    ['Power now / energy per hour (mean) / peak', `${currentPower.power.toFixed(0)} W / ${powerSummary.meanW.toFixed(0)} W / ${powerSummary.peakW.toFixed(0)} W`],
    ['Energy / producing time', `${(powerSummary.energyWh / 1000).toFixed(2)} kWh / ${powerSummary.producingPct.toFixed(1)}%`],
    ['Longest power outage / eclipse', `${powerSummary.longestOutageHours.toFixed(1)} h / ${powerSummary.eclipseHours.toFixed(1)} h`],
    ['DSN link now', DSN_STATIONS.filter((station) => currentDsn.st[station.id]?.link).map((station) => station.name).join(', ') || 'No station in link'],
    ['Any DSN contact during interval', `${dsnSummary.contactPct.toFixed(1)}% of interval`],
    ['DSN overlap (none / exactly 1 / exactly 2 / all 3)', `${dsnSummary.noStationPct.toFixed(1)}% / ${dsnSummary.oneStationPct.toFixed(1)}% / ${dsnSummary.twoStationPct.toFixed(1)}% / ${dsnSummary.allThreePct.toFixed(1)}%`],
    ...DSN_STATIONS.map((station) => [`${station.name} ${station.antenna} contact time`, `${dsnSummary.stationPct[station.id].toFixed(1)}% of interval`] as [string, string]),
    ['Longest estimated no-contact gap', `${dsnSummary.longestNoContactHours.toFixed(1)} h`],
  ]
  if (request.includeSiteDetails && request.site.note) rows.splice(4, 0, ['Site note', request.site.note])
  table(rows)

  section('Model assumptions')
  paragraph('Visibility and DSN contacts use the selected site’s terrain horizon. A station is considered in link only when the lunar site and that antenna have mutual line of sight. Power assumes the stated array mode, area and efficiency; it does not include storage, degradation or temperature derating.')
  paragraph(`Temperature uses the Hayne regolith model where terrain data are available. Radiation is the GCR + albedo estimate. Timelines are sampled at up to ${(timelineStep / HOUR_MS).toFixed(1)} h for illumination and ${dsnStepMs / HOUR_MS < 24 ? `${(dsnStepMs / HOUR_MS).toFixed(1)} h` : `${(dsnStepMs / DAY_MS).toFixed(1)} d`} for DSN; event boundaries are approximate at that resolution.`)

  newPage()
  section('Terrain horizon and Sun/Earth paths')
  paragraph('The skyline and body tracks use the active site-analysis window. Markers show the Sun and Earth positions at the current application time.')
  const panoramaHeight = addHorizonPanorama(
    doc,
    request.site,
    request.panoramaTimeline,
    request.panoramaNow,
    margin,
    y,
    contentWidth,
  )
  y += panoramaHeight + 3

  newPage()
  section(landingDayReport ? 'Landing-day timelines' : 'Mission timelines')
  paragraph(`Temperature and power are plotted as mean curves against the selected interval. Temperature uses representative lunations for intervals longer than one year, so its connecting line is a guide between sampled periods. DSN links are binary (0 = no link, 1 = link): the three station traces are separated into lanes so simultaneous links remain visible. A second chart sums them from 0 to 3. DSN sampling: ${dsnStepMs / HOUR_MS < 24 ? `${(dsnStepMs / HOUR_MS).toFixed(1)} h` : `${(dsnStepMs / DAY_MS).toFixed(1)} d`}; contact transitions are approximate at that resolution.`)
  if (request.temperatureTimeline?.length) {
    reserve(60)
    addTemperatureChart(doc, request.temperatureTimeline, request.startMs, request.endMs, margin, y, contentWidth)
    y += 62
  } else {
    reserve(60)
    const chart = chartFrame(doc, 'Surface temperature (°C) — unavailable', margin, y, contentWidth, 38, ['—', '—', '—'])
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(105, 115, 128)
    doc.text('No terrain/thermal samples returned for this site and interval.', chart.chartX + chart.chartWidth / 2, chart.chartY + 21, { align: 'center' })
    addChartDates(doc, chart, request.startMs, request.endMs)
    y += 62
  }
  reserve(61)
  addPowerChart(doc, powerSamples, request.startMs, request.endMs, margin, y, contentWidth)
  y += 62
  reserve(63)
  addStationDsnChart(doc, dsnSamples, request.startMs, request.endMs, margin, y, contentWidth)

  newPage()
  section('Combined DSN link')
  paragraph('The step line is the number of stations connected at each time: 0 means no link, 1 means one station, 2 means two simultaneous links, and 3 means all three.')
  reserve(75)
  addDsnSumChart(doc, dsnSamples, request.startMs, request.endMs, margin, y, contentWidth)
  y += 76
  const landingWindows = dsnSummary.bestWindows
  section('Landing windows with at least one DSN link')
  if (landingWindows.length) {
    table(landingWindows.map((window, index) => [
      `Window ${index + 1}`,
      `${fmtDateTime(window.start)} – ${fmtDateTime(window.end)} UTC (${((window.end - window.start) / HOUR_MS).toFixed(1)} h)`,
    ]))
  } else {
    paragraph('No interval with a sampled link from Goldstone, Madrid or Canberra was found. Increase sampling detail or choose another site/analysis interval.')
  }

  if (request.includeMap) {
    if (request.filterImages.length !== request.overlays.length) {
      throw new Error('A separate map image is required for every active filter.')
    }
    newPage()
    section('Close-up map views by active filter')
    paragraph('Each near-vertical image is centered on the selected coordinates and shows only the named analysis filter over the lunar basemap.')
    const images = new Map(request.filterImages.map((item) => [item.id, item]))
    for (const overlay of request.overlays) {
      const filterImage = images.get(overlay.id)
      if (!filterImage?.image) throw new Error(`The map image for “${overlay.title}” could not be captured.`)
      const image = doc.getImageProperties(filterImage.image)
      const imageSize = Math.min(82, contentWidth)
      const scale = Math.min(imageSize / image.width, imageSize / image.height)
      const imageWidth = image.width * scale
      const imageHeight = image.height * scale
      const caption = `${overlay.opacity === 1 ? 'Opacity 100%' : `Opacity ${Math.round(overlay.opacity * 100)}%`}. ${overlay.source}`
      const captionLines = doc.splitTextToSize(caption, contentWidth)
      reserve(13 + imageHeight + 5 + captionLines.length * 5 + 2)
      section(overlay.title)
      doc.addImage(filterImage.image, 'JPEG', margin + (contentWidth - imageWidth) / 2, y, imageWidth, imageHeight)
      y += imageHeight + 3
      paragraph(caption)
    }
  }

  const pageCount = doc.getNumberOfPages()
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(110, 120, 132)
    doc.text('ByteTheMoon · Technical site report', margin, pageHeight - 9)
    doc.text(`${page} / ${pageCount}`, pageWidth - margin, pageHeight - 9, { align: 'right' })
  }

  const safeName = request.site.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'lunar-site'
  doc.save(`ByteTheMoon-${safeName}-${fmtDate(request.startMs)}-${fmtDate(request.endMs)}.pdf`)
}

function addHorizonPanorama(
  doc: import('jspdf').jsPDF,
  site: Site,
  timeline: TimelineSample[],
  now: TimelineSample | undefined,
  x: number,
  y: number,
  width: number,
) {
  const W = 312, H = 160
  const pad = { left: 30, right: 8, top: 8, bottom: 18 }
  const scale = width / W
  const height = H * scale
  const plotWidth = W - pad.left - pad.right
  const plotHeight = H - pad.top - pad.bottom
  const bottom = pad.top + plotHeight
  const { lo, hi, step } = fitPanoramaRange(site.horizon, timeline, now)
  const px = (azimuth: number) => x + (pad.left + (azimuth / 360) * plotWidth) * scale
  const py = (elevation: number) => y + (pad.top + ((hi - elevation) / (hi - lo)) * plotHeight) * scale
  const plotTop = y + pad.top * scale
  const plotBottom = y + bottom * scale
  const plotLeft = x + pad.left * scale
  const plotRight = x + (pad.left + plotWidth) * scale
  const colors = {
    text: [55, 65, 81] as [number, number, number],
    grid: [226, 232, 240] as [number, number, number],
    zero: [148, 163, 184] as [number, number, number],
    terrain: [226, 232, 240] as [number, number, number],
    skyline: [71, 85, 105] as [number, number, number],
    sun: [191, 105, 0] as [number, number, number],
    earth: [0, 105, 174] as [number, number, number],
    border: [203, 213, 225] as [number, number, number],
  }

  doc.setFillColor(255, 255, 255)
  doc.setDrawColor(...colors.border)
  doc.setLineWidth(0.25)
  doc.roundedRect(x, y, width, height, 1.5, 1.5, 'FD')

  const elevationTicks: number[] = []
  for (let elevation = lo; elevation <= hi + 1e-9; elevation += step) elevationTicks.push(elevation)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  for (const elevation of elevationTicks) {
    const tickY = py(elevation)
    doc.setDrawColor(...(elevation === 0 ? colors.zero : colors.grid))
    doc.setLineWidth(elevation === 0 ? 0.35 : 0.2)
    doc.line(plotLeft, tickY, plotRight, tickY)
    doc.setTextColor(...colors.text)
    doc.text(`${elevation}°`, plotLeft - 1.5, tickY + 1, { align: 'right' })
  }

  for (const azimuth of [0, 90, 180, 270, 360]) {
    const tickX = px(azimuth)
    if (azimuth > 0 && azimuth < 360) {
      doc.setDrawColor(...colors.grid)
      doc.setLineWidth(0.2)
      doc.line(tickX, plotTop, tickX, plotBottom)
    }
    doc.setTextColor(...colors.text)
    doc.text(['N', 'E', 'S', 'W', 'N'][azimuth / 90], tickX, y + height - 2, {
      align: azimuth === 0 ? 'left' : azimuth === 360 ? 'right' : 'center',
    })
  }

  const drawTrack = (key: 'sun' | 'earth') => {
    const color = key === 'sun' ? colors.sun : colors.earth
    doc.setDrawColor(...color)
    doc.setLineWidth(0.45)
    for (let i = 1; i < timeline.length; i++) {
      const previous = timeline[i - 1]
      const current = timeline[i]
      const previousAz = key === 'sun' ? previous.sunAz : previous.earthAz
      const currentAz = key === 'sun' ? current.sunAz : current.earthAz
      if (Math.abs(currentAz - previousAz) > 180) continue
      const previousEl = key === 'sun' ? previous.sunEl : previous.earthEl
      const currentEl = key === 'sun' ? current.sunEl : current.earthEl
      const clipped = clipSegment(
        px(previousAz), py(previousEl), px(currentAz), py(currentEl),
        plotLeft, plotTop, plotRight, plotBottom,
      )
      if (clipped) doc.line(clipped[0], clipped[1], clipped[2], clipped[3])
    }
  }
  drawTrack('sun')
  drawTrack('earth')

  const terrainMask = site.horizon?.elevDeg.length ? site.horizon : undefined
  const terrain = terrainMask?.elevDeg ?? [0]
  const azStep = terrainMask?.azStepDeg ?? 360
  const terrainPoints = terrain.map((elevation, index) => [px(index * azStep), py(elevation)] as const)
  const firstPoint = terrainPoints[0]
  const lastPoint = terrainPoints[terrainPoints.length - 1]
  const skylinePoints = [...terrainPoints, [plotRight, py(terrain[0])] as const]
  doc.setFillColor(...colors.terrain)
  for (let i = 1; i < skylinePoints.length; i++) {
    const previous = skylinePoints[i - 1]
    const current = skylinePoints[i]
    doc.triangle(previous[0], previous[1], current[0], current[1], previous[0], plotBottom, 'F')
    doc.triangle(current[0], current[1], current[0], plotBottom, previous[0], plotBottom, 'F')
  }
  doc.setDrawColor(...colors.skyline)
  doc.setLineWidth(0.45)
  doc.line(plotLeft, plotBottom, firstPoint[0], firstPoint[1])
  for (let i = 1; i < terrainPoints.length; i++) {
    doc.line(terrainPoints[i - 1][0], terrainPoints[i - 1][1], terrainPoints[i][0], terrainPoints[i][1])
  }
  doc.line(lastPoint[0], lastPoint[1], plotRight, py(terrain[0]))
  doc.line(plotRight, py(terrain[0]), plotRight, plotBottom)

  if (now) {
    drawPanoramaBody(doc, px(now.sunAz), py(now.sunEl), plotTop, colors.sun)
    drawPanoramaBody(doc, px(now.earthAz), py(now.earthEl), plotTop, colors.earth)
  }
  return height
}

function clipSegment(
  x0: number, y0: number, x1: number, y1: number,
  left: number, top: number, right: number, bottom: number,
): [number, number, number, number] | undefined {
  const dx = x1 - x0, dy = y1 - y0
  let min = 0, max = 1
  for (const [p, q] of [[-dx, x0 - left], [dx, right - x0], [-dy, y0 - top], [dy, bottom - y0]]) {
    if (p === 0) {
      if (q < 0) return undefined
      continue
    }
    const ratio = q / p
    if (p < 0) min = Math.max(min, ratio)
    else max = Math.min(max, ratio)
    if (min > max) return undefined
  }
  return [x0 + min * dx, y0 + min * dy, x0 + max * dx, y0 + max * dy]
}

function drawPanoramaBody(
  doc: import('jspdf').jsPDF,
  x: number,
  y: number,
  top: number,
  color: [number, number, number],
) {
  const radius = 1.2
  doc.setFillColor(...color)
  doc.setDrawColor(255, 255, 255)
  doc.setLineWidth(0.45)
  if (y < top) {
    doc.triangle(x, top, x + radius, top + radius * 1.6, x - radius, top + radius * 1.6, 'FD')
  } else {
    doc.circle(x, y, radius, 'FD')
  }
}

function chartFrame(
  doc: import('jspdf').jsPDF,
  title: string,
  x: number,
  y: number,
  width: number,
  plotHeight: number,
  labels: string[],
) {
  const chartX = x + 18, chartY = y + 6, chartWidth = width - 23
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(45, 54, 66)
  doc.text(title, x, y)
  doc.setDrawColor(170, 180, 191)
  doc.setLineWidth(0.25)
  doc.rect(chartX, chartY, chartWidth, plotHeight)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(90, 101, 114)
  labels.forEach((label, index) => {
    const gy = chartY + plotHeight * index / (labels.length - 1)
    if (index > 0 && index < labels.length - 1) {
      doc.setDrawColor(226, 231, 236)
      doc.line(chartX, gy, chartX + chartWidth, gy)
    }
    doc.text(label, x + 15, gy + 1, { align: 'right' })
  })
  return { chartX, chartY, chartWidth, plotHeight }
}

function addChartDates(doc: import('jspdf').jsPDF, chart: { chartX: number; chartY: number; chartWidth: number; plotHeight: number }, startMs: number, endMs: number) {
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.setTextColor(90, 101, 114)
  const label = (time: number) => endMs - startMs < 7 * DAY_MS ? fmtDateTime(time) : fmtDate(time)
  doc.text(label(startMs), chart.chartX, chart.chartY + chart.plotHeight + 4)
  doc.text(label(startMs + (endMs - startMs) / 2), chart.chartX + chart.chartWidth / 2, chart.chartY + chart.plotHeight + 4, { align: 'center' })
  doc.text(label(endMs), chart.chartX + chart.chartWidth, chart.chartY + chart.plotHeight + 4, { align: 'right' })
}

interface TimeBucketMean {
  start: number
  end: number
  mean: number
}

function meanBuckets<T>(samples: T[], startMs: number, endMs: number, timeOf: (sample: T) => number, valueOf: (sample: T) => number, maxBuckets: number): TimeBucketMean[] {
  const count = Math.min(maxBuckets, Math.max(4, Math.ceil(samples.length / 20)))
  const duration = (endMs - startMs) / count
  const buckets = Array.from({ length: count }, (_, index) => ({
    start: startMs + index * duration,
    end: startMs + (index + 1) * duration,
    sum: 0,
    count: 0,
  }))
  for (const sample of samples) {
    const time = timeOf(sample), value = valueOf(sample)
    if (time < startMs || time > endMs || !Number.isFinite(value)) continue
    const index = Math.min(count - 1, Math.floor((time - startMs) / duration))
    const bucket = buckets[index]
    bucket.sum += value
    bucket.count++
  }
  return buckets
    .filter((bucket) => bucket.count > 0)
    .map(({ start, end, sum, count: sampleCount }) => ({ start, end, mean: sum / sampleCount }))
}

function drawMeanCurve(
  doc: import('jspdf').jsPDF,
  chart: { chartX: number; chartY: number; chartWidth: number; plotHeight: number },
  buckets: TimeBucketMean[],
  min: number,
  max: number,
  startMs: number,
  endMs: number,
  color: [number, number, number],
) {
  const px = (bucket: TimeBucketMean) => chart.chartX + (((bucket.start + bucket.end) / 2 - startMs) / (endMs - startMs)) * chart.chartWidth
  const py = (value: number) => chart.chartY + ((max - value) / (max - min)) * chart.plotHeight
  doc.setDrawColor(...color)
  doc.setFillColor(...color)
  doc.setLineWidth(0.7)
  let previous: TimeBucketMean | undefined
  for (const bucket of buckets) {
    if (previous && bucket.start - previous.end < 1) {
      doc.line(px(previous), py(previous.mean), px(bucket), py(bucket.mean))
    }
    doc.circle(px(bucket), py(bucket.mean), 0.8, 'F')
    previous = bucket
  }
}

function addTemperatureChart(
  doc: import('jspdf').jsPDF,
  samples: SiteTemperatureSample[],
  startMs: number,
  endMs: number,
  x: number,
  y: number,
  width: number,
) {
  const buckets = meanBuckets(samples, startMs, endMs, (sample) => sample.t, (sample) => sample.temperatureK - 273.15, 12)
  let low = Math.floor(Math.min(...buckets.map((bucket) => bucket.mean))), high = Math.ceil(Math.max(...buckets.map((bucket) => bucket.mean)))
  if (low === high) { low -= 1; high += 1 }
  const padding = Math.max(2, (high - low) * 0.08)
  low = Math.floor(low - padding)
  high = Math.ceil(high + padding)
  const chart = chartFrame(doc, 'Mean surface temperature (°C)', x, y, width, 38, [`${high}`, `${((high + low) / 2).toFixed(0)}`, `${low}`])
  drawMeanCurve(doc, chart, buckets, low, high, startMs, endMs, [190, 83, 42])
  addChartDates(doc, chart, startMs, endMs)
}

function addPowerChart(
  doc: import('jspdf').jsPDF,
  samples: PowerSample[],
  startMs: number,
  endMs: number,
  x: number,
  y: number,
  width: number,
) {
  const buckets = meanBuckets(samples, startMs, endMs, (sample) => sample.t, (sample) => sample.power, 120)
  const peak = Math.max(...buckets.map((bucket) => bucket.mean))
  const top = peak > 0 ? Math.ceil(peak / 10) * 10 : 1
  const chart = chartFrame(doc, 'Mean solar-array power generation (W)', x, y, width, 38, [`${top.toFixed(0)}`, `${(top / 2).toFixed(0)}`, '0'])
  drawMeanCurve(doc, chart, buckets, 0, top, startMs, endMs, [39, 127, 105])
  addChartDates(doc, chart, startMs, endMs)
}

function addStationDsnChart(
  doc: import('jspdf').jsPDF,
  samples: DsnSample[],
  startMs: number,
  endMs: number,
  x: number,
  y: number,
  width: number,
) {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(45, 54, 66)
  doc.text('Individual station links (0 = no link, 1 = link)', x, y)
  const chartX = x + 47, chartY = y + 7, chartWidth = width - 52, laneHeight = 13
  const stateY = (lane: number, state: boolean) => chartY + lane * laneHeight + (state ? 2 : 10)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  for (let lane = 0; lane < DSN_STATIONS.length; lane++) {
    const station = DSN_STATIONS[lane]
    const top = chartY + lane * laneHeight
    doc.setTextColor(70, 81, 94)
    doc.text(`${station.name} (${station.antenna.split(' ')[0]})`, x, top + 7)
    doc.text('1', chartX - 4, stateY(lane, true) + 1)
    doc.text('0', chartX - 4, stateY(lane, false) + 1)
    for (const state of [true, false]) {
      doc.setDrawColor(225, 230, 235)
      doc.setLineWidth(0.2)
      doc.line(chartX, stateY(lane, state), chartX + chartWidth, stateY(lane, state))
    }
    const px = (time: number) => chartX + ((time - startMs) / (endMs - startMs)) * chartWidth
    doc.setDrawColor(
      parseInt(station.color.slice(1, 3), 16),
      parseInt(station.color.slice(3, 5), 16),
      parseInt(station.color.slice(5, 7), 16),
    )
    doc.setLineWidth(0.7)
    let runStart = samples[0].t
    let runState = !!samples[0].st[station.id]?.link
    for (let i = 1; i < samples.length; i++) {
      const state = !!samples[i].st[station.id]?.link
      if (state === runState) continue
      const transition = px(samples[i].t), currentY = stateY(lane, runState), nextY = stateY(lane, state)
      doc.line(px(runStart), currentY, transition, currentY)
      doc.line(transition, currentY, transition, nextY)
      runStart = samples[i].t
      runState = state
    }
    doc.line(px(runStart), stateY(lane, runState), px(samples[samples.length - 1].t), stateY(lane, runState))
  }
  const chartEnd = chartY + DSN_STATIONS.length * laneHeight + 2
  doc.setTextColor(90, 101, 114)
  const dateLabel = (time: number) => endMs - startMs < 7 * DAY_MS ? fmtDateTime(time) : fmtDate(time)
  doc.text(dateLabel(startMs), chartX, chartEnd)
  doc.text(dateLabel(startMs + (endMs - startMs) / 2), chartX + chartWidth / 2, chartEnd, { align: 'center' })
  doc.text(dateLabel(endMs), chartX + chartWidth, chartEnd, { align: 'right' })
}

function addDsnSumChart(
  doc: import('jspdf').jsPDF,
  samples: DsnSample[],
  startMs: number,
  endMs: number,
  x: number,
  y: number,
  width: number,
) {
  const chart = chartFrame(doc, 'Number of DSN stations in link (0–3)', x, y, width, 42, ['3', '2', '1', '0'])
  const px = (time: number) => chart.chartX + ((time - startMs) / (endMs - startMs)) * chart.chartWidth
  const py = (count: number) => chart.chartY + (1 - count / 3) * chart.plotHeight
  doc.setDrawColor(76, 91, 128)
  doc.setLineWidth(0.8)
  const linkedCount = (sample: DsnSample) => DSN_STATIONS.filter((station) => sample.st[station.id]?.link).length
  let runStart = samples[0].t
  let runCount = linkedCount(samples[0])
  for (let i = 1; i < samples.length; i++) {
    const count = linkedCount(samples[i])
    if (count === runCount) continue
    const transition = px(samples[i].t)
    doc.line(px(runStart), py(runCount), transition, py(runCount))
    doc.line(transition, py(runCount), transition, py(count))
    runStart = samples[i].t
    runCount = count
  }
  doc.line(px(runStart), py(runCount), px(samples[samples.length - 1].t), py(runCount))
  addChartDates(doc, chart, startMs, endMs)
}
