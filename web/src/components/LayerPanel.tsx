import { cssGradient } from '../lib/colormaps'
import type { LayerMeta } from '../lib/raster'
import type { RadiationOverlayMetadata } from '../lib/radiation'
import { FOOTPRINT_MAX_M, FOOTPRINT_MIN_M, type Footprint, footprintLabel, SLOPE_CLASSES, SLOPE_MAX_DEG, slopeClass } from '../lib/requirements'

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
  opacity: number
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="slider" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} style={{ width: 90 }}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function FootprintEditor({ fp, onChange }: { fp: Footprint; onChange: (fp: Footprint) => void }) {
  const m = { min: FOOTPRINT_MIN_M, max: FOOTPRINT_MAX_M, step: 10 }
  return (
    <>
      <p className="slider">Landing footprint</p>
      <div style={{ display: 'flex', gap: 16 }}>
        {(['circle', 'ellipse'] as const).map((s) => (
          <label key={s} className="layer-head">
            <input type="radio" name="fp-shape" checked={fp.shape === s} onChange={() => onChange({ ...fp, shape: s })} />
            {s === 'circle' ? 'Circle' : 'Ellipse'}
          </label>
        ))}
      </div>
      {fp.shape === 'circle' ? (
        <NumberField label="Radius (m)" value={fp.radiusM} {...m} onChange={(v) => onChange({ ...fp, radiusM: v })} />
      ) : (
        <>
          <NumberField label="Semi-major axis (m)" value={fp.semiMajorM} {...m} onChange={(v) => onChange({ ...fp, semiMajorM: v })} />
          <NumberField label="Semi-minor axis (m)" value={fp.semiMinorM} {...m} onChange={(v) => onChange({ ...fp, semiMinorM: v })} />
          <NumberField label="Azimuth (° from north)" value={fp.azimuthDeg} min={0} max={180} step={5} onChange={(v) => onChange({ ...fp, azimuthDeg: v })} />
        </>
      )}
    </>
  )
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
  slopeExact,
  guided,
  onGuided,
  guidedAvailable,
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
  /** true: steepest slope from the slope pyramid's max channel (lib/slopeMax.ts); false: the engine's sampled (average) slope */
  slopeExact: boolean
  /** DEM-guided upsampling of the computed heatmaps (sharper edges); off = plain bilinear */
  guided: boolean
  onGuided: (on: boolean) => void
  guidedAvailable: boolean
}) {
  const shown = layers.filter((l) => l.display !== false)
  const activeLayers = shown.filter((l) => state[l.id]?.visible).length
  const suitabilityStatus = !scoreAvailable ? 'Unavailable' : score.enabled ? 'On' : 'Off'
  const radiationStatus = radiationLoading ? 'Loading' : radiationError ? 'Error' : radiationMetadata ? (radiationVisible ? 'On' : 'Off') : 'Unavailable'

  return (
    <section className="panel layer-menu">
      <h2>Map controls</h2>
      <details className="menu-section">
        <summary className="menu-section-summary">
          <span>Landing suitability</span>
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
              <FootprintEditor fp={score.footprint} onChange={(footprint) => onScore({ ...score, footprint })} />
              <label className="slider">
                <span className="slider-label">
                  <span>Max slope in footprint</span>
                  <span className="slider-value">
                    {score.maxSlope}° · <b style={{ color: slopeClass(score.maxSlope).color }}>{slopeClass(score.maxSlope).label}</b>
                  </span>
                </span>
                <input type="range" min={0.5} max={SLOPE_MAX_DEG} step={0.5} value={score.maxSlope}
                  onChange={(e) => onScore({ ...score, maxSlope: Number(e.target.value) })} />
              </label>
              <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden' }}>
                {SLOPE_CLASSES.map((c, i) => (
                  <div key={c.label} title={`${c.label}: ${i ? SLOPE_CLASSES[i - 1].upTo : 0}–${c.upTo}°`}
                    style={{ flex: c.upTo - (i ? SLOPE_CLASSES[i - 1].upTo : 0), background: c.color }} />
                ))}
              </div>
              <div className="legend-labels">
                {SLOPE_CLASSES.map((c, i) => <span key={c.label}>{c.label} {i ? SLOPE_CLASSES[i - 1].upTo : 0}–{c.upTo}°</span>)}
              </div>
              <p className="muted">Combines temperature, radiation, slope, telecommunications and sunlight with equal weight. Temporal values use the global heatmap sampling; a selected site shows its detailed score.</p>
              {score.enabled && <Legend colormap="viridis" min={0} max={100} units="score" />}
              {score.enabled && (
                <p className="source">
                  Transparent where the steepest slope inside the footprint ({footprintLabel(score.footprint)}) centred on
                  that point exceeds the limit.{' '}
                  {slopeExact
                    ? 'The exclusion mask uses the max-slope pyramid; the score criterion uses a 5 × 5 DEM sample grid over the footprint.'
                    : 'The max-slope check and score criterion use DEM samples over the footprint; resolution follows the current map zoom.'}
                </p>
              )}
            </div>
          )}
        </div>
      </details>

      <details className="menu-section">
        <summary className="menu-section-summary">
          <span>Map layers</span>
          <span className="menu-section-state">{activeLayers}/{shown.length} active</span>
          <span className="menu-section-chevron" aria-hidden="true">›</span>
        </summary>
        <div className="menu-section-body">
          <p className="muted">Overlays are stacked on the map; enable only the layers you need and adjust opacity to keep them readable.</p>
          {!shown.length && <p className="muted">No overlays yet. Run the Python pipeline (see README).</p>}
          {guidedAvailable && (
            <label className="layer-head" title="Computed maps are sampled on a coarse grid; this fills the pixels in between following the elevation, so shadow edges and crater rims stay sharp. Off: plain bilinear interpolation.">
              <input type="checkbox" checked={guided} onChange={(e) => onGuided(e.target.checked)} />
              <span>Terrain-guided sharpening</span>
            </label>
          )}
          {shown.map((l) => {
            const s = state[l.id] ?? { visible: false, opacity: 0.55 }
            return (
              <div key={l.id} className="layer">
                <label className="layer-head" title={l.description}>
                  <input type="checkbox" checked={s.visible} onChange={(e) => onChange(l.id, { ...s, visible: e.target.checked })} />
                  {l.title}
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

      <details className="menu-section">
        <summary className="menu-section-summary">
          <span>Radiation</span>
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

      <details className="menu-section">
        <summary className="menu-section-summary">
          <span>Water ice</span>
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
