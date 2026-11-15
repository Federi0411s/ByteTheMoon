import { useEffect, useState } from 'react'
import {
  copyAdvancedSettings,
  DEFAULT_ADVANCED_SETTINGS,
  validateAdvancedSettings,
  type AdvancedSettings,
} from '../lib/advancedSettings'
import { DEFAULT_FOOTPRINT, type Footprint } from '../lib/requirements'
import { FootprintEditor } from './FootprintEditor'

function NumberField({
  label,
  value,
  unit,
  onChange,
}: {
  label: string
  value: number
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <label className="advanced-field">
      <span>{label}</span>
      <span className="advanced-field-input">
        <input type="number" step="any" value={Number.isFinite(value) ? value : ''}
          onChange={(event) => onChange(event.target.value === '' ? NaN : Number(event.target.value))} />
        <span>{unit}</span>
      </span>
    </label>
  )
}

export function SettingsDialog({
  settings,
  footprint,
  onSave,
  onCancel,
}: {
  settings: AdvancedSettings
  footprint: Footprint
  onSave: (settings: AdvancedSettings, footprint: Footprint) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(() => copyAdvancedSettings(settings))
  const [draftFootprint, setDraftFootprint] = useState(() => ({ ...footprint }))
  const errors = validateAdvancedSettings(draft)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  function updateSection<K extends keyof AdvancedSettings>(section: K, key: keyof AdvancedSettings[K], value: number) {
    setDraft((current) => ({
      ...current,
      [section]: { ...current[section], [key]: value },
    }))
  }

  return (
    <div className="settings-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <section className="settings-dialog panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="advanced-header">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p className="muted">Set the landing footprint and adjust optional scoring and crew limits.</p>
          </div>
          <button type="button" className="advanced-close" onClick={onCancel} aria-label="Close without saving">×</button>
        </header>

        <div className="advanced-content">
          <fieldset className="advanced-section">
            <legend>Landing footprint</legend>
            <FootprintEditor fp={draftFootprint} onChange={setDraftFootprint} radioName="settings-footprint-shape" />
          </fieldset>

          <details className="settings-advanced">
            <summary>Advanced settings</summary>
            <div className="settings-advanced-content">
              <fieldset className="advanced-section">
                <legend>Landing suitability score</legend>
                <p className="muted">Class boundaries are applied from recommended through feasible and difficult.</p>
                <div className="advanced-criteria-grid">
                  <div className="advanced-criterion-group">
                    <h3>Mean surface temperature</h3>
                    <NumberField label="Recommended at or above" value={draft.temperature.recommendedC} unit="°C"
                      onChange={(value) => updateSection('temperature', 'recommendedC', value)} />
                    <NumberField label="Feasible at or above" value={draft.temperature.feasibleC} unit="°C"
                      onChange={(value) => updateSection('temperature', 'feasibleC', value)} />
                    <NumberField label="Difficult at or above" value={draft.temperature.difficultC} unit="°C"
                      onChange={(value) => updateSection('temperature', 'difficultC', value)} />
                  </div>
                  <div className="advanced-criterion-group">
                    <h3>Total mission radiation dose</h3>
                    <NumberField label="Recommended below" value={draft.radiation.recommendedDoseUGy} unit="µGy"
                      onChange={(value) => updateSection('radiation', 'recommendedDoseUGy', value)} />
                    <NumberField label="Feasible below" value={draft.radiation.feasibleDoseUGy} unit="µGy"
                      onChange={(value) => updateSection('radiation', 'feasibleDoseUGy', value)} />
                    <NumberField label="Difficult below" value={draft.radiation.difficultDoseUGy} unit="µGy"
                      onChange={(value) => updateSection('radiation', 'difficultDoseUGy', value)} />
                  </div>
                  <div className="advanced-criterion-group">
                    <h3>Maximum landing slope</h3>
                    <NumberField label="Recommended" value={draft.slope.recommendedDeg} unit="°"
                      onChange={(value) => updateSection('slope', 'recommendedDeg', value)} />
                    <NumberField label="Feasible" value={draft.slope.feasibleDeg} unit="°"
                      onChange={(value) => updateSection('slope', 'feasibleDeg', value)} />
                    <NumberField label="Difficult" value={draft.slope.difficultDeg} unit="°"
                      onChange={(value) => updateSection('slope', 'difficultDeg', value)} />
                  </div>
                  <div className="advanced-criterion-group">
                    <h3>DSN contact time</h3>
                    <NumberField label="Recommended at or above" value={draft.telecom.recommendedPercent} unit="%"
                      onChange={(value) => updateSection('telecom', 'recommendedPercent', value)} />
                    <NumberField label="Feasible at or above" value={draft.telecom.feasiblePercent} unit="%"
                      onChange={(value) => updateSection('telecom', 'feasiblePercent', value)} />
                    <NumberField label="Difficult at or above" value={draft.telecom.difficultPercent} unit="%"
                      onChange={(value) => updateSection('telecom', 'difficultPercent', value)} />
                  </div>
                  <div className="advanced-criterion-group">
                    <h3>Sunlight</h3>
                    <NumberField label="Recommended at or above" value={draft.sunlight.recommendedPercent} unit="%"
                      onChange={(value) => updateSection('sunlight', 'recommendedPercent', value)} />
                    <NumberField label="Feasible at or above" value={draft.sunlight.feasiblePercent} unit="%"
                      onChange={(value) => updateSection('sunlight', 'feasiblePercent', value)} />
                    <NumberField label="Difficult at or above" value={draft.sunlight.difficultPercent} unit="%"
                      onChange={(value) => updateSection('sunlight', 'difficultPercent', value)} />
                  </div>
                </div>
              </fieldset>

              <fieldset className="advanced-section">
                <legend>Crew and EVA limits</legend>
                <div className="advanced-grid">
                  <NumberField label="Minimum suit operating temperature" value={draft.eva.minimumTemperatureC} unit="°C"
                    onChange={(value) => updateSection('eva', 'minimumTemperatureC', value)} />
                  <NumberField label="Maximum suit operating temperature" value={draft.eva.maximumTemperatureC} unit="°C"
                    onChange={(value) => updateSection('eva', 'maximumTemperatureC', value)} />
                  <NumberField label="Maximum EVA duration" value={draft.eva.maximumWalkHours} unit="hours"
                    onChange={(value) => updateSection('eva', 'maximumWalkHours', value)} />
                  <NumberField label="Cold-only excursion duration" value={draft.eva.coldWalkHours} unit="hours"
                    onChange={(value) => updateSection('eva', 'coldWalkHours', value)} />
                  <NumberField label="Daily radiation dose budget" value={draft.eva.dailyDoseLimitMsv} unit="mSv/day"
                    onChange={(value) => updateSection('eva', 'dailyDoseLimitMsv', value)} />
                  <NumberField label="Career radiation dose limit" value={draft.eva.careerDoseLimitMsv} unit="mSv"
                    onChange={(value) => updateSection('eva', 'careerDoseLimitMsv', value)} />
                  <NumberField label="Reference crew stay without mission dates" value={draft.eva.referenceStayDays} unit="days"
                    onChange={(value) => updateSection('eva', 'referenceStayDays', value)} />
                </div>
              </fieldset>

              {errors.length > 0 && (
                <ul className="advanced-errors" role="alert">
                  {errors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              )}
            </div>
          </details>
          {errors.length > 0 && <p className="settings-validation-hint" role="status">Open Advanced settings to review the validation errors.</p>}
          <p className="muted advanced-note">Changes apply only for this app session. Reloading restores the values defined in the code.</p>
        </div>

        <footer className="advanced-footer">
          <button type="button" onClick={() => { setDraft(copyAdvancedSettings(DEFAULT_ADVANCED_SETTINGS)); setDraftFootprint({ ...DEFAULT_FOOTPRINT }) }}>Reset to default</button>
          <span className="advanced-spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="advanced-save" disabled={errors.length > 0}
            onClick={() => onSave(copyAdvancedSettings(draft), { ...draftFootprint })}>Save settings</button>
        </footer>
      </section>
    </div>
  )
}
