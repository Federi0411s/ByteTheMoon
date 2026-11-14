import { useEffect, useState } from 'react'
import type { SiteSummary, TimelineSample } from '../lib/analysis'
import type { Site } from '../lib/data'
import { Panorama } from './Panorama'
import { TimelineBars } from './TimelineBars'

const fmtDur = (ms: number | null) => {
  if (ms === null) return '—'
  const h = ms / 3600_000
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(0)} h`
}

export function SitePanel({
  sites,
  selected,
  onSelect,
  timeline,
  summary,
  now,
  nowMs,
  windowDays,
  onWindowDays,
  inspect,
  expanded,
  onToggleExpanded,
  onSaveSite,
  onRemoveSite,
  savedSitesError,
}: {
  sites: Site[]
  selected?: Site
  onSelect: (s: Site) => void
  timeline: TimelineSample[]
  summary?: SiteSummary
  now?: TimelineSample
  nowMs: number
  windowDays: number
  onWindowDays: (d: number) => void
  inspect?: { lat: number; lon: number; values: { title: string; value: string }[] }
  expanded: boolean
  onToggleExpanded: () => void
  onSaveSite: (name: string) => void
  onRemoveSite: () => void
  savedSitesError?: string
}) {
  const [siteName, setSiteName] = useState('')
  const groups = [...new Set(sites.map((s) => s.group))]
  useEffect(() => setSiteName(selected?.name ?? ''), [selected?.id, selected?.name])
  return (
    <section className="panel" id="landing-sites-panel">
      <div className="site-panel-heading">
        <h2>Landing sites</h2>
        <button className="site-panel-expand" onClick={onToggleExpanded} aria-expanded={expanded} aria-controls="landing-sites-panel"
          aria-label={expanded ? 'Collapse landing sites panel' : 'Expand landing sites panel'}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <select value={selected?.id ?? ''} onChange={(e) => { const s = sites.find((x) => x.id === e.target.value); if (s) onSelect(s) }} aria-label="Site">
        <option value="" disabled>Choose a site…</option>
        {selected?.group === 'Custom' && <option value={selected.id}>{selected.name}</option>}
        {groups.map((g) => (
          <optgroup key={g} label={g === 'Saved' ? 'My landing sites' : g}>
            {sites.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </optgroup>
        ))}
      </select>
      <p className="muted">Click the map to inspect and analyse a point as a custom landing site.</p>
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
            <div className="saved-site-form">
              <input type="text" value={siteName} onChange={(e) => setSiteName(e.target.value)}
                aria-label="Landing site name" maxLength={60} />
              <button onClick={() => onSaveSite(siteName)} disabled={!siteName.trim()}>
                {selected.group === 'Saved' ? 'Save name' : 'Add to Landing Sites'}
              </button>
              {selected.group === 'Saved' && (
                <button className="saved-site-remove" onClick={onRemoveSite}>Remove</button>
              )}
            </div>
          )}
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
