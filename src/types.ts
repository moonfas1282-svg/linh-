import type { Activity, Sex } from './calories';
export type { Activity, Sex } from './calories';

export type RunStatus = 'idle' | 'running' | 'paused';

export interface UserSettings {
  weightKg: number;
  heightCm: number | null;
  ageYears: number | null;
  sex: Sex;
  activity: Activity;
  apiUrl: string;
  apiKey: string;
  // Tài khoản đăng nhập (gắn dữ liệu theo user trên Google Sheet).
  username: string;
  authToken: string;
}

export interface RoutePoint {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  speedKmh: number;
  timestamp: number;
}

export interface ActiveRunState {
  status: RunStatus;
  activity: Activity;
  runId: string;
  startedAt: number;
  endedAt: number | null;
  pausedAt: number | null;
  totalPausedMs: number;
  lastAcceptedAt: number | null;
  lastLatitude: number | null;
  lastLongitude: number | null;
  lastAltitude: number | null;
  smoothedSpeedKmh: number;
  distanceKm: number;
  calories: number;
  maxSpeedKmh: number;
  bestPaceSecondsPerKm: number | null;
  elevationGainM: number;
  elevationLossM: number;
  locationCount: number;
  route: RoutePoint[];
  steps: number;
  currentCadence: number;
  maxCadence: number;
  cadenceSamples: number[];
}

export interface SavedRun {
  run_id: string;
  username: string;
  activity: Activity;
  date: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  moving_seconds: number;
  pause_seconds: number;
  distance_km: number;
  avg_pace_seconds_per_km: number;
  best_pace_seconds_per_km: number | null;
  avg_speed_kmh: number;
  max_speed_kmh: number;
  calories: number;
  weight_kg: number;
  steps: number;
  avg_cadence: number;
  max_cadence: number;
  avg_heart_rate: null;
  max_heart_rate: null;
  elevation_gain_m: number;
  elevation_loss_m: number;
  location_count: number;
  route_data: string;
  device_id: string;
  app_version: string;
  sync_status: 'pending' | 'synced' | 'failed';
  sync_error?: string;
}

export interface DailySummary {
  date: string;
  runCount: number;
  totalDistanceKm: number;
  totalDurationSeconds: number;
  totalCalories: number;
  totalSteps: number;
}

/** Một bản ghi buổi tập lấy từ Google Sheet (dùng cho tab Báo cáo). */
export interface RemoteRun {
  run_id: string;
  username: string;
  activity: Activity;
  date: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  moving_seconds: number;
  distance_km: number;
  avg_pace_seconds_per_km: number;
  avg_speed_kmh: number;
  max_speed_kmh: number;
  calories: number;
  steps: number;
  elevation_gain_m: number;
}

export interface ReportFilters {
  activity: Activity | 'all';
  fromDate: string; // yyyy-MM-dd
  toDate: string;   // yyyy-MM-dd
  minDistanceKm: number;
  maxPaceSecondsPerKm: number | null; // null = không lọc
}
