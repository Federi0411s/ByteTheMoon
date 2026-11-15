/**
 * Precomputed global tile pyramids (time-independent layers), all in Cesium's geographic layout:
 * level z has 2^(z+1) x 2^z tiles of 256 px, x from lon -180, y from lat +90.
 *
 *   dem    pipeline/dem_tiles.py    elevation, u16 (R*256 + G), B = 255 valid
 *   slope  pipeline/slope_tiles.py  slope (deg), u8x2: R = mean, G = max of the 118 m slopes inside
 *   sky    pipeline/sky_view.py     visible-sky fraction, u8 grey (radiation dose)
 *
 * Levels 0..publicMaxLevel ship with the app (public/data/<name>); finer ones come from a bucket.
 * Fine URL: VITE_<NAME>_FINE_URL, else VITE_DEM_FINE_URL with "dem_fine" -> "<name>_fine", else in
 * dev the Vite server's /<name>-fine (MOON_DATA/<name>_fine). "none" disables the fine levels.
 */
import { DATA_URL } from './data'

export type PyramidName = 'dem' | 'slope' | 'sky'

export interface PyramidIndex {
  name: PyramidName
  encoding: 'u16' | 'u8' | 'u8x2'
  scale: number
  offset: number
  publicMaxLevel: number
  fineMaxLevel: number
  source?: string
  publicUrl: string
  fineUrl: string | null
}

const ENV: Record<PyramidName, string | undefined> = {
  dem: import.meta.env.VITE_DEM_FINE_URL as string | undefined,
  slope: import.meta.env.VITE_SLOPE_FINE_URL as string | undefined,
  sky: import.meta.env.VITE_SKY_FINE_URL as string | undefined,
}

export function fineUrlFor(name: PyramidName): string | null {
  let url = ENV[name]
  if (url === undefined && name !== 'dem' && ENV.dem && ENV.dem !== 'none' && /dem_fine\/?$/.test(ENV.dem)) {
    url = ENV.dem.replace(/dem_fine(\/?)$/, `${name}_fine$1`)
  }
  if (url === '' || url === 'none') return null
  url = url ?? (import.meta.env.DEV ? `/${name}-fine` : undefined)
  return url ? new URL(url, location.href).href.replace(/\/$/, '') : null
}

/** null when that pyramid has not been generated (its index.json is missing). */
export async function loadPyramid(name: PyramidName): Promise<PyramidIndex | null> {
  try {
    const r = await fetch(`${DATA_URL}/${name}/index.json`)
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null
    const ix = await r.json()
    return {
      name,
      encoding: ix.encoding,
      scale: ix.scale,
      offset: ix.offset,
      publicMaxLevel: ix.publicMaxLevel,
      fineMaxLevel: ix.fineMaxLevel,
      source: ix.source,
      publicUrl: new URL(`${DATA_URL}/${name}`, location.href).href,
      fineUrl: ix.fineMaxLevel > ix.publicMaxLevel ? fineUrlFor(name) : null,
    }
  } catch {
    return null
  }
}
