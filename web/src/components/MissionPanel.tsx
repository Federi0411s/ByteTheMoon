import { IsoDateTimeInput } from './IsoDateTimeInput'
import { fmtDate } from '../lib/time'

export interface Mission {
  start?: number
  end?: number
  landingDay?: number
  landingDayEnabled?: boolean
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
  calendarRange,
  status,
}: {
  mission: Mission
  onChange: (m: Mission) => void
  range: [number, number]
  calendarRange: [number, number]
  /** 'idle' = no period set; 'loading' = ephemeris request in progress; 'outside' = period not loaded */
  status: { state: 'idle' | 'loading' | 'ready' | 'outside' }
}) {
  const set = mission.start !== undefined && mission.end !== undefined
  const valid = set && mission.end! > mission.start!
  const dayStart = (ms: number) => Math.floor(ms / 86400_000) * 86400_000
  const landingMin = valid ? dayStart(mission.start!) : calendarRange[0]
  const landingMax = valid ? dayStart(mission.end!) : dayStart(calendarRange[1])
  const landingMaxTime = valid ? landingMax + 86400_000 - 1 : calendarRange[1]
  const landingDay = mission.landingDay === undefined ? undefined : dayStart(mission.landingDay)
  const statusText = (
    <>
      {status.state === 'loading' && ' · loading ephemeris data…'}
      {status.state === 'ready' && ` · the selected ${mission.landingDayEnabled ? 'landing day' : 'mission period'} is loaded`}
      {status.state === 'outside' && ` · selected analysis interval is outside the loaded window ${fmtDate(range[0])} – ${fmtDate(range[1])}`}
    </>
  )
  return (
    <section className="panel mission" data-tour="mission-period">
      <h2>Mission period</h2>
      <div className="mission-inputs">
        <label>
          <span className="muted">Start (UTC)</span>
          <IsoDateTimeInput value={mission.start} min={calendarRange[0]} max={calendarRange[1]} allowEmpty showCalendar ariaLabel="Mission start (UTC)"
            onChange={(start) => onChange({ ...mission, start })} />
        </label>
        <label>
          <span className="muted">End (UTC)</span>
          <IsoDateTimeInput value={mission.end} min={calendarRange[0]} max={calendarRange[1]} allowEmpty showCalendar ariaLabel="Mission end (UTC)"
            onChange={(end) => onChange({ ...mission, end })} />
        </label>
      </div>
      <label className="mission-landing-toggle">
        <input
          type="checkbox"
          checked={!!mission.landingDayEnabled}
          onChange={(event) => {
            const enabled = event.target.checked
            const initialDay = dayStart(mission.landingDay ?? mission.start ?? Date.now())
            const boundedDay = Math.min(Math.max(initialDay, landingMin), landingMax)
            onChange({ ...mission, landingDay: boundedDay, landingDayEnabled: enabled })
          }}
        />
        Analyze the landing day only
      </label>
      {mission.landingDayEnabled && (
        <div className="mission-landing-date">
          <label>
            <span className="muted">Landing day (UTC)</span>
            <IsoDateTimeInput
              value={landingDay}
              min={landingMin}
              max={landingMaxTime}
              showCalendar
              ariaLabel="Landing day (UTC)"
              onChange={(value) => {
                if (value !== undefined) onChange({ ...mission, landingDay: dayStart(value) })
              }}
            />
          </label>
          <p className="muted">The left-side analysis and PDF will use this full UTC day instead of the mission interval.</p>
        </div>
      )}
      <div className="mission-status">
        {mission.landingDayEnabled && landingDay !== undefined ? (
          <>
            <span><b>Landing day · {fmtDate(landingDay)}</b><span className="muted">{statusText}</span></span>
            {set && <button onClick={() => onChange({})}>Clear</button>}
          </>
        ) : !set ? (
          <span className="muted">Empty: heatmaps cover the whole loaded window ({fmtDate(range[0])} – {fmtDate(range[1])}). Set start and end, or drag on the blue track under the timeline.</span>
        ) : (
          <>
            <span>
              <b>{mission.end! > mission.start! ? fmtDuration(mission.end! - mission.start!) : 'End must be after start'}</b>
              <span className="muted">{statusText}</span>
            </span>
            <button onClick={() => onChange({})}>Clear</button>
          </>
        )}
      </div>
    </section>
  )
}
