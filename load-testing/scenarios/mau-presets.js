/**
 * MAU ベーステストプリセット
 *
 * MAU (Monthly Active Users) から Peak RPS を計算し、
 * 負荷テストの設定を自動生成する。
 *
 * 計算式:
 * RPS_peak = (MAU × DAU_Ratio × Requests_Per_DAU) / (Active_Hours × 3600) × Peak_Factor
 *
 * 簡略式: RPS_peak ≒ MAU / 5,000
 *
 * デフォルトパラメータ:
 * - DAU/MAU比率: 20% (B2B SaaS標準)
 * - ログイン回数/日: 1.5回
 * - リフレッシュ回数/日: 8回 (1時間Access Token想定)
 * - リクエスト/ログイン: 3.1 (authorize + token + userinfo)
 * - リクエスト/リフレッシュ: 1.2 (token + 稀にuserinfo)
 * - ピーク倍率: 2.0x
 * - アクティブ時間: 8時間
 */

// MAU → RPS 変換パラメータ
export const CONVERSION_PARAMS = {
  dauMauRatio: 0.2, // 20% DAU/MAU ratio
  loginsPerDay: 1.5, // Average logins per DAU
  refreshesPerDay: 8, // Refresh token operations per DAU
  requestsPerLogin: 3.1, // authorize + token + userinfo
  requestsPerRefresh: 1.2, // token + occasional userinfo
  peakFactor: 2.0, // Peak multiplier
  activeHours: 8, // Business hours
};

/**
 * MAU から Peak RPS を計算
 * @param {number} mau Monthly Active Users
 * @param {Object} params オプションパラメータ
 * @returns {number} Peak RPS
 */
export function calculatePeakRPS(mau, params = {}) {
  const config = { ...CONVERSION_PARAMS, ...params };

  const dau = mau * config.dauMauRatio;
  const requestsPerDau =
    config.loginsPerDay * config.requestsPerLogin +
    config.refreshesPerDay * config.requestsPerRefresh;
  const dailyRequests = dau * requestsPerDau;
  const averageRps = dailyRequests / (config.activeHours * 3600);
  const peakRps = averageRps * config.peakFactor;

  return Math.round(peakRps);
}

/**
 * MAU プリセット定義
 *
 * 各プリセットには以下が含まれる:
 * - mau: 対象 MAU
 * - targetRPS: 目標 Peak RPS
 * - clientCount: テストクライアント数
 * - duration: テスト時間
 * - stages: k6 stages 設定
 * - thresholds: k6 thresholds 設定
 * - distribution: クライアント負荷配分
 */
export const MAU_PRESETS = {
  // MAU 10万 - スタートアップ規模
  'mau-100k': {
    mau: 100000,
    description: 'MAU 100K - Startup scale (20 Peak RPS)',
    targetRPS: 20,
    clientCount: 10,
    duration: '5m',
    stages: [
      { target: 10, duration: '30s' }, // Warm up
      { target: 20, duration: '30s' }, // Ramp to target
      { target: 20, duration: '3m' }, // Sustain
      { target: 10, duration: '30s' }, // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<150', 'p(99)<250'],
      http_req_failed: ['rate<0.001'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.99'],
    },
    preAllocatedVUs: 30,
    maxVUs: 50,
    distribution: {
      high: { count: 1, rpsPerClient: 9 },
      medium: { count: 4, rpsPerClient: 1.75 },
      low: { count: 5, rpsPerClient: 0.8 },
    },
  },

  // MAU 50万 - 中規模 SaaS
  'mau-500k': {
    mau: 500000,
    description: 'MAU 500K - Mid-size SaaS (100 Peak RPS)',
    targetRPS: 100,
    clientCount: 20,
    duration: '10m',
    stages: [
      { target: 50, duration: '30s' }, // Warm up
      { target: 100, duration: '30s' }, // Ramp to target
      { target: 100, duration: '8m' }, // Sustain
      { target: 50, duration: '30s' }, // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.99'],
    },
    preAllocatedVUs: 120,
    maxVUs: 150,
    distribution: {
      high: { count: 3, rpsPerClient: 15 },
      medium: { count: 7, rpsPerClient: 5 },
      low: { count: 10, rpsPerClient: 2 },
    },
  },

  // MAU 100万 - 大規模 SaaS
  'mau-1m': {
    mau: 1000000,
    description: 'MAU 1M - Large SaaS (200 Peak RPS)',
    targetRPS: 200,
    clientCount: 30,
    duration: '10m',
    stages: [
      { target: 100, duration: '30s' }, // Warm up
      { target: 200, duration: '30s' }, // Ramp to target
      { target: 200, duration: '8m' }, // Sustain
      { target: 100, duration: '30s' }, // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.001'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.99'],
    },
    preAllocatedVUs: 250,
    maxVUs: 300,
    distribution: {
      high: { count: 5, rpsPerClient: 18 },
      medium: { count: 10, rpsPerClient: 7 },
      low: { count: 15, rpsPerClient: 2.7 },
    },
  },

  // MAU 200万 - エンタープライズ規模
  'mau-2m': {
    mau: 2000000,
    description: 'MAU 2M - Enterprise scale (400 Peak RPS)',
    targetRPS: 400,
    clientCount: 40,
    duration: '10m',
    stages: [
      { target: 200, duration: '30s' }, // Warm up
      { target: 400, duration: '30s' }, // Ramp to target
      { target: 400, duration: '8m' }, // Sustain
      { target: 200, duration: '30s' }, // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.002'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.98'],
    },
    preAllocatedVUs: 500,
    maxVUs: 600,
    distribution: {
      high: { count: 6, rpsPerClient: 30 },
      medium: { count: 14, rpsPerClient: 10 },
      low: { count: 20, rpsPerClient: 4 },
    },
  },
};

/**
 * カスタム MAU からプリセットを生成
 * @param {number} mau 対象 MAU
 * @param {Object} options オプション
 * @returns {Object} 生成されたプリセット
 */
export function generatePreset(mau, options = {}) {
  const targetRPS = calculatePeakRPS(mau);
  const clientCount = options.clientCount || Math.ceil(targetRPS / 10);
  const duration = options.duration || '10m';

  // 負荷配分を計算
  const highCount = Math.max(1, Math.round(clientCount * 0.15));
  const mediumCount = Math.max(1, Math.round(clientCount * 0.35));
  const lowCount = Math.max(1, clientCount - highCount - mediumCount);

  const highRPS = (targetRPS * 0.45) / highCount;
  const mediumRPS = (targetRPS * 0.35) / mediumCount;
  const lowRPS = (targetRPS * 0.2) / lowCount;

  return {
    mau,
    description: `MAU ${(mau / 1000000).toFixed(1)}M - Custom (${targetRPS} Peak RPS)`,
    targetRPS,
    clientCount,
    duration,
    stages: [
      { target: Math.round(targetRPS / 2), duration: '30s' },
      { target: targetRPS, duration: '30s' },
      { target: targetRPS, duration: '8m' },
      { target: Math.round(targetRPS / 2), duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.002'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.98'],
    },
    preAllocatedVUs: Math.round(targetRPS * 1.25),
    maxVUs: Math.round(targetRPS * 1.5),
    distribution: {
      high: { count: highCount, rpsPerClient: Math.round(highRPS * 10) / 10 },
      medium: { count: mediumCount, rpsPerClient: Math.round(mediumRPS * 10) / 10 },
      low: { count: lowCount, rpsPerClient: Math.round(lowRPS * 10) / 10 },
    },
  };
}

/**
 * プリセットを取得
 * @param {string} presetName プリセット名またはカスタム MAU ("mau-100k", "mau-500k", "1500000")
 * @returns {Object} プリセット
 */
export function getPreset(presetName) {
  // 定義済みプリセット
  if (MAU_PRESETS[presetName]) {
    return MAU_PRESETS[presetName];
  }

  // カスタム MAU（数値で指定）
  const mau = parseInt(presetName.replace(/[^0-9]/g, ''), 10);
  if (!isNaN(mau) && mau > 0) {
    return generatePreset(mau);
  }

  throw new Error(
    `Unknown preset: ${presetName}. Available: ${Object.keys(MAU_PRESETS).join(', ')} or custom MAU number`
  );
}

// デフォルトエクスポート
export default MAU_PRESETS;
