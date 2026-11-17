/**
 * Sharp Earth when zoomed in: the whole-Earth Blue Marble map (4096 px, ~10 km per texel) is enough
 * until the Earth is ~2000 px across; in the first-person view, zoomed in to 0.5 deg, it is ~5000 px
 * and the map went soft. This fetches, for the part of the Earth actually in view, a patch of the same
 * Blue Marble at screen resolution (NASA GIBS WMS, any bounding box, native ~500 m), which the Earth
 * shader uses instead of the global map inside its box (celestial.ts, EARTH_MATERIAL `detail`).
 *
 * The region in view: rays through a grid of screen points intersected with the WGS84 ellipsoid in
 * Earth-fixed coordinates (as EARTH_FS), giving a longitude/latitude box (+25 % margin). A new patch is
 * requested once the view has been still for a moment and it has left the current patch or needs more
 * than 1.5x its resolution; one request at a time, the old patch stays until the new one has loaded.
 */
import { Cartesian2, Cartesian3, Matrix3, Matrix4, Ray, type Scene } from 'cesium'

const EARTH_A = 6378137, EARTH_B = 6356752.314
/** texels per degree of the global map (4096 px over 360 deg) */
const BASE_PPD = 4096 / 360
/** Blue Marble native resolution, ~500 m: no point asking for more */
const MAX_PPD = 220
const MAX_SIDE = 2048
const STILL_MS = 250
const GRID = 9

const wmsUrl = (lat0: number, lon0: number, lat1: number, lon1: number, w: number, h: number) =>
  `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=BlueMarble_NextGeneration&STYLES=&CRS=EPSG:4326&BBOX=${[lat0, lon0, lat1, lon1].map((v) => v.toFixed(4)).join(',')}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/jpeg`

export interface EarthDetailPatch {
  image: HTMLImageElement
  /** the patch in the Earth texture's st coordinates: (s0, t0, s1, t1); s = lon / 360 + 0.5, t = lat / 180 + 0.5 */
  box: [number, number, number, number]
}

/**
 * Call `update` every frame with the Earth's model matrix (Earth-fixed -> world); `onPatch` receives each
 * new patch, or null when the Earth no longer needs one (zoomed out: the global map is enough).
 */
export function createEarthDetail(scene: Scene, onPatch: (p: EarthDetailPatch | null) => void) {
  let cur: { lon0: number; lon1: number; lat0: number; lat1: number; ppd: number } | null = null
  let loading = false
  let lastKey = '', stillSince = 0
  let disposed = false
  const inv = new Matrix4(), rotT = new Matrix3()
  const ray = new Ray(), o = new Cartesian3(), d = new Cartesian3(), px = new Cartesian2()

  function want() {
    const cam = scene.camera
    const h = scene.drawingBufferHeight
    const cw = scene.canvas.clientWidth, ch = scene.canvas.clientHeight // (getPickRay takes CSS pixels)
    let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity, hits = 0
    let lonRef: number | undefined
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      px.x = (cw * i) / (GRID - 1); px.y = (ch * j) / (GRID - 1)
      cam.getPickRay(px, ray)
      Matrix4.multiplyByPoint(inv, ray.origin, o)
      Matrix3.multiplyByVector(rotT, ray.direction, d)
      const ox = o.x / EARTH_A, oy = o.y / EARTH_A, oz = o.z / EARTH_B
      const dx = d.x / EARTH_A, dy = d.y / EARTH_A, dz = d.z / EARTH_B
      const a = dx * dx + dy * dy + dz * dz, b = ox * dx + oy * dy + oz * dz, c = ox * ox + oy * oy + oz * oz - 1
      const disc = b * b - a * c
      if (disc < 0) continue
      const t = (-b - Math.sqrt(disc)) / a
      if (t <= 0) continue
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t
      let lon = (Math.atan2(y, x) * 180) / Math.PI
      // geodetic latitude (the texture's, as EARTH_FS: from the ellipsoid normal)
      const lat = (Math.atan2(z / (EARTH_B * EARTH_B), Math.hypot(x, y) / (EARTH_A * EARTH_A)) * 180) / Math.PI
      lonRef ??= lon
      while (lon - lonRef > 180) lon -= 360 // keep the box continuous across the date line
      while (lon - lonRef < -180) lon += 360
      lonMin = Math.min(lonMin, lon); lonMax = Math.max(lonMax, lon)
      latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat)
      hits++
    }
    if (hits < 2) return null
    // screen pixels per degree of the Earth's surface at the disc centre
    const fovy = (cam.frustum as { fovy?: number }).fovy ?? Math.PI / 3
    const dist = Cartesian3.magnitude(o) // camera distance from the Earth's centre (o: last ray origin, Earth-fixed)
    const ppd = Math.min(MAX_PPD, ((EARTH_A / dist / Math.tan(fovy / 2)) * (h / 2)) * (Math.PI / 180))
    if (ppd < 1.3 * BASE_PPD) return null
    // the region in view (+ 25 % margin, and at least the grid spacing so nothing between rays is missed)
    const mLon = Math.max(0.25 * (lonMax - lonMin), 1), mLat = Math.max(0.25 * (latMax - latMin), 1)
    let lon0 = lonMin - mLon, lon1 = lonMax + mLon
    const lat0 = Math.max(-90, latMin - mLat), lat1 = Math.min(90, latMax + mLat)
    // the WMS box cannot cross the date line: centre it in -180..180 and keep the side the centre is on
    const shift = 360 * Math.round((lon0 + lon1) / 2 / 360)
    lon0 = Math.max(-180, lon0 - shift)
    const lon1c = Math.min(180, lon1 - shift)
    return { lon0, lon1: lon1c, lat0, lat1, ppd }
  }

  function request(r: NonNullable<ReturnType<typeof want>>) {
    const latC = (r.lat0 + r.lat1) / 2
    let w = (r.lon1 - r.lon0) * r.ppd * Math.max(Math.cos((latC * Math.PI) / 180), 0.2), h = (r.lat1 - r.lat0) * r.ppd
    const k = Math.min(1, MAX_SIDE / Math.max(w, h))
    w = Math.max(64, Math.round(w * k)); h = Math.max(64, Math.round(h * k))
    const ppdGot = r.ppd * k
    loading = true
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      loading = false
      if (disposed) return
      cur = { ...r, ppd: ppdGot }
      onPatch({ image: img, box: [r.lon0 / 360 + 0.5, r.lat0 / 180 + 0.5, r.lon1 / 360 + 0.5, r.lat1 / 180 + 0.5] })
      scene.requestRender()
    }
    img.onerror = () => { loading = false }
    img.src = wmsUrl(r.lat0, r.lon0, r.lat1, r.lon1, w, h)
  }

  return {
    /** earthModel: Earth-fixed -> world (the Earth primitive's model matrix) */
    update(earthModel: Matrix4) {
      if (disposed) return
      Matrix4.inverseTransformation(earthModel, inv)
      Matrix4.getMatrix3(inv, rotT)
      const r = want()
      if (!r) {
        if (cur) { cur = null; onPatch(null) }
        return
      }
      if (loading) return
      const inside = cur && r.lon0 >= cur.lon0 - 1e-6 && r.lon1 <= cur.lon1 + 1e-6 && r.lat0 >= cur.lat0 - 1e-6 && r.lat1 <= cur.lat1 + 1e-6
      // shrink the request to the view itself when only resolution is missing
      if (inside && r.ppd <= 1.5 * cur!.ppd) return
      // wait until the view has been still (zooming / panning produces a new box every frame)
      const key = `${r.lon0.toFixed(2)},${r.lon1.toFixed(2)},${r.lat0.toFixed(2)},${r.lat1.toFixed(2)},${Math.round(r.ppd)}`
      const now = performance.now()
      if (key !== lastKey) { lastKey = key; stillSince = now; setTimeout(() => scene.requestRender(), STILL_MS + 20); return }
      if (now - stillSince < STILL_MS) return
      request(r)
    },
    dispose() { disposed = true },
  }
}
