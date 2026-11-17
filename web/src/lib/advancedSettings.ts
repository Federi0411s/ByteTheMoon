export interface AdvancedSettings {
  temperature: {
    recommendedC: number
    feasibleC: number
    difficultC: number
  }
  radiation: {
    recommendedDoseUGy: number
    feasibleDoseUGy: number
    difficultDoseUGy: number
  }
  slope: {
    recommendedDeg: number
    feasibleDeg: number
    difficultDeg: number
  }
  telecom: {
    recommendedPercent: number
    feasiblePercent: number
    difficultPercent: number
  }
  sunlight: {
    recommendedPercent: number
    feasiblePercent: number
    difficultPercent: number
  }
  eva: {
    minimumTemperatureC: number
    maximumTemperatureC: number
    maximumWalkHours: number
    coldWalkHours: number
    dailyDoseLimitMsv: number
    careerDoseLimitMsv: number
    referenceStayDays: number
  }
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  temperature: { recommendedC: -80, feasibleC: -130, difficultC: -180 },
  radiation: { recommendedDoseUGy: 3e8, feasibleDoseUGy: 1e9, difficultDoseUGy: 1e10 },
  slope: { recommendedDeg: 5, feasibleDeg: 8, difficultDeg: 10 },
  telecom: { recommendedPercent: 80, feasiblePercent: 40, difficultPercent: 10 },
  sunlight: { recommendedPercent: 80, feasiblePercent: 50, difficultPercent: 20 },
  eva: {
    minimumTemperatureC: -157,
    maximumTemperatureC: 121,
    maximumWalkHours: 8,
    coldWalkHours: 2,
    dailyDoseLimitMsv: 0.8,
    careerDoseLimitMsv: 600,
    referenceStayDays: 30,
  },
}

export function copyAdvancedSettings(settings: AdvancedSettings): AdvancedSettings {
  return {
    temperature: { ...settings.temperature },
    radiation: { ...settings.radiation },
    slope: { ...settings.slope },
    telecom: { ...settings.telecom },
    sunlight: { ...settings.sunlight },
    eva: { ...settings.eva },
  }
}

export function validateAdvancedSettings(settings: AdvancedSettings): string[] {
  const errors: string[] = []
  const allValues = Object.values(settings).flatMap((section) => Object.values(section))
  if (allValues.some((value) => !Number.isFinite(value))) errors.push('All values must be finite numbers.')

  const { temperature, radiation, slope, telecom, sunlight, eva } = settings
  if (!(temperature.recommendedC > temperature.feasibleC && temperature.feasibleC > temperature.difficultC)) {
    errors.push('Temperature bands must descend from recommended to difficult.')
  }
  if (!(radiation.recommendedDoseUGy > 0 &&
      radiation.recommendedDoseUGy < radiation.feasibleDoseUGy &&
      radiation.feasibleDoseUGy < radiation.difficultDoseUGy)) {
    errors.push('Radiation dose bands must be positive and increase from recommended to difficult.')
  }
  if (!(slope.recommendedDeg > 0 && slope.recommendedDeg < slope.feasibleDeg && slope.feasibleDeg < slope.difficultDeg && slope.difficultDeg <= 90)) {
    errors.push('Slope bands must increase from recommended to difficult and stay at or below 90°.')
  }
  if (!(telecom.recommendedPercent <= 100 &&
      telecom.recommendedPercent > telecom.feasiblePercent &&
      telecom.feasiblePercent > telecom.difficultPercent &&
      telecom.difficultPercent >= 0)) {
    errors.push('Telecommunications bands must descend from recommended to difficult within 0–100%.')
  }
  if (!(sunlight.recommendedPercent <= 100 &&
      sunlight.recommendedPercent > sunlight.feasiblePercent &&
      sunlight.feasiblePercent > sunlight.difficultPercent &&
      sunlight.difficultPercent >= 0)) {
    errors.push('Sunlight percentage bands must descend from recommended to difficult within 0–100%.')
  }
  if (!(eva.minimumTemperatureC < eva.maximumTemperatureC)) errors.push('The minimum EVA temperature must be below the maximum.')
  if (!(eva.maximumWalkHours > 0 && eva.maximumWalkHours <= 24 && eva.coldWalkHours > 0 && eva.coldWalkHours <= 24)) {
    errors.push('EVA durations must be greater than 0 and no more than 24 hours.')
  }
  if (eva.coldWalkHours > eva.maximumWalkHours) errors.push('A cold-only excursion cannot exceed the maximum EVA duration.')
  if (!(eva.dailyDoseLimitMsv > 0 && eva.careerDoseLimitMsv > 0 && eva.referenceStayDays > 0)) {
    errors.push('Radiation dose limits and the reference stay must be greater than 0.')
  }
  return errors
}

/** Map display and movement settings (Settings dialog, outside the scoring thresholds above). */
export interface DisplaySettings {
  /** DEM-guided upsampling of the computed heatmaps (sharper edges); off = plain bilinear */
  guided: boolean
  /** steepest slope (deg) a rover or crew can drive up or down: the reachable-area layer */
  moveSlopeDeg: number
  /** search radius (km) of the reachable-area layer around the selected point */
  reachRadiusKm: number
  /** where the heatmaps are computed: 'auto' = graphics card (WebGPU) and processor together, 'cpu' = processor only */
  compute: 'auto' | 'cpu'
  /** first-person ground near the viewer: 'photo' = the sharpest Moon Trek orbital photo plus procedural detail, 'procedural' = the procedural regolith surrogate only (no download) */
  fpvGround: 'photo' | 'procedural'
}

export const MOVE_SLOPE_MIN_DEG = 1
export const MOVE_SLOPE_MAX_DEG = 45
export const REACH_RADIUS_MIN_KM = 5
export const REACH_RADIUS_MAX_KM = 300
/** 15 deg: a common design limit for lunar rovers */
export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { guided: true, moveSlopeDeg: 15, reachRadiusKm: 100, compute: 'auto', fpvGround: 'photo' }
