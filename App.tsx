import './src/tracking';

import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { Pedometer } from 'expo-sensors';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { formatDuration, formatPace } from './src/calories';
import type { Activity, Sex } from './src/calories';
import { buildSavedRun } from './src/runBuilder';
import {
  applyFilters,
  bucketByDay,
  computeStats,
  shiftDate,
} from './src/report';
import {
  clearActiveRun,
  EMPTY_ACTIVE_RUN,
  getActiveRun,
  getHistory,
  getSettings,
  prependRun,
  saveActiveRun,
  saveHistory,
  saveSettings,
} from './src/storage';
import {
  fetchRemoteRuns,
  loginAccount,
  registerAccount,
  syncPendingRuns,
  syncRun,
  testApi,
} from './src/sync';
import {
  elapsedSeconds,
  requestTrackingPermissions,
  startBackgroundTracking,
  stopBackgroundTracking,
} from './src/tracking';
import type {
  ActiveRunState,
  DailySummary,
  RemoteRun,
  ReportFilters,
  SavedRun,
  UserSettings,
} from './src/types';

type TabKey = 'run' | 'history' | 'report' | 'settings';

function localDateKey(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function numberOrZero(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const ACTIVITY_LABEL: Record<Activity, string> = { run: 'Chạy bộ', bike: 'Đạp xe' };

function AppContent() {
  const [tab, setTab] = useState<TabKey>('run');
  const [active, setActive] = useState<ActiveRunState>({ ...EMPTY_ACTIVE_RUN });
  const [history, setHistory] = useState<SavedRun[]>([]);
  const [settings, setSettingsState] = useState<UserSettings>({
    weightKg: 70,
    heightCm: null,
    ageYears: null,
    sex: 'unspecified',
    activity: 'run',
    apiUrl: '',
    apiKey: '',
    username: '',
    authToken: '',
  });

  // Profile / settings form
  const [weightInput, setWeightInput] = useState('70');
  const [heightInput, setHeightInput] = useState('');
  const [ageInput, setAgeInput] = useState('');
  const [sexInput, setSexInput] = useState<Sex>('unspecified');
  const [apiUrlInput, setApiUrlInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');

  // Auth form
  const [authUser, setAuthUser] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // Activity selection for next run
  const [selectedActivity, setSelectedActivity] = useState<Activity>('run');

  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [apiStatus, setApiStatus] = useState('Chưa kiểm tra kết nối');
  const [loaded, setLoaded] = useState(false);

  // Report state
  const [reportRuns, setReportRuns] = useState<RemoteRun[]>([]);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState('');
  const [rangePreset, setRangePreset] = useState<'7' | '30' | '90'>('30');
  const [filterActivity, setFilterActivity] = useState<Activity | 'all'>('all');
  const [filterMinKm, setFilterMinKm] = useState('0');
  const [filterMaxPace, setFilterMaxPace] = useState('');

  const pedometerSubscription = useRef<{ remove: () => void } | null>(null);
  const pedometerBaseSteps = useRef(0);
  const cadenceSample = useRef({ steps: 0, at: Date.now() });

  const refreshAll = useCallback(async () => {
    const [storedSettings, storedActive, storedHistory] = await Promise.all([
      getSettings(),
      getActiveRun(),
      getHistory(),
    ]);
    setSettingsState(storedSettings);
    setWeightInput(String(storedSettings.weightKg));
    setHeightInput(storedSettings.heightCm ? String(storedSettings.heightCm) : '');
    setAgeInput(storedSettings.ageYears ? String(storedSettings.ageYears) : '');
    setSexInput(storedSettings.sex);
    setApiUrlInput(storedSettings.apiUrl);
    setApiKeyInput(storedSettings.apiKey);
    setSelectedActivity(storedSettings.activity);
    setActive(storedActive);
    setHistory(storedHistory);
    setLoaded(true);
  }, []);

  useEffect(() => {
    refreshAll().catch((error) => {
      Alert.alert('Không thể tải dữ liệu', error instanceof Error ? error.message : String(error));
    });
  }, [refreshAll]);

  useEffect(() => {
    const interval = setInterval(async () => {
      setNow(Date.now());
      const latest = await getActiveRun();
      setActive(latest);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshAll().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [refreshAll]);

  useEffect(() => {
    pedometerSubscription.current?.remove();
    pedometerSubscription.current = null;

    if (active.status !== 'running') return;

    let cancelled = false;
    const subscribe = async () => {
      try {
        const available = await Pedometer.isAvailableAsync();
        if (!available || cancelled) return;
        const permission = await Pedometer.requestPermissionsAsync();
        if (!permission.granted || cancelled) return;

        const latest = await getActiveRun();
        pedometerBaseSteps.current = latest.steps;
        cadenceSample.current = { steps: 0, at: Date.now() };

        pedometerSubscription.current = Pedometer.watchStepCount(async ({ steps }) => {
          const timestamp = Date.now();
          const previous = cadenceSample.current;
          const deltaSeconds = (timestamp - previous.at) / 1000;
          let cadence: number | null = null;

          if (deltaSeconds >= 5 && steps >= previous.steps) {
            cadence = (steps - previous.steps) / deltaSeconds * 60;
            cadenceSample.current = { steps, at: timestamp };
          }

          const run = await getActiveRun();
          if (run.status !== 'running') return;
          const totalSteps = Math.max(run.steps, pedometerBaseSteps.current + steps);
          const validCadence = cadence != null && cadence >= 40 && cadence <= 240 ? cadence : null;
          const next: ActiveRunState = {
            ...run,
            steps: totalSteps,
            currentCadence: validCadence ?? run.currentCadence,
            maxCadence: validCadence != null ? Math.max(run.maxCadence, validCadence) : run.maxCadence,
            cadenceSamples: validCadence != null
              ? [...run.cadenceSamples.slice(-59), validCadence]
              : run.cadenceSamples,
          };
          await saveActiveRun(next);
          setActive(next);
        });
      } catch {
        // Pedometer is optional; GPS tracking continues normally.
      }
    };
    subscribe();

    return () => {
      cancelled = true;
      pedometerSubscription.current?.remove();
      pedometerSubscription.current = null;
    };
  }, [active.status]);

  useEffect(() => {
    if (!loaded) return;
    syncPendingRuns()
      .then(setHistory)
      .catch(() => undefined);
  }, [loaded]);

  const movingSeconds = elapsedSeconds(active, now);
  const averagePace = active.distanceKm > 0 ? movingSeconds / active.distanceKm : 0;
  const averageSpeed = movingSeconds > 0 ? active.distanceKm / (movingSeconds / 3600) : 0;
  const isBike = active.activity === 'bike';

  const todaySummary = useMemo<DailySummary>(() => {
    const date = localDateKey();
    const runs = history.filter((run) => run.date === date);
    return {
      date,
      runCount: runs.length,
      totalDistanceKm: runs.reduce((sum, run) => sum + run.distance_km, 0),
      totalDurationSeconds: runs.reduce((sum, run) => sum + run.moving_seconds, 0),
      totalCalories: runs.reduce((sum, run) => sum + run.calories, 0),
      totalSteps: runs.reduce((sum, run) => sum + run.steps, 0),
    };
  }, [history]);

  const startRun = async () => {
    const weightKg = numberOrZero(weightInput);
    if (weightKg < 30 || weightKg > 250) {
      Alert.alert('Cân nặng chưa hợp lệ', 'Hãy nhập cân nặng từ 30 đến 250 kg trong tab Cài đặt.');
      return;
    }

    setBusy(true);
    try {
      const granted = await requestTrackingPermissions();
      if (!granted) {
        Alert.alert('Cần quyền vị trí', 'Ứng dụng cần GPS để tính quãng đường, pace và calo.');
        return;
      }
      const nextSettings = { ...settings, weightKg, activity: selectedActivity };
      await saveSettings(nextSettings);
      setSettingsState(nextSettings);

      const timestamp = Date.now();
      const next: ActiveRunState = {
        ...EMPTY_ACTIVE_RUN,
        status: 'running',
        activity: selectedActivity,
        runId: `run_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
        startedAt: timestamp,
      };
      await saveActiveRun(next);
      setActive(next);
      await startBackgroundTracking();
    } catch (error) {
      await clearActiveRun();
      setActive({ ...EMPTY_ACTIVE_RUN });
      Alert.alert('Không thể bắt đầu', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const pauseRun = async () => {
    setBusy(true);
    try {
      await stopBackgroundTracking();
      const latest = await getActiveRun();
      const next = { ...latest, status: 'paused' as const, pausedAt: Date.now(), currentCadence: 0 };
      await saveActiveRun(next);
      setActive(next);
    } finally {
      setBusy(false);
    }
  };

  const resumeRun = async () => {
    setBusy(true);
    try {
      const latest = await getActiveRun();
      const timestamp = Date.now();
      const next: ActiveRunState = {
        ...latest,
        status: 'running',
        totalPausedMs: latest.totalPausedMs + (latest.pausedAt ? timestamp - latest.pausedAt : 0),
        pausedAt: null,
        lastAcceptedAt: null,
        lastLatitude: null,
        lastLongitude: null,
        lastAltitude: null,
        smoothedSpeedKmh: 0,
      };
      await saveActiveRun(next);
      setActive(next);
      await startBackgroundTracking();
    } catch (error) {
      Alert.alert('Không thể tiếp tục', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const finishRun = async () => {
    const latest = await getActiveRun();
    if (latest.status === 'idle') return;

    Alert.alert('Kết thúc buổi tập?', 'Dữ liệu sẽ được lưu trên máy và đồng bộ lên Google Sheet.', [
      { text: 'Tiếp tục', style: 'cancel' },
      {
        text: 'Kết thúc',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await stopBackgroundTracking();
            const endedAt = Date.now();
            const current = await getActiveRun();
            const normalized: ActiveRunState = current.status === 'paused'
              ? {
                  ...current,
                  status: 'running',
                  totalPausedMs: current.totalPausedMs + (current.pausedAt ? endedAt - current.pausedAt : 0),
                  pausedAt: null,
                }
              : current;

            if (normalized.locationCount < 2 || normalized.distanceKm < 0.01) {
              Alert.alert('Chưa đủ dữ liệu GPS', 'Buổi tập quá ngắn nên chưa được lưu.');
              await clearActiveRun();
              setActive({ ...EMPTY_ACTIVE_RUN });
              return;
            }

            const saved = await buildSavedRun(normalized, settings, endedAt);
            let nextHistory = await prependRun(saved);
            setHistory(nextHistory);
            await clearActiveRun();
            setActive({ ...EMPTY_ACTIVE_RUN });

            const synced = await syncRun(saved, settings);
            nextHistory = nextHistory.map((item) => item.run_id === synced.run_id ? synced : item);
            await saveHistory(nextHistory);
            setHistory(nextHistory);
            setTab('history');
          } catch (error) {
            Alert.alert('Không thể lưu buổi tập', error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const saveSettingsForm = async () => {
    const weightKg = numberOrZero(weightInput);
    if (weightKg < 30 || weightKg > 250) {
      Alert.alert('Cân nặng chưa hợp lệ', 'Hãy nhập cân nặng từ 30 đến 250 kg.');
      return;
    }
    if (!apiUrlInput.trim().startsWith('https://script.google.com/')) {
      Alert.alert('URL chưa hợp lệ', 'Hãy dùng Web app URL kết thúc bằng /exec.');
      return;
    }
    if (!apiKeyInput.trim()) {
      Alert.alert('Thiếu API key', 'API key phải giống trong file Apps Script.');
      return;
    }
    const next: UserSettings = {
      ...settings,
      weightKg,
      heightCm: numberOrNull(heightInput),
      ageYears: numberOrNull(ageInput),
      sex: sexInput,
      apiUrl: apiUrlInput.trim(),
      apiKey: apiKeyInput.trim(),
    };
    await saveSettings(next);
    setSettingsState(next);
    Alert.alert('Đã lưu', 'Cấu hình đã được lưu trên điện thoại.');
  };

  const checkConnection = async () => {
    setApiStatus('Đang kiểm tra...');
    try {
      const candidate = { ...settings, apiUrl: apiUrlInput.trim(), apiKey: apiKeyInput.trim() };
      const serverTime = await testApi(candidate);
      setApiStatus(`Đã kết nối • ${serverTime}`);
    } catch (error) {
      setApiStatus(`Lỗi: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const doAuth = async (mode: 'login' | 'register') => {
    if (!authUser.trim() || !authPass) {
      Alert.alert('Thiếu thông tin', 'Nhập tên đăng nhập và mật khẩu.');
      return;
    }
    if (authPass.length < 6) {
      Alert.alert('Mật khẩu quá ngắn', 'Mật khẩu cần ít nhất 6 ký tự.');
      return;
    }
    setAuthBusy(true);
    try {
      const candidate = { ...settings, apiUrl: apiUrlInput.trim() || settings.apiUrl, apiKey: apiKeyInput.trim() || settings.apiKey };
      const token = mode === 'register'
        ? await registerAccount(candidate, authUser, authPass)
        : await loginAccount(candidate, authUser, authPass);
      const next: UserSettings = { ...candidate, username: authUser.trim().toLowerCase(), authToken: token };
      await saveSettings(next);
      setSettingsState(next);
      setAuthPass('');
      Alert.alert(mode === 'register' ? 'Đăng ký thành công' : 'Đăng nhập thành công', `Xin chào ${next.username}!`);
    } catch (error) {
      Alert.alert('Thất bại', error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = async () => {
    const next = { ...settings, username: '', authToken: '' };
    await saveSettings(next);
    setSettingsState(next);
    setReportRuns([]);
  };

  const syncAll = async () => {
    setSyncing(true);
    try {
      const next = await syncPendingRuns();
      setHistory(next);
      const failed = next.filter((run) => run.sync_status !== 'synced').length;
      Alert.alert(failed ? 'Đồng bộ chưa hoàn tất' : 'Đồng bộ hoàn tất', failed ? `${failed} buổi vẫn chưa gửi được.` : 'Tất cả dữ liệu đã có trên Google Sheet.');
    } finally {
      setSyncing(false);
    }
  };

  const rangeDays = useMemo(() => Number(rangePreset), [rangePreset]);
  const reportFilters = useMemo<ReportFilters>(() => {
    const today = new Date();
    return {
      activity: filterActivity,
      fromDate: shiftDate(today, -(rangeDays - 1)),
      toDate: localDateKey(),
      minDistanceKm: numberOrZero(filterMinKm),
      maxPaceSecondsPerKm: filterMaxPace.trim()
        ? (() => {
            const parts = filterMaxPace.split(':');
            if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
            return numberOrZero(filterMaxPace) * 60;
          })()
        : null,
    };
  }, [filterActivity, rangeDays, filterMinKm, filterMaxPace]);

  const loadReport = useCallback(async () => {
    if (!settings.username || !settings.authToken) {
      setReportError('Hãy đăng nhập ở tab Cài đặt để xem báo cáo từ Google Sheet.');
      return;
    }
    setReportBusy(true);
    setReportError('');
    try {
      const today = new Date();
      const from = shiftDate(today, -89); // tải tối đa 90 ngày, lọc tại client
      const runs = await fetchRemoteRuns(settings, from, localDateKey());
      setReportRuns(runs);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : String(error));
    } finally {
      setReportBusy(false);
    }
  }, [settings]);

  useEffect(() => {
    if (tab === 'report' && settings.username && reportRuns.length === 0 && !reportBusy && !reportError) {
      loadReport();
    }
  }, [tab, settings.username, reportRuns.length, reportBusy, reportError, loadReport]);

  const filtered = useMemo(() => applyFilters(reportRuns, reportFilters), [reportRuns, reportFilters]);
  const stats = useMemo(() => computeStats(filtered), [filtered]);
  const buckets = useMemo(
    () => bucketByDay(filtered, reportFilters.fromDate, reportFilters.toDate),
    [filtered, reportFilters.fromDate, reportFilters.toDate],
  );

  if (!loaded) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" />
        <Text style={styles.loadingText}>Đang tải RunPulse...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <LinearGradient colors={['#101D37', '#152B50']} style={styles.header}>
        <View>
          <Text style={styles.brand}>RUNPULSE</Text>
          <Text style={styles.brandSub}>{settings.username ? `@${settings.username}` : 'Chạy bộ • Đạp xe • Calo'}</Text>
        </View>
        <View style={styles.syncPill}>
          <View style={[styles.syncDot, history.some((run) => run.sync_status !== 'synced') && styles.syncDotPending]} />
          <Text style={styles.syncPillText}>{history.some((run) => run.sync_status !== 'synced') ? 'Chờ sync' : 'Đã sync'}</Text>
        </View>
      </LinearGradient>

      <View style={styles.content}>
        {tab === 'run' && (
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.todayCard}>
              <View>
                <Text style={styles.sectionEyebrow}>HÔM NAY</Text>
                <Text style={styles.todayDate}>{new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit' })}</Text>
              </View>
              <View style={styles.todayStatsRow}>
                <MiniStat label="Lượt tập" value={String(todaySummary.runCount)} />
                <MiniStat label="Quãng đường" value={`${todaySummary.totalDistanceKm.toFixed(2)} km`} />
                <MiniStat label="Calo" value={`${Math.round(todaySummary.totalCalories)}`} />
              </View>
            </View>

            {active.status === 'idle' && (
              <View style={styles.activityRow}>
                {(['run', 'bike'] as Activity[]).map((act) => (
                  <TouchableOpacity
                    key={act}
                    style={[styles.activityChip, selectedActivity === act && styles.activityChipActive]}
                    onPress={() => setSelectedActivity(act)}
                  >
                    <Text style={[styles.activityChipText, selectedActivity === act && styles.activityChipTextActive]}>
                      {act === 'run' ? '🏃 Chạy bộ' : '🚴 Đạp xe'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={[styles.liveCard, active.status !== 'idle' && styles.liveCardActive]}>
              <View style={styles.statusRow}>
                <View style={[styles.statusBadge, active.status === 'running' && styles.statusRunning, active.status === 'paused' && styles.statusPaused]}>
                  <Text style={styles.statusText}>{active.status === 'running' ? `ĐANG ${ACTIVITY_LABEL[active.activity].toUpperCase()}` : active.status === 'paused' ? 'TẠM DỪNG' : 'SẴN SÀNG'}</Text>
                </View>
                <Text style={styles.gpsHint}>{active.status === 'idle' ? 'GPS sẽ bật khi bắt đầu' : `${active.locationCount} điểm GPS`}</Text>
              </View>

              <Text style={styles.timer}>{formatDuration(movingSeconds)}</Text>
              <Text style={styles.distance}>{active.distanceKm.toFixed(2)} <Text style={styles.distanceUnit}>km</Text></Text>

              <View style={styles.metricGrid}>
                <Metric label={isBike ? 'TỐC ĐỘ TB' : 'PACE TB'} value={isBike ? averageSpeed.toFixed(1) : formatPace(averagePace)} suffix={isBike ? 'km/h' : '/km'} />
                <Metric label="CALO" value={String(Math.round(active.calories))} suffix="kcal" />
                <Metric label="TỐC ĐỘ" value={averageSpeed.toFixed(1)} suffix="km/h" />
                <Metric label={isBike ? 'LEO DỐC' : 'CADENCE'} value={isBike ? String(Math.round(active.elevationGainM)) : (active.currentCadence > 0 ? String(Math.round(active.currentCadence)) : '--')} suffix={isBike ? 'm' : 'spm'} />
              </View>

              {active.status === 'idle' ? (
                <TouchableOpacity style={styles.startButton} onPress={startRun} disabled={busy}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.startButtonText}>BẮT ĐẦU {ACTIVITY_LABEL[selectedActivity].toUpperCase()}</Text>}
                </TouchableOpacity>
              ) : (
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={styles.secondaryAction}
                    onPress={active.status === 'running' ? pauseRun : resumeRun}
                    disabled={busy}
                  >
                    <Text style={styles.secondaryActionText}>{active.status === 'running' ? 'TẠM DỪNG' : 'TIẾP TỤC'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.stopAction} onPress={finishRun} disabled={busy}>
                    <Text style={styles.stopActionText}>KẾT THÚC</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>Cách app tính calo</Text>
              <Text style={styles.infoText}>Calo được cộng theo từng đoạn GPS bằng phương trình ACSM (chạy) / MET nội suy (đạp xe), có tính tốc độ đã làm mượt VÀ độ dốc. Nếu nhập thêm tuổi, giới tính, chiều cao, app hiệu chỉnh thêm theo chỉ số trao đổi chất cơ bản của bro.</Text>
              <Text style={styles.infoFoot}>Cadence chỉ cập nhật khi app hiển thị; GPS, pace và calo vẫn chạy nền khi tắt màn hình.</Text>
            </View>
          </ScrollView>
        )}

        {tab === 'history' && (
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.historyHeader}>
              <View>
                <Text style={styles.pageTitle}>Lịch sử</Text>
                <Text style={styles.pageSub}>{history.length} buổi lưu trên máy</Text>
              </View>
              <TouchableOpacity style={styles.syncButton} onPress={syncAll} disabled={syncing}>
                {syncing ? <ActivityIndicator size="small" /> : <Text style={styles.syncButtonText}>Đồng bộ</Text>}
              </TouchableOpacity>
            </View>

            {history.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>Chưa có buổi tập</Text>
                <Text style={styles.emptyText}>Kết thúc buổi tập đầu tiên để xem tại đây.</Text>
              </View>
            ) : history.map((run) => (
              <View key={run.run_id} style={styles.runCard}>
                <View style={styles.runCardTop}>
                  <View>
                    <Text style={styles.runDate}>{run.activity === 'bike' ? '🚴 ' : '🏃 '}{new Date(run.started_at).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })}</Text>
                    <Text style={styles.runTime}>{new Date(run.started_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</Text>
                  </View>
                  <View style={[styles.runSyncBadge, run.sync_status !== 'synced' && styles.runSyncBadgePending]}>
                    <Text style={styles.runSyncText}>{run.sync_status === 'synced' ? 'Sheet ✓' : 'Chờ sync'}</Text>
                  </View>
                </View>
                <Text style={styles.runDistance}>{run.distance_km.toFixed(2)} km</Text>
                <View style={styles.runMetrics}>
                  <MiniStat label="Thời gian" value={formatDuration(run.moving_seconds)} dark />
                  <MiniStat label={run.activity === 'bike' ? 'Tốc độ' : 'Pace'} value={run.activity === 'bike' ? `${run.avg_speed_kmh.toFixed(1)} km/h` : `${formatPace(run.avg_pace_seconds_per_km)}/km`} dark />
                  <MiniStat label="Calo" value={`${Math.round(run.calories)} kcal`} dark />
                </View>
                <View style={styles.runFooter}>
                  <Text style={styles.runFooterText}>{run.steps.toLocaleString('vi-VN')} bước</Text>
                  <Text style={styles.runFooterText}>↗ {Math.round(run.elevation_gain_m)} m</Text>
                  <Text style={styles.runFooterText}>Max {run.max_speed_kmh.toFixed(1)} km/h</Text>
                </View>
                {run.sync_error ? <Text style={styles.errorText}>{run.sync_error}</Text> : null}
              </View>
            ))}
          </ScrollView>
        )}

        {tab === 'report' && (
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.historyHeader}>
              <View>
                <Text style={styles.pageTitle}>Báo cáo</Text>
                <Text style={styles.pageSub}>Dữ liệu từ Google Sheet</Text>
              </View>
              <TouchableOpacity style={styles.syncButton} onPress={loadReport} disabled={reportBusy}>
                {reportBusy ? <ActivityIndicator size="small" /> : <Text style={styles.syncButtonText}>Tải lại</Text>}
              </TouchableOpacity>
            </View>

            {!settings.username ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyTitle}>Cần đăng nhập</Text>
                <Text style={styles.emptyText}>Vào tab Cài đặt để đăng nhập, rồi quay lại đây xem báo cáo tổng hợp.</Text>
              </View>
            ) : (
              <>
                <View style={styles.filterCard}>
                  <Text style={styles.filterLabel}>Khoảng thời gian</Text>
                  <View style={styles.segmentRow}>
                    {(['7', '30', '90'] as const).map((preset) => (
                      <TouchableOpacity key={preset} style={[styles.segment, rangePreset === preset && styles.segmentActive]} onPress={() => setRangePreset(preset)}>
                        <Text style={[styles.segmentText, rangePreset === preset && styles.segmentTextActive]}>{preset} ngày</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={styles.filterLabel}>Môn</Text>
                  <View style={styles.segmentRow}>
                    {([['all', 'Tất cả'], ['run', '🏃 Chạy'], ['bike', '🚴 Đạp']] as [Activity | 'all', string][]).map(([val, label]) => (
                      <TouchableOpacity key={val} style={[styles.segment, filterActivity === val && styles.segmentActive]} onPress={() => setFilterActivity(val)}>
                        <Text style={[styles.segmentText, filterActivity === val && styles.segmentTextActive]}>{label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <View style={styles.filterInputsRow}>
                    <View style={styles.filterInputBox}>
                      <Text style={styles.filterLabel}>Cự ly tối thiểu (km)</Text>
                      <TextInput style={styles.inputSmall} value={filterMinKm} onChangeText={setFilterMinKm} keyboardType="decimal-pad" placeholder="0" />
                    </View>
                    <View style={styles.filterInputBox}>
                      <Text style={styles.filterLabel}>Pace tối đa (mm:ss)</Text>
                      <TextInput style={styles.inputSmall} value={filterMaxPace} onChangeText={setFilterMaxPace} placeholder="vd 6:30" autoCapitalize="none" />
                    </View>
                  </View>
                </View>

                {reportError ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>Không tải được</Text>
                    <Text style={styles.errorText}>{reportError}</Text>
                  </View>
                ) : (
                  <>
                    <View style={styles.summaryGrid}>
                      <SummaryCell label="Số buổi" value={String(stats.count)} />
                      <SummaryCell label="Tổng km" value={stats.totalDistanceKm.toFixed(2)} />
                      <SummaryCell label="Tổng calo" value={String(Math.round(stats.totalCalories))} />
                      <SummaryCell label="Thời gian" value={formatDuration(stats.totalMovingSeconds)} />
                      <SummaryCell label="Pace TB" value={`${formatPace(stats.avgPaceSecondsPerKm)}/km`} />
                      <SummaryCell label="Tốc độ TB" value={`${stats.avgSpeedKmh.toFixed(1)} km/h`} />
                      <SummaryCell label="Pace tốt nhất" value={stats.bestPaceSecondsPerKm ? `${formatPace(stats.bestPaceSecondsPerKm)}/km` : '--'} />
                      <SummaryCell label="Dài nhất" value={`${stats.longestKm.toFixed(2)} km`} />
                      <SummaryCell label="Tổng leo dốc" value={`${Math.round(stats.totalElevationGainM)} m`} />
                    </View>

                    <TrendChart title="Quãng đường theo ngày (km)" buckets={buckets} field="distanceKm" color="#1B9BFF" />
                    <TrendChart title="Calo theo ngày (kcal)" buckets={buckets} field="calories" color="#FF8A3D" />

                    {filtered.length === 0 && (
                      <View style={styles.emptyCard}>
                        <Text style={styles.emptyText}>Không có buổi tập nào khớp bộ lọc.</Text>
                      </View>
                    )}
                  </>
                )}
              </>
            )}
          </ScrollView>
        )}

        {tab === 'settings' && (
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
              <Text style={styles.pageTitle}>Cài đặt</Text>
              <Text style={styles.pageSub}>Thông tin dùng để tính calo và đồng bộ.</Text>

              {/* TÀI KHOẢN */}
              <View style={styles.formCard}>
                <Text style={styles.cardHeading}>Tài khoản</Text>
                {settings.username ? (
                  <>
                    <Text style={styles.loggedInText}>Đang đăng nhập: <Text style={styles.loggedInName}>@{settings.username}</Text></Text>
                    <TouchableOpacity style={styles.logoutButton} onPress={logout}>
                      <Text style={styles.logoutText}>ĐĂNG XUẤT</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <Text style={styles.inputLabel}>Tên đăng nhập</Text>
                    <TextInput style={styles.input} value={authUser} onChangeText={setAuthUser} autoCapitalize="none" autoCorrect={false} placeholder="vd: moon" />
                    <Text style={styles.inputLabel}>Mật khẩu</Text>
                    <TextInput style={styles.input} value={authPass} onChangeText={setAuthPass} secureTextEntry autoCapitalize="none" placeholder="ít nhất 6 ký tự" />
                    <View style={styles.actionRow}>
                      <TouchableOpacity style={[styles.secondaryAction, styles.flex1]} onPress={() => doAuth('login')} disabled={authBusy}>
                        {authBusy ? <ActivityIndicator size="small" color="#17679F" /> : <Text style={styles.secondaryActionText}>ĐĂNG NHẬP</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.startButton, styles.flex1, styles.noMargin]} onPress={() => doAuth('register')} disabled={authBusy}>
                        <Text style={styles.startButtonText}>ĐĂNG KÝ</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.helperText}>Cần điền API URL + key bên dưới trước khi đăng ký/đăng nhập.</Text>
                  </>
                )}
              </View>

              {/* HỒ SƠ */}
              <View style={styles.formCard}>
                <Text style={styles.cardHeading}>Hồ sơ cơ thể</Text>
                <Text style={styles.inputLabel}>Cân nặng (kg) — bắt buộc</Text>
                <TextInput style={styles.input} value={weightInput} onChangeText={setWeightInput} keyboardType="decimal-pad" placeholder="70" />

                <View style={styles.filterInputsRow}>
                  <View style={styles.filterInputBox}>
                    <Text style={styles.inputLabel}>Chiều cao (cm)</Text>
                    <TextInput style={styles.input} value={heightInput} onChangeText={setHeightInput} keyboardType="decimal-pad" placeholder="tuỳ chọn" />
                  </View>
                  <View style={styles.filterInputBox}>
                    <Text style={styles.inputLabel}>Tuổi</Text>
                    <TextInput style={styles.input} value={ageInput} onChangeText={setAgeInput} keyboardType="number-pad" placeholder="tuỳ chọn" />
                  </View>
                </View>

                <Text style={styles.inputLabel}>Giới tính</Text>
                <View style={styles.segmentRow}>
                  {([['male', 'Nam'], ['female', 'Nữ'], ['unspecified', 'Không nói']] as [Sex, string][]).map(([val, label]) => (
                    <TouchableOpacity key={val} style={[styles.segment, sexInput === val && styles.segmentActive]} onPress={() => setSexInput(val)}>
                      <Text style={[styles.segmentText, sexInput === val && styles.segmentTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.helperText}>Thêm chiều cao, tuổi, giới tính giúp calo chính xác hơn. Bỏ trống vẫn tính được theo cân nặng.</Text>
              </View>

              {/* KẾT NỐI */}
              <View style={styles.formCard}>
                <Text style={styles.cardHeading}>Google Sheet</Text>
                <Text style={styles.inputLabel}>Apps Script Web App URL</Text>
                <TextInput style={[styles.input, styles.multilineInput]} value={apiUrlInput} onChangeText={setApiUrlInput} autoCapitalize="none" autoCorrect={false} multiline />
                <Text style={styles.inputLabel}>API key</Text>
                <TextInput style={styles.input} value={apiKeyInput} onChangeText={setApiKeyInput} autoCapitalize="none" autoCorrect={false} secureTextEntry />

                <TouchableOpacity style={styles.saveButton} onPress={saveSettingsForm}>
                  <Text style={styles.saveButtonText}>LƯU CẤU HÌNH</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.testButton} onPress={checkConnection}>
                  <Text style={styles.testButtonText}>KIỂM TRA GOOGLE SHEET</Text>
                </TouchableOpacity>
                <Text style={styles.apiStatus}>{apiStatus}</Text>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        )}
      </View>

      <View style={styles.tabBar}>
        <TabButton active={tab === 'run'} label="TẬP" icon="●" onPress={() => setTab('run')} />
        <TabButton active={tab === 'history'} label="LỊCH SỬ" icon="▤" onPress={() => setTab('history')} />
        <TabButton active={tab === 'report'} label="BÁO CÁO" icon="◫" onPress={() => setTab('report')} />
        <TabButton active={tab === 'settings'} label="CÀI ĐẶT" icon="⚙" onPress={() => setTab('settings')} />
      </View>
    </SafeAreaView>
  );
}

function Metric({ label, value, suffix }: { label: string; value: string; suffix: string }) {
  return (
    <View style={styles.metricBox}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricSuffix}>{suffix}</Text>
    </View>
  );
}

function MiniStat({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) {
  return (
    <View style={styles.miniStat}>
      <Text style={[styles.miniValue, dark && styles.miniValueDark]}>{value}</Text>
      <Text style={[styles.miniLabel, dark && styles.miniLabelDark]}>{label}</Text>
    </View>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCell}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function TrendChart({ title, buckets, field, color }: { title: string; buckets: { date: string; distanceKm: number; calories: number }[]; field: 'distanceKm' | 'calories'; color: string }) {
  const values = buckets.map((b) => b[field]);
  const max = Math.max(1, ...values);
  // Hiển thị tối đa ~30 cột để khỏi rối; nếu nhiều hơn thì lấy mẫu đều.
  const step = buckets.length > 31 ? Math.ceil(buckets.length / 31) : 1;
  const shown = buckets.filter((_, i) => i % step === 0);
  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartTitle}>{title}</Text>
      <View style={styles.chartBars}>
        {shown.map((b, i) => {
          const v = b[field];
          const h = Math.max(2, (v / max) * 90);
          return (
            <View key={b.date + i} style={styles.chartBarWrap}>
              <View style={[styles.chartBar, { height: h, backgroundColor: v > 0 ? color : '#E3E9F0' }]} />
            </View>
          );
        })}
      </View>
      <View style={styles.chartAxis}>
        <Text style={styles.chartAxisText}>{shown[0]?.date.slice(5)}</Text>
        <Text style={styles.chartAxisText}>Đỉnh: {field === 'distanceKm' ? max.toFixed(1) + ' km' : Math.round(max) + ' kcal'}</Text>
        <Text style={styles.chartAxisText}>{shown[shown.length - 1]?.date.slice(5)}</Text>
      </View>
    </View>
  );
}

function TabButton({ active, label, icon, onPress }: { active: boolean; label: string; icon: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.tabButton} onPress={onPress}>
      <Text style={[styles.tabIcon, active && styles.tabActive]}>{icon}</Text>
      <Text style={[styles.tabLabel, active && styles.tabActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flex1: { flex: 1 },
  noMargin: { marginTop: 0 },
  safeArea: { flex: 1, backgroundColor: '#101D37' },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4F7FB' },
  loadingText: { marginTop: 14, color: '#4A5870', fontSize: 15 },
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { color: '#FFFFFF', fontSize: 23, fontWeight: '900', letterSpacing: 1.6 },
  brandSub: { color: '#AFC5E7', fontSize: 12, marginTop: 2 },
  syncPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.10)', borderRadius: 20, paddingHorizontal: 11, paddingVertical: 7 },
  syncDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#4EE09B', marginRight: 7 },
  syncDotPending: { backgroundColor: '#FFC45E' },
  syncPillText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  content: { flex: 1, backgroundColor: '#F4F7FB', borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' },
  scrollContent: { padding: 16, paddingBottom: 30 },
  todayCard: { backgroundColor: '#1B3054', borderRadius: 20, padding: 18, marginBottom: 14 },
  sectionEyebrow: { color: '#76D8FF', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  todayDate: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', marginTop: 4, textTransform: 'capitalize' },
  todayStatsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 18 },
  miniStat: { flex: 1 },
  miniValue: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  miniLabel: { color: '#9CB0CE', fontSize: 10, marginTop: 3 },
  miniValueDark: { color: '#152744' },
  miniLabelDark: { color: '#75829A' },
  activityRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  activityChip: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 2, borderColor: '#E3E9F0' },
  activityChipActive: { borderColor: '#1B9BFF', backgroundColor: '#EAF4FF' },
  activityChipText: { color: '#5A6B82', fontSize: 14, fontWeight: '800' },
  activityChipTextActive: { color: '#1372C9' },
  liveCard: { backgroundColor: '#FFFFFF', borderRadius: 24, padding: 18, shadowColor: '#19304F', shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 3 },
  liveCardActive: { borderWidth: 1, borderColor: '#D9E9F8' },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusBadge: { backgroundColor: '#EAF0F7', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12 },
  statusRunning: { backgroundColor: '#D9F9E8' },
  statusPaused: { backgroundColor: '#FFF0D4' },
  statusText: { color: '#2B496C', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  gpsHint: { color: '#8A96A8', fontSize: 11 },
  timer: { color: '#12243F', textAlign: 'center', fontSize: 44, fontWeight: '300', fontVariant: ['tabular-nums'], marginTop: 20 },
  distance: { color: '#10213B', textAlign: 'center', fontSize: 58, fontWeight: '900', letterSpacing: -2, marginTop: 4 },
  distanceUnit: { fontSize: 20, color: '#6E7D92', fontWeight: '700', letterSpacing: 0 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5, marginTop: 18 },
  metricBox: { width: '50%', paddingHorizontal: 5, marginBottom: 10 },
  metricLabel: { color: '#8B96A7', fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
  metricValue: { color: '#182B49', fontSize: 25, fontWeight: '900', marginTop: 4 },
  metricSuffix: { color: '#8090A7', fontSize: 11, marginTop: 1 },
  startButton: { backgroundColor: '#1B9BFF', borderRadius: 17, paddingVertical: 18, alignItems: 'center', marginTop: 12 },
  startButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900', letterSpacing: 1 },
  actionRow: { flexDirection: 'row', marginTop: 12, gap: 10 },
  secondaryAction: { flex: 1, backgroundColor: '#E9F3FC', borderRadius: 17, paddingVertical: 17, alignItems: 'center' },
  secondaryActionText: { color: '#17679F', fontSize: 13, fontWeight: '900' },
  stopAction: { flex: 1, backgroundColor: '#FFE7E5', borderRadius: 17, paddingVertical: 17, alignItems: 'center' },
  stopActionText: { color: '#C4443D', fontSize: 13, fontWeight: '900' },
  infoCard: { backgroundColor: '#EAF2FA', borderRadius: 18, padding: 16, marginTop: 14 },
  infoTitle: { color: '#173351', fontSize: 14, fontWeight: '900' },
  infoText: { color: '#53687F', fontSize: 12.5, lineHeight: 19, marginTop: 7 },
  infoFoot: { color: '#76879B', fontSize: 11, lineHeight: 16, marginTop: 8 },
  pageTitle: { color: '#132642', fontSize: 26, fontWeight: '900' },
  pageSub: { color: '#758198', fontSize: 13, marginTop: 3 },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  syncButton: { backgroundColor: '#DDEEFF', paddingHorizontal: 15, paddingVertical: 10, borderRadius: 14 },
  syncButtonText: { color: '#17679F', fontWeight: '800', fontSize: 12 },
  emptyCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 26, alignItems: 'center', marginTop: 20 },
  emptyTitle: { color: '#172A48', fontSize: 17, fontWeight: '800' },
  emptyText: { color: '#7A879B', fontSize: 13, textAlign: 'center', marginTop: 7 },
  runCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 17, marginBottom: 12 },
  runCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  runDate: { color: '#172C49', fontSize: 14, fontWeight: '800', textTransform: 'capitalize' },
  runTime: { color: '#8A95A6', fontSize: 11, marginTop: 2 },
  runSyncBadge: { backgroundColor: '#DFF8EA', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5 },
  runSyncBadgePending: { backgroundColor: '#FFF0D5' },
  runSyncText: { color: '#486073', fontSize: 9.5, fontWeight: '800' },
  runDistance: { color: '#122642', fontSize: 33, fontWeight: '900', marginTop: 13 },
  runMetrics: { flexDirection: 'row', marginTop: 13 },
  runFooter: { borderTopWidth: 1, borderTopColor: '#EDF1F5', marginTop: 14, paddingTop: 11, flexDirection: 'row', justifyContent: 'space-between' },
  runFooterText: { color: '#76849A', fontSize: 10.5 },
  errorText: { color: '#C6544E', fontSize: 11.5, marginTop: 8, textAlign: 'center', lineHeight: 17 },
  formCard: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 17, marginTop: 16 },
  cardHeading: { color: '#132642', fontSize: 16, fontWeight: '900', marginBottom: 6 },
  inputLabel: { color: '#40536C', fontSize: 12, fontWeight: '800', marginBottom: 7, marginTop: 8 },
  input: { backgroundColor: '#F3F6FA', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 13, color: '#172A45', fontSize: 14, paddingHorizontal: 13, paddingVertical: 12 },
  inputSmall: { backgroundColor: '#F3F6FA', borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 11, color: '#172A45', fontSize: 14, paddingHorizontal: 11, paddingVertical: 10 },
  multilineInput: { minHeight: 74, textAlignVertical: 'top' },
  helperText: { color: '#8290A4', fontSize: 11, lineHeight: 16, marginTop: 10 },
  loggedInText: { color: '#40536C', fontSize: 14, marginTop: 6 },
  loggedInName: { color: '#1372C9', fontWeight: '900' },
  logoutButton: { backgroundColor: '#FFE7E5', borderRadius: 13, paddingVertical: 13, alignItems: 'center', marginTop: 14 },
  logoutText: { color: '#C4443D', fontWeight: '900', fontSize: 13 },
  saveButton: { backgroundColor: '#1B9BFF', borderRadius: 14, paddingVertical: 15, alignItems: 'center', marginTop: 18 },
  saveButtonText: { color: '#FFFFFF', fontWeight: '900', fontSize: 13 },
  testButton: { backgroundColor: '#E8F2FB', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 9 },
  testButtonText: { color: '#276992', fontWeight: '900', fontSize: 12 },
  apiStatus: { color: '#718095', fontSize: 11, lineHeight: 16, marginTop: 10 },
  filterCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 15, marginBottom: 14 },
  filterLabel: { color: '#40536C', fontSize: 11.5, fontWeight: '800', marginBottom: 7, marginTop: 6 },
  segmentRow: { flexDirection: 'row', gap: 7, marginBottom: 4 },
  segment: { flex: 1, backgroundColor: '#F1F5FA', borderRadius: 11, paddingVertical: 9, alignItems: 'center' },
  segmentActive: { backgroundColor: '#1B9BFF' },
  segmentText: { color: '#5A6B82', fontSize: 12, fontWeight: '800' },
  segmentTextActive: { color: '#FFFFFF' },
  filterInputsRow: { flexDirection: 'row', gap: 10 },
  filterInputBox: { flex: 1 },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#FFFFFF', borderRadius: 18, padding: 6, marginBottom: 14 },
  summaryCell: { width: '33.33%', padding: 11, alignItems: 'center' },
  summaryValue: { color: '#132642', fontSize: 18, fontWeight: '900' },
  summaryLabel: { color: '#7A879B', fontSize: 10, marginTop: 3, textAlign: 'center' },
  chartCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, marginBottom: 14 },
  chartTitle: { color: '#172C49', fontSize: 13, fontWeight: '900', marginBottom: 14 },
  chartBars: { flexDirection: 'row', alignItems: 'flex-end', height: 96, gap: 2 },
  chartBarWrap: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  chartBar: { width: '100%', borderRadius: 3, minHeight: 2 },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 9 },
  chartAxisText: { color: '#8A96A8', fontSize: 9.5 },
  tabBar: { backgroundColor: '#FFFFFF', flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#E7ECF2', paddingBottom: Platform.OS === 'android' ? 9 : 5, paddingTop: 8 },
  tabButton: { flex: 1, alignItems: 'center' },
  tabIcon: { color: '#9AA5B5', fontSize: 18, height: 22 },
  tabLabel: { color: '#9AA5B5', fontSize: 9, fontWeight: '800', marginTop: 2 },
  tabActive: { color: '#168CE3' },
});
