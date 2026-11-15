// Layer "Lunar pits" per Cesium. Legge public/data/pits.geojson (generato da pipeline/pits.py:
// catalogo LROC di Wagner & Robinson 2021 + quota LOLA della superficie per ogni pit).
import {
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  PointPrimitiveCollection,
  VerticalOrigin,
  type Label,
  type PointPrimitive,
  type Viewer,
} from 'cesium'
import { DATA_URL } from '../lib/data'

export interface PitProps {
  name: string
  host: string
  terrain: string
  type: string
  lat: number
  lon: number
  funnel_min_m: number | null
  funnel_max_m: number | null
  inner_min_m: number | null
  inner_max_m: number | null
  azimuth_deg: number | null
  depth_m: number | null
  depth_is_lower_bound: boolean
  entry_ramp: string | null
  overhang: string | null
  image_id: string | null
  dtm: string | null
  warnings: string | null
  notes: string
  /** LOLA surface height around the pit [m above the 1737.4 km sphere] (same DEM tiles as the 3D terrain) */
  surface_elev_m: number | null
  floor_elev_m: number | null
  inner_area_m2: number | null
  inner_volume_m3: number | null
  depth_to_diameter: number | null
}

/** Same rule as site markers: depth test off only when the camera is near, so pits on the far side stay hidden. */
const NO_DEPTH_TEST_WITHIN_M = 500_000
const CORE = Color.fromCssColorString('#ff9f1c')
const GLOW = Color.fromCssColorString('#ff9f1c').withAlpha(0.25)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePits(value: unknown): PitProps[] {
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) {
    throw new Error('Invalid pits GeoJSON FeatureCollection')
  }
  return value.features.map((feature: unknown, index: number) => {
    if (!isRecord(feature) || !isRecord(feature.geometry) || !isRecord(feature.properties) ||
        feature.geometry.type !== 'Point' || !Array.isArray(feature.geometry.coordinates)) {
      throw new Error(`Invalid pits GeoJSON feature at index ${index}`)
    }
    const [lon, lat] = feature.geometry.coordinates
    const p = feature.properties
    if (typeof lon !== 'number' || !Number.isFinite(lon) || typeof lat !== 'number' ||
        !Number.isFinite(lat) || lat < -90 || lat > 90 || typeof p.name !== 'string') {
      throw new Error(`Invalid coordinates or name in pits GeoJSON feature ${index}`)
    }
    return { ...(p as unknown as PitProps), lat, lon }
  })
}

export class PitsLayer {
  private readonly points = new PointPrimitiveCollection()
  private readonly glows = new PointPrimitiveCollection()
  private readonly labels = new LabelCollection()
  private readonly items: { pit: PitProps; core: PointPrimitive; glow: PointPrimitive; label: Label }[] = []
  private loading: Promise<void> | null = null
  private onTerrain = false
  private visible = false

  private readonly viewer: Viewer

  constructor(viewer: Viewer) {
    this.viewer = viewer
    viewer.scene.primitives.add(this.glows) // halo (below)
    viewer.scene.primitives.add(this.points) // bright core (above)
    viewer.scene.primitives.add(this.labels)
    this.applyVisibility()
  }

  get loaded() {
    return this.items.length > 0
  }

  /** Show / hide the layer; the GeoJSON is fetched the first time it is shown. */
  async setVisible(on: boolean) {
    this.visible = on
    if (on) await this.load()
    this.applyVisibility()
  }

  /**
   * With the LOLA 3D terrain on, put each pit at its LOLA surface height so it sits on the
   * terrain; on the smooth globe keep it at height 0, like the site markers.
   */
  setTerrain(on: boolean) {
    this.onTerrain = on
    for (const it of this.items) {
      const position = this.position(it.pit)
      it.core.position = position
      it.glow.position = position
      it.label.position = position
    }
  }

  /** The pit under a scene.pick() result, if any. */
  pitFromPick(picked: unknown): PitProps | undefined {
    if (!isRecord(picked) || !this.visible) return undefined
    if (picked.collection !== this.points && picked.collection !== this.glows) return undefined
    const id = picked.id
    return isRecord(id) && typeof id.name === 'string' ? (id as unknown as PitProps) : undefined
  }

  destroy() {
    for (const c of [this.points, this.glows, this.labels]) this.viewer.scene.primitives.remove(c)
  }

  private applyVisibility() {
    this.points.show = this.visible
    this.glows.show = this.visible
    this.labels.show = this.visible
  }

  private position(pit: PitProps) {
    const h = this.onTerrain && pit.surface_elev_m !== null ? pit.surface_elev_m : 0
    return Cartesian3.fromDegrees(pit.lon, pit.lat, h, Ellipsoid.MOON)
  }

  private load() {
    this.loading ??= (async () => {
      const response = await fetch(`${DATA_URL}/pits.geojson`)
      if (!response.ok) throw new Error(`Pits GeoJSON unavailable (${response.status} ${response.statusText})`)
      const pits = parsePits(await response.json())
      for (const pit of pits) {
        const position = this.position(pit)
        // pits are 10-100 m wide, invisible at global scale: draw them with a fixed pixel size
        const glow = this.glows.add({
          position,
          pixelSize: 22,
          color: GLOW,
          scaleByDistance: new NearFarScalar(2e3, 1.6, 4e6, 0.6),
          disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
          id: pit,
        })
        const core = this.points.add({
          position,
          pixelSize: 9,
          color: CORE,
          outlineColor: Color.BLACK,
          outlineWidth: 1.5,
          scaleByDistance: new NearFarScalar(2e3, 1.6, 4e6, 0.7),
          disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
          id: pit, // returned by scene.pick
        })
        const label = this.labels.add({
          position,
          text: pit.name,
          font: '12px system-ui',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -14),
          distanceDisplayCondition: new DistanceDisplayCondition(0, 3e5), // labels only up close
          disableDepthTestDistance: NO_DEPTH_TEST_WITHIN_M,
        })
        this.items.push({ pit, core, glow, label })
      }
    })().catch((error: unknown) => {
      this.loading = null // allow a retry
      throw error
    })
    return this.loading
  }
}

/** Rows for the inspect panel. */
export function pitInfoRows(p: PitProps): { title: string; value: string }[] {
  const m = (v: number | null, digits = 0) => (v === null || v === undefined ? '—' : `${v.toFixed(digits)} m`)
  const size = (a: number | null, b: number | null) => (a === null && b === null ? '—' : `${a ?? '?'} × ${b ?? '?'} m`)
  const flag = (v: string | null) => ({ Y: 'yes', N: 'no', 'Y?': 'probably', 'N?': 'probably not' } as Record<string, string>)[v ?? ''] ?? 'unknown'
  return [
    { title: `Pit: ${p.name}`, value: `${p.host} (${p.terrain}${p.type ? `, ${p.type}` : ''})` },
    { title: 'Pit depth', value: p.depth_m === null ? '—' : `${p.depth_is_lower_bound ? '> ' : ''}${p.depth_m} m` },
    { title: 'Pit inner opening', value: size(p.inner_min_m, p.inner_max_m) },
    { title: 'Pit funnel', value: size(p.funnel_min_m, p.funnel_max_m) },
    { title: 'Surface height (LOLA)', value: m(p.surface_elev_m) },
    { title: 'Pit floor height', value: m(p.floor_elev_m) },
    { title: 'Entrance ramp / overhangs', value: `${flag(p.entry_ramp)} / ${flag(p.overhang)}` },
    { title: 'Pit source', value: `LROC catalog (Wagner & Robinson 2021)${p.image_id ? `, NAC ${p.image_id}` : ''}` },
  ]
}
