import { APP_VERSION } from './config';
import { elapsedSeconds } from './tracking';
import type { ActiveRunState, SavedRun, UserSettings } from './types';

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function buildSavedRun(
  active: ActiveRunState,
  settings: UserSettings,
  endedAt: number,
): Promise<SavedRun> {
  const movingSeconds = elapsedSeconds({ ...active, status: 'running', endedAt }, endedAt);
  const totalDurationSeconds = Math.max(0, Math.round((endedAt - active.startedAt) / 1000));
  const pauseSeconds = Math.max(0, totalDurationSeconds - movingSeconds);
  const avgPace = active.distanceKm > 0 ? movingSeconds / active.distanceKm : 0;
  const avgSpeed = movingSeconds > 0 ? active.distanceKm / (movingSeconds / 3600) : 0;
  const avgCadence = active.cadenceSamples.length
    ? active.cadenceSamples.reduce((sum, value) => sum + value, 0) / active.cadenceSamples.length
    : 0;

  return {
    run_id: active.runId,
    username: settings.username || '',
    activity: active.activity,
    date: localDateKey(active.startedAt),
    started_at: new Date(active.startedAt).toISOString(),
    ended_at: new Date(endedAt).toISOString(),
    duration_seconds: totalDurationSeconds,
    moving_seconds: movingSeconds,
    pause_seconds: pauseSeconds,
    distance_km: Number(active.distanceKm.toFixed(3)),
    avg_pace_seconds_per_km: Number(avgPace.toFixed(2)),
    best_pace_seconds_per_km: active.bestPaceSecondsPerKm
      ? Number(active.bestPaceSecondsPerKm.toFixed(2))
      : null,
    avg_speed_kmh: Number(avgSpeed.toFixed(2)),
    max_speed_kmh: Number(active.maxSpeedKmh.toFixed(2)),
    calories: Number(active.calories.toFixed(2)),
    weight_kg: settings.weightKg,
    steps: active.steps,
    avg_cadence: Number(avgCadence.toFixed(1)),
    max_cadence: Number(active.maxCadence.toFixed(1)),
    avg_heart_rate: null,
    max_heart_rate: null,
    elevation_gain_m: Number(active.elevationGainM.toFixed(2)),
    elevation_loss_m: Number(active.elevationLossM.toFixed(2)),
    location_count: active.locationCount,
    route_data: JSON.stringify(active.route),
    device_id: 'runpulse_android',
    app_version: APP_VERSION,
    sync_status: 'pending',
  };
}
