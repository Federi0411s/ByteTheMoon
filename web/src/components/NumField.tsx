import { useState } from 'react'

/**
 * Free-text number box: no spinner arrows, nothing is corrected while typing. The value is applied as
 * soon as the text is a valid number in [min, max] ("," or "." as decimal separator); otherwise the box
 * turns red and the last valid value stays in use. On leaving the box the text snaps back to that value.
 */
export function NumField({ label, unit, value, min, max, onChange }: {
  label: string; unit?: string; value: number; min: number; max: number; onChange: (v: number) => void
}) {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const parsed = Number(text.replace(',', '.').trim())
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max
  return (
    <label className="num-field">
      <span>{label}</span>
      <input type="text" inputMode="decimal" value={editing ? text : String(value)} className={editing && !valid ? 'invalid' : ''}
        title={`${min} – ${max}`}
        onFocus={() => { setText(String(value)); setEditing(true) }}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value.replace(',', '.').trim())
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(n)
        }} />
      <span className="muted">{unit}</span>
    </label>
  )
}
