import { DEFAULT_ADVANCED_SETTINGS, type AdvancedSettings } from './advancedSettings'

/**
 * Landing score: each criterion is put in one of four classes, each class is worth fixed points, the
 * overall score is the mean. If ANY criterion is "Not feasible" every score is still shown, but the
 * mission is declared not feasible.
 *
 * Thresholds:
 *  - temperature (MEAN regolith surface temperature over the period, lunar bands; min/max only reported):
 *      Recommended ≥ −80 °C · Feasible −80…−130 °C · Difficult −130…−180 °C · Not feasible < −180 °C
 *  - radiation (total ionizing dose over the mission period, µGy):
 *      Recommended < 3·10^8 · Feasible 3·10^8…10^9 · Difficult 10^9…10^10 · Not feasible > 10^10
 *  - slope (max slope inside the landing footprint, °):
 *      Recommended 0–5 · Feasible 5–8 · Difficult 8–10 · Not feasible > 10
 *  - telecommunications (PROPOSED: share of time with at least one DSN station in direct link):
 *      Recommended ≥ 80 % (near-continuous contact) · Feasible 40–80 % (store-and-forward between passes)
 *      · Difficult 10–40 % (long blackouts, relay advised) · Not feasible < 10 % (needs a relay satellite)
 *  - sunlight (percentage of the selected mission period with the Sun above the local terrain horizon):
 *      Recommended ≥ 80 % · Feasible 50–80 % · Difficult 20–50 % · Not feasible < 20 %
 */

export type ScoreClass = 'recommended' | 'feasible' | 'difficult' | 'not-feasible'

export const CLASS_INFO: Record<ScoreClass, { label: string; points: number; color: string }> = {
  recommended: { label: 'Recommended', points: 100, color: '#3ddc84' },
  feasible: { label: 'Feasible', points: 70, color: '#c6e24a' },
  difficult: { label: 'Difficult', points: 40, color: '#ffa23f' },
  'not-feasible': { label: 'Not feasible', points: 0, color: '#ff5b5b' },
}

export interface CriterionResult {
  id: 'temperature' | 'radiation' | 'slope' | 'telecom' | 'sunlight'
  name: string
  cls: ScoreClass
  /** what was measured, human readable */
  value: string
  comment: string
}

export interface LandingScore {
  criteria: CriterionResult[]
  /** 0..100, mean of the criteria points */
  score: number
  feasible: boolean
  /** names of the criteria still being computed / unavailable */
  missing: string[]
}

const fmtC = (c: number) => `${Math.round(c)} °C`
const sci = (v: number) => (v >= 1e6 ? v.toExponential(1).replace('e+', '·10^') : Math.round(v).toLocaleString('en-US'))

/**
 * Temperature class from the MEAN regolith surface temperature over the period, with lunar bands: no
 * place on the Moon has a natural environment inside equipment limits (−55…+125 °C), so every lander
 * needs insulation and heaters; these bands rank how hard that is. Reference (Hayne 2017 model, flat
 * terrain, 2027): equator ≈ −67 °C, 60°S ≈ −105 °C, 80°S ≈ −153 °C, 88°S ≈ −197 °C. The bare-soil
 * extremes are reported in the comment only.
 */
export const TEMP_BANDS_C = {
  recommended: DEFAULT_ADVANCED_SETTINGS.temperature.recommendedC,
  feasible: DEFAULT_ADVANCED_SETTINGS.temperature.feasibleC,
  difficult: DEFAULT_ADVANCED_SETTINGS.temperature.difficultC,
}

export function scoreTemperature(tMeanC: number, tMinC: number, tMaxC: number, settings: AdvancedSettings = DEFAULT_ADVANCED_SETTINGS): CriterionResult {
  const t = tMeanC
  const { recommendedC, feasibleC, difficultC } = settings.temperature
  const cls: ScoreClass =
    t >= recommendedC ? 'recommended'
      : t >= feasibleC ? 'feasible'
        : t >= difficultC ? 'difficult'
          : 'not-feasible'
  const extremes = ` Bare-soil extremes ${fmtC(tMinC)} – ${fmtC(tMaxC)}.`
  const comment = {
    recommended: `Mean ${fmtC(t)} (≥ ${fmtC(recommendedC)}): among the mildest places on the Moon, standard insulation and heaters.`,
    feasible: `Mean ${fmtC(t)} (${fmtC(feasibleC)}…${fmtC(recommendedC)}): cold site, more heater power and insulation needed.`,
    difficult: `Mean ${fmtC(t)} (${fmtC(difficultC)}…${fmtC(feasibleC)}): very cold, a dedicated thermal design (e.g. radioisotope heaters) is needed.`,
    'not-feasible': `Mean ${fmtC(t)} (below ${fmtC(difficultC)}, like permanently shadowed craters): equipment must be isolated from the environment.`,
  }[cls] + extremes
  return { id: 'temperature', name: 'Temperature', cls, value: `mean ${fmtC(t)}`, comment }
}

export function scoreRadiation(doseRateUGyH: number, hours: number, settings: AdvancedSettings = DEFAULT_ADVANCED_SETTINGS): CriterionResult {
  const total = doseRateUGyH * hours
  const { recommendedDoseUGy, feasibleDoseUGy, difficultDoseUGy } = settings.radiation
  const cls: ScoreClass = total < recommendedDoseUGy ? 'recommended'
    : total < feasibleDoseUGy ? 'feasible'
      : total < difficultDoseUGy ? 'difficult'
        : 'not-feasible'
  const comment = {
    recommended: `Total dose ${sci(total)} µGy over ${Math.round(hours / 24)} d, below ${sci(recommendedDoseUGy)} µGy.`,
    feasible: `Total dose ${sci(total)} µGy: between ${sci(recommendedDoseUGy)} and ${sci(feasibleDoseUGy)} µGy, radiation-tolerant parts needed.`,
    difficult: `Total dose ${sci(total)} µGy: between ${sci(feasibleDoseUGy)} and ${sci(difficultDoseUGy)} µGy, shielding and rad-hard design needed.`,
    'not-feasible': `Total dose ${sci(total)} µGy reaches or exceeds ${sci(difficultDoseUGy)} µGy.`,
  }[cls]
  return { id: 'radiation', name: 'Radiation', cls, value: `${doseRateUGyH.toFixed(1)} µGy/h`, comment }
}

export function scoreSlope(maxSlopeDeg: number, footprint: string, settings: AdvancedSettings = DEFAULT_ADVANCED_SETTINGS): CriterionResult {
  const { recommendedDeg, feasibleDeg, difficultDeg } = settings.slope
  const cls: ScoreClass = maxSlopeDeg <= recommendedDeg ? 'recommended'
    : maxSlopeDeg <= feasibleDeg ? 'feasible'
      : maxSlopeDeg <= difficultDeg ? 'difficult'
        : 'not-feasible'
  const comment = {
    recommended: `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: safe (0–${recommendedDeg}°).`,
    feasible: `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: intermediate (${recommendedDeg}–${feasibleDeg}°).`,
    difficult: `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: at the limit (${feasibleDeg}–${difficultDeg}°).`,
    'not-feasible': `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: above ${difficultDeg}°, landing not feasible.`,
  }[cls]
  return { id: 'slope', name: 'Slope', cls, value: `${maxSlopeDeg.toFixed(1)}°`, comment }
}

export function scoreTelecom(linkPct: number, longestGapH: number, settings: AdvancedSettings = DEFAULT_ADVANCED_SETTINGS): CriterionResult {
  const { recommendedPercent, feasiblePercent, difficultPercent } = settings.telecom
  const cls: ScoreClass = linkPct >= recommendedPercent ? 'recommended'
    : linkPct >= feasiblePercent ? 'feasible'
      : linkPct >= difficultPercent ? 'difficult'
        : 'not-feasible'
  const gap = longestGapH >= 48 ? `${(longestGapH / 24).toFixed(1)} d` : `${Math.round(longestGapH)} h`
  const comment = {
    recommended: `Direct link to the DSN ${Math.round(linkPct)}% of the time: near-continuous contact (≥ ${recommendedPercent}%).`,
    feasible: `Direct link ${Math.round(linkPct)}% of the time, longest gap ${gap}: store data between passes (${feasiblePercent}–${recommendedPercent}%).`,
    difficult: `Direct link only ${Math.round(linkPct)}% of the time, longest gap ${gap}: a relay satellite is advised (${difficultPercent}–${feasiblePercent}%).`,
    'not-feasible': `Direct link ${Math.round(linkPct)}% of the time, below ${difficultPercent}%: a relay satellite is required.`,
  }[cls]
  return { id: 'telecom', name: 'Telecommunications', cls, value: `${Math.round(linkPct)}% in link`, comment }
}

export function scoreSunlight(sunlitPct: number, settings: AdvancedSettings = DEFAULT_ADVANCED_SETTINGS): CriterionResult {
  const pct = Math.round(sunlitPct * 10) / 10
  const { recommendedPercent, feasiblePercent, difficultPercent } = settings.sunlight
  const cls: ScoreClass = pct >= recommendedPercent ? 'recommended'
    : pct >= feasiblePercent ? 'feasible'
      : pct >= difficultPercent ? 'difficult'
        : 'not-feasible'
  const comment = {
    recommended: `Sunlight is available for ${pct.toFixed(1)}% of the mission period, meeting the ≥ ${recommendedPercent}% target.`,
    feasible: `Sunlight is available for ${pct.toFixed(1)}% of the mission period, meeting the ≥ ${feasiblePercent}% target but below ${recommendedPercent}%.`,
    difficult: `Sunlight is available for ${pct.toFixed(1)}% of the mission period, meeting the ≥ ${difficultPercent}% target but below ${feasiblePercent}%.`,
    'not-feasible': pct <= 0
      ? 'No sunlight is available during the selected mission period.'
      : `Sunlight is available for ${pct.toFixed(1)}% of the mission period, below the ${difficultPercent}% minimum target.`,
  }[cls]
  return { id: 'sunlight', name: 'Sunlight', cls, value: `${pct.toFixed(1)}% of period`, comment }
}

const fmtDoseBand = (value: number) => value.toExponential(0).replace('e+', '·10^').replace('e', '·10^')

/** Current score boundaries, used by the info pop-ups beside each criterion. */
export function criteriaInfo(settings: AdvancedSettings): Record<CriterionResult['id'], { what: string; bands: [ScoreClass, string][] }> {
  const { temperature, radiation, slope, telecom, sunlight } = settings
  const t = (value: number) => `${value} °C`
  const dose = (value: number) => `${fmtDoseBand(value)} µGy`
  const angle = (value: number) => `${value}°`
  const percent = (value: number) => `${value}%`
  return {
    temperature: {
      what: 'Mean surface temperature over the period',
      bands: [['recommended', `≥ ${t(temperature.recommendedC)}`],
        ['feasible', `${t(temperature.feasibleC)} to ${t(temperature.recommendedC)}`],
        ['difficult', `${t(temperature.difficultC)} to ${t(temperature.feasibleC)}`],
        ['not-feasible', `< ${t(temperature.difficultC)}`]],
    },
    radiation: {
      what: 'Total dose over the period',
      bands: [['recommended', `< ${dose(radiation.recommendedDoseUGy)}`],
        ['feasible', `${dose(radiation.recommendedDoseUGy)} to ${dose(radiation.feasibleDoseUGy)}`],
        ['difficult', `${dose(radiation.feasibleDoseUGy)} to ${dose(radiation.difficultDoseUGy)}`],
        ['not-feasible', `≥ ${dose(radiation.difficultDoseUGy)}`]],
    },
    slope: {
      what: 'Max slope in the landing footprint',
      bands: [['recommended', `0 to ${angle(slope.recommendedDeg)}`],
        ['feasible', `${angle(slope.recommendedDeg)} to ${angle(slope.feasibleDeg)}`],
        ['difficult', `${angle(slope.feasibleDeg)} to ${angle(slope.difficultDeg)}`],
        ['not-feasible', `> ${angle(slope.difficultDeg)}`]],
    },
    telecom: {
      what: 'Time with at least one DSN station in direct link',
      bands: [['recommended', `≥ ${percent(telecom.recommendedPercent)}`],
        ['feasible', `${percent(telecom.feasiblePercent)} to ${percent(telecom.recommendedPercent)}`],
        ['difficult', `${percent(telecom.difficultPercent)} to ${percent(telecom.feasiblePercent)}`],
        ['not-feasible', `< ${percent(telecom.difficultPercent)}`]],
    },
    sunlight: {
      what: 'Percentage of the selected mission period with the Sun above the local terrain horizon',
      bands: [['recommended', `≥ ${percent(sunlight.recommendedPercent)}`],
        ['feasible', `${percent(sunlight.feasiblePercent)} to < ${percent(sunlight.recommendedPercent)}`],
        ['difficult', `${percent(sunlight.difficultPercent)} to < ${percent(sunlight.feasiblePercent)}`],
        ['not-feasible', `< ${percent(sunlight.difficultPercent)}`]],
    },
  }
}

export function combine(criteria: (CriterionResult | undefined)[], names: string[]): LandingScore {
  const ok = criteria.filter((c): c is CriterionResult => !!c)
  const missing = names.filter((_, i) => !criteria[i])
  const score = ok.length ? ok.reduce((s, c) => s + CLASS_INFO[c.cls].points, 0) / ok.length : 0
  return { criteria: ok, score, feasible: !ok.some((c) => c.cls === 'not-feasible'), missing }
}

export function scoreLandingCell(input: {
  tMeanC: number
  doseRateUGyH: number
  periodHours: number
  maxSlopeDeg: number
  linkPct: number
  longestLinkGapH: number
  sunlitPct: number
}, settings: AdvancedSettings = DEFAULT_ADVANCED_SETTINGS): number {
  const points = (cls: ScoreClass) => CLASS_INFO[cls].points
  const t = input.tMeanC
  const temperature: ScoreClass = t >= settings.temperature.recommendedC ? 'recommended'
    : t >= settings.temperature.feasibleC ? 'feasible'
      : t >= settings.temperature.difficultC ? 'difficult'
        : 'not-feasible'
  const totalDose = input.doseRateUGyH * input.periodHours
  const radiation: ScoreClass = totalDose < settings.radiation.recommendedDoseUGy ? 'recommended'
    : totalDose < settings.radiation.feasibleDoseUGy ? 'feasible'
      : totalDose < settings.radiation.difficultDoseUGy ? 'difficult'
        : 'not-feasible'
  const slope: ScoreClass = input.maxSlopeDeg <= settings.slope.recommendedDeg ? 'recommended'
    : input.maxSlopeDeg <= settings.slope.feasibleDeg ? 'feasible'
      : input.maxSlopeDeg <= settings.slope.difficultDeg ? 'difficult'
        : 'not-feasible'
  const telecom: ScoreClass = input.linkPct >= settings.telecom.recommendedPercent ? 'recommended'
    : input.linkPct >= settings.telecom.feasiblePercent ? 'feasible'
      : input.linkPct >= settings.telecom.difficultPercent ? 'difficult'
        : 'not-feasible'
  const sunlightPct = Math.round(input.sunlitPct * 10) / 10
  const sunlight: ScoreClass = sunlightPct >= settings.sunlight.recommendedPercent ? 'recommended'
    : sunlightPct >= settings.sunlight.feasiblePercent ? 'feasible'
      : sunlightPct >= settings.sunlight.difficultPercent ? 'difficult'
        : 'not-feasible'
  return (points(temperature) + points(radiation) + points(slope) + points(telecom) + points(sunlight)) / 5
}
