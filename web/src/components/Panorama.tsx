import type { HorizonMask, TimelineSample } from '../lib/analysis'

/**
 * 360° horizon panorama: terrain skyline (grey), Sun path (yellow) and Earth path (blue) over the
 * analysis window, with the current Sun/Earth positions highlighted. Azimuth 0 = north.
 */
export function Panorama({
  mask,
  timeline,
  now,
}: {
  mask?: HorizonMask
  timeline: TimelineSample[]
  now?: TimelineSample
}) {
  const W = 720, H = 200
  const elMin = -5, elMax = 15
  const x = (az: number) => (az / 360) * W
  const y = (el: number) => H - ((el - elMin) / (elMax - elMin)) * H

  const terrain = mask
    ? 'M0,' + H + ' ' + mask.elevDeg.map((e, i) => `L${x(i * mask.azStepDeg)},${y(e)}`).join(' ') + ` L${W},${y(mask.elevDeg[0])} L${W},${H} Z`
    : `M0,${y(0)} L${W},${y(0)} L${W},${H} L0,${H} Z`

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

  return (
    <svg className="panorama" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Horizon panorama">
      {[0, 5, 10].map((e) => (
        <g key={e}>
          <line x1={0} x2={W} y1={y(e)} y2={y(e)} className="grid" />
          <text x={4} y={y(e) - 3} className="tick">{e}°</text>
        </g>
      ))}
      {['N', 'E', 'S', 'W'].map((l, i) => (
        <text key={l} x={x(i * 90) + 4} y={14} className="tick">{l}</text>
      ))}
      <path d={track('sun')} className="track sun" />
      <path d={track('earth')} className="track earth" />
      <path d={terrain} className="terrain" />
      {now && (
        <>
          <circle cx={x(now.sunAz)} cy={y(now.sunEl)} r={6} className="body sun" />
          <circle cx={x(now.earthAz)} cy={y(now.earthEl)} r={5} className="body earth" />
        </>
      )}
    </svg>
  )
}
