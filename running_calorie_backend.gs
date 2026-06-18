/**
 * RUNNING CALORIE APP - GOOGLE APPS SCRIPT BACKEND
 * ------------------------------------------------
 * Chức năng:
 * - Nhận dữ liệu từng buổi chạy từ ứng dụng Android.
 * - Mỗi buổi chạy được lưu thành một dòng trong sheet "Runs".
 * - Tự động tổng hợp dữ liệu theo ngày vào sheet "DailySummary".
 * - Chống lưu trùng bằng run_id.
 * - Kiểm tra API key.
 * - Hỗ trợ lấy lịch sử chạy và tổng hợp theo ngày qua HTTP GET.
 *
 * CÁCH CẤU HÌNH
 * 1. Tạo một Google Sheet mới.
 * 2. Lấy SPREADSHEET_ID từ URL:
 *    https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
 * 3. Thay SPREADSHEET_ID và API_KEY trong APP_CONFIG bên dưới.
 * 4. Trong Apps Script, chạy hàm setupSheets() một lần và cấp quyền.
 * 5. Deploy > New deployment > Web app:
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 6. Copy Web app URL để dán vào ứng dụng Android.
 */

const APP_CONFIG = Object.freeze({
  SPREADSHEET_ID: 'DAN_SPREADSHEET_ID_VAO_DAY',
  API_KEY: 'THAY_BANG_MOT_CHUOI_BI_MAT_DAI_VA_KHO_DOAN',
  TIMEZONE: 'Asia/Bangkok',

  RUNS_SHEET: 'Runs',
  DAILY_SUMMARY_SHEET: 'DailySummary',
  USERS_SHEET: 'Users',

  // Một ô Google Sheet chứa tối đa khoảng 50.000 ký tự.
  MAX_ROUTE_DATA_LENGTH: 45000,
});

const USER_HEADERS = Object.freeze([
  'username',
  'password_hash',
  'salt',
  'token',
  'created_at',
  'last_login_at',
]);

const RUN_HEADERS = Object.freeze([
  'run_id',
  'username',
  'activity',
  'date',
  'start_time',
  'end_time',
  'started_at',
  'ended_at',
  'duration_seconds',
  'moving_seconds',
  'pause_seconds',
  'distance_km',
  'avg_pace_seconds_per_km',
  'avg_pace',
  'best_pace_seconds_per_km',
  'best_pace',
  'avg_speed_kmh',
  'max_speed_kmh',
  'calories',
  'weight_kg',
  'steps',
  'avg_cadence',
  'max_cadence',
  'avg_heart_rate',
  'max_heart_rate',
  'elevation_gain_m',
  'elevation_loss_m',
  'location_count',
  'route_data',
  'device_id',
  'app_version',
  'created_at',
  'updated_at',
]);

const DAILY_HEADERS = Object.freeze([
  'date',
  'run_count',
  'total_distance_km',
  'total_duration_seconds',
  'total_moving_seconds',
  'total_pause_seconds',
  'total_calories',
  'total_steps',
  'avg_pace_seconds_per_km',
  'avg_pace',
  'avg_speed_kmh',
  'avg_heart_rate',
  'total_elevation_gain_m',
  'total_elevation_loss_m',
  'updated_at',
]);

/**
 * Chạy thủ công một lần sau khi cấu hình.
 */
function setupSheets() {
  validateConfiguration_();

  const spreadsheet = getSpreadsheet_();
  spreadsheet.setSpreadsheetTimeZone(APP_CONFIG.TIMEZONE);

  const runsSheet = ensureSheet_(spreadsheet, APP_CONFIG.RUNS_SHEET, RUN_HEADERS);
  const dailySheet = ensureSheet_(
    spreadsheet,
    APP_CONFIG.DAILY_SUMMARY_SHEET,
    DAILY_HEADERS
  );
  ensureSheet_(spreadsheet, APP_CONFIG.USERS_SHEET, USER_HEADERS);

  formatRunsSheet_(runsSheet);
  formatDailySheet_(dailySheet);

  return {
    success: true,
    spreadsheet_id: spreadsheet.getId(),
    spreadsheet_url: spreadsheet.getUrl(),
    sheets: [APP_CONFIG.RUNS_SHEET, APP_CONFIG.DAILY_SUMMARY_SHEET, APP_CONFIG.USERS_SHEET],
  };
}

/**
 * Có thể chạy hàm này để kiểm tra cấu hình ngay trong Apps Script.
 */
function testConfiguration() {
  const result = setupSheets();
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * HTTP POST
 *
 * Body mẫu:
 * {
 *   "api_key": "YOUR_API_KEY",
 *   "action": "save_run",
 *   "run": {
 *     "run_id": "run_1718700000000_abcd1234",
 *     "started_at": "2026-06-18T06:30:15+07:00",
 *     "ended_at": "2026-06-18T07:02:42+07:00",
 *     "duration_seconds": 1947,
 *     "moving_seconds": 1890,
 *     "pause_seconds": 57,
 *     "distance_km": 5.16,
 *     "avg_pace_seconds_per_km": 366.28,
 *     "best_pace_seconds_per_km": 298,
 *     "avg_speed_kmh": 9.83,
 *     "max_speed_kmh": 14.2,
 *     "calories": 319,
 *     "weight_kg": 70,
 *     "steps": 6380,
 *     "avg_cadence": 168,
 *     "max_cadence": 182,
 *     "avg_heart_rate": 151,
 *     "max_heart_rate": 174,
 *     "elevation_gain_m": 42,
 *     "elevation_loss_m": 39,
 *     "location_count": 386,
 *     "route_data": "...",
 *     "device_id": "android_xxx",
 *     "app_version": "1.0.0"
 *   }
 * }
 */
function doPost(e) {
  try {
    validateConfiguration_();

    const body = parseJsonBody_(e);
    assertApiKey_(body.api_key || getParameter_(e, 'api_key'));

    const action = normalizeString_(body.action || 'save_run').toLowerCase();

    switch (action) {
      case 'register':
        return jsonResponse_(
          registerUser_(normalizeString_(body.username), normalizeString_(body.password))
        );

      case 'login':
        return jsonResponse_(
          loginUser_(normalizeString_(body.username), normalizeString_(body.password))
        );

      case 'save_run':
      case 'saverun':
        return jsonResponse_(saveRun_(body.run || body));

      case 'delete_run':
      case 'deleterun':
        return jsonResponse_(
          deleteRun_(
            normalizeString_(body.run_id),
            normalizeString_(body.confirmation)
          )
        );

      case 'rebuild_daily_summary':
      case 'rebuilddailysummary':
        return jsonResponse_(rebuildDailySummary_());

      default:
        throw new Error('Action không hợp lệ: ' + action);
    }
  } catch (error) {
    return errorResponse_(error);
  }
}

/**
 * HTTP GET
 *
 * Ví dụ:
 * ?action=ping&api_key=...
 * ?action=runs&date=2026-06-18&api_key=...
 * ?action=run&run_id=run_xxx&api_key=...
 * ?action=summary&date=2026-06-18&api_key=...
 * ?action=summaries&from=2026-06-01&to=2026-06-30&api_key=...
 */
function doGet(e) {
  try {
    validateConfiguration_();

    const apiKey = getParameter_(e, 'api_key');
    assertApiKey_(apiKey);

    const action = normalizeString_(getParameter_(e, 'action') || 'ping')
      .toLowerCase();

    switch (action) {
      case 'ping':
        return jsonResponse_({
          success: true,
          service: 'running-calorie-app',
          server_time: nowIso_(),
          timezone: APP_CONFIG.TIMEZONE,
        });

      case 'runs':
        return jsonResponse_(
          getRunsByDate_(normalizeDate_(getParameter_(e, 'date')))
        );

      case 'run':
        return jsonResponse_(
          getRunById_(normalizeString_(getParameter_(e, 'run_id')))
        );

      case 'summary':
        return jsonResponse_(
          getDailySummary_(normalizeDate_(getParameter_(e, 'date')))
        );

      case 'summaries':
        return jsonResponse_(
          getDailySummaries_(
            normalizeDate_(getParameter_(e, 'from')),
            normalizeDate_(getParameter_(e, 'to'))
          )
        );

      case 'report':
        return jsonResponse_(
          getReport_(
            normalizeString_(getParameter_(e, 'username')),
            normalizeString_(getParameter_(e, 'token')),
            normalizeDate_(getParameter_(e, 'from')),
            normalizeDate_(getParameter_(e, 'to'))
          )
        );

      default:
        throw new Error('Action không hợp lệ: ' + action);
    }
  } catch (error) {
    return errorResponse_(error);
  }
}

function saveRun_(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Thiếu object run.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = getSpreadsheet_();
    const runsSheet = ensureSheet_(
      spreadsheet,
      APP_CONFIG.RUNS_SHEET,
      RUN_HEADERS
    );
    ensureSheet_(
      spreadsheet,
      APP_CONFIG.DAILY_SUMMARY_SHEET,
      DAILY_HEADERS
    );

    const run = normalizeRun_(input);

    const existingRow = findExactRow_(
      runsSheet,
      RUN_HEADERS.indexOf('run_id') + 1,
      run.run_id
    );

    if (existingRow > 0) {
      const existingRun = rowToObject_(
        RUN_HEADERS,
        runsSheet.getRange(existingRow, 1, 1, RUN_HEADERS.length).getValues()[0]
      );

      return {
        success: true,
        duplicate: true,
        message: 'run_id đã tồn tại, không tạo thêm dòng mới.',
        run: existingRun,
      };
    }

    const row = RUN_HEADERS.map(function (header) {
      return run[header] !== undefined && run[header] !== null
        ? run[header]
        : '';
    });

    runsSheet.appendRow(row);
    const insertedRow = runsSheet.getLastRow();

    applyRunRowFormats_(runsSheet, insertedRow);
    SpreadsheetApp.flush();

    const dailySummary = updateDailySummary_(run.date);

    return {
      success: true,
      duplicate: false,
      message: 'Đã lưu buổi chạy.',
      run_id: run.run_id,
      date: run.date,
      sheet_row: insertedRow,
      daily_summary: dailySummary,
      server_time: nowIso_(),
    };
  } finally {
    lock.releaseLock();
  }
}

function deleteRun_(runId, confirmation) {
  if (!runId) {
    throw new Error('Thiếu run_id.');
  }

  // Tránh app gọi nhầm làm mất dữ liệu.
  if (confirmation !== 'DELETE') {
    throw new Error('Để xóa, confirmation phải có giá trị DELETE.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const runsSheet = getRequiredSheet_(APP_CONFIG.RUNS_SHEET);
    const rowNumber = findExactRow_(
      runsSheet,
      RUN_HEADERS.indexOf('run_id') + 1,
      runId
    );

    if (rowNumber < 2) {
      return {
        success: true,
        deleted: false,
        message: 'Không tìm thấy run_id.',
        run_id: runId,
      };
    }

    const dateValue = runsSheet
      .getRange(rowNumber, RUN_HEADERS.indexOf('date') + 1)
      .getDisplayValue();

    runsSheet.deleteRow(rowNumber);
    SpreadsheetApp.flush();

    const dailySummary = updateDailySummary_(normalizeDate_(dateValue));

    return {
      success: true,
      deleted: true,
      run_id: runId,
      date: dateValue,
      daily_summary: dailySummary,
    };
  } finally {
    lock.releaseLock();
  }
}

function normalizeRun_(input) {
  const runId = normalizeString_(input.run_id);
  if (!runId) {
    throw new Error('run_id là bắt buộc.');
  }

  const startedAt = normalizeDateTime_(input.started_at);
  const endedAt = normalizeDateTime_(input.ended_at);

  if (!startedAt) {
    throw new Error('started_at là bắt buộc và phải là ngày giờ hợp lệ.');
  }

  if (!endedAt) {
    throw new Error('ended_at là bắt buộc và phải là ngày giờ hợp lệ.');
  }

  if (endedAt.getTime() < startedAt.getTime()) {
    throw new Error('ended_at không được nhỏ hơn started_at.');
  }

  const calculatedDuration = Math.max(
    0,
    Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
  );

  const durationSeconds = nonNegativeNumber_(
    input.duration_seconds,
    calculatedDuration
  );
  const movingSeconds = Math.min(
    durationSeconds,
    nonNegativeNumber_(input.moving_seconds, durationSeconds)
  );
  const pauseSeconds = nonNegativeNumber_(
    input.pause_seconds,
    Math.max(0, durationSeconds - movingSeconds)
  );
  const distanceKm = nonNegativeNumber_(input.distance_km, 0);

  const avgPaceSecondsPerKm = positiveNumberOrBlank_(
    input.avg_pace_seconds_per_km,
    distanceKm > 0 && movingSeconds > 0 ? movingSeconds / distanceKm : ''
  );

  const bestPaceSecondsPerKm = positiveNumberOrBlank_(
    input.best_pace_seconds_per_km,
    ''
  );

  const avgSpeedKmh = positiveNumberOrBlank_(
    input.avg_speed_kmh,
    distanceKm > 0 && movingSeconds > 0
      ? distanceKm / (movingSeconds / 3600)
      : ''
  );

  const date = input.date
    ? normalizeDate_(input.date)
    : Utilities.formatDate(startedAt, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd');

  const now = nowIso_();

  return {
    run_id: safeSheetText_(runId),
    username: safeSheetText_(normalizeString_(input.username)).toLowerCase(),
    activity: normalizeActivity_(input.activity),
    date: date,
    start_time: Utilities.formatDate(startedAt, APP_CONFIG.TIMEZONE, 'HH:mm:ss'),
    end_time: Utilities.formatDate(endedAt, APP_CONFIG.TIMEZONE, 'HH:mm:ss'),
    started_at: toIsoInTimezone_(startedAt),
    ended_at: toIsoInTimezone_(endedAt),
    duration_seconds: Math.round(durationSeconds),
    moving_seconds: Math.round(movingSeconds),
    pause_seconds: Math.round(pauseSeconds),
    distance_km: round_(distanceKm, 3),
    avg_pace_seconds_per_km:
      avgPaceSecondsPerKm === '' ? '' : round_(avgPaceSecondsPerKm, 2),
    avg_pace:
      avgPaceSecondsPerKm === '' ? '' : formatPace_(avgPaceSecondsPerKm),
    best_pace_seconds_per_km:
      bestPaceSecondsPerKm === '' ? '' : round_(bestPaceSecondsPerKm, 2),
    best_pace:
      bestPaceSecondsPerKm === '' ? '' : formatPace_(bestPaceSecondsPerKm),
    avg_speed_kmh: avgSpeedKmh === '' ? '' : round_(avgSpeedKmh, 2),
    max_speed_kmh: roundOptional_(input.max_speed_kmh, 2),
    calories: round_(nonNegativeNumber_(input.calories, 0), 2),
    weight_kg: roundOptional_(input.weight_kg, 2),
    steps: integerOptional_(input.steps),
    avg_cadence: roundOptional_(input.avg_cadence, 1),
    max_cadence: roundOptional_(input.max_cadence, 1),
    avg_heart_rate: roundOptional_(input.avg_heart_rate, 1),
    max_heart_rate: roundOptional_(input.max_heart_rate, 1),
    elevation_gain_m: round_(nonNegativeNumber_(input.elevation_gain_m, 0), 2),
    elevation_loss_m: round_(nonNegativeNumber_(input.elevation_loss_m, 0), 2),
    location_count: integerOptional_(input.location_count),
    route_data: normalizeRouteData_(input.route_data),
    device_id: safeSheetText_(normalizeString_(input.device_id)),
    app_version: safeSheetText_(normalizeString_(input.app_version)),
    created_at: normalizeString_(input.created_at) || now,
    updated_at: now,
  };
}

function updateDailySummary_(date) {
  const normalizedDate = normalizeDate_(date);
  const spreadsheet = getSpreadsheet_();

  const runsSheet = getRequiredSheet_(APP_CONFIG.RUNS_SHEET);
  const dailySheet = ensureSheet_(
    spreadsheet,
    APP_CONFIG.DAILY_SUMMARY_SHEET,
    DAILY_HEADERS
  );

  const rows = getDataObjects_(runsSheet, RUN_HEADERS).filter(function (run) {
    return normalizeDate_(run.date) === normalizedDate;
  });

  const existingRow = findExactRow_(
    dailySheet,
    DAILY_HEADERS.indexOf('date') + 1,
    normalizedDate
  );

  if (rows.length === 0) {
    if (existingRow >= 2) {
      dailySheet.deleteRow(existingRow);
    }

    return {
      date: normalizedDate,
      run_count: 0,
      deleted: true,
    };
  }

  const totalDistance = sum_(rows, 'distance_km');
  const totalDuration = sum_(rows, 'duration_seconds');
  const totalMoving = sum_(rows, 'moving_seconds');
  const totalPause = sum_(rows, 'pause_seconds');
  const totalCalories = sum_(rows, 'calories');
  const totalSteps = sum_(rows, 'steps');
  const totalElevationGain = sum_(rows, 'elevation_gain_m');
  const totalElevationLoss = sum_(rows, 'elevation_loss_m');

  const avgPaceSecondsPerKm =
    totalDistance > 0 && totalMoving > 0
      ? totalMoving / totalDistance
      : '';

  const avgSpeedKmh =
    totalDistance > 0 && totalMoving > 0
      ? totalDistance / (totalMoving / 3600)
      : '';

  let heartRateWeightedTotal = 0;
  let heartRateWeight = 0;

  rows.forEach(function (run) {
    const heartRate = toNumber_(run.avg_heart_rate);
    const moving = toNumber_(run.moving_seconds);

    if (heartRate > 0 && moving > 0) {
      heartRateWeightedTotal += heartRate * moving;
      heartRateWeight += moving;
    }
  });

  const avgHeartRate =
    heartRateWeight > 0 ? heartRateWeightedTotal / heartRateWeight : '';

  const summary = {
    date: normalizedDate,
    run_count: rows.length,
    total_distance_km: round_(totalDistance, 3),
    total_duration_seconds: Math.round(totalDuration),
    total_moving_seconds: Math.round(totalMoving),
    total_pause_seconds: Math.round(totalPause),
    total_calories: round_(totalCalories, 2),
    total_steps: Math.round(totalSteps),
    avg_pace_seconds_per_km:
      avgPaceSecondsPerKm === '' ? '' : round_(avgPaceSecondsPerKm, 2),
    avg_pace:
      avgPaceSecondsPerKm === '' ? '' : formatPace_(avgPaceSecondsPerKm),
    avg_speed_kmh: avgSpeedKmh === '' ? '' : round_(avgSpeedKmh, 2),
    avg_heart_rate:
      avgHeartRate === '' ? '' : round_(avgHeartRate, 1),
    total_elevation_gain_m: round_(totalElevationGain, 2),
    total_elevation_loss_m: round_(totalElevationLoss, 2),
    updated_at: nowIso_(),
  };

  const outputRow = DAILY_HEADERS.map(function (header) {
    return summary[header] !== undefined && summary[header] !== null
      ? summary[header]
      : '';
  });

  if (existingRow >= 2) {
    dailySheet
      .getRange(existingRow, 1, 1, DAILY_HEADERS.length)
      .setValues([outputRow]);
    applyDailyRowFormats_(dailySheet, existingRow);
  } else {
    dailySheet.appendRow(outputRow);
    applyDailyRowFormats_(dailySheet, dailySheet.getLastRow());
  }

  SpreadsheetApp.flush();
  return summary;
}

function rebuildDailySummary_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const spreadsheet = getSpreadsheet_();
    const runsSheet = ensureSheet_(
      spreadsheet,
      APP_CONFIG.RUNS_SHEET,
      RUN_HEADERS
    );
    const dailySheet = ensureSheet_(
      spreadsheet,
      APP_CONFIG.DAILY_SUMMARY_SHEET,
      DAILY_HEADERS
    );

    if (dailySheet.getLastRow() > 1) {
      dailySheet
        .getRange(2, 1, dailySheet.getLastRow() - 1, DAILY_HEADERS.length)
        .clearContent();
    }

    const dates = {};
    getDataObjects_(runsSheet, RUN_HEADERS).forEach(function (run) {
      if (run.date) {
        dates[normalizeDate_(run.date)] = true;
      }
    });

    const summaries = Object.keys(dates)
      .sort()
      .map(function (date) {
        return updateDailySummary_(date);
      });

    return {
      success: true,
      rebuilt_dates: summaries.length,
      summaries: summaries,
    };
  } finally {
    lock.releaseLock();
  }
}

function getRunsByDate_(date) {
  const runsSheet = getRequiredSheet_(APP_CONFIG.RUNS_SHEET);

  const runs = getDataObjects_(runsSheet, RUN_HEADERS)
    .filter(function (run) {
      return normalizeDate_(run.date) === date;
    })
    .sort(function (a, b) {
      return String(a.started_at).localeCompare(String(b.started_at));
    });

  return {
    success: true,
    date: date,
    count: runs.length,
    runs: runs,
  };
}

function getRunById_(runId) {
  if (!runId) {
    throw new Error('Thiếu run_id.');
  }

  const runsSheet = getRequiredSheet_(APP_CONFIG.RUNS_SHEET);
  const rowNumber = findExactRow_(
    runsSheet,
    RUN_HEADERS.indexOf('run_id') + 1,
    runId
  );

  if (rowNumber < 2) {
    return {
      success: true,
      found: false,
      run_id: runId,
      run: null,
    };
  }

  const values = runsSheet
    .getRange(rowNumber, 1, 1, RUN_HEADERS.length)
    .getValues()[0];

  return {
    success: true,
    found: true,
    run: rowToObject_(RUN_HEADERS, values),
  };
}

function getDailySummary_(date) {
  const dailySheet = getRequiredSheet_(APP_CONFIG.DAILY_SUMMARY_SHEET);
  const rowNumber = findExactRow_(
    dailySheet,
    DAILY_HEADERS.indexOf('date') + 1,
    date
  );

  if (rowNumber < 2) {
    return {
      success: true,
      found: false,
      date: date,
      summary: null,
    };
  }

  const values = dailySheet
    .getRange(rowNumber, 1, 1, DAILY_HEADERS.length)
    .getValues()[0];

  return {
    success: true,
    found: true,
    summary: rowToObject_(DAILY_HEADERS, values),
  };
}

function getDailySummaries_(fromDate, toDate) {
  if (fromDate > toDate) {
    throw new Error('from không được lớn hơn to.');
  }

  const dailySheet = getRequiredSheet_(APP_CONFIG.DAILY_SUMMARY_SHEET);

  const summaries = getDataObjects_(dailySheet, DAILY_HEADERS)
    .filter(function (summary) {
      const date = normalizeDate_(summary.date);
      return date >= fromDate && date <= toDate;
    })
    .sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date));
    });

  return {
    success: true,
    from: fromDate,
    to: toDate,
    count: summaries.length,
    summaries: summaries,
  };
}

function ensureSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      headers.length - sheet.getMaxColumns()
    );
  }

  const currentHeaders = sheet
    .getRange(1, 1, 1, headers.length)
    .getDisplayValues()[0];

  const isEmpty = currentHeaders.every(function (value) {
    return !value;
  });

  if (isEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    headers.forEach(function (header, index) {
      if (currentHeaders[index] !== header) {
        throw new Error(
          'Header sheet "' +
            sheetName +
            '" không đúng tại cột ' +
            (index + 1) +
            '. Cần "' +
            header +
            '" nhưng đang là "' +
            currentHeaders[index] +
            '".'
        );
      }
    });
  }

  sheet.setFrozenRows(1);

  sheet
    .getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setWrap(true);

  if (!sheet.getFilter()) {
    sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), headers.length)
      .createFilter();
  }

  return sheet;
}

function formatRunsSheet_(sheet) {
  // Định dạng dựa trên VỊ TRÍ HEADER (không hardcode) để an toàn khi đổi cột.
  const col = function (name) { return RUN_HEADERS.indexOf(name) + 1; };
  if (sheet.getLastRow() >= 2) {
    const n = sheet.getLastRow() - 1;
    const intCols = ['duration_seconds', 'moving_seconds', 'pause_seconds', 'steps', 'location_count'];
    const dec2Cols = ['avg_pace_seconds_per_km', 'best_pace_seconds_per_km', 'avg_speed_kmh', 'max_speed_kmh', 'calories', 'weight_kg', 'avg_cadence', 'max_cadence', 'avg_heart_rate', 'max_heart_rate', 'elevation_gain_m', 'elevation_loss_m'];
    intCols.forEach(function (c) { sheet.getRange(2, col(c), n, 1).setNumberFormat('0'); });
    dec2Cols.forEach(function (c) { sheet.getRange(2, col(c), n, 1).setNumberFormat('0.00'); });
    sheet.getRange(2, col('distance_km'), n, 1).setNumberFormat('0.000');
  }
}

function formatDailySheet_(sheet) {
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 170);
  sheet.setColumnWidth(5, 170);
  sheet.setColumnWidth(6, 160);
  sheet.setColumnWidth(7, 130);
  sheet.setColumnWidth(8, 110);
  sheet.setColumnWidth(9, 210);
  sheet.setColumnWidth(10, 100);
  sheet.setColumnWidth(11, 140);
  sheet.setColumnWidth(12, 150);
  sheet.setColumnWidth(15, 190);

  if (sheet.getLastRow() >= 2) {
    sheet
      .getRange(2, 3, sheet.getLastRow() - 1, 1)
      .setNumberFormat('0.000');
    sheet
      .getRange(2, 4, sheet.getLastRow() - 1, 5)
      .setNumberFormat('0.00');
  }
}

function applyRunRowFormats_(sheet, row) {
  const col = function (name) { return RUN_HEADERS.indexOf(name) + 1; };
  ['duration_seconds', 'moving_seconds', 'pause_seconds', 'steps', 'location_count'].forEach(function (c) {
    sheet.getRange(row, col(c)).setNumberFormat('0');
  });
  ['avg_pace_seconds_per_km', 'best_pace_seconds_per_km', 'avg_speed_kmh', 'max_speed_kmh', 'calories', 'weight_kg', 'avg_cadence', 'max_cadence', 'avg_heart_rate', 'max_heart_rate', 'elevation_gain_m', 'elevation_loss_m'].forEach(function (c) {
    sheet.getRange(row, col(c)).setNumberFormat('0.00');
  });
  sheet.getRange(row, col('distance_km')).setNumberFormat('0.000');
  sheet.getRange(row, col('route_data')).setWrap(false);
}

function applyDailyRowFormats_(sheet, row) {
  sheet.getRange(row, 2).setNumberFormat('0');
  sheet.getRange(row, 3).setNumberFormat('0.000');
  sheet.getRange(row, 4, 1, 3).setNumberFormat('0');
  sheet.getRange(row, 7).setNumberFormat('0.00');
  sheet.getRange(row, 8).setNumberFormat('0');
  sheet.getRange(row, 9).setNumberFormat('0.00');
  sheet.getRange(row, 11, 1, 4).setNumberFormat('0.00');
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(APP_CONFIG.SPREADSHEET_ID);
}

function getRequiredSheet_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(
      'Không tìm thấy sheet "' +
        sheetName +
        '". Hãy chạy setupSheets() trước.'
    );
  }

  return sheet;
}

function getDataObjects_(sheet, headers) {
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  return sheet
    .getRange(2, 1, lastRow - 1, headers.length)
    .getValues()
    .map(function (row) {
      return rowToObject_(headers, row);
    });
}

function rowToObject_(headers, row) {
  const object = {};

  headers.forEach(function (header, index) {
    const value = row[index];

    if (value instanceof Date) {
      object[header] = toIsoInTimezone_(value);
    } else {
      object[header] = value;
    }
  });

  return object;
}

function findExactRow_(sheet, column, searchValue) {
  if (!searchValue || sheet.getLastRow() < 2) {
    return -1;
  }

  const finder = sheet
    .getRange(2, column, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(searchValue))
    .matchEntireCell(true)
    .matchCase(true);

  const match = finder.findNext();
  return match ? match.getRow() : -1;
}

function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('Request POST không có JSON body.');
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    throw new Error('JSON body không hợp lệ.');
  }
}

function assertApiKey_(providedApiKey) {
  const expected = String(APP_CONFIG.API_KEY || '');
  const provided = String(providedApiKey || '');

  if (!expected || expected === 'THAY_BANG_MOT_CHUOI_BI_MAT_DAI_VA_KHO_DOAN') {
    throw new Error('API_KEY chưa được cấu hình.');
  }

  if (provided !== expected) {
    throw new Error('API key không hợp lệ.');
  }
}

function validateConfiguration_() {
  if (
    !APP_CONFIG.SPREADSHEET_ID ||
    APP_CONFIG.SPREADSHEET_ID === 'DAN_SPREADSHEET_ID_VAO_DAY'
  ) {
    throw new Error('SPREADSHEET_ID chưa được cấu hình.');
  }

  if (
    !APP_CONFIG.API_KEY ||
    APP_CONFIG.API_KEY === 'THAY_BANG_MOT_CHUOI_BI_MAT_DAI_VA_KHO_DOAN'
  ) {
    throw new Error('API_KEY chưa được cấu hình.');
  }
}

function normalizeRouteData_(routeData) {
  if (routeData === undefined || routeData === null || routeData === '') {
    return '';
  }

  let value;

  if (typeof routeData === 'string') {
    value = routeData;
  } else {
    value = JSON.stringify(routeData);
  }

  if (value.length > APP_CONFIG.MAX_ROUTE_DATA_LENGTH) {
    throw new Error(
      'route_data quá dài. Tối đa ' +
        APP_CONFIG.MAX_ROUTE_DATA_LENGTH +
        ' ký tự.'
    );
  }

  return safeSheetText_(value);
}

function normalizeDateTime_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  if (value === undefined || value === null || value === '') {
    return null;
  }

  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function normalizeDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, APP_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  const stringValue = normalizeString_(value);

  if (!stringValue) {
    throw new Error('Thiếu ngày theo định dạng yyyy-MM-dd.');
  }

  const match = stringValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw new Error(
      'Ngày không hợp lệ: "' +
        stringValue +
        '". Định dạng yêu cầu: yyyy-MM-dd.'
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const testDate = new Date(Date.UTC(year, month - 1, day));

  if (
    testDate.getUTCFullYear() !== year ||
    testDate.getUTCMonth() !== month - 1 ||
    testDate.getUTCDate() !== day
  ) {
    throw new Error('Ngày không tồn tại: ' + stringValue);
  }

  return stringValue;
}

function toIsoInTimezone_(date) {
  return Utilities.formatDate(
    date,
    APP_CONFIG.TIMEZONE,
    "yyyy-MM-dd'T'HH:mm:ssXXX"
  );
}

function nowIso_() {
  return toIsoInTimezone_(new Date());
}

function formatPace_(secondsPerKm) {
  const totalSeconds = Math.max(0, Math.round(toNumber_(secondsPerKm)));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return minutes + ':' + String(seconds).padStart(2, '0') + '/km';
}

function safeSheetText_(value) {
  const text = normalizeString_(value);

  // Ngăn formula injection khi dữ liệu bắt đầu bằng =, +, - hoặc @.
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function normalizeString_(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function getParameter_(e, name) {
  return e && e.parameter ? e.parameter[name] : '';
}

function nonNegativeNumber_(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveNumberOrBlank_(value, fallback) {
  if (value === '' || value === undefined || value === null) {
    return fallback;
  }

  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function roundOptional_(value, decimals) {
  if (value === '' || value === undefined || value === null) {
    return '';
  }

  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? round_(number, decimals)
    : '';
}

function integerOptional_(value) {
  if (value === '' || value === undefined || value === null) {
    return '';
  }

  const number = Number(value);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number)
    : '';
}

function toNumber_(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round_(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round((toNumber_(value) + Number.EPSILON) * factor) / factor;
}

function sum_(rows, key) {
  return rows.reduce(function (total, row) {
    return total + toNumber_(row[key]);
  }, 0);
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(error) {
  const message =
    error && error.message ? String(error.message) : 'Lỗi không xác định.';

  console.error(error && error.stack ? error.stack : message);

  return jsonResponse_({
    success: false,
    error: message,
    server_time: nowIso_(),
  });
}

/**
 * ============ TÀI KHOẢN (đăng ký / đăng nhập) ============
 * Mật khẩu được hash SHA-256 với salt ngẫu nhiên, KHÔNG lưu mật khẩu gốc.
 * Token là chuỗi ngẫu nhiên cấp khi đăng nhập, app gửi kèm mỗi request.
 */
function normalizeActivity_(value) {
  const v = normalizeString_(value).toLowerCase();
  return v === 'bike' ? 'bike' : 'run';
}

function getUsersSheet_() {
  return ensureSheet_(getSpreadsheet_(), APP_CONFIG.USERS_SHEET, USER_HEADERS);
}

function hashPassword_(password, salt) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + ':' + password,
    Utilities.Charset.UTF_8
  );
  return raw
    .map(function (b) {
      return ('0' + (b & 0xff).toString(16)).slice(-2);
    })
    .join('');
}

function randomToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function findUserRow_(sheet, username) {
  return findExactRow_(sheet, USER_HEADERS.indexOf('username') + 1, username);
}

function registerUser_(username, password) {
  const user = normalizeString_(username).toLowerCase();
  if (!user || !/^[a-z0-9_.]{3,30}$/.test(user)) {
    throw new Error('Tên đăng nhập 3-30 ký tự, chỉ gồm chữ thường, số, _ hoặc .');
  }
  if (!password || password.length < 6) {
    throw new Error('Mật khẩu cần ít nhất 6 ký tự.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getUsersSheet_();
    if (findUserRow_(sheet, user) > 0) {
      throw new Error('Tên đăng nhập đã tồn tại.');
    }
    const salt = randomToken_().slice(0, 24);
    const token = randomToken_();
    const now = nowIso_();
    const row = USER_HEADERS.map(function (h) {
      switch (h) {
        case 'username': return safeSheetText_(user);
        case 'password_hash': return hashPassword_(password, salt);
        case 'salt': return salt;
        case 'token': return token;
        case 'created_at': return now;
        case 'last_login_at': return now;
        default: return '';
      }
    });
    sheet.appendRow(row);
    SpreadsheetApp.flush();
    return { success: true, username: user, token: token, server_time: now };
  } finally {
    lock.releaseLock();
  }
}

function loginUser_(username, password) {
  const user = normalizeString_(username).toLowerCase();
  if (!user || !password) {
    throw new Error('Thiếu tên đăng nhập hoặc mật khẩu.');
  }
  const sheet = getUsersSheet_();
  const rowNumber = findUserRow_(sheet, user);
  if (rowNumber < 2) {
    throw new Error('Tài khoản không tồn tại.');
  }
  const values = sheet.getRange(rowNumber, 1, 1, USER_HEADERS.length).getValues()[0];
  const record = rowToObject_(USER_HEADERS, values);
  const expected = String(record.password_hash);
  const actual = hashPassword_(password, String(record.salt));
  if (expected !== actual) {
    throw new Error('Sai mật khẩu.');
  }
  // Cấp token mới mỗi lần đăng nhập.
  const token = randomToken_();
  sheet.getRange(rowNumber, USER_HEADERS.indexOf('token') + 1).setValue(token);
  sheet.getRange(rowNumber, USER_HEADERS.indexOf('last_login_at') + 1).setValue(nowIso_());
  SpreadsheetApp.flush();
  return { success: true, username: user, token: token, server_time: nowIso_() };
}

function assertUserToken_(username, token) {
  const user = normalizeString_(username).toLowerCase();
  const providedToken = normalizeString_(token);
  if (!user || !providedToken) {
    throw new Error('Cần đăng nhập (thiếu username hoặc token).');
  }
  const sheet = getUsersSheet_();
  const rowNumber = findUserRow_(sheet, user);
  if (rowNumber < 2) {
    throw new Error('Tài khoản không tồn tại.');
  }
  const storedToken = String(
    sheet.getRange(rowNumber, USER_HEADERS.indexOf('token') + 1).getValue()
  );
  if (storedToken !== providedToken) {
    throw new Error('Phiên đăng nhập hết hạn, hãy đăng nhập lại.');
  }
  return user;
}

/**
 * Báo cáo: trả về toàn bộ buổi tập của user trong khoảng ngày.
 * App sẽ tự lọc thêm theo môn / cự ly / pace ở phía client.
 */
function getReport_(username, token, fromDate, toDate) {
  const user = assertUserToken_(username, token);
  if (fromDate > toDate) {
    throw new Error('from không được lớn hơn to.');
  }
  const runsSheet = getRequiredSheet_(APP_CONFIG.RUNS_SHEET);
  const runs = getDataObjects_(runsSheet, RUN_HEADERS)
    .filter(function (run) {
      const runUser = normalizeString_(run.username).toLowerCase();
      if (runUser !== user) return false;
      const date = normalizeDate_(run.date);
      return date >= fromDate && date <= toDate;
    })
    .map(function (run) {
      return {
        run_id: run.run_id,
        username: normalizeString_(run.username).toLowerCase(),
        activity: normalizeActivity_(run.activity),
        date: normalizeDate_(run.date),
        started_at: run.started_at,
        ended_at: run.ended_at,
        duration_seconds: toNumber_(run.duration_seconds),
        moving_seconds: toNumber_(run.moving_seconds),
        distance_km: toNumber_(run.distance_km),
        avg_pace_seconds_per_km: toNumber_(run.avg_pace_seconds_per_km),
        avg_speed_kmh: toNumber_(run.avg_speed_kmh),
        max_speed_kmh: toNumber_(run.max_speed_kmh),
        calories: toNumber_(run.calories),
        steps: toNumber_(run.steps),
        elevation_gain_m: toNumber_(run.elevation_gain_m),
      };
    })
    .sort(function (a, b) {
      return String(b.started_at).localeCompare(String(a.started_at));
    });

  return {
    success: true,
    username: user,
    from: fromDate,
    to: toDate,
    count: runs.length,
    runs: runs,
  };
}

/**
 * Test lưu dữ liệu trực tiếp trong Apps Script.
 * Sau khi setupSheets() thành công, chạy hàm này để tạo một bản ghi mẫu.
 */
function testSaveRun() {
  const result = saveRun_({
    run_id: 'test_' + new Date().getTime(),
    started_at: '2026-06-18T06:30:15+07:00',
    ended_at: '2026-06-18T07:02:42+07:00',
    duration_seconds: 1947,
    moving_seconds: 1890,
    pause_seconds: 57,
    distance_km: 5.16,
    avg_pace_seconds_per_km: 366.28,
    best_pace_seconds_per_km: 298,
    avg_speed_kmh: 9.83,
    max_speed_kmh: 14.2,
    calories: 319,
    weight_kg: 70,
    steps: 6380,
    avg_cadence: 168,
    max_cadence: 182,
    avg_heart_rate: 151,
    max_heart_rate: 174,
    elevation_gain_m: 42,
    elevation_loss_m: 39,
    location_count: 386,
    route_data: JSON.stringify([
      {
        latitude: 21.028511,
        longitude: 105.804817,
        timestamp: 1781748615000,
      },
      {
        latitude: 21.0286,
        longitude: 105.80495,
        timestamp: 1781748620000,
      },
    ]),
    device_id: 'test_android_device',
    app_version: '1.0.0',
  });

  Logger.log(JSON.stringify(result, null, 2));
}
