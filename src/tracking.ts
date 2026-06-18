import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { activeCaloriesForSegment } from './calories';
import type { CalorieProfile } from './calories';
import { LOCATION_TASK_NAME } from './config';
import { getActiveRun, getSettings, saveActiveRun } from './storage';
import type { ActiveRunState, RoutePoint } from './types';

const MAX_ROUTE_POINTS = 240;

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const earthRadius = 6_371_000;
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function appendRoutePoint(route: RoutePoint[], point: RoutePoint): RoutePoint[] {
  const next = [...route, point];
  if (next.length <= MAX_ROUTE_POINTS) return next;
  // Preserve the route shape while keeping route_data below the Google Sheet cell limit.
  return next.filter((_, index) => index % 2 === 0);
}

export async function processLocations(locations: Location.LocationObject[]): Promise<void> {
  let run = await getActiveRun();
  if (run.status !== 'running') return;
  const settings = await getSettings();

  for (const location of [...locations].sort((a, b) => a.timestamp - b.timestamp)) {
    const { latitude, longitude, altitude, accuracy, speed } = location.coords;
    const timestamp = location.timestamp;

    if (accuracy != null && accuracy > 35) continue;

    if (run.lastAcceptedAt == null || run.lastLatitude == null || run.lastLongitude == null) {
      run = {
        ...run,
        lastAcceptedAt: timestamp,
        lastLatitude: latitude,
        lastLongitude: longitude,
        lastAltitude: altitude,
        locationCount: run.locationCount + 1,
        route: appendRoutePoint(run.route, {
          latitude,
          longitude,
          altitude,
          accuracy,
          speedKmh: 0,
          timestamp,
        }),
      };
      continue;
    }

    const deltaSeconds = (timestamp - run.lastAcceptedAt) / 1000;
    if (deltaSeconds < 1 || deltaSeconds > 45) continue;

    const distanceMeters = haversineMeters(
      run.lastLatitude,
      run.lastLongitude,
      latitude,
      longitude,
    );

    const gpsSpeedKmh = speed != null && speed >= 0 ? speed * 3.6 : 0;
    const derivedSpeedKmh = distanceMeters / deltaSeconds * 3.6;
    const rawSpeedKmh = gpsSpeedKmh > 0.5 ? gpsSpeedKmh : derivedSpeedKmh;

    // Ngưỡng lọc nhiễu tuỳ theo môn: đạp xe cho phép tốc độ/khoảng cách lớn hơn.
    const maxSpeedReject = run.activity === 'bike' ? 75 : 35;
    const maxDistReject = run.activity === 'bike' ? 600 : 250;
    // Reject GPS drift and impossible jumps.
    if (distanceMeters < 2 || distanceMeters > maxDistReject || rawSpeedKmh > maxSpeedReject) continue;

    const smoothedSpeedKmh = run.smoothedSpeedKmh > 0
      ? run.smoothedSpeedKmh * 0.65 + rawSpeedKmh * 0.35
      : rawSpeedKmh;

    // Độ dốc của đoạn: chênh cao GPS / quãng đường ngang. Lọc nhiễu trước khi dùng.
    let segmentGrade = 0;
    if (
      altitude != null &&
      run.lastAltitude != null &&
      distanceMeters >= 8
    ) {
      const rawDelta = altitude - run.lastAltitude;
      if (Math.abs(rawDelta) >= 1 && Math.abs(rawDelta) <= 15) {
        segmentGrade = rawDelta / distanceMeters;
        // Giới hạn ±30% để tránh GPS altitude lỗi thổi phồng calo.
        segmentGrade = Math.max(-0.3, Math.min(0.3, segmentGrade));
      }
    }

    const profile: CalorieProfile = {
      weightKg: settings.weightKg,
      heightCm: settings.heightCm,
      ageYears: settings.ageYears,
      sex: settings.sex,
    };
    const calories = activeCaloriesForSegment(
      profile,
      smoothedSpeedKmh,
      deltaSeconds,
      segmentGrade,
      run.activity,
    );
    const segmentPace = smoothedSpeedKmh > 1 ? 3600 / smoothedSpeedKmh : null;

    let elevationGainM = run.elevationGainM;
    let elevationLossM = run.elevationLossM;
    if (altitude != null && run.lastAltitude != null && distanceMeters >= 8) {
      const altitudeDelta = altitude - run.lastAltitude;
      // GPS altitude is noisy, so ignore tiny changes and implausible spikes.
      if (Math.abs(altitudeDelta) >= 1.5 && Math.abs(altitudeDelta) <= 12) {
        if (altitudeDelta > 0) elevationGainM += altitudeDelta;
        else elevationLossM += Math.abs(altitudeDelta);
      }
    }

    run = {
      ...run,
      lastAcceptedAt: timestamp,
      lastLatitude: latitude,
      lastLongitude: longitude,
      lastAltitude: altitude,
      smoothedSpeedKmh,
      distanceKm: run.distanceKm + distanceMeters / 1000,
      calories: run.calories + calories,
      maxSpeedKmh: Math.max(run.maxSpeedKmh, smoothedSpeedKmh),
      bestPaceSecondsPerKm:
        segmentPace != null && segmentPace >= 150 && segmentPace <= 1200
          ? Math.min(run.bestPaceSecondsPerKm ?? segmentPace, segmentPace)
          : run.bestPaceSecondsPerKm,
      elevationGainM,
      elevationLossM,
      locationCount: run.locationCount + 1,
      route: appendRoutePoint(run.route, {
        latitude,
        longitude,
        altitude,
        accuracy,
        speedKmh: smoothedSpeedKmh,
        timestamp,
      }),
    };
  }

  await saveActiveRun(run);
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn('Background location task error:', error.message);
    return;
  }
  const payload = data as { locations?: Location.LocationObject[] } | undefined;
  if (payload?.locations?.length) {
    await processLocations(payload.locations);
  }
});

export async function requestTrackingPermissions(): Promise<boolean> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') return false;
  const background = await Location.requestBackgroundPermissionsAsync();
  return background.status === 'granted';
}

export async function startBackgroundTracking(): Promise<void> {
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (alreadyStarted) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 4000,
    distanceInterval: 3,
    deferredUpdatesDistance: 0,
    deferredUpdatesInterval: 4000,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'RunPulse đang ghi lại buổi chạy',
      notificationBody: 'GPS, pace và calo đang được cập nhật.',
      killServiceOnDestroy: false,
    },
  });
}

export async function stopBackgroundTracking(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
}

export function elapsedSeconds(run: ActiveRunState, now = Date.now()): number {
  if (run.status === 'idle' || !run.startedAt) return 0;
  const end = run.endedAt ?? now;
  const currentPause = run.status === 'paused' && run.pausedAt ? end - run.pausedAt : 0;
  return Math.max(0, Math.floor((end - run.startedAt - run.totalPausedMs - currentPause) / 1000));
}
