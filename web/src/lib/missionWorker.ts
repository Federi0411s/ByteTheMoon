/// <reference lib="webworker" />
/**
 * Mission-period visibility for a slice of horizon-grid cells (all within ~6 deg of the south pole).
 *
 * init:    { type: 'init', hz: Float32Array (cells x nAz, degrees), lonlat: Float64Array (cells x 2, radians), nAz, azStepDeg }
 * compute: { type: 'compute', id, sun: Float32Array (N x 4: unit dir xyz + angular radius deg), earth: same }
 * reply:   { id, sun: Float32Array (cells), earth: Float32Array (cells) }  — fractions 0..1, NaN = no data
 *
 * Method: see visibility() below (time steps binned by body longitude + lookup tables).
 */

let hz: Float32Array
let nAz = 180
let azStep = 2
let cosLat: Float64Array, sinLat: Float64Array, cosLon: Float64Array, sinLon: Float64Array, lonDeg: Float64Array
let hMin: Float32Array, hMax: Float32Array

const R2D = 180 / Math.PI

// Visible fraction as a function of horizon height u (deg), per body-longitude bin.
const U0 = -12, DU = 0.02, NU = 1500 // u in [-12, 18) deg

/**
 * Binned evaluation (cost independent of the number of time steps):
 *   el(cell, t) ~= a(cell, az) + v(t),  a = asin(cos(lat) cos(az)),  v = asin(-sz(t)),  az = lonBody(t) - lonCell
 * Time steps are grouped by body longitude into the horizon's azimuth bins. For each bin we tabulate
 *   G_b(u) = (1/N) sum_{t in b} discFraction((v_t - u) / r)
 * and a cell's average is sum_b G_b(h(az_b) - a(az_b)). Errors: < 1 deg in azimuth (half a bin),
 * ~0.02 deg in elevation, both below the horizon mask's own resolution.
 */
function visibility(body: Float32Array, out: Float32Array) {
  const nT = body.length / 4
  const nB = nAz
  const counts = new Int32Array(nB)
  const binOf = new Int32Array(nT)
  const v = new Float64Array(nT)
  let rMean = 0
  for (let j = 0; j < nT; j++) {
    const x = body[j * 4], y = body[j * 4 + 1], z = body[j * 4 + 2]
    const lon = Math.atan2(y, x) * R2D
    let b = Math.floor((lon + 180) / azStep)
    if (b >= nB) b = nB - 1
    binOf[j] = b
    counts[b]++
    v[j] = Math.asin(-z) * R2D
    rMean += body[j * 4 + 3]
  }
  rMean /= nT
  const kr = Math.ceil(rMean / DU)
  const K = new Float64Array(2 * kr + 1) // K[d + kr] = discFraction(d * DU / r)
  for (let d = -kr; d <= kr; d++) {
    const x = Math.max(-1, Math.min(1, (d * DU) / rMean))
    K[d + kr] = 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI
  }
  // tables for non-empty bins: G = (fully-above suffix) + disc kernel scattered from each sample
  const bins: number[] = []
  const tables: Float64Array[] = []
  const members: number[][] = Array.from({ length: nB }, () => [])
  for (let j = 0; j < nT; j++) members[binOf[j]].push(j)
  for (let b = 0; b < nB; b++) {
    if (!counts[b]) continue
    const G = new Float64Array(NU)
    const full = new Float64Array(NU + 1) // samples whose disc is entirely above u = U0 + i*DU
    for (const j of members[b]) {
      const iv = Math.round((v[j] - U0) / DU)
      const lo = iv - kr, hi = iv + kr // partial range
      if (lo > 0) full[Math.min(lo, NU)] += 1 / nT // u index < lo -> fully visible
      for (let i = Math.max(0, lo); i <= Math.min(NU - 1, hi); i++) G[i] += K[iv - i + kr] / nT
    }
    // full[i] currently marks "fully visible for every u index below i": prefix-accumulate from the top
    let run = 0
    for (let i = NU - 1; i >= 0; i--) { run += full[i + 1]; G[i] += run }
    bins.push(b)
    tables.push(G)
  }
  const nb = bins.length
  const cB = new Float64Array(nb), sB = new Float64Array(nb), lonB = new Float64Array(nb)
  for (let k = 0; k < nb; k++) {
    const lon = -180 + (bins[k] + 0.5) * azStep
    lonB[k] = lon
    cB[k] = Math.cos(lon / R2D)
    sB[k] = Math.sin(lon / R2D)
  }
  const cells = out.length
  for (let c = 0; c < cells; c++) {
    if (Number.isNaN(hMin[c])) { out[c] = NaN; continue }
    const cl = cosLat[c], co = cosLon[c], so = sinLon[c], lonC = lonDeg[c]
    const row = c * nAz
    let acc = 0
    for (let k = 0; k < nb; k++) {
      let fa = (lonB[k] - lonC) / azStep
      fa -= Math.floor(fa / nAz) * nAz
      const i0 = fa | 0
      const w = fa - i0
      const h = hz[row + i0] * (1 - w) + hz[row + (i0 + 1 === nAz ? 0 : i0 + 1)] * w
      const x = cl * (cB[k] * co + sB[k] * so)
      const fi = (h - (x + (x * x * x) / 6) * R2D - U0) / DU
      const G = tables[k]
      if (fi <= 0) acc += G[0]
      else if (fi >= NU - 1) acc += G[NU - 1]
      else {
        const i = fi | 0
        acc += G[i] + (G[i + 1] - G[i]) * (fi - i)
      }
    }
    out[c] = acc
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data
  if (m.type === 'init') {
    hz = m.hz
    nAz = m.nAz
    azStep = m.azStepDeg
    const cells = hz.length / nAz
    const ll: Float64Array = m.lonlat
    cosLat = new Float64Array(cells); sinLat = new Float64Array(cells)
    cosLon = new Float64Array(cells); sinLon = new Float64Array(cells); lonDeg = new Float64Array(cells)
    hMin = new Float32Array(cells); hMax = new Float32Array(cells)
    for (let c = 0; c < cells; c++) {
      const lon = ll[c * 2], lat = ll[c * 2 + 1]
      cosLat[c] = Math.cos(lat); sinLat[c] = Math.sin(lat)
      cosLon[c] = Math.cos(lon); sinLon[c] = Math.sin(lon); lonDeg[c] = lon * R2D
      let lo = Infinity, hi = -Infinity
      for (let k = 0; k < nAz; k++) {
        const v = hz[c * nAz + k]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      hMin[c] = lo
      hMax[c] = hi
    }
    return
  }
  if (m.type === 'compute') {
    const t0 = performance.now()
    const cells = hMin.length
    const sun = new Float32Array(cells)
    const earth = new Float32Array(cells)
    visibility(m.sun, sun)
    visibility(m.earth, earth)
    ;(self as unknown as Worker).postMessage({ id: m.id, sun, earth, workMs: performance.now() - t0 }, [sun.buffer, earth.buffer])
  }
}
