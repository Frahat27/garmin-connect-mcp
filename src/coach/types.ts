export type SportLevel = 'principiante' | 'intermedio' | 'avanzado';

export type CoachType = 'shalo' | 'mego' | 'mecha';

export type AnalysisDepth = 'detailed' | 'summary' | 'minimal';

export type Goal = {
  id: string;
  eventName: string;
  eventDistance: string;
  eventDate: string;
  priority: 'A' | 'B' | 'C';
  comment: string;
};

export type AthleteProfile = {
  savedAt: string;
  eventName: string;
  eventDistance: string;
  eventDate: string;
  eventPriority: 'A' | 'B' | 'C';
  secondaryObjective: string;
  runningDays: number;
  runningMaxMinutes: number;
  runningAvailableDays: number[];
  swimmingDays: number;
  swimmingMaxMinutes: number;
  swimmingAvailableDays: number[];
  cyclingDays: number;
  cyclingMaxMinutes: number;
  cyclingAvailableDays: number[];
  gymDays: number;
  gymMaxMinutes: number;
  gymAvailableDays: number[];
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
  sleepSource: 'garmin' | 'manual' | null;
  newPainOrIssue: string;
};

export type DailyLog = {
  date: string;
  weight: number | null;
  sleepScore: number | null;
  sleepSource: 'garmin' | 'manual' | null;
  rpe: number | null;
  soreness: number | null;
  motivation: number | null;
  pain: string;
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
