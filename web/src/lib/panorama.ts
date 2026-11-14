import type { HorizonMask, TimelineSample } from './analysis'

const STEPS = [1, 2, 5, 10, 15, 20, 30, 45]

export function fitPanoramaRange(mask: HorizonMask | undefined, timeline: TimelineSample[], now?: TimelineSample) {
  let tMin = 0, tMax = 0
  if (mask) for (const elevation of mask.elevDeg) {
    if (elevation < tMin) tMin = elevation
    if (elevation > tMax) tMax = elevation
  }
  const cap = Math.max(tMax + 6, tMax * 1.8, 5)
  let bodyMax = -Infinity, bodyMin = Infinity
  const addElevation = (elevation: number) => {
    if (elevation > bodyMax) bodyMax = elevation
    if (elevation < bodyMin) bodyMin = elevation
  }
  for (const sample of timeline) {
    addElevation(sample.sunEl)
    addElevation(sample.earthEl)
  }
  if (now) {
    addElevation(now.sunEl)
    addElevation(now.earthEl)
  }
  const hi0 = Math.max(tMax + 1.5, Math.min(cap, bodyMax + 1), 3)
  const lo0 = Math.min(tMin - 1, Math.max(bodyMin - 1, tMin - 3), -1)
  const step = STEPS.find((candidate) => (hi0 - lo0) / candidate <= 6) ?? 90
  return { lo: Math.floor(lo0 / step) * step, hi: Math.ceil(hi0 / step) * step, step }
}
