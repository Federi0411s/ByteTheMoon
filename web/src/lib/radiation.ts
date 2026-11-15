import type { LayerMeta } from './raster'

const RAD_PRIMARY_UGY_H = 20.2
const RAD_ALBEDO_UGY_H = 6.2

/** GCR + soil-albedo dose rate from the visible sky fraction and the selected solar-cycle factor. */
export const radiationDose = (visibleSkyFraction: number, gcrFactor: number) =>
  (RAD_PRIMARY_UGY_H * visibleSkyFraction + RAD_ALBEDO_UGY_H * (1 - visibleSkyFraction)) * gcrFactor

export interface RadiationClassLegendItem {
  color: string
  label: string
}

export interface RadiationOverlayMetadata {
  projection: 'polar-south'
  width: number
  height: number
  halfExtentM: number
  resolutionM: number
  encoding: 'u8'
  classScale: number
  classOffset: number
  doseScale: number
  doseOffset: number
  units: string
  doseMin: number
  doseMax: number
  classLegend: RadiationClassLegendItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export async function loadRadiationMetadata(url: string): Promise<RadiationOverlayMetadata> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Radiation metadata unavailable (${response.status} ${response.statusText})`)

  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error('Invalid radiation metadata format')

  if (value.projection !== 'polar-south' || value.encoding !== 'u8') {
    throw new Error('Radiation metadata must describe a u8 raster in south-polar projection')
  }
  const { width, height, halfExtentM, resolutionM } = value
  if (!finiteNumber(width) || !Number.isInteger(width) || width <= 0 ||
      !finiteNumber(height) || !Number.isInteger(height) || height <= 0 ||
      !finiteNumber(halfExtentM) || halfExtentM <= 0 ||
      !finiteNumber(resolutionM) || resolutionM <= 0) {
    throw new Error('Invalid radiation raster dimensions, extent, or resolution')
  }
  const { classScale, classOffset, doseScale, doseOffset, doseMin, doseMax } = value
  if (!finiteNumber(classScale) || classScale <= 0 ||
      !finiteNumber(classOffset) ||
      !finiteNumber(doseScale) || doseScale <= 0 ||
      !finiteNumber(doseOffset) ||
      !finiteNumber(doseMin) ||
      !finiteNumber(doseMax) || doseMin > doseMax) {
    throw new Error('Invalid radiation encoding or dose range')
  }
  if (typeof value.units !== 'string' || !Array.isArray(value.classLegend)) {
    throw new Error('Radiation metadata must include units and a class legend')
  }

  const classLegend: RadiationClassLegendItem[] = []
  for (const item of value.classLegend) {
    if (!isRecord(item) || typeof item.color !== 'string' || typeof item.label !== 'string') {
      throw new Error('Radiation metadata contains an invalid class legend')
    }
    classLegend.push({ color: item.color, label: item.label })
  }

  return {
    projection: 'polar-south',
    width,
    height,
    halfExtentM,
    resolutionM,
    encoding: 'u8',
    classScale,
    classOffset,
    doseScale,
    doseOffset,
    units: value.units,
    doseMin,
    doseMax,
    classLegend,
  }
}

export function radiationLayerMeta(metadata: RadiationOverlayMetadata, mode: 'classes' | 'continuous'): LayerMeta {
  const classes = mode === 'classes'
  return {
    id: 'radiation',
    title: 'Radiation',
    description: 'Lunar radiation dose from GCRs and albedo',
    source: 'GCR + albedo model, LOLA DEM',
    file: classes ? 'radiation_classes.png' : 'radiation_continuous.png',
    projection: metadata.projection,
    width: metadata.width,
    height: metadata.height,
    halfExtentM: metadata.halfExtentM,
    encoding: metadata.encoding,
    scale: classes ? metadata.classScale : metadata.doseScale,
    offset: classes ? metadata.classOffset : metadata.doseOffset,
    units: classes ? 'class' : metadata.units,
    min: classes ? 0 : metadata.doseMin,
    max: classes ? 2 : metadata.doseMax,
    colormap: classes ? 'radiationClasses' : 'inferno',
    resolutionM: metadata.resolutionM,
  }
}
