import type { Activity, RemoteRun, ReportFilters } from './types';

export interface ReportStats {
  count: number;
  totalDistanceKm: number;
  totalCalories: number;
  totalMovingSeconds: number;
  totalSteps: number;
  totalElevationGainM: number;
  avgPaceSecondsPerKm: number; // pace TB có trọng số theo quãng đường
  avgSpeedKmh: number;
  bestPaceSecondsPerKm: number | null;
  longestKm: number;
}

export interface DayBucket {
  date: string;
  distanceKm: number;
  calories: number;
}

export function applyFilters(runs: RemoteRun[], filters: ReportFilters): RemoteRun[] {
  return runs.filter((run) => {
    if (filters.activity !== 'all' && run.activity !== filters.activity) return false;
    if (run.date < filters.fromDate || run.date > filters.toDate) return false;
    if (run.distance_km < filters.minDistanceKm) return false;
    if (
      filters.maxPaceSecondsPerKm != null &&
      run.avg_pace_seconds_per_km > 0 &&
      run.avg_pace_seconds_per_km > filters.maxPaceSecondsPerKm
    ) {
      return false;
    }
    return true;
  });
}

export function computeStats(runs: RemoteRun[]): ReportStats {
  let totalDistanceKm = 0;
  let totalCalories = 0;
  let totalMovingSeconds = 0;
  let totalSteps = 0;
  let totalElevationGainM = 0;
  let bestPace: number | null = null;
  let longestKm = 0;

  for (const run of runs) {
    totalDistanceKm += run.distance_km || 0;
    totalCalories += run.calories || 0;
    totalMovingSeconds += run.moving_seconds || 0;
    totalSteps += run.steps || 0;
    totalElevationGainM += run.elevation_gain_m || 0;
    if (run.distance_km > longestKm) longestKm = run.distance_km;
    const pace = run.avg_pace_seconds_per_km;
    if (pace > 0 && (bestPace == null || pace < bestPace)) bestPace = pace;
  }

  const avgPaceSecondsPerKm = totalDistanceKm > 0 ? totalMovingSeconds / totalDistanceKm : 0;
  const avgSpeedKmh = totalMovingSeconds > 0 ? totalDistanceKm / (totalMovingSeconds / 3600) : 0;

  return {
    count: runs.length,
    totalDistanceKm,
    totalCalories,
    totalMovingSeconds,
    totalSteps,
    totalElevationGainM,
    avgPaceSecondsPerKm,
    avgSpeedKmh,
    bestPaceSecondsPerKm: bestPace,
    longestKm,
  };
}

/** Gom theo ngày để vẽ biểu đồ xu hướng. */
export function bucketByDay(runs: RemoteRun[], fromDate: string, toDate: string): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (const run of runs) {
    const existing = map.get(run.date) ?? { date: run.date, distanceKm: 0, calories: 0 };
    existing.distanceKm += run.distance_km || 0;
    existing.calories += run.calories || 0;
    map.set(run.date, existing);
  }
  // Điền đủ các ngày trống trong khoảng để biểu đồ liền mạch.
  const out: DayBucket[] = [];
  const start = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(map.get(key) ?? { date: key, distanceKm: 0, calories: 0 });
  }
  return out;
}

export function shiftDate(base: Date, deltaDays: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
