import type { HorizonMask } from '../lib/analysis'

export function TerrainPreview({
  mask,
  active,
  loading,
  onClick,
}: {
  mask?: HorizonMask
  active: boolean
  loading: boolean
  onClick: () => void
}) {
  const width = 320, height = 72
  const profile = mask?.elevDeg ?? []
  const points = profile.length
    ? profile.map((e, i) => `${(i / Math.max(profile.length - 1, 1)) * width},${height - Math.max(0, Math.min(35, e + 8)) / 35 * height}`)
    : [`0,${height * 0.65}`, `${width * 0.2},${height * 0.48}`, `${width * 0.42},${height * 0.62}`, `${width * 0.7},${height * 0.38}`, `${width},${height * 0.55}`]
  const skyline = `M0,${height} L${points.join(' L')} L${width},${height} Z`

  return (
    <button
      className="terrain-preview"
      type="button"
      aria-label={active ? 'Exit first-person terrain view' : 'Open first-person terrain view'}
      aria-pressed={active}
      disabled={loading}
      onClick={onClick}
    >
      <svg className="terrain-preview-image" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="terrain-preview-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#172943" />
            <stop offset="100%" stopColor="#a07c54" />
          </linearGradient>
        </defs>
        <rect width={width} height={height} fill="url(#terrain-preview-sky)" />
        <path d={skyline} fill="#25252b" stroke="#b4a58c" strokeWidth="1.5" />
        <circle cx="270" cy="18" r="8" fill="#d9d4c7" opacity=".8" />
      </svg>
      <span className="terrain-preview-caption">
        <b>{loading ? 'Preparing terrain view…' : active ? 'Return to map' : 'Explore nearby terrain'}</b>
        <small>{active ? 'Click to restore the previous view' : 'Open low-altitude 3D view'}</small>
      </span>
      <span className="terrain-preview-arrow" aria-hidden="true">{active ? '↩' : '↗'}</span>
    </button>
  )
}
