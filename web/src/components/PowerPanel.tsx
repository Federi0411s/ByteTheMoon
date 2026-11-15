import { NumField } from './NumField'
import type { PanelConfig, PanelMode, PowerSummary } from '../lib/power'

const fmtWh = (wh: number) =>
  wh >= 1000 ? `${(wh / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} kWh` : `${Math.round(wh)} Wh`

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
