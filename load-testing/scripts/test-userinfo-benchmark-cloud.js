/**
 * UserInfo Endpoint ベンチマークテスト - K6 Cloud版
 *
 * 目的:
 * - UserInfo API (/userinfo) の最大スループットを測定
 * - Bearer トークン認証のパフォーマンス評価
 * - Auth0/Keycloak/Ory との比較指標
 * - **K6 Cloud経由で分散負荷テストを実行**
 *
 * テスト仕様:
 * - ターゲット: GET /userinfo
 * - 認証: Authorization: Bearer {access_token}
 * - 成功判定: status 200 + sub クレーム存在
 *
 * K6 Cloud実行方法:
 * 1. K6_CLOUD_TOKEN環境変数を設定
 * 2. k6 cloud --env PRESET=rps500 scripts/test-userinfo-benchmark-cloud.js
 *
 * ローカル実行（デバッグ用）:
 * k6 run --env PRESET=rps100 scripts/test-userinfo-benchmark-cloud.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import exec from 'k6/execution';

// テスト識別情報
const TEST_NAME = 'UserInfo Endpoint Benchmark [Cloud]';
const TEST_ID = 'userinfo-benchmark-cloud';

// カスタムメトリクス
const userinfoDuration = new Trend('userinfo_duration');
const userinfoSuccess = new Rate('userinfo_success');
const tokenErrors = new Counter('token_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');
const validationErrors = new Counter('validation_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const PRESET = __ENV.PRESET || 'rps500';
// K6 Cloud用: R2からシードをフェッチするURL
// 注: K6 setup()の4MB制限のため、ValidトークンのみのファイルをURLからフェッチ
const TOKEN_URL =
  __ENV.TOKEN_URL ||
  'https://pub-999cabb8466b46c4a2b32b63ef5579cc.r2.dev/seeds/valid_tokens_4k.json';

// K6 Cloud Project ID（環境変数で上書き可能）
const K6_CLOUD_PROJECT_ID = __ENV.K6_CLOUD_PROJECT_ID || '';

/**
 * プリセット設定 - K6 Cloud最適化版
 *
 * K6 Cloudの分散実行により、ローカル版より高いRPSが可能
 * - クライアント側のTCP制限なし
 * - 複数リージョンからの分散負荷
 *
 * 仕様書準拠:
 * - 成功率: > 99.9%
 * - p95: < 200ms, p99: < 300ms
 */
const PRESETS = {
  // 軽量テスト（確認用）
  rps100: {
    description: '100 RPS - Cloud smoke test (1 min)',
    stages: [
      { target: 50, duration: '10s' },
      { target: 100, duration: '60s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.01'],
      userinfo_success: ['rate>0.99'],
    },
    preAllocatedVUs: 150,
    maxVUs: 200,
  },

  // ベンチマーク: 500 RPS (3分)
  rps500: {
    description: '500 RPS - UserInfo benchmark (3 min)',
    stages: [
      { target: 250, duration: '15s' },
      { target: 500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 600,
    maxVUs: 800,
  },

  // ベンチマーク: 1000 RPS (3分)
  rps1000: {
    description: '1000 RPS - UserInfo high throughput (3 min)',
    stages: [
      { target: 500, duration: '15s' },
      { target: 1000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 1200,
    maxVUs: 1500,
  },

  // ベンチマーク: 1500 RPS (3分)
  rps1500: {
    description: '1500 RPS - UserInfo stress test (3 min)',
    stages: [
      { target: 750, duration: '15s' },
      { target: 1500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 1800,
    maxVUs: 2200,
  },

  // ベンチマーク: 2000 RPS (3分)
  rps2000: {
    description: '2000 RPS - UserInfo maximum capacity (3 min)',
    stages: [
      { target: 1000, duration: '15s' },
      { target: 2000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 2400,
    maxVUs: 3000,
  },

  // ベンチマーク: 2500 RPS (3分)
  rps2500: {
    description: '2500 RPS - UserInfo capacity limit (3 min)',
    stages: [
      { target: 1250, duration: '15s' },
      { target: 2500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.002'],
      userinfo_success: ['rate>0.998'],
    },
    preAllocatedVUs: 3000,
    maxVUs: 3800,
  },

  // ベンチマーク: 3000 RPS (3分)
  rps3000: {
    description: '3000 RPS - UserInfo high stress (3 min)',
    stages: [
      { target: 1500, duration: '15s' },
      { target: 3000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.005'],
      userinfo_success: ['rate>0.995'],
    },
    preAllocatedVUs: 3600,
    maxVUs: 4500,
  },

  // ベンチマーク: 4000 RPS (3分)
  rps4000: {
    description: '4000 RPS - UserInfo extreme (3 min)',
    stages: [
      { target: 2000, duration: '15s' },
      { target: 4000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<800'],
      http_req_failed: ['rate<0.01'],
      userinfo_success: ['rate>0.99'],
    },
    preAllocatedVUs: 4800,
    maxVUs: 6000,
  },

  // ベンチマーク: 5000 RPS (3分)
  rps5000: {
    description: '5000 RPS - UserInfo ultimate (3 min)',
    stages: [
      { target: 2500, duration: '15s' },
      { target: 5000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.02'],
      userinfo_success: ['rate>0.98'],
    },
    preAllocatedVUs: 6000,
    maxVUs: 7500,
  },
};

// プリセット検証
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Unknown preset: ${PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`);
}

// ウォームアップ設定
const WARMUP_DURATION = '30s';
const WARMUP_RPS = 50;
const WARMUP_VUS = 100;

// ターゲットRPSを抽出（プリセット名からパース）
const targetRps = parseInt(PRESET.replace('rps', ''), 10) || 500;

// K6オプション - ウォームアップ + 本測定の2シナリオ構成
export const options = {
  scenarios: {
    // シナリオ1: ウォームアップ（コールドスタート対策）
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RPS,
      timeUnit: '1s',
      duration: WARMUP_DURATION,
      preAllocatedVUs: WARMUP_VUS,
      maxVUs: WARMUP_VUS * 2,
      tags: { scenario: 'warmup' },
      exec: 'warmupScenario',
    },
    // シナリオ2: 本測定（ウォームアップ完了後に開始）
    userinfo_benchmark: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
      startTime: WARMUP_DURATION, // ウォームアップ完了後に開始
      tags: { scenario: 'benchmark' },
      exec: 'benchmarkScenario',
    },
  },
  thresholds: {
    // 本測定シナリオのみにthresholdsを適用
    'http_req_duration{scenario:benchmark}': selectedPreset.thresholds.http_req_duration,
    'http_req_failed{scenario:benchmark}': selectedPreset.thresholds.http_req_failed,
    'userinfo_success{scenario:benchmark}': selectedPreset.thresholds.userinfo_success,
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  // K6 Cloud設定
  cloud: {
    projectID: K6_CLOUD_PROJECT_ID ? parseInt(K6_CLOUD_PROJECT_ID, 10) : undefined,
    name: `${TEST_ID}-${PRESET}`,
    distribution: {
      // US Oregon region to test DO location hypothesis
      'amazon:us:portland': { loadZone: 'amazon:us:portland', percent: 100 },
    },
  },
};

// セットアップ（テスト開始前に1回だけ実行）
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`☁️  K6 Cloud Mode: Fetching tokens from R2`);
  console.log(``);

  // K6 Cloud: R2からトークンを取得
  // フォーマット: トークン文字列の配列 (K6 setup() 4MB制限対応)
  console.log(`📥 Fetching tokens from: ${TOKEN_URL}`);
  const response = http.get(TOKEN_URL, { timeout: '120s' });
  if (response.status !== 200) {
    throw new Error(`Failed to fetch tokens: ${response.status} - ${response.body}`);
  }

  const tokens = JSON.parse(response.body); // 配列: ["eyJ...", "eyJ...", ...]
  console.log(`   Loaded ${tokens.length} valid tokens from R2`);

  if (tokens.length === 0) {
    throw new Error('No valid tokens found in R2. Upload valid_tokens_4k.json to R2 first.');
  }

  // ウォームアップ: 最初の数リクエストでDOを初期化
  console.log(`🔥 Warming up...`);
  for (let i = 0; i < Math.min(10, tokens.length); i++) {
    const token = tokens[i];
    http.get(`${BASE_URL}/userinfo`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'Warmup' },
    });
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    tokens: tokens,
    tokenCount: tokens.length,
    preset: PRESET,
    baseUrl: BASE_URL,
  };
}

// 共通のUserInfoリクエスト処理
function executeUserInfoRequest(data, scenarioTag) {
  const tokens = data.tokens;
  const tokenCount = data.tokenCount;

  // VU IDベースでトークンを選択（ラウンドロビン）
  const tokenIndex = (__VU - 1) % tokenCount;
  const token = tokens[tokenIndex]; // 文字列として直接使用

  // /userinfo リクエスト
  const params = {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
    tags: {
      name: 'UserInfoRequest',
      preset: PRESET,
      scenario: scenarioTag,
    },
  };

  const response = http.get(`${BASE_URL}/userinfo`, params);
  const duration = response.timings.duration;

  // メトリクス記録
  userinfoDuration.add(duration, { scenario: scenarioTag });

  // レスポンス検証
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (_) {
    // ignore parse errors
  }

  // 仕様書準拠: sub / email_verified などを検証
  const success = check(
    response,
    {
      'status is 200': (r) => r.status === 200,
      'has sub claim': () => responseBody.sub !== undefined,
      'has email_verified claim': () => responseBody.email_verified !== undefined,
      'response time < 500ms': (r) => r.timings.duration < 500,
    },
    { scenario: scenarioTag }
  );

  userinfoSuccess.add(success, { scenario: scenarioTag });

  // エラー分類
  if (response.status === 401 || response.status === 403) {
    tokenErrors.add(1, { scenario: scenarioTag });
  }
  if (response.status === 429) {
    rateLimitErrors.add(1, { scenario: scenarioTag });
  }
  if (response.status >= 500) {
    serverErrors.add(1, { scenario: scenarioTag });
  }
  if (!success) {
    validationErrors.add(1, { scenario: scenarioTag });
  }
}

// ウォームアップシナリオ（コールドスタート対策）
export function warmupScenario(data) {
  executeUserInfoRequest(data, 'warmup');
}

// 本測定シナリオ（thresholds適用対象）
export function benchmarkScenario(data) {
  executeUserInfoRequest(data, 'benchmark');
}

// K6 Cloudでは exec で指定したシナリオ関数のみが呼び出されるため
// default は不要。ローカルデバッグ用に最小限残す
export default function () {
  // このfunctionはK6 Cloud実行では呼び出されない（exec指定時）
  // ローカルでk6 run実行時のフォールバック
  console.log('Warning: default function should not be called in Cloud mode');
}

// ティアダウン（テスト終了後に1回だけ実行）
export function teardown(data) {
  console.log(``);
  console.log(`✅ ${TEST_NAME} テスト完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
  console.log(`📈 トークン数: ${data.tokenCount}`);
}

// サマリーハンドラー
export function handleSummary(data) {
  const preset = PRESET;
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\..+/, '')
    .replace('T', '_');
  const resultsDir = __ENV.RESULTS_DIR || './results';

  return {
    [`${resultsDir}/${TEST_ID}-${preset}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// テキストサマリー生成
function textSummary(data, options) {
  const indent = options.indent || '';

  let summary = '\n';
  summary += `${indent}📊 ${TEST_NAME} - サマリー\n`;
  summary += `${indent}${'='.repeat(70)}\n\n`;

  // テスト情報
  summary += `${indent}🎯 プリセット: ${PRESET}\n`;
  summary += `${indent}📝 説明: ${selectedPreset.description}\n\n`;

  // 基本統計
  const metrics = data.metrics;
  const totalRequests = metrics.http_reqs?.values?.count || 0;
  const failedRequests = metrics.http_req_failed?.values?.passes || 0;
  const successRequests = totalRequests - failedRequests;
  const successRate = ((metrics.userinfo_success?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}📈 リクエスト統計:\n`;
  summary += `${indent}  総リクエスト数: ${totalRequests}\n`;
  summary += `${indent}  成功: ${successRequests}\n`;
  summary += `${indent}  失敗: ${failedRequests}\n`;
  summary += `${indent}  成功率: ${successRate}%\n\n`;

  // レスポンスタイム
  summary += `${indent}⏱️  レスポンスタイム:\n`;
  summary += `${indent}  平均: ${metrics.http_req_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p50: ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p90: ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p95: ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p99: ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p999: ${metrics.http_req_duration?.values?.['p(99.9)']?.toFixed(2) || 0}ms\n\n`;

  // 仕様書準拠チェック
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.userinfo_success?.values?.rate || 0;

  summary += `${indent}📋 仕様書準拠チェック:\n`;
  summary += `${indent}  成功率 > 99.9%: ${rate > 0.999 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 200ms: ${p95 < 200 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 300ms: ${p99 < 300 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n\n`;

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  トークンエラー (401/403): ${metrics.token_errors?.values?.count || 0}\n`;
  summary += `${indent}  レート制限 (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  サーバーエラー (5xx): ${metrics.server_errors?.values?.count || 0}\n`;
  summary += `${indent}  検証エラー: ${metrics.validation_errors?.values?.count || 0}\n\n`;

  // スループット
  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 スループット: ${rps.toFixed(2)} req/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
