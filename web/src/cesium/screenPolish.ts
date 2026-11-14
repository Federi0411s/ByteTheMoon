/**
 * Two screen-quality fixes applied once to the Cesium viewer:
 *
 * 1. Crisp text. Cesium renders at CSS-pixel resolution by default, so on scaled displays (Windows
 *    125-150%) the whole canvas is upscaled and labels look soft. We render at the device pixel ratio
 *    and rasterise every entity label at 2x its font size, drawn at scale 0.5 (same on-screen size,
 *    twice the glyph resolution).
 *
 * 2. Credits placement. The Cesium ion logo/credits must stay visible. They sit bottom-left, just
 *    above the time bar, and slide right only when the left panel's visible content would cover them
 *    (e.g. the expanded site panel), tracking it as it grows or shrinks.
 */
import { ConstantProperty, JulianDate, type Entity, type Viewer } from 'cesium'

const SUPERSAMPLE = 2
const done = new WeakSet<Entity>()

function crispLabel(e: Entity) {
  const label = e.label
  if (!label || done.has(e)) return
  done.add(e)
  const now = JulianDate.now()
  const font = (label.font?.getValue(now) as string | undefined) ?? '30px sans-serif'
  const m = /(\d+(?:\.\d+)?)px/.exec(font)
  if (!m) return
  label.font = new ConstantProperty(font.replace(m[0], `${parseFloat(m[1]) * SUPERSAMPLE}px`))
  label.scale = new ConstantProperty(((label.scale?.getValue(now) as number | undefined) ?? 1) / SUPERSAMPLE)
  const ow = label.outlineWidth?.getValue(now) as number | undefined
  if (ow !== undefined) label.outlineWidth = new ConstantProperty(ow * SUPERSAMPLE)
}

export function crispText(viewer: Viewer) {
  viewer.useBrowserRecommendedResolution = false // render at devicePixelRatio
  viewer.entities.values.forEach(crispLabel)
  viewer.entities.collectionChanged.addEventListener((_c, added: Entity[]) => added.forEach(crispLabel))
  // labels assigned after an entity was added (entity.label = ...) are caught on the next frame
  viewer.scene.preRender.addEventListener(() => {
    for (const e of viewer.entities.values) if (e.label && !done.has(e)) crispLabel(e)
  })
}

const GAP = 12

export function keepCreditsClear(viewer: Viewer) {
  const credits = viewer.bottomContainer as HTMLElement
  const app = viewer.container.closest('.app') ?? document.body
  let panel: Element | null = null
  const ro = new ResizeObserver(() => update())

  function update() {
    const p = app.querySelector('.side.left')
    if (p !== panel) {
      ro.disconnect()
      panel = p
      if (panel) {
        ro.observe(panel)
        for (const child of Array.from(panel.children)) ro.observe(child)
      }
    }
    let left = GAP
    if (panel && getComputedStyle(panel).position === 'absolute') {
      const box = panel.getBoundingClientRect()
      // visible part of the panel's content (the aside itself is a transparent full-height scroller)
      let bottom = box.top
      let right = box.left
      for (const child of Array.from(panel.children)) {
        const r = child.getBoundingClientRect()
        if (r.height === 0) continue
        bottom = Math.max(bottom, Math.min(r.bottom, box.bottom))
        right = Math.max(right, r.right)
      }
      const creditsTop = credits.getBoundingClientRect().top
      // the aside's own right edge includes its scrollbar
      if (bottom + GAP > creditsTop) left = Math.max(right, box.right) + GAP
    }
    credits.style.setProperty('--credits-left', `${Math.round(left)}px`)
  }

  // the panel mounts after the viewer and changes with React state: watch the DOM and the window
  new MutationObserver(() => update()).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  window.addEventListener('resize', update)
  update()
}
