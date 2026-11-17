/**
 * The starry sky, at the real position of every star at the simulation instant, and - in the
 * first-person view - only the stars a human eye could actually see there.
 *
 * Catalogue: all 15,400 Hipparcos stars brighter than V = 7.0 (pipeline/stars.py), i.e. every star
 * visible to the naked eye even under the darkest sky.
 *
 * Positions, at any instant t:
 *  - proper motion from the catalogue epoch (J1991.25) to t;
 *  - annual aberration: the Moon's velocity around the Sun (~30 km/s, from the ephemeris) shifts every
 *    star up to ~20" towards the apex of the motion;
 *  - ICRF -> Moon-fixed (the scene frame) with the IAU 2009 rotation model of the Moon (lib/dsn.ts), so
 *    the sky turns once per sidereal month (27.3 d) around the Moon's pole, with the librations.
 *  The Moon-to-star parallax (< 0.8") and the Sun's light bending (< 2" at the limb) are left out.
 *
 * Rendering: Cesium's sky-box slot (drawn first, behind everything, no depth), one draw call of points
 * whose positions and visibility are computed in the vertex shader from a handful of uniforms; only
 * the stars that could be visible this frame are drawn (the catalogue is sorted by magnitude). No
 * twinkling: there is no atmosphere.
 *
 * Visibility (first person, `vision`): there is no sky glow on the Moon, so what hides the stars in
 * daytime is the eye itself, modelled with standard vision-science results:
 *  - veiling glare: light scattered inside the eye from bright sources in the field, laid over the
 *    dark sky around each star - CIE 146:2002 general disability glare equation (age 30, average eye
 *    pigmentation) for the Sun and the Earth, and integrated over the sunlit / earthlit ground below
 *    the horizon (flat horizon, regolith albedo 0.12) for the ground;
 *  - adaptation: the retina cannot adapt fully to the dark sky while bright ground fills the rest of
 *    the field - adaptation luminance 0.923 x the central field (sky + glare) + 0.077 x the mean
 *    luminance of the surround (Moon & Spencer 1945);
 *  - detection threshold of a point source at that adaptation: Schaefer (1990, after Hecht 1947 and
 *    Blackwell 1946), rods and cones (whichever is more sensitive);
 *  - pupil: closed by the light entering the eye (Stanley & Davies 1995), relative to the pupil of the
 *    threshold data (a uniform field at the adaptation luminance): the bright ground costs ~0.5-1 mag;
 *  - colour only for stars above the cone threshold (rods are colour-blind: faint stars look white).
 *  So: all stars to V ~7.3 in a night with the Earth below the horizon (far side, poles), ~mag 4 in a
 *  near-side night under the full Earth (none right around its disc); at sunrise they fade as the
 *  ground brightens, faint ones first; in full daylight none with the Sun or much sunlit ground in
 *  view (as the Apollo crews reported), at most the brightest handful (~mag 0.5) looking high up away
 *  from the Sun. Dark adaptation over time (minutes) is not modelled:
 *  the eye is taken as adapted to the current scene. From orbit the sky is shown as to a dark-adapted
 *  eye.
 *
 * On screen: a star the eye can just see shows as a faint but clearly visible dot (it fades in over
 * the first 0.5 magnitude above the threshold, so stars still appear and vanish continuously, faint
 * ones first); brighter ones grow as (E / E_threshold)^0.75, between the perceived brightness of a
 * point source (Stevens' law, exponent 0.5) and the screen's own lightness response. Beyond a
 * full-white core the image grows instead (up to 4x wider).
 */
import { BlendingState, Cartesian3, Cartesian4, ComponentDatatype, Matrix3, PrimitiveType, type Viewer } from 'cesium'
import * as Cesium from 'cesium'
import { moonFixedToIcrf } from '../lib/dsn'
import { DATA_URL } from '../lib/data'

type V3 = [number, number, number]

/** What the eye has to cope with in the first-person view (null: dark-adapted eye, no glare). */
export interface StarVision {
  /** share of the Sun's light reaching the eye (terrain horizon x eclipse), 0..1 */
  sunVisible: number
  /** illuminance from the Earth as a share of direct sunlight (createViewer earthshineRatio) */
  earthshine: number
}

export interface Stars {
  /** sky at time tMs (UTC); sunAt: Moon-fixed Sun position (m) at any time (for the aberration) */
  update(tMs: number, sunAt: (tMs: number) => V3, earthM: V3, vision: StarVision | null): void
  dispose(): void
}

// ---- Cesium renderer internals (exported at runtime, missing from the type definitions) ----
interface Ctx { readonly _brand?: 'context' }
interface Destroyable { destroy(): void }
const C = Cesium as unknown as {
  Buffer: { createVertexBuffer(o: { context: Ctx; typedArray: Float32Array; usage: unknown }): Destroyable }
  BufferUsage: { STATIC_DRAW: unknown }
  VertexArray: new (o: { context: Ctx; attributes: object[] }) => Destroyable
  ShaderProgram: { fromCache(o: { context: Ctx; vertexShaderSource: string; fragmentShaderSource: string; attributeLocations: Record<string, number> }): Destroyable }
  RenderState: { fromCache(o: object): unknown }
  DrawCommand: new (o: object) => { count: number; vertexArray?: Destroyable; shaderProgram?: Destroyable }
  Pass: { ENVIRONMENT: number }
}
interface FrameState { context: Ctx; camera: { positionWC: Cartesian3 } }

// ---- physical constants ----
/** solar illuminance at 1 AU outside any atmosphere (Darula et al. 2005), lux */
const E_SUN = 1.333e5
const AU_M = 149_597_870_700
const C_MS = 299_792_458
/** normal albedo of the regolith (as the exposure model in celestial.ts) */
const ALBEDO = 0.12
/** sky background in space: zodiacal light + unresolved starlight, ~23 V mag/arcsec² -> cd/m² */
const SKY_L = 7e-5
const EPOCH_MS = Date.UTC(2000, 0, 1, 11, 58, 56) - 3195.9375 * 86400_000 // J1991.25 (Hipparcos)
const YEAR_MS = 365.25 * 86400_000
/** display flux (linear display units x CSS px²) of a star just visible to the eye (0.5 mag above the threshold) */
const FLUX_MIN = 0.14
/** Gaussian width (sigma) of a faint star's image, CSS px */
const SIGMA_PX = 0.65

/** CIE 146 disability glare: veiling luminance (cd/m²) per lux at the eye at angle th (deg); age 30, p = 0.5 */
function cieGlare(th: number) {
  th = Math.max(th, 0.1)
  return 10 / th ** 3 + (5 / th ** 2 + 0.05 / th) * (1 + (30 / 62.5) ** 4) + 0.00125
}

/**
 * Veiling luminance per unit ground luminance for a gaze at elevation h (deg): the ground (everything
 * below a flat horizon) within 90 deg of the gaze, each patch an illuminance L cos(th) dOmega at the eye.
 * Over rings at angle th from the gaze, the part of the ring below the horizon is 2 (pi - psi0) with
 * cos(psi0) = -tan(h) / tan(th). Returned as ln(G) per degree of elevation, 0..90.
 */
function groundGlareTable() {
  const out: number[] = []
  const N = 4000
  for (let hd = 0; hd <= 90; hd++) {
    const h = (hd * Math.PI) / 180, t0 = Math.max(h, (0.1 * Math.PI) / 180), span = Math.PI / 2 - t0
    let g = 0
    for (let k = 0; k < N; k++) {
      const u = (k + 0.5) / N, th = t0 + span * u * u, dth = 2 * span * u / N
      const c = -Math.tan(h) / Math.tan(th)
      const arc = 2 * (Math.PI - Math.acos(Math.max(-1, Math.min(1, c))))
      g += cieGlare((th * 180) / Math.PI) * Math.cos(th) * Math.sin(th) * arc * dth
    }
    out.push(Math.log(Math.max(g, 1e-12)))
  }
  return out
}
const LN_G = groundGlareTable()

const SQ_DEG = (180 / Math.PI) ** 2
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const pupil = (F: number) => { const x = (Math.max(F, 0) / 846) ** 0.41; return 7.75 - 5.75 * x / (x + 2) }
const glareCos = (c: number) => cieGlare((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI) * Math.max(c, 0)
function groundGlare(sinH: number) {
  const h = Math.min(90, Math.max(0, (Math.asin(Math.max(-1, Math.min(1, sinH))) * 180) / Math.PI)), i = Math.min(Math.floor(h), 89)
  return Math.exp(LN_G[i] + (LN_G[i + 1] - LN_G[i]) * (h - i))
}

/**
 * Limiting magnitude looking along cosines (cs, ce, sh) to the Sun, the Earth and the zenith: the CPU twin
 * of the vertex shader (VS), same model. Schaefer (1990): threshold I = c1 (1 + sqrt(c2 B))² foot-candles
 * on a background B in nanolamberts, m = -16.57 - 2.5 log10 I, rods (night) or cones (day).
 */
function limitingMag(cs: number, ce: number, sh: number, eSun: number, eEarth: number, lGround: number) {
  const veil = SKY_L + eSun * glareCos(cs) + eEarth * glareCos(ce) + lGround * groundGlare(sh)
  const ground = Math.PI - 2 * Math.asin(Math.max(0, Math.min(1, sh))) // solid angle of the ground in the field
  const adapt = 0.923 * veil + 0.077 * lGround * ground / (2 * Math.PI) // Moon & Spencer 1945 surround
  const B = adapt / 3.183e-6
  const night = 1.58e-10 * (1 + Math.sqrt(0.0126 * B)) ** 2, day = 4.47e-9 * (1 + Math.sqrt(1.26e-6 * B)) ** 2
  const F = SQ_DEG * (eSun * smoothstep(-0.17, 0.17, cs) + eEarth * smoothstep(-0.17, 0.17, ce) + lGround * ground + 2 * Math.PI * veil)
  const Fb = SQ_DEG * 2 * Math.PI * adapt
  return -16.57 - 2.5 * Math.log10(Math.min(night, day)) + Math.min(0, 5 * Math.log10(pupil(F) / pupil(Fb)))
}

/** gaze directions for the frame's best limiting magnitude: a Fibonacci sphere */
const PROBES: V3[] = Array.from({ length: 400 }, (_, i) => {
  const z = 1 - (2 * (i + 0.5)) / 400, r = Math.sqrt(1 - z * z), a = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(a), r * Math.sin(a), z]
})

const VS = `
in vec3 a_dir;   // ICRF unit vector at the catalogue epoch
in vec3 a_pm;    // proper motion, rad/yr (ICRF)
in vec4 a_col;   // linear RGB of unit luminance, V magnitude
uniform mat3 u_rot;     // ICRF -> Moon-fixed
uniform float u_years;  // since the catalogue epoch
uniform vec3 u_beta;    // observer velocity / c (ICRF): aberration
uniform vec4 u_sun;     // direction to the Sun (Moon-fixed), illuminance at the eye (lux)
uniform vec4 u_earth;   // direction to the Earth, illuminance at the eye (lux)
uniform vec4 u_up;      // local vertical, ground luminance (cd/m2)
uniform float u_sky;    // sky background (cd/m2)
out vec3 v_col;
out float v_peak;
out float v_sigma;
out float v_half;

const float LN_G[91] = float[91](${LN_G.map((v) => v.toFixed(5)).join(', ')});

// CIE 146 disability glare per lux at the eye, cos-weighted (illuminance on the plane facing the gaze)
float glare(float c) {
  float th = max(degrees(acos(clamp(c, -1.0, 1.0))), 0.1);
  float f = 10.0 / (th * th * th) + (5.0 / (th * th) + 0.05 / th) * ${(1 + (30 / 62.5) ** 4).toFixed(5)} + 0.00125;
  return f * max(c, 0.0);
}
float groundGlare(float sinH) {
  float h = clamp(degrees(asin(clamp(sinH, -1.0, 1.0))), 0.0, 90.0);
  int i = int(min(floor(h), 89.0));
  return exp(mix(LN_G[i], LN_G[i + 1], h - float(i)));
}
// pupil diameter (mm) for a corneal flux density F (cd deg2 / m2), Stanley & Davies 1995
float pupil(float F) {
  float x = pow(max(F, 0.0) / 846.0, 0.41);
  return 7.75 - 5.75 * x / (x + 2.0);
}

void main() {
  vec3 d = normalize(a_dir + a_pm * u_years);
  d = normalize(d + u_beta);
  vec3 w = u_rot * d;
  vec4 clip = czm_projection * vec4(czm_viewRotation * w, 1.0);
  clip.z = 0.0; // at infinity: no depth (drawn first, everything else covers it); behind the camera w < 0 clips it
  gl_Position = clip;

  float cs = dot(w, u_sun.xyz), ce = dot(w, u_earth.xyz), sh = dot(w, u_up.xyz);
  // veiling luminance over the dark sky at this star (looking at it)
  float veil = u_sky + u_sun.w * glare(cs) + u_earth.w * glare(ce) + u_up.w * groundGlare(sh);
  // ... and the bright ground in the rest of the field keeps the retina from adapting fully to the dark
  // sky: adaptation luminance 0.923 x central field + 0.077 x surround (Moon & Spencer 1945)
  float ground = 3.14159265 - 2.0 * asin(clamp(sh, 0.0, 1.0)); // solid angle of the ground in the field
  float adapt = 0.923 * veil + 0.077 * u_up.w * ground / 6.2831853;
  // Schaefer 1990: point-source thresholds (log10 foot-candles), B in nanolamberts
  float B = adapt * ${(1 / 3.183e-6).toFixed(1)};
  float tNight = -9.80134 + 2.0 * log(1.0 + sqrt(0.0126 * B)) / log(10.0);
  float tDay = -8.34969 + 2.0 * log(1.0 + sqrt(1.26e-6 * B)) / log(10.0);
  // pupil closed by all the light entering the eye from the half space in front (sources within 90 deg
  // of the gaze, ground below the horizon: solid angle pi - 2h), relative to the threshold data's pupil
  float F = ${((180 / Math.PI) ** 2).toFixed(2)} * (u_sun.w * smoothstep(-0.17, 0.17, cs) + u_earth.w * smoothstep(-0.17, 0.17, ce)
    + u_up.w * ground + 6.2831853 * veil);
  float Fb = ${((180 / Math.PI) ** 2).toFixed(2)} * 6.2831853 * adapt;
  float dmPupil = min(0.0, 5.0 * log(pupil(F) / pupil(Fb)) / log(10.0));
  float mag = a_col.a;
  float dm = -16.57 - 2.5 * min(tNight, tDay) + dmPupil - mag;     // magnitudes above the threshold
  float dmCone = -16.57 - 2.5 * tDay + dmPupil - mag;
  if (dm <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); gl_PointSize = 1.0; v_peak = 0.0; v_sigma = 1.0; v_half = 0.5; v_col = vec3(0.0); return; }
  // brightness on screen (see the header): fades in over the first 0.5 mag above the threshold to a
  // faint but clearly visible dot, then grows as (E / E_threshold)^0.75
  float flux = ${FLUX_MIN.toFixed(4)} * smoothstep(0.0, 0.5, dm) * pow(10.0, 0.3 * max(dm - 0.5, 0.0));
  float s0 = ${SIGMA_PX.toFixed(3)};
  float peak = flux / (6.2831853 * s0 * s0);
  float sigma = s0;
  if (peak > 1.0) { sigma = min(s0 * sqrt(peak), 4.0 * s0); peak = flux / (6.2831853 * sigma * sigma); }
  v_sigma = sigma * czm_pixelRatio;
  v_peak = peak;
  float size = 2.0 * ceil(3.0 * v_sigma) + 1.0;
  gl_PointSize = size;
  v_half = 0.5 * size;
  // colour only above the cone threshold (rod vision has none)
  v_col = mix(vec3(1.0), a_col.rgb, smoothstep(0.0, 1.5, dmCone));
}
`

const FS = `
in vec3 v_col;
in float v_peak;
in float v_sigma;
in float v_half;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * (2.0 * v_half);
  float a = v_peak * exp(-0.5 * dot(q, q) / (v_sigma * v_sigma));
  if (a < 0.002) discard;
  out_FragColor = vec4(pow(min(v_col * a, vec3(1.0)), vec3(1.0 / 2.2)), 1.0);
}
`

/** linear sRGB (luminance 1) of a star of colour index B-V: Ballesteros (2012) temperature, Kim et al. (2002) Planckian locus */
function starColor(bv: number): V3 {
  const T = Math.min(25000, Math.max(1667, 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))))
  const x = T <= 4000
    ? -0.2661239e9 / T ** 3 - 0.2343589e6 / T ** 2 + 0.8776956e3 / T + 0.17991
    : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.24039
  const y = T <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : T <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483
  const X = x / y, Z = (1 - x - y) / y
  const r = Math.max(0, 3.2406 * X - 1.5372 - 0.4986 * Z)
  const g = Math.max(0, -0.9689 * X + 1.8758 + 0.0415 * Z)
  const b = Math.max(0, 0.0557 * X - 0.204 + 1.057 * Z)
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [r / Y, g / Y, b / Y]
}

interface Catalogue { vertices: Float32Array; mags: Float32Array }

async function loadCatalogue(): Promise<Catalogue> {
  const r = await fetch(`${DATA_URL}/stars.bin`)
  if (!r.ok) throw new Error(`stars.bin: HTTP ${r.status}`)
  const buf = await r.arrayBuffer()
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== 0x31525453) throw new Error('stars.bin: bad header') // 'STR1'
  const n = dv.getUint32(4, true)
  let o = 16
  const f32 = () => { const a = new Float32Array(buf.slice(o, o + 4 * n)); o += 4 * n; return a }
  const i16 = () => { const a = new Int16Array(buf.slice(o, o + 2 * n)); o += 2 * n; return a }
  const ra = f32(), de = f32(), v = i16(), bv = i16(), pmra = i16(), pmde = i16()
  const vertices = new Float32Array(n * 10), mags = new Float32Array(n)
  const D2R = Math.PI / 180, MAS = D2R / 3.6e6
  for (let i = 0; i < n; i++) {
    const a = ra[i] * D2R, d = de[i] * D2R, ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d)
    const pa = pmra[i] * MAS, pd = pmde[i] * MAS // pmRA already x cos(dec)
    const [cr, cg, cb] = starColor(bv[i] / 1000)
    mags[i] = v[i] / 100
    vertices.set([cd * ca, cd * sa, sd,
      -sa * pa - sd * ca * pd, ca * pa - sd * sa * pd, cd * pd,
      cr, cg, cb, mags[i]], i * 10)
  }
  return { vertices, mags }
}

export function createStars(viewer: Viewer): Stars {
  const scene = viewer.scene
  let cat: Catalogue | undefined
  let destroyed = false
  loadCatalogue().then((c) => { if (!destroyed) { cat = c; scene.requestRender() } })
    .catch((e: unknown) => console.warn('Stars unavailable:', e))

  const rot = Matrix3.clone(Matrix3.IDENTITY)
  const beta = new Cartesian3()
  let years = 0
  const sunM = new Cartesian3(1, 0, 0), earthM = new Cartesian3(0, 1, 0)
  let vision: StarVision | null = null
  let lastT = NaN
  // per-frame uniforms
  const uSun = new Cartesian4(), uEarth = new Cartesian4(), uUp = new Cartesian4()
  const tmp = new Cartesian3(), up = new Cartesian3()

  let command: InstanceType<typeof C.DrawCommand> | undefined
  const uniformMap = {
    u_rot: () => rot,
    u_years: () => years,
    u_beta: () => beta,
    u_sun: () => uSun,
    u_earth: () => uEarth,
    u_up: () => uUp,
    u_sky: () => SKY_L,
  }

  function build(context: Ctx, c: Catalogue) {
    const vertexBuffer = C.Buffer.createVertexBuffer({ context, typedArray: c.vertices, usage: C.BufferUsage.STATIC_DRAW })
    const attr = (index: number, size: number, offset: number) => ({
      index, vertexBuffer, componentsPerAttribute: size, componentDatatype: ComponentDatatype.FLOAT,
      offsetInBytes: offset * 4, strideInBytes: 40,
    })
    const attributeLocations = { a_dir: 0, a_pm: 1, a_col: 2 }
    command = new C.DrawCommand({
      primitiveType: PrimitiveType.POINTS,
      vertexArray: new C.VertexArray({ context, attributes: [attr(0, 3, 0), attr(1, 3, 3), attr(2, 4, 6)] }),
      shaderProgram: C.ShaderProgram.fromCache({ context, vertexShaderSource: VS, fragmentShaderSource: FS, attributeLocations }),
      renderState: C.RenderState.fromCache({ depthTest: { enabled: false }, depthMask: false, blending: BlendingState.ADDITIVE_BLEND }),
      uniformMap,
      pass: C.Pass.ENVIRONMENT,
      owner: sky,
      count: 0,
    })
  }

  /** stars brighter than m: the catalogue is sorted by magnitude */
  const countBrighter = (m: number) => {
    const a = cat!.mags
    let lo = 0, hi = a.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < m) lo = mid + 1; else hi = mid }
    return lo
  }

  const sky = {
    show: true,
    /** last frame, for the browser console (moon.viewer.scene.skyBox.stats) */
    stats: {} as Record<string, number>,
    update(frameState: FrameState) {
      if (!sky.show || !cat) return undefined
      if (!command) build(frameState.context, cat)
      // directions from the camera (the Sun and the Earth are far, but the view can be from orbit)
      const cam = frameState.camera.positionWC
      Cartesian3.normalize(cam, up)
      const toSun = Cartesian3.normalize(Cartesian3.subtract(sunM, cam, tmp), tmp)
      uSun.x = toSun.x; uSun.y = toSun.y; uSun.z = toSun.z
      const sinSun = Cartesian3.dot(toSun, up)
      const toEarth = Cartesian3.normalize(Cartesian3.subtract(earthM, cam, tmp), tmp)
      uEarth.x = toEarth.x; uEarth.y = toEarth.y; uEarth.z = toEarth.z
      const sinEarth = Cartesian3.dot(toEarth, up)
      uUp.x = up.x; uUp.y = up.y; uUp.z = up.z
      if (vision) {
        const sunDist = Cartesian3.magnitude(sunM) / AU_M
        const eSun = (E_SUN / (sunDist * sunDist)) * vision.sunVisible
        // the Earth's light only while its disc (radius ~0.95 deg) is above the horizon
        const above = Math.min(1, Math.max(0, (Math.asin(sinEarth) * 180 / Math.PI + 0.95) / 1.9))
        const eEarth = (E_SUN / (sunDist * sunDist)) * vision.earthshine * above
        uSun.w = eSun
        uEarth.w = eEarth
        uUp.w = (ALBEDO / Math.PI) * (eSun * Math.max(sinSun, 0) + eEarth * Math.max(sinEarth, 0))
      } else {
        uSun.w = uEarth.w = uUp.w = 0
      }
      // only the stars that could show anywhere this frame: the best limiting magnitude over ~400 gaze
      // directions (+0.3 mag for the gaps between them; without glare every star is drawn)
      let best = 99
      if (vision) {
        best = -99
        for (const [x, y, z] of PROBES) {
          best = Math.max(best, limitingMag(x * uSun.x + y * uSun.y + z * uSun.z, x * uEarth.x + y * uEarth.y + z * uEarth.z,
            x * up.x + y * up.y + z * up.z, uSun.w, uEarth.w, uUp.w))
        }
        best += 0.3
      }
      command!.count = countBrighter(best)
      sky.stats = { drawn: command!.count, bestLimit: best, sunLux: uSun.w, earthLux: uEarth.w, groundCdM2: uUp.w }
      return command!.count > 0 ? command : undefined
    },
    isDestroyed: () => destroyed,
    destroy() {
      destroyed = true
      command?.vertexArray?.destroy()
      command?.shaderProgram?.destroy()
      command = undefined
    },
  }

  const prev = (scene as unknown as { skyBox?: Destroyable & { isDestroyed?(): boolean } }).skyBox
  if (prev && prev.isDestroyed && !prev.isDestroyed()) prev.destroy()
  ;(scene as unknown as { skyBox: unknown }).skyBox = sky

  return {
    update(tMs, sunAt, earth, v) {
      vision = v
      const s = sunAt(tMs)
      sunM.x = s[0]; sunM.y = s[1]; sunM.z = s[2]
      earthM.x = earth[0]; earthM.y = earth[1]; earthM.z = earth[2]
      if (tMs !== lastT) {
        lastT = tMs
        const m = moonFixedToIcrf(tMs) // row-major, Moon-fixed -> ICRF; the stars need its transpose
        Matrix3.fromRowMajorArray([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]], rot)
        years = (tMs - EPOCH_MS) / YEAR_MS
        // aberration: the Moon's velocity relative to the Sun (ICRF), central difference over +-10 min
        const h = 600_000
        const icrf = (t: number) => {
          const r = moonFixedToIcrf(t), p = t === tMs ? s : sunAt(t)
          return [r[0] * p[0] + r[1] * p[1] + r[2] * p[2], r[3] * p[0] + r[4] * p[1] + r[5] * p[2], r[6] * p[0] + r[7] * p[1] + r[8] * p[2]]
        }
        const a = icrf(tMs + h), b = icrf(tMs - h)
        const k = -1 / ((2 * h) / 1000) / C_MS // observer velocity = -d(Sun position)/dt
        beta.x = (a[0] - b[0]) * k; beta.y = (a[1] - b[1]) * k; beta.z = (a[2] - b[2]) * k
      }
      scene.requestRender()
    },
    dispose() {
      if ((scene as unknown as { skyBox: unknown }).skyBox === sky) (scene as unknown as { skyBox: unknown }).skyBox = undefined
      sky.destroy()
    },
  }
}
