import { useState, type FormEvent } from 'react'
import type { SiteSummary, TimelineSample } from '../lib/analysis'
import type { Site } from '../lib/data'
import { Panorama } from './Panorama'
import { TimelineBars } from './TimelineBars'

const fmtDur = (ms: number | null) => {
  if (ms === null) return '—'
  const h = ms / 3600_000
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(0)} h`
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
  timeline,
  summary,
  now,
  nowMs,
  windowDays,
  onWindowDays,
  inspect,
  expanded,
  onToggleExpanded,
  showSiteMarkers,
  onShowSiteMarkersChange,
}: {
  sites: Site[]
  selected?: Site
  onSelect: (s: Site) => void
  onSearchCoordinates: (lat: number, lon: number) => void
  timeline: TimelineSample[]
  summary?: SiteSummary
  now?: TimelineSample
  nowMs: number
  windowDays: number
  onWindowDays: (d: number) => void
  inspect?: { lat: number; lon: number; values: { title: string; value: string }[] }
  expanded: boolean
  onToggleExpanded: () => void
  showSiteMarkers: boolean
  onShowSiteMarkersChange: (show: boolean) => void
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
      </div>
      <div className="site-legend">
        <span><i className="marker-dot past" aria-hidden="true" />Past missions</span>
        <span><i className="marker-dot future" aria-hidden="true" />Future candidates</span>
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
          <optgroup key={g} label={g}>
            {sites.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        ))}
      </select>
      <p className="muted">Click the map or search coordinates to inspect and analyse a custom landing site.</p>

      {inspect && (
        <div className="inspect">
          <h3>{inspect.lat.toFixed(3)}°, {inspect.lon.toFixed(3)}°</h3>
          {inspect.values.map((v) => <div key={v.title} className="kv"><span>{v.title}</span><b>{v.value}</b></div>)}
        </div>
      )}

      {selected && (
        <>
          <h3>{selected.name}</h3>
          <p className="muted">
            {selected.lat.toFixed(3)}°, {selected.lon.toFixed(3)}° · horizon: {selected.horizon ? selected.horizon.source : 'flat (no terrain data here)'}
          </p>
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
          <div className="row">
            <span className="muted">Window</span>
            {[1, 3, 7, 30, 90, 365].map((d) => (
              <button key={d} className={d === windowDays ? 'on' : ''} onClick={() => onWindowDays(d)}>{d} d</button>
            ))}
          </div>
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
        </>
      )}
    </section>
  )
}
