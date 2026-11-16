/**
 * The heatmap worker's time integration on the GPU (WebGPU compute), one thread per sample point.
 *
 * Mirrors, in 32-bit floats, these functions of lib/heatWorker.ts (keep them in step: a change to the
 * CPU physics needs the same change here; HeatEngine.compareThermalBackends shows any drift):
 *   - sunAndCharging()     light-weighted sunlit share (limb-darkened disc over the terrain horizon,
 *                          lib/sunDisc.ts; solar eclipses), EQUIPOT surface charging
 *   - visibleFraction()    Earth above the horizon (partial disc)
 *   - stationLinkStats()   DSN direct-link share and longest gap
 *   - longestNightHours()  longest interval without direct sunlight
 *   - absorbedFlux()       solar flux absorbed per regular thermal step, written straight into the GPU
 *                          buffers of the regolith solver (lib/gpuThermal.ts): the 14 MB series of a tile
 *                          never travel through the CPU
 *   - markNearHorizon()    which 1-deg directions need the adaptive horizon refinement (entry `marks`)
 *
 * Differences from the CPU: the Sun-Earth separation of the eclipse test comes from atan2 rather than
 * acos (acos near 1 loses ~0.02 deg in 32-bit floats); times are hours from the window start.
 * "No result" is the sentinel -1e30 (GPU compilers may assume NaN never occurs).
 */
import { BU, MAP_READ, type Gpu, WGSL_TRIG, wgslF as f } from './gpu'
import { discLight } from './sunDisc'
import type { EquipotTable } from './equipot'
import type { GpuThermal } from './gpuThermal'

export interface TimeConstants {
  sunRadius1AuDeg: number
  chargeSunRadiusDeg: number // SUN_RADIUS_DEG of the charging test
  adaptMarginDeg: number
  fineNaz: number
  s0: number; a0: number; aA: number; aB: number
  epsSigma: number
  moonRadiusM: number
}

/** Everything of a time window the kernels read (as the worker holds it). */
export interface TimeWindow {
  sun: Float32Array // T x [dir xyz, radius deg]
  earth: Float32Array // T x [dir xyz, radius deg] (eclipses, magnetotail, Earth visibility)
  dsn: Float64Array // T x 18: 3 stations x [position xyz m, up xyz]
  thermalSun: Float32Array // T2 x [dir xyz, distance AU]
  thermalEarth: Float32Array // T2 x [dir xyz, radius deg] or empty
  nightSun: Float32Array // NN x [dir xyz, radius deg]
  nightEarth: Float32Array // NN x 4 or empty
  nightTimes: Float64Array // NN, ms
  windowStart: number
  windowEnd: number
  sunRMax: number
  thermalRMax: number
  equipot: EquipotTable | null
  chargeThreshold: number
}

/** Bits of TimeJob.flags. */
export const TIME = { CHARGING: 1, EARTH: 2, LINK: 4, FLUX: 8, NIGHT: 16 } as const

/** Per-sample outputs of integrate() (stride OUT_STRIDE), NaN where not computed. */
export const OUT = { FRAC: 0, SUNLIT: 1, CMEAN: 2, CMIN: 3, CBELOW: 4, EARTH: 5, LINK: 6, LINKGAP: 7, DARK: 8, QMEAN: 9 } as const
export const OUT_STRIDE = 10
/** Per-sample input: frame (up xyz, east xy, north xyz, normal xyz), hMin, hMax, site height, horizon offset, count. */
export const SAMPLE_STRIDE = 16

const WG = 64
// samples per dispatch: each thread loops over thousands of time steps, so on a weak GPU one dispatch of a
// whole tile could approach the ~2 s after which Windows resets the GPU (TDR); short dispatches also let
// the globe's rendering run in between
const CHUNK_SAMPLES = 256
const DISC_N = 1600 // discLight() sampled at 4x its own 400 table nodes: the same piecewise-linear curve

function shader(c: TimeConstants) {
  return /* wgsl */ `${WGSL_TRIG}
const R2D: f32 = 57.2957795131;
const PI: f32 = 3.14159265358979;
const MISSING: f32 = -1e30;
const SUN_R_KM: f32 = 695700.0;
const EARTH_R_KM: f32 = 6371.0;
const MOON_R_KM: f32 = ${f(c.moonRadiusM / 1000)};
const MOON_R_M: f32 = ${f(c.moonRadiusM)};
const PARALLAX: f32 = 0.27;
const CH_SUN_R: f32 = ${f(c.chargeSunRadiusDeg)};
const SUN_R_1AU: f32 = ${f(c.sunRadius1AuDeg)};
const ADAPT: f32 = ${f(c.adaptMarginDeg)};
const FINE: i32 = ${c.fineNaz};
const S0: f32 = ${f(c.s0)};
const A0: f32 = ${f(c.a0)};
const AA: f32 = ${f(c.aA)};
const AB: f32 = ${f(c.aB)};
const ES: f32 = ${f(c.epsSigma)};
const DISC_N: u32 = ${DISC_N}u;

struct U {
  n: u32, T: u32, T2: u32, NN: u32,
  oSun: u32, oEarth: u32, oDsn: u32, oTSun: u32,
  oTEarth: u32, oNSun: u32, oNEarth: u32, oNTimes: u32,
  oDisc: u32, oEq: u32, flags: u32, has: u32,
  sunRMax: f32, thermalRMax: f32, windowH: f32, chargeThr: f32,
  dsnOk: u32, eqOn: u32, cosTail: f32, base: u32,
}
@group(0) @binding(0) var<uniform> P: U;
@group(0) @binding(1) var<storage, read> W: array<f32>;
@group(0) @binding(2) var<storage, read> SM: array<f32>;
@group(0) @binding(3) var<storage, read> HZ: array<f32>;
@group(0) @binding(4) var<storage, read_write> OUTB: array<f32>;
@group(0) @binding(5) var<storage, read_write> QOUT: array<f32>;
@group(0) @binding(6) var<storage, read_write> INIT: array<f32>;
@group(0) @binding(7) var<storage, read_write> MARKS: array<u32>;

var<private> HO: u32;
var<private> HN: u32;

fn v4(o: u32, j: u32) -> vec4<f32> { let i = o + 4u * j; return vec4<f32>(W[i], W[i + 1u], W[i + 2u], W[i + 3u]); }

// horizonAtAz(): linear between the HN azimuths of the current sample
fn hzAt(az: f32) -> f32 {
  let n = f32(HN);
  var fr = ((az / 360.0) * n) % n;
  fr = (fr + n) % n;
  let fl = floor(fr);
  let i0 = min(u32(fl), HN - 1u);
  let w = fr - fl;
  return HZ[HO + i0] * (1.0 - w) + HZ[HO + (i0 + 1u) % HN] * w;
}
fn azOf(east: f32, north: f32) -> f32 { var a = atan2P(east, north) * R2D; if (a < 0.0) { a += 360.0; } return a; }

fn discLight(d: f32) -> f32 {
  if (d >= 1.0) { return 1.0; }
  if (d <= -1.0) { return 0.0; }
  let fr = (d + 1.0) * 0.5 * f32(DISC_N);
  let i = min(DISC_N - 1u, u32(floor(fr)));
  let a = W[P.oDisc + i];
  return a + (W[P.oDisc + i + 1u] - a) * (fr - f32(i));
}
fn discEdgeAz(el: f32, r: f32) -> f32 { return r / max(cos(el / R2D), 1e-3); }
fn sunVisible(el: f32, r: f32, hC: f32, hL: f32, hR: f32) -> f32 {
  let s = (hR - hL) / (2.0 * r);
  return discLight((el - hC) / (r * sqrt(1.0 + s * s)));
}
fn sunLight(el: f32, r: f32, east: f32, north: f32) -> f32 {
  let az = azOf(east, north);
  let w = discEdgeAz(el, r);
  return sunVisible(el, r, hzAt(az), hzAt(az - w), hzAt(az + w));
}

// share of the Sun's disc hidden by the Earth, seen from the point at unit vector u
fn eclipseCover(u: vec3<f32>, s: vec3<f32>, rS: f32, e: vec3<f32>, rE: f32) -> f32 {
  if (dot(s, e) < cos((rS + rE + PARALLAX) / R2D)) { return 0.0; }
  let dS = SUN_R_KM / sin(rS / R2D);
  let dE = EARTH_R_KM / sin(rE / R2D);
  let p = u * MOON_R_KM;
  let vs = dS * s - p;
  let ve = dE * e - p;
  let ls = length(vs);
  let le = length(ve);
  let d = atan2P(length(cross(vs, ve)), dot(vs, ve));
  let r1 = asinP(SUN_R_KM / ls);
  let r2 = asinP(EARTH_R_KM / le);
  if (d >= r1 + r2) { return 0.0; }
  if (d <= r2 - r1) { return 1.0; }
  let a1 = r1 * r1 * acosP(clamp((d * d + r1 * r1 - r2 * r2) / (2.0 * d * r1), -1.0, 1.0));
  let a2 = r2 * r2 * acosP(clamp((d * d + r2 * r2 - r1 * r1) / (2.0 * d * r2), -1.0, 1.0));
  let k = 0.5 * sqrt(max(0.0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return min(1.0, (a1 + a2 - k) / (PI * r1 * r1));
}

fn sinHi(hMax: f32, rMax: f32) -> f32 { let h = hMax + 2.0 * rMax; return select(sin(h / R2D), 3.0, h >= 90.0); }
fn sinLo(hMin: f32, rMax: f32) -> f32 { let h = hMin - 2.0 * rMax; return select(sin(h / R2D), -3.0, h <= -90.0); }

// EQUIPOT curve (angles ascending at a, potentials at a + n): binary search as interp()
fn interp(x: f32, a: u32, n: u32) -> f32 {
  if (x <= W[a]) { return W[a + n]; }
  if (x > W[a + n - 1u]) { return W[a + 2u * n - 1u]; }
  var lo = 1u;
  var hi = n - 1u;
  while (lo < hi) {
    let mid = (lo + hi) >> 1u;
    if (x <= W[a + mid]) { hi = mid; } else { lo = mid + 1u; }
  }
  let x0 = W[a + lo - 1u];
  let y0 = W[a + n + lo - 1u];
  return y0 + (W[a + n + lo] - y0) * (x - x0) / (W[a + lo] - x0);
}

fn albedo(inc: f32) -> f32 {
  let a = inc / 45.0;
  let b = inc / 90.0;
  let b2 = b * b;
  let b4 = b2 * b2;
  return A0 + AA * a * a * a + AB * b4 * b4;
}

struct Frame { u: vec3<f32>, e: vec3<f32>, nn: vec3<f32>, m: vec3<f32> }

fn frameOf(k: u32) -> Frame {
  let b = k * ${SAMPLE_STRIDE}u;
  var F: Frame;
  F.u = vec3<f32>(SM[b], SM[b + 1u], SM[b + 2u]);
  F.e = vec3<f32>(SM[b + 3u], SM[b + 4u], 0.0);
  F.nn = vec3<f32>(SM[b + 5u], SM[b + 6u], SM[b + 7u]);
  F.m = vec3<f32>(SM[b + 8u], SM[b + 9u], SM[b + 10u]);
  HO = bitcast<u32>(SM[b + 14u]);
  HN = bitcast<u32>(SM[b + 15u]);
  return F;
}

@compute @workgroup_size(${WG})
fn integrate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = P.base + gid.x;
  if (k >= P.n) { return; }
  let F = frameOf(k);
  let b = k * ${SAMPLE_STRIDE}u;
  let hMin = SM[b + 11u];
  let hMax = SM[b + 12u];
  let siteH = SM[b + 13u];
  let o = k * ${OUT_STRIDE}u;
  for (var i = 0u; i < ${OUT_STRIDE}u; i++) { OUTB[o + i] = MISSING; }
  let hasEarth = (P.has & 1u) != 0u;
  let charging = (P.flags & ${TIME.CHARGING}u) != 0u && P.eqOn != 0u && hasEarth;

  // ---- sunAndCharging()
  if (P.T > 0u) {
    let sHi = sinHi(hMax, P.sunRMax);
    let sLo = sinLo(hMin, P.sunRMax);
    var acc = 0.0;
    var sum = 0.0;
    var vmin = 1e30;
    var below = 0.0;
    let eq = P.oEq;
    let swN = u32(W[eq]);
    let psN = u32(W[eq + 1u]);
    let swEcl = W[eq + 2u];
    let psEcl = W[eq + 3u];
    let wake = W[eq + 4u];
    let swA = eq + 5u;
    let psA = swA + 2u * swN;
    for (var j = 0u; j < P.T; j++) {
      let sv = v4(P.oSun, j);
      let s = sv.xyz;
      let r = sv.w;
      let se = dot(s, F.u);
      var el = select(-999.0, asinP(clamp(se, -1.0, 1.0)) * R2D, charging);
      var visible = 0.0;
      if (se >= sHi) { visible = 1.0; }
      else if (se > sLo) {
        if (el < -900.0) { el = asinP(clamp(se, -1.0, 1.0)) * R2D; }
        if (el - hMax >= 2.0 * r) { visible = 1.0; }
        else if (!(el - hMin <= -2.0 * r)) { visible = sunLight(el, r, dot(s, F.e), dot(s, F.nn)); }
      }
      var ecl = 0.0;
      var ev = vec4<f32>(0.0);
      if (hasEarth) {
        ev = v4(P.oEarth, j);
        ecl = eclipseCover(F.u, s, r, ev.xyz, ev.w);
        if (ecl > 0.0) { visible *= 1.0 - ecl; }
      }
      acc += visible;
      if (!charging) { continue; }
      let inTail = dot(s, ev.xyz) > P.cosTail;
      var above = false;
      if (el > hMax - CH_SUN_R) { above = true; }
      else if (el <= hMin - CH_SUN_R) { above = false; }
      else { above = el > hzAt(azOf(dot(s, F.e), dot(s, F.nn))) - CH_SUN_R; }
      let cosInc = dot(s, F.m);
      var V = 0.0;
      if (above && cosInc > 0.0 && ecl < 0.5) {
        let inc = acosP(min(1.0, cosInc)) * R2D;
        V = select(interp(inc, swA, swN), interp(inc, psA, psN), inTail);
      } else if (inTail) { V = psEcl; }
      else { V = select(wake, swEcl, above); }
      sum += V;
      vmin = min(vmin, V);
      if (V < P.chargeThr) { below += 1.0; }
    }
    let T = f32(P.T);
    OUTB[o + ${OUT.FRAC}u] = acc / T;
    OUTB[o + ${OUT.SUNLIT}u] = 100.0 * acc / T;
    if (charging) {
      OUTB[o + ${OUT.CMEAN}u] = sum / T;
      OUTB[o + ${OUT.CMIN}u] = vmin;
      OUTB[o + ${OUT.CBELOW}u] = below / T;
    }
  }

  // ---- visibleFraction(earth)
  if ((P.flags & ${TIME.EARTH}u) != 0u && hasEarth && P.T > 0u) {
    var acc = 0.0;
    for (var j = 0u; j < P.T; j++) {
      let ev = v4(P.oEarth, j);
      let el = asinP(clamp(dot(ev.xyz, F.u), -1.0, 1.0)) * R2D;
      let r = ev.w;
      if (el - hMax >= r) { acc += 1.0; continue; }
      if (el - hMin <= -r) { continue; }
      let h = hzAt(azOf(dot(ev.xyz, F.e), dot(ev.xyz, F.nn)));
      acc += clamp((el - h) / (2.0 * r) + 0.5, 0.0, 1.0);
    }
    OUTB[o + ${OUT.EARTH}u] = acc / f32(P.T);
  }

  // ---- stationLinkStats()
  if ((P.flags & ${TIME.LINK}u) != 0u && P.dsnOk != 0u && P.T > 0u) {
    let site = F.u * (MOON_R_M + siteH);
    let sHi = sin(hMax / R2D);
    let sLo = sin(hMin / R2D);
    var linked = 0.0;
    var gap = 0.0;
    var longest = 0.0;
    for (var j = 0u; j < P.T; j++) {
      var any = false;
      for (var st = 0u; st < 3u && !any; st++) {
        let q = P.oDsn + j * 18u + st * 6u;
        let dv = vec3<f32>(W[q], W[q + 1u], W[q + 2u]) - site;
        if (-dot(dv, vec3<f32>(W[q + 3u], W[q + 4u], W[q + 5u])) < 0.0) { continue; }
        let sinEl = dot(dv, F.u) / length(dv);
        if (sinEl >= sHi) { any = true; break; }
        if (sinEl < sLo) { continue; }
        any = asinP(clamp(sinEl, -1.0, 1.0)) * R2D >= hzAt(azOf(dot(dv, F.e), dot(dv, F.nn)));
      }
      if (any) { linked += 1.0; gap = 0.0; } else { gap += 1.0; longest = max(longest, gap); }
    }
    OUTB[o + ${OUT.LINK}u] = 100.0 * linked / f32(P.T);
    OUTB[o + ${OUT.LINKGAP}u] = longest * (P.windowH / f32(P.T));
  }

  // ---- longestNightHours()
  if ((P.flags & ${TIME.NIGHT}u) != 0u) {
    if (P.NN < 2u) { OUTB[o + ${OUT.DARK}u] = 0.0; }
    else {
      let hasNE = (P.has & 4u) != 0u;
      var prevM = 0.0;
      var prevT = 0.0;
      var darkStart = -1.0;
      var longest = 0.0;
      for (var j = 0u; j < P.NN; j++) {
        let sv = v4(P.oNSun, j);
        let s = sv.xyz;
        let r = sv.w;
        var m = 0.0;
        if (hasNE && eclipseCover(F.u, s, r, v4(P.oNEarth, j).xyz, v4(P.oNEarth, j).w) >= 0.999) { m = -0.01; }
        else {
          let el = asinP(clamp(dot(s, F.u), -1.0, 1.0)) * R2D;
          let az = azOf(dot(s, F.e), dot(s, F.nn));
          let w = discEdgeAz(el, r);
          let hC = hzAt(az);
          let sl = (hzAt(az + w) - hzAt(az - w)) / (2.0 * r);
          m = (el - hC) / (r * sqrt(1.0 + sl * sl)) + 1.0;
        }
        let t = W[P.oNTimes + j];
        if (j == 0u) { if (!(m > 0.0)) { darkStart = 0.0; } }
        else if ((prevM > 0.0) != (m > 0.0)) {
          let crossing = prevT + (-prevM / (m - prevM)) * (t - prevT);
          if (m > 0.0) { longest = max(longest, crossing - darkStart); darkStart = -1.0; }
          else { darkStart = crossing; }
        }
        prevM = m;
        prevT = t;
      }
      if (darkStart >= 0.0) { longest = max(longest, P.windowH - darkStart); }
      OUTB[o + ${OUT.DARK}u] = longest;
    }
  }

  // ---- absorbedFlux() -> the regolith solver's input buffers
  if ((P.flags & ${TIME.FLUX}u) != 0u && P.T2 > 0u) {
    let sHi = sinHi(hMax, P.thermalRMax);
    let sLo = sinLo(hMin, P.thermalRMax);
    let hasTE = (P.has & 2u) != 0u;
    var qMean = 0.0;
    let T2 = f32(P.T2);
    for (var j = 0u; j < P.T2; j++) {
      let sv = v4(P.oTSun, j);
      let s = sv.xyz;
      let au = sv.w;
      var q = 0.0;
      let cosInc = dot(s, F.m);
      if (cosInc > 0.0) {
        let se = dot(s, F.u);
        var vis = 0.0;
        if (se >= sHi) { vis = 1.0; }
        else if (se <= sLo) { vis = 0.0; }
        else {
          let el = asinP(clamp(se, -1.0, 1.0)) * R2D;
          let r = SUN_R_1AU / au;
          if (el - hMax >= 2.0 * r) { vis = 1.0; }
          else if (el - hMin <= -2.0 * r) { vis = 0.0; }
          else { vis = sunLight(el, r, dot(s, F.e), dot(s, F.nn)); }
        }
        if (vis > 0.0 && hasTE) {
          let te = v4(P.oTEarth, j);
          let ecl = eclipseCover(F.u, s, SUN_R_1AU / au, te.xyz, te.w);
          if (ecl > 0.0) { vis *= 1.0 - ecl; }
        }
        if (vis > 0.0) {
          let inc = acosP(min(1.0, cosInc)) * R2D;
          q = (1.0 - albedo(inc)) * (S0 / (au * au)) * cosInc * vis;
          qMean += q / T2;
        }
      }
      QOUT[j * P.n + k] = q;
    }
    OUTB[o + ${OUT.QMEAN}u] = qMean;
    INIT[k] = max(30.0, 0.74 * sqrt(sqrt(qMean / ES)));
  }
}

// ---- markNearHorizon() for the Sun and the Earth: 1-deg bins as bits, ${Math.ceil(c.fineNaz / 32)} words per sample
@compute @workgroup_size(${WG})
fn marks(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = P.base + gid.x;
  if (k >= P.n) { return; }
  let F = frameOf(k);
  let b = k * ${SAMPLE_STRIDE}u;
  let hMin = SM[b + 11u];
  let hMax = SM[b + 12u];
  var bits: array<u32, ${Math.ceil(c.fineNaz / 32)}>;
  let pad = ADAPT + 2.0;
  let sHi = select(sin((hMax + pad) / R2D), 2.0, hMax + pad >= 90.0);
  let sLo = select(sin((hMin - pad) / R2D), -2.0, hMin - pad <= -90.0);
  let bodies = select(1u, 2u, (P.has & 1u) != 0u);
  for (var body = 0u; body < bodies; body++) {
    let off = select(P.oEarth, P.oSun, body == 0u);
    for (var j = 0u; j < P.T; j++) {
      let sv = v4(off, j);
      let s = sv.xyz;
      let r = sv.w;
      let se = dot(s, F.u);
      if (se > sHi || se < sLo) { continue; }
      let el = asinP(clamp(se, -1.0, 1.0)) * R2D;
      let az = azOf(dot(s, F.e), dot(s, F.nn));
      if (abs(el - hzAt(az)) > ADAPT + 2.0 * r) { continue; }
      let w = i32(ceil(r / max(cos(el / R2D), 0.05))) + 1;
      let a0 = i32(floor(az));
      for (var d = -w; d <= w; d++) {
        let bin = u32(((a0 + d) % FINE + FINE) % FINE);
        bits[bin >> 5u] |= 1u << (bin & 31u);
      }
    }
  }
  for (var i = 0u; i < ${Math.ceil(c.fineNaz / 32)}u; i++) { MARKS[k * ${Math.ceil(c.fineNaz / 32)}u + i] = bits[i]; }
}
`
}

export class GpuTime {
  private readonly gpu: Gpu
  private readonly device: GPUDevice
  private readonly pIntegrate: GPUComputePipeline
  private readonly pMarks: GPUComputePipeline
  private readonly uniform: GPUBuffer
  private readonly words: number
  private win: GPUBuffer | null = null
  private header = new ArrayBuffer(96)
  private T2 = 0
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(gpu: Gpu, pIntegrate: GPUComputePipeline, pMarks: GPUComputePipeline, words: number) {
    this.gpu = gpu
    this.device = gpu.device
    this.pIntegrate = pIntegrate
    this.pMarks = pMarks
    this.words = words
    this.uniform = this.device.createBuffer({ size: 96, usage: BU.UNIFORM | BU.COPY_DST })
  }

  get lost() { return this.gpu.lost }

  static async create(gpu: Gpu, c: TimeConstants): Promise<GpuTime | null> {
    try {
      const module = gpu.device.createShaderModule({ code: shader(c) })
      const [pi, pm] = await Promise.all([
        gpu.device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'integrate' } }),
        gpu.device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'marks' } }),
      ])
      return new GpuTime(gpu, pi, pm, Math.ceil(c.fineNaz / 32))
    } catch (e) {
      console.warn('GPU time integration unavailable:', e)
      return null
    }
  }

  /** Pack and upload a new time window (queued after the work still using the old one). */
  setWindow(w: TimeWindow) {
    const T = w.sun.length / 4, T2 = w.thermalSun.length / 4, NN = w.nightTimes.length
    const hasEarth = w.earth.length >= T * 4 && T > 0
    const hasTE = w.thermalEarth.length >= T2 * 4 && T2 > 0
    const hasNE = w.nightEarth.length >= NN * 4 && NN > 0
    const dsnOk = w.dsn.length >= T * 18 && T > 0
    const eq = w.equipot
    const eqData = eq ? [eq.swAng.length, eq.psAng.length, eq.swEcl, eq.psEcl, eq.wake, ...eq.swAng, ...eq.swV, ...eq.psAng, ...eq.psV] : [1, 1, 0, 0, 0, 0, 0, 0, 0]
    const parts: ArrayLike<number>[] = []
    const offs: number[] = []
    let len = 0
    const add = (a: ArrayLike<number>) => { offs.push(len); parts.push(a); len += a.length }
    const disc = new Float32Array(DISC_N + 1)
    for (let i = 0; i <= DISC_N; i++) disc[i] = discLight(-1 + (2 * i) / DISC_N)
    const nightH = new Float32Array(NN)
    for (let j = 0; j < NN; j++) nightH[j] = (w.nightTimes[j] - w.windowStart) / 3600_000
    add(w.sun); add(hasEarth ? w.earth : []); add(dsnOk ? w.dsn : []); add(w.thermalSun); add(hasTE ? w.thermalEarth : [])
    add(w.nightSun); add(hasNE ? w.nightEarth : []); add(nightH); add(disc); add(eqData)
    const data = new Float32Array(Math.max(4, len))
    let o = 0
    for (const p of parts) { data.set(p, o); o += p.length }
    const h = new ArrayBuffer(96), hu = new Uint32Array(h), hf = new Float32Array(h)
    hu.set([0, T, T2, NN, ...offs.slice(0, 8), offs[8], offs[9], 0, (hasEarth ? 1 : 0) | (hasTE ? 2 : 0) | (hasNE ? 4 : 0)])
    hf[16] = w.sunRMax; hf[17] = w.thermalRMax; hf[18] = (w.windowEnd - w.windowStart) / 3600_000; hf[19] = w.chargeThreshold
    hu[20] = dsnOk ? 1 : 0; hu[21] = eq ? 1 : 0; hf[22] = eq ? Math.cos((eq.tailHalfAngleDeg * Math.PI) / 180) : 2
    this.queue = this.queue.then(() => {
      this.win?.destroy()
      this.win = this.device.createBuffer({ size: data.byteLength, usage: BU.STORAGE | BU.COPY_DST })
      this.device.queue.writeBuffer(this.win, 0, data)
      this.header = h
      this.T2 = T2
    }).catch(() => undefined)
  }

  private params(n: number, flags: number, base = 0) {
    const h = this.header.slice(0), hu = new Uint32Array(h)
    hu[0] = n
    hu[14] = flags
    hu[23] = base
    this.device.queue.writeBuffer(this.uniform, 0, h)
  }

  /** One dispatch per CHUNK_SAMPLES samples, each its own submit (uniform `base` updated in between). */
  private dispatch(pipeline: GPUComputePipeline, bind: GPUBindGroup, n: number, flags: number) {
    const dev = this.device
    for (let base = 0; base < n; base += CHUNK_SAMPLES) {
      this.params(n, flags, base)
      const enc = dev.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(Math.ceil(Math.min(CHUNK_SAMPLES, n - base) / WG))
      pass.end()
      dev.queue.submit([enc.finish()])
    }
  }

  private buf(data: ArrayBufferView) {
    const g = this.device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: BU.STORAGE | BU.COPY_DST })
    this.device.queue.writeBuffer(g, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
    return g
  }

  private async readback(src: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const dev = this.device
    const read = dev.createBuffer({ size: bytes, usage: BU.MAP_READ | BU.COPY_DST })
    const enc = dev.createCommandEncoder()
    enc.copyBufferToBuffer(src, 0, read, 0, bytes)
    dev.queue.submit([enc.finish()])
    await read.mapAsync(MAP_READ)
    const r = read.getMappedRange().slice(0)
    read.unmap()
    read.destroy()
    return r
  }

  private dummy(): GPUBuffer {
    return this.device.createBuffer({ size: 16, usage: BU.STORAGE })
  }

  /** markNearHorizon() for n samples (frames: SAMPLE_STRIDE floats each; hz: their coarse horizons). */
  marks(frames: Float32Array, hz: Float32Array, n: number): Promise<Uint32Array> {
    const run = this.queue.then(async () => {
      if (this.gpu.lost || !this.win) throw new Error('GPU not ready')
      const dev = this.device
      const sm = this.buf(frames), hzb = this.buf(hz)
      const out = dev.createBuffer({ size: Math.max(16, n * this.words * 4), usage: BU.STORAGE | BU.COPY_SRC })
      try {
        dev.pushErrorScope('validation')
        this.dispatch(this.pMarks, dev.createBindGroup({
          layout: this.pMarks.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.win } },
            { binding: 2, resource: { buffer: sm } }, { binding: 3, resource: { buffer: hzb } }, { binding: 7, resource: { buffer: out } },
          ],
        }), n, 0)
        const err = await dev.popErrorScope()
        if (err) throw new Error(`GPU marks: ${err.message}`)
        return new Uint32Array(await this.readback(out, n * this.words * 4))
      } finally {
        sm.destroy(); hzb.destroy(); out.destroy()
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Time integration of n samples. frames: SAMPLE_STRIDE floats each (horizon offset / count as u32 bits
   * into hz); flags: TIME bits. With TIME.FLUX and a solver, the regolith model runs right after on the
   * GPU (spin-up steps, step length s). Returns OUT_STRIDE values per sample (NaN = not computed) and,
   * with the solver, [mean, min, max] temperature per sample.
   */
  integrate(frames: Float32Array, hz: Float32Array, n: number, flags: number, thermal?: { solver: GpuThermal; spin: number; dtS: number }): Promise<{ out: Float32Array; temps?: Float32Array }> {
    const run = this.queue.then(async () => {
      if (this.gpu.lost || !this.win) throw new Error('GPU not ready')
      const dev = this.device
      const flux = (flags & TIME.FLUX) !== 0 && this.T2 > 0
      const sm = this.buf(frames), hzb = this.buf(hz)
      const out = dev.createBuffer({ size: Math.max(16, n * OUT_STRIDE * 4), usage: BU.STORAGE | BU.COPY_SRC })
      const q = flux ? dev.createBuffer({ size: Math.max(16, this.T2 * n * 4), usage: BU.STORAGE }) : this.dummy()
      const init = flux ? dev.createBuffer({ size: Math.max(16, n * 4), usage: BU.STORAGE | BU.COPY_SRC }) : this.dummy()
      try {
        dev.pushErrorScope('validation')
        this.dispatch(this.pIntegrate, dev.createBindGroup({
          layout: this.pIntegrate.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.win } },
            { binding: 2, resource: { buffer: sm } }, { binding: 3, resource: { buffer: hzb } },
            { binding: 4, resource: { buffer: out } }, { binding: 5, resource: { buffer: q } }, { binding: 6, resource: { buffer: init } },
          ],
        }), n, flags)
        const err = await dev.popErrorScope()
        if (err) throw new Error(`GPU time integration: ${err.message}`)
        // the solver's dispatches queue behind this one on the same device: no wait in between
        const tempsP = flux && thermal && thermal.solver.windowSteps === this.T2 ? thermal.solver.solveGpu(q, init, n, thermal.spin, thermal.dtS) : undefined
        const res = new Float32Array(await this.readback(out, n * OUT_STRIDE * 4))
        for (let i = 0; i < res.length; i++) if (res[i] <= -1e29) res[i] = NaN
        return { out: res, temps: tempsP ? await tempsP : undefined }
      } finally {
        sm.destroy(); hzb.destroy(); out.destroy(); q.destroy(); init.destroy()
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
