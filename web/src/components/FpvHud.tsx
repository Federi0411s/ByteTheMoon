/**
 * First-person HUD, videogame style: a compass tape across the top (heading, cardinal points, the Sun
 * and the Earth at their azimuths) and an elevation scale on the right (the Sun and the Earth at their
 * elevations). Both span the current field of view, so the marks line up with the scene.
 */
interface Body { name: string; icon: string; az: number; el: number; color: string }

const CARD: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }
const wrap = (d: number) => ((d % 360) + 360) % 360
const rel = (d: number) => ((d + 540) % 360) - 180 // -180..180

export function FpvHud({ heading, pitch, fovxDeg, fovyDeg, bodies }: { heading: number; pitch: number; fovxDeg: number; fovyDeg: number; bodies: Body[] }) {
  // compass width: the free area between the side panels (left panel 384 px, right 344 px), max 600
  const W = Math.round(Math.max(240, Math.min(600, (typeof window !== 'undefined' ? window.innerWidth : 1300) - 384 - 344 - 40)))
  const H = 34
  const span = fovxDeg // degrees across the tape
  const x = (az: number) => W / 2 + (rel(az - heading) / span) * W
  const ticks: number[] = []
  for (let a = Math.floor((heading - span / 2) / 5) * 5; a <= heading + span / 2; a += 5) ticks.push(a)
  const VH = 320 // elevation scale height (CSS px)
  const y = (el: number) => VH / 2 - ((el - pitch) / fovyDeg) * VH
  const eticks: number[] = []
  for (let e = Math.ceil((pitch - fovyDeg / 2) / 5) * 5; e <= pitch + fovyDeg / 2; e += 5) if (e >= -90 && e <= 90) eticks.push(e)
  const scale = (side: 'left' | 'right') => (
    <svg className={`fpv-elev ${side}`} width={46} height={VH} viewBox={`0 0 46 ${VH}`} aria-hidden="true">
      {eticks.map((e) => (
        <g key={e}>
          <line x1={side === 'left' ? 0 : 46} x2={side === 'left' ? (e % 10 ? 8 : 14) : 46 - (e % 10 ? 8 : 14)} y1={y(e)} y2={y(e)} className="fpv-tick" />
          {e % 10 === 0 && <text x={side === 'left' ? 17 : 29} y={y(e) + 4} textAnchor={side === 'left' ? 'start' : 'end'} className="fpv-label">{e}°</text>}
        </g>
      ))}
      {bodies.filter((b) => Math.abs(b.el - pitch) <= fovyDeg / 2).map((b) => (
        <text key={b.name} x={side === 'left' ? 40 : 6} y={y(b.el) + 5} textAnchor="middle" fill={b.color} className="fpv-icon">{b.icon}</text>
      ))}
      <path d={side === 'left' ? `M0 ${VH / 2 - 5} L7 ${VH / 2} L0 ${VH / 2 + 5}` : `M46 ${VH / 2 - 5} L39 ${VH / 2} L46 ${VH / 2 + 5}`} className="fpv-pointer" />
    </svg>
  )
  return (
    <div className="fpv-hud" aria-hidden="true">
      <div className="fpv-compass-wrap">
        <svg className="fpv-compass" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          {ticks.map((a) => {
            const big = wrap(a) % 15 === 0
            return (
              <g key={a}>
                <line x1={x(a)} x2={x(a)} y1={H} y2={H - (big ? 10 : 5)} className="fpv-tick" />
                {big && <text x={x(a)} y={H - 13} textAnchor="middle" className={CARD[wrap(a)] ? 'fpv-label card' : 'fpv-label'}>{CARD[wrap(a)] ?? `${wrap(a)}`}</text>}
              </g>
            )
          })}
          {bodies.filter((b) => Math.abs(rel(b.az - heading)) <= span / 2).map((b) => (
            <text key={b.name} x={x(b.az)} y={11} textAnchor="middle" fill={b.color} className="fpv-icon">{b.icon}</text>
          ))}
          <path d={`M${W / 2 - 6} 0 L${W / 2} 7 L${W / 2 + 6} 0`} className="fpv-pointer" />
        </svg>
        <span className="fpv-readout">{Math.round(wrap(heading))}° · elev {pitch.toFixed(1)}°</span>
      </div>
      {scale('right')}
    </div>
  )
}
