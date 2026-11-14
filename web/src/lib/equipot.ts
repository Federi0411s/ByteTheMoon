/**
 * EQUIPOT (SPENVIS) surface-charging table, read straight from pipeline/equipot_results.csv so the
 * browser and the offline pipeline (lunar_charging.py) use the same numbers.
 *
 * Model (same as lunar_charging.ChargingModel):
 *   - Moon in the magnetotail when the Sun-Earth angle seen from the Moon is < 23 deg -> plasma sheet
 *     (PS) curve when lit, PS eclipse value when not;
 *   - otherwise solar wind (SW) curve when lit, SW eclipse value in self-shadow (Sun above the
 *     horizon but behind the local slope), WAKE value in terrain shadow (Sun below the horizon).
 *   - curves: V vs solar incidence angle from the surface normal, incidence clipped to the first
 *     tabulated angle, ending at 90 deg with the eclipse value.
 */
import csv from '../../../pipeline/equipot_results.csv?raw'

export interface EquipotTable {
  swAng: number[]
  swV: number[]
  psAng: number[]
  psV: number[]
  swEcl: number
  psEcl: number
  wake: number
  tailHalfAngleDeg: number
}

export function loadEquipot(): EquipotTable {
  const rows = csv
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split(','))
  const head = rows.shift()!.map((s) => s.trim())
  const col = (n: string) => head.indexOf(n)
  const data = rows.map((r) => ({ env: r[col('env')].trim(), cond: r[col('condition')].trim(), ang: Number(r[col('angle_deg')]), V: Number(r[col('V')]) }))
  const ecl = (env: string) => {
    const r = data.find((d) => d.env === env && d.cond === 'eclipse')
    if (!r) throw new Error(`EQUIPOT table: no eclipse value for ${env}`)
    return r.V
  }
  const curve = (env: string): [number[], number[]] => {
    const sun = data.filter((d) => d.env === env && d.cond === 'sun').sort((a, b) => a.ang - b.ang)
    return [[...sun.map((d) => d.ang), 90], [...sun.map((d) => d.V), ecl(env)]]
  }
  const [swAng, swV] = curve('SW')
  const [psAng, psV] = curve('PS')
  return { swAng, swV, psAng, psV, swEcl: ecl('SW'), psEcl: ecl('PS'), wake: ecl('WAKE'), tailHalfAngleDeg: 23 }
}
