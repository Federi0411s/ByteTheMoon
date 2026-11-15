import { CLASS_INFO, criteriaInfo, type CriterionResult, type LandingScore } from '../lib/landingScore'
import { DAYLIGHT_TIP, type HumanAssessment, type HumanStatus } from '../lib/human'
import type { AdvancedSettings } from '../lib/advancedSettings'

const HUMAN_COLOR: Record<HumanStatus, string> = { ok: '#3ddc84', limited: '#ffa23f', no: '#ff5b5b' }
const HUMAN_MARK: Record<HumanStatus, string> = { ok: '✓', limited: '!', no: '✕' }

/** Stylised astronaut in a suit (helmet with visor, backpack, arms, legs). */
function Astronaut() {
  return (
    <svg className="astronaut" viewBox="0 0 64 80" aria-hidden="true">
      <rect x="14" y="26" width="10" height="24" rx="3" className="suit-dark" />{/* life-support backpack */}
      <circle cx="34" cy="16" r="12" className="suit" />{/* helmet */}
      <path d="M26 15 a8 7 0 0 1 16 0 v2 a8 6 0 0 1 -16 0 z" className="visor" />
      <rect x="22" y="28" width="24" height="26" rx="7" className="suit" />{/* torso */}
      <rect x="29" y="34" width="10" height="6" rx="1.5" className="suit-dark" />{/* chest controls */}
      <path d="M45 31 q9 4 8 15" className="limb" />{/* arm raised */}
      <path d="M23 32 q-6 8 -4 16" className="limb" />
      <path d="M28 53 l-2 17" className="limb" />{/* legs */}
      <path d="M40 53 l3 17" className="limb" />
      <rect x="21" y="68" width="9" height="5" rx="2" className="suit-dark" />{/* boots */}
      <rect x="40" y="68" width="9" height="5" rx="2" className="suit-dark" />
    </svg>
  )
}

function HumanSection({ human, settings }: { human: HumanAssessment; settings: AdvancedSettings }) {
  const row = (label: string, r: HumanAssessment['temp'], tip: string) => (
    <div className="human-item tip" data-tip={tip} tabIndex={0}>
      <span>{label} <span className="tip-mark">ⓘ</span></span>
      <span style={{ color: HUMAN_COLOR[r.status] }}>{r.value} · {r.note}</span>
    </div>
  )
  return (
    <div className="human">
      <div className="human-head">
        <Astronaut />
        <div>
          <h4>Walks outside (EVA)</h4>
          <b style={{ color: HUMAN_COLOR[human.walks] }}>{HUMAN_MARK[human.walks]} {human.verdict}</b>
          <p className="muted">Artemis III suit · in daylight · within 2 km of the lander</p>
        </div>
      </div>
      <div className="power-now walk-duration tip"
        data-tip={`Longest sunlit stretch within ${settings.eva.minimumTemperatureC}…${settings.eva.maximumTemperatureC} °C, up to ${settings.eva.maximumWalkHours} h; cold-only excursions up to ${settings.eva.coldWalkHours} h, further limited by the ${settings.eva.dailyDoseLimitMsv} mSv/day budget.`}
        tabIndex={0}>
        <span>Walk duration <span className="tip-mark">ⓘ</span></span>
        <b style={{ color: HUMAN_COLOR[human.walk.status] }}>{human.walk.value}</b>
      </div>
      <p className="walk-note" style={{ color: HUMAN_COLOR[human.walk.status] }}>{human.walk.note}</p>
      {row('Daylight', human.daylight, DAYLIGHT_TIP)}
      {row('Temperature', human.temp, `Suit operating range: ${settings.eva.minimumTemperatureC}…${settings.eva.maximumTemperatureC} °C.`)}
      {row('Radiation', human.rad, `Career limit: ${settings.eva.careerDoseLimitMsv} mSv.`)}
    </div>
  )
}

/** ⓘ with a small pop-up: what the criterion measures and its four bands with coloured dots. */
function CriterionInfo({ id, settings }: { id: CriterionResult['id']; settings: AdvancedSettings }) {
  const { what, bands } = criteriaInfo(settings)[id]
  return (
    <span className="info" tabIndex={0} aria-label={`${what}: ${bands.map(([c, t]) => `${CLASS_INFO[c].label} ${t}`).join(', ')}`}>
      <span className="tip-mark">ⓘ</span>
      <span className="info-box" role="tooltip">
        <span className="info-what">{what}</span>
        {bands.map(([cls, text]) => (
          <span key={cls} className="info-band">
            <i className="info-dot" style={{ background: CLASS_INFO[cls].color }} />
            <span>{CLASS_INFO[cls].label}</span>
            <b>{text}</b>
          </span>
        ))}
      </span>
    </span>
  )
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Landing score: one coloured bar per criterion, the human EVA check, the overall score, then the comments. */
export function ScorePanel({
  result,
  period,
  periodLabel,
  human,
  settings,
}: {
  result: LandingScore
  period: [number, number]
  periodLabel: string
  human?: HumanAssessment
  settings: AdvancedSettings
}) {
  const { criteria, score, feasible, missing } = result
  const overallColor = !feasible ? CLASS_INFO['not-feasible'].color : score >= 85 ? CLASS_INFO.recommended.color : score >= 60 ? CLASS_INFO.feasible.color : CLASS_INFO.difficult.color
  const periodText = periodLabel === 'landing day' ? day(period[0]) : `${day(period[0])} → ${day(period[1])}`
  return (
    <div className="dsn">
      <h3>Landing score</h3>
      <p className="muted">
        Over the {periodLabel}: {periodText}.
        Recommended 100 · Feasible 70 · Difficult 40 · Not feasible 0 points; the score is the mean.
      </p>
      {criteria.map((c) => {
        const info = CLASS_INFO[c.cls]
        return (
          <div key={c.id} className="score-row">
            <div className="score-head"><span>{c.name} <CriterionInfo id={c.id} settings={settings} /></span><span style={{ color: info.color }}>{info.label}</span></div>
            <div className="score-track"><div className="score-fill" style={{ width: `${Math.max(info.points, 3)}%`, background: info.color }} /></div>
          </div>
        )
      })}
      {missing.length > 0 && <p className="muted">Computing: {missing.join(', ')}…</p>}
      {human && <HumanSection human={human} settings={settings} />}
      {criteria.length > 0 && (
        <>
          <div className="power-now" style={{ marginTop: 10 }}>
            <span>Overall score</span>
            <b style={{ color: overallColor }}>{Math.round(score)} / 100</b>
          </div>
          <p className={feasible ? 'score-verdict ok' : 'score-verdict no'}>
            {feasible ? '✓ Mission feasible' : `✕ Mission not feasible: ${criteria.filter((c) => c.cls === 'not-feasible').map((c) => c.name.toLowerCase()).join(', ')} beyond the critical limit.`}
          </p>
          <ul className="score-comments">
            {criteria.map((c) => (
              <li key={c.id}><b style={{ color: CLASS_INFO[c.cls].color }}>{c.name}</b> ({c.value}): {c.comment}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
