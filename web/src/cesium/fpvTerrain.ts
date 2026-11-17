/**
 * First-person terrain: one mesh of rings x spokes around the viewer, built from the same height
 * samples (and the same great circles / elevation levels) as the computed horizon (heatWorker
 * heightField), so what you see on the horizon is exactly what the sunlight / Earth analysis uses.
 *
 * Cesium's geographic terrain tiles converge on the poles: near them the tiles degenerate, mixing
 * elevation sources gave seams and cliffs, and the drawn horizon disagreed with the computed one. A
 * local polar mesh has none of that, loads with one request, and has real normals, so slopes are
 * shaded by the Sun (or earthshine) and it casts / receives shadows.
 *
 * Within PHOTO_HALF_M (500 m) of the viewer the sharpest Moon Trek photo of the spot (NAC site mosaics
 * 0.5-1.3 m / px, the polar NAC mosaics ~4 m / px, else Kaguya / WAC) is draped on the mesh, normalised
 * to the regolith grey and faded out towards 500 m into the shaded terrain beyond. Everywhere, a
 * procedural regolith texture adds what no orbital photo resolves: brightness mottling and micro-relief
 * (bump-mapped normals, 15 cm .. 20 m), each scale faded out once it is smaller than a pixel, so the
 * ground at your feet has grain and the low polar Sun rakes across it.
 */
import {
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryInstance,
  GeometryPipeline,
  Material,
  MaterialAppearance,
  Primitive,
  PrimitiveType,
  ShadowMode,
  type Scene,
} from 'cesium'
import trekLayers from './trekLayers.json'

const R = 1737400
export const FPV_AZIMUTHS = 360
/** radius of the photo-draped area around the viewer (m); the photo is a square of twice that */
const PHOTO_HALF_M = 500
const PHOTO_PX = 1024
const TREK = 'https://trek.nasa.gov/tiles/Moon/EQ'
const MAX_PHOTO_TILES = 80

/** ring distances (m): 4 m .. 150 km, x1.035 */
export function fpvRings(): number[] {
  const d: number[] = []
  for (let r = 4; r < 150_000; r *= 1.035) d.push(r)
  return d
}

const GROUND_FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
void main() {
  vec3 n = normalize(v_normalEC);
  if (!gl_FrontFacing) n = -n;
  czm_materialInput mi;
  mi.normalEC = n;
  mi.positionToEyeEC = -v_positionEC;
  mi.st = v_st;
  czm_material m = czm_getMaterial(mi);
  float lambert = max(dot(normalize(m.normal), czm_lightDirectionEC), 0.0) * step(0.0, dot(n, czm_lightDirectionEC));
  // m.diffuse: regolith grey blended with the photo near the viewer; m.normal: with the micro-relief
  // (no light on facets the mesh itself turns away from the Sun); m.specular: "lighting off" level.
  // Realistic lighting: direct light only (no sky in space). Lighting off: an even, map-like light with a
  // touch of relief from the light direction so the ground stays readable
  float amb = m.specular;
  // lighting off: a light raised ~50 deg above the horizon in the Sun's direction, so slopes and the
  // micro-relief read like a shaded map
  float raised = max(dot(normalize(m.normal), normalize(n * 1.2 + czm_lightDirectionEC)), 0.0);
  vec3 c = amb > 0.0 ? m.diffuse * amb * (0.25 + 0.9 * raised) : m.diffuse * czm_lightColor * lambert;
  out_FragColor = vec4(c, 1.0);
}
`

/**
 * Regolith material. Local east / north (m) of the fragment from its eye-relative position (the eye is
 * above the mesh centre and only turns), precise to well under a millimetre at your feet.
 *  - photo: relative brightness (highPass) over the PHOTO_HALF_M square, weight fading from 65 % to
 *    100 % of that radius
 *  - albedo mottling: value noise, 0.6 m .. 90 m (+-7 % per octave) and 300 m .. 25 km (+-3 %)
 *  - micro-relief: 9 octaves 3 cm .. 22 m, height amplitude proportional to wavelength (slopes of
 *    ~9 deg rms per octave), plus small craters (0.6 / 4 / 25 m cells: bowls 0.15 r deep with a low
 *    rim), applied as a normal perturbation in the local east / north frame
 * Every octave fades out when it is under ~2 pixels (fwidth), so nothing shimmers in the distance.
 */
const REGOLITH_MATERIAL = `
float fpvHash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
vec3 fpvNoise(vec2 p) {           // value noise and its gradient
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = fpvHash(i), b = fpvHash(i + vec2(1.0, 0.0)), c = fpvHash(i + vec2(0.0, 1.0)), d = fpvHash(i + vec2(1.0, 1.0));
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * vec2(b - a + k * u.y, c - a + k * u.x));
}
// small craters (cells of size S, at most one per cell): bowl 0.15 r deep inside, a low rim outside;
// returns the height gradient (dh/de, dh/dn)
vec2 fpvCraters(vec2 en, float S, float seed) {
  vec2 g = vec2(0.0), cell = floor(en / S);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    float h1 = fpvHash(c + seed), h2 = fpvHash(c + seed + 17.3), h3 = fpvHash(c + seed + 41.9);
    if (h3 > 0.55) continue;                                    // ~55 % of the cells hold a crater
    vec2 ctr = (c + vec2(h1, h2)) * S;
    float r = S * (0.12 + 0.3 * h3);
    vec2 dv = en - ctr;
    float dist = length(dv), d = dist / r;
    if (d > 1.6 || dist < 1e-5) continue;
    float slope = d < 1.0 ? 0.3 * d : -0.04 * 6.0 * (d - 1.0) * (1.6 - d) / (0.36 * 0.6);   // d(height / r) / d(d)
    g += slope * dv / dist;
  }
  return g;
}
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  vec3 eEC = normalize(czm_viewRotation * eastAxis), nEC = normalize(czm_viewRotation * northAxis);
  vec3 p = -mi.positionToEyeEC;
  vec2 en = vec2(dot(p, eEC), dot(p, nEC));
  float fp = max(length(fwidth(en)), 1e-4);           // ground metres per pixel
  // photo
  vec2 uv = en / ${(2 * PHOTO_HALF_M).toFixed(1)} + 0.5;
  float w = (1.0 - smoothstep(0.65, 1.0, length(en) / ${PHOTO_HALF_M.toFixed(1)})) * step(0.0001, photoGain);
  float detail = clamp(texture(image, clamp(uv, 0.0, 1.0)).r * photoGain, 0.12, 2.2);   // 1 = local mean
  vec3 base = vec3(0.58, 0.57, 0.55) * mix(1.0, detail, w);
  // albedo mottling
  float alb = 0.0, wl = 0.6;
  for (int i = 0; i < 6; i++) {
    float f = 1.0 - smoothstep(0.25, 0.5, fp / wl);
    alb += f * (fpvNoise(en / wl + float(i) * 31.7).x - 0.5) * 0.14;
    wl *= 2.7;
  }
  float big = 0.0;
  wl = 300.0;
  for (int i = 0; i < 5; i++) { big += (fpvNoise(en / wl + float(i) * 7.3).x - 0.5) * 0.06; wl *= 3.0; }
  m.diffuse = clamp(base * (1.0 + alb * (1.0 - 0.5 * w) + big * (1.0 - w)), 0.0, 1.0);
  // micro-relief: rolling noise 3 cm .. 22 m plus small craters
  vec2 g = vec2(0.0);
  wl = 0.03;
  for (int i = 0; i < 9; i++) {
    float f = 1.0 - smoothstep(0.25, 0.5, fp / wl);
    if (f > 0.0) g += f * fpvNoise(en / wl + float(i) * 13.1).yz * 0.16;
    wl *= 2.2;
  }
  float S = 0.6;
  for (int i = 0; i < 3; i++) {
    float f = 1.0 - smoothstep(0.03, 0.08, fp / S);
    if (f > 0.0) g += f * fpvCraters(en, S, float(i) * 7.7);
    S *= 6.5;
  }
  m.normal = normalize(mi.normalEC - g.x * eEC - g.y * nEC);
  m.specular = ambient;
  m.alpha = 1.0;
  return m;
}
`

export interface FpvTerrain {
  primitive: Primitive
  /** terrain height (m) at the viewer */
  centerHeight: number
  /** mesh height (m) at lat / lon (deg); NaN outside the mesh */
  heightAt(latDeg: number, lonDeg: number): number
  setAmbient(a: number): void
  destroy(): void
}

/** great-circle destination from (lat0, lon0) at azimuth az (rad, from north) and distance d (m) */
function dest(sinP: number, cosP: number, lon0: number, sa: number, ca: number, d: number): [number, number] {
  const th = d / R, sinD = Math.sin(th), cosD = Math.cos(th)
  const sinLat = sinP * cosD + cosP * sinD * ca
  return [Math.asin(sinLat), lon0 + Math.atan2(sa * sinD * cosP, cosD - sinP * sinLat)]
}

/**
 * heights: out[0] = centre, then azimuth-major (FPV_AZIMUTHS x rings), from HeatEngine.heightField.
 * Missing samples (NaN) take their ring neighbour's value.
 */
export function buildFpvTerrain(scene: Scene, latDeg: number, lonDeg: number, heights: Float32Array, rings: number[]): FpvTerrain {
  const nAz = FPV_AZIMUTHS, K = rings.length
  const lat0 = (latDeg * Math.PI) / 180, lon0 = (lonDeg * Math.PI) / 180
  const sinP = Math.sin(lat0), cosP = Math.cos(lat0)
  const h0 = Number.isFinite(heights[0]) ? heights[0] : 0
  const nV = 1 + nAz * K
  const pos = new Float64Array(nV * 3)
  const st = new Float32Array(nV * 2) // unused by the shader (local east / north come from the eye-relative position)
  const H = new Float32Array(nV) // heights with gaps filled (for heightAt)
  const put = (i: number, lat: number, lon: number, h: number) => {
    const r = R + h, cl = Math.cos(lat)
    pos[i * 3] = r * cl * Math.cos(lon); pos[i * 3 + 1] = r * cl * Math.sin(lon); pos[i * 3 + 2] = r * Math.sin(lat)
    H[i] = h
  }
  put(0, lat0, lon0, h0)
  for (let a = 0; a < nAz; a++) {
    const az = (2 * Math.PI * a) / nAz, sa = Math.sin(az), ca = Math.cos(az)
    let last = h0
    for (let k = 0; k < K; k++) {
      const [lat, lon] = dest(sinP, cosP, lon0, sa, ca, rings[k])
      let h = heights[1 + a * K + k]
      if (!Number.isFinite(h)) h = last
      last = h
      put(1 + a * K + k, lat, lon, h)
    }
  }
  // triangles: centre fan to ring 0, then quads between rings k and k + 1
  const idx = new Uint32Array(nAz * 3 + nAz * (K - 1) * 6)
  let o = 0
  const v = (a: number, k: number) => 1 + (((a % nAz) + nAz) % nAz) * K + k
  for (let a = 0; a < nAz; a++) { idx[o++] = 0; idx[o++] = v(a, 0); idx[o++] = v(a + 1, 0) }
  for (let a = 0; a < nAz; a++) for (let k = 0; k < K - 1; k++) {
    const p = v(a, k), q = v(a + 1, k), p2 = v(a, k + 1), q2 = v(a + 1, k + 1)
    idx[o++] = p; idx[o++] = p2; idx[o++] = q
    idx[o++] = q; idx[o++] = p2; idx[o++] = q2
  }
  let geometry = new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: pos }),
      st: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: st }),
    } as never,
    indices: idx,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(pos as unknown as number[]),
  })
  geometry = GeometryPipeline.computeNormal(geometry)

  // photo: a 1 px grey placeholder until loaded (weight 0 then)
  const blank = document.createElement('canvas')
  blank.width = blank.height = 1
  const east = new Cartesian3(-Math.sin(lon0), Math.cos(lon0), 0)
  const north = new Cartesian3(-sinP * Math.cos(lon0), -sinP * Math.sin(lon0), cosP)
  const material = new Material({
    fabric: {
      type: 'FpvRegolith',
      uniforms: { ambient: 0.0, image: blank.toDataURL(), photoGain: 0.0, eastAxis: east, northAxis: north },
      source: REGOLITH_MATERIAL,
    },
  })
  const primitive = scene.primitives.add(new Primitive({
    geometryInstances: new GeometryInstance({ geometry }),
    appearance: new MaterialAppearance({
      material, materialSupport: MaterialAppearance.MaterialSupport.TEXTURED, translucent: false, closed: false, faceForward: false,
      fragmentShaderSource: GROUND_FS,
    }),
    asynchronous: false,
    shadows: ShadowMode.ENABLED,
  })) as Primitive
  scene.requestRender()

  let disposed = false
  void loadPhoto(lat0, lon0).then((photo) => {
    if (disposed || !photo) return
    material.uniforms.image = photo.url
    material.uniforms.photoGain = photo.gain
    scene.requestRender()
  })

  return {
    primitive,
    centerHeight: h0,
    heightAt(latDeg2, lonDeg2) {
      const lat = (latDeg2 * Math.PI) / 180, lon = (lonDeg2 * Math.PI) / 180
      const c = Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(lon - lon0)
      const d = Math.acos(Math.max(-1, Math.min(1, c))) * R
      if (d < rings[0]) return h0
      if (d > rings[K - 1]) return NaN
      const az = Math.atan2(Math.sin(lon - lon0) * Math.cos(lat), Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(lon - lon0))
      const fa = ((((az / (2 * Math.PI)) * nAz) % nAz) + nAz) % nAz
      const fk = Math.log(d / rings[0]) / Math.log(1.035)
      const a0 = Math.floor(fa), k0 = Math.min(K - 2, Math.floor(fk)), wa = fa - a0, wk = Math.min(1, fk - k0)
      const g = (aa: number, kk: number) => H[v(aa, kk)]
      return (g(a0, k0) * (1 - wa) + g(a0 + 1, k0) * wa) * (1 - wk) + (g(a0, k0 + 1) * (1 - wa) + g(a0 + 1, k0 + 1) * wa) * wk
    },
    setAmbient(a) { material.uniforms.ambient = a; scene.requestRender() },
    destroy() { disposed = true; scene.primitives.remove(primitive) },
  }
}

/**
 * The photo as relative brightness: each pixel over the mean of its surroundings (a box of
 * DETAIL_BOX_M), 128 = the local mean. Orbital photos of the polar regions are averages of low-Sun
 * images with their shadows baked in (crater walls black, rims white); kept whole they put a dark
 * blob around the viewer that ignores the real lighting. As detail they keep the craters, boulders and
 * texture and leave the shading to the real-time Sun / earthshine, and fade seamlessly into the plain
 * regolith beyond (factor 1). Pixels without data stay at 128.
 */
const DETAIL_BOX_M = 40
function highPass(img: ImageData, N: number, out: HTMLCanvasElement, octx: CanvasRenderingContext2D): { url: string; gain: number } {
  const d = img.data
  const lum = new Float64Array(N * N), has = new Float64Array(N * N)
  for (let p = 0; p < N * N; p++) if (d[p * 4 + 3]) { lum[p] = (d[p * 4] + d[p * 4 + 1] + d[p * 4 + 2]) / 3; has[p] = 1 }
  // summed-area tables of brightness and data coverage
  const W = N + 1, sl = new Float64Array(W * W), sh = new Float64Array(W * W)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y + 1) * W + x + 1
    sl[i] = lum[y * N + x] + sl[i - 1] + sl[i - W] - sl[i - W - 1]
    sh[i] = has[y * N + x] + sh[i - 1] + sh[i - W] - sh[i - W - 1]
  }
  const r = Math.max(2, Math.round((DETAIL_BOX_M / 2 / (2 * PHOTO_HALF_M)) * N))
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const p = y * N + x
    let v = 128
    if (has[p]) {
      const x0 = Math.max(0, x - r), x1 = Math.min(N, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(N, y + r + 1)
      const box = (t: Float64Array) => t[y1 * W + x1] - t[y0 * W + x1] - t[y1 * W + x0] + t[y0 * W + x0]
      const mean = box(sl) / Math.max(1, box(sh))
      v = Math.min(255, Math.round((128 * (lum[p] + 6)) / (mean + 6)))
    }
    d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = v; d[p * 4 + 3] = 255
  }
  octx.putImageData(img, 0, 0)
  return { url: out.toDataURL('image/jpeg', 0.92), gain: 255 / 128 }
}

/** bilinear sample of a 256 px RGBA tile at pixel coordinates (px, py) (0..256, clamped at the tile edge); null where any texel is transparent */
const texel: [number, number, number] = [0, 0, 0]
function bilinear(t: Uint8ClampedArray, px: number, py: number): [number, number, number] | null {
  const x = Math.min(255, Math.max(0, px - 0.5)), y = Math.min(255, Math.max(0, py - 0.5))
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1), wx = x - x0, wy = y - y0
  const i00 = (y0 * 256 + x0) * 4, i10 = (y0 * 256 + x1) * 4, i01 = (y1 * 256 + x0) * 4, i11 = (y1 * 256 + x1) * 4
  if (t[i00 + 3] === 0 || t[i10 + 3] === 0 || t[i01 + 3] === 0 || t[i11 + 3] === 0) return null
  for (let c = 0; c < 3; c++) texel[c] = (t[i00 + c] * (1 - wx) + t[i10 + c] * wx) * (1 - wy) + (t[i01 + c] * (1 - wx) + t[i11 + c] * wx) * wy
  return texel
}

/** Moon Trek polar-stereographic LROC NAC mosaics: level 0 = one 256 px tile over +-1,095,930 m, x right, y up */
const POLAR_HALF_EXTENT = 1095930
const POLAR_LEVEL = 11

function squarePixels(lat0: number, lon0: number) {
  const sinP = Math.sin(lat0), cosP = Math.cos(lat0)
  const N = PHOTO_PX
  const ll = new Float64Array(N * N * 2)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = ((i + 0.5) / N - 0.5) * 2 * PHOTO_HALF_M, n = (0.5 - (j + 0.5) / N) * 2 * PHOTO_HALF_M
    const d = Math.hypot(e, n), az = Math.atan2(e, n)
    const [la, lo] = d > 0 ? dest(sinP, cosP, lon0, Math.sin(az), Math.cos(az), d) : [lat0, lon0]
    ll[(j * N + i) * 2] = lo
    ll[(j * N + i) * 2 + 1] = la
  }
  return ll
}

async function loadPolarPhoto(lat0: number, lon0: number): Promise<{ url: string; gain: number } | null> {
  const south = lat0 < 0
  const id = south ? 'LRO_NAC_AvgMosaic_SPole855_1mp' : 'LRO_NAC_AvgMosaic_NPole855_1mp'
  const base = `https://trek.nasa.gov/tiles/Moon/${south ? 'SP' : 'NP'}/${id}/1.0.0/default/default028mm/${POLAR_LEVEL}`
  const tileM = (2 * POLAR_HALF_EXTENT) / 2 ** POLAR_LEVEL
  const N = PHOTO_PX, ll = squarePixels(lat0, lon0)
  // polar stereographic (R = 1737.4 km): south x = rho sin lon, y = rho cos lon; north y = -rho cos lon
  const xy = new Float64Array(N * N * 2)
  const need = new Set<number>()
  for (let p = 0; p < N * N; p++) {
    const lon = ll[p * 2], lat = ll[p * 2 + 1]
    const rho = 2 * R * Math.tan((Math.PI / 2 - Math.abs(lat)) / 2)
    const x = rho * Math.sin(lon), y = (south ? 1 : -1) * rho * Math.cos(lon)
    xy[p * 2] = x; xy[p * 2 + 1] = y
    if (p % 29 === 0) need.add(Math.floor((POLAR_HALF_EXTENT - y) / tileM) * 1e5 + Math.floor((x + POLAR_HALF_EXTENT) / tileM))
  }
  // corners too, so edge tiles are not missed
  for (const p of [0, N - 1, N * (N - 1), N * N - 1]) need.add(Math.floor((POLAR_HALF_EXTENT - xy[p * 2 + 1]) / tileM) * 1e5 + Math.floor((xy[p * 2] + POLAR_HALF_EXTENT) / tileM))
  if (need.size > 64) return null
  const data = new Map<number, Uint8ClampedArray | null>()
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  await Promise.all([...need].map(async (key) => {
    const row = Math.floor(key / 1e5), col = key % 1e5
    try {
      const r = await fetch(`${base}/${row}/${col}.png`)
      if (!r.ok) { data.set(key, null); return }
      const bmp = await createImageBitmap(await r.blob())
      ctx.clearRect(0, 0, 256, 256)
      ctx.drawImage(bmp, 0, 0, 256, 256)
      bmp.close()
      data.set(key, ctx.getImageData(0, 0, 256, 256).data)
    } catch { data.set(key, null) }
  }))
  const out = document.createElement('canvas')
  out.width = out.height = N
  const octx = out.getContext('2d')!
  const img = octx.createImageData(N, N)
  let cnt = 0
  for (let p = 0; p < N * N; p++) {
    const fc = (xy[p * 2] + POLAR_HALF_EXTENT) / tileM, fr = (POLAR_HALF_EXTENT - xy[p * 2 + 1]) / tileM
    const col = Math.floor(fc), row = Math.floor(fr)
    const t = data.get(row * 1e5 + col)
    if (!t) continue
    const c = bilinear(t, (fc - col) * 256, (fr - row) * 256)
    if (!c) continue // transparent: no data
    img.data[p * 4] = c[0]; img.data[p * 4 + 1] = c[1]; img.data[p * 4 + 2] = c[2]; img.data[p * 4 + 3] = 255
    cnt++
  }
  if (cnt < N * N * 0.5) return null
  return highPass(img, N, out, octx)
}

interface TrekLayer { id: string; kind: 'global' | 'regional'; maxLevel: number; ext: string; bbox: [number, number, number, number] }

/**
 * The sharpest Moon Trek photo of the PHOTO_HALF_M square around (lat0, lon0) as a PHOTO_PX image in the
 * square's east / north frame, plus the gain normalising its mean brightness to the regolith grey.
 */
async function loadPhoto(lat0: number, lon0: number): Promise<{ url: string; gain: number } | null> {
  // near the poles: the polar-stereographic LROC NAC mosaics (~4 m / px at level 11); the geographic
  // tiles are so narrow there that a few dozen of them only reach ~170 m / px
  if (Math.abs(lat0) > (85.3 * Math.PI) / 180) {
    const polar = await loadPolarPhoto(lat0, lon0).catch(() => null)
    if (polar) return polar
  }
  const latD = (lat0 * 180) / Math.PI, lonD = (((lon0 * 180) / Math.PI + 540) % 360) - 180
  const covers = (l: TrekLayer) => latD >= l.bbox[1] && latD <= l.bbox[3] && lonD >= l.bbox[0] && lonD <= l.bbox[2]
  const layers = (trekLayers as unknown as TrekLayer[]).filter(covers)
  const rank = (l: TrekLayer) => (l.kind === 'regional' ? 0 : l.id.includes('NAC') ? 1 : l.id.startsWith('Kaguya') ? 2 : 3)
  layers.sort((a, b) => rank(a) - rank(b) || b.maxLevel - a.maxLevel)
  const layer = layers[0]
  if (!layer) return null
  // geographic lon / lat of every photo pixel (great-circle offsets from the viewer)
  const sinP = Math.sin(lat0), cosP = Math.cos(lat0)
  const N = PHOTO_PX
  const ll = new Float64Array(N * N * 2)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const e = ((i + 0.5) / N - 0.5) * 2 * PHOTO_HALF_M, n = (0.5 - (j + 0.5) / N) * 2 * PHOTO_HALF_M
    const d = Math.hypot(e, n), az = Math.atan2(e, n)
    const [la, lo] = d > 0 ? dest(sinP, cosP, lon0, Math.sin(az), Math.cos(az), d) : [lat0, lon0]
    ll[(j * N + i) * 2] = ((lo + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
    ll[(j * N + i) * 2 + 1] = la
  }
  // the finest level at which the square needs at most MAX_PHOTO_TILES tiles (near the pole the
  // geographic tiles get very narrow)
  let z = layer.maxLevel, tiles = new Set<number>()
  for (; z >= 0; z--) {
    tiles = new Set<number>()
    const n = 2 ** z, step = Math.PI / n
    for (let p = 0; p < N * N; p += 37) {
      const x = Math.min(2 * n - 1, Math.floor((ll[p * 2] + Math.PI) / step)), y = Math.min(n - 1, Math.floor((Math.PI / 2 - ll[p * 2 + 1]) / step))
      tiles.add(y * 1e6 + x)
    }
    if (tiles.size <= MAX_PHOTO_TILES) break
  }
  const n = 2 ** z, step = Math.PI / n
  const data = new Map<number, Uint8ClampedArray | null>()
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const ctx = cv.getContext('2d', { willReadFrequently: true })!
  await Promise.all([...tiles].map(async (key) => {
    const y = Math.floor(key / 1e6), x = key % 1e6
    try {
      const r = await fetch(`${TREK}/${layer.id}/1.0.0/default/default028mm/${z}/${y}/${x}.${layer.ext}`)
      if (!r.ok) { data.set(key, null); return }
      const bmp = await createImageBitmap(await r.blob())
      ctx.clearRect(0, 0, 256, 256)
      ctx.drawImage(bmp, 0, 0, 256, 256)
      bmp.close()
      data.set(key, ctx.getImageData(0, 0, 256, 256).data)
    } catch { data.set(key, null) }
  }))
  // resample into the local square
  const out = document.createElement('canvas')
  out.width = out.height = N
  const octx = out.getContext('2d')!
  const img = octx.createImageData(N, N)
  let cnt = 0
  for (let p = 0; p < N * N; p++) {
    const fx = (ll[p * 2] + Math.PI) / step, fy = (Math.PI / 2 - ll[p * 2 + 1]) / step
    const x = Math.min(2 * n - 1, Math.floor(fx)), y = Math.min(n - 1, Math.floor(fy))
    const t = data.get(y * 1e6 + x)
    if (!t) continue
    const c = bilinear(t, (fx - x) * 256, (fy - y) * 256)
    if (!c) continue
    img.data[p * 4] = c[0]; img.data[p * 4 + 1] = c[1]; img.data[p * 4 + 2] = c[2]; img.data[p * 4 + 3] = 255
    cnt++
  }
  if (cnt < N * N * 0.5) return null
  return highPass(img, N, out, octx)
}
