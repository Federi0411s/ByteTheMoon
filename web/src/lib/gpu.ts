/**
 * The WebGPU device of one heatmap worker (shared by lib/gpuThermal.ts and lib/gpuHorizon.ts).
 *
 * Which GPU: the browser decides. We ask for 'high-performance'; on Windows laptops with two GPUs,
 * Chrome / Edge still run on the integrated one unless the browser is set to "High performance" in
 * Windows Settings > System > Display > Graphics (or chrome://flags/#force-high-performance-gpu is on).
 * A page can only ever use one GPU; the work is shared between it and the CPU cores instead (see the
 * per-tile backend choice in heatWorker.ts).
 */
export interface GpuInfo { vendor: string; architecture: string; description: string; integrated: boolean }

export interface Gpu { device: GPUDevice; info: GpuInfo; lost: boolean }

// WebGPU flags (the TS DOM lib has the WebGPU types but not these constant namespaces)
export const BU = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const
export const MAP_READ = 0x1

/** Integrated GPUs (shared memory): Intel, and AMD / Apple / ARM mobile parts. A guess from the adapter info. */
function isIntegrated(i: GPUAdapterInfo) {
  const v = i.vendor.toLowerCase(), a = i.architecture.toLowerCase(), d = i.description.toLowerCase()
  if (v === 'intel') return !/arc|alchemist|battlemage|xe-hpg/.test(`${a} ${d}`)
  return /apple|arm|qualcomm|mali|adreno|imagination/.test(v) || /\b(vega|radeon\(tm\) graphics|680m|780m|890m)\b/.test(d)
}

let pending: Promise<Gpu | null> | null = null

/** This worker's GPU device; null when WebGPU is unavailable (old browser, blocked GPU, no adapter). */
export function getGpu(): Promise<Gpu | null> {
  pending ??= (async () => {
    try {
      const gpu = globalThis.navigator?.gpu
      if (!gpu) return null
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return null
      // the largest storage buffers the adapter allows (DEM tile atlas, flux series)
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
        },
      })
      const i = adapter.info
      const g: Gpu = { device, info: { vendor: i.vendor, architecture: i.architecture, description: i.description, integrated: isIntegrated(i) }, lost: false }
      // lost (GPU reset, driver update, ...): the next getGpu() asks for a new device
      device.lost.then((l) => { g.lost = true; pending = null; console.warn('GPU device lost:', l.message) })
      return g
    } catch (e) {
      console.warn('WebGPU unavailable, computing on the CPU:', e)
      return null
    }
  })()
  return pending
}

/**
 * Inverse trigonometry with ~1e-7 accuracy on every GPU (WGSL lets implementations approximate atan2 /
 * asin / acos loosely, and some do: on Intel GPUs the horizon rays' longitudes, from atan2, moved
 * sampled terrain by up to ~170 m). atan: reduction to [0, 1], then to |u| <= tan(pi/8) via
 * atan t = pi/4 + atan((t - 1) / (t + 1)), then its series to u^17 (error < 3e-9).
 * asin / acos via atan2 with sqrt((1 - x)(1 + x)), well conditioned near +-1 (the poles).
 */
export const WGSL_TRIG = /* wgsl */ `
fn atanCore(t: f32) -> f32 {
  let big = t > 0.41421356;
  let u = select(t, (t - 1.0) / (t + 1.0), big);
  let u2 = u * u;
  var p = 1.0 / 17.0;
  p = -1.0 / 15.0 + u2 * p;
  p = 1.0 / 13.0 + u2 * p;
  p = -1.0 / 11.0 + u2 * p;
  p = 1.0 / 9.0 + u2 * p;
  p = -1.0 / 7.0 + u2 * p;
  p = 1.0 / 5.0 + u2 * p;
  p = -1.0 / 3.0 + u2 * p;
  p = 1.0 + u2 * p;
  return select(u * p, 0.785398163 + u * p, big);
}
fn atan2P(y: f32, x: f32) -> f32 {
  let ax = abs(x);
  let ay = abs(y);
  let mx = max(ax, ay);
  if (mx == 0.0) { return 0.0; }
  var r = atanCore(min(ax, ay) / mx);
  if (ay > ax) { r = 1.570796327 - r; }
  if (x < 0.0) { r = 3.141592654 - r; }
  return select(r, -r, y < 0.0);
}
fn atanP(x: f32) -> f32 { return atan2P(x, 1.0); }
fn asinP(x: f32) -> f32 { let c = clamp(x, -1.0, 1.0); return atan2P(c, sqrt(max(0.0, (1.0 - c) * (1.0 + c)))); }
fn acosP(x: f32) -> f32 { let c = clamp(x, -1.0, 1.0); return atan2P(sqrt(max(0.0, (1.0 - c) * (1.0 + c))), c); }
`

/** Float literal for WGSL source (f32 precision, always with a decimal point or exponent). */
export function wgslF(v: number) {
  const s = Math.fround(v).toPrecision(9)
  return /[.eE]/.test(s) ? s : `${s}.0`
}
