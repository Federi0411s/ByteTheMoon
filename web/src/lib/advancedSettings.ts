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
  darkness: {
    recommendedDays: number
    feasibleDays: number
    difficultDays: number
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
  darkness: { recommendedDays: 3, feasibleDays: 7, difficultDays: 20 },
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
    darkness: { ...settings.darkness },
    eva: { ...settings.eva },
  }
}

export function validateAdvancedSettings(settings: AdvancedSettings): string[] {
  const errors: string[] = []
  const allValues = Object.values(settings).flatMap((section) => Object.values(section))
  if (allValues.some((value) => !Number.isFinite(value))) errors.push('All values must be finite numbers.')

  const { temperature, radiation, slope, telecom, darkness, eva } = settings
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
  if (!(darkness.recommendedDays >= 0 && darkness.recommendedDays < darkness.feasibleDays && darkness.feasibleDays < darkness.difficultDays)) {
    errors.push('Darkness-duration bands must increase from recommended to difficult.')
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
