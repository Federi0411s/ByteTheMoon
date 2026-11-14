import type { TimelineSample } from '../lib/analysis'

/** Two stacked bars over the analysis window: sunlight (yellow) and Earth visibility (blue). */
export function TimelineBars({ timeline, nowMs }: { timeline: TimelineSample[]; nowMs: number }) {
  if (!timeline.length) return null
  const W = 720, row = 18
  const t0 = timeline[0].t
  const t1 = timeline[timeline.length - 1].t
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
  const w = W / timeline.length + 0.5
  const days = Math.round((t1 - t0) / 86400_000)
  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${row * 2 + 16}`} preserveAspectRatio="none" role="img" aria-label="Sunlight and Earth visibility timeline">
      {timeline.map((s) => (
        <g key={s.t}>
          <rect x={x(s.t)} y={0} width={w} height={row - 2} className="bar sun" opacity={s.sunVisibleFrac} />
          <rect x={x(s.t)} y={row} width={w} height={row - 2} className="bar earth" opacity={s.earthVisibleFrac} />
        </g>
      ))}
      {nowMs >= t0 && nowMs <= t1 && <line x1={x(nowMs)} x2={x(nowMs)} y1={0} y2={row * 2} className="now" />}
      <text x={2} y={row * 2 + 12} className="tick">{new Date(t0).toISOString().slice(0, 10)}</text>
      <text x={W - 2} y={row * 2 + 12} className="tick" textAnchor="end">+{days} d</text>
    </svg>
  )
}
