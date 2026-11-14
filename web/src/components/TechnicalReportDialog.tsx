import { useEffect, useRef, useState } from 'react'
import type { Ephemeris } from '../lib/ephemeris'
import type { TimelineSample } from '../lib/analysis'
import { downloadTechnicalReport, type ReportFilterImage, type ReportOverlay } from '../lib/technicalReport'
import type { Site } from '../lib/data'
import { fmtDateTime } from '../lib/time'

export function TechnicalReportDialog({
  site,
  ephemeris,
  panoramaTimeline,
  panoramaNow,
  period,
  periodSource,
  overlays,
  captureMap,
  onClose,
}: {
  site: Site
  ephemeris: Ephemeris
  panoramaTimeline: TimelineSample[]
  panoramaNow?: TimelineSample
  period: [number, number]
  periodSource: string
  overlays: ReportOverlay[]
  captureMap: (site: Site, overlays: ReportOverlay[]) => Promise<ReportFilterImage[]>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [includeSiteDetails, setIncludeSiteDetails] = useState(true)
  const [includePeriodAnalysis, setIncludePeriodAnalysis] = useState(true)
  const [includeMap, setIncludeMap] = useState(overlays.length > 0)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])

  const generate = async () => {
    setGenerating(true)
    setError(undefined)
    try {
      const filterImages = includeMap ? await captureMap(site, overlays) : []
      await downloadTechnicalReport({
        site,
        ephemeris,
        panoramaTimeline,
        panoramaNow,
        startMs: period[0],
        endMs: period[1],
        includeSiteDetails,
        includePeriodAnalysis,
        includeMap,
        filterImages,
        overlays,
      })
      onClose()
    } catch (reason) {
      setError(`The report could not be generated: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="report-dialog"
      aria-labelledby="report-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!generating) onClose()
      }}
    >
      <header className="report-dialog-header">
        <div>
          <p className="report-eyebrow">BYTETHEMOON · DOCUMENTATION</p>
          <h2 id="report-dialog-title">Technical site report</h2>
        </div>
        <button type="button" aria-label="Close report dialog" disabled={generating} onClick={onClose}>×</button>
      </header>

      <div className="report-dialog-body">
        <p className="muted">
          Select the sections to include. The UTC interval matches the active Mission period, so the analysis and map layers use the same dates.
        </p>
        <p className="muted">The report always includes the selected point’s 360° terrain horizon with Sun and Earth tracks.</p>

        <section className="report-period">
          <h3>Mission interval</h3>
          <div className="report-date-row"><span>Start (UTC)</span><output>{fmtDateTime(period[0])}</output></div>
          <div className="report-date-row"><span>End (UTC)</span><output>{fmtDateTime(period[1])}</output></div>
          <p className="muted">Source: {periodSource}. Change dates in the Mission period panel before opening this report.</p>
        </section>

        <section className="report-sections">
          <h3>Report contents</h3>
          <label>
            <input type="checkbox" checked={includeSiteDetails} onChange={(event) => setIncludeSiteDetails(event.target.checked)} disabled={generating} />
            Site and terrain details
          </label>
          <label>
            <input type="checkbox" checked={includePeriodAnalysis} onChange={(event) => setIncludePeriodAnalysis(event.target.checked)} disabled={generating} />
            Illumination and Earth visibility for the full interval
          </label>
          <label title={overlays.length ? undefined : 'Enable one or more map layers before opening the report.'}>
            <input type="checkbox" checked={includeMap} onChange={(event) => setIncludeMap(event.target.checked)} disabled={generating || overlays.length === 0} />
            One close-up map image per active filter
          </label>
          {overlays.length > 0 ? (
            <ul className="report-overlay-list">
              {overlays.map((overlay) => <li key={overlay.id}>{overlay.title} · {Math.round(overlay.opacity * 100)}%</li>)}
            </ul>
          ) : (
            <p className="muted">Enable at least one map layer to include a filtered map image.</p>
          )}
        </section>

        {error && <p className="report-error" role="alert">{error}</p>}
      </div>

      <footer className="report-dialog-footer">
        <button type="button" disabled={generating} onClick={onClose}>Cancel</button>
        <button type="button" className="report-primary" disabled={generating} onClick={() => void generate()}>
          {generating ? 'Preparing PDF…' : 'Generate and download PDF'}
        </button>
      </footer>
    </dialog>
  )
}
