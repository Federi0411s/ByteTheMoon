import { cssGradient } from '../lib/colormaps'
import type { LayerMeta } from '../lib/raster'
import type { RadiationOverlayMetadata } from '../lib/radiation'
import type { Footprint } from '../lib/requirements'
import { InfoTip } from './InfoTip'
import { INFO_FOR_LAYER } from '../content/insights'

export interface LayerState {
  visible: boolean
  opacity: number
}

export interface ScoreConfig {
  enabled: boolean
  /** max acceptable slope (deg) inside the landing footprint, 0.5..SLOPE_MAX_DEG; steeper -> transparent */
  maxSlope: number
  /** landing ellipse / circle over which the max slope is taken */
  footprint: Footprint
  /** the map is drawn within this radius (km) of the selected site / point */
  radiusKm: number
  opacity: number
}

/** Reachable-area layer (lib/reachWorker.ts): area connected to the selected point by terrain within the movement slope limit. */
export interface ReachConfig {
  enabled: boolean
  opacity: number
}

export interface ReachInfo {
  /** elevation pyramid loaded and a site / point selected */
  available: boolean
  /** movement maximum slope (deg, Settings) */
  maxDeg: number
  /** search radius around the selected point, km */
  radiusKm: number
  /** progress / result line */
  status?: string
}

function Legend({ colormap, min, max, units }: { colormap: string; min: number; max: number; units: string }) {
  return (
    <div className="legend">
      <div className="legend-bar" style={{ background: cssGradient(colormap) }} />
      <div className="legend-labels">
        <span>{min}</span>
        <span>{units}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

export function LayerPanel({
  layers,
  state,
  onChange,
  score,
  onScore,
  scoreAvailable,
  radiationMetadata,
  radiationLoading,
  radiationError,
  radiationVisible,
  onRadiationVisible,
  radiationOpacity,
  onRadiationOpacity,
  radiationMode,
  onRadiationMode,
  iceVisible,
  onIceVisible,
  iceError,
  pitsVisible,
  onPitsVisible,
  pitsError,
  reach,
  onReach,
  reachInfo,
}: {
  layers: LayerMeta[]
  state: Record<string, LayerState>
  onChange: (id: string, s: LayerState) => void
  score: ScoreConfig
  onScore: (s: ScoreConfig) => void
  scoreAvailable: boolean
  radiationMetadata: RadiationOverlayMetadata | null
  radiationLoading: boolean
  radiationError?: string
  radiationVisible: boolean
  onRadiationVisible: (visible: boolean) => void
  radiationOpacity: number
  onRadiationOpacity: (opacity: number) => void
  radiationMode: 'classes' | 'continuous'
  onRadiationMode: (mode: 'classes' | 'continuous') => void
  iceVisible: boolean
  onIceVisible: (visible: boolean) => void
  iceError?: string
  pitsVisible: boolean
  onPitsVisible: (visible: boolean) => void
  pitsError?: string
  reach: ReachConfig
  onReach: (r: ReachConfig) => void
  reachInfo: ReachInfo
}) {
  const shown = layers.filter((l) => l.display !== false)
  const activeLayers = shown.filter((l) => state[l.id]?.visible).length
  const suitabilityStatus = !scoreAvailable ? 'Unavailable' : score.enabled ? 'On' : 'Off'
  const radiationStatus = radiationLoading ? 'Loading' : radiationError ? 'Error' : radiationMetadata ? (radiationVisible ? 'On' : 'Off') : 'Unavailable'

  return (
    <section className="panel layer-menu">
      <h2 className="with-info">Map controls <InfoTip topic="dataSources" /></h2>
      <details className="menu-section" data-tour="landing-suitability">
        <summary className="menu-section-summary">
          <span>Landing suitability</span>
          <InfoTip topic="landingSite" />
          <span className="menu-section-state">{suitabilityStatus}</span>
          <span className="menu-section-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="menu-section-body">
          {!scoreAvailable ? (
            <p className="muted">Needs the global elevation model and a loaded time window.</p>
          ) : (
            <div className="layer">
              <label className="layer-head">
                <input type="checkbox" checked={score.enabled} onChange={(e) => onScore({ ...score, enabled: e.target.checked })} />
                Show score heatmap
              </label>
              <p className="muted">Combines temperature, radiation, slope, telecommunications and the sunlight percentage during the selected mission period with equal weight. Drawn within {score.radiusKm} km of the selected site or point (radius in Settings) (select one first), at the highest resolution available there.</p>
              {score.enabled && <Legend colormap="viridis" min={0} max={100} units="score" />}
            </div>
          )}
        </div>
      </details>

      <details className="menu-section" data-tour="map-layers">
        <summary className="menu-section-summary">
          <span>Map layers</span>
          <span className="menu-section-state">{activeLayers}/{shown.length} active</span>
          <span className="menu-section-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="menu-section-body">
          <p className="muted">Overlays are stacked on the map; enable only the layers you need and adjust opacity to keep them readable.</p>
          {!shown.length && <p className="muted">No overlays yet. Run the Python pipeline (see README).</p>}
          <div className="layer">
            <label className="layer-head" title="Area you can drive to from the selected site or point without facing terrain steeper than the movement maximum slope, uphill or downhill (Settings).">
              <input type="checkbox" checked={reach.enabled} onChange={(e) => onReach({ ...reach, enabled: e.target.checked })} />
              Reachable area (max slope {reachInfo.maxDeg}°)
            </label>
            {reach.enabled && (
              <>
                <input type="range" min={0} max={1} step={0.05} value={reach.opacity} aria-label="Reachable area opacity"
                  onChange={(e) => onReach({ ...reach, opacity: Number(e.target.value) })} />
                {!reachInfo.available ? (
                  <p className="muted">Select a site or click a point on the Moon first.</p>
                ) : (
                  <>
                    <div className="legend">
                      <div className="legend-bar" style={{ background: 'linear-gradient(to right, rgb(46, 204, 113), rgb(255, 176, 32))' }} />
                      <div className="legend-labels">
                        <span>0°</span>
                        <span>steepest slope on the way</span>
                        <span>{reachInfo.maxDeg}°</span>
                      </div>
                    </div>
                    {reachInfo.status && <p className="muted">{reachInfo.status}</p>}
                  </>
                )}
                <p className="source">Within {reachInfo.radiusKm} km of the selected point. Terrain slope from LOLA elevation (steepest gradient, so it holds driving up, down or across); change the limit in Settings.</p>
              </>
            )}
          </div>
          {shown.map((l) => {
            const s = state[l.id] ?? { visible: false, opacity: 0.55 }
            return (
              <div key={l.id} className="layer">
                <label className="layer-head" title={l.description}>
                  <input type="checkbox" checked={s.visible} onChange={(e) => onChange(l.id, { ...s, visible: e.target.checked })} />
                  {l.title}
                  {INFO_FOR_LAYER[l.id] && <InfoTip topic={INFO_FOR_LAYER[l.id]} />}
                </label>
                {s.visible && (
                  <>
                    <input type="range" min={0} max={1} step={0.05} value={s.opacity} aria-label={`${l.title} opacity`}
                      onChange={(e) => onChange(l.id, { ...s, opacity: Number(e.target.value) })} />
                    <Legend colormap={l.colormap} min={l.min} max={l.max} units={l.units} />
                    <p className="source">{l.source}</p>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </details>

      <details className="menu-section" data-tour="radiation">
        <summary className="menu-section-summary">
          <span>Radiation</span>
          <InfoTip topic="radiation" />
          <span className="menu-section-state">{radiationStatus}</span>
          <span className="menu-section-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="menu-section-body">
          <div className="layer">
            <label className="layer-head">
              <input type="checkbox" checked={radiationVisible} disabled={!radiationMetadata} onChange={(e) => onRadiationVisible(e.target.checked)} />
              Show layer
            </label>
            {radiationLoading && <p className="muted">Loading legend...</p>}
            {radiationMetadata && (
              <>
                <label className="slider">
                  <span>Display</span>
                  <select value={radiationMode} onChange={(e) => {
                    if (e.target.value === 'classes' || e.target.value === 'continuous') onRadiationMode(e.target.value)
                  }}>
                    <option value="classes">Dose levels</option>
                    <option value="continuous">Continuous dose</option>
                  </select>
                </label>
                {radiationVisible && (
                  <>
                    <label className="slider">
                      <span>Opacity: {Math.round(radiationOpacity * 100)}%</span>
                      <input type="range" min={0} max={1} step={0.05} value={radiationOpacity}
                        onChange={(e) => onRadiationOpacity(Number(e.target.value))} />
                    </label>
                    {radiationMode === 'classes' ? (
                      <div className="radiation-legend">
                        {radiationMetadata.classLegend.map((item, index) => (
                          <div className="radiation-legend-item" key={`${item.label}-${index}`}>
                            <span className="radiation-swatch" style={{ backgroundColor: item.color }} />
                            <span>{item.label}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="legend">
                        <div className="legend-bar" style={{ background: cssGradient('inferno') }} />
                        <div className="legend-labels">
                          <span>{radiationMetadata.doseMin}</span>
                          <span>{radiationMetadata.units}</span>
                          <span>{radiationMetadata.doseMax}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
            {radiationError && <p className="muted">{radiationError}</p>}
          </div>
        </div>
      </details>

      <details className="menu-section" data-tour="water-ice">
        <summary className="menu-section-summary">
          <span>Water ice South Pole</span>
          <InfoTip topic="ice" />
          <span className="menu-section-state">{iceError ? 'Error' : iceVisible ? 'On' : 'Off'}</span>
          <span className="menu-section-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="menu-section-body">
          <div className="layer">
            <label className="layer-head">
              <input type="checkbox" checked={iceVisible} onChange={(e) => onIceVisible(e.target.checked)} />
              Show layer
            </label>
            {iceError && <p className="muted">{iceError}</p>}
            <div className="radiation-legend">
              <div className="radiation-legend-item">
                <span className="radiation-swatch" style={{ backgroundColor: '#1f6fff' }} />
                <span>Cold trap: surface ice stable (T max &lt; 110 K on ≥ 25% of the 4 km cell)</span>
              </div>
            </div>
            <p className="source">Diviner Polar Resource Product (Paige et al. 2010).</p>
          </div>
        </div>
      </details>

      <details className="menu-section">
        <summary className="menu-section-summary">
          <span>Lunar pits</span>
          <InfoTip topic="pits" />
          <span className="menu-section-state">{pitsError ? 'Error' : pitsVisible ? 'On' : 'Off'}</span>
          <span className="menu-section-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="menu-section-body">
          <div className="layer">
            <label className="layer-head">
              <input type="checkbox" checked={pitsVisible} onChange={(e) => onPitsVisible(e.target.checked)} />
              Show layer
            </label>
            {pitsError && <p className="muted">{pitsError}</p>}
            <p className="source">278 pits (possible lava-tube skylights) from the LROC catalog (Wagner &amp; Robinson 2021), heights from LOLA. Click a pit for its depth and size.</p>
          </div>
        </div>
      </details>
    </section>
  )
}
