import { useEffect, useRef, useState } from 'react'
import type { Ephemeris } from '../lib/ephemeris'
import type { TimelineSample } from '../lib/analysis'
import { downloadTechnicalReport, type ReportFilterImage, type ReportOverlay } from '../lib/technicalReport'
import type { Site } from '../lib/data'
import type { HeatEngine } from '../lib/heatEngine'
import type { SiteEnv } from './EnvPanel'
import type { PanelConfig } from '../lib/power'
import { sampleSiteTemperatureTimeline } from '../lib/siteEnv'
import { fmtDateTime } from '../lib/time'

export function TechnicalReportDialog({
  site,
  ephemeris,
  heat,
  panel,
  env,
  panoramaTimeline,
  panoramaNow,
  currentMs,
  period,
  periodSource,
  overlays,
  captureMap,
  onClose,
}: {
  site: Site
  ephemeris: Ephemeris
  heat?: HeatEngine | null
  panel: PanelConfig
  env?: SiteEnv
  panoramaTimeline: TimelineSample[]
  panoramaNow?: TimelineSample
  currentMs: number
  period: [number, number]
  periodSource: string
  overlays: ReportOverlay[]
  captureMap: (site: Site, overlays: ReportOverlay[]) => Promise<ReportFilterImage[]>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [includeSiteDetails, setIncludeSiteDetails] = useState(true)
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
      if (heat && (heat.window[0] !== period[0] || heat.window[1] !== period[1])) {
        throw new Error('The thermal model is still preparing the selected analysis interval. Please try again in a moment.')
      }
      const [filterImages, temperatureTimeline] = await Promise.all([
        includeMap ? captureMap(site, overlays) : Promise.resolve([] as ReportFilterImage[]),
        heat
          ? sampleSiteTemperatureTimeline(heat, site.lat, site.lon)
          : Promise.resolve(null),
      ])
      await downloadTechnicalReport({
        site,
        ephemeris,
        panel,
        env,
        temperatureTimeline: temperatureTimeline ?? undefined,
        panoramaTimeline,
        panoramaNow,
        currentMs,
        startMs: period[0],
        endMs: period[1],
        periodSource,
        includeSiteDetails,
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
          The report includes a site data table and temperature, power-generation and DSN-contact timelines for the selected UTC interval below.
        </p>
        <p className="muted">Temperature and power are shown over time. Three separate binary DSN traces show each station’s link; a second chart shows how many are connected simultaneously.</p>

        <section className="report-period">
          <h3>Analysis interval</h3>
          <div className="report-date-row"><span>Start (UTC)</span><output>{fmtDateTime(period[0])}</output></div>
          <div className="report-date-row"><span>End (UTC)</span><output>{fmtDateTime(period[1])}</output></div>
          <p className="muted">Source: {periodSource}. Change dates in the Mission period panel before opening this report.</p>
        </section>

        <section className="report-sections">
          <h3>Report contents</h3>
          <label>
            <input type="checkbox" checked={includeSiteDetails} onChange={(event) => setIncludeSiteDetails(event.target.checked)} disabled={generating} />
            Include the optional site note
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
