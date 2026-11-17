/**
 * The Earth and the Sun in the Moon-fixed scene, at their true positions, sizes and orientation, with
 * physically scaled brightness.
 *
 * Exposure: everything is displayed on one scale, set by the lunar ground: regolith (normal albedo
 * ~0.12) under the overhead Sun shows as 0.58 (sRGB) = 0.30 linear, i.e. display-linear = 2.5 x
 * reflectance x cos(incidence) (EXPOSURE_K). At night in the first-person view the camera exposure goes
 * up NIGHT_EXPOSURE times (earthshine), and so do the Earth and the Sun.
 *
 * Earth: an ellipsoid (WGS84 radii) at its SPICE position (lib/ephemeris.ts), rotated to its real
 * orientation: Earth-fixed -> Moon-fixed = (ICRF -> Moon ME) x (ICRF -> Earth fixed)^T from the IAU
 * rotation models (Earth: IAU pck00011; Moon: IAU 2009 with its 13 libration terms), checked against
 * SPICE pxform(IAU_EARTH, MOON_ME) within 0.003 deg over 2026-2031. Surface: NASA Blue Marble Next
 * Generation (cloud-free, from NASA GIBS; 2048 px, 4096 px once the first-person view opens) taken as
 * surface reflectance, ocean sun glint (Cox-Munk slopes, Fresnel), and procedural clouds (below), lit by
 * the Sun (Lambert) at EXPOSURE_K: thick clouds and ice saturate to white, land shows at ~0.5-0.7, the
 * ocean is dark blue - the Earth's mean albedo ~0.3 is ~2.5x the Moon's, as it looks from the Moon.
 * Rayleigh-scattering atmosphere shell on top (same exposure).
 *
 * Clouds: not data (that would mean downloading global imagery every few hours) but a statistical
 * climatology: domain-warped 3D simplex noise thresholded to the zonal mean cloud cover (ITCZ ~6 N,
 * clear subtropics, cloudy mid-latitude storm tracks), carried by zonal winds (trade easterlies ~7 m/s,
 * westerlies ~13 m/s) with the simulation clock, two noise generations cross-fading every 12 h so the
 * weather keeps changing without shearing apart. Cloud albedo 0.45-0.8 with optical thickness.
 *
 * Sun: a sphere always 1.5e6 km in front of the camera along the true Sun direction with its true
 * angular diameter (0.53 deg; it grows with zoom), at infinity (no parallax) yet depth-tested so the
 * Moon and the Earth hide it. Its luminance (~2e9 cd/m2) is ~4e5 times the sunlit regolith's, so on the
 * ground's exposure the whole disc is saturated white (limb darkening, 40 % at the limb, is still far
 * above white). Glare: the scatter of the camera optics, which on a real image is what makes the Sun
 * look big - a screen-space post-process, fixed in screen pixels like a lens's veiling glare (zooming
 * enlarges the disc, not the glare), with the Spencer et al. (1995) glare point-spread shape at 0.1 %
 * of the human eye's (a clean camera lens), scaled by the fraction of the disc actually visible (the
 * terrain, the Moon or the Earth in front of it dim it as they cover it).
 */
import {
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Color,
  CullFace,
  ConstantProperty,
  EllipsoidGeometry,
  GeometryInstance,
  Material,
  MaterialAppearance,
  Matrix4,
  NearFarScalar,
  PostProcessStage,
  Primitive,
  SceneTransforms,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  LabelStyle,
  Matrix3,
  Quaternion,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium'
import * as Cesium from 'cesium'

/** Cesium's renderer Sampler (exported at runtime, missing from the type definitions) */
const Sampler = (Cesium as unknown as { Sampler: new (o: { minificationFilter: TextureMinificationFilter; magnificationFilter: TextureMagnificationFilter }) => object }).Sampler

const D2R = Math.PI / 180
const EARTH_A = 6378137, EARTH_B = 6356752.314
const SUN_RADIUS_KM = 695700
/** distance of the Sun sphere from the camera (beyond the Earth from any allowed camera position) */
const SUN_DRAW_M = 1.5e9
/** display-linear value per unit reflectance at normal incidence (regolith 0.12 -> 0.30 linear = 0.58 sRGB) */
const EXPOSURE_K = 2.5
/** NASA GIBS WMS: Blue Marble Next Generation, cloud-free, equirectangular (CORS-enabled) */
const blueMarble = (w: number) => `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=BlueMarble_NextGeneration&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${w}&HEIGHT=${w / 2}&FORMAT=image/jpeg`
/** cloud generations cross-fade over this period (s) */
const CLOUD_PERIOD_S = 43200

type V3 = [number, number, number]

// ---- rotation models (matrices act on column vectors; body = M * ICRF) ----
function rz(a: number): number[] { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1] }
function rx(a: number): number[] { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c] }
function mul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]
  return o
}
/** ICRF -> body-fixed for pole (alpha0, delta0) and prime meridian W (deg) */
function bodyFrame(a0: number, d0: number, w: number) { return mul(rz(w * D2R), mul(rx((90 - d0) * D2R), rz((90 + a0) * D2R))) }

function moonFrame(d: number) {
  const T = d / 36525
  const E = [0, 125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.064993 * d, 276.617 + 0.3287146 * d, 34.226 + 1.7484877 * d,
    15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d, 25.053 + 12.9590088 * d].map((v) => v * D2R)
  const s = (i: number) => Math.sin(E[i]), c = (i: number) => Math.cos(E[i])
  const a0 = 269.9949 + 0.0031 * T - 3.8787 * s(1) - 0.1204 * s(2) + 0.07 * s(3) - 0.0172 * s(4) + 0.0072 * s(6) - 0.0052 * s(10) + 0.0043 * s(13)
  const d0 = 66.5392 + 0.013 * T + 1.5419 * c(1) + 0.0239 * c(2) - 0.0278 * c(3) + 0.0068 * c(4) - 0.0029 * c(6) + 0.0009 * c(7) + 0.0008 * c(10) - 0.0009 * c(13)
  const w = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.561 * s(1) + 0.1208 * s(2) - 0.0642 * s(3) + 0.0158 * s(4) + 0.0252 * s(5)
    - 0.0066 * s(6) - 0.0047 * s(7) - 0.0046 * s(8) + 0.0028 * s(9) + 0.0052 * s(10) + 0.004 * s(11) + 0.0019 * s(12) - 0.0044 * s(13)
  return bodyFrame(a0, d0, w)
}

function earthFrame(d: number) {
  const T = d / 36525
  return bodyFrame(-0.641 * T, 90 - 0.557 * T, 190.147 + 360.9856235 * d)
}

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0) - 69_184 // TT - UTC ~ 69.184 s

/** Earth's orientation in the Moon-fixed frame at time tMs (UTC): columns = Earth-fixed axes in Moon ME. */
export function earthOrientation(tMs: number): Quaternion {
  const d = (tMs - J2000_MS) / 86400_000
  const M = moonFrame(d), Et = earthFrame(d)
  // Earth fixed -> Moon ME = M * Et^T
  const EtT = [Et[0], Et[3], Et[6], Et[1], Et[4], Et[7], Et[2], Et[5], Et[8]]
  const R = mul(M, EtT)
  // Matrix3 constructor takes row-major arguments
  return Quaternion.fromRotationMatrix(new Matrix3(R[0], R[1], R[2], R[3], R[4], R[5], R[6], R[7], R[8]))
}

// ---- textures ----
/** Natural Earth II level 1 (TMS: 4 x 2 tiles of 256 px, y = 0 is the southern row) as one 1024 x 512 image. */
async function earthTexture(baseUrl: string): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas')
  c.width = 1024; c.height = 512
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#1b3a6b'
  ctx.fillRect(0, 0, 1024, 512)
  const jobs: Promise<void>[] = []
  for (let x = 0; x < 4; x++) for (let y = 0; y < 2; y++) {
    jobs.push(new Promise((resolve) => {
      const img = new Image()
      // longitude -180 at the left, like the Blue Marble image (EARTH_FS maps longitude / latitude directly)
      img.onload = () => { ctx.drawImage(img, x * 256, (1 - y) * 256, 256, 256); resolve() }
      img.onerror = () => resolve()
      img.src = `${baseUrl}/Assets/Textures/NaturalEarthII/1/${x}/${y}.jpg`
    }))
  }
  await Promise.all(jobs)
  return c
}


/**
 * Earth fragment shader: ray-traced. Each pixel takes the nearest point of the WGS84 ellipsoid along its
 * view ray (in Earth-fixed coordinates), so its colour never depends on which of the mesh's triangles
 * was rasterised: 360,000 km away, Cesium's depth buffer could not tell the sphere's near and far
 * hemispheres apart, and the far side showed through (mirrored continents, the wrong phase). The mesh
 * is only the screen footprint. Hands the Earth-fixed geometry to the material in czm_materialInput
 * fields (see EARTH_MATERIAL).
 */
const EARTH_FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
void main() {
  vec3 o = (czm_inverseModelView * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 d = normalize((czm_inverseModelView * vec4(normalize(v_positionEC), 0.0)).xyz);
  vec3 inv = vec3(${(1 / EARTH_A).toExponential(9)}, ${(1 / EARTH_A).toExponential(9)}, ${(1 / EARTH_B).toExponential(9)});
  vec3 os = o * inv, ds = d * inv;
  float a = dot(ds, ds), b = dot(os, ds), c = dot(os, os) - 1.0;
  float disc = b * b - a * c;
  if (disc < 0.0) discard;
  vec3 p = o + d * ((-b - sqrt(disc)) / a);
  czm_materialInput mi;
  mi.normalEC = normalize(p * inv * inv);
  mi.positionToEyeEC = -d;
  mi.str = normalize((czm_inverseModelView * vec4(czm_lightDirectionEC, 0.0)).xyz);
  mi.tangentToEyeMatrix = mat3(normalize(p), vec3(0.0), vec3(0.0));
  mi.st = vec2(atan(p.y, p.x) / czm_twoPi + 0.5, asin(clamp(mi.normalEC.z, -1.0, 1.0)) / czm_pi + 0.5);
  czm_material material = czm_getMaterial(mi);
  out_FragColor = vec4(material.diffuse, 1.0);
}
`

/** 3D simplex noise: Ashima Arts / Stefan Gustavson (MIT licence) */
const SIMPLEX = `
vec3 cMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 cMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 cPermute(vec4 x) { return cMod289(((x * 34.0) + 1.0) * x); }
vec4 cTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float cSnoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = cMod289(i);
  vec4 p = cPermute(cPermute(cPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = cTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`

/**
 * Earth surface + clouds + glint + haze, in display units (see the header). All vectors Earth-fixed,
 * from EARTH_FS: mi.normalEC = surface normal, mi.positionToEyeEC = towards the eye, mi.str = towards
 * the Sun, mi.tangentToEyeMatrix[0] = unit position, mi.st = (longitude, latitude) image coordinates.
 * Fabric uniforms: image (Blue Marble, longitude -180 at the left), exposure, cloudPhase (0..1 within
 * the 12 h cross-fade), cloudCycle.
 */
const EARTH_MATERIAL = SIMPLEX + `
// octaves fade out below ~2 pixels (fp = noise-space distance per pixel), so the small Earth does not shimmer
float cFbm(vec3 p, float fp) {
  float s = 0.0, a = 0.5, wl = 1.0;
  for (int i = 0; i < 8; i++) {
    s += a * cSnoise(p) * (1.0 - smoothstep(0.25, 0.5, fp / wl));
    p = p * 2.07 + vec3(3.1, 1.7, 5.3);
    a *= 0.52; wl /= 2.07;
  }
  return s;
}
// one cloud generation, carried dt seconds by the zonal winds (east positive)
float cField(vec3 q, float dt, float seed, float fp) {
  float lat = asin(clamp(q.z, -1.0, 1.0)), al = abs(lat) * 57.29578;
  float u = -7.0 * (1.0 - smoothstep(18.0, 30.0, al)) + 13.0 * smoothstep(28.0, 40.0, al) * (1.0 - smoothstep(58.0, 70.0, al)) - 3.0 * smoothstep(65.0, 75.0, al);
  float ang = -u * dt / (6.371e6 * max(cos(lat), 0.1));
  float c = cos(ang), s = sin(ang);
  vec3 p = vec3(c * q.x - s * q.y, s * q.x + c * q.y, q.z) * 3.0 + seed * vec3(1.7, 9.2, 4.1);
  // two levels of domain warping: large swirls (cyclones, fronts) and smaller eddies
  vec3 w1 = vec3(cSnoise(p * 0.9 + 11.0), cSnoise(p * 0.9 + 23.0), cSnoise(p * 0.9 + 37.0));
  vec3 w2 = vec3(cSnoise(p * 3.1 + 5.0), cSnoise(p * 3.1 + 17.0), cSnoise(p * 3.1 + 29.0));
  return cFbm(p * 1.4 + 0.9 * w1 + 0.12 * w2, fp * 4.2);
}
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  vec3 n = mi.normalEC, v = mi.positionToEyeEC, l = mi.str, q = mi.tangentToEyeMatrix[0];
  float fp = max(length(fwidth(q)), 1e-6);
  // surface reflectance; texture derivatives without the jump at longitude +-180
  vec2 st = mi.st, st2 = vec2(fract(st.x + 0.5), st.y);
  vec2 gx = dFdx(st), gy = dFdy(st), gx2 = dFdx(st2), gy2 = dFdy(st2);
  if (abs(gx2.x) + abs(gy2.x) < abs(gx.x) + abs(gy.x)) { gx = gx2; gy = gy2; }
  vec3 tex = textureGrad(image, st, gx, gy).rgb;
  vec3 surf = pow(tex, vec3(2.2));
  float ocean = smoothstep(1.2, 2.0, tex.b / max(tex.r, 0.01)) * (1.0 - smoothstep(0.12, 0.25, tex.g));
  surf += vec3(0.010, 0.016, 0.028) * ocean;     // open ocean ~0.02-0.03 plus diffuse sky light
  // clouds: two generations cross-fading (variance kept), thresholded to the zonal cloud cover; thin
  // edges darker (optically thin), thick cores up to 0.8
  float latD = asin(clamp(q.z, -1.0, 1.0)) * 57.29578;
  float cover = clamp(0.52 + 0.28 * exp(-pow((latD - 6.0) / 7.0, 2.0)) - 0.27 * exp(-pow((abs(latD) - 24.0) / 9.0, 2.0)) + 0.25 * smoothstep(35.0, 55.0, abs(latD)), 0.05, 0.95);
  float pa = cloudPhase, pb = fract(cloudPhase + 0.5);
  float wa = 1.0 - abs(2.0 * pa - 1.0), wb = 1.0 - wa;
  float cn = 0.0;
  if (wa > 0.01) cn += wa * cField(q, (pa - 0.5) * ${CLOUD_PERIOD_S.toFixed(1)}, cloudCycle, fp);
  if (wb > 0.01) cn += wb * cField(q, (pb - 0.5) * ${CLOUD_PERIOD_S.toFixed(1)}, cloudCycle + floor(cloudPhase + 0.5) + 157.0, fp);
  cn /= sqrt(wa * wa + wb * wb);
  float thr = (0.5 - cover) * 0.6;
  float dens = smoothstep(thr - 0.04, thr + 0.24, cn);
  float cloudAlb = 0.3 + 0.5 * smoothstep(thr, thr + 0.45, cn);
  vec3 alb = mix(surf, vec3(cloudAlb), dens);
  // sunlight in (Lambert, reddened through the air near the terminator) + glint off the open ocean
  // (Cox-Munk slope variance 0.03, Schlick Fresnel)
  vec3 TAU0 = vec3(0.050, 0.099, 0.224);
  float mu0 = max(dot(n, l), 0.0), mu = max(dot(n, v), 0.02);
  vec3 sunIn = exp(-TAU0 * min(1.0 / max(mu0, 1e-3), 35.4));
  vec3 h = normalize(l + v);
  float ch = max(dot(n, h), 0.05), ch2 = ch * ch;
  float slopes = exp(-(1.0 - ch2) / (ch2 * 0.03)) / (3.14159 * 0.03 * ch2 * ch2);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  float glint = 3.14159 * fres * slopes / (4.0 * mu) * step(0.0, dot(n, l)) * ocean * (1.0 - dens);
  // haze over the disc (single Rayleigh scattering, as the limb shell ATMOSPHERE_FS): the slant path
  // to this point dims the surface and adds blue sky light where that air is sunlit
  vec3 T = exp(-TAU0 * min(1.0 / mu, 35.4));
  float cosTh = dot(l, v);
  float litAir = smoothstep(-0.18, 0.05, dot(n, l));
  vec3 path = 0.75 * (1.0 + cosTh * cosTh) / (4.0 * 3.14159) * (1.0 - T) * litAir;
  vec3 lin = ${EXPOSURE_K.toFixed(2)} * exposure * ((alb * mu0 + glint * vec3(1.0, 0.97, 0.92)) * sunIn * T + 3.14159 * path);
  m.diffuse = pow(min(lin, vec3(1.0)), vec3(1.0 / 2.2));
  m.alpha = 1.0;
  return m;
}
`

/**
 * Earth's atmosphere around the limb: single Rayleigh scattering in a shell above the surface (over
 * the disc itself, the Earth shader adds the same haze). Physics (per RGB channel, ~650 / 550 / 450 nm):
 *  - sea-level Rayleigh optical depth tau0 = 0.0088 lambda^-4.05 (lambda in um): 0.050, 0.099, 0.224
 *  - density scale height H = 8 km; slant optical depth along the view ray from its impact parameter b:
 *    rays that miss the surface (tangent height h = b - R): tau0 sqrt(2 pi R / H) exp(-h / H) (Chapman,
 *    full grazing path); rays that hit it: tau0 / cos z, capped at half the grazing path
 *  - scattered radiance L = F_sun * P(theta) / (4 pi) * (1 - exp(-tau)), Rayleigh phase
 *    P = 3/4 (1 + cos^2 theta), only where that air is sunlit (with the twilight band beyond the
 *    terminator, sunlight skimming above the surface)
 *  - displayed on the same scale as the surface (radiance F A cos(i) / pi shown as EXPOSURE_K A cos(i)),
 *    i.e. EXPOSURE_K pi L / F, times the camera exposure, then sRGB-encoded
 * So the sunlit limb is about as bright as the clouds/land below it and blue-white, and the haze over
 * the disc adds a few % (why the Earth looks blue from space); nothing on the night side.
 */
const ATMOSPHERE_TOP_M = 100e3
const ATMOSPHERE_FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
const float R = 6371000.0;
const float H = 8000.0;
const vec3 TAU0 = vec3(0.050, 0.099, 0.224);
void main() {
  czm_materialInput mi;
  mi.normalEC = vec3(0.0, 0.0, 1.0);
  mi.positionToEyeEC = -v_positionEC;
  mi.st = v_st;
  float exposure = czm_getMaterial(mi).specular;
  vec3 center = (czm_modelView * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 v = normalize(v_positionEC);                 // eye -> fragment (eye at the EC origin)
  float t = dot(center, v);
  float b = length(center - v * t);                 // impact parameter of the view ray
  float grazing = sqrt(2.0 * czm_pi * R / H);
  // from the Moon the 8 km scale height is far below a pixel: spread the falloff over the pixel's
  // footprint (w), keeping its integral (H / w), so the limb is a smooth glow instead of a jagged line
  float w = max(H, fwidth(b));
  // rays that hit the planet: its haze is drawn by the Earth shader itself (EARTH_MATERIAL); this shell
  // only adds the glow around the limb. Everything from the ray alone (impact parameter, tangent
  // point), not from the rasterised face, for the same reason as EARTH_FS
  if (b <= R) discard;
  float factor = grazing * exp(-(b - R) / w) * (H / w);
  vec3 tau = TAU0 * factor;
  // sunlit air: around the ray's tangent point, with the twilight band beyond the terminator
  vec3 up = normalize(v * t - center);
  float lit = smoothstep(-0.18, 0.05, dot(up, czm_lightDirectionEC));
  float cosTheta = dot(czm_lightDirectionEC, v);
  float phase = 0.75 * (1.0 + cosTheta * cosTheta);
  vec3 L = phase / (4.0 * czm_pi) * (1.0 - exp(-tau)) * lit;   // in units of F_sun
  vec3 col = pow(min(L * ${EXPOSURE_K.toFixed(2)} * czm_pi * exposure, vec3(1.0)), vec3(1.0 / 2.2));
  // composited "over" the planet: opacity = the air's extinction of what lies behind (mean over RGB),
  // colour = scattered light / opacity, so the result is col + background x transmittance
  float alpha = max(1.0 - exp(-(tau.r + tau.g + tau.b) / 3.0), max(col.r, max(col.g, col.b)));
  if (alpha < 1e-4) discard;
  out_FragColor = vec4(col / alpha, alpha);
}
`

/** Sun disc: ~4e5 times the exposure of the sunlit ground, so saturated white edge to edge (see the header) */
const SUN_DISC_FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
void main() {
  out_FragColor = vec4(1.0);
}
`
/**
 * Glare post-process. Visible fraction of the disc: 16 samples spread over it, counted where the
 * rendered pixel is the (pure white) disc. Glare at angle theta (deg, from the disc edge, on a reference
 * 60 deg vertical field so it keeps its size on screen at any zoom): display-linear =
 * EXPOSURE_K pi / 0.12 x 0.001 x P(theta) x visible fraction, P = the Spencer et al. (1995) wide-angle
 * point-spread terms (per sr, halved for its normalisation): saturated to ~0.6 deg from the disc edge,
 * half-bright at ~1.2 deg, a faint haze to ~15 deg.
 */
const SUN_GLARE_FS = `
uniform sampler2D colorTexture;
uniform vec2 sunUv;
uniform float sunRadiusPx;
uniform float gain;
in vec2 v_textureCoordinates;
void main() {
  vec4 col = texture(colorTexture, v_textureCoordinates);
  if (gain <= 0.0) { out_FragColor = col; return; }
  vec2 res = czm_viewport.zw;
  float vis = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996, r = sqrt((float(i) + 0.5) / 16.0) * sunRadiusPx * 0.85;
    vec2 uv = sunUv + vec2(cos(a), sin(a)) * r / res;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    vec3 c = texture(colorTexture, uv).rgb;
    vis += step(2.97, c.r + c.g + c.b);
  }
  vis /= 16.0;
  if (vis <= 0.0) { out_FragColor = col; return; }
  float dPx = max(length((v_textureCoordinates - sunUv) * res) - sunRadiusPx, 0.0);
  float th = dPx * 60.0 / res.y + 0.02;
  float psf = 0.5 * (72.37 / (th * th) + 20.91 / (th * th * th));
  float glare = ${((EXPOSURE_K * Math.PI) / 0.12).toFixed(3)} * 0.001 * psf * vis * gain;
  vec3 lin = pow(col.rgb, vec3(2.2)) + glare * vec3(1.0, 0.97, 0.92);
  out_FragColor = vec4(pow(min(lin, vec3(1.0)), vec3(1.0 / 2.2)), col.a);
}
`

export interface Celestial {
  /** update for time tMs (UTC) with Moon-fixed Sun / Earth positions in metres */
  update(tMs: number, sunM: V3, earthM: V3): void
  /** show / hide the labels (e.g. hidden in the first-person view, where the bodies speak for themselves) */
  setLabels(show: boolean): void
  /** camera exposure relative to daylight (NIGHT_EXPOSURE in the first-person view at night) */
  setExposure(x: number): void
  /** load the 4096 px Earth (first-person view: zoomed in, the Earth can fill the screen) */
  loadDetail(): void
  dispose(): void
}

export function createCelestial(viewer: Viewer, cesiumBaseUrl: string): Celestial {
  const scene = viewer.scene
  const earthPos = new Cartesian3()
  /**
   * Label anchor on a body's top limb as seen from the camera (centre + the camera's up direction,
   * made perpendicular to the line of sight, x radius): the label sits just above the disc at any
   * distance, and is still hidden by the Moon / terrain in front of it like the body itself.
   */
  const aboveLimb = (center: () => Cartesian3, radius: number) => {
    const out = new Cartesian3(), los = new Cartesian3(), up = new Cartesian3()
    return new CallbackPositionProperty(() => {
      const c = center()
      Cartesian3.normalize(Cartesian3.subtract(c, scene.camera.positionWC, los), los)
      Cartesian3.subtract(scene.camera.upWC, Cartesian3.multiplyByScalar(los, Cartesian3.dot(scene.camera.upWC, los), up), up)
      Cartesian3.normalize(up, up)
      return Cartesian3.add(c, Cartesian3.multiplyByScalar(up, radius * 1.01, out), out)
    }, false)
  }
  const sunDir = new Cartesian3(1, 0, 0)
  let sunAngR = 0.2666 * D2R

  // Earth: a textured sphere primitive whose model matrix (position + rotation) is updated in place;
  // a blue placeholder texture until the Earth image has loaded
  const placeholder = document.createElement('canvas')
  placeholder.width = placeholder.height = 2
  const pctx = placeholder.getContext('2d')!
  pctx.fillStyle = '#3d6aa8'
  pctx.fillRect(0, 0, 2, 2)
  const material = new Material({
    fabric: { type: 'EarthSurface', uniforms: { image: placeholder.toDataURL(), exposure: 1.0, cloudPhase: 0.0, cloudCycle: 0.0 }, source: EARTH_MATERIAL },
  })
  // mipmaps for the Earth image (Cesium's materials make none, and a 4096 px map on a small disc
  // sparkles): once each new texture is up, generate them and switch to trilinear filtering
  type Tex = { width: number; generateMipmap(): void; sampler: object }
  const mipmapped = new WeakSet<Tex>()
  const offMipmaps = scene.postRender.addEventListener(() => {
    const textures = (material as unknown as { _textures?: Record<string, Tex | undefined> })._textures ?? {}
    for (const tex of Object.values(textures)) {
      if (!tex || tex.width < 64 || mipmapped.has(tex)) continue
      mipmapped.add(tex)
      try {
        tex.generateMipmap()
        tex.sampler = new Sampler({ minificationFilter: TextureMinificationFilter.LINEAR_MIPMAP_LINEAR, magnificationFilter: TextureMagnificationFilter.LINEAR })
        scene.requestRender()
      } catch { /* keep the plain texture */ }
    }
  })
  const earthPrim = scene.primitives.add(new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new EllipsoidGeometry({
        radii: new Cartesian3(EARTH_A, EARTH_A, EARTH_B),
        vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        slicePartitions: 128, // a round limb even when the Earth fills the screen
        stackPartitions: 64,
      }),
    }),
    appearance: new MaterialAppearance({
      material, materialSupport: MaterialAppearance.MaterialSupport.TEXTURED, translucent: false, closed: true, faceForward: false,
      fragmentShaderSource: EARTH_FS,
    }),
    asynchronous: false,
  })) as Primitive
  const atmMaterial = new Material({
    // Cesium renames material uniforms inside the material source only: hand the exposure out as .specular
    fabric: { type: 'EarthAtmosphere', uniforms: { exposure: 1.0 }, source: 'czm_material czm_getMaterial(czm_materialInput mi) { czm_material m = czm_getDefaultMaterial(mi); m.specular = exposure; return m; }' },
  })
  // atmosphere shell: front faces only, additive, no depth writes (drawn over the planet and its limb)
  const atmPrim = scene.primitives.add(new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new EllipsoidGeometry({
        radii: new Cartesian3(EARTH_A + ATMOSPHERE_TOP_M, EARTH_A + ATMOSPHERE_TOP_M, EARTH_B + ATMOSPHERE_TOP_M),
        vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        slicePartitions: 64,
        stackPartitions: 32,
      }),
    }),
    appearance: new MaterialAppearance({
      material: atmMaterial, materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
      translucent: true, closed: false, faceForward: false, fragmentShaderSource: ATMOSPHERE_FS,
      renderState: { depthTest: { enabled: true }, depthMask: false, cull: { enabled: true, face: CullFace.BACK } },
    }),
    asynchronous: false,
  })) as Primitive
  const earthLabel: Entity = viewer.entities.add({
    name: 'Earth',
    position: aboveLimb(() => earthPos, EARTH_A),
    label: {
      text: 'Earth', font: '13px system-ui', fillColor: Color.fromCssColorString('#cfe3ff'),
      style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -4), // anchored on the top limb: just above the disc, not over it
    },
  })
  let disposed = false
  // Natural Earth II (shipped with Cesium, instant) until the Blue Marble image arrives
  let detail = 0
  const loadEarth = (w: number) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (disposed || w < detail) return
      detail = w
      material.uniforms.image = img
      scene.requestRender()
    }
    img.src = blueMarble(w)
  }
  void earthTexture(cesiumBaseUrl).then((canvas) => {
    if (disposed || detail) return
    material.uniforms.image = canvas.toDataURL('image/jpeg', 0.9)
    scene.requestRender()
  })
  loadEarth(2048)
  let detailRequested = false
  const rot = new Matrix3()

  // Sun: a camera-relative unit sphere (scaled by the model matrix) 1.5e6 km out along the true Sun
  // direction, so it stays "at infinity" (no parallax) but is real geometry: the Moon and the Earth hide
  // exactly the part of the disc behind them
  const sunDisc = scene.primitives.add(new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new EllipsoidGeometry({ radii: new Cartesian3(1, 1, 1), vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat, slicePartitions: 48, stackPartitions: 24 }),
    }),
    // opaque (MaterialAppearance defaults to translucent, and translucent commands were composited over the terrain)
    appearance: new MaterialAppearance({ material: Material.fromType('Color'), materialSupport: MaterialAppearance.MaterialSupport.TEXTURED, translucent: false, closed: true, fragmentShaderSource: SUN_DISC_FS }),
    asynchronous: false,
  })) as Primitive
  const sunPos = new Cartesian3()
  const glareState = { uv: new Cartesian2(-10, -10), radiusPx: 1, gain: 0 }
  const glare = scene.postProcessStages.add(new PostProcessStage({
    name: 'sunGlare',
    fragmentShader: SUN_GLARE_FS,
    uniforms: { sunUv: () => glareState.uv, sunRadiusPx: () => glareState.radiusPx, gain: () => glareState.gain },
  }))
  const win = new Cartesian2()
  let exposure = 1
  const placeSun = () => {
    Cartesian3.add(scene.camera.positionWC, Cartesian3.multiplyByScalar(sunDir, SUN_DRAW_M, sunPos), sunPos)
    const r = SUN_DRAW_M * Math.tan(sunAngR)
    sunDisc.modelMatrix = Matrix4.setTranslation(Matrix4.fromUniformScale(r, sunDisc.modelMatrix), sunPos, sunDisc.modelMatrix)
    // glare: the disc's drawing-buffer position and radius (pixels); off while the Sun is behind the camera
    glareState.gain = 0
    const fovy = (scene.camera.frustum as { fovy?: number }).fovy
    if (fovy && Cartesian3.dot(scene.camera.directionWC, sunDir) > 0 && SceneTransforms.worldToDrawingBufferCoordinates(scene, sunPos, win)) {
      const h = scene.drawingBufferHeight, w = scene.drawingBufferWidth
      glareState.uv.x = win.x / w
      glareState.uv.y = 1 - win.y / h
      glareState.radiusPx = Math.max(1, (Math.tan(sunAngR) / Math.tan(fovy / 2)) * (h / 2))
      glareState.gain = exposure
    }
  }
  const offPreRender = scene.preRender.addEventListener(placeSun)
  const sun: Entity = viewer.entities.add({
    name: 'Sun',
    position: new CallbackPositionProperty(() => sunPos, false),
    label: {
      text: 'Sun', font: '13px system-ui', fillColor: Color.fromCssColorString('#fff3c4'),
      style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -14),
    },
  })
  // "Moon" tag just above the Moon's disc, fading in as the landmark tags fade out (App.tsx LANDMARK_FADE)
  const moonLabel: Entity = viewer.entities.add({
    name: 'Moon',
    position: aboveLimb(() => Cartesian3.ZERO, 1737400),
    label: {
      text: 'Moon', font: '13px system-ui', fillColor: Color.fromCssColorString('#e6e6e6'),
      style: LabelStyle.FILL_AND_OUTLINE, outlineWidth: 3, verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -4),
      translucencyByDistance: new NearFarScalar(3.2e7, 0, 5.0e7, 1),
    },
  })
  // edges (the Earth's limb, the lunar horizon) without stair steps
  if (scene.msaaSupported) scene.msaaSamples = 4

  // far enough for the Sun spheres behind the Earth (Cesium default far plane: 5e8 m)
  ;(scene.camera.frustum as { far?: number }).far = 3e9

  return {
    update(tMs, sunM, earthM) {
      Cartesian3.fromArray(earthM, 0, earthPos)
      earthPrim.modelMatrix = Matrix4.fromRotationTranslation(Matrix3.fromQuaternion(earthOrientation(tMs), rot), earthPos, earthPrim.modelMatrix)
      atmPrim.modelMatrix = Matrix4.clone(earthPrim.modelMatrix, atmPrim.modelMatrix)
      const d = Math.hypot(sunM[0], sunM[1], sunM[2])
      Cartesian3.normalize(Cartesian3.fromArray(sunM, 0, sunDir), sunDir)
      sunAngR = Math.asin((SUN_RADIUS_KM * 1000) / d)
      const cyc = tMs / 1000 / CLOUD_PERIOD_S
      material.uniforms.cloudPhase = cyc - Math.floor(cyc)
      material.uniforms.cloudCycle = Math.floor(cyc) % 512
      scene.requestRender()
    },
    setExposure(x) {
      if (x === exposure) return
      exposure = x
      material.uniforms.exposure = x
      atmMaterial.uniforms.exposure = x
      scene.requestRender()
    },
    loadDetail() {
      if (detailRequested) return
      detailRequested = true
      loadEarth(4096)
    },
    setLabels(show) {
      if (earthLabel.label) earthLabel.label.show = new ConstantProperty(show)
      if (sun.label) sun.label.show = new ConstantProperty(show)
      scene.requestRender()
    },
    dispose() {
      viewer.entities.remove(earthLabel)
      scene.primitives.remove(earthPrim)
      scene.primitives.remove(atmPrim)
      viewer.entities.remove(sun)
      viewer.entities.remove(moonLabel)
      scene.primitives.remove(sunDisc)
      scene.postProcessStages.remove(glare)
      offMipmaps()
      offPreRender()
      disposed = true
    },
  }
}
