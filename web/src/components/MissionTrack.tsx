import { useRef, type PointerEvent as RPointerEvent } from 'react'
import type { Mission } from './MissionPanel'
import { fmtDate, fmtDateTime } from '../lib/time'

const HOUR = 3600_000

/**
 * Thick blue mission bar under the time slider. Drag a pin to move that end; drag on empty track to
 * draw a new period. Times snap to the hour.
 */
export function MissionTrack({ range, mission, onChange }: { range: [number, number]; mission: Mission; onChange: (m: Mission) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // which end is dragged ('move' = the whole bar), the fixed other end, and where it was grabbed
  const drag = useRef<{ which: 'start' | 'end' | 'move'; other: number; offset: number; length: number } | null>(null)
  const span = range[1] - range[0]
  const set = mission.start !== undefined && mission.end !== undefined

  const rawTime = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return range[0] + Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * span
  }
  const snap = (t: number) => Math.min(Math.max(Math.round(t / HOUR) * HOUR, range[0]), range[1])
  const move = (clientX: number) => {
    const d = drag.current
    if (!d) return
    const t = snap(rawTime(clientX) - d.offset)
    if (d.which === 'move') {
      const s0 = Math.min(Math.max(t, range[0]), range[1] - d.length)
      onChange({ start: s0, end: s0 + d.length })
      return
    }
    // ends may cross: keep start <= end, at least one hour apart
    const a = Math.min(t, d.other), b = Math.max(t, d.other)
    onChange({ start: a, end: Math.max(b, a + HOUR) })
  }
  const begin = (e: RPointerEvent, which: 'start' | 'end' | 'move' | 'new') => {
    e.preventDefault()
    e.stopPropagation()
    try { ref.current!.setPointerCapture(e.pointerId) } catch { /* synthetic events */ }
    const raw = rawTime(e.clientX)
    if (which === 'new' || !set) {
      const t = snap(raw)
      drag.current = { which: 'end', other: t, offset: 0, length: 0 }
      onChange({ start: t, end: t + HOUR })
    } else if (which === 'move') {
      drag.current = { which, other: 0, offset: raw - mission.start!, length: mission.end! - mission.start! }
    } else {
      // grab offset: the bracket handles sit outside the period, so don't jump to the pointer
      drag.current = { which, other: which === 'start' ? mission.end! : mission.start!, offset: raw - mission[which]!, length: 0 }
    }
  }
  const pct = (t: number) => `${Math.min(Math.max((t - range[0]) / span, 0), 1) * 100}%`
  const outside = set && (mission.end! <= range[0] || mission.start! >= range[1])

  return (
    <div
      ref={ref}
      className={`mission-track${set ? ' set' : ''}`}
      onPointerDown={(e) => begin(e, 'new')}
      onPointerMove={(e) => move(e.clientX)}
      onPointerUp={(e) => { drag.current = null; try { ref.current?.releasePointerCapture(e.pointerId) } catch { /* not captured */ } }}
      title={set ? 'Drag the handles to change start/end, the bar to shift it, or empty track to draw a new period' : 'Drag to set a mission period'}
    >
      {!set && <span className="mission-hint">drag here to set a mission period</span>}
      {outside && <span className="mission-hint">mission period {fmtDate(mission.start!)} – {fmtDate(mission.end!)} is outside this window</span>}
      {set && !outside && (
        <>
          <div className="mission-bar" style={{ left: pct(mission.start!), width: `calc(${pct(mission.end!)} - ${pct(mission.start!)})` }}
            onPointerDown={(e) => begin(e, 'move')} title="Drag to shift the whole mission period" />
          {(['start', 'end'] as const).map((w) => (
            <div key={w} className={`mission-pin ${w}`} style={{ left: pct(mission[w]!) }} onPointerDown={(e) => begin(e, w)}
              role="slider" aria-label={`Mission ${w}`} aria-valuemin={range[0]} aria-valuemax={range[1]} aria-valuenow={mission[w]}
              title={`${fmtDateTime(mission[w]!)} UTC`} />
          ))}
        </>
      )}
    </div>
  )
}
