const STEPS = [
  { label: '1 h/tick', ms: 3600_000 },
  { label: '6 h/tick', ms: 6 * 3600_000 },
  { label: '1 d/tick', ms: 86400_000 },
]

export function TimeBar({
  t,
  range,
  onChange,
  playing,
  onPlay,
  stepMs,
  onStep,
  lighting,
  onLighting,
}: {
  t: number
  range: [number, number]
  onChange: (t: number) => void
  playing: boolean
  onPlay: (p: boolean) => void
  stepMs: number
  onStep: (ms: number) => void
  lighting: boolean
  onLighting: (on: boolean) => void
}) {
  return (
    <footer className="timebar">
      <button onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
      <select value={stepMs} onChange={(e) => onStep(Number(e.target.value))} aria-label="Speed">
        {STEPS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
      </select>
      <input type="range" min={range[0]} max={range[1]} step={3600_000} value={t} onChange={(e) => onChange(Number(e.target.value))} aria-label="Date" />
      <input
        type="datetime-local"
        value={new Date(t).toISOString().slice(0, 16)}
        onChange={(e) => e.target.value && onChange(Date.parse(e.target.value + 'Z'))}
        aria-label="Date and time (UTC)"
      />
      <span className="muted">UTC</span>
      <label className="toggle" title="Light the Moon from the Sun's real direction at this time">
        <input type="checkbox" checked={lighting} onChange={(e) => onLighting(e.target.checked)} /> Sun lighting
      </label>
    </footer>
  )
}
