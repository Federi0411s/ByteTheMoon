/**
 * Regolith temperature model on the GPU (WebGPU compute), used by the heatmap workers (lib/heatWorker.ts).
 *
 * The Hayne et al. 2017 column solver of heatWorker.solveThermal() is the most expensive part of every
 * temperature / landing-score tile (~3000 implicit time steps x 25 nodes per sample, 2-5 ms per sample
 * on one CPU core). Its only input is the absorbed-flux series of each sample, which the worker computes
 * on the CPU (that part holds the solar-disc, eclipse and terrain-horizon models), so here one GPU
 * thread solves one sample's column, all samples of a tile at once.
 *
 * Same arithmetic as the CPU solver (implicit Euler with temperature-dependent conductivity and heat
 * capacity lagged one step, bottom-up elimination, Newton on the surface radiation balance), in 32-bit
 * floats (WebGPU has no 64-bit): the means are summed with Kahan compensation, and results agree with
 * the CPU to ~0.01 K (HeatEngine.compareThermalBackends checks this on real tiles).
 *
 * The time loop is split into dispatches of CHUNK steps with the column state kept in a storage buffer,
 * so no single GPU job runs long: Windows resets a GPU that is busy for ~2 s (TDR), and the same GPU
 * also draws the globe.
 * The device is the worker's shared one (lib/gpu.ts).
 */
import { BU, MAP_READ, type Gpu, type GpuInfo, wgslF as f } from './gpu'


/** Regolith column constants (from heatWorker.ts, the single source of the model). */
export interface ThermalModel {
  nz: number
  rhoVol: ArrayLike<number> // rho * node volume
  kc: ArrayLike<number> // contact conductivity per node
  halfInvDz: ArrayLike<number> // 0.5 / dz per interface (nz - 1)
  cp: [number, number, number, number, number] // heat capacity polynomial
  chi: number
  epsSigma: number
  qGeo: number
}

const CHUNK = 256 // time steps per dispatch
const WG = 64
const arr = (a: ArrayLike<number>) => Array.from(a, f).join(', ')

/** WGSL of the column solver (constants inlined). State per sample: nz temperatures + [sum, comp, min, max, n]. */
function shader(m: ThermalModel) {
  const NZ = m.nz
  return /* wgsl */ `
const NZ: u32 = ${NZ}u;
const RHO_VOL = array<f32, ${NZ}>(${arr(m.rhoVol)});
const KC = array<f32, ${NZ}>(${arr(m.kc)});
const HALF_INV_DZ = array<f32, ${NZ - 1}>(${arr(m.halfInvDz)});
const CHI: f32 = ${f(m.chi)};
const ES: f32 = ${f(m.epsSigma)};
const QGEO: f32 = ${f(m.qGeo)};

struct Params { n: u32, steps: u32, first: i32, count: u32, invH: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> Q: array<f32>;         // [step][sample]
@group(0) @binding(2) var<storage, read> counted: array<u32>;   // per step: 1 = in the statistics
@group(0) @binding(3) var<storage, read_write> S: array<f32>;   // [node or stat][sample]

fn cp(t: f32) -> f32 { return ${f(m.cp[0])} + t * (${f(m.cp[1])} + t * (${f(m.cp[2])} + t * (${f(m.cp[3])} + t * ${f(m.cp[4])}))); }

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  let n = P.n;
  if (k >= n) { return; }
  var Tc: array<f32, ${NZ}>;
  var C: array<f32, ${NZ}>;
  var G: array<f32, ${NZ - 1}>;
  var alpha: array<f32, ${NZ}>;
  var beta: array<f32, ${NZ}>;
  for (var i = 0u; i < NZ; i++) { Tc[i] = S[i * n + k]; }
  var sum = S[NZ * n + k];
  var comp = S[(NZ + 1u) * n + k];
  var tmin = S[(NZ + 2u) * n + k];
  var tmax = S[(NZ + 3u) * n + k];
  var cnt = S[(NZ + 4u) * n + k];
  let T = i32(P.steps);
  for (var c = 0u; c < P.count; c++) {
    let s = P.first + i32(c);
    let q = Q[u32(((s % T) + T) % T) * n + k]; // spin-up cycles through the start of the series
    var kPrev = 0.0;
    for (var i = 0u; i < NZ; i++) {
      let t = Tc[i];
      let r = t * (1.0 / 350.0);
      C[i] = RHO_VOL[i] * cp(t) * P.invH;
      let kn = KC[i] * (1.0 + CHI * r * r * r);
      if (i > 0u) { G[i - 1u] = (kPrev + kn) * HALF_INV_DZ[i - 1u]; }
      kPrev = kn;
    }
    var invD = 1.0 / (C[NZ - 1u] + G[NZ - 2u]);
    alpha[NZ - 1u] = (C[NZ - 1u] * Tc[NZ - 1u] + QGEO) * invD;
    beta[NZ - 1u] = G[NZ - 2u] * invD;
    for (var i = NZ - 2u; i >= 1u; i--) {
      invD = 1.0 / (C[i] + G[i - 1u] + G[i] - G[i] * beta[i + 1u]);
      alpha[i] = (C[i] * Tc[i] + G[i] * alpha[i + 1u]) * invD;
      beta[i] = G[i - 1u] * invD;
    }
    let a1 = alpha[1];
    let b1 = beta[1];
    let c0 = C[0];
    let g0 = G[0];
    let lin = c0 + g0 * (1.0 - b1);
    let rhs = q + c0 * Tc[0] + g0 * a1;
    var t0 = max(Tc[0], sqrt(sqrt(max(rhs, 0.0) / ES)));
    for (var it = 0; it < 30; it++) {
      let t2 = t0 * t0;
      let fv = ES * t2 * t2 + lin * t0 - rhs;
      let d = fv / (4.0 * ES * t2 * t0 + lin);
      t0 -= d;
      if (abs(d) < 1e-3) { break; }
    }
    Tc[0] = max(t0, 2.0);
    for (var i = 1u; i < NZ; i++) { Tc[i] = alpha[i] + beta[i] * Tc[i - 1u]; }
    if (s >= 0 && counted[u32(s)] != 0u) {
      let v = Tc[0];
      // Kahan summation: a 3000-step sum of ~100-400 K stays exact to ~0.001 K in 32-bit floats
      let y = v - comp;
      let tt = sum + y;
      comp = (tt - sum) - y;
      sum = tt;
      tmin = min(tmin, v);
      tmax = max(tmax, v);
      cnt += 1.0;
    }
  }
  for (var i = 0u; i < NZ; i++) { S[i * n + k] = Tc[i]; }
  S[NZ * n + k] = sum;
  S[(NZ + 1u) * n + k] = comp;
  S[(NZ + 2u) * n + k] = tmin;
  S[(NZ + 3u) * n + k] = tmax;
  S[(NZ + 4u) * n + k] = cnt;
}
`
}

export class GpuThermal {
  readonly info: GpuInfo
  private readonly gpu: Gpu
  private readonly device: GPUDevice
  private readonly pipeline: GPUComputePipeline
  private readonly model: ThermalModel
  private readonly params: GPUBuffer
  private counted: GPUBuffer | null = null
  private steps = 0
  private qBuf: GPUBuffer | null = null
  private sBuf: GPUBuffer | null = null
  private rBuf: GPUBuffer | null = null
  private cap = 0 // samples the buffers hold
  private capSteps = 0 // ... for this many steps
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(gpu: Gpu, pipeline: GPUComputePipeline, model: ThermalModel) {
    this.gpu = gpu
    this.device = gpu.device
    this.pipeline = pipeline
    this.info = gpu.info
    this.model = model
    this.params = this.device.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST })
  }

  get lost() { return this.gpu.lost }

  /** regular thermal steps of the current window */
  get windowSteps() { return this.steps }

  /** null if the shader fails to compile (then the CPU solver is used). */
  static async create(model: ThermalModel, gpu: Gpu): Promise<GpuThermal | null> {
    try {
      // the async variant rejects on shader compile errors (instead of a silent invalid pipeline)
      const pipeline = await gpu.device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: gpu.device.createShaderModule({ code: shader(model) }), entryPoint: 'main' },
      })
      return new GpuThermal(gpu, pipeline, model)
    } catch (e) {
      console.warn('GPU regolith solver unavailable:', e)
      return null
    }
  }

  /** New time window: number of regular steps and which of them enter the statistics. */
  setWindow(counted: Uint8Array) {
    const u = new Uint32Array(Math.max(1, counted.length))
    u.set(counted)
    // after any batch still running on the old window (its buffers must not be replaced under it)
    this.queue = this.queue.then(() => {
      this.steps = counted.length
      this.counted?.destroy()
      this.counted = this.device.createBuffer({ size: u.byteLength, usage: BU.STORAGE | BU.COPY_DST })
      this.device.queue.writeBuffer(this.counted, 0, u)
    }).catch(() => undefined)
  }

  private ensure(n: number) {
    if (n <= this.cap && this.qBuf && this.capSteps === this.steps) return
    this.qBuf?.destroy(); this.sBuf?.destroy(); this.rBuf?.destroy()
    const cap = Math.max(n, 256)
    const nz = this.model.nz
    this.qBuf = this.device.createBuffer({ size: this.steps * cap * 4, usage: BU.STORAGE | BU.COPY_DST })
    this.sBuf = this.device.createBuffer({ size: (nz + 5) * cap * 4, usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC })
    this.rBuf = this.device.createBuffer({ size: 5 * cap * 4, usage: BU.MAP_READ | BU.COPY_DST })
    this.cap = cap
    this.capSteps = this.steps
  }

  /**
   * Solve n columns. q: absorbed flux (W/m2), step-major [step * n + sample]; init: starting temperature
   * of each column (K); spin: warm-up steps run before step 0 (cycling through the series start);
   * dtS: step (s). Returns [mean, min, max] surface temperature (K) per sample, interleaved.
   * Calls are queued: one batch at a time per device.
   */
  solve(q: Float32Array, init: Float32Array, n: number, spin: number, dtS: number): Promise<Float32Array> {
    const run = this.queue.then(() => this.run(q, init, n, spin, dtS))
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * As solve(), with the flux series and starting temperatures already in GPU buffers (written there by
   * lib/gpuTime.ts): nothing goes through the CPU but the results. q: [step * n + sample], init: [n].
   */
  solveGpu(q: GPUBuffer, init: GPUBuffer, n: number, spin: number, dtS: number): Promise<Float32Array> {
    const run = this.queue.then(() => this.run(q, init, n, spin, dtS))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async run(q: Float32Array | GPUBuffer, init: Float32Array | GPUBuffer, n: number, spin: number, dtS: number): Promise<Float32Array> {
    if (this.lost) throw new Error('GPU device lost')
    const T = this.steps, nz = this.model.nz, dev = this.device
    if (!T || !this.counted) throw new Error('no time window')
    this.ensure(n)
    // the buffers are laid out for `cap` samples, but the shader indexes with n: pack to n
    if (q instanceof Float32Array) dev.queue.writeBuffer(this.qBuf!, 0, q.buffer as ArrayBuffer, q.byteOffset, T * n * 4)
    const state = new Float32Array((nz + 5) * n)
    if (init instanceof Float32Array) for (let i = 0; i < nz; i++) state.set(init.subarray(0, n), i * n)
    state.fill(Infinity, (nz + 2) * n, (nz + 3) * n) // min
    state.fill(-Infinity, (nz + 3) * n, (nz + 4) * n) // max
    dev.queue.writeBuffer(this.sBuf!, 0, state)
    if (!(init instanceof Float32Array)) {
      // starting temperature of every node of each column, copied on the GPU
      const enc = dev.createCommandEncoder()
      for (let i = 0; i < nz; i++) enc.copyBufferToBuffer(init, 0, this.sBuf!, i * n * 4, n * 4)
      dev.queue.submit([enc.finish()])
    }
    const bind = dev.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: q instanceof Float32Array ? { buffer: this.qBuf!, size: T * n * 4 } : { buffer: q, size: T * n * 4 } },
        { binding: 2, resource: { buffer: this.counted } },
        { binding: 3, resource: { buffer: this.sBuf!, size: (nz + 5) * n * 4 } },
      ],
    })
    const params = new ArrayBuffer(32), pu = new Uint32Array(params), pi = new Int32Array(params), pf = new Float32Array(params)
    dev.pushErrorScope('validation')
    for (let first = -spin; first < T; first += CHUNK) {
      pu[0] = n; pu[1] = T; pi[2] = first; pu[3] = Math.min(CHUNK, T - first); pf[4] = 1 / dtS
      dev.queue.writeBuffer(this.params, 0, params)
      const enc = dev.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(this.pipeline)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(Math.ceil(n / WG))
      pass.end()
      dev.queue.submit([enc.finish()]) // one submit per chunk: other GPU work (the globe) can run in between
    }
    const enc = dev.createCommandEncoder()
    enc.copyBufferToBuffer(this.sBuf!, nz * n * 4, this.rBuf!, 0, 5 * n * 4)
    dev.queue.submit([enc.finish()])
    const err = await dev.popErrorScope()
    if (err) throw new Error(`GPU thermal: ${err.message}`)
    await this.rBuf!.mapAsync(MAP_READ, 0, 5 * n * 4)
    const r = new Float32Array(this.rBuf!.getMappedRange(0, 5 * n * 4).slice(0))
    this.rBuf!.unmap()
    const out = new Float32Array(3 * n)
    for (let k = 0; k < n; k++) {
      const cnt = r[4 * n + k]
      out[3 * k] = cnt > 0 ? r[k] / cnt : NaN
      out[3 * k + 1] = cnt > 0 ? r[2 * n + k] : NaN
      out[3 * k + 2] = cnt > 0 ? r[3 * n + k] : NaN
    }
    return out
  }
}
