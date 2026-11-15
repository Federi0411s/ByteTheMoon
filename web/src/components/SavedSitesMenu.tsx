import { useEffect, useMemo, useRef, useState } from 'react'
import type { Site } from '../lib/data'
import { CLASS_INFO, type CriterionResult } from '../lib/landingScore'
import { downloadSavedSitesReport } from '../lib/savedSitesReport'
import type { SavedSiteComparison } from '../lib/savedSiteComparison'
import { fmtDateTime } from '../lib/time'

const CRITERIA: CriterionResult['id'][] = ['temperature', 'radiation', 'slope', 'telecom', 'sunlight']

function strengths(site: SavedSiteComparison) {
  return site.score.criteria.filter((criterion) => criterion.cls === 'recommended' || criterion.cls === 'feasible')
}

function weaknesses(site: SavedSiteComparison) {
  return site.score.criteria.filter((criterion) => criterion.cls === 'difficult' || criterion.cls === 'not-feasible')
}

function CriterionPills({ criteria, empty }: { criteria: CriterionResult[]; empty: string }) {
  return criteria.length ? (
    <ul className="comparison-pills">
      {criteria.map((criterion) => (
        <li key={criterion.id} className={`comparison-${criterion.cls}`}>
          <b>{criterion.name}</b> · {CLASS_INFO[criterion.cls].label} ({criterion.value})
        </li>
      ))}
    </ul>
  ) : <p className="muted">{empty}</p>
}

function SavedSitesComparisonDialog({
  sites,
  period,
  periodLabel,
  compare,
  onClose,
}: {
  sites: Site[]
  period: [number, number]
  periodLabel: string
  compare: (onProgress: (completed: number, total: number) => void, signal: AbortSignal) => Promise<SavedSiteComparison[]>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [results, setResults] = useState<SavedSiteComparison[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>(() => sites.map((site) => site.id))
  const [progress, setProgress] = useState({ completed: 0, total: sites.length })
  const [comparing, setComparing] = useState(false)
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [error, setError] = useState<string>()
  const [pdfError, setPdfError] = useState<string>()
  const selectedResults = useMemo(() => results.filter((result) => selectedIds.includes(result.site.id)), [results, selectedIds])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      abortRef.current?.abort()
      if (dialog?.open) dialog.close()
    }
  }, [])

  const close = () => {
    abortRef.current?.abort()
    onClose()
  }

  const runComparison = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setComparing(true)
    setError(undefined)
    setResults([])
    setProgress({ completed: 0, total: sites.length })
    try {
      const compared = await compare((completed, total) => setProgress({ completed, total }), controller.signal)
      if (!controller.signal.aborted) {
        setResults(compared)
        setSelectedIds(compared.map((result) => result.site.id))
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(`Comparison could not be completed: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      if (!controller.signal.aborted) setComparing(false)
    }
  }

  const generatePdf = async () => {
    setGeneratingPdf(true)
    setPdfError(undefined)
    try {
      await downloadSavedSitesReport(selectedResults, period, periodLabel)
    } catch (reason) {
      setPdfError(`The comparison PDF could not be generated: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setGeneratingPdf(false)
    }
  }

  const allSelected = selectedResults.length === results.length
  const best = results[0]
  return (
    <dialog
      ref={dialogRef}
      className="report-dialog saved-sites-dialog"
      aria-labelledby="saved-sites-dialog-title"
      onCancel={(event) => { event.preventDefault(); close() }}
    >
      <header className="report-dialog-header">
        <div>
          <p className="report-eyebrow">BYTETHEMOON · CANDIDATE ANALYSIS</p>
          <h2 id="saved-sites-dialog-title">Compare saved landing sites</h2>
        </div>
        <button type="button" aria-label="Close saved site comparison" onClick={close}>×</button>
      </header>

      <div className="report-dialog-body saved-sites-dialog-body">
        <p className="muted">
          Analysis period: {periodLabel} · {fmtDateTime(period[0])} – {fmtDateTime(period[1])} UTC.
          Sites are ranked by feasibility first, then average score.
        </p>
        {!results.length && !comparing && (
          <section className="saved-sites-confirm">
            <h3>Sites in this comparison ({sites.length})</h3>
            <ul>{sites.map((site) => <li key={site.id}>{site.name} · {site.lat.toFixed(3)}°, {site.lon.toFixed(3)}°</li>)}</ul>
            <button type="button" className="report-primary" onClick={() => void runComparison()}>
              Compare all saved sites
            </button>
          </section>
        )}

        {comparing && (
          <div className="comparison-progress" role="status">
            <span>Analyzing sites: {progress.completed} / {progress.total}</span>
            <progress value={progress.completed} max={Math.max(progress.total, 1)} />
            <button type="button" onClick={close}>Cancel analysis</button>
          </div>
        )}
        {error && <p className="report-error" role="alert">{error}</p>}

        {results.length > 0 && (
          <>
            <section className="comparison-best">
              <span>{best?.score.feasible ? 'Best feasible candidate' : 'Highest-scoring candidate (not fully feasible)'}</span>
              <strong>{best?.site.name}</strong>
              <b>{Math.round(best?.score.score ?? 0)} / 100</b>
              {!results.some((result) => result.score.feasible) && (
                <p className="muted">No saved site meets every feasibility threshold for this interval.</p>
              )}
            </section>

            <section>
              <h3>Score comparison</h3>
              <div className="comparison-table-wrap">
                <table className="comparison-table">
                  <thead>
                    <tr>
                      <th>Rank / site</th>
                      <th>Overall</th>
                      {CRITERIA.map((id) => <th key={id}>{id === 'telecom' ? 'DSN' : id === 'sunlight' ? 'Sunlight' : id[0].toUpperCase() + id.slice(1)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result, index) => (
                      <tr key={result.site.id}>
                        <th scope="row"><span className="comparison-rank">#{index + 1}</span> {result.site.name}</th>
                        <td className={result.score.feasible ? 'comparison-feasible' : 'comparison-not-feasible'}>
                          <b>{Math.round(result.score.score)} / 100</b>
                          <small>{result.score.feasible ? 'Feasible' : 'Not feasible'}</small>
                        </td>
                        {CRITERIA.map((id) => {
                          const criterion = result.score.criteria.find((item) => item.id === id)
                          return (
                            <td key={id} className={criterion ? `comparison-${criterion.cls}` : ''} title={criterion?.comment}>
                              <b>{criterion ? CLASS_INFO[criterion.cls].label : '—'}</b>
                              <small>{criterion?.value}</small>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="comparison-details">
              <h3>Strengths and weaknesses</h3>
              {results.map((result, index) => (
                <article className="comparison-site-card" key={result.site.id}>
                  <header>
                    <h4>#{index + 1} · {result.site.name}</h4>
                    <span>{Math.round(result.score.score)} / 100</span>
                  </header>
                  <div className="comparison-traits">
                    <div><b>Strengths</b><CriterionPills criteria={strengths(result)} empty="No criteria in the feasible range." /></div>
                    <div><b>Weaknesses</b><CriterionPills criteria={weaknesses(result)} empty="No difficult or infeasible criteria." /></div>
                  </div>
                  <p className={`comparison-eva comparison-${result.human.walks}`}>
                    EVA: {result.human.verdict} · longest walk {result.human.walk.value}
                  </p>
                </article>
              ))}
            </section>

            <section className="comparison-pdf-selection">
              <div className="comparison-selection-heading">
                <div>
                  <h3>Choose sites for the PDF</h3>
                  <p className="muted">Only checked sites will be included in the comparison report.</p>
                </div>
                <button type="button" onClick={() => setSelectedIds(allSelected ? [] : results.map((result) => result.site.id))}>
                  {allSelected ? 'Select none' : 'Select all'}
                </button>
              </div>
              <div className="comparison-checklist">
                {results.map((result, index) => (
                  <label key={result.site.id}>
                    <input type="checkbox" checked={selectedIds.includes(result.site.id)}
                      onChange={(event) => setSelectedIds((current) => event.target.checked
                        ? [...current, result.site.id]
                        : current.filter((id) => id !== result.site.id))} />
                    #{index + 1} · {result.site.name} · {Math.round(result.score.score)} / 100
                  </label>
                ))}
              </div>
              {pdfError && <p className="report-error" role="alert">{pdfError}</p>}
              <button type="button" className="report-primary comparison-pdf-button"
                disabled={!selectedResults.length || generatingPdf || comparing} onClick={() => void generatePdf()}>
                {generatingPdf ? 'Preparing comparison PDF…' : `Download PDF for ${selectedResults.length} site${selectedResults.length === 1 ? '' : 's'}`}
              </button>
            </section>
          </>
        )}
      </div>

      <footer className="report-dialog-footer">
        <button type="button" onClick={close}>Close</button>
        {results.length > 0 && (
          <button type="button" disabled={comparing || generatingPdf} onClick={() => void runComparison()}>
            Recalculate comparison
          </button>
        )}
      </footer>
    </dialog>
  )
}

export function SavedSitesMenu({
  sites,
  onSelect,
  period,
  periodLabel,
  comparisonDisabledReason,
  compare,
}: {
  sites: Site[]
  onSelect: (site: Site) => void
  period: [number, number]
  periodLabel: string
  comparisonDisabledReason?: string
  compare: (onProgress: (completed: number, total: number) => void, signal: AbortSignal) => Promise<SavedSiteComparison[]>
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const menuRef = useRef<HTMLDetailsElement>(null)
  const canCompare = sites.length > 1 && !comparisonDisabledReason

  return (
    <>
      <details className="menu-section saved-sites-menu" ref={menuRef}>
        <summary className="menu-section-summary">
          <span>My saved landing sites</span>
          <span className="menu-section-state">{sites.length} saved</span>
          <span className="menu-section-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="menu-section-body">
          {sites.length === 0 ? (
            <p className="muted">Sites you save from the map will appear here.</p>
          ) : (
            <>
              <div className="saved-sites-list">
                {sites.map((site) => (
                  <button type="button" className="saved-site-link" key={site.id}
                    onClick={() => { if (menuRef.current) menuRef.current.open = false; onSelect(site) }}>
                    <i className="marker-dot saved" aria-hidden="true" />
                    <span>{site.name}<small>{site.lat.toFixed(3)}°, {site.lon.toFixed(3)}°</small></span>
                  </button>
                ))}
              </div>
              <button type="button" className="saved-sites-compare-button" disabled={!canCompare}
                title={comparisonDisabledReason ?? (sites.length < 2 ? 'Save at least two sites to compare them.' : undefined)}
                onClick={() => setDialogOpen(true)}>
                Compare all saved sites
              </button>
              {comparisonDisabledReason ? (
                <p className="muted" role="status">{comparisonDisabledReason}</p>
              ) : sites.length < 2 ? (
                <p className="muted">Save at least two sites to compare candidates.</p>
              ) : (
                <p className="muted">Compares score criteria for the selected mission interval.</p>
              )}
            </>
          )}
        </div>
      </details>
      {dialogOpen && (
        <SavedSitesComparisonDialog
          sites={sites}
          period={period}
          periodLabel={periodLabel}
          compare={compare}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  )
}
