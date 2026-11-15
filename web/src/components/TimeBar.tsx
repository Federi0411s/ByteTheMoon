import type { Mission } from './MissionPanel'
import { MissionTrack } from './MissionTrack'
import { IsoDateTimeInput } from './IsoDateTimeInput'
import { fmtDate, fmtDateTime } from '../lib/time'

const STEPS = [
  { label: '1 min/tick', ms: 60_000 },
  { label: '30 min/tick', ms: 30 * 60_000 },
  { label: '1 h/tick', ms: 3600_000 },
  { label: '6 h/tick', ms: 6 * 3600_000 },
  { label: '12 h/tick', ms: 12 * 3600_000 },
  { label: '1 d/tick', ms: 86400_000 },
]

export function TimeBar({
  t,
  range,
  navigationRange,
  calendarRange,
  onChange,
  onCalendarChange,
  onReset,
  playing,
  onPlay,
  stepMs,
  onStep,
  lighting,
  onLighting,
  busy,
  error,
  mission,
  onMission,
}: {
  mission: Mission
  onMission: (m: Mission) => void
  t: number
  range: [number, number]
  navigationRange: [number, number]
  calendarRange: [number, number]
  onChange: (t: number) => void
  onCalendarChange: (t: number) => void
  onReset: () => void
  playing: boolean
  onPlay: (p: boolean) => void
  stepMs: number
  onStep: (ms: number) => void
  lighting: boolean
  onLighting: (on: boolean) => void
  busy: boolean
  error?: string
}) {
  const missionRange = mission.start !== undefined && mission.end !== undefined &&
    navigationRange[0] === mission.start && navigationRange[1] === mission.end
  const oneDayRange = navigationRange[1] - navigationRange[0] <= 86400_000
  return (
    <footer className="timebar">
      <button onClick={() => onPlay(!playing)} disabled={busy} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
      <button onClick={() => onChange(Math.max(navigationRange[0], t - stepMs))} disabled={busy || t <= navigationRange[0]} aria-label="Previous time step">-1</button>
      <select value={stepMs} onChange={(e) => onStep(Number(e.target.value))} disabled={busy} aria-label="Time step">
        {STEPS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
      </select>
      <button onClick={() => onChange(Math.min(navigationRange[1], t + stepMs))} disabled={busy || t >= navigationRange[1]} aria-label="Next time step">+1</button>
      <div className="time-col">
        <input type="range" min={navigationRange[0]} max={navigationRange[1]}
          step={missionRange ? 1 : Math.min(stepMs, 3600_000)} value={t} disabled={busy}
          onChange={(e) => onChange(Number(e.target.value))} aria-label="Date" />
        <MissionTrack range={range} mission={mission} onChange={onMission} />
      </div>
      <IsoDateTimeInput
        value={t}
        min={calendarRange[0]}
        max={calendarRange[1]}
        onChange={(v) => v !== undefined && onCalendarChange(v)}
        disabled={busy}
        ariaLabel="Date and time (UTC)"
      />
      <span className="muted time-range-label" title={missionRange ? 'Mission time range' : oneDayRange ? 'Selected analysis day' : 'Loaded ephemeris range'}>
        {missionRange
          ? `${fmtDateTime(navigationRange[0])} – ${fmtDateTime(navigationRange[1])}`
          : `${fmtDate(navigationRange[0])} – ${fmtDate(navigationRange[1])}`}
      </span>
      <button onClick={onReset} disabled={busy} aria-label="Reset timeline to 2026–2031">Reset</button>
      {busy && <span className="muted" role="status">Loading ephemeris…</span>}
      {error && <span className="time-error" role="alert">{error}</span>}
      <label className="toggle" title="Light the Moon from the Sun's real direction at this time">
        <input type="checkbox" checked={lighting} disabled={busy} onChange={(e) => onLighting(e.target.checked)} /> Sun lighting
      </label>
    </footer>
  )
}
