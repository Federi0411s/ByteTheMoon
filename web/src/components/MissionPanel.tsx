import { IsoDateTimeInput } from './IsoDateTimeInput'
import { fmtDate } from '../lib/time'

export interface Mission {
  start?: number
  end?: number
}


function fmtDuration(ms: number) {
  const h = ms / 3600_000
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`
  const d = h / 24
  return d < 120 ? `${d.toFixed(d < 10 ? 1 : 0)} days` : `${(d / 365.25).toFixed(1)} years`
}

export function MissionPanel({
  mission,
  onChange,
  range,
  status,
}: {
  mission: Mission
  onChange: (m: Mission) => void
  range: [number, number]
  /** 'idle' = no period set; 'loading' / 'computing'; 'ready'; 'unavailable' = no horizon grid;
   *  'outside' = period not inside the loaded ephemeris window (`range`) */
  status: { state: 'idle' | 'loading' | 'computing' | 'ready' | 'unavailable' | 'outside'; detail?: string }
}) {
  const set = mission.start !== undefined && mission.end !== undefined
  const clamp = (v?: number) => (v === undefined ? v : Math.min(Math.max(v, range[0]), range[1]))
  return (
    <section className="panel mission">
      <h2>Mission period</h2>
      <div className="mission-inputs">
        <label>
          <span className="muted">Start (UTC)</span>
          <IsoDateTimeInput value={mission.start} min={range[0]} max={range[1]} allowEmpty ariaLabel="Mission start (UTC)"
            onChange={(v) => onChange({ ...mission, start: clamp(v) })} />
        </label>
        <label>
          <span className="muted">End (UTC)</span>
          <IsoDateTimeInput value={mission.end} min={range[0]} max={range[1]} allowEmpty ariaLabel="Mission end (UTC)"
            onChange={(v) => onChange({ ...mission, end: clamp(v) })} />
        </label>
      </div>
      <div className="mission-status">
        {!set ? (
          <span className="muted">Empty: heatmaps cover the whole loaded window ({fmtDate(range[0])} – {fmtDate(range[1])}). Set start and end, or drag on the blue track under the timeline.</span>
        ) : (
          <>
            <span>
              <b>{mission.end! > mission.start! ? fmtDuration(mission.end! - mission.start!) : 'End must be after start'}</b>
              <span className="muted">
                {status.state === 'computing' && ' · computing averages…'}
                {status.state === 'loading' && ' · loading horizon grid…'}
                {status.state === 'ready' && ` · sunlight & Earth averages for this period${status.detail ? ` (${status.detail})` : ''}`}
                {status.state === 'outside' && ` · outside the loaded window ${fmtDate(range[0])} – ${fmtDate(range[1])}: heatmaps cover the whole window`}
              </span>
            </span>
            <button onClick={() => onChange({})}>Clear</button>
          </>
        )}
      </div>
    </section>
  )
}
