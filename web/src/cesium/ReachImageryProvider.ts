import { Credit, Ellipsoid, Event, GeographicTilingScheme, Rectangle, type ImageryProvider } from 'cesium'
import type { ReachResult } from '../lib/reach'
import { reachBounds, SLOPE_QUANTUM, stereoForward } from '../lib/reachGrid'
import { levelForResolution } from './FieldImageryProvider'

/**
 * Map layer of the reachable area (lib/reachWorker.ts): cells whose "smallest slope limit that
 * reaches them" is within the chosen limit, coloured from green (reached on gentle ground) to amber
 * (needs nearly the full limit), with a light outline along the edge of the area.
 *
 * Each 256 px tile is reprojected through a 17 x 17 lattice of exact projections, bilinearly
 * interpolated in between (the projection is smooth; the error is far below a grid cell), so a tile
 * costs a few hundred trigonometric calls instead of 65 536. Changing the limit only means a new
 * provider over the same result: no recomputation.
 */
const TILE = 256
const LATTICE = 16 // pixels between exact projections
const NL = TILE / LATTICE + 1

type RawTile = { width: number; height: number; arrayBufferView: Uint8Array }
const EMPTY_TILE: RawTile = { width: 1, height: 1, arrayBufferView: new Uint8Array(4) }

// green (easy) -> amber (at the limit)
const LO = [46, 204, 113], HI = [255, 176, 32]
const EDGE = [255, 255, 255]

export class ReachImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme({ ellipsoid: Ellipsoid.MOON })
  readonly tileWidth = TILE
  readonly tileHeight = TILE
  readonly minimumLevel = 0
  readonly maximumLevel: number
  readonly rectangle: Rectangle
  readonly tileDiscardPolicy = undefined
  readonly errorEvent = new Event()
  readonly credit: Credit
  readonly proxy = undefined
  readonly hasAlphaChannel = true

  private readonly r: ReachResult
  private readonly limitQ: number
  private readonly lut = new Uint8Array(256 * 3)

  constructor(result: ReachResult, maxDeg: number) {
    this.r = result
    // a limit above what the search has explored yet would show unfinished values: clamp
    this.limitQ = Math.min(Math.floor(maxDeg * SLOPE_QUANTUM + 1e-9), result.exploredQ)
    this.rectangle = new Rectangle(...reachBounds(result.grid))
    // a few levels past the grid resolution, so the cell edges stay crisp when zoomed in
    this.maximumLevel = Math.min(15, levelForResolution(result.grid.cell) + 2)
    this.credit = new Credit(`Reachable area: max slope ${maxDeg}°, LOLA elevation (${Math.round(result.grid.cell)} m grid)`)
    for (let k = 0; k < 256; k++) {
      const t = k / 255
      for (let c = 0; c < 3; c++) this.lut[k * 3 + c] = Math.round(LO[c] + (HI[c] - LO[c]) * t)
    }
  }

  getTileCredits() {
    return []
  }

  pickFeatures() {
    return undefined
  }

  requestImage(x: number, y: number, level: number): Promise<RawTile> {
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level)
    if (!Rectangle.intersection(rect, this.rectangle) || this.limitQ < 0) return Promise.resolve(EMPTY_TILE)
    const { grid, val } = this.r
    const { n, cell, lat0, lon0 } = grid
    const half = (n - 1) / 2
    const L = this.limitQ, invL = L > 0 ? 255 / L : 0

    // exact grid coordinates (fractional cells) on the lattice
    const gi = new Float64Array(NL * NL), gj = new Float64Array(NL * NL)
    const p = new Float64Array(3)
    const dLon = (rect.east - rect.west) / TILE, dLat = (rect.north - rect.south) / TILE
    let anyNear = false
    for (let b = 0; b < NL; b++) {
      const lat = rect.north - b * LATTICE * dLat
      for (let a = 0; a < NL; a++) {
        stereoForward(lat0, lon0, rect.west + a * LATTICE * dLon, lat, p)
        const k = b * NL + a
        if (p[2] < 0) { gi[k] = gj[k] = -1e9; continue } // far side of the Moon
        gi[k] = p[0] / cell + half
        gj[k] = half - p[1] / cell
        if (gi[k] > -LATTICE && gi[k] < n + LATTICE && gj[k] > -LATTICE && gj[k] < n + LATTICE) anyNear = true
      }
    }
    // no lattice point near the grid: nothing to draw, unless the tile is so large that the whole
    // grid fits between two lattice points
    if (!anyNear && (rect.north - rect.south) * 1737400 / NL <= 4 * grid.radiusM) return Promise.resolve(EMPTY_TILE)

    const px = new Uint8Array(TILE * TILE * 4)
    const lut = this.lut
    let painted = false
    const at = (i: number, j: number) => (i < 0 || j < 0 || i >= n || j >= n ? 0xffff : val[j * n + i])
    for (let jy = 0; jy < TILE; jy++) {
      const b = Math.min(NL - 2, (jy / LATTICE) | 0)
      const fy = (jy + 0.5) / LATTICE - b
      for (let ix = 0; ix < TILE; ix++) {
        const a = Math.min(NL - 2, (ix / LATTICE) | 0)
        const fx = (ix + 0.5) / LATTICE - a
        const k = b * NL + a
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
        const fi = gi[k] * w00 + gi[k + 1] * w10 + gi[k + NL] * w01 + gi[k + NL + 1] * w11
        const fj = gj[k] * w00 + gj[k + 1] * w10 + gj[k + NL] * w01 + gj[k + NL + 1] * w11
        const ci = Math.round(fi), cj = Math.round(fj)
        if (ci < 0 || cj < 0 || ci >= n || cj >= n) continue
        const v = val[cj * n + ci]
        if (v > L) continue
        const o = (jy * TILE + ix) * 4
        // edge of the area: a 4-neighbour cell not reachable at this limit
        if (at(ci - 1, cj) > L || at(ci + 1, cj) > L || at(ci, cj - 1) > L || at(ci, cj + 1) > L) {
          px[o] = EDGE[0]; px[o + 1] = EDGE[1]; px[o + 2] = EDGE[2]
        } else {
          const t = Math.min(255, Math.round(v * invL)) * 3
          px[o] = lut[t]; px[o + 1] = lut[t + 1]; px[o + 2] = lut[t + 2]
        }
        px[o + 3] = 255
        painted = true
      }
    }
    return Promise.resolve(painted ? { width: TILE, height: TILE, arrayBufferView: px } : EMPTY_TILE)
  }
}

export const asReachProvider = (p: ReachImageryProvider) => p as unknown as ImageryProvider
