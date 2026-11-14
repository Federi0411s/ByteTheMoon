import { useState } from 'react'
import type { PanelConfig, PanelMode, PowerSummary } from '../lib/power'

const fmtWh = (wh: number) =>
  wh >= 1000 ? `${(wh / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} kWh` : `${Math.round(wh)} Wh`

/**
 * Free-text number box: no spinner arrows, nothing is corrected while typing. The value is applied as
 * soon as the text is a valid number in [min, max] ("," or "." as decimal separator); otherwise the box
 * turns red and the last valid value stays in use. On leaving the box the text snaps back to that value.
 */
function NumField({ label, unit, value, min, max, onChange }: {
  label: string; unit?: string; value: number; min: number; max: number; onChange: (v: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const parsed = Number(text.replace(',', '.').trim())
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max
  return (
    <label className="num-field">
      <span>{label}</span>
      <input type="text" inputMode="decimal" value={editing ? text : String(value)} className={editing && !valid ? 'invalid' : ''}
        title={`${min} – ${max}`}
        onFocus={() => { setText(String(value)); setEditing(true) }}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value.replace(',', '.').trim())
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(n)
        }} />
      <span className="muted">{unit}</span>
    </label>
  )
}

export function PowerPanel({ panel, onPanel, summary }: {
  panel: PanelConfig
  onPanel: (p: PanelConfig) => void
  summary?: PowerSummary
}) {
  return (
    <div className="dsn">
      <h3>Power generation</h3>
      <p className="muted">Solar arrays. Includes Sun distance, terrain shadows (ridges, crater rims), Sun elevation and eclipses by the Earth.</p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {([['tracking', 'Mobile (Sun-tracking)'], ['fixed', 'Fixed (horizontal)']] as [PanelMode, string][]).map(([m, label]) => (
          <label key={m} className="layer-head" title={m === 'tracking' ? 'Two-axis tracker: always faces the Sun' : 'Lies parallel to the local lunar surface'}>
            <input type="radio" name="panel-mode" checked={panel.mode === m} onChange={() => onPanel({ ...panel, mode: m })} />
            {label}
          </label>
        ))}
      </div>
      <NumField label="Panel area" unit="m²" value={panel.areaM2} min={0.01} max={100000} onChange={(v) => onPanel({ ...panel, areaM2: v })} />
      <NumField label="Efficiency (0–1)" value={panel.efficiency} min={0} max={1} onChange={(v) => onPanel({ ...panel, efficiency: v })} />

      {summary && (
        <div className="power-wh">
          <div className="power-now"><span>Energy / hour</span><b>{fmtWh(summary.meanW)}</b></div>
        </div>
      )}
    </div>
  )
}
