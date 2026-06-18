import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_API_KEY, DEFAULT_API_URL } from './config';
import type { ActiveRunState, SavedRun, UserSettings } from './types';

const SETTINGS_KEY = 'runpulse.settings.v1';
const ACTIVE_RUN_KEY = 'runpulse.active.v1';
const HISTORY_KEY = 'runpulse.history.v1';

export const DEFAULT_SETTINGS: UserSettings = {
  weightKg: 70,
  heightCm: null,
  ageYears: null,
  sex: 'unspecified',
  activity: 'run',
  apiUrl: DEFAULT_API_URL,
  apiKey: DEFAULT_API_KEY,
  username: '',
  authToken: '',
};

export const EMPTY_ACTIVE_RUN: ActiveRunState = {
  status: 'idle',
  activity: 'run',
  runId: '',
  startedAt: 0,
  endedAt: null,
  pausedAt: null,
  totalPausedMs: 0,
  lastAcceptedAt: null,
  lastLatitude: null,
  lastLongitude: null,
  lastAltitude: null,
  smoothedSpeedKmh: 0,
  distanceKm: 0,
  calories: 0,
  maxSpeedKmh: 0,
  bestPaceSecondsPerKm: null,
  elevationGainM: 0,
  elevationLossM: 0,
  locationCount: 0,
  route: [],
  steps: 0,
  currentCadence: 0,
  maxCadence: 0,
  cadenceSamples: [],
};

export async function getSettings(): Promise<UserSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function getActiveRun(): Promise<ActiveRunState> {
  const raw = await AsyncStorage.getItem(ACTIVE_RUN_KEY);
  if (!raw) return { ...EMPTY_ACTIVE_RUN };
  try {
    return { ...EMPTY_ACTIVE_RUN, ...JSON.parse(raw) };
  } catch {
    return { ...EMPTY_ACTIVE_RUN };
  }
}

export async function saveActiveRun(run: ActiveRunState): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify(run));
}

export async function clearActiveRun(): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify(EMPTY_ACTIVE_RUN));
}

export async function getHistory(): Promise<SavedRun[]> {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveHistory(history: SavedRun[]): Promise<void> {
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 300)));
}

export async function prependRun(run: SavedRun): Promise<SavedRun[]> {
  const history = await getHistory();
  const next = [run, ...history.filter((item) => item.run_id !== run.run_id)].slice(0, 300);
  await saveHistory(next);
  return next;
}
