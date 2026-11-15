import { useState, type FormEvent } from 'react'
import type { SiteSummary, TimelineSample } from '../lib/analysis'
import type { Site } from '../lib/data'
import type { DsnSample } from '../lib/dsn'
import { DsnPanel } from './DsnPanel'
import { PowerPanel } from './PowerPanel'
import { ScorePanel } from './ScorePanel'
import type { LandingScore } from '../lib/landingScore'
import type { HumanAssessment } from '../lib/human'
import type { AdvancedSettings } from '../lib/advancedSettings'
import { EnvPanel, type SiteEnv } from './EnvPanel'
import type { PanelConfig, PowerSummary } from '../lib/power'
import { Panorama } from './Panorama'
import { TerrainPreview } from './TerrainPreview'
import { TimelineBars } from './TimelineBars'
import { SavedSitesMenu } from './SavedSitesMenu'
import type { SavedSiteComparison } from '../lib/savedSiteComparison'

const fmtDur = (ms: number | null) => {
  if (ms === null) return '—'
  const h = ms / 3600_000
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(0)} h`
}

function SavedSiteEditor({ site, onSave, onRemove }: { site: Site; onSave: (name: string) => void; onRemove: () => void }) {
  const [siteName, setSiteName] = useState(site.name)
  return (
    <div className="saved-site-form">
      <input type="text" value={siteName} onChange={(e) => setSiteName(e.target.value)}
        aria-label="Landing site name" maxLength={60} />
      <button onClick={() => onSave(siteName)} disabled={!siteName.trim()}>
        {site.group === 'Saved' ? 'Save name' : 'Add to Landing Sites'}
      </button>
      {site.group === 'Saved' && <button className="saved-site-remove" onClick={onRemove}>Remove</button>}
    </div>
  )
}

function CoordinateSearch({ onSearch }: { onSearch: (lat: number, lon: number) => void }) {
  const [coordinates, setCoordinates] = useState('')
  const [error, setError] = useState<string>()

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parts = coordinates.trim().split(/[,\s;]+/).filter(Boolean)
    if (parts.length !== 2) {
      setError('Enter latitude and longitude, e.g. -89.5, 135.2.')
      return
    }

    const [lat, lon] = parts.map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setError('Coordinates must be valid numbers.')
      return
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setError('Latitude must be between -90° and 90°; longitude between -180° and 180°.')
      return
    }

    setError(undefined)
    onSearch(lat, lon)
  }

  return (
    <form className="coordinate-search" onSubmit={submit}>
      <label className="muted" htmlFor="coordinate-search-input">Go to coordinates</label>
      <div className="coordinate-search-row">
        <input id="coordinate-search-input" type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
          aria-label="Latitude and longitude" aria-invalid={!!error} placeholder="-89.5, 135.2" value={coordinates}
          onChange={(e) => { setCoordinates(e.target.value); setError(undefined) }} />
        <button type="submit" aria-label="Go to coordinates">Go</button>
      </div>
      {error && <p className="coordinate-error" role="alert">{error}</p>}
    </form>
  )
}

export function SitePanel({
  sites,
  selected,
  onSelect,
  onSearchCoordinates,
  onGenerateReport,
  reportDisabled,
  timeline,
  summary,
  now,
  nowMs,
  periodLabel,
  inspect,
  expanded,
  onToggleExpanded,
  onClose,
  onSaveSite,
  onRemoveSite,
  savedSites,
  comparisonPeriod,
  comparisonPeriodLabel,
  savedSitesError,
  comparisonDisabledReason,
  compareSavedSites,
  showSiteMarkers,
  onShowSiteMarkersChange,
  env,
  dsn,
  power,
  landing,
  terrainViewActive,
  terrainViewLoading,
  terrainViewError,
  onToggleTerrainView,
}: {
  sites: Site[]
  selected?: Site
  onSelect: (s: Site) => void
  onSearchCoordinates: (lat: number, lon: number) => void
  onGenerateReport: () => void
  reportDisabled: boolean
  timeline: TimelineSample[]
  summary?: SiteSummary
  now?: TimelineSample
  nowMs: number
  periodLabel: string
  inspect?: { lat: number; lon: number; values: { title: string; value: string }[] }
  expanded: boolean
  onToggleExpanded: () => void
  /** close the analysis of the selected point / site */
  onClose: () => void
  onSaveSite: (name: string) => void
  onRemoveSite: () => void
  savedSites: Site[]
  comparisonPeriod: [number, number]
  comparisonPeriodLabel: string
  savedSitesError?: string
  comparisonDisabledReason?: string
  compareSavedSites: (onProgress: (completed: number, total: number) => void, signal: AbortSignal) => Promise<SavedSiteComparison[]>
  showSiteMarkers: boolean
  onShowSiteMarkersChange: (show: boolean) => void
  dsn?: { now?: DsnSample }
  env?: { env?: SiteEnv; loading: boolean }
  power?: { panel: PanelConfig; onPanel: (p: PanelConfig) => void; summary?: PowerSummary }
  landing?: { result: LandingScore; period: [number, number]; periodLabel: string; human?: HumanAssessment; settings: AdvancedSettings }
  terrainViewActive: boolean
  terrainViewLoading: boolean
  terrainViewError?: string
  onToggleTerrainView: () => void
}) {
  const groups = [...new Set(sites.map((s) => s.group))]
  return (
    <section className="panel" id="landing-sites-panel">
      <div className="site-panel-heading">
        <h2>Landing sites</h2>
        <button className="site-panel-expand" onClick={onToggleExpanded} aria-expanded={expanded} aria-controls="landing-sites-panel"
          aria-label={expanded ? 'Collapse landing sites panel' : 'Expand landing sites panel'}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        {(selected || inspect) && (
          <button className="site-panel-close" onClick={onClose} title="Close the analysis of this point" aria-label="Close the analysis of this point">✕</button>
        )}
      </div>
      <div className="site-legend">
        <span><i className="marker-dot past" aria-hidden="true" />Past missions</span>
        <span><i className="marker-dot future" aria-hidden="true" />Artemis mission LS</span>
        <span><i className="marker-dot saved" aria-hidden="true" />My landing sites</span>
        <span><i className="marker-dot selected" aria-hidden="true" />Selected point</span>
      </div>
      <label className="layer-head" title="Show or hide mission and candidate markers on the map.">
        <input type="checkbox" checked={showSiteMarkers} onChange={(e) => onShowSiteMarkersChange(e.target.checked)} />
        Show landing-site markers
      </label>
      <CoordinateSearch onSearch={onSearchCoordinates} />
      <select value={selected?.id ?? ''} onChange={(e) => { const s = sites.find((x) => x.id === e.target.value); if (s) onSelect(s) }} aria-label="Site">
        <option value="" disabled>Choose a site…</option>
        {selected?.group === 'Custom' && <option value={selected.id}>{selected.name}</option>}
        {groups.map((g) => (
          <optgroup key={g} label={g === 'Saved' ? 'My landing sites' : g}>
            {sites.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        ))}
      </select>
      <SavedSitesMenu
        sites={savedSites}
        onSelect={onSelect}
        period={comparisonPeriod}
        periodLabel={comparisonPeriodLabel}
        comparisonDisabledReason={comparisonDisabledReason}
        compare={compareSavedSites}
      />
      <p className="muted">Click the map or search coordinates to inspect and analyse a custom landing site.</p>
      {landing && <ScorePanel {...landing} />}
      {savedSitesError && <p className="site-save-error" role="alert">{savedSitesError}</p>}

      {inspect && (
        <div className="inspect">
          <h3>{inspect.lat.toFixed(3)}°, {inspect.lon.toFixed(3)}°</h3>
          {inspect.values.map((v) => <div key={v.title} className="kv"><span>{v.title}</span><b>{v.value}</b></div>)}
        </div>
      )}

      {selected && (
        <>
          {(selected.group === 'Custom' || selected.group === 'Saved') && (
            <SavedSiteEditor key={selected.id} site={selected} onSave={onSaveSite} onRemove={onRemoveSite} />
          )}
          <h3>{selected.name}</h3>
          <p className="muted">
            {selected.lat.toFixed(3)}°, {selected.lon.toFixed(3)}° · horizon: {selected.horizon ? selected.horizon.source : 'flat (no terrain data here)'}
          </p>
          <TerrainPreview
            mask={selected.horizon}
            active={terrainViewActive}
            loading={terrainViewLoading}
            onClick={onToggleTerrainView}
          />
          {terrainViewError && <p className="terrain-view-error" role="alert">{terrainViewError}</p>}
          {now && (
            <div className="kv-grid">
              <div className="kv"><span>Elevation</span><b>{selected.heightM === undefined ? '—' : `${selected.heightM.toFixed(0)} m`}</b></div>
              <div className="kv"><span>Sun elevation</span><b>{now.sunEl.toFixed(1)}°</b></div>
              <div className="kv"><span>Sun disc visible</span><b>{(now.sunVisibleFrac * 100).toFixed(0)}%</b></div>
              <div className="kv"><span>Earth elevation</span><b>{now.earthEl.toFixed(1)}°</b></div>
              <div className="kv"><span>Earth visible</span><b>{(now.earthVisibleFrac * 100).toFixed(0)}%</b></div>
            </div>
          )}
          <Panorama mask={selected.horizon} timeline={timeline} now={now} />
          <div className="row"><span className="muted">{periodLabel} · sunlight and Earth visibility</span></div>
          <TimelineBars timeline={timeline} nowMs={nowMs} />
          {summary && (
            <div className="kv-grid">
              <div className="kv"><span>Sunlit</span><b>{summary.litPct.toFixed(0)}%</b></div>
              <div className="kv"><span>Earth in view</span><b>{summary.earthPct.toFixed(0)}%</b></div>
              <div className="kv"><span>Both</span><b>{summary.bothPct.toFixed(0)}%</b></div>
              <div className="kv"><span>Longest night</span><b>{fmtDur(summary.longestDarkH * 3600_000)}</b></div>
              <div className="kv"><span>Time to sunset</span><b>{fmtDur(summary.nextSunsetMs)}</b></div>
              <div className="kv"><span>Time to Earthset</span><b>{fmtDur(summary.nextEarthsetMs)}</b></div>
            </div>
          )}
          {env && <EnvPanel {...env} />}
          {dsn && <DsnPanel now={dsn.now} />}
          {power && <PowerPanel {...power} />}
          <button className="report-open-button" type="button" disabled={reportDisabled} onClick={onGenerateReport}>
            <span className="report-button-copy">
              <span className="report-button-title">Generate technical report (PDF)</span>
              <span className="report-button-note">Your mission report is ready for liftoff</span>
            </span>
            <span className="report-rocket" aria-hidden="true">
              <svg viewBox="0 0 56 56" fill="none">
                <path d="M28 5C21 13 19 22 20 31l8 7 8-7c1-9-1-18-8-26Z" fill="#141a2b" />
                <circle cx="28" cy="20" r="3.2" fill="#ffcf70" />
                <path d="m20 27-7 8 9-2m14-6 7 8-9-2M24 34l-2 7 6-3 6 3-2-7" />
                <path className="rocket-flame" d="M25 39c-1 4 0 7 3 10 3-3 4-6 3-10l-3 2Z" fill="#ff8a3d" />
              </svg>
            </span>
          </button>
          {reportDisabled && <p className="muted">Wait for the selected analysis interval data to finish loading before generating a report.</p>}
        </>
      )}
    </section>
  )
}
