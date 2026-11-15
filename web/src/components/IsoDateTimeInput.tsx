import { useEffect, useRef, useState } from 'react'
import { fmtDate, fmtDateTime, ISO_PLACEHOLDER, parseIso } from '../lib/time'

/**
 * Text field for a UTC instant in ISO 8601 (CCYY-MM-DDTHH:MM:SS), independent of the OS locale.
 * Accepts CCYY-MM-DD, CCYY-MM-DDTHH:MM, CCYY-MM-DDTHH:MM:SS and CCYY-MM-DDTHH:MM:SS.sss.
 * Commits on Enter or when the field loses focus; Escape reverts. Out-of-range values are clamped.
 */
export function IsoDateTimeInput({
  value,
  onChange,
  min,
  max,
  allowEmpty = false,
  showCalendar = false,
  disabled,
  ariaLabel,
}: {
  value?: number
  onChange: (ms: number | undefined) => void
  min?: number
  max?: number
  allowEmpty?: boolean
  showCalendar?: boolean
  disabled?: boolean
  ariaLabel: string
}) {
  const shown = value === undefined ? '' : fmtDateTime(value)
  const [draft, setDraft] = useState(shown)
  const [focused, setFocused] = useState(false)
  const cancelled = useRef(false) // Escape: the following blur must not commit the draft
  const datePicker = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!focused) setDraft(shown) }, [shown, focused])

  const parsed = draft.trim() === '' ? undefined : parseIso(draft)
  const invalid = draft.trim() === '' ? !allowEmpty : parsed === undefined

  const commit = () => {
    if (draft.trim() === '') {
      if (allowEmpty) onChange(undefined)
      else setDraft(shown)
      return
    }
    if (parsed === undefined) return // keep the draft so it can be fixed
    let v = parsed
    if (min !== undefined) v = Math.max(v, min)
    if (max !== undefined) v = Math.min(v, max)
    onChange(v)
    setDraft(fmtDateTime(v))
  }

  const chooseDate = (date: string) => {
    const midnight = parseIso(date)
    if (midnight === undefined) return
    const current = value === undefined ? undefined : new Date(value)
    let next = midnight + (current
      ? current.getUTCHours() * 3_600_000 + current.getUTCMinutes() * 60_000 + current.getUTCSeconds() * 1_000 + current.getUTCMilliseconds()
      : 0)
    if (min !== undefined) next = Math.max(next, min)
    if (max !== undefined) next = Math.min(next, max)
    onChange(next)
    setDraft(fmtDateTime(next))
  }

  const range = min !== undefined && max !== undefined ? ` (${fmtDate(min)} to ${fmtDate(max)})` : ''
  return (
    <span className={showCalendar ? 'iso-input-control iso-input-with-calendar' : 'iso-input-control'}>
      <input
        type="text"
        className={`iso-input${invalid && focused ? ' invalid' : ''}`}
        style={{ width: draft ? `${Math.max(draft.length, 19) + 2.5}ch` : "24.5ch" }} // fits the value or the (wider, uppercase) placeholder
        value={draft}
        placeholder={ISO_PLACEHOLDER}
        spellCheck={false}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid && focused}
        title={`UTC, format ${ISO_PLACEHOLDER} (also YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS.sss)${range}. Press Enter to apply.`}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); if (cancelled.current) cancelled.current = false; else commit() }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur() }
          if (e.key === 'Escape') { cancelled.current = true; setDraft(shown); (e.target as HTMLInputElement).blur() }
        }}
      />
      {showCalendar && (
        <>
          <button
            type="button"
            className="iso-calendar-button"
            aria-label={`Choose ${ariaLabel} date from calendar`}
            title="Choose date from calendar"
            disabled={disabled}
            onClick={() => {
              const picker = datePicker.current
              if (!picker) return
              if (picker.showPicker) picker.showPicker()
              else picker.click()
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="4" width="15" height="13" rx="2" />
              <path d="M6 2.5v3M14 2.5v3M2.5 8h15" />
            </svg>
          </button>
          <input
            ref={datePicker}
            className="iso-date-picker"
            type="date"
            value={value === undefined ? '' : fmtDate(value)}
            min={min === undefined ? undefined : fmtDate(min)}
            max={max === undefined ? undefined : fmtDate(max)}
            aria-hidden="true"
            tabIndex={-1}
            disabled={disabled}
            onChange={(event) => chooseDate(event.target.value)}
          />
        </>
      )}
    </span>
  )
}
