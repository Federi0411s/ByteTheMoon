import { DSN_STATIONS, type DsnSample, type LinkBlock } from '../lib/dsn'

const REASON: Record<LinkBlock, string> = {
  ok: '',
  terrain: 'Ridge in the way',
  'below-lunar-horizon': 'Earth below the horizon',
  'below-station-horizon': 'Moon below the station horizon',
}

export function DsnPanel({ now }: { now?: DsnSample }) {
  return (
    <div className="dsn">
      <h3>Telecommunications</h3>
      <p className="muted">Assumes the station is always pointed at the site. “In link”: station and site in mutual line of sight.</p>
      {now && (
        <table className="dsn-table">
          <tbody>
            {DSN_STATIONS.map((s) => {
              const l = now.st[s.id]
              return (
                <tr key={s.id}>
                  <td><span className="swatch" style={{ background: s.color }} />{s.name}</td>
                  <td className={l.link ? 'dsn-ok' : 'dsn-no'}>{l.link ? '✓ In link' : '✕ Not in link'}</td>
                  <td className="muted">{REASON[l.block]}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
