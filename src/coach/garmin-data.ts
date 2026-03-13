import type { GarminClient } from '../client';
import type { ActivitySummary, GarminSummary, WeeklyVolume } from './types';

function dateStr(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

function normalizeType(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('running') || s === 'run') return 'running';
  if (s.includes('cycling') || s.includes('bike') || s.includes('road_biking') || s.includes('indoor_cycling')) return 'cycling';
  if (s.includes('swimming') || s.includes('swim')) return 'swimming';
  if (s.includes('strength') || s.includes('gym') || s.includes('weight_training') || s.includes('fitness_equipment')) return 'strength';
  if (s.includes('triathlon')) return 'triathlon';
  return raw;
}

function toNum(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function summarizeActivity(raw: Record<string, unknown>): ActivitySummary {
  const typeObj = raw.activityType as Record<string, unknown> | undefined;
  const typeKey = String(typeObj?.typeKey ?? raw.activityTypeDTO ?? 'unknown');
  const dateRaw = String(raw.startTimeLocal ?? raw.beginTimestamp ?? '');
  const distanceRaw = toNum(raw.distance);
  const durationRaw = toNum(raw.duration);

  return {
    type: normalizeType(typeKey),
    date: dateRaw.split('T')[0] ?? '',
    distanceKm: distanceRaw !== null ? Math.round((distanceRaw / 1000) * 10) / 10 : null,
    durationMin: durationRaw !== null ? Math.round(durationRaw / 60) : 0,
    avgHR: toNum(raw.averageHR),
    maxHR: toNum(raw.maxHR),
    zone1Min: Math.round((toNum(raw.hrTimeInZone_1) ?? 0) / 60),
    zone2Min: Math.round((toNum(raw.hrTimeInZone_2) ?? 0) / 60),
    zone3Min: Math.round((toNum(raw.hrTimeInZone_3) ?? 0) / 60),
    zone4Min: Math.round((toNum(raw.hrTimeInZone_4) ?? 0) / 60),
    zone5Min: Math.round((toNum(raw.hrTimeInZone_5) ?? 0) / 60),
  };
}

function computeWeeklyVolumes(activities: ActivitySummary[]): WeeklyVolume[] {
  const weeks = new Map<string, WeeklyVolume>();

  for (const a of activities) {
    if (!a.date) continue;
    const date = new Date(a.date);
    const dow = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
    const weekStart = monday.toISOString().split('T')[0];

    if (!weeks.has(weekStart)) {
      weeks.set(weekStart, {
        weekStart,
        runningKm: 0, runningMin: 0,
        cyclingKm: 0, cyclingMin: 0,
        swimmingM: 0, swimmingMin: 0,
        strengthMin: 0, totalMin: 0,
      });
    }

    const w = weeks.get(weekStart)!;
    w.totalMin += a.durationMin;

    switch (a.type) {
      case 'running':
        w.runningKm += a.distanceKm ?? 0;
        w.runningMin += a.durationMin;
        break;
      case 'cycling':
        w.cyclingKm += a.distanceKm ?? 0;
        w.cyclingMin += a.durationMin;
        break;
      case 'swimming':
        w.swimmingM += (a.distanceKm ?? 0) * 1000;
        w.swimmingMin += a.durationMin;
        break;
      case 'strength':
        w.strengthMin += a.durationMin;
        break;
    }
  }

  return Array.from(weeks.values())
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map(w => ({
      ...w,
      runningKm: Math.round(w.runningKm * 10) / 10,
      cyclingKm: Math.round(w.cyclingKm * 10) / 10,
      swimmingM: Math.round(w.swimmingM),
    }));
}

function extractRHR(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.value === 'number') return d.value;
  if (typeof d.restingHeartRate === 'number') return d.restingHeartRate;
  const daily = d.allMetrics as Record<string, unknown> | undefined;
  if (daily && typeof daily.metricsMap === 'object') {
    const mm = daily.metricsMap as Record<string, unknown[]>;
    const values = mm.WELLNESS_RESTING_HEART_RATE;
    if (Array.isArray(values) && values.length > 0) {
      const last = values[values.length - 1] as Record<string, unknown>;
      return typeof last.value === 'number' ? last.value : null;
    }
  }
  return null;
}

function extractVO2Max(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.vo2Max === 'number') return d.vo2Max;
  const generic = d.generic as Record<string, unknown> | undefined;
  if (generic && typeof generic.vo2MaxValue === 'number') return generic.vo2MaxValue;
  return null;
}

function extractHRV(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.lastNight === 'number') return d.lastNight;
  const summary = d.hrvSummary as Record<string, unknown> | undefined;
  if (summary && typeof summary.lastNight === 'number') return summary.lastNight;
  return null;
}

function extractLatestWeight(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (Array.isArray(d.totalAverage) && d.totalAverage.length > 0) {
    const last = d.totalAverage[d.totalAverage.length - 1] as Record<string, unknown>;
    if (typeof last.weight === 'number') return Math.round((last.weight / 1000) * 10) / 10;
  }
  return null;
}

function extractAvgBodyBattery(raw: unknown): number | null {
  if (!Array.isArray(raw)) return null;
  const values: number[] = (raw as Record<string, unknown>[])
    .flatMap(d => {
      const arr = d.bodyBatteryValuesArray;
      return Array.isArray(arr) ? (arr as number[][]).map(entry => entry[1]) : [];
    })
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export async function fetchGarminData(client: GarminClient): Promise<GarminSummary> {
  const today = dateStr(0);
  const errors: string[] = [];

  const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const [
    rawActivities,
    rawLatestActivities,
    trainingStatus,
    trainingReadiness,
    hrvData,
    sleepRaw,
    bodyBatteryRaw,
    vo2maxRaw,
    racePredictions,
    personalRecords,
    lactateThreshold,
    bodyCompositionRaw,
  ] = await Promise.all([
    safe('activities_60d', () => client.getActivitiesByDate(dateStr(60), today)),
    safe('activities_latest', () => client.getActivities(0, 10)),
    safe('training_status', () => client.getTrainingStatus(today)),
    safe('training_readiness', () => client.getTrainingReadiness(today)),
    safe('hrv', () => client.getHRV(today)),
    safe('sleep_7d', () => client.getSleepDataRange(dateStr(7), today)),
    safe('body_battery_14d', () => client.getBodyBattery(dateStr(14), today)),
    safe('vo2max', () => client.getVO2Max(today)),
    safe('race_predictions', () => client.getRacePredictions()),
    safe('personal_records', () => client.getPersonalRecords()),
    safe('lactate_threshold', () => client.getLactateThreshold()),
    safe('body_composition_30d', () => client.getBodyComposition(dateStr(30), today)),
  ]);

  const last7Days = Array.from({ length: 7 }, (_, i) => dateStr(i));
  const rhrResults = await Promise.all(
    last7Days.map(d => safe(`rhr_${d}`, () => client.getRestingHeartRate(d))),
  );

  const byDateList = Array.isArray(rawActivities) ? (rawActivities as Record<string, unknown>[]) : [];
  const latestList = Array.isArray(rawLatestActivities) ? (rawLatestActivities as Record<string, unknown>[]) : [];
  const seenIds = new Set(byDateList.map(a => a.activityId ?? a.startTimeLocal));
  const merged = [...byDateList];
  for (const a of latestList) {
    const key = a.activityId ?? a.startTimeLocal;
    if (!seenIds.has(key)) { merged.push(a); seenIds.add(key); }
  }
  merged.sort((a, b) => String(a.startTimeLocal ?? '').localeCompare(String(b.startTimeLocal ?? '')));
  const activities: ActivitySummary[] = merged.map(summarizeActivity);

  const weeklyVolumes = computeWeeklyVolumes(activities);

  const rhrValues = rhrResults
    .map(r => extractRHR(r))
    .filter((v): v is number => v !== null);

  const avgRHR = rhrValues.length > 0
    ? Math.round(rhrValues.reduce((a, b) => a + b, 0) / rhrValues.length)
    : null;

  return {
    fetchDate: today,
    activities,
    weeklyVolumes,
    vo2max: extractVO2Max(vo2maxRaw),
    racePredictions,
    personalRecords,
    lactateThreshold,
    trainingStatus,
    trainingReadiness,
    avgRestingHR7d: avgRHR,
    restingHRTrend: [...rhrValues].reverse(),
    hrvToday: extractHRV(hrvData),
    avgBodyBattery7d: extractAvgBodyBattery(bodyBatteryRaw),
    sleepRaw,
    latestWeight: extractLatestWeight(bodyCompositionRaw),
    errors,
  };
}
