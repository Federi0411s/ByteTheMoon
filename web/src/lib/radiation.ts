export interface RadiationClassLegendItem {
  colore: string
  etichetta: string
}

export interface RadiationOverlayMetadata {
  west: number
  south: number
  east: number
  north: number
  unita: string
  dose_min: number
  dose_max: number
  legenda_classi: RadiationClassLegendItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function loadRadiationMetadata(url: string): Promise<RadiationOverlayMetadata> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Metadata radiazioni non disponibili (${response.status} ${response.statusText})`)

  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error('Formato non valido per i metadata delle radiazioni')

  const { west, south, east, north, unita, dose_min, dose_max } = value
  const bounds = [west, south, east, north]
  if (!bounds.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('Il JSON delle radiazioni deve contenere west, south, east e north numerici')
  }
  if (typeof west !== 'number' || typeof south !== 'number' || typeof east !== 'number' || typeof north !== 'number') {
    throw new Error('Il rettangolo geografico delle radiazioni non è valido')
  }
  if (west >= east || south >= north) {
    throw new Error('Il rettangolo geografico delle radiazioni non è valido')
  }
  if (typeof unita !== 'string' || typeof dose_min !== 'number' || !Number.isFinite(dose_min) ||
      typeof dose_max !== 'number' || !Number.isFinite(dose_max) || dose_min > dose_max) {
    throw new Error('Il JSON delle radiazioni deve contenere unita, dose_min e dose_max')
  }
  if (!Array.isArray(value.legenda_classi)) {
    throw new Error('Il JSON delle radiazioni deve contenere una legenda_classi valida')
  }
  const legenda_classi: RadiationClassLegendItem[] = []
  for (const item of value.legenda_classi) {
    if (!isRecord(item) || typeof item.colore !== 'string' || typeof item.etichetta !== 'string') {
      throw new Error('Il JSON delle radiazioni deve contenere una legenda_classi valida')
    }
    legenda_classi.push({ colore: item.colore, etichetta: item.etichetta })
  }

  return {
    west,
    south,
    east,
    north,
    unita,
    dose_min,
    dose_max,
    legenda_classi,
  }
}
