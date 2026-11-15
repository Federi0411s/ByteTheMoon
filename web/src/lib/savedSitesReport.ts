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
  const setTextColor = (hex: string) => {
    const color = hex.replace('#', '')
    doc.setTextColor(
      Number.parseInt(color.slice(0, 2), 16),
      Number.parseInt(color.slice(2, 4), 16),
      Number.parseInt(color.slice(4, 6), 16),
    )
  }
  const criterionLines = (criteria: CriterionResult[], columnWidth: number) => {
    doc.setFontSize(8.5)
    return criteria.map((criterion) => {
      const suffix = ` · ${CLASS_INFO[criterion.cls].label} (${criterion.value})`
      doc.setFont('helvetica', 'bold')
      const nameWidth = doc.getTextWidth(criterion.name)
      return {
        criterion,
        nameWidth,
        suffixLines: doc.splitTextToSize(suffix, Math.max(12, columnWidth - nameWidth)),
      }
    })
  }

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
  heading('Site ranking')

  comparisons.forEach((comparison, index) => {
    const padding = 4
    const columnGap = 9
    const columnWidth = (width - padding * 2 - columnGap) / 2
    const strongLines = criterionLines(strengths(comparison), columnWidth)
    const weakLines = criterionLines(weaknesses(comparison), columnWidth)
    const title = `#${index + 1} · ${comparison.site.name}`
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    const titleLines = doc.splitTextToSize(title, width - padding * 2 - 27)
    const headerHeight = titleLines.length * 4.4
    const contentHeight = (items: ReturnType<typeof criterionLines>) =>
      items.length ? items.reduce((total, item) => total + item.suffixLines.length * 4.2 + 1.2, 0) : 5
    const columnsHeight = Math.max(contentHeight(strongLines), contentHeight(weakLines))
    const cardHeight = 5 + headerHeight + 4 + 5 + 2 + columnsHeight + 2 + 5 + 5
    reserve(cardHeight + 4)

    const cardTop = y
    const titleY = cardTop + 5
    const sectionY = titleY + headerHeight + 4
    const contentY = sectionY + 5
    const dividerY = contentY + columnsHeight + 2
    const evaY = dividerY + 5
    const leftX = margin + padding
    const rightX = leftX + columnWidth + columnGap

    doc.setFillColor(250, 251, 253)
    doc.setDrawColor(205, 214, 225)
    doc.setLineWidth(0.25)
    doc.roundedRect(margin, cardTop, width, cardHeight, 2, 2, 'FD')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(33, 54, 80)
    doc.text(titleLines, leftX, titleY)
    setTextColor('#ff8a3d')
    doc.text(`${Math.round(comparison.score.score)} / 100`, pageWidth - margin - padding, titleY, { align: 'right' })

    doc.setFontSize(8.5)
    doc.setTextColor(75, 86, 100)
    doc.text('Strengths', leftX, sectionY)
    doc.text('Weaknesses', rightX, sectionY)

    const drawCriteria = (items: ReturnType<typeof criterionLines>, x: number, empty: string) => {
      if (!items.length) {
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8.5)
        doc.setTextColor(110, 120, 132)
        doc.text(empty, x, contentY)
        return
      }
      let lineY = contentY
      for (const item of items) {
        setTextColor(CLASS_INFO[item.criterion.cls].color)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(8.5)
        doc.text(item.criterion.name, x, lineY)
        doc.setFont('helvetica', 'normal')
        doc.text(item.suffixLines[0], x + item.nameWidth, lineY)
        for (let line = 1; line < item.suffixLines.length; line++) {
          doc.text(item.suffixLines[line], x, lineY + line * 4.2)
        }
        lineY += item.suffixLines.length * 4.2 + 1.2
      }
    }
    drawCriteria(strongLines, leftX, 'No criteria in the feasible range.')
    drawCriteria(weakLines, rightX, 'No difficult or infeasible criteria.')

    doc.setDrawColor(205, 214, 225)
    doc.line(margin + padding, dividerY, pageWidth - margin - padding, dividerY)
    setTextColor('#35c98b')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.text(`EVA: ${comparison.human.verdict} · longest walk ${comparison.human.walk.value}`, leftX, evaY)
    y = cardTop + cardHeight + 4
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
