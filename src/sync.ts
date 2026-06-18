import { getHistory, getSettings, saveHistory } from './storage';
import type { RemoteRun, SavedRun, UserSettings } from './types';

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Phản hồi không phải JSON: ' + text.slice(0, 120));
  }
  return json;
}

export async function testApi(settings?: UserSettings): Promise<string> {
  const current = settings ?? await getSettings();
  const url = `${current.apiUrl}?action=ping&api_key=${encodeURIComponent(current.apiKey)}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.success) throw new Error(json.error || 'API trả về lỗi.');
  return json.server_time || 'Kết nối thành công';
}

/** Đăng ký tài khoản mới. Trả về authToken. */
export async function registerAccount(
  settings: UserSettings,
  username: string,
  password: string,
): Promise<string> {
  const json = await postJson(settings.apiUrl, {
    api_key: settings.apiKey,
    action: 'register',
    username: username.trim().toLowerCase(),
    password,
  });
  if (!json.success) throw new Error(json.error || 'Đăng ký thất bại.');
  return json.token as string;
}

/** Đăng nhập. Trả về authToken. */
export async function loginAccount(
  settings: UserSettings,
  username: string,
  password: string,
): Promise<string> {
  const json = await postJson(settings.apiUrl, {
    api_key: settings.apiKey,
    action: 'login',
    username: username.trim().toLowerCase(),
    password,
  });
  if (!json.success) throw new Error(json.error || 'Đăng nhập thất bại.');
  return json.token as string;
}

export async function syncRun(run: SavedRun, settings?: UserSettings): Promise<SavedRun> {
  const current = settings ?? await getSettings();
  try {
    const json = await postJson(current.apiUrl, {
      api_key: current.apiKey,
      action: 'save_run',
      username: current.username || '',
      token: current.authToken || '',
      run: {
        run_id: run.run_id,
        username: run.username,
        activity: run.activity,
        date: run.date,
        started_at: run.started_at,
        ended_at: run.ended_at,
        duration_seconds: run.duration_seconds,
        moving_seconds: run.moving_seconds,
        pause_seconds: run.pause_seconds,
        distance_km: run.distance_km,
        avg_pace_seconds_per_km: run.avg_pace_seconds_per_km,
        best_pace_seconds_per_km: run.best_pace_seconds_per_km,
        avg_speed_kmh: run.avg_speed_kmh,
        max_speed_kmh: run.max_speed_kmh,
        calories: run.calories,
        weight_kg: run.weight_kg,
        steps: run.steps,
        avg_cadence: run.avg_cadence,
        max_cadence: run.max_cadence,
        avg_heart_rate: run.avg_heart_rate,
        max_heart_rate: run.max_heart_rate,
        elevation_gain_m: run.elevation_gain_m,
        elevation_loss_m: run.elevation_loss_m,
        location_count: run.location_count,
        route_data: run.route_data,
        device_id: run.device_id,
        app_version: run.app_version,
      },
    });
    if (!json.success) throw new Error(json.error || 'Google Sheet từ chối dữ liệu.');
    return { ...run, sync_status: 'synced', sync_error: undefined };
  } catch (error) {
    return {
      ...run,
      sync_status: 'failed',
      sync_error: error instanceof Error ? error.message : 'Không thể đồng bộ',
    };
  }
}

export async function syncPendingRuns(): Promise<SavedRun[]> {
  const history = await getHistory();
  const settings = await getSettings();
  const next: SavedRun[] = [];
  for (const run of history) {
    if (run.sync_status === 'synced') next.push(run);
    else next.push(await syncRun(run, settings));
  }
  await saveHistory(next);
  return next;
}

/**
 * Kéo dữ liệu buổi tập từ Google Sheet cho tab Báo cáo (lọc theo khoảng ngày).
 * Dữ liệu chỉ của tài khoản đang đăng nhập.
 */
export async function fetchRemoteRuns(
  settings: UserSettings,
  fromDate: string,
  toDate: string,
): Promise<RemoteRun[]> {
  const params = new URLSearchParams({
    action: 'report',
    api_key: settings.apiKey,
    username: settings.username || '',
    token: settings.authToken || '',
    from: fromDate,
    to: toDate,
  });
  const response = await fetch(`${settings.apiUrl}?${params.toString()}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.success) throw new Error(json.error || 'Không lấy được báo cáo.');
  return (json.runs || []) as RemoteRun[];
}
