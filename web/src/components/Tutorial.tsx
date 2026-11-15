import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TUTORIAL } from '../content/insights'

const GAP = 14 // px between the highlighted element and the card
const MARGIN = 12 // px from the window edges

interface Box { top: number; left: number; width: number; height: number }

function sameBox(a: Box | null, b: Box | null) {
  return a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)
}

/** Where the card goes: beside the target where there is room, else above / below it, else centred. */
function cardPosition(target: Box | null, card: { width: number; height: number }) {
  const vw = window.innerWidth, vh = window.innerHeight
  const clampX = (x: number) => Math.min(Math.max(x, MARGIN), vw - card.width - MARGIN)
  const clampY = (y: number) => Math.min(Math.max(y, MARGIN), vh - card.height - MARGIN)
  if (!target) return { left: (vw - card.width) / 2, top: (vh - card.height) / 2 }
  const right = target.left + target.width
  if (target.left - GAP - card.width >= MARGIN) return { left: target.left - GAP - card.width, top: clampY(target.top) }
  if (right + GAP + card.width <= vw - MARGIN) return { left: right + GAP, top: clampY(target.top) }
  const x = clampX(target.left + target.width / 2 - card.width / 2)
  if (target.top - GAP - card.height >= MARGIN) return { left: x, top: target.top - GAP - card.height }
  return { left: x, top: clampY(target.top + target.height + GAP) }
}

/** Step-by-step tour: highlights the element each step talks about and shows a card next to it. */
export function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const [target, setTarget] = useState<Box | null>(null)
  const [cardSize, setCardSize] = useState({ width: 340, height: 200 })
  const cardRef = useRef<HTMLDivElement>(null)
  const steps = TUTORIAL.steps
  const current = steps[step]
  const last = step === steps.length - 1

  // bring the target into view when the step changes (side panels scroll)
  useEffect(() => {
    const el = current.target ? document.querySelector(current.target) : null
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [current.target])

  // follow the target while it moves (panel scrolling, window resize, element appearing after load)
  useEffect(() => {
    let frame = 0
    const track = () => {
      const el = current.target ? document.querySelector(current.target) : null
      const r = el?.getBoundingClientRect()
      const box = r && r.width > 0 && r.height > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null
      setTarget((prev) => (sameBox(prev, box) ? prev : box))
      frame = requestAnimationFrame(track)
    }
    track()
    return () => cancelAnimationFrame(frame)
  }, [current.target])

  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const size = { width: el.offsetWidth, height: el.offsetHeight }
    setCardSize((prev) => (prev.width === size.width && prev.height === size.height ? prev : size))
  }, [step])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, steps.length - 1))
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, steps.length])

  const pos = cardPosition(target, cardSize)
  const pad = 6
  return (
    <div className="tutorial-layer">
      {target ? (
        <div className="tutorial-highlight" aria-hidden="true" style={{
          top: target.top - pad, left: target.left - pad, width: target.width + 2 * pad, height: target.height + 2 * pad,
        }} />
      ) : (
        <div className="tutorial-dim" aria-hidden="true" />
      )}
      <div ref={cardRef} className="panel tutorial-card" role="dialog" aria-labelledby="tutorial-title"
        style={{ top: pos.top, left: pos.left }}>
        <div className="tutorial-card-head">
          <h2 id="tutorial-title">{current.title}</h2>
          <span className="menu-section-state" aria-label={`Step ${step + 1} of ${steps.length}`}>{step + 1} / {steps.length}</span>
        </div>
        <p>{current.body}</p>
        <div className="insights-actions">
          <button type="button" onClick={onClose}>{TUTORIAL.close}</button>
          <span className="insights-spacer" />
          <button type="button" onClick={() => setStep(step - 1)} disabled={step === 0}>{TUTORIAL.back}</button>
          <button type="button" className="report-primary" onClick={() => (last ? onClose() : setStep(step + 1))}>
            {last ? TUTORIAL.finish : TUTORIAL.next}
          </button>
        </div>
      </div>
    </div>
  )
}
