/**
 * First-person terrain: one mesh of rings x spokes around the viewer, built from the same height
 * samples (and the same great circles / elevation levels) as the computed horizon (heatWorker
 * heightField), so what you see on the horizon is exactly what the sunlight / Earth analysis uses.
 *
 * Cesium's geographic terrain tiles converge on the poles: near them the tiles degenerate, mixing
 * elevation sources gave seams and cliffs, and the drawn horizon disagreed with the computed one. A
 * local polar mesh has none of that, loads with one request, and has real normals, so slopes are
 * shaded by the Sun (or earthshine).
 *
 * Terrain shadows are traced in the shader over the mesh's own heights (a float texture, azimuth x
 * ring): from each pixel towards the light, keeping the steepest terrain in the way, and the share of
 * the Sun's disc above it (penumbra). Same heights as the horizon analysis, so a spot is in shadow
 * exactly when the analysis says the Sun is hidden there; no shadow map (Cesium's, on a 150 km mesh
 * shadowing itself, turned the whole ground black even under a high Sun).
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
import * as Cesium from 'cesium'
import trekLayers from './trekLayers.json'

/** renderer classes Cesium exports at runtime but leaves out of its type definitions */
type CesiumRenderer = {
  Texture: new (o: object) => { destroy(): void }
  Sampler: new (o: object) => object
  PixelFormat: { RED: number }
  PixelDatatype: { FLOAT: number }
  TextureMinificationFilter: { NEAREST: number }
  TextureMagnificationFilter: { NEAREST: number }
  TextureWrap: { CLAMP_TO_EDGE: number }
}
const CR = Cesium as unknown as CesiumRenderer

const R = 1737400
export const FPV_AZIMUTHS = 360
/** radius of the photo-draped area around the viewer (m); the photo is a square of twice that */
const PHOTO_HALF_M = 500
const PHOTO_PX = 1024
/** the Sun's angular radius (rad), as in the shader's shadow tracer */
const SUN_RADIUS_RAD = 0.00466
const TREK = 'https://trek.nasa.gov/tiles/Moon/EQ'
const MAX_PHOTO_TILES = 80

/** ring distances (m): RING0 m .. 150 km, x RING_GROWTH (the shadow tracer indexes rings by these) */
const RING0 = 4
const RING_GROWTH = 1.035
/** the viewer's eye above the ground (m) */
export const EYE_HEIGHT_M = 1.75
/** the shadow tracer stops at the mesh's outer ring */
const MESH_EDGE_M = 200_000
/**
 * ring distances (m): 4 m .. 200 km, x1.035 - out to the horizon analysis's own reach (heatWorker
 * MAX_DIST), so terrain 150-200 km away hides the Sun in the view exactly when it does in the analysis
 */
export function fpvRings(): number[] {
  const d: number[] = []
  for (let r = RING0; r < MESH_EDGE_M * RING_GROWTH; r *= RING_GROWTH) d.push(r)
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
  // realistic: m.shininess = share of the light's disc not hidden by terrain; in shadow, a few % of
  // light scattered from the sunlit terrain around
  vec3 c = amb > 0.0 ? m.diffuse * amb * (0.25 + 0.9 * raised) : m.diffuse * czm_lightColor * lambert * mix(0.04, 1.0, m.shininess);
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
// mesh height (m) at local east / north q, distance d from the centre: bilinear in azimuth x ring
float fpvHeight(vec2 q, float d) {
  float fk = log(max(d, ${RING0.toFixed(1)}) / ${RING0.toFixed(1)}) / ${Math.log(RING_GROWTH).toFixed(8)};
  float fa = atan(q.x, q.y) / 6.2831853 * ${FPV_AZIMUTHS.toFixed(1)};
  fa = fa < 0.0 ? fa + ${FPV_AZIMUTHS.toFixed(1)} : fa;
  int k0 = int(floor(fk)), a0 = int(floor(fa));
  float wk = fk - float(k0), wa = fa - float(a0);
  int K = textureSize(heights, 0).y;
  k0 = clamp(k0, 0, K - 1);
  int k1 = min(k0 + 1, K - 1), a1 = (a0 + 1) % ${FPV_AZIMUTHS};
  a0 = a0 % ${FPV_AZIMUTHS};
  float h00 = texelFetch(heights, ivec2(a0, k0), 0).r, h10 = texelFetch(heights, ivec2(a1, k0), 0).r;
  float h01 = texelFetch(heights, ivec2(a0, k1), 0).r, h11 = texelFetch(heights, ivec2(a1, k1), 0).r;
  return mix(mix(h00, h10, wa), mix(h01, h11, wa), wk);
}
// share of the light's disc (radius 0.267 deg) visible from (en, height hp above the centre's tangent
// plane), light direction l in the local east / north / up frame. Heights are compared on that plane
// (terrain lowered by d^2 / 2R for the curvature); 80 steps growing x1.16 reach the mesh edge.
float fpvLit(vec2 en, float hp, vec3 l) {
  float hz = length(l.xy);
  if (hz < 1e-5) return 1.0;
  vec2 dir = l.xy / hz;
  float tanE = l.z / hz;
  float tanLow = tan(atan(tanE) - 0.00466);                    // the disc's lower edge
  float steep = -1e9;                                         // steepest terrain seen: (h - hp) / t
  float t = max(0.6, 0.004 * length(en));
  for (int i = 0; i < 80; i++) {
    vec2 q = en + dir * t;
    float d = length(q);
    if (d > ${MESH_EDGE_M.toFixed(1)}) break;
    float h = fpvHeight(q, d) - d * d / ${(2 * 1737400).toFixed(1)};
    steep = max(steep, (h - hp - 0.3 - 0.002 * t) / t);
    if (hp + t * tanLow > maxHeight) break;                   // above every peak: nothing more can block
    t *= 1.16;
  }
  float margin = (atan(tanE) - atan(steep)) / 0.00466;        // light centre above the terrain, in disc radii
  float y = clamp(-margin, -1.0, 1.0);
  return (acos(y) - y * sqrt(1.0 - y * y)) / 3.14159265;
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
  // terrain shadow (realistic lighting only): height of this point above the centre's tangent plane
  // from its eye-relative position, light direction in the local frame
  m.shininess = 1.0;
  if (ambient <= 0.0) {
    vec3 uEC = normalize(czm_viewRotation * upAxis);
    vec3 l = czm_lightDirectionEC;
    m.shininess = fpvLit(en, eyeHeight + dot(p, uEC), vec3(dot(l, eEC), dot(l, nEC), dot(l, uEC)));
  }
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
  /** elevation (deg) of this mesh's skyline at azimuth azDeg (from north, clockwise), seen from the eye (curvature included) */
  horizonDeg(azDeg: number): number
  setAmbient(a: number): void
  /** drape the Moon Trek photo near the viewer (loaded on first use) or show the procedural regolith only */
  setPhoto(on: boolean): void
  /**
   * Share (0..1) of the Sun's disc above the terrain horizon seen from the eye at the centre, for a Sun
   * at sunPosM (Moon-fixed, m): same heights and curvature as the shader's shadow tracer (fpvLit)
   */
  sunVisible(sunPosM: [number, number, number]): number
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
export function buildFpvTerrain(scene: Scene, latDeg: number, lonDeg: number, heights: Float32Array, rings: number[], usePhoto = true): FpvTerrain {
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
  // the eye's height, for the drawn skyline (horizonDeg: what the view shows hiding the Sun, for its glare)
  const hEye = h0 + EYE_HEIGHT_M
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
  const up = new Cartesian3(cosP * Math.cos(lon0), cosP * Math.sin(lon0), sinP)
  const east = new Cartesian3(-Math.sin(lon0), Math.cos(lon0), 0)
  const north = new Cartesian3(-sinP * Math.cos(lon0), -sinP * Math.sin(lon0), cosP)
  const material = new Material({
    // opaque: Cesium counts a material with its own shader source as translucent unless told otherwise,
    // and in the blended pass the Sun / Earth behind the hills showed through them
    translucent: false,
    fabric: {
      type: 'FpvRegolith',
      uniforms: {
        ambient: 0.0, image: blank.toDataURL(), photoGain: 0.0, eastAxis: east, northAxis: north,
        // terrain shadows: mesh heights (float texture, set below), the eye's height, the local up
        // (the default image id loads nothing: a placeholder image finishing its load after the height
        // texture was set replaced it and destroyed it)
        heights: Material.DefaultImageId, maxHeight: 0.0, eyeHeight: h0 + EYE_HEIGHT_M, upAxis: up,
      },
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
    shadows: ShadowMode.DISABLED, // terrain shadows are traced in the shader (REGOLITH_MATERIAL fpvLit)
  })) as Primitive
  // mesh heights as a float texture (x = azimuth, y = ring; heights relative to the centre's tangent
  // plane come from these minus d^2 / 2R in the shader) and the highest point on that plane
  const hTex = new Float32Array(nAz * K)
  let maxHeight = -1e9
  for (let a = 0; a < nAz; a++) for (let k = 0; k < K; k++) {
    const h = H[v(a, k)]
    hTex[k * nAz + a] = h
    maxHeight = Math.max(maxHeight, h - (rings[k] * rings[k]) / (2 * R))
  }
  const heightTexture = new CR.Texture({
    context: (scene as unknown as { context: object }).context,
    width: nAz, height: K,
    pixelFormat: CR.PixelFormat.RED, pixelDatatype: CR.PixelDatatype.FLOAT,
    source: { arrayBufferView: hTex }, flipY: false,
    sampler: new CR.Sampler({
      minificationFilter: CR.TextureMinificationFilter.NEAREST, magnificationFilter: CR.TextureMagnificationFilter.NEAREST,
      wrapS: CR.TextureWrap.CLAMP_TO_EDGE, wrapT: CR.TextureWrap.CLAMP_TO_EDGE,
    }),
  })
  material.uniforms.heights = heightTexture
  material.uniforms.maxHeight = maxHeight
  scene.requestRender()

  // photo off: photoGain 0 gives the procedural regolith alone (the shader skips the photo weight)
  let disposed = false
  let photo: { url: string; gain: number } | null = null
  let photoRequested = false
  const applyPhoto = () => {
    if (usePhoto && photo) material.uniforms.image = photo.url
    material.uniforms.photoGain = usePhoto && photo ? photo.gain : 0
    scene.requestRender()
  }
  const requestPhoto = () => {
    if (photoRequested) return
    photoRequested = true
    void loadPhoto(lat0, lon0).then((p) => {
      if (disposed || !p) return
      photo = p
      applyPhoto()
    })
  }
  if (usePhoto) requestPhoto()

  return {
    primitive,
    centerHeight: h0,
    horizonDeg(azDeg) {
      // as the mesh draws it: heights interpolated between the two spokes ring by ring, then the
      // highest (interpolating the spokes' own skylines overstated it between them, hiding a sliver
      // of Sun the view showed)
      const fa = ((((azDeg / 360) * nAz) % nAz) + nAz) % nAz
      const a0 = Math.floor(fa), w = fa - a0, a1 = (a0 + 1) % nAz
      let best = -Math.PI / 2
      for (let k = 0; k < K; k++) {
        const hk = H[v(a0, k)] * (1 - w) + H[v(a1, k)] * w
        best = Math.max(best, Math.atan2(hk - hEye - (rings[k] * rings[k]) / (2 * R), rings[k]))
      }
      return (best * 180) / Math.PI
    },
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
    sunVisible(sunPosM) {
      // Sun direction in the local east / north / up frame (it is far enough to ignore the eye's offset)
      const n = Math.hypot(sunPosM[0], sunPosM[1], sunPosM[2])
      const sx = sunPosM[0] / n, sy = sunPosM[1] / n, sz = sunPosM[2] / n
      const se = sx * east.x + sy * east.y + sz * east.z
      const sn = sx * north.x + sy * north.y + sz * north.z
      const su = sx * up.x + sy * up.y + sz * up.z
      const elev = Math.atan2(su, Math.hypot(se, sn))
      // terrain horizon at the Sun's azimuth: steepest (height on the tangent plane - eye) / distance
      // over the rings, linear between the two nearest spokes
      const fa = ((((Math.atan2(se, sn) / (2 * Math.PI)) * nAz) % nAz) + nAz) % nAz
      const a0 = Math.floor(fa), wa = fa - a0
      const eye = h0 + EYE_HEIGHT_M
      let steep = -Infinity
      for (let k = 0; k < K; k++) {
        const d = rings[k]
        const h = H[v(a0, k)] * (1 - wa) + H[v(a0 + 1, k)] * wa - (d * d) / (2 * R)
        steep = Math.max(steep, (h - eye) / d)
      }
      const y = Math.max(-1, Math.min(1, -(elev - Math.atan(steep)) / SUN_RADIUS_RAD))
      return (Math.acos(y) - y * Math.sqrt(1 - y * y)) / Math.PI
    },
    setPhoto(on) {
      usePhoto = on
      if (on) requestPhoto()
      applyPhoto()
    },
    destroy() {
      disposed = true
      scene.primitives.remove(primitive)
      if (!material.isDestroyed()) material.destroy() // with its textures (the photo, the height texture)
    },
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
