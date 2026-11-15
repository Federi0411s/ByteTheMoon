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
 *  - sunlight (PROPOSED: longest stretch with the Sun below the terrain horizon, i.e. the night batteries /
 *    heaters must survive; independent of the solar arrays):
 *      Recommended ≤ 3 d · Feasible 3–7 d · Difficult 7–20 d (a full lunar night: ~14.8 d on flat ground,
 *      up to ~16 d with terrain shadows at sunrise / sunset) · Not feasible > 20 d (darker than any lunar
 *      night, e.g. seasonal polar shadow) or no sunlight at all
 */

export type ScoreClass = 'recommended' | 'feasible' | 'difficult' | 'not-feasible'

export const CLASS_INFO: Record<ScoreClass, { label: string; points: number; color: string }> = {
  recommended: { label: 'Recommended', points: 100, color: '#3ddc84' },
  feasible: { label: 'Feasible', points: 70, color: '#c6e24a' },
  difficult: { label: 'Difficult', points: 40, color: '#ffa23f' },
  'not-feasible': { label: 'Not feasible', points: 0, color: '#ff5b5b' },
}

/** Short explanation of each criterion and its four bands, for the info pop-up next to the bars. */
export const CRITERIA_INFO: Record<CriterionResult['id'], { what: string; bands: [ScoreClass, string][] }> = {
  temperature: {
    what: 'Mean surface temperature over the period',
    bands: [['recommended', '≥ −80 °C'], ['feasible', '−80 – −130 °C'], ['difficult', '−130 – −180 °C'], ['not-feasible', '< −180 °C']],
  },
  radiation: {
    what: 'Total dose over the period',
    bands: [['recommended', '< 3·10⁸ µGy'], ['feasible', '3·10⁸ – 10⁹ µGy'], ['difficult', '10⁹ – 10¹⁰ µGy'], ['not-feasible', '> 10¹⁰ µGy']],
  },
  slope: {
    what: 'Max slope in the landing footprint',
    bands: [['recommended', '0 – 5°'], ['feasible', '5 – 8°'], ['difficult', '8 – 10°'], ['not-feasible', '> 10°']],
  },
  telecom: {
    what: 'Time with at least one DSN station in direct link',
    bands: [['recommended', '≥ 80%'], ['feasible', '40 – 80%'], ['difficult', '10 – 40%'], ['not-feasible', '< 10%']],
  },
  sunlight: {
    what: 'Longest stretch without sunlight (Sun below the terrain horizon)',
    bands: [['recommended', '≤ 3 days'], ['feasible', '3 – 7 days'], ['difficult', '7 – 20 days'], ['not-feasible', '> 20 days or none']],
  },
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
export const TEMP_BANDS_C = { recommended: -80, feasible: -130, difficult: -180 }

export function scoreTemperature(tMeanC: number, tMinC: number, tMaxC: number): CriterionResult {
  const t = tMeanC
  const cls: ScoreClass =
    t >= TEMP_BANDS_C.recommended ? 'recommended'
      : t >= TEMP_BANDS_C.feasible ? 'feasible'
        : t >= TEMP_BANDS_C.difficult ? 'difficult'
          : 'not-feasible'
  const extremes = ` Bare-soil extremes ${fmtC(tMinC)} – ${fmtC(tMaxC)}.`
  const comment = {
    recommended: `Mean ${fmtC(t)} (≥ −80 °C): among the mildest places on the Moon, standard insulation and heaters.`,
    feasible: `Mean ${fmtC(t)} (−80…−130 °C): cold site, more heater power and insulation needed.`,
    difficult: `Mean ${fmtC(t)} (−130…−180 °C): very cold, a dedicated thermal design (e.g. radioisotope heaters) is needed.`,
    'not-feasible': `Mean ${fmtC(t)} (below −180 °C, like permanently shadowed craters): equipment must be isolated from the environment.`,
  }[cls] + extremes
  return { id: 'temperature', name: 'Temperature', cls, value: `mean ${fmtC(t)}`, comment }
}

export function scoreRadiation(doseRateUGyH: number, hours: number): CriterionResult {
  const total = doseRateUGyH * hours
  const cls: ScoreClass = total < 3e8 ? 'recommended' : total < 1e9 ? 'feasible' : total < 1e10 ? 'difficult' : 'not-feasible'
  const comment = {
    recommended: `Total dose ${sci(total)} µGy over ${Math.round(hours / 24)} d, below 3·10^8 µGy.`,
    feasible: `Total dose ${sci(total)} µGy: between 3·10^8 and 10^9 µGy, radiation-tolerant parts needed.`,
    difficult: `Total dose ${sci(total)} µGy: between 10^9 and 10^10 µGy, shielding and rad-hard design needed.`,
    'not-feasible': `Total dose ${sci(total)} µGy exceeds 10^10 µGy.`,
  }[cls]
  return { id: 'radiation', name: 'Radiation', cls, value: `${doseRateUGyH.toFixed(1)} µGy/h`, comment }
}

export function scoreSlope(maxSlopeDeg: number, footprint: string): CriterionResult {
  const cls: ScoreClass = maxSlopeDeg <= 5 ? 'recommended' : maxSlopeDeg <= 8 ? 'feasible' : maxSlopeDeg <= 10 ? 'difficult' : 'not-feasible'
  const comment = {
    recommended: `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: safe (0–5°).`,
    feasible: `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: intermediate (5–8°).`,
    difficult: `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: at the limit (8–10°).`,
    'not-feasible': `Max slope ${maxSlopeDeg.toFixed(1)}° in the ${footprint}: above 10°, landing not feasible.`,
  }[cls]
  return { id: 'slope', name: 'Slope', cls, value: `${maxSlopeDeg.toFixed(1)}°`, comment }
}

export function scoreTelecom(linkPct: number, longestGapH: number): CriterionResult {
  const cls: ScoreClass = linkPct >= 80 ? 'recommended' : linkPct >= 40 ? 'feasible' : linkPct >= 10 ? 'difficult' : 'not-feasible'
  const gap = longestGapH >= 48 ? `${(longestGapH / 24).toFixed(1)} d` : `${Math.round(longestGapH)} h`
  const comment = {
    recommended: `Direct link to the DSN ${Math.round(linkPct)}% of the time: near-continuous contact.`,
    feasible: `Direct link ${Math.round(linkPct)}% of the time, longest gap ${gap}: store data between passes.`,
    difficult: `Direct link only ${Math.round(linkPct)}% of the time, longest gap ${gap}: a relay satellite is advised.`,
    'not-feasible': `Direct link ${Math.round(linkPct)}% of the time: a relay satellite is required.`,
  }[cls]
  return { id: 'telecom', name: 'Telecommunications', cls, value: `${Math.round(linkPct)}% in link`, comment }
}

export function scoreSunlight(longestDarkH: number, sunlitPct: number): CriterionResult {
  const d = longestDarkH / 24
  const cls: ScoreClass = sunlitPct <= 0 ? 'not-feasible' : d <= 3 ? 'recommended' : d <= 7 ? 'feasible' : d <= 20 ? 'difficult' : 'not-feasible'
  const comment = {
    recommended: `Sunlit ${Math.round(sunlitPct)}% of the time, longest night ${d.toFixed(1)} d: small batteries suffice.`,
    feasible: `Longest night ${d.toFixed(1)} d: batteries must bridge several days.`,
    difficult: `Longest night ${d.toFixed(1)} d (a lunar night): large batteries or a heat source needed.`,
    'not-feasible': sunlitPct <= 0
      ? 'No sunlight at all in the period.'
      : `Longest night ${d.toFixed(1)} d, longer than a lunar night: solar power alone is not enough.`,
  }[cls]
  return { id: 'sunlight', name: 'Sunlight', cls, value: `${Math.round(sunlitPct)}% sunlit`, comment }
}

export function combine(criteria: (CriterionResult | undefined)[], names: string[]): LandingScore {
  const ok = criteria.filter((c): c is CriterionResult => !!c)
  const missing = names.filter((_, i) => !criteria[i])
  const score = ok.length ? ok.reduce((s, c) => s + CLASS_INFO[c.cls].points, 0) / ok.length : 0
  return { criteria: ok, score, feasible: !ok.some((c) => c.cls === 'not-feasible'), missing }
}
