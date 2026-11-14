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
  disabled,
  ariaLabel,
}: {
  value?: number
  onChange: (ms: number | undefined) => void
  min?: number
  max?: number
  allowEmpty?: boolean
  disabled?: boolean
  ariaLabel: string
}) {
  const shown = value === undefined ? '' : fmtDateTime(value)
  const [draft, setDraft] = useState(shown)
  const [focused, setFocused] = useState(false)
  const cancelled = useRef(false) // Escape: the following blur must not commit the draft
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

  const range = min !== undefined && max !== undefined ? ` (${fmtDate(min)} to ${fmtDate(max)})` : ''
  return (
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
  )
}
