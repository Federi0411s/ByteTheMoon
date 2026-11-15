/**
 * Can the crew walk outside (EVA)? Artemis III suit (Axiom AxEMU) + NASA-STD-3001 radiation limits.
 *
 * Radiation (NASA-STD-3001): career limit 600 mSv effective dose (all ages, both sexes); solar particle
 * event max 250 mSv per event (not in the dose model: GCR + albedo only); surface habitat / vehicle
 * design requirement < 0.8 mSv/day.
 * Suit (AxEMU): normal use about −157 °C … +121 °C; permanently shadowed regions (below about −230 °C)
 * at most ~2 h; EVA at most ~8 h (suit autonomy); stay within ~2 km of the lander (solar events).
 *
 * The dose model gives ABSORBED dose in silicon (µGy/h); converted to EFFECTIVE dose with the Chang'e 4
 * surface ratio 13.2 µGy/h ↔ ~60 µSv/h (as pipeline/lunar_radiation.py, SV_PER_GY).
 */

export const SV_PER_GY = 60 / 13.2
export const CAREER_LIMIT_MSV = 600
export const SUIT_MIN_C = -157
export const SUIT_MAX_C = 121
/** dose budget per day spent outside (NASA-STD-3001 surface design value) */
export const DAILY_BUDGET_MSV = 0.8
/** crew stay assumed when no mission period is set (the loaded window is years long, no crew stays that long) */
export const REFERENCE_STAY_DAYS = 30

import type { SiteThermalSeries } from './regolith'

const fmtH = (h: number) => (h >= 1 ? `${+h.toFixed(1)} h` : `${Math.round(h * 60)} min`)

export const TEMP_LIMITS_TIP = 'AxEMU suit: −157…+121 °C · below −230 °C max 2 h'
export const WALK_TIP = 'Longest continuous sunlit stretch with the surface within −157…+121 °C, max 8 h (suit autonomy); shorter if the dose would exceed 0.8 mSv/day'
export const DAYLIGHT_TIP = 'Walks only in sunlight'
export const RAD_LIMITS_TIP = 'Career limit: 600 mSv (NASA-STD-3001)'

export type HumanStatus = 'ok' | 'limited' | 'no'

export interface HumanAssessment {
  /** can the crew walk outside? */
  walks: HumanStatus
  verdict: string
  /** longest walk, h */
  maxWalkH: number
  /** longest single walk and what limits it */
  walk: { status: HumanStatus; value: string; note: string }
  daylight: { status: HumanStatus; value: string; note: string }
  temp: { status: HumanStatus; value: string; note: string }
  rad: { status: HumanStatus; value: string; note: string }
}

/**
 * @param series hour-by-hour sunlight + surface temperature at the site over the period (lib/regolith.ts)
 * @param isMission false: no mission period set, the habitat dose is counted over REFERENCE_STAY_DAYS
 */
export function assessHuman(doseUGyH: number, series: SiteThermalSeries, missionDays: number, isMission: boolean): HumanAssessment {
  const periodDays = isMission ? missionDays : REFERENCE_STAY_DAYS
  const { sunlit, tC, stepH } = series
  const n = sunlit.length

  // walks only in sunlight AND with the surface inside the suit range, checked hour by hour
  let lit = 0, ok = 0, run = 0, windowH = 0, dayMin = Infinity, dayMax = -Infinity, cold = 0, hot = 0
  for (let i = 0; i < n; i++) {
    const inRange = tC[i] >= SUIT_MIN_C && tC[i] <= SUIT_MAX_C
    if (sunlit[i]) {
      lit++
      if (tC[i] < dayMin) dayMin = tC[i]
      if (tC[i] > dayMax) dayMax = tC[i]
      if (inRange) ok++
      else if (tC[i] < SUIT_MIN_C) cold++
      else hot++
    }
    run = sunlit[i] && inRange ? run + 1 : 0
    windowH = Math.max(windowH, run * stepH)
  }
  const sunlitPct = n ? (100 * lit) / n : 0
  const daylight: HumanAssessment['daylight'] = lit === 0
    ? { status: 'no', value: '0%', note: 'never sunlit' }
    : { status: sunlitPct < 30 ? 'limited' : 'ok', value: `${Math.round(sunlitPct)}%`, note: 'of the period, walks only then' }

  const okPct = lit ? (100 * ok) / lit : 0
  const range = lit ? `${Math.round(dayMin)} – ${Math.round(dayMax)} °C` : '—'
  const temp: HumanAssessment['temp'] = !lit
    ? { status: 'no', value: range, note: 'no daylight' }
    : ok === 0
      ? { status: hot > cold ? 'no' : 'limited', value: range, note: hot > cold ? 'too hot in daylight' : 'too cold in daylight: 2 h max' }
      : { status: okPct >= 90 ? 'ok' : 'limited', value: range, note: `in suit range ${Math.round(okPct)}% of daylight hours` }
  // longest walk allowed by temperature: the longest continuous sunlit, in-range stretch (max 8 h);
  // if it is never in range but only too cold, the suit still allows short (~2 h) excursions
  const suitH = ok > 0 ? Math.min(8, windowH) : lit && cold >= hot ? 2 : 0

  // radiation: one walk keeps within 0.8 mSv/day; the career limit has to cover the habitat dose first
  const mSvH = (doseUGyH * SV_PER_GY) / 1000
  const radH = DAILY_BUDGET_MSV / mSvH
  const maxWalkH = Math.min(suitH, radH)
  const walkMSv = mSvH * maxWalkH
  const habitatMSv = DAILY_BUDGET_MSV * periodDays
  const walksByDose = habitatMSv >= CAREER_LIMIT_MSV ? 0 : Math.floor((CAREER_LIMIT_MSV - habitatMSv) / Math.max(walkMSv, 1e-9))
  const sunlitDays = Math.floor((sunlitPct / 100) * periodDays)
  const rad: HumanAssessment['rad'] = {
    status: walksByDose === 0 ? 'no' : walksByDose < sunlitDays ? 'limited' : 'ok',
    value: `${mSvH.toFixed(3)} mSv/h`,
    note: `${walkMSv.toFixed(2)} mSv per walk`,
  }

  const walks: HumanStatus = daylight.status === 'no' || rad.status === 'no' || maxWalkH <= 0 ? 'no'
    : temp.status === 'ok' && rad.status === 'ok' && daylight.status === 'ok' && maxWalkH >= 8 ? 'ok' : 'limited'
  const verdict = walks === 'ok' ? 'Walks possible' : walks === 'limited' ? 'Walks possible, with limits' : 'Walks not possible'
  const walk: HumanAssessment['walk'] = walks === 'no'
    ? { status: 'no', value: '0 h', note: daylight.status === 'no' ? 'no daylight' : rad.status === 'no' ? 'career dose reached' : 'never within suit range' }
    : radH < suitH
      ? { status: 'limited', value: fmtH(maxWalkH), note: 'limited by radiation' }
      : ok === 0
        ? { status: 'limited', value: fmtH(maxWalkH), note: 'limited by the cold' }
        : maxWalkH < 8
          ? { status: 'limited', value: fmtH(maxWalkH), note: 'limited by the temperature window' }
          : { status: 'ok', value: fmtH(maxWalkH), note: 'full suit autonomy' }
  return { walks, verdict, maxWalkH, walk, daylight, temp, rad }
}
