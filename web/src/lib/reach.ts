/**
 * Main-thread side of the reachable-area computation (lib/reachWorker.ts): one worker, one job at a
 * time. start() begins a new search from a point; setLimit() changes the slope limit of the current
 * one (lowering it needs no work at all: the result already holds every lower limit, see
 * ReachResult.exploredQ; raising it resumes the search in the worker).
 */
import type { DemConfig } from './dem'
import type { ReachGrid } from './reachGrid'
import type { ReachReply, ReachRequest } from './reachWorker'

export interface ReachResult {
  grid: ReachGrid
  /** n x n, row 0 = north: smallest slope limit (tenths of a degree) reaching each cell (see reachGrid) */
  val: Uint16Array
  /** values up to this limit (tenths of a degree) are final; any limit up to it can be drawn as is */
  exploredQ: number
  /** elevation pyramid level the grid was sampled at (cell = that level's pixel) */
  level: number
  /** false while a finer pass is still running */
  final: boolean
  /** time since the search started, ms */
  ms: number
}

export class ReachEngine {
  private readonly worker: Worker
  private readonly cfg: DemConfig
  private job = 0
  onResult?: (r: ReachResult) => void
  onError?: (error: string) => void

  constructor(cfg: DemConfig) {
    this.cfg = cfg
    this.worker = new Worker(new URL('./reachWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<ReachReply>) => {
      const m = e.data
      if (m.job !== this.job) return // an older search
      if (m.type === 'error') this.onError?.(m.error)
      else this.onResult?.({ grid: m.grid, val: m.val, exploredQ: m.exploredQ, level: m.level, final: m.final, ms: m.ms })
    }
  }

  start(latDeg: number, lonDeg: number, radiusM: number, maxDeg: number) {
    this.job++
    this.send({ type: 'start', job: this.job, cfg: this.cfg, latDeg, lonDeg, radiusM, maxDeg })
  }

  setLimit(maxDeg: number) {
    this.send({ type: 'limit', job: this.job, maxDeg })
  }

  stop() {
    this.job++
    this.send({ type: 'stop' })
  }

  dispose() {
    this.worker.terminate()
  }

  private send(m: ReachRequest) {
    this.worker.postMessage(m)
  }
}
