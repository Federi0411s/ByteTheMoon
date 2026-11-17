import { memo } from 'react'
import { fmtDate } from '../lib/time'
import type { TimelineSample } from '../lib/analysis'

const W = 720, ROW = 18

const TimelineSamples = memo(function TimelineSamples({
  timeline,
  t0,
  t1,
  width,
}: {
  timeline: TimelineSample[]
  t0: number
  t1: number
  width: number
}) {
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
  return (
    <>
      {timeline.map((s) => (
        <g key={s.t}>
          <rect x={x(s.t)} y={0} width={width} height={ROW - 2} className="bar sun" opacity={s.sunVisibleFrac} />
          <rect x={x(s.t)} y={ROW} width={width} height={ROW - 2} className="bar earth" opacity={s.earthVisibleFrac} />
        </g>
      ))}
    </>
  )
})

/** Two stacked bars over the analysis window: sunlight (yellow) and Earth visibility (blue). */
export function TimelineBars({ timeline, nowMs }: { timeline: TimelineSample[]; nowMs: number }) {
  if (!timeline.length) return null
  const t0 = timeline[0].t
  const t1 = timeline[timeline.length - 1].t
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
  const w = W / timeline.length + 0.5
  const days = Math.round((t1 - t0) / 86400_000)
  // the bars stretch to the panel width (preserveAspectRatio none); the dates are HTML under them so the
  // text is never squashed with the bars
  return (
    <div className="timeline-wrap">
      <svg className="timeline" viewBox={`0 0 ${W} ${ROW * 2}`} preserveAspectRatio="none" role="img" aria-label="Sunlight and Earth visibility timeline">
        <TimelineSamples timeline={timeline} t0={t0} t1={t1} width={w} />
        {nowMs >= t0 && nowMs <= t1 && <line x1={x(nowMs)} x2={x(nowMs)} y1={0} y2={ROW * 2} className="now" />}
      </svg>
      <div className="timeline-ticks">
        <span>{fmtDate(t0)}</span>
        <span>{fmtDate(t1)} · {days} d</span>
      </div>
    </div>
  )
}
