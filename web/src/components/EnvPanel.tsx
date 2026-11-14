export interface SiteEnv {
  /** regolith surface temperature over the period, K */
  tMinK: number
  tMaxK: number
  /** GCR + albedo dose rate, µGy/h */
  doseUGyH: number
}

const C = (k: number) => `${Math.round(k - 273.15)} °C`

/** Thermal range and radiation at the selected site, shown like the power figure (big coloured numbers). */
export function EnvPanel({ env, loading }: { env?: SiteEnv; loading: boolean }) {
  return (
    <div className="dsn">
      <h3>Temperature &amp; radiation</h3>
      <p className="muted">Over the selected period. Surface temperature includes terrain shadows. Radiation: galactic cosmic rays + albedo, scaled to the solar cycle.</p>
      {env ? (
        <>
          <div className="power-now big-temp">
            <span>Temperature range</span>
            <b>{C(env.tMinK)} – {C(env.tMaxK)}</b>
          </div>
          <div className="kv env-sub">
            <span>Thermal excursion</span>
            <b>{Math.round(env.tMaxK - env.tMinK)} °C</b>
          </div>
          <div className="power-now big-rad">
            <span>Radiation dose</span>
            <b>{env.doseUGyH.toFixed(1)} µGy/h</b>
          </div>
        </>
      ) : (
        <p className="muted">{loading ? 'Computing…' : 'Not available here.'}</p>
      )}
    </div>
  )
}
