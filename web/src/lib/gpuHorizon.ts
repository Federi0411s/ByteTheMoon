/**
 * Terrain horizons on the GPU (WebGPU compute), used by the heatmap workers (lib/heatWorker.ts).
 *
 * A horizon is the highest elevation angle along a ray marched outward over the elevation map, for
 * each of many azimuths of each sample: the live 32-azimuth horizons of zoomed-in tiles and the 1-deg
 * adaptive refinement near Sun / Earth crossings (at the poles, where the Sun always grazes the horizon,
 * that refinement alone took ~8 s per tile on one CPU core). Here one GPU thread marches one ray.
 *
 * Elevation data: the worker's decoded DEM tiles (lib/dem.ts, 16-bit DN, 128 KB each) are kept in a GPU
 * tile atlas (LRU over slots, uploaded once and reused by later jobs) with an open-addressing hash
 * table from the tile key (same numeric key as DemSampler) to its slot. The lookups replicate
 * DemSampler.sample(): bilinear within a level, falling back to coarser global levels where a tile is
 * missing, and the stereographic polar caps (lib/dem.ts) poleward of their edge latitudes.
 *
 * 32-bit floats: the ray points are built as unit vectors (p = cos d u + sin d (cos az n + sin az e))
 * and the polar-cap coordinates straight from them (x = 2R py / (1 -/+ pz), ...), which stays accurate
 * to ~0.2 m everywhere, even at the pole where asin(sin lat) would lose ~100 m. "No data" is a sentinel
 * value, not NaN (GPU compilers may assume NaN never occurs). Horizons agree with the CPU to ~0.01 deg.
 */
import { BU, MAP_READ, type Gpu, WGSL_TRIG, wgslF as f } from './gpu'

/** Elevation layout from DemSampler.gpuLayout(). */
export interface DemGpuLayout {
  offset: number
  scale: number
  /** south / north polar caps (null: none, or a different encoding, then the global DEM is read there) */
  caps: ({ z0: number; half: number; base: number; sinEdge: number; kForLevel: number[] } | null)[]
}

/** One batch of rays: samples (local frame + eye height) and (sample, azimuth) pairs. */
export interface RayBatch {
  /** per sample: up xyz, north xyz, east xyz, eye height (m): 10 floats */
  frames: Float32Array
  /** per ray: sample index */
  pairSample: Uint32Array
  /** per ray: sin(azimuth), cos(azimuth) */
  pairAz: Float32Array
  /** the ray: per step sin(d/R), cos(d/R), 1/d, curvature drop d/2R, and the DEM level read there */
  sinD: ArrayLike<number>; cosD: ArrayLike<number>; d: ArrayLike<number>; curv: ArrayLike<number>; level: ArrayLike<number>
  /** keys of the DEM tiles the rays may read, and their data (Uint16 DN; null / undefined = missing) */
  keys: Iterable<number>
  tile: (key: number) => Uint16Array | null | undefined
}

const TILE_PX = 256 * 256
const SLOT_WORDS = TILE_PX / 2 // two 16-bit DN per u32
const SLOT_BYTES = SLOT_WORDS * 4
const WG = 64
const CHUNK_RAYS = 16384 // rays per dispatch (each a few hundred DEM lookups): short GPU jobs, even on weak GPUs (TDR)
const EMPTY = 0xffffffff

function shader(L: DemGpuLayout) {
  const cap = (c: DemGpuLayout['caps'][number], name: string) => c
    ? `const ${name}_ON = true;
const ${name}_Z0: u32 = ${c.z0}u;
const ${name}_HALF: f32 = ${f(c.half)};
const ${name}_BASE: f32 = ${f(c.base)};
const ${name}_SIN: f32 = ${f(c.sinEdge)};
const ${name}_K = array<u32, ${c.kForLevel.length}>(${c.kForLevel.map((k) => `${k}u`).join(', ')});`
    : `const ${name}_ON = false;
const ${name}_Z0: u32 = 0u;
const ${name}_HALF: f32 = 1.0;
const ${name}_BASE: f32 = 1.0;
const ${name}_SIN: f32 = 0.0;
const ${name}_K = array<u32, 1>(0u);`
  const kMax = (c: DemGpuLayout['caps'][number]) => (c ? c.kForLevel.length - 1 : 0)
  return /* wgsl */ `${WGSL_TRIG}
const MISSING: f32 = -1e30;
const PI: f32 = 3.14159265358979;
const R2 = ${f(2 * 1737400)};
const OFFSET: f32 = ${f(L.offset)};
const SCALE: f32 = ${f(L.scale)};
${cap(L.caps[0], 'PS')}
${cap(L.caps[1], 'PN')}

struct Params { nRays: u32, base: u32, steps: u32, hashMask: u32 }
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> atlas: array<u32>;
// (7 storage buffers: WebGPU guarantees 8 per shader stage)
@group(0) @binding(2) var<storage, read> htab: array<vec2<u32>>;     // tile key, slot
@group(0) @binding(3) var<storage, read> ray: array<vec4<f32>>;      // sin d, cos d, 1/d, curvature
@group(0) @binding(4) var<storage, read> rlev: array<u32>;
@group(0) @binding(5) var<storage, read> frames: array<f32>;         // 10 per sample
@group(0) @binding(6) var<storage, read> pairs: array<vec4<f32>>;    // sample index (bits), sin az, cos az, -
@group(0) @binding(7) var<storage, read_write> outv: array<f32>;

fn slotOf(key: u32) -> i32 {
  var h = ((key ^ (key >> 15u)) * 2654435761u) & P.hashMask;
  for (var i = 0u; i <= P.hashMask; i++) {
    let e = htab[h];
    if (e.x == key) { return i32(e.y); }
    if (e.x == ${EMPTY}u) { return -1; }
    h = (h + 1u) & P.hashMask;
  }
  return -1;
}

// height (m) of pixel (gx, gy) of pseudo-level z (global level, or polar z0 + k), MISSING if absent
fn px(z: u32, gx: i32, gy: i32) -> f32 {
  if (gx < 0 || gy < 0) { return MISSING; }
  let tx = u32(gx) >> 8u;
  let ty = u32(gy) >> 8u;
  if (tx >= 8192u || ty >= 4096u) { return MISSING; }
  let slot = slotOf((z * 4096u + ty) * 8192u + tx);
  if (slot < 0) { return MISSING; }
  let i = (u32(gy) & 255u) * 256u + (u32(gx) & 255u);
  let w = atlas[u32(slot) * ${SLOT_WORDS}u + (i >> 1u)];
  let dn = select(w & 0xffffu, w >> 16u, (i & 1u) == 1u);
  if (dn == 0u) { return MISSING; }
  return OFFSET + SCALE * f32(dn);
}

fn bilin(a: f32, b: f32, c: f32, d: f32, fx: f32, fy: f32) -> f32 {
  if (a <= -1e29 || b <= -1e29 || c <= -1e29 || d <= -1e29) { return MISSING; }
  return (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (c * (1.0 - fx) + d * fx) * fy;
}

fn sampleLevel(lon: f32, lat: f32, z: u32) -> f32 {
  let n = 1u << z;
  let Wi = i32(512u * n);
  let Hi = i32(256u * n);
  let W = f32(Wi);
  let H = f32(Hi);
  var gx = (lon + PI) / (2.0 * PI) * W - 0.5;
  let gy = clamp((PI / 2.0 - lat) / PI * H - 0.5, 0.0, H - 1.0001);
  gx = gx - floor(gx / W) * W;
  let x0 = floor(gx);
  let y0 = floor(gy);
  let ix = i32(x0) % Wi;
  let iy = i32(y0);
  let x1 = (ix + 1) % Wi;
  let y1 = min(iy + 1, Hi - 1);
  return bilin(px(z, ix, iy), px(z, x1, iy), px(z, ix, y1), px(z, x1, y1), gx - x0, gy - y0);
}

fn samplePolar(z0: u32, k: u32, half: f32, base: f32, x: f32, y: f32) -> f32 {
  let pxm = base * exp2(f32(k));
  let c = (x + half) / pxm - 0.5;
  let r = (half - y) / pxm - 0.5;
  let c0 = floor(c);
  let r0 = floor(r);
  let zk = z0 + k;
  let ic = i32(c0);
  let ir = i32(r0);
  return bilin(px(zk, ic, ir), px(zk, ic + 1, ir), px(zk, ic, ir + 1), px(zk, ic + 1, ir + 1), c - c0, r - r0);
}

// DemSampler.sample() at unit vector p, global level z
fn sampleAt(p: vec3<f32>, z: u32) -> f32 {
  if (PS_ON && p.z < PS_SIN) {
    let den = 1.0 - p.z;
    let v = samplePolar(PS_Z0, PS_K[min(z, ${kMax(L.caps[0])}u)], PS_HALF, PS_BASE, R2 * p.y / den, R2 * p.x / den);
    if (v > -1e29) { return v; }
  } else if (PN_ON && p.z > PN_SIN) {
    let den = 1.0 + p.z;
    let v = samplePolar(PN_Z0, PN_K[min(z, ${kMax(L.caps[1])}u)], PN_HALF, PN_BASE, R2 * p.y / den, -R2 * p.x / den);
    if (v > -1e29) { return v; }
  }
  let lon = atan2P(p.y, p.x);
  let lat = atan2P(p.z, sqrt(p.x * p.x + p.y * p.y));
  for (var l = i32(z); l >= 0; l--) {
    let v = sampleLevel(lon, lat, u32(l));
    if (v > -1e29) { return v; }
  }
  return MISSING;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = P.base + gid.x;
  if (idx >= P.nRays) { return; }
  let pr = pairs[idx];
  let s = bitcast<u32>(pr.x) * 10u;
  let az = pr.yz;
  let u = vec3<f32>(frames[s], frames[s + 1u], frames[s + 2u]);
  let nn = vec3<f32>(frames[s + 3u], frames[s + 4u], frames[s + 5u]);
  let e = vec3<f32>(frames[s + 6u], frames[s + 7u], frames[s + 8u]);
  let hs = frames[s + 9u];
  let dir = az.y * nn + az.x * e;
  var best = MISSING;
  for (var k = 0u; k < P.steps; k++) {
    let r = ray[k];
    let h = sampleAt(r.y * u + r.x * dir, rlev[k]);
    if (h <= -1e29) { continue; }
    best = max(best, (h - hs) * r.z - r.w);
  }
  outv[idx] = select(atanP(best) * 57.2957795, 0.0, best <= -1e29);
}
`
}

export class GpuHorizon {
  private readonly gpu: Gpu
  private readonly device: GPUDevice
  private readonly pipeline: GPUComputePipeline
  private readonly params: GPUBuffer
  private atlas: GPUBuffer | null = null
  private slots = 0
  private readonly maxSlots: number
  private readonly resident = new Map<number, number>() // tile key -> slot
  private readonly lru: number[] = [] // keys, least recently used first
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(gpu: Gpu, pipeline: GPUComputePipeline) {
    this.gpu = gpu
    this.device = gpu.device
    this.pipeline = pipeline
    this.params = this.device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST })
    // each worker has its own atlas: at most 384 tiles (48 MB) on a discrete GPU, 160 (20 MB) on an
    // integrated one, whose memory is the system RAM (a batch needing more traces on the CPU)
    const cap = gpu.info.integrated ? 160 : 384
    this.maxSlots = Math.max(64, Math.min(cap, Math.floor(this.device.limits.maxStorageBufferBindingSize / SLOT_BYTES)))
  }

  get lost() { return this.gpu.lost }

  static async create(gpu: Gpu, layout: DemGpuLayout): Promise<GpuHorizon | null> {
    try {
      const pipeline = await gpu.device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: gpu.device.createShaderModule({ code: shader(layout) }), entryPoint: 'main' },
      })
      return new GpuHorizon(gpu, pipeline)
    } catch (e) {
      console.warn('GPU horizons unavailable:', e)
      return null
    }
  }

  /** Horizon elevation (deg) per ray of the batch (0 where no data was found along it). Queued per device. */
  trace(b: RayBatch): Promise<Float32Array> {
    const run = this.queue.then(() => this.run(b))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Make the batch's tiles resident; returns false if they don't fit. */
  private upload(b: RayBatch): boolean {
    const need: [number, Uint16Array][] = []
    const seen = new Set<number>()
    for (const k of b.keys) {
      if (seen.has(k)) continue
      seen.add(k)
      const t = b.tile(k)
      if (t) need.push([k, t])
    }
    if (need.length > this.maxSlots) return false
    if (!this.atlas || need.length > this.slots) {
      // grow (power of two, up to maxSlots); the old residents are dropped
      let n = Math.max(64, this.slots)
      while (n < need.length * 1.25 && n < this.maxSlots) n *= 2
      n = Math.min(n, this.maxSlots)
      this.atlas?.destroy()
      this.atlas = this.device.createBuffer({ size: n * SLOT_BYTES, usage: BU.STORAGE | BU.COPY_DST })
      this.slots = n
      this.resident.clear()
      this.lru.length = 0
    }
    const needed = new Set(need.map(([k]) => k))
    const free: number[] = []
    if (this.resident.size < this.slots) {
      const used = new Set(this.resident.values())
      for (let s = 0; s < this.slots && free.length < need.length; s++) if (!used.has(s)) free.push(s)
    }
    for (const [k, t] of need) {
      if (this.resident.has(k)) continue
      let slot = free.pop()
      if (slot === undefined) {
        // evict the least recently used tile this batch doesn't need
        const i = this.lru.findIndex((key) => !needed.has(key))
        if (i < 0) return false
        const old = this.lru.splice(i, 1)[0]
        slot = this.resident.get(old)!
        this.resident.delete(old)
      }
      this.device.queue.writeBuffer(this.atlas!, slot * SLOT_BYTES, t.buffer as ArrayBuffer, t.byteOffset, SLOT_BYTES)
      this.resident.set(k, slot)
      this.lru.push(k)
    }
    // refresh LRU order: this batch's tiles are the most recent
    for (const k of needed) {
      const i = this.lru.indexOf(k)
      if (i >= 0) { this.lru.splice(i, 1); this.lru.push(k) }
    }
    return true
  }

  private async run(b: RayBatch): Promise<Float32Array> {
    if (this.gpu.lost) throw new Error('GPU device lost')
    const nRays = b.pairSample.length
    if (!nRays) return new Float32Array(0)
    if (!this.upload(b)) throw new Error('too many elevation tiles for the GPU atlas')
    const dev = this.device
    // hash table of every resident tile (2x the slots, power of two)
    let H = 2
    while (H < this.slots * 2) H *= 2
    const htab = new Uint32Array(2 * H).fill(EMPTY)
    for (const [key, slot] of this.resident) {
      let h = Math.imul((key ^ (key >>> 15)) >>> 0, 2654435761) >>> 0 & (H - 1)
      while (htab[2 * h] !== EMPTY) h = (h + 1) & (H - 1)
      htab[2 * h] = key
      htab[2 * h + 1] = slot
    }
    const pairs = new Float32Array(nRays * 4), pairBits = new Uint32Array(pairs.buffer)
    for (let i = 0; i < nRays; i++) {
      pairBits[4 * i] = b.pairSample[i]
      pairs[4 * i + 1] = b.pairAz[2 * i]
      pairs[4 * i + 2] = b.pairAz[2 * i + 1]
    }
    const K = b.d.length
    const rayData = new Float32Array(K * 4), rlev = new Uint32Array(K)
    for (let k = 0; k < K; k++) {
      rayData[4 * k] = b.sinD[k]; rayData[4 * k + 1] = b.cosD[k]; rayData[4 * k + 2] = 1 / b.d[k]; rayData[4 * k + 3] = b.curv[k]
      rlev[k] = b.level[k]
    }
    const buf = (data: ArrayBufferView, usage = BU.STORAGE | BU.COPY_DST) => {
      const g = dev.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage })
      dev.queue.writeBuffer(g, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
      return g
    }
    const bufs = [buf(htab), buf(rayData), buf(rlev), buf(b.frames), buf(pairs)]
    const out = dev.createBuffer({ size: nRays * 4, usage: BU.STORAGE | BU.COPY_SRC })
    const read = dev.createBuffer({ size: nRays * 4, usage: BU.MAP_READ | BU.COPY_DST })
    try {
      const bind = dev.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.atlas! } },
          ...bufs.map((g, i) => ({ binding: i + 2, resource: { buffer: g } })),
          { binding: 7, resource: { buffer: out } },
        ],
      })
      dev.pushErrorScope('validation')
      const p = new Uint32Array(4)
      for (let base = 0; base < nRays; base += CHUNK_RAYS) {
        p[0] = nRays; p[1] = base; p[2] = K; p[3] = H - 1
        dev.queue.writeBuffer(this.params, 0, p)
        const enc = dev.createCommandEncoder()
        const pass = enc.beginComputePass()
        pass.setPipeline(this.pipeline)
        pass.setBindGroup(0, bind)
        pass.dispatchWorkgroups(Math.ceil(Math.min(CHUNK_RAYS, nRays - base) / WG))
        pass.end()
        dev.queue.submit([enc.finish()])
      }
      const enc = dev.createCommandEncoder()
      enc.copyBufferToBuffer(out, 0, read, 0, nRays * 4)
      dev.queue.submit([enc.finish()])
      const err = await dev.popErrorScope()
      if (err) throw new Error(`GPU horizons: ${err.message}`)
      await read.mapAsync(MAP_READ)
      const r = new Float32Array(read.getMappedRange().slice(0))
      read.unmap()
      return r
    } finally {
      for (const g of bufs) g.destroy()
      out.destroy()
      read.destroy()
    }
  }
}
