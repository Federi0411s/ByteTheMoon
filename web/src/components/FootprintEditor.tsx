import { FOOTPRINT_MAX_M, FOOTPRINT_MIN_M, type Footprint } from '../lib/requirements'
import { NumField } from './NumField'

/** Landing footprint (landing ellipse): circle with a radius, or ellipse with semi-axes and azimuth. */
export function FootprintEditor({ fp, onChange }: { fp: Footprint; onChange: (fp: Footprint) => void }) {
  return (
    <div className="footprint-editor">
      <p className="footprint-help">
        The region where the lander is expected to touch down: guidance and navigation errors scatter the
        actual landing point around the target, so the footprint is drawn where that probability density is
        concentrated. The slope is checked over the whole region. Default: a circle of 100 m radius.
      </p>
      <div style={{ display: 'flex', gap: 16 }}>
        {(['circle', 'ellipse'] as const).map((s) => (
          <label key={s} className="layer-head">
            <input type="radio" name="fp-shape" checked={fp.shape === s} onChange={() => onChange({ ...fp, shape: s })} />
            {s === 'circle' ? 'Circle' : 'Ellipse'}
          </label>
        ))}
      </div>
      {fp.shape === 'circle' ? (
        <NumField label="Radius" unit="m" value={fp.radiusM} min={FOOTPRINT_MIN_M} max={FOOTPRINT_MAX_M} onChange={(v) => onChange({ ...fp, radiusM: v })} />
      ) : (
        <>
          <NumField label="Semi-major axis" unit="m" value={fp.semiMajorM} min={FOOTPRINT_MIN_M} max={FOOTPRINT_MAX_M} onChange={(v) => onChange({ ...fp, semiMajorM: v })} />
          <NumField label="Semi-minor axis" unit="m" value={fp.semiMinorM} min={FOOTPRINT_MIN_M} max={FOOTPRINT_MAX_M} onChange={(v) => onChange({ ...fp, semiMinorM: v })} />
          <NumField label="Azimuth (from north)" unit="°" value={fp.azimuthDeg} min={0} max={180} onChange={(v) => onChange({ ...fp, azimuthDeg: v })} />
        </>
      )}
    </div>
  )
}
