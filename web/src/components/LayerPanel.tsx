import { cssGradient } from '../lib/colormaps'
import type { LayerMeta } from '../lib/raster'
import type { RadiationOverlayMetadata } from '../lib/radiation'

export interface LayerState {
  visible: boolean
  opacity: number
}

export interface ScoreWeights {
  enabled: boolean
  sun: number
  earth: number
  flat: number
  maxSlope: number
  opacity: number
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
}: {
  layers: LayerMeta[]
  state: Record<string, LayerState>
  onChange: (id: string, s: LayerState) => void
  score: ScoreWeights
  onScore: (s: ScoreWeights) => void
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
}) {
  const shown = layers.filter((l) => l.display !== false)
  return (
    <section className="panel">
      <h2>Map layers</h2>
      {!shown.length && <p className="muted">No overlays yet. Run the Python pipeline (see README).</p>}
      {shown.map((l) => {
        const s = state[l.id] ?? { visible: false, opacity: 0.75 }
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

      <h2>Landing suitability</h2>
      {!scoreAvailable ? (
        <p className="muted">Needs the sunlight, Earth visibility and slope layers.</p>
      ) : (
        <div className="layer">
          <label className="layer-head">
            <input type="checkbox" checked={score.enabled} onChange={(e) => onScore({ ...score, enabled: e.target.checked })} />
            Show score heatmap
          </label>
          {(['sun', 'earth', 'flat'] as const).map((k) => (
            <label key={k} className="slider">
              <span>{{ sun: 'Sunlight (power)', earth: 'Earth visibility (comms)', flat: 'Flat terrain' }[k]}</span>
              <input type="range" min={0} max={1} step={0.05} value={score[k]} onChange={(e) => onScore({ ...score, [k]: Number(e.target.value) })} />
            </label>
          ))}
          <label className="slider">
            <span>Max slope: {score.maxSlope}°</span>
            <input type="range" min={2} max={30} step={1} value={score.maxSlope} onChange={(e) => onScore({ ...score, maxSlope: Number(e.target.value) })} />
          </label>
          {score.enabled && <Legend colormap="viridis" min={0} max={1} units="score" />}
        </div>
      )}

      <h2>Radiation</h2>
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
                <option value="classes">Classes</option>
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

    </section>
  )
}
