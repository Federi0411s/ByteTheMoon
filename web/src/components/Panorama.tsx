import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { HorizonMask, TimelineSample } from '../lib/analysis'
import { fitPanoramaRange } from '../lib/panorama'

/**
 * 360° horizon panorama: terrain skyline (grey), Sun path (yellow) and Earth path (blue) over the
 * analysis window, with the current Sun/Earth positions highlighted. Azimuth 0 = north.
 *
 * Drawn at the element's real pixel size (no stretched viewBox, so the text keeps its shape at any
 * panel width), with an elevation range fitted to the skyline and to the Sun/Earth paths near it.
 */
const PAD = { left: 30, right: 8, top: 8, bottom: 18 }
const AZ_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export function Panorama({
  mask,
  timeline,
  now,
}: {
  mask?: HorizonMask
  timeline: TimelineSample[]
  now?: TimelineSample
}) {
  const ref = useRef<SVGSVGElement>(null)
  const clipId = `panorama-plot-${useId().replace(/:/g, '')}`
  const [size, setSize] = useState({ w: 360, h: 140 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { w: W, h: H } = size
  const pw = Math.max(1, W - PAD.left - PAD.right), ph = Math.max(1, H - PAD.top - PAD.bottom)
  const { lo, hi, step } = fitPanoramaRange(mask, timeline, now)
  const x = (az: number) => PAD.left + (az / 360) * pw
  const y = (el: number) => PAD.top + ((hi - el) / (hi - lo)) * ph
  const bottom = PAD.top + ph

  const terrain = mask
    ? `M${x(0)},${bottom} ` + mask.elevDeg.map((e, i) => `L${x(i * mask.azStepDeg).toFixed(1)},${y(e).toFixed(1)}`).join(' ') + ` L${x(360)},${y(mask.elevDeg[0]).toFixed(1)} L${x(360)},${bottom} Z`
    : `M${x(0)},${y(0)} L${x(360)},${y(0)} L${x(360)},${bottom} L${x(0)},${bottom} Z`

  // split paths where azimuth wraps around 360 -> 0
  const track = (key: 'sun' | 'earth') => {
    let d = ''
    let prev = -1
    for (const s of timeline) {
      const az = key === 'sun' ? s.sunAz : s.earthAz
      const el = key === 'sun' ? s.sunEl : s.earthEl
      d += `${prev < 0 || Math.abs(az - prev) > 180 ? 'M' : 'L'}${x(az).toFixed(1)},${y(el).toFixed(1)} `
      prev = az
    }
    return d
  }

  const elTicks: number[] = []
  for (let e = lo; e <= hi + 1e-9; e += step) elTicks.push(e)
  const azStep = pw >= 320 ? 45 : 90 // eight compass points when there is room, else four
  const azTicks: number[] = []
  for (let a = 0; a <= 360; a += azStep) azTicks.push(a)
  // a body above the plotted range is drawn on the top edge as a small triangle pointing up
  const body = (az: number, el: number, r: number, cls: string) => {
    const cx = x(az)
    if (el <= hi) return <circle cx={cx} cy={y(el)} r={r} className={`body ${cls}`} />
    const t = PAD.top
    return <path d={`M${cx},${t} l${r},${r * 1.6} l${-2 * r},0 Z`} className={`body ${cls}`} />
  }

  return (
    <svg ref={ref} className="panorama" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Horizon panorama, elevation ${lo}° to ${hi}°`}>
      <defs>
        <clipPath id={clipId}><rect x={PAD.left} y={PAD.top} width={pw} height={ph} /></clipPath>
      </defs>
      {elTicks.map((e) => (
        <g key={e}>
          <line x1={PAD.left} x2={PAD.left + pw} y1={y(e)} y2={y(e)} className={e === 0 ? 'grid zero' : 'grid'} />
          <text x={PAD.left - 4} y={y(e)} className="tick" textAnchor="end" dominantBaseline="middle">{e}°</text>
        </g>
      ))}
      {azTicks.map((a) => (
        <g key={a}>
          {a > 0 && a < 360 && <line x1={x(a)} x2={x(a)} y1={PAD.top} y2={bottom} className="grid" />}
          <text x={x(a)} y={H - 4} className="tick" textAnchor={a === 0 ? 'start' : a === 360 ? 'end' : 'middle'}>
            {AZ_LABELS[(a / 45) % 8] ?? ''}
          </text>
        </g>
      ))}
      <g clipPath={`url(#${clipId})`}>
        <path d={track('sun')} className="track sun" />
        <path d={track('earth')} className="track earth" />
        <path d={terrain} className="terrain" />
      </g>
      {now && (
        <>
          {body(now.sunAz, now.sunEl, 5, 'sun')}
          {body(now.earthAz, now.earthEl, 4.5, 'earth')}
        </>
      )}
    </svg>
  )
}
