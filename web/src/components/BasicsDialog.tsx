import { useEffect, useRef } from 'react'
import { BASICS } from '../content/insights'

/** "Learn the basics": short explanations for non-experts, as accordion sections. */
export function BasicsDialog({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])

  return (
    <dialog ref={dialogRef} className="report-dialog insights-dialog" aria-labelledby="basics-title"
      onCancel={(e) => { e.preventDefault(); onClose() }}>
      <div className="report-dialog-header">
        <h2 id="basics-title">{BASICS.title}</h2>
        <button type="button" onClick={onClose} aria-label={BASICS.close}>×</button>
      </div>
      <div className="report-dialog-body insights-basics">
        {BASICS.sections.map((s, i) => (
          <details key={s.question} className="menu-section" open={i === 0}>
            <summary className="menu-section-summary">
              <span>{s.question}</span>
              <span className="menu-section-chevron" aria-hidden="true">›</span>
            </summary>
            <p className="insights-answer">{s.answer}</p>
          </details>
        ))}
      </div>
      <div className="report-dialog-footer">
        <button type="button" onClick={onBack}>{BASICS.back}</button>
        <button type="button" className="report-primary" onClick={onClose}>{BASICS.close}</button>
      </div>
    </dialog>
  )
}
