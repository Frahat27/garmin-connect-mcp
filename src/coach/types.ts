export type SportLevel = 'principiante' | 'intermedio' | 'avanzado';

export type AthleteProfile = {
  savedAt: string;
  eventName: string;
  eventDistance: string;
  eventDate: string;
  eventPriority: 'A' | 'B' | 'C';
  secondaryObjective: string;
  runningDays: number;
  runningMaxMinutes: number;
  swimmingDays: number;
  swimmingMaxMinutes: number;
  cyclingDays: number;
  cyclingMaxMinutes: number;
  gymDays: number;
  gymMaxMinutes: number;
  restDays: string;
  activeInjury: boolean;
  injuryDescription: string;
  injuryPain: number;
  recentInjuries: string;
  levelRunning: SportLevel;
  levelSwimming: SportLevel;
  levelCycling: SportLevel;
  weightGoal: boolean;
  logsAllActivities: boolean;
  missingDisciplines: string;
};

export type DailyCheckin = {
  date: string;
  weight: number | null;
  rpeLastSession: number | null;
  muscleSoreness: number | null;
  motivation: number | null;
  sleepQuality: number | null;
  newPainOrIssue: string;
};

export type ActivitySummary = {
  type: string;
  date: string;
  distanceKm: number | null;
  durationMin: number;
  avgHR: number | null;
  maxHR: number | null;
  zone1Min: number;
  zone2Min: number;
  zone3Min: number;
  zone4Min: number;
  zone5Min: number;
};

export type WeeklyVolume = {
  weekStart: string;
  runningKm: number;
  runningMin: number;
  cyclingKm: number;
  cyclingMin: number;
  swimmingM: number;
  swimmingMin: number;
  strengthMin: number;
  totalMin: number;
};

export type GarminSummary = {
  fetchDate: string;
  activities: ActivitySummary[];
  weeklyVolumes: WeeklyVolume[];
  vo2max: number | null;
  racePredictions: unknown;
  personalRecords: unknown;
  lactateThreshold: unknown;
  trainingStatus: unknown;
  trainingReadiness: unknown;
  avgRestingHR7d: number | null;
  restingHRTrend: number[];
  hrvToday: number | null;
  avgBodyBattery7d: number | null;
  sleepRaw: unknown;
  latestWeight: number | null;
  errors: string[];
};
