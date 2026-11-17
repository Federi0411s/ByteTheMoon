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
 * angular diameter (0.53 deg; it grows with zoom), at infinity (no parallax); the Earth in front of it
 * is ray-traced (SUN_DISC_FS), terrain hides it by depth. Photosphere: limb darkening per colour (redder
 * towards the edge, u = 0.47 / 0.58 / 0.70) and faint granulation. Its luminance (~2e9 cd/m2) is ~4e5
 * times the sunlit regolith's, so on the ground's exposure the disc is saturated white.
 *
 * Camera metering: as the Sun's visible disc fills more of the frame (zooming in on it), the exposure
 * drops like a real camera's metering, down to the level where the disc centre is properly exposed:
 * fully zoomed in you see the limb darkening and the granulation while the terrain goes black, as in
 * real photographs of the Sun. Applied to everything (ground light, Earth, glare) on top of the scene
 * exposure from App (setExposure).
 *
 * Glare: the scatter of the camera optics, which on a real image is what makes the Sun look big. It is
 * the visible part of the disc convolved with the glare point-spread function, done the way bloom is:
 * a mask of the visible disc pixels, a pyramid of 9 downsampled copies (each ~2x blurrier), recombined
 * with weights that make the sum of their blurs follow the Spencer et al. (1995) glare profile (at
 * 0.1 % of the human eye's, a clean camera lens), fixed in screen pixels like a lens's veiling glare.
 * Continuous by construction: a crescent (the Earth in an eclipse, a ridge at sunrise) glows like a
 * crescent, with no individual point sources, and it costs a few small passes.
 */
import {
  CallbackPositionProperty,
  Cartesian2,
  Cartesian3,
  Cartesian4,
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
  PostProcessStageComposite,
  PostProcessStageSampleMode,
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
import { createEarthDetail } from './earthDetail'

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
  // closest approach first (b * b - a * c, two numbers ~3000 for a ~1 difference, lost the precision
  // at the limb: jittery hit points / normals, a dotted edge); ATMOSPHERE_FS uses the same expressions
  float a = dot(ds, ds);
  vec3 pc = os - ds * (dot(os, ds) / a);              // closest point of the ray, ellipsoid-scaled
  float q2 = dot(pc, pc);                             // < 1: the ray hits the Earth
  if (q2 > 1.0) discard;
  vec3 p = (pc - ds * sqrt((1.0 - q2) / a)) / inv;    // the near hit (metres, Earth-fixed)
  czm_materialInput mi;
  mi.normalEC = normalize(p * inv * inv);
  mi.positionToEyeEC = -d;
  mi.str = vec3(0.0); // (the material uses the true Sun direction, sunDirE: at night the scene light is the earthshine)
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
 * from EARTH_FS: mi.normalEC = surface normal, mi.positionToEyeEC = towards the eye; towards the Sun:
 * the sunDirE uniform (the true Sun, not the scene light, which at lunar night is the earthshine); mi.tangentToEyeMatrix[0] = unit position, mi.st = (longitude, latitude) image coordinates.
 * Fabric uniforms: image (Blue Marble, longitude -180 at the left), exposure, cloudPhase (0..1 within
 * the 12 h cross-fade), cloudCycle.
 */
const EARTH_MATERIAL = SIMPLEX + `
// octaves fade out below ~2 pixels (fp = noise-space distance per pixel), so the small Earth does not shimmer;
// the loop stops at the first invisible one (a small Earth costs only its few large octaves; the 8th
// is at pixel scale for the Earth zoomed in to the 0.5 deg view).
// The large octaves (systems, fronts: > ~400 km) follow the fully warped coordinates p; the small ones
// the lightly warped pu, as billows (|noise|: puffy cells with sharp creases, convective texture) - fine
// octaves on the strongly warped p were stretched along the swirls into hair-like streaks, which looked
// like brush strokes once the Earth was zoomed in.
float cFbm(vec3 p, vec3 pu, float fp) {
  float s = 0.0, a = 0.5, wl = 1.0;
  for (int i = 0; i < 8; i++) {
    if (fp / wl > 0.5) break;
    float n = i < 3 ? cSnoise(p) : 2.0 * abs(cSnoise(pu)) - 0.75;
    s += a * n * (1.0 - smoothstep(0.25, 0.5, fp / wl));
    p = p * 2.07 + vec3(3.1, 1.7, 5.3);
    pu = pu * 2.07 + vec3(3.1, 1.7, 5.3);
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
  return cFbm(p * 1.4 + 0.9 * w1 + 0.12 * w2, p * 1.4 + 0.25 * w1, fp * 4.2);
}
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  vec3 n = mi.normalEC, v = mi.positionToEyeEC, l = normalize(sunDirE), q = mi.tangentToEyeMatrix[0];
  float fp = max(length(fwidth(q)), 1e-6);
  // surface reflectance; texture derivatives without the jump at longitude +-180
  vec2 st = mi.st, st2 = vec2(fract(st.x + 0.5), st.y);
  vec2 gx = dFdx(st), gy = dFdy(st), gx2 = dFdx(st2), gy2 = dFdy(st2);
  if (abs(gx2.x) + abs(gy2.x) < abs(gx.x) + abs(gy.x)) { gx = gx2; gy = gy2; }
  vec3 tex = textureGrad(image, st, gx, gy).rgb;
  // zoomed in: a screen-resolution patch of the same map for the part in view (earthDetail.ts), blended
  // in over the outer 3 % of its box
  vec2 dsz = detailBox.zw - detailBox.xy, dq = (st - detailBox.xy) / dsz;
  float dEdge = min(min(dq.x, 1.0 - dq.x), min(dq.y, 1.0 - dq.y));
  if (dEdge > 0.0) tex = mix(tex, textureGrad(detail, dq, gx / dsz, gy / dsz).rgb, smoothstep(0.0, 0.03, dEdge));
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
  // edge sharpness: soft on the small Earth (no aliasing), crisper zoomed in (fp: Earth radii per pixel;
  // ~4e-4 in the 0.5 deg first-person view), where cloud edges are sharp at the km scale
  float dens = smoothstep(thr - 0.04, thr + mix(0.10, 0.24, smoothstep(0.0008, 0.004, fp)), cn);
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
  // to this point dims the surface and adds sky light. Plane-parallel single scattering:
  // L = F P / (4 pi) mu0 / (mu0 + mu) (1 - exp(-tau (1/mu + 1/mu0))), so the haze fades (and reddens)
  // with the sunlight reaching the air and goes dark at the terminator together with the ground, instead
  // of a bright blue band there. mu0 is eased to exactly 0 within ~1 deg past the terminator (air above
  // the ground still lit: twilight; C1 quadratic ramp, no long tail lifted by the gamma into a grey band).
  vec3 T = exp(-TAU0 * min(1.0 / mu, 35.4));
  float cosTh = dot(l, v), nl = dot(n, l);
  float mu0a = nl >= 0.02 ? nl : pow(max(nl + 0.02, 0.0), 2.0) / 0.08;
  vec3 path = 0.75 * (1.0 + cosTh * cosTh) / (4.0 * 3.14159) * mu0a / (mu0a + mu)
    * (1.0 - exp(-TAU0 * (min(1.0 / mu, 35.4) + min(1.0 / max(mu0a, 1e-4), 35.4))));
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
const float HA = 1200.0;
const float DELTA0 = 0.0204;                        // refraction of a ray grazing the surface (rad, both legs)
const vec3 TAUA = vec3(0.080, 0.100, 0.130);
void main() {
  czm_materialInput mi;
  mi.normalEC = vec3(0.0, 0.0, 1.0);
  mi.positionToEyeEC = -v_positionEC;
  mi.st = v_st;
  czm_material am = czm_getMaterial(mi);
  float exposure = am.specular;
  vec3 sunEC = am.normal;                           // the true Sun (not the scene light)
  float sunR = am.shininess;                        // its angular radius (rad)
  vec3 center = (czm_modelView * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 v = normalize(v_positionEC);                 // eye -> fragment (eye at the EC origin)
  float t = dot(center, v);
  float b = length(center - v * t);                 // impact parameter of the view ray
  float grazing = sqrt(2.0 * czm_pi * R / H);
  // rays that hit the planet: its haze is drawn by the Earth shader itself (EARTH_MATERIAL); this shell
  // only adds the glow around the limb. The test is EARTH_FS's own ray / WGS84-ellipsoid discriminant,
  // so the two cover exactly complementary pixels (a 6371 km sphere left a dark gap towards the poles,
  // where the ellipsoid is 14 km smaller). The ray's closest approach to the ellipsoid in its scaled
  // coordinates, q (1 = the surface), gives the tangent height h = (q - 1) R.
  vec3 inv = vec3(${(1 / EARTH_A).toExponential(9)}, ${(1 / EARTH_A).toExponential(9)}, ${(1 / EARTH_B).toExponential(9)});
  vec3 os = (czm_inverseModelView * vec4(0.0, 0.0, 0.0, 1.0)).xyz * inv;
  vec3 ds = normalize((czm_inverseModelView * vec4(v, 0.0)).xyz) * inv;
  vec3 pc = os - ds * (dot(os, ds) / dot(ds, ds));    // closest point of the ray (as EARTH_FS)
  float q2 = dot(pc, pc);
  if (q2 <= 1.0) discard;
  float h = (sqrt(q2) - 1.0) * R;
  // from the Moon the 8 km scale height is far below a pixel: spread the falloff over the pixel's
  // footprint (w), keeping its integral (H / w), so the limb is a smooth glow instead of a jagged line
  float fw = max(fwidth(h), 1.0);
  float w = max(H, fw);
  // Rayleigh (molecules, H = 8 km) and aerosols (dust, sulphate, sea salt: H_A = 1.2 km, optical depth
  // 0.1 at 550 nm, Angstrom exponent 1.3, single-scattering albedo 0.95). Along the view ray, each
  // contributes its slant optical depth at the tangent height h (Chapman grazing path, spread over the
  // pixel's footprint as above)
  float wa = max(HA, fw);
  float grazingA = sqrt(2.0 * czm_pi * R / HA);
  vec3 tauR = TAU0 * grazing * exp(-h / w) * (H / w);
  vec3 tauA = TAUA * grazingA * exp(-h / wa) * (HA / wa);
  vec3 tau = tauR + tauA;
  // sunlight reaching the air at the tangent point, attenuated (and reddened) along its own path: from
  // straight down (1 / mu0) up to half the grazing path at the terminator, through the air above h only;
  // a narrow twilight band beyond the terminator (air a few scale heights up still sees the Sun)
  vec3 up = normalize(v * t - center);
  float ul = dot(up, sunEC);
  float mu0a = ul >= 0.05 ? ul : pow(max(ul + 0.05, 0.0), 2.0) / 0.2;
  // (evaluated where each kind of air scatters within this pixel: from the Moon a pixel spans tens of
  // km of tangent height, and the scattering comes from its dense bottom, where the sunlight is dimmer
  // and redder - at the pixel's mid-height the ring came out white)
  float hLow = max(h - 0.5 * fw, 0.0);
  float hR = hLow + min(H, 0.5 * fw), hA = hLow + min(HA, 0.5 * fw);
  // the path length is capped at half the grazing path, so on its own the light stayed at that level
  // right up to the end of the twilight band and then stopped dead (a square end just past the cusps):
  // the share of the band still sunlit fades it out over the band instead
  vec3 lit = mu0a > 0.0
    ? exp(-TAU0 * exp(-hR / H) * min(1.0 / mu0a, 0.5 * grazing) - TAUA * exp(-hA / HA) * min(1.0 / mu0a, 0.5 * grazingA))
      * smoothstep(-0.05, 0.05, ul)
    : vec3(0.0);
  // phase functions: Rayleigh 3/4 (1 + cos^2), aerosols Henyey-Greenstein g = 0.75 - strongly forward:
  // ~28x at the Sun's direction, ~0.2x at right angles, so with the Sun just behind or beside the Earth
  // (a thin crescent, an eclipse) the limb flares into a bright arc on the Sun's side
  float cosTheta = dot(sunEC, v);
  float phaseR = 0.75 * (1.0 + cosTheta * cosTheta);
  float g = 0.75;
  float phaseA = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosTheta, 1.5);
  vec3 L = (phaseR * tauR + 0.95 * phaseA * tauA) / max(tau, vec3(1e-9)) / (4.0 * czm_pi) * (1.0 - exp(-tau)) * lit;   // in units of F_sun
  // refraction: the air bends a ray grazing at height hr by DELTA0 exp(-hr / H) (both legs; 1.17 deg at
  // the surface), so this point of the limb shows the refracted Sun from the height where that bending
  // equals the angle between it and the Sun: hr = H ln(DELTA0 / angle), over the Sun's disc (angle +- its
  // radius). The image keeps the Sun's surface brightness (1 / (pi r^2) of F_sun per sr), reddened by
  // the full grazing path at hr, but is squeezed radially ~1000x into a thin line: it covers only the
  // share of this pixel's span of tangent heights that its own span of heights overlaps. Where the Sun
  // sits off-centre behind the Earth the far side needs more bending than the air gives, so the copper
  // ring of an eclipse is lopsided, brightest on the Sun's side (Surveyor 3, 1967; Kaguya, 2009).
  float ang = acos(clamp(dot(v, sunEC), -1.0, 1.0));
  if (ang < DELTA0 + sunR) {
    float hImgLow = H * log(DELTA0 / (ang + sunR));
    float hImgHigh = ang > sunR ? H * log(DELTA0 / (ang - sunR)) : 100000.0;
    float overlap = max(0.0, min(hImgHigh, h + 0.5 * fw) - max(max(hImgLow, 0.0), h - 0.5 * fw));
    if (overlap > 0.0) {
      float hr = max(0.5 * (max(hImgLow, 0.0) + min(hImgHigh, h + 0.5 * fw)), 0.0);
      vec3 Tg = exp(-TAU0 * grazing * exp(-hr / H) - TAUA * grazingA * exp(-hr / HA));
      L += Tg * (overlap / fw) / (czm_pi * sunR * sunR);
    }
  }
  // over-exposed (the auto-exposure rises in an eclipse): clipped keeping the hue, so the ring of
  // refracted, reddened sunlight around the black Earth stays copper instead of washing out to white
  vec3 lin = L * ${EXPOSURE_K.toFixed(2)} * czm_pi * exposure;
  vec3 col = pow(lin / max(1.0, max(lin.r, max(lin.g, lin.b))), vec3(1.0 / 2.2));
  // composited "over" the planet: opacity = the air's extinction of what lies behind (mean over RGB),
  // colour = scattered light / opacity, so the result is col + background x transmittance
  float alpha = max(1.0 - exp(-(tau.r + tau.g + tau.b) / 3.0), max(col.r, max(col.g, col.b)));
  if (alpha < 1e-4) discard;
  out_FragColor = vec4(col / alpha, alpha);
}
`

/**
 * Sun disc. The Earth in front (a solar eclipse) is ray-traced, not left to the depth buffer, which
 * 360,000 km and 1.5e6 km out cannot order: the material (SUN_DISC_MATERIAL) gives the view ray's closest
 * approach to the same WGS84 ellipsoid as EARTH_FS (shininess, scaled units; < 1 = hits the Earth), so the
 * disc and the Earth cover exactly complementary pixels. A ray grazing just above the surface crosses
 * the air's grazing path (Rayleigh, as ATMOSPHERE_FS): attenuated and reddened. Photosphere: linear limb
 * darkening per channel and faint granulation (value noise on the solar sphere, scales fading out below
 * a pixel), colour of a 5772 K photosphere; times discGain (= 4e5 x exposure x metering, material
 * specular), clipped per channel (saturated = white, like a sensor).
 */
const SUN_BRIGHTNESS = 4e5
const SUN_DISC_FS = `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec2 v_st;
const vec3 TAU0 = vec3(0.050, 0.099, 0.224);
float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sHash(i), sHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(sHash(i + vec3(0.0, 1.0, 0.0)), sHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(sHash(i + vec3(0.0, 0.0, 1.0)), sHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(sHash(i + vec3(0.0, 1.0, 1.0)), sHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
void main() {
  czm_materialInput mi;
  mi.normalEC = vec3(0.0, 0.0, 1.0);
  mi.positionToEyeEC = -v_positionEC;
  mi.st = v_st;
  czm_material m = czm_getMaterial(mi);
  float h = (m.shininess - 1.0) * ${EARTH_A.toFixed(1)}; // height of the ray's closest approach to the Earth (m)
  if (h <= 0.0) discard;
  vec3 T = exp(-TAU0 * sqrt(2.0 * czm_pi * 6371000.0 / 8000.0) * exp(-h / 8000.0));
  vec3 n = normalize(v_normalEC);
  float mu = clamp(dot(n, normalize(-v_positionEC)), 0.0, 1.0);
  vec3 limb = 1.0 - vec3(0.47, 0.58, 0.70) * (1.0 - mu);
  // granulation / supergranulation on the solar sphere (world-aligned, the sphere does not rotate)
  vec3 q = czm_inverseViewRotation * n;
  float fq = length(fwidth(q));
  float gran = 0.0, sc = 25.0;
  for (int i = 0; i < 5; i++) {
    gran += (sNoise(q * sc + float(i) * 7.1) - 0.5) * 0.045 * (1.0 - smoothstep(0.3, 0.6, fq * sc));
    sc *= 2.6;
  }
  vec3 lin = m.specular * T * limb * vec3(1.0, 0.96, 0.91) * (1.0 + gran);
  out_FragColor = vec4(pow(min(lin, vec3(1.0)), vec3(1.0 / 2.2)), 1.0);
}
`
/**
 * SUN_DISC_FS's material: closest approach of the view ray to the Earth's ellipsoid (shininess, scaled
 * units) and the disc's brightness on the display scale (specular = discGain)
 */
const SUN_DISC_MATERIAL = `
czm_material czm_getMaterial(czm_materialInput mi) {
  czm_material m = czm_getDefaultMaterial(mi);
  vec3 inv = vec3(${(1 / EARTH_A).toExponential(9)}, ${(1 / EARTH_A).toExponential(9)}, ${(1 / EARTH_B).toExponential(9)});
  vec3 d = earthRotT * (czm_inverseViewRotation * normalize(-mi.positionToEyeEC)) * inv;
  vec3 o = earthRotT * (-earthCam) * inv;                 // camera in Earth-fixed, scaled coordinates
  float t = -dot(o, d) / dot(d, d);
  m.shininess = t > 0.0 ? length(o + d * t) : 1e9;       // behind the camera: never in front
  m.specular = discGain;
  return m;
}
`

/** glare pyramid depth: level k is 1 / 2^k of the resolution, blur ~0.6 x 2^k px; 9 levels reach the ~15 deg haze */
const GLARE_LEVELS = 9
/**
 * Glare level 1 (1/2 resolution): the share of each 2 x 2 block of screen pixels that sees the Sun's
 * disc, from geometry alone (no test on the rendered pixels, which white terrain or a metered disc
 * fooled): inside the disc, outside the Earth's and the Moon's discs (screen circles), and above the
 * drawn terrain's skyline (first person: 8 samples across the disc, in Sun radii above its centre,
 * along the screen directions of increasing azimuth / elevation at the Sun). Off-screen pixels: none.
 */
const GLARE_MASK_FS = `
uniform sampler2D colorTexture;
uniform vec2 sunUv;
uniform float sunRadiusPx;
uniform vec2 basisRight;   // screen px (y up) for +1 Sun radius of azimuth
uniform vec2 basisUp;      // ... and of elevation
uniform vec4 skylineA;     // skyline at azimuth offsets -1.05, -0.75, -0.45, -0.15 Sun radii (height above the centre, radii)
uniform vec4 skylineB;     // ... at 0.15, 0.45, 0.75, 1.05
uniform vec3 earthDisc;    // centre (px, y up), radius (px; 0 = none)
uniform vec3 moonDisc;
in vec2 v_textureCoordinates;
float skyline(float a) {
  float f = clamp((a + 1.05) / 0.3, 0.0, 6.999);
  int i = int(floor(f));
  float w = f - float(i);
  float h[8] = float[8](skylineA.x, skylineA.y, skylineA.z, skylineA.w, skylineB.x, skylineB.y, skylineB.z, skylineB.w);
  return mix(h[i], h[i + 1], w);
}
float sunPx(vec2 p, vec2 size, vec2 c) {
  if (p.x < 0.0 || p.y < 0.0 || p.x > size.x || p.y > size.y) return 0.0;
  vec2 d = p - c;
  if (length(d) > sunRadiusPx) return 0.0;
  if (earthDisc.z > 0.0 && length(p - earthDisc.xy) < earthDisc.z) return 0.0;
  if (moonDisc.z > 0.0 && length(p - moonDisc.xy) < moonDisc.z) return 0.0;
  float det = basisRight.x * basisUp.y - basisRight.y * basisUp.x;
  if (abs(det) > 1e-6) {
    float a = (d.x * basisUp.y - d.y * basisUp.x) / det, b = (basisRight.x * d.y - basisRight.y * d.x) / det;
    if (b < skyline(a)) return 0.0;
  }
  return 1.0;
}
void main() {
  vec2 size = vec2(textureSize(colorTexture, 0));
  vec2 c = sunUv * size;
  vec2 b = floor(gl_FragCoord.xy) * 2.0;
  out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  if (length(b + 1.0 - c) > sunRadiusPx + 2.0) return;
  // 8 x 8 samples over the 2 x 2 pixels: a sliver of disc thinner than a pixel (the Sun rising behind
  // a ridge, at full field of view) still counts
  float v = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) v += sunPx(b + (vec2(float(i), float(j)) + 0.5) * 0.25, size, c);
  out_FragColor.r = v / 64.0;
}
`
/** Glare levels 2..9: 2x downsample, four bilinear taps one source texel off the centre (a smooth 4 x 4 footprint) */
const GLARE_DOWN_FS = `
uniform sampler2D src;
in vec2 v_textureCoordinates;
void main() {
  vec2 t = 1.0 / vec2(textureSize(src, 0)), uv = v_textureCoordinates;
  float s = texture(src, uv + vec2(-t.x, -t.y)).r + texture(src, uv + vec2(t.x, -t.y)).r
          + texture(src, uv + vec2(-t.x, t.y)).r + texture(src, uv + vec2(t.x, t.y)).r;
  out_FragColor = vec4(0.25 * s, 0.0, 0.0, 1.0);
}
`
/** 3 x 3 tent upsample of a coarser level */
const GLARE_TENT = `
float tent(sampler2D tex, vec2 uv) {
  vec2 t = 1.0 / vec2(textureSize(tex, 0));
  return (4.0 * texture(tex, uv).r
    + 2.0 * (texture(tex, uv + vec2(t.x, 0.0)).r + texture(tex, uv - vec2(t.x, 0.0)).r + texture(tex, uv + vec2(0.0, t.y)).r + texture(tex, uv - vec2(0.0, t.y)).r)
    + texture(tex, uv + t).r + texture(tex, uv - t).r + texture(tex, uv + vec2(t.x, -t.y)).r + texture(tex, uv + vec2(-t.x, t.y)).r) / 16.0;
}
`
/** Recombination, coarse to fine: U_k = tent(U_k+1) + weight_k x D_k (the top level has no coarser one) */
const GLARE_UP_FS = GLARE_TENT + `
uniform sampler2D coarse;
uniform sampler2D detail;
uniform float weight;
uniform float coarseOn;
in vec2 v_textureCoordinates;
void main() {
  float c = coarseOn > 0.5 ? tent(coarse, v_textureCoordinates) : 0.0;
  out_FragColor = vec4(c + weight * texture(detail, v_textureCoordinates).r, 0.0, 0.0, 1.0);
}
`
/** The scene plus the glare (U_1 upsampled, times the photometric scale and the exposure), in linear light */
const GLARE_APPLY_FS = GLARE_TENT + `
uniform sampler2D colorTexture;
uniform sampler2D glareTexture;
uniform float gain;
in vec2 v_textureCoordinates;
void main() {
  vec4 col = texture(colorTexture, v_textureCoordinates);
  if (gain <= 0.0) { out_FragColor = vec4(col.rgb, 1.0); return; }
  float glare = gain * tent(glareTexture, v_textureCoordinates);
  if (glare <= 1e-5) { out_FragColor = vec4(col.rgb, 1.0); return; }
  vec3 lin = pow(col.rgb, vec3(2.2)) + glare * vec3(1.0, 0.97, 0.92);
  out_FragColor = vec4(pow(min(lin, vec3(1.0)), vec3(1.0 / 2.2)), 1.0); // opaque again (SUN_DISC_FS's alpha flag)
}
`

/**
 * Weight of glare level k (k = 1..GLARE_LEVELS): its blur is ~ a Gaussian of sigma_k = 0.6 x 2^k px, so
 * weights a_k = 2 pi sigma_k^2 (0.69 P2 + 0.55 P3)(theta_k) make sum_k a_k G_k follow the point-spread
 * P = P2 + P3 = 0.5 (72.37 / theta^2 + 20.91 / theta^3) (theta in deg on the 60 deg reference field;
 * 0.69 / 0.55: the overlap of Gaussians an octave apart for the 1 / theta^2 and 1 / theta^3 terms),
 * divided by the disc's area so a fully visible disc gives the profile itself.
 */
function glareWeight(k: number, resY: number, discAreaPx: number) {
  const sigma = 0.6 * 2 ** k
  const th = (sigma * 60) / resY + 0.02
  const p2 = (0.5 * 72.37) / (th * th), p3 = (0.5 * 20.91) / (th * th * th)
  return (2 * Math.PI * sigma * sigma * (0.69 * p2 + 0.55 * p3)) / discAreaPx
}

export interface Celestial {
  /** update for time tMs (UTC) with Moon-fixed Sun / Earth positions in metres */
  update(tMs: number, sunM: V3, earthM: V3): void
  /** show / hide the labels (e.g. hidden in the first-person view, where the bodies speak for themselves) */
  setLabels(show: boolean): void
  /**
   * camera exposure relative to daylight (fpvExposure in the first-person view), the share of the Sun's
   * disc visible (terrain, eclipse) for the metering when the Sun fills the frame, and the exposure for
   * the Earth and its atmosphere (default x): from the eclipse alone, so a local sunset behind the
   * terrain does not brighten the Earth
   */
  setExposure(x: number, sunVisible?: number, sky?: number): void
  /** load the 4096 px Earth (first-person view: zoomed in, the Earth can fill the screen) */
  loadDetail(): void
  /** first-person view: the drawn terrain's skyline (elevation, deg, at an azimuth, deg), for the glare; null: orbit */
  setHorizon(horizonDeg: ((azDeg: number) => number) | null): void
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
    // opaque: Cesium counts a material with its own shader source as translucent unless told otherwise,
    // and a translucent Earth went to the blended pass (no depth: its far side showed through)
    translucent: false,
    fabric: { type: 'EarthSurface', uniforms: { image: placeholder.toDataURL(), detail: placeholder.toDataURL(), detailBox: new Cartesian4(2, 2, 3, 3), exposure: 1.0, cloudPhase: 0.0, cloudCycle: 0.0, sunDirE: new Cartesian3(1, 0, 0) }, source: EARTH_MATERIAL },
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
        // a little larger than the ellipsoid (0.1 %): the 128-sided mesh drawn inside it left a dotted
        // line of pixels at the limb that neither it nor the halo (which skips the true ellipsoid)
        // covered; EARTH_FS ray-traces the true ellipsoid and discards the rest
        radii: new Cartesian3(EARTH_A * 1.001, EARTH_A * 1.001, EARTH_B * 1.001),
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
    // (and the true Sun direction as .normal, eye coordinates: the scene light is the earthshine at night)
    fabric: { type: 'EarthAtmosphere', uniforms: { exposure: 1.0, sunDirWC: new Cartesian3(1, 0, 0), sunRadius: 0.00465 }, source: 'czm_material czm_getMaterial(czm_materialInput mi) { czm_material m = czm_getDefaultMaterial(mi); m.specular = exposure; m.normal = normalize(czm_viewRotation * sunDirWC); m.shininess = sunRadius; return m; }' },
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
  // zoomed in on the Earth: a screen-resolution patch of the map for the part in view (earthDetail.ts)
  const earthDetail = createEarthDetail(scene, (p) => {
    if (p) material.uniforms.detail = p.image
    material.uniforms.detailBox = p ? new Cartesian4(...p.box) : new Cartesian4(2, 2, 3, 3)
    scene.requestRender()
  })
  const offDetail = scene.preRender.addEventListener(() => earthDetail.update(earthPrim.modelMatrix))
  const rot = new Matrix3()

  // Sun: a camera-relative unit sphere (scaled by the model matrix) 1.5e6 km out along the true Sun
  // direction, so it stays "at infinity" (no parallax) but is real geometry: the Moon and the Earth hide
  // exactly the part of the disc behind them
  // the Earth's centre from the camera (world, m) and its world -> Earth-fixed rotation, for SUN_DISC_FS
  const earthRotT = new Matrix3()
  const earthRotTArr = Matrix3.toArray(Matrix3.IDENTITY) // material mat3 uniforms are column-major arrays
  const sunMaterial = new Material({
    translucent: false, // opaque (see the Earth's material): translucent, the disc showed through the terrain
    fabric: {
      type: 'SunDisc',
      uniforms: { earthCam: new Cartesian3(1e12, 0, 0), earthRotT: earthRotTArr, discGain: SUN_BRIGHTNESS },
      source: SUN_DISC_MATERIAL,
    },
  })
  const sunDisc = scene.primitives.add(new Primitive({
    geometryInstances: new GeometryInstance({
      geometry: new EllipsoidGeometry({ radii: new Cartesian3(1, 1, 1), vertexFormat: MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat, slicePartitions: 48, stackPartitions: 24 }),
    }),
    // opaque (MaterialAppearance defaults to translucent, and translucent commands were composited over the terrain)
    appearance: new MaterialAppearance({ material: sunMaterial, materialSupport: MaterialAppearance.MaterialSupport.TEXTURED, translucent: false, closed: true, fragmentShaderSource: SUN_DISC_FS }),
    asynchronous: false,
  })) as Primitive
  const sunPos = new Cartesian3()
  const glareState = {
    uv: new Cartesian2(-10, -10), radiusPx: 1, gain: 0, resY: 1000, area: 1,
    right: new Cartesian2(1, 0), up: new Cartesian2(0, 1),
    skyA: new Cartesian4(-99, -99, -99, -99), skyB: new Cartesian4(-99, -99, -99, -99),
    earth: new Cartesian3(0, 0, 0), moon: new Cartesian3(0, 0, 0),
  }
  // the glare pyramid (GLARE_* shaders): level 1 = visible-disc mask at 1/2 resolution, levels 2..9
  // downsampled, then recombined from the coarsest up, then added to the scene. Half-float textures: the
  // coverage of a small Sun in the coarse levels is far below 8-bit steps
  const halfFloat = (Cesium as unknown as { PixelDatatype: { HALF_FLOAT: number } }).PixelDatatype.HALF_FLOAT
  const level = (k: number) => ({ textureScale: 1 / 2 ** k, sampleMode: PostProcessStageSampleMode.LINEAR, pixelDatatype: halfFloat })
  const stages: PostProcessStage[] = [
    new PostProcessStage({
      name: 'sunGlareD1', fragmentShader: GLARE_MASK_FS, ...level(1),
      uniforms: {
        sunUv: () => glareState.uv, sunRadiusPx: () => glareState.radiusPx, basisRight: () => glareState.right, basisUp: () => glareState.up,
        skylineA: () => glareState.skyA, skylineB: () => glareState.skyB, earthDisc: () => glareState.earth, moonDisc: () => glareState.moon,
      },
    } as ConstructorParameters<typeof PostProcessStage>[0]),
  ]
  for (let k = 2; k <= GLARE_LEVELS; k++) {
    stages.push(new PostProcessStage({ name: `sunGlareD${k}`, fragmentShader: GLARE_DOWN_FS, ...level(k), uniforms: { src: `sunGlareD${k - 1}` } } as ConstructorParameters<typeof PostProcessStage>[0]))
  }
  for (let k = GLARE_LEVELS; k >= 1; k--) {
    const kk = k
    stages.push(new PostProcessStage({
      name: `sunGlareU${k}`, fragmentShader: GLARE_UP_FS, ...level(k),
      uniforms: {
        coarse: k < GLARE_LEVELS ? `sunGlareU${k + 1}` : `sunGlareD${k}`, coarseOn: k < GLARE_LEVELS ? 1 : 0,
        detail: `sunGlareD${k}`, weight: () => glareWeight(kk, glareState.resY, glareState.area),
      },
    } as ConstructorParameters<typeof PostProcessStage>[0]))
  }
  stages.push(new PostProcessStage({
    name: 'sunGlareApply', fragmentShader: GLARE_APPLY_FS,
    // photometric scale: EXPOSURE_K pi / 0.12 (display units per unit of the profile) x 0.001 (lens) x exposure
    uniforms: { glareTexture: 'sunGlareU1', gain: () => ((EXPOSURE_K * Math.PI) / 0.12) * 0.001 * glareState.gain },
  }))
  const glare = scene.postProcessStages.add(new PostProcessStageComposite({ name: 'sunGlare', inputPreviousStageTexture: false, stages }))
  const win = new Cartesian2()
  let exposure = 1, sunVisibleShare = 1, meter = 1, skyExposure = 1
  let horizonFn: ((azDeg: number) => number) | null = null
  const scratchA = new Cartesian3(), scratchB = new Cartesian3(), scratchC = new Cartesian3(), scratchD = new Cartesian3()
  const scratchE = new Cartesian3(), scratchF = new Cartesian3(), scratchG = new Cartesian3(), scratchWin = new Cartesian2()
  // the metering scales the scene light set by App (a new light object on each change) without owning it
  let meteredLight: unknown = undefined, lightBase = 1
  const earthDir = new Cartesian3()
  const placeSun = () => {
    Cartesian3.add(scene.camera.positionWC, Cartesian3.multiplyByScalar(sunDir, SUN_DRAW_M, sunPos), sunPos)
    const r = SUN_DRAW_M * Math.tan(sunAngR)
    sunDisc.modelMatrix = Matrix4.setTranslation(Matrix4.fromUniformScale(r, sunDisc.modelMatrix), sunPos, sunDisc.modelMatrix)
    sunMaterial.uniforms.earthCam = Cartesian3.subtract(earthPos, scene.camera.positionWC, earthDir)
    // the disc on screen (drawing-buffer pixels); glare and metering off while the Sun is behind the camera
    let cover = 0, visMask = 0
    glareState.gain = 0
    const fovy = (scene.camera.frustum as { fovy?: number }).fovy
    const cam = scene.camera.positionWC
    if (fovy && Cartesian3.dot(scene.camera.directionWC, sunDir) > 0 && SceneTransforms.worldToDrawingBufferCoordinates(scene, sunPos, win)) {
      const h = scene.drawingBufferHeight, w = scene.drawingBufferWidth
      const pxPerRad = h / 2 / Math.tan(fovy / 2)
      glareState.uv.x = win.x / w
      glareState.uv.y = 1 - win.y / h
      const R = Math.max(1, Math.tan(sunAngR) * pxPerRad)
      glareState.radiusPx = R
      glareState.resY = h
      glareState.area = Math.PI * R * R
      const c = { x: win.x, y: h - win.y } // y up, as in the shaders
      // screen directions of +1 Sun radius in azimuth and elevation at the Sun (local frame of the camera)
      const up = Cartesian3.normalize(cam, scratchA)
      const upPerp = Cartesian3.normalize(Cartesian3.subtract(up, Cartesian3.multiplyByScalar(sunDir, Cartesian3.dot(up, sunDir), scratchB), scratchB), scratchB)
      const azDir = Cartesian3.normalize(Cartesian3.cross(sunDir, up, scratchC), scratchC)
      const screenOf = (dir: Cartesian3, out: Cartesian2) => {
        const p = Cartesian3.add(cam, Cartesian3.multiplyByScalar(dir, SUN_DRAW_M, scratchD), scratchD)
        if (!SceneTransforms.worldToDrawingBufferCoordinates(scene, p, out)) return false
        out.y = h - out.y
        return true
      }
      const offset = (perp: Cartesian3, out: Cartesian2) => {
        const dir = Cartesian3.normalize(Cartesian3.add(sunDir, Cartesian3.multiplyByScalar(perp, Math.tan(sunAngR), scratchE), scratchE), scratchE)
        if (screenOf(dir, out)) { out.x -= c.x; out.y -= c.y } else { out.x = 0; out.y = 0 }
      }
      offset(azDir, glareState.right)
      offset(upPerp, glareState.up)
      // the drawn skyline across the disc (first person), in Sun radii above its centre
      const sunEl = Math.asin(Math.max(-1, Math.min(1, Cartesian3.dot(sunDir, up))))
      const east = Cartesian3.normalize(Cartesian3.cross(Cartesian3.UNIT_Z, up, scratchF), scratchF)
      const north = Cartesian3.cross(up, east, scratchG)
      const sunAz = Math.atan2(Cartesian3.dot(sunDir, east), Cartesian3.dot(sunDir, north))
      const sky = [0, 0, 0, 0, 0, 0, 0, 0]
      for (let i = 0; i < 8; i++) {
        const t = -1.05 + 0.3 * i
        sky[i] = horizonFn ? (horizonFn(((sunAz + (t * sunAngR) / Math.max(Math.cos(sunEl), 0.05)) * 180) / Math.PI) * D2R - sunEl) / sunAngR : -99
      }
      glareState.skyA.x = sky[0]; glareState.skyA.y = sky[1]; glareState.skyA.z = sky[2]; glareState.skyA.w = sky[3]
      glareState.skyB.x = sky[4]; glareState.skyB.y = sky[5]; glareState.skyB.z = sky[6]; glareState.skyB.w = sky[7]
      // the Earth's and (from orbit) the Moon's discs on screen
      const disc = (center: Cartesian3, radiusM: number, out: Cartesian3) => {
        out.z = 0
        const rel = Cartesian3.subtract(center, cam, scratchD)
        const dist = Cartesian3.magnitude(rel)
        if (dist <= radiusM || Cartesian3.dot(rel, scene.camera.directionWC) <= 0) return
        if (!SceneTransforms.worldToDrawingBufferCoordinates(scene, center, scratchWin)) return
        out.x = scratchWin.x; out.y = h - scratchWin.y
        out.z = Math.tan(Math.asin(radiusM / dist)) * pxPerRad
      }
      disc(earthPos, EARTH_A, glareState.earth)
      if (horizonFn) glareState.moon.z = 0
      else disc(Cartesian3.ZERO, 1737400, glareState.moon)
      // the same geometry over 256 points of the disc: the share of it the mask holds (and on screen)
      let inside = 0, seen = 0
      const det = glareState.right.x * glareState.up.y - glareState.right.y * glareState.up.x
      for (let i = 0; i < 256; i++) {
        const a = i * 2.39996, rr = Math.sqrt((i + 0.5) / 256) * R
        const px = c.x + Math.cos(a) * rr, py = c.y + Math.sin(a) * rr
        if (px < 0 || py < 0 || px > w || py > h) continue
        inside++
        const E = glareState.earth, M = glareState.moon
        if (E.z > 0 && Math.hypot(px - E.x, py - E.y) < E.z) continue
        if (M.z > 0 && Math.hypot(px - M.x, py - M.y) < M.z) continue
        if (Math.abs(det) > 1e-6) {
          const dx = px - c.x, dy = py - c.y
          const ta = (dx * glareState.up.y - dy * glareState.up.x) / det, tb = (glareState.right.x * dy - glareState.right.y * dx) / det
          const f = Math.min(6.999, Math.max(0, (ta + 1.05) / 0.3)), k = Math.floor(f)
          if (tb < sky[k] * (1 - (f - k)) + sky[k + 1] * (f - k)) continue
        }
        seen++
      }
      visMask = seen / 256
      cover = Math.min(1, ((inside / 256) * glareState.area) / (w * h)) * sunVisibleShare
      glareState.gain = 1
    }
    // metering: from no change below 0.3 % of the frame to the disc centre properly exposed (0.9) at 6 %
    const full = Math.min(1, 0.9 / (SUN_BRIGHTNESS * exposure))
    const x = cover > 0 ? Math.min(1, Math.max(0, (Math.log(cover) - Math.log(0.003)) / (Math.log(0.06) - Math.log(0.003)))) : 0
    meter = Math.exp(x * x * (3 - 2 * x) * Math.log(full))
    const e = exposure * meter
    // glare at the camera exposure; faded out once the horizon analysis has the Sun hidden, so a sliver
    // of disc the drawn terrain misses (sampling) cannot flood the night exposure with glare
    // first person: the glare's total light follows the horizon analysis's visible share (the exposure
    // is set from the same number, so exposure x light <= 1 and a sliver the drawn terrain shows a bit
    // larger cannot flash); its shape is the mask's. From orbit: the mask's own share.
    const norm = horizonFn ? (visMask > 0 ? Math.min(4, sunVisibleShare / visMask) : 0) : 1
    glareState.gain *= e * norm
    const discGain = SUN_BRIGHTNESS * e
    sunMaterial.uniforms.discGain = discGain
    // the Earth and its air: the sky exposure (eclipse only, not the local sunset) x the metering
    const eSky = skyExposure * meter
    if (material.uniforms.exposure !== eSky) { material.uniforms.exposure = eSky; atmMaterial.uniforms.exposure = eSky }
    const light = scene.light as unknown as { intensity: number }
    if (light !== meteredLight) { meteredLight = light; lightBase = light.intensity }
    light.intensity = lightBase * meter
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
      Matrix3.toArray(Matrix3.transpose(rot, earthRotT), earthRotTArr)
      atmPrim.modelMatrix = Matrix4.clone(earthPrim.modelMatrix, atmPrim.modelMatrix)
      const d = Math.hypot(sunM[0], sunM[1], sunM[2])
      Cartesian3.normalize(Cartesian3.fromArray(sunM, 0, sunDir), sunDir)
      sunAngR = Math.asin((SUN_RADIUS_KM * 1000) / d)
      // the true Sun direction for the Earth (Earth-fixed) and its air (world)
      material.uniforms.sunDirE = Matrix3.multiplyByVector(earthRotT, sunDir, new Cartesian3())
      atmMaterial.uniforms.sunDirWC = Cartesian3.clone(sunDir)
      atmMaterial.uniforms.sunRadius = sunAngR
      const cyc = tMs / 1000 / CLOUD_PERIOD_S
      material.uniforms.cloudPhase = cyc - Math.floor(cyc)
      material.uniforms.cloudCycle = Math.floor(cyc) % 512
      scene.requestRender()
    },
    setExposure(x, sunVisible = 1, sky = x) {
      if (x === exposure && sunVisible === sunVisibleShare && sky === skyExposure) return
      exposure = x
      sunVisibleShare = sunVisible
      skyExposure = sky
      scene.requestRender() // placeSun applies it (with the metering) before the frame
    },
    setHorizon(fn) {
      horizonFn = fn
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
      offDetail()
      earthDetail.dispose()
      disposed = true
    },
  }
}
