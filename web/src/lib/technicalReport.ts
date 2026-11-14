import { computeTimeline, type TimelineSample } from './analysis'
import type { Ephemeris } from './ephemeris'
import type { Site } from './data'
import { fitPanoramaRange } from './panorama'
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
  panoramaTimeline: TimelineSample[]
  panoramaNow?: TimelineSample
  startMs: number
  endMs: number
  includeSiteDetails: boolean
  includePeriodAnalysis: boolean
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
  const keyValue = (label: string, value: string) => paragraph(`${label}: ${value}`)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(19)
  doc.setTextColor(20, 38, 61)
  doc.text('ByteTheMoon', margin, y)
  y += 8
  doc.setFontSize(13)
  doc.text('TECHNICAL LUNAR SITE REPORT', margin, y)
  y += 7
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(85, 98, 116)
  doc.text(`Generated ${fmtDateTime(Date.now())} UTC`, margin, y)
  y += 9

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(28, 38, 50)
  doc.text(request.site.name, margin, y)
  y += 7
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  const latHemisphere = request.site.lat < 0 ? 'S' : 'N'
  const lonHemisphere = request.site.lon < 0 ? 'W' : 'E'
  keyValue('Coordinates', `${Math.abs(request.site.lat).toFixed(5)}° ${latHemisphere}, ${Math.abs(request.site.lon).toFixed(5)}° ${lonHemisphere}`)
  keyValue('Mission interval (UTC)', `${fmtDateTime(request.startMs)} – ${fmtDateTime(request.endMs)}`)
  keyValue('Elapsed time', `${((request.endMs - request.startMs) / DAY_MS).toFixed(2)} days`)

  if (request.includeSiteDetails) {
    section('Site and terrain')
    keyValue('Site category', request.site.group)
    keyValue('Elevation', request.site.heightM === undefined ? 'Unavailable' : `${request.site.heightM.toFixed(1)} m above the reference sphere`)
    keyValue('Terrain horizon', request.site.horizon?.source ?? 'Unavailable; flat horizon assumed for visibility analysis')
    if (request.site.note) keyValue('Site note', request.site.note)
  }

  const panoramaHeightEstimate = contentWidth * 160 / 312
  reserve(panoramaHeightEstimate + 36)
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
  if (request.panoramaTimeline.length) {
    const first = request.panoramaTimeline[0].t
    const last = request.panoramaTimeline[request.panoramaTimeline.length - 1].t
    paragraph(`Active analysis window: ${fmtDateTime(first)}–${fmtDateTime(last)} UTC; current position: ${request.panoramaNow ? fmtDateTime(request.panoramaNow.t) : 'unavailable'} UTC.`)
  }

  if (request.includePeriodAnalysis) {
    section('Mission-period illumination and communications')
    const spanMs = request.endMs - request.startMs
    const stepMs = Math.min(spanMs, spanMs > 365 * DAY_MS ? 6 * HOUR_MS : HOUR_MS)
    const samples = computeTimeline(
      request.ephemeris,
      request.site,
      request.site.horizon,
      request.startMs,
      request.endMs,
      stepMs,
    )
    if (samples.length < 2) throw new Error('The selected interval is too short to analyse.')
    if (samples[samples.length - 1].t < request.endMs) {
      samples.push(...computeTimeline(request.ephemeris, request.site, request.site.horizon, request.endMs, request.endMs, stepMs))
    }
    const stats = periodStats(samples, request.endMs)
    keyValue('Sun visible (>50% of disc)', `${stats.sunPct.toFixed(1)}% of the interval`)
    keyValue('Earth visible (>50% of disc)', `${stats.earthPct.toFixed(1)}% of the interval`)
    keyValue('Sun and Earth simultaneously visible', `${stats.bothPct.toFixed(1)}% of the interval`)
    keyValue('Longest estimated uninterrupted night', `${stats.longestDarkHours.toFixed(1)} h`)
    paragraph(`Visibility is evaluated with ${stepMs / HOUR_MS}-hour sampling against the selected terrain horizon. Percentages are time-weighted; the longest night is an estimate at the sampling resolution.`)
    reserve(76)
    addVisibilityChart(doc, samples, request.startMs, request.endMs, margin, y, contentWidth)
    y += 76
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

function addVisibilityChart(
  doc: import('jspdf').jsPDF,
  samples: TimelineSample[],
  startMs: number,
  endMs: number,
  x: number,
  y: number,
  width: number,
) {
  const chartX = x + 13, chartY = y + 5, chartWidth = width - 18, chartHeight = 48
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor(45, 54, 66)
  doc.text('Visible fraction over time', x, y)
  doc.setDrawColor(130, 140, 153)
  doc.setLineWidth(0.25)
  doc.rect(chartX, chartY, chartWidth, chartHeight)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(105, 115, 128)
  for (const pct of [0, 50, 100]) {
    const gy = chartY + chartHeight * (1 - pct / 100)
    doc.setDrawColor(220, 224, 229)
    if (pct > 0 && pct < 100) doc.line(chartX, gy, chartX + chartWidth, gy)
    doc.text(`${pct}%`, x, gy + 1)
  }
  const stride = Math.max(1, Math.ceil(samples.length / 900))
  const drawSeries = (key: 'sunVisibleFrac' | 'earthVisibleFrac', color: [number, number, number]) => {
    doc.setDrawColor(...color)
    doc.setLineWidth(0.45)
    let previous: [number, number] | undefined
    for (let i = 0; i < samples.length; i += stride) {
      const sample = samples[i]
      const point: [number, number] = [
        chartX + ((sample.t - startMs) / (endMs - startMs)) * chartWidth,
        chartY + (1 - sample[key]) * chartHeight,
      ]
      if (previous) doc.line(previous[0], previous[1], point[0], point[1])
      previous = point
    }
    const last = samples[samples.length - 1]
    const endPoint: [number, number] = [chartX + chartWidth, chartY + (1 - last[key]) * chartHeight]
    if (previous) doc.line(previous[0], previous[1], endPoint[0], endPoint[1])
  }
  drawSeries('sunVisibleFrac', [235, 149, 48])
  drawSeries('earthVisibleFrac', [56, 132, 190])
  doc.setFillColor(235, 149, 48)
  doc.circle(chartX + 5, chartY + chartHeight + 7, 1.1, 'F')
  doc.setTextColor(85, 95, 107)
  doc.text('Sun', chartX + 8, chartY + chartHeight + 8)
  doc.setFillColor(56, 132, 190)
  doc.circle(chartX + 25, chartY + chartHeight + 7, 1.1, 'F')
  doc.text('Earth', chartX + 28, chartY + chartHeight + 8)
  doc.text(fmtDate(startMs), chartX, chartY + chartHeight + 15)
  doc.text(fmtDate(endMs), chartX + chartWidth, chartY + chartHeight + 15, { align: 'right' })
}
