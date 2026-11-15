import { CLASS_INFO, type CriterionResult } from './landingScore'
import type { SavedSiteComparison } from './savedSiteComparison'
import { fmtDateTime } from './time'

export async function downloadSavedSitesReport(
  comparisons: SavedSiteComparison[],
  period: [number, number],
  periodLabel: string,
): Promise<void> {
  if (!comparisons.length) throw new Error('Select at least one landing site for the PDF report.')
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 17
  const width = pageWidth - margin * 2
  let y = margin

  const newPage = () => {
    doc.addPage()
    y = margin
  }
  const reserve = (height: number) => {
    if (y + height > pageHeight - margin) newPage()
  }
  const paragraph = (text: string, size = 9, indent = 0) => {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(size)
    const lines = doc.splitTextToSize(text, width - indent)
    const height = lines.length * 4.5 + 2
    reserve(height)
    doc.setTextColor(45, 54, 66)
    doc.text(lines, margin + indent, y)
    y += height
  }
  const heading = (text: string, size = 12) => {
    reserve(11)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(size)
    doc.setTextColor(33, 54, 80)
    doc.text(text, margin, y)
    y += 6
    doc.setDrawColor(170, 184, 201)
    doc.setLineWidth(0.35)
    doc.line(margin, y, pageWidth - margin, y)
    y += 5
  }
  const criterionText = (criterion: CriterionResult) =>
    `${criterion.name}: ${CLASS_INFO[criterion.cls].label} (${criterion.value})`
  const strengths = (site: SavedSiteComparison) =>
    site.score.criteria.filter((criterion) => criterion.cls === 'recommended' || criterion.cls === 'feasible')
  const weaknesses = (site: SavedSiteComparison) =>
    site.score.criteria.filter((criterion) => criterion.cls === 'difficult' || criterion.cls === 'not-feasible')

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.setTextColor(20, 38, 61)
  doc.text('ByteTheMoon', margin, y)
  y += 8
  doc.setFontSize(12)
  doc.text('SAVED LANDING SITE COMPARISON', margin, y)
  y += 7
  paragraph(`Generated ${fmtDateTime(Date.now())} UTC. Analysis period: ${periodLabel}, ${fmtDateTime(period[0])} – ${fmtDateTime(period[1])} UTC.`)
  paragraph('Ranking prioritizes feasible sites, then sorts by the average landing score. The score is the mean of temperature, radiation, slope, telecommunications and sunlight classes.')
  heading('Overall ranking')

  const columns = [10, 78, 28, 27, width - 143]
  const headers = ['#', 'Landing site', 'Score', 'Status', 'Coordinates']
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(75, 86, 100)
  let x = margin
  headers.forEach((header, index) => {
    doc.text(header, x + 1, y)
    x += columns[index]
  })
  y += 4
  doc.setDrawColor(190, 198, 208)
  doc.line(margin, y, pageWidth - margin, y)
  y += 4
  comparisons.forEach((comparison, index) => {
    const { site, score } = comparison
    const values = [
      `${index + 1}`,
      site.name,
      `${Math.round(score.score)} / 100`,
      score.feasible ? 'Feasible' : 'Not feasible',
      `${site.lat.toFixed(3)}°, ${site.lon.toFixed(3)}°`,
    ]
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    const cellLines = values.map((value, column) => doc.splitTextToSize(value, columns[column] - 3))
    const height = Math.max(7, ...cellLines.map((lines) => lines.length * 3.8 + 2))
    reserve(height)
    if (index % 2 === 0) {
      doc.setFillColor(245, 247, 250)
      doc.rect(margin, y - 3, width, height, 'F')
    }
    x = margin
    cellLines.forEach((lines, column) => {
      doc.setTextColor(column === 2 ? 33 : 45, column === 2 ? 54 : 54, column === 2 ? 80 : 66)
      doc.text(lines, x + 1, y)
      x += columns[column]
    })
    y += height
  })

  for (let index = 0; index < comparisons.length; index++) {
    const comparison = comparisons[index]
    newPage()
    heading(`${index + 1}. ${comparison.site.name}`, 14)
    paragraph(`${comparison.site.group} · ${comparison.site.lat.toFixed(5)}°, ${comparison.site.lon.toFixed(5)}°`)
    paragraph(`Overall score: ${Math.round(comparison.score.score)} / 100 · ${comparison.score.feasible ? 'Mission feasible' : 'Not feasible'}`, 11)

    heading('Score by criterion')
    comparison.score.criteria.forEach((criterion) => {
      const classInfo = CLASS_INFO[criterion.cls]
      reserve(13)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(33, 54, 80)
      doc.text(`${criterion.name} · ${classInfo.label} · ${criterion.value}`, margin, y)
      y += 4.5
      paragraph(criterion.comment, 8, 2)
    })

    heading('Strengths')
    const strong = strengths(comparison)
    if (strong.length) strong.forEach((criterion) => paragraph(criterionText(criterion), 9, 2))
    else paragraph('No criterion reached the feasible range.', 9, 2)

    heading('Weaknesses')
    const weak = weaknesses(comparison)
    if (weak.length) weak.forEach((criterion) => paragraph(criterionText(criterion), 9, 2))
    else paragraph('No criterion fell into the difficult or not-feasible range.', 9, 2)

    heading('Crew and EVA assessment')
    paragraph(`${comparison.human.verdict}. Longest walk: ${comparison.human.walk.value} (${comparison.human.walk.note}).`)
    paragraph(`Temperature: ${comparison.human.temp.value} · ${comparison.human.temp.note}. Radiation: ${comparison.human.rad.value} · ${comparison.human.rad.note}.`)
  }

  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(110, 120, 132)
    doc.text('ByteTheMoon · Saved landing site comparison', margin, pageHeight - 8)
    doc.text(`${page} / ${pages}`, pageWidth - margin, pageHeight - 8, { align: 'right' })
  }

  const date = new Date().toISOString().slice(0, 10)
  doc.save(`ByteTheMoon-saved-sites-comparison-${date}.pdf`)
}
