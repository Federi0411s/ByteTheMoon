/** Small colour-map library: value in [0,1] -> [r,g,b] 0..255. Lookup tables are built once. */

type Stops = [number, number, number][]

// Coarse control points of the matplotlib maps (perceptually uniform, colour-blind friendly).
const STOPS: Record<string, Stops> = {
  viridis: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
  inferno: [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50], [252, 255, 164]],
  cividis: [[0, 34, 78], [40, 56, 108], [87, 92, 109], [125, 124, 120], [165, 158, 118], [210, 195, 101], [253, 234, 69]],
  // sequential blue for "shadow / cold" layers
  ice: [[8, 16, 48], [20, 60, 130], [40, 120, 200], [120, 190, 240], [220, 245, 255]],
  // diverging-ish for slope: green (flat) -> yellow -> red (steep)
  slope: [[26, 152, 80], [145, 207, 96], [217, 239, 139], [254, 224, 139], [252, 141, 89], [215, 48, 39]],
  grey: [[0, 0, 0], [255, 255, 255]],
  // terrain-like for elevation
  terrain: [[40, 30, 90], [50, 90, 160], [80, 160, 160], [170, 200, 120], [220, 200, 140], [240, 240, 240]],
}

const LUTS: Record<string, Uint8ClampedArray> = {}

function buildLut(stops: Stops): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1)
    const k = Math.min(Math.floor(t), stops.length - 2)
    const f = t - k
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] * (1 - f) + stops[k + 1][c] * f
  }
  return lut
}

export function getLut(name: string): Uint8ClampedArray {
  if (!LUTS[name]) LUTS[name] = buildLut(STOPS[name] ?? STOPS.viridis)
  return LUTS[name]
}

export const colormapNames = Object.keys(STOPS)

/** CSS linear-gradient for legends. */
export function cssGradient(name: string): string {
  const s = STOPS[name] ?? STOPS.viridis
  return `linear-gradient(90deg, ${s.map((c, i) => `rgb(${c.join(',')}) ${(i / (s.length - 1)) * 100}%`).join(', ')})`
}
