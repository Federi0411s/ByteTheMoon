import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { INFO, type InfoTopic } from '../content/insights'

const WIDTH = 270 // px, pop-up width
const GAP = 8 // px between the icon and the pop-up
const MARGIN = 8 // px from the window edges

/**
 * Small "i" icon next to a control: hover or focus it to read a short explanation, click to keep it
 * open. The pop-up is rendered in <body> so the scrolling, blurred side panels cannot clip it.
 */
export function InfoTip({ topic }: { topic: InfoTopic }) {
  const { question, answer } = INFO[topic]
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const open = hover || pinned

  // beside the icon, on the side with more room (left for the right panel, right for the left one)
  useLayoutEffect(() => {
    const b = buttonRef.current?.getBoundingClientRect()
    if (!open || !b) return
    const height = popRef.current?.offsetHeight ?? 120
    const vw = window.innerWidth, vh = window.innerHeight
    const left = b.left > vw / 2 ? b.left - GAP - WIDTH : b.right + GAP
    const top = Math.min(Math.max(b.top + b.height / 2 - height / 2, MARGIN), vh - height - MARGIN)
    setPos({ left: Math.min(Math.max(left, MARGIN), vw - WIDTH - MARGIN), top })
  }, [open])

  useEffect(() => {
    if (!pinned) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !buttonRef.current?.contains(e.target as Node)) setPinned(false)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', close)
    window.addEventListener('scroll', close, true) // the panel scrolled: the icon moved away
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [pinned])

  return (
    <>
      <button ref={buttonRef} type="button" className="info-tip" aria-label={question}
        aria-describedby={open ? id : undefined} aria-expanded={pinned}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)} onBlur={() => { setHover(false); setPinned(false) }}
        // inside a <summary> or <label>: don't also open the section / tick the checkbox
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPinned((p) => !p) }}>
        i
      </button>
      {open && createPortal(
        <div ref={popRef} id={id} role="tooltip" className="info-tip-pop"
          style={{ width: WIDTH, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}>
          <b>{question}</b>
          <span>{answer}</span>
        </div>,
        document.body,
      )}
    </>
  )
}
