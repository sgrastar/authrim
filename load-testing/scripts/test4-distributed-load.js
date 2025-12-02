/**
 * TEST 4: Distributed Load Test (Multi-Client)
 *
 * 複数クライアント（テナント）に分散負荷をかける本番シミュレーション:
 * - RefreshTokenRotator DO は client_id 単位でシャーディング
 * - 各クライアントに重み付きで負荷を分散
 * - MAU ベースのプリセットで目標 RPS を設定
 *
 * 使い方:
 *   # MAU プリセット使用
 *   k6 run --env MAU_PRESET=mau-100k scripts/test4-distributed-load.js
 *   k6 run --env MAU_PRESET=mau-500k scripts/test4-distributed-load.js
 *   k6 run --env MAU_PRESET=mau-1m scripts/test4-distributed-load.js
 *
 *   # カスタム設定
 *   k6 run --env TARGET_RPS=150 --env DURATION=5m scripts/test4-distributed-load.js
 *
 * 事前準備:
 *   1. node scripts/setup-test-clients.js      # テストクライアント作成
 *   2. node scripts/generate-distributed-seeds.js # シード生成
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';

// ============================================================================
// カスタムメトリクス
// ============================================================================

// 全体メトリクス
const refreshRequestDuration = new Trend('refresh_request_duration');
const refreshRequestSuccess = new Rate('refresh_request_success');
const tokenRotationSuccess = new Rate('token_rotation_success');
const serverErrors = new Counter('server_errors');

// クライアントレベル別メトリクス
const highLoadRequestDuration = new Trend('high_load_request_duration');
const mediumLoadRequestDuration = new Trend('medium_load_request_duration');
const lowLoadRequestDuration = new Trend('low_load_request_duration');

const highLoadSuccess = new Rate('high_load_success');
const mediumLoadSuccess = new Rate('medium_load_success');
const lowLoadSuccess = new Rate('low_load_success');

// クライアント別リクエストカウント
const clientRequestCount = new Counter('client_request_count');

// ============================================================================
// 環境変数と設定
// ============================================================================

const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const MAU_PRESET = __ENV.MAU_PRESET || 'mau-100k';
const TARGET_RPS = __ENV.TARGET_RPS ? parseInt(__ENV.TARGET_RPS, 10) : null;
const DURATION = __ENV.DURATION || null;
const SEEDS_PATH = __ENV.SEEDS_PATH || '../seeds/distributed/all_seeds.json';
const RESULTS_DIR = __ENV.RESULTS_DIR || '../results';

// ============================================================================
// MAU プリセット定義（scenarios/mau-presets.js と同期）
// ============================================================================

const MAU_PRESETS = {
  'mau-100k': {
    mau: 100000,
    description: 'MAU 100K - Startup scale (20 Peak RPS)',
    targetRPS: 20,
    clientCount: 10,
    duration: '5m',
    stages: [
      { target: 10, duration: '30s' },
      { target: 20, duration: '30s' },
      { target: 20, duration: '3m' },
      { target: 10, duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<150', 'p(99)<250'],
      http_req_failed: ['rate<0.001'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.99'],
    },
    preAllocatedVUs: 30,
    maxVUs: 50,
  },

  'mau-500k': {
    mau: 500000,
    description: 'MAU 500K - Mid-size SaaS (100 Peak RPS)',
    targetRPS: 100,
    clientCount: 20,
    duration: '10m',
    stages: [
      { target: 50, duration: '30s' },
      { target: 100, duration: '30s' },
      { target: 100, duration: '8m' },
      { target: 50, duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.99'],
    },
    preAllocatedVUs: 120,
    maxVUs: 150,
  },

  'mau-1m': {
    mau: 1000000,
    description: 'MAU 1M - Large SaaS (200 Peak RPS)',
    targetRPS: 200,
    clientCount: 30,
    duration: '10m',
    stages: [
      { target: 100, duration: '30s' },
      { target: 200, duration: '30s' },
      { target: 200, duration: '8m' },
      { target: 100, duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.001'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.99'],
    },
    preAllocatedVUs: 250,
    maxVUs: 300,
  },

  'mau-2m': {
    mau: 2000000,
    description: 'MAU 2M - Enterprise scale (400 Peak RPS)',
    targetRPS: 400,
    clientCount: 40,
    duration: '10m',
    stages: [
      { target: 200, duration: '30s' },
      { target: 400, duration: '30s' },
      { target: 400, duration: '8m' },
      { target: 200, duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.002'],
      refresh_request_success: ['rate>0.99'],
      token_rotation_success: ['rate>0.98'],
    },
    preAllocatedVUs: 500,
    maxVUs: 600,
  },
};

// プリセット選択
const selectedPreset = MAU_PRESETS[MAU_PRESET];
if (!selectedPreset) {
  throw new Error(`Invalid MAU_PRESET "${MAU_PRESET}". Use one of: ${Object.keys(MAU_PRESETS).join(', ')}`);
}

// カスタム設定の上書き
const effectiveTargetRPS = TARGET_RPS || selectedPreset.targetRPS;
const effectiveDuration = DURATION || selectedPreset.duration;

// ============================================================================
// シードデータの読み込み
// ============================================================================

/**
 * 分散シードデータを読み込み
 * 構造:
 * {
 *   metadata: { ... },
 *   clients: [
 *     {
 *       client_id, client_secret, client_name, load_level, target_rps,
 *       seeds: [{ token, client_id, client_secret, family_id }, ...]
 *     },
 *     ...
 *   ]
 * }
 */
const seedData = new SharedArray('distributed_seeds', function () {
  try {
    const raw = open(SEEDS_PATH);
    const parsed = JSON.parse(raw);

    if (!parsed.clients || parsed.clients.length === 0) {
      throw new Error('No clients found in seed file');
    }

    // クライアントごとにシードプールを準備
    const clients = parsed.clients.map((client) => ({
      client_id: client.client_id,
      client_secret: client.client_secret,
      client_name: client.client_name,
      load_level: client.load_level,
      target_rps: client.target_rps,
      seeds: client.seeds || [],
    }));

    // シードがないクライアントを除外
    const validClients = clients.filter((c) => c.seeds.length > 0);
    if (validClients.length === 0) {
      throw new Error('No clients with valid seeds found');
    }

    return validClients;
  } catch (err) {
    throw new Error(
      `Failed to load distributed seeds from "${SEEDS_PATH}". ` +
        `Run setup-test-clients.js and generate-distributed-seeds.js first. (${err.message})`
    );
  }
});

// 負荷レベル別のクライアント分類
const highLoadClients = seedData.filter((c) => c.load_level === 'high');
const mediumLoadClients = seedData.filter((c) => c.load_level === 'medium');
const lowLoadClients = seedData.filter((c) => c.load_level === 'low');

// 重み付き選択用の累積配列を構築
// high: 45%, medium: 35%, low: 20%
const LOAD_WEIGHTS = {
  high: 0.45,
  medium: 0.35,
  low: 0.2,
};

const totalClients = seedData.length;
const weightedClientSelection = [];

// 重み付きで選択配列を構築
highLoadClients.forEach((client) => {
  const weight = LOAD_WEIGHTS.high / highLoadClients.length;
  weightedClientSelection.push({ client, weight, level: 'high' });
});
mediumLoadClients.forEach((client) => {
  const weight = LOAD_WEIGHTS.medium / mediumLoadClients.length;
  weightedClientSelection.push({ client, weight, level: 'medium' });
});
lowLoadClients.forEach((client) => {
  const weight = LOAD_WEIGHTS.low / lowLoadClients.length;
  weightedClientSelection.push({ client, weight, level: 'low' });
});

// 累積分布を計算
let cumulative = 0;
const cumulativeWeights = weightedClientSelection.map((entry) => {
  cumulative += entry.weight;
  return { ...entry, cumulative };
});

// ============================================================================
// テストオプション
// ============================================================================

export const options = {
  scenarios: {
    distributed_load: {
      executor: 'ramping-arrival-rate',
      startRate: selectedPreset.stages[0].target,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
    },
  },
  thresholds: selectedPreset.thresholds,
};

// ============================================================================
// VU 状態管理
// ============================================================================

// VU ごとの状態
let vuState = null;

/**
 * 重み付きでクライアントを選択
 */
function selectWeightedClient() {
  const rand = Math.random();
  for (const entry of cumulativeWeights) {
    if (rand <= entry.cumulative) {
      return entry;
    }
  }
  // フォールバック（最後のエントリ）
  return cumulativeWeights[cumulativeWeights.length - 1];
}

/**
 * VU 初期化
 * 各 VU に固有のクライアントとトークンを割り当て
 */
function initializeVU() {
  const vuId = __VU;

  // 重み付きでクライアントを選択
  const selection = selectWeightedClient();
  const client = selection.client;
  const loadLevel = selection.level;

  // クライアント内でシードをラウンドロビン選択
  const seedIndex = (vuId - 1) % client.seeds.length;
  const seed = client.seeds[seedIndex];

  return {
    vuId,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    clientName: client.client_name,
    loadLevel,
    currentToken: seed.token,
    familyDepth: 0,
    hasLoggedError: false,
  };
}

// ============================================================================
// セットアップ
// ============================================================================

export function setup() {
  console.log(`🚀 TEST 4: Distributed Load Test (Multi-Client)`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(``);
  console.log(`📊 MAU プリセット: ${MAU_PRESET}`);
  console.log(`📝 説明: ${selectedPreset.description}`);
  console.log(`🎯 ターゲット URL: ${BASE_URL}`);
  console.log(`📈 目標 RPS: ${effectiveTargetRPS}`);
  console.log(``);
  console.log(`📦 クライアント分布:`);
  console.log(`   Total: ${totalClients} clients`);
  console.log(`   High:   ${highLoadClients.length} clients (45% load share)`);
  console.log(`   Medium: ${mediumLoadClients.length} clients (35% load share)`);
  console.log(`   Low:    ${lowLoadClients.length} clients (20% load share)`);
  console.log(``);
  console.log(`✨ テスト特徴:`);
  console.log(`   - 複数クライアント（テナント）への分散負荷`);
  console.log(`   - RefreshTokenRotator DO シャーディング検証`);
  console.log(`   - 重み付きクライアント選択（本番環境シミュレーション）`);
  console.log(`   - Token Rotation 有効`);
  console.log(``);

  return {
    baseUrl: BASE_URL,
    preset: MAU_PRESET,
    targetRPS: effectiveTargetRPS,
    clientCount: totalClients,
  };
}

// ============================================================================
// メインテスト関数
// ============================================================================

export default function (data) {
  // VU 初回実行時に初期化
  if (!vuState) {
    vuState = initializeVU();
  }

  // リクエストパラメータ
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    tags: {
      name: 'RefreshTokenRequest',
      preset: MAU_PRESET,
      client_id: vuState.clientId,
      load_level: vuState.loadLevel,
    },
  };

  const payload = [
    `grant_type=refresh_token`,
    `refresh_token=${vuState.currentToken}`,
    `client_id=${vuState.clientId}`,
    `client_secret=${vuState.clientSecret}`,
  ].join('&');

  // リクエスト送信
  const response = http.post(`${BASE_URL}/token`, payload, params);
  const duration = response.timings.duration;

  // 全体メトリクス記録
  refreshRequestDuration.add(duration);

  // 負荷レベル別メトリクス記録
  if (vuState.loadLevel === 'high') {
    highLoadRequestDuration.add(duration);
  } else if (vuState.loadLevel === 'medium') {
    mediumLoadRequestDuration.add(duration);
  } else {
    lowLoadRequestDuration.add(duration);
  }

  // クライアント別カウント
  clientRequestCount.add(1, { client_id: vuState.clientId });

  // レスポンスパース
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (e) {
    // JSON パースエラー
  }

  // レスポンスチェック
  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has access_token': (r) => responseBody.access_token !== undefined,
    'has refresh_token': (r) => responseBody.refresh_token !== undefined,
    'token_type is Bearer': (r) => responseBody.token_type === 'Bearer',
    'token rotated': (r) => {
      if (responseBody.refresh_token) {
        return responseBody.refresh_token !== vuState.currentToken;
      }
      return false;
    },
  });

  // メトリクス更新
  refreshRequestSuccess.add(success);

  // 負荷レベル別成功率
  if (vuState.loadLevel === 'high') {
    highLoadSuccess.add(success);
  } else if (vuState.loadLevel === 'medium') {
    mediumLoadSuccess.add(success);
  } else {
    lowLoadSuccess.add(success);
  }

  // Token Rotation 成功チェック
  if (success && responseBody.refresh_token && responseBody.refresh_token !== vuState.currentToken) {
    tokenRotationSuccess.add(1);
    vuState.currentToken = responseBody.refresh_token;
    vuState.familyDepth++;
  } else {
    tokenRotationSuccess.add(0);

    // エラーログ（デバッグ用）
    if (!success && !vuState.hasLoggedError) {
      console.error(`❌ Token rotation failed for VU ${vuState.vuId} (${vuState.clientName}):`);
      console.error(`   Status: ${response.status}`);
      console.error(`   Response: ${response.body.substring(0, 200)}`);
      vuState.hasLoggedError = true;
    }
  }

  // サーバーエラー
  if (response.status >= 500) {
    serverErrors.add(1);
    if (!vuState.hasLoggedError) {
      console.error(
        `❌ 5xx from /token (VU ${vuState.vuId}, ${vuState.clientName}): status=${response.status}`
      );
      vuState.hasLoggedError = true;
    }
  }
}

// ============================================================================
// ティアダウン
// ============================================================================

export function teardown(data) {
  console.log(``);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`✅ TEST 4: Distributed Load Test 完了`);
  console.log(`   プリセット: ${data.preset}`);
  console.log(`   目標 RPS: ${data.targetRPS}`);
  console.log(`   クライアント数: ${data.clientCount}`);
  console.log(`═══════════════════════════════════════════════════════════════`);
}

// ============================================================================
// サマリーハンドラー
// ============================================================================

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '').replace('T', '_');

  return {
    [`${RESULTS_DIR}/test4-${MAU_PRESET}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    [`${RESULTS_DIR}/test4-${MAU_PRESET}_${timestamp}.log`]: textSummary(data, {
      indent: ' ',
      enableColors: false,
    }),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

/**
 * テキストサマリー生成
 */
function textSummary(data, options) {
  const indent = options.indent || '';
  const metrics = data.metrics;

  let summary = '\n';
  summary += `${indent}📊 TEST 4: Distributed Load Test - サマリー\n`;
  summary += `${indent}${'═'.repeat(70)}\n\n`;

  // テスト情報
  summary += `${indent}🎯 MAU プリセット: ${MAU_PRESET}\n`;
  summary += `${indent}📝 説明: ${selectedPreset.description}\n`;
  summary += `${indent}📈 目標 RPS: ${effectiveTargetRPS}\n\n`;

  // クライアント分布
  summary += `${indent}📦 クライアント分布:\n`;
  summary += `${indent}   Total: ${totalClients} clients\n`;
  summary += `${indent}   High:   ${highLoadClients.length} (45% load)\n`;
  summary += `${indent}   Medium: ${mediumLoadClients.length} (35% load)\n`;
  summary += `${indent}   Low:    ${lowLoadClients.length} (20% load)\n\n`;

  // 基本統計
  const totalRequests = metrics.http_reqs?.values?.count || 0;
  const failedRequests = metrics.http_req_failed?.values?.passes || 0;
  const successRequests = totalRequests - failedRequests;

  summary += `${indent}📈 リクエスト統計:\n`;
  summary += `${indent}   総リクエスト数: ${totalRequests}\n`;
  summary += `${indent}   成功: ${successRequests}\n`;
  summary += `${indent}   失敗: ${failedRequests}\n`;
  summary += `${indent}   失敗率: ${((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(3)}%\n\n`;

  // レスポンスタイム
  summary += `${indent}⏱️  レスポンスタイム (全体):\n`;
  summary += `${indent}   平均: ${metrics.http_req_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}   p50:  ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}   p90:  ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}   p95:  ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}   p99:  ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  // 負荷レベル別レスポンスタイム
  summary += `${indent}⏱️  レスポンスタイム (負荷レベル別):\n`;
  if (metrics.high_load_request_duration) {
    summary += `${indent}   High:   p95=${metrics.high_load_request_duration.values?.['p(95)']?.toFixed(2) || 0}ms, `;
    summary += `avg=${metrics.high_load_request_duration.values?.avg?.toFixed(2) || 0}ms\n`;
  }
  if (metrics.medium_load_request_duration) {
    summary += `${indent}   Medium: p95=${metrics.medium_load_request_duration.values?.['p(95)']?.toFixed(2) || 0}ms, `;
    summary += `avg=${metrics.medium_load_request_duration.values?.avg?.toFixed(2) || 0}ms\n`;
  }
  if (metrics.low_load_request_duration) {
    summary += `${indent}   Low:    p95=${metrics.low_load_request_duration.values?.['p(95)']?.toFixed(2) || 0}ms, `;
    summary += `avg=${metrics.low_load_request_duration.values?.avg?.toFixed(2) || 0}ms\n`;
  }
  summary += '\n';

  // Token Rotation 統計
  if (metrics.token_rotation_success) {
    const rotationRate = metrics.token_rotation_success.values.rate * 100;
    summary += `${indent}🔄 Token Rotation:\n`;
    summary += `${indent}   成功率: ${rotationRate.toFixed(2)}%\n`;
    summary += `${indent}   成功数: ${metrics.token_rotation_success.values.passes || 0}\n`;
    summary += `${indent}   失敗数: ${metrics.token_rotation_success.values.fails || 0}\n\n`;
  }

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}   5xx 応答: ${metrics.server_errors?.values?.count || 0}\n\n`;

  // 判定
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const errorRate = (metrics.http_req_failed?.values?.rate || 0) * 100;
  const rotationRate = (metrics.token_rotation_success?.values?.rate || 0) * 100;

  const thresholds = selectedPreset.thresholds;
  const p95Threshold = parseInt(thresholds.http_req_duration[0].match(/p\(95\)<(\d+)/)?.[1] || '300', 10);
  const p99Threshold = parseInt(thresholds.http_req_duration[1].match(/p\(99\)<(\d+)/)?.[1] || '500', 10);
  const errorThreshold = parseFloat(thresholds.http_req_failed[0].match(/rate<([\d.]+)/)?.[1] || '0.01') * 100;
  const rotationThreshold =
    parseFloat(thresholds.token_rotation_success?.[0]?.match(/rate>([\d.]+)/)?.[1] || '0.99') * 100;

  const p95Pass = p95 < p95Threshold;
  const p99Pass = p99 < p99Threshold;
  const errorPass = errorRate < errorThreshold;
  const rotationPass = rotationRate >= rotationThreshold;
  const allPass = p95Pass && p99Pass && errorPass && rotationPass;

  summary += `${indent}✅ 判定結果:\n`;
  summary += `${indent}   ${allPass ? '✅ PASS' : '❌ FAIL'}\n`;
  summary += `${indent}   - p95 < ${p95Threshold}ms: ${p95Pass ? '✅' : '❌'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}   - p99 < ${p99Threshold}ms: ${p99Pass ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}   - エラーレート < ${errorThreshold.toFixed(2)}%: ${errorPass ? '✅' : '❌'} (${errorRate.toFixed(3)}%)\n`;
  summary += `${indent}   - Rotation 成功率 >= ${rotationThreshold.toFixed(0)}%: ${rotationPass ? '✅' : '❌'} (${rotationRate.toFixed(2)}%)\n`;

  summary += `\n${indent}${'═'.repeat(70)}\n`;

  // README 用サマリー
  summary += `\n${indent}📋 README 用サマリー:\n`;
  summary += `${indent}┌──────────────┬──────────┬─────────┬─────────────┬──────────────┐\n`;
  summary += `${indent}│ Target MAU   │ Peak RPS │ Clients │ p95 Latency │ Success Rate │\n`;
  summary += `${indent}├──────────────┼──────────┼─────────┼─────────────┼──────────────┤\n`;

  const mauDisplay =
    selectedPreset.mau >= 1000000
      ? `${(selectedPreset.mau / 1000000).toFixed(0)}M`
      : `${(selectedPreset.mau / 1000).toFixed(0)}K`;

  summary += `${indent}│ ${mauDisplay.padEnd(12)} │ ${String(effectiveTargetRPS).padEnd(8)} │ ${String(totalClients).padEnd(7)} │ ${(p95.toFixed(0) + 'ms').padEnd(11)} │ ${((100 - errorRate).toFixed(2) + '%').padEnd(12)} │\n`;
  summary += `${indent}└──────────────┴──────────┴─────────┴─────────────┴──────────────┘\n`;

  return summary;
}
