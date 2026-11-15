import { NumField } from './NumField'
import { FILTER_DEFS, FILTER_ORDER, activeFilters, defaultFilters, type FilterKey, type RegionFilterState } from '../lib/regionFilters'

/**
 * Region filters: tick the criteria that matter, set a range for each, and the map highlights in green
 * the areas that meet all of them.
 */
export function RegionFiltersPanel({ filters, onChange, periodHours, periodLabel, available, busy, error }: {
  filters: RegionFilterState
  onChange: (f: RegionFilterState) => void
  /** length of the selected period, hours (upper limit of the sunlight / night filters) */
  periodHours: number
  periodLabel: string
  /** the global engine is ready */
  available: boolean
  /** water-ice / pit distances still loading */
  busy: boolean
  error?: string
}) {
  const active = activeFilters(filters)
  const set = (k: FilterKey, patch: Partial<RegionFilterState[FilterKey]>) => onChange({ ...filters, [k]: { ...filters[k], ...patch } })
  return (
    <details className="panel menu-section region-filters" data-tour="region-filters">
      <summary className="menu-section-summary">
        <span>Region filters</span>
        <span className="menu-section-state">{!available ? 'Unavailable' : active.length ? `${active.length} on` : 'Off'}</span>
        <span className="menu-section-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="menu-section-body">
        {!available ? (
          <p className="muted">Needs the global elevation model and a loaded time window.</p>
        ) : (
          <>
            <p className="muted">
              Tick the criteria you need and set their range: the map shows in <b className="region-ok">green</b> the
              areas that meet all of them. Period: {periodLabel}.
            </p>
            {FILTER_ORDER.map((k) => {
              const d = FILTER_DEFS[k], f = filters[k]
              const hi = d.limits[1] ?? Math.max(1, Math.round(periodHours))
              return (
                <div key={k} className="layer region-filter">
                  <label className="layer-head" title={d.help}>
                    <input type="checkbox" checked={f.on} onChange={(e) => {
                      // sunlight / night are in hours of the selected period: start from that period's
                      // defaults if the current range does not fit it (e.g. a shorter mission period)
                      const reset = e.target.checked && d.limits[1] === null && f.max > hi
                      set(k, reset ? { ...defaultFilters(periodHours)[k], on: true } : { on: e.target.checked })
                    }} />
                    {d.label}
                  </label>
                  {f.on && (
                    <div className="region-range">
                      <NumField label="min" unit="" value={f.min} min={d.limits[0]} max={Math.min(f.max, hi)} onChange={(v) => set(k, { min: v })} />
                      <NumField label="max" unit={d.unit} value={f.max} min={Math.max(f.min, d.limits[0])} max={hi} onChange={(v) => set(k, { max: v })} />
                      <p className="source">{d.help}.</p>
                    </div>
                  )}
                </div>
              )
            })}
            {busy && <p className="muted" role="status">Loading water-ice / pit distances…</p>}
            {error && <p className="muted" role="alert">{error}</p>}
            {active.length > 0 && (
              <button type="button" className="region-clear" onClick={() => onChange(Object.fromEntries(
                FILTER_ORDER.map((k) => [k, { ...filters[k], on: false }]),
              ) as RegionFilterState)}>Clear filters</button>
            )}
          </>
        )}
      </div>
    </details>
  )
}
