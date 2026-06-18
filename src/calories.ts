/**
 * RunPulse — Mô hình năng lượng (calo).
 *
 * Chạy bộ: dùng phương trình ACSM cho running VO2 (ml/kg/phút):
 *     VO2 = 0.2 * v + 0.9 * v * grade + 3.5
 *   với v = tốc độ tính bằng m/phút, grade = độ dốc (tỉ lệ, vd 0.05 = 5%).
 *   Phương trình này nội suy mượt theo tốc độ (không bị nhảy bậc như bảng MET)
 *   và CÓ tính độ dốc — chạy lên dốc tốn calo hơn hẳn.
 *
 * Đạp xe: dùng MET nội suy theo tốc độ (Compendium of Physical Activity 2011),
 *   cộng thêm phần grade quy đổi sang công cơ học.
 *
 * Từ VO2 -> kcal: 1 lít O2 ≈ 5 kcal; kcal/phút = VO2(ml/kg/ph) * kg / 1000 * 5.
 * Ta tính ACTIVE calories nên trừ đi 1 MET (3.5 ml/kg/phút) chuyển hoá nghỉ.
 *
 * Khi có profile (tuổi, giới, chiều cao) ta hiệu chỉnh nhẹ theo tỉ lệ BMR thực tế
 * so với BMR của người tham chiếu 70kg, để cá nhân hoá. Nếu chỉ có cân nặng,
 * hệ số hiệu chỉnh = 1 (vẫn chạy bình thường).
 */

export type Activity = 'run' | 'bike';
export type Sex = 'male' | 'female' | 'unspecified';

export interface CalorieProfile {
  weightKg: number;
  heightCm?: number | null;
  ageYears?: number | null;
  sex?: Sex;
}

const KCAL_PER_LITRE_O2 = 5;
const RESTING_VO2 = 3.5; // ml/kg/phút = 1 MET

/** Mifflin-St Jeor BMR (kcal/ngày). Trả về null nếu thiếu dữ liệu. */
export function bmrPerDay(profile: CalorieProfile): number | null {
  const { weightKg, heightCm, ageYears, sex } = profile;
  if (!weightKg || !heightCm || !ageYears || !sex || sex === 'unspecified') {
    return null;
  }
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === 'male' ? base + 5 : base - 161;
}

/**
 * Hệ số cá nhân hoá dựa trên BMR thực tế so với người tham chiếu cùng cân nặng
 * (nam 30 tuổi, cao 170cm). Giới hạn 0.85–1.15 để tránh lệch phi lý.
 */
export function personalFactor(profile: CalorieProfile): number {
  const actual = bmrPerDay(profile);
  if (actual == null) return 1;
  const reference =
    bmrPerDay({ weightKg: profile.weightKg, heightCm: 170, ageYears: 30, sex: 'male' }) ?? actual;
  if (reference <= 0) return 1;
  const ratio = actual / reference;
  return Math.min(1.15, Math.max(0.85, ratio));
}

/** VO2 (ml/kg/phút) khi chạy bộ theo ACSM, đã tính độ dốc. */
export function runningVO2(speedKmh: number, grade = 0): number {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return RESTING_VO2;
  const vMetersPerMin = (speedKmh * 1000) / 60;
  // Khi xuống dốc, hệ số grade chỉ còn ~50% tác dụng (cơ thể vẫn tốn sức ghìm).
  const g = grade >= 0 ? grade : grade * 0.5;
  const vo2 = 0.2 * vMetersPerMin + 0.9 * vMetersPerMin * g + RESTING_VO2;
  return Math.max(RESTING_VO2, vo2);
}

/**
 * MET đạp xe nội suy theo tốc độ (Compendium 2011, đường bằng).
 * Các mốc: <16:4.0, 16:6.8, 19:8.0, 22:10.0, 25:12.0, 30:15.8, ≥35:16.8.
 */
function cyclingMetFlat(speedKmh: number): number {
  const pts: [number, number][] = [
    [0, 3.0], [13, 4.0], [16, 6.8], [19, 8.0], [22, 10.0],
    [25, 12.0], [30, 15.8], [35, 16.8], [45, 18.0],
  ];
  if (speedKmh <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (speedKmh <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const t = (speedKmh - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

/** VO2 (ml/kg/phút) khi đạp xe, cộng phần leo dốc quy đổi. */
export function cyclingVO2(speedKmh: number, grade = 0): number {
  if (!Number.isFinite(speedKmh) || speedKmh <= 0) return RESTING_VO2;
  const flatVO2 = cyclingMetFlat(speedKmh) * RESTING_VO2;
  // Công leo dốc: m*g*sin ≈ m*g*grade; quy đổi sang VO2 với hiệu suất cơ ~22%.
  // P_climb (W/kg) = 9.81 * grade * v(m/s); VO2 thêm ≈ P/kg / 0.0697 (1 ml O2/kg/ph ~ 0.0697 W/kg ở eff 22%).
  const g = grade > 0 ? grade : 0;
  const vMs = (speedKmh * 1000) / 3600;
  const climbWattsPerKg = 9.81 * g * vMs;
  const climbVO2 = climbWattsPerKg / 0.0697;
  return Math.max(RESTING_VO2, flatVO2 + climbVO2);
}

export function vo2ForActivity(activity: Activity, speedKmh: number, grade = 0): number {
  return activity === 'bike' ? cyclingVO2(speedKmh, grade) : runningVO2(speedKmh, grade);
}

/**
 * Calo chủ động (kcal) cho một đoạn, có độ dốc và cá nhân hoá.
 * grade = chênh cao / quãng đường ngang (tỉ lệ). durationSeconds = thời gian đoạn.
 */
export function activeCaloriesForSegment(
  profile: CalorieProfile,
  speedKmh: number,
  durationSeconds: number,
  grade = 0,
  activity: Activity = 'run',
): number {
  const weightKg = profile.weightKg;
  if (weightKg <= 0 || durationSeconds <= 0) return 0;
  const vo2 = vo2ForActivity(activity, speedKmh, grade);
  const activeVO2 = Math.max(0, vo2 - RESTING_VO2); // trừ chuyển hoá nghỉ
  const minutes = durationSeconds / 60;
  const kcal = (activeVO2 * weightKg) / 1000 * KCAL_PER_LITRE_O2 * minutes;
  return Math.max(0, kcal * personalFactor(profile));
}

export function formatPace(secondsPerKm: number | null | undefined): string {
  if (!secondsPerKm || !Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    return '--:--';
  }
  const rounded = Math.round(secondsPerKm);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}
