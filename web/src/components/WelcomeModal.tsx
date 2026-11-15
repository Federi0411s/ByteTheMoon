import { useEffect, useRef, useState } from 'react'
import { WELCOME } from '../content/insights'
import { setWelcomeHidden, welcomeHidden } from '../lib/welcomeStorage'

export function WelcomeModal({ onStartTutorial, onLearnBasics, onClose }: {
  onStartTutorial: () => void
  onLearnBasics: () => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [hidden, setHidden] = useState(welcomeHidden)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])

  return (
    <dialog ref={dialogRef} className="report-dialog insights-dialog" aria-labelledby="welcome-title"
      onCancel={(e) => { e.preventDefault(); onClose() }}>
      <div className="insights-welcome">
        <h2 id="welcome-title">{WELCOME.title}</h2>
        <p>{WELCOME.text}</p>
        <div className="insights-actions">
          <button type="button" className="report-primary" onClick={onStartTutorial}>{WELCOME.startTutorial}</button>
          <button type="button" onClick={onLearnBasics}>{WELCOME.learnBasics}</button>
          <button type="button" onClick={onClose}>{WELCOME.skip}</button>
        </div>
        <label className="insights-check">
          <input type="checkbox" checked={hidden}
            onChange={(e) => { setHidden(e.target.checked); setWelcomeHidden(e.target.checked) }} />
          {WELCOME.doNotShowAgain}
        </label>
      </div>
    </dialog>
  )
}
