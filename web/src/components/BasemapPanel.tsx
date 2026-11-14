import { useState } from 'react'

export interface BasemapState {
  kaguya: boolean
  nacPolar: boolean
  nacSites: boolean
  elevation: boolean
  relief: boolean
}

const ELEVATION_ROW = { key: 'elevation' as const, label: 'LOLA 3D elevation relief' }

const ROWS: { key: keyof BasemapState; label: string; detail: string }[] = [
  { key: 'kaguya', label: 'Kaguya TC mosaic', detail: '~21 m/px, 60°S–60°N' },
  { key: 'nacPolar', label: 'LROC NAC polar mosaics', detail: '~5 m/px, poles to 83.6°' },
  { key: 'nacSites', label: 'LROC NAC site mosaics', detail: '0.5–1.5 m/px, ~50 regions' },
  { key: 'relief', label: 'LOLA relief shading', detail: '240 m/px, south of 80°S' },
]

function fmtRes(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : m >= 10 ? `${Math.round(m)} m` : `${m.toFixed(1)} m`
}

export function BasemapPanel({
  basemap,
  state,
  onChange,
  viewResM,
}: {
  basemap: 'ion' | 'trek'
  state: BasemapState
  onChange: (s: BasemapState) => void
  viewResM?: number
}) {
  const [open, setOpen] = useState(false)
  const active = ROWS.filter((r) => state[r.key]).length + Number(state.elevation)
  const elevationDetail = basemap === 'trek'
    ? 'Terrain mesh + color · 666 m/px, global'
    : 'Color overlay on Cesium 3D terrain'
  return (
    <section className="panel">
      <button className="panel-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <h2>Basemap</h2>
        <span className="muted">
          {basemap === 'ion' ? 'Cesium 3D' : `${active + 1}/${ROWS.length + 2} layers`}
          {viewResM !== undefined && ` · ~${fmtRes(viewResM)}/px`}
        </span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {!open ? null : basemap === 'ion' ? (
        <>
          <p className="muted">Cesium Moon 3D tiles (streams finer detail as you zoom).</p>
          <label className="layer-head basemap-row">
            <input type="checkbox" checked={state.elevation} onChange={(e) => onChange({ ...state, elevation: e.target.checked })} />
            <span>{ELEVATION_ROW.label}</span>
            <span className="muted">{elevationDetail}</span>
          </label>
        </>
      ) : (
        <>
          <p className="muted">
            LRO WAC global mosaic (~100 m/px) everywhere, with sharper NASA Moon Trek mosaics streamed in as you zoom.
          </p>
          <label className="layer-head basemap-row">
            <input type="checkbox" checked={state.elevation} onChange={(e) => onChange({ ...state, elevation: e.target.checked })} />
            <span>{ELEVATION_ROW.label}</span>
            <span className="muted">{elevationDetail}</span>
          </label>
          {ROWS.map((r) => (
            <label key={r.key} className="layer-head basemap-row">
              <input type="checkbox" checked={state[r.key]} onChange={(e) => onChange({ ...state, [r.key]: e.target.checked })} />
              <span>{r.label}</span>
              <span className="muted">{r.detail}</span>
            </label>
          ))}
        </>
      )}
      {open && viewResM !== undefined && <p className="source">Screen detail at centre: ~{fmtRes(viewResM)} per pixel</p>}
    </section>
  )
}
