/**
 * /token (authorization_code) 負荷テスト
 *
 * 目的:
 * - authorization_code grant の最大 RPS を測定
 * - DO ロック競合の発生域を確認
 * - JWT 署名の CPU-ms の実負荷を測る
 *
 * 使い方:
 * k6 run --env PRESET=rps100 scripts/token-authcode.js
 * k6 run --env PRESET=rps300 scripts/token-authcode.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

// テスト識別情報
const TEST_NAME = '/token (authorization_code)';
const TEST_ID = 'token-authcode';

// カスタムメトリクス
const tokenRequestDuration = new Trend('token_request_duration');
const tokenRequestSuccess = new Rate('token_request_success');
const authErrors = new Counter('auth_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://example.com/callback';
const PRESET = __ENV.PRESET || 'rps100';
const AUTH_CODE_PATH = __ENV.AUTH_CODE_PATH || '../seeds/authorization_codes.json';

// プリセット設定
const PRESETS = {
  light: {
    description: '20 RPS light load - Development testing',
    stages: [
      { target: 5, duration: '10s' },
      { target: 20, duration: '20s' },
      { target: 20, duration: '20s' },
      { target: 5, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<250'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<250'],
    },
    preAllocatedVUs: 20,
    maxVUs: 30,
  },
  rps50: {
    description: '50 RPS sustained load - Light production',
    stages: [
      { target: 10, duration: '10s' },
      { target: 50, duration: '15s' },
      { target: 50, duration: '120s' },
      { target: 10, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<300'],
    },
    preAllocatedVUs: 60,
    maxVUs: 80,
  },
  rps100: {
    description: '100 RPS sustained load - Production baseline',
    stages: [
      { target: 20, duration: '10s' },
      { target: 50, duration: '10s' },
      { target: 100, duration: '15s' },
      { target: 100, duration: '120s' },
      { target: 50, duration: '10s' },
      { target: 20, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<400'],
    },
    preAllocatedVUs: 120,
    maxVUs: 150,
  },
  rps200: {
    description: '200 RPS sustained load - High traffic scenario',
    stages: [
      { target: 50, duration: '10s' },
      { target: 100, duration: '10s' },
      { target: 200, duration: '15s' },
      { target: 200, duration: '120s' },
      { target: 100, duration: '10s' },
      { target: 50, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<500'],
    },
    preAllocatedVUs: 200,
    maxVUs: 300,
  },
  // 標準ベンチマーク: 2分間 300 RPS テスト
  rps300: {
    description: '300 RPS sustained load - Standard benchmark (2 min)',
    stages: [
      { target: 300, duration: '10s' },
      { target: 300, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<500'],
    },
    preAllocatedVUs: 300,
    maxVUs: 400,
  },
  rps500: {
    description: '500 RPS sustained load - High capacity benchmark (2 min)',
    stages: [
      { target: 500, duration: '10s' },
      { target: 500, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<600'],
      http_req_failed: ['rate<0.01'],
      token_request_duration: ['p(99)<600'],
    },
    preAllocatedVUs: 500,
    maxVUs: 600,
  },
  rps1000: {
    description: '1000 RPS sustained load - Extreme capacity benchmark (2 min)',
    stages: [
      { target: 1000, duration: '15s' },
      { target: 1000, duration: '120s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<800'],
      http_req_failed: ['rate<0.02'],
      token_request_duration: ['p(99)<800'],
    },
    preAllocatedVUs: 800,
    maxVUs: 1000,
  },
  heavy: {
    description: '600 RPS peak load - Stress testing',
    stages: [
      { target: 200, duration: '30s' },
      { target: 400, duration: '60s' },
      { target: 600, duration: '60s' },
      { target: 400, duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<750'],
      http_req_failed: ['rate<0.05'],
      token_request_duration: ['p(99)<750'],
    },
    preAllocatedVUs: 200,
    maxVUs: 600,
  },
};

// 選択されたプリセット
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Invalid PRESET "${PRESET}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
}

// テストオプション
export const options = {
  // K6 Cloud 設定
  cloud: {
    projectID: 5942435,
    name: `Authrim - Token AuthCode (${PRESET})`,
    distribution: {
      'amazon:jp:tokyo': { loadZone: 'amazon:jp:tokyo', percent: 100 },
    },
  },
  scenarios: {
    token_authcode: {
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

// テストデータ: 事前生成された認可コード
const authorizationCodes = new SharedArray('authz_codes', function () {
  try {
    const raw = open(AUTH_CODE_PATH);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('authorization_codes is empty');
    }
    const normalized = parsed
      .map((item, idx) => ({
        code: item.code,
        verifier: item.code_verifier || item.verifier,
        redirectUri: item.redirect_uri || REDIRECT_URI,
        index: idx,
      }))
      .filter((item) => item.code && item.verifier);

    if (normalized.length === 0) {
      throw new Error('authorization_codes has no usable entries');
    }
    return normalized;
  } catch (err) {
    throw new Error(
      `Authorization code seed not found or invalid at "${AUTH_CODE_PATH}". Run scripts/generate-seeds.js to create it. (${err.message})`
    );
  }
});
if (!authorizationCodes.length) {
  throw new Error(`No authorization codes available for ${TEST_ID}. Aborting.`);
}

// Basic 認証ヘッダーの生成
function getBasicAuthHeader() {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${encoding.b64encode(credentials)}`;
}

// セットアップ（テスト開始前に1回だけ実行）
export function setup() {
  console.log(`🚀 ${TEST_NAME} 負荷テスト`);
  console.log(`📊 プリセット: ${PRESET}`);
  console.log(`📝 説明: ${selectedPreset.description}`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);
  console.log(`📦 認可コード数: ${authorizationCodes.length}`);
  console.log(``);

  return {
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    preset: PRESET,
  };
}

// メインテスト関数
export default function (data) {
  // グローバルイテレーション番号を使用して一意のコードを選択
  const globalIterationId = exec.scenario.iterationInTest;
  const codeIndex = globalIterationId % authorizationCodes.length;
  const codeData = authorizationCodes[codeIndex];

  // /token リクエストのパラメータ
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Connection: 'keep-alive',
      Authorization: getBasicAuthHeader(),
    },
    tags: {
      name: 'TokenAuthCodeRequest',
      preset: PRESET,
    },
  };

  const payload = [
    `grant_type=authorization_code`,
    `code=${codeData.code}`,
    `redirect_uri=${encodeURIComponent(codeData.redirectUri || REDIRECT_URI)}`,
    `code_verifier=${codeData.verifier}`,
  ].join('&');

  // リクエスト送信
  const response = http.post(`${BASE_URL}/token`, payload, params);
  const duration = response.timings.duration;

  // メトリクス記録
  tokenRequestDuration.add(duration);

  // レスポンスチェック
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (_) {
    // ignore parse errors
  }

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has access_token': () => responseBody.access_token !== undefined,
    'has token_type': () => responseBody.token_type === 'Bearer',
    'response time < 5000ms': (r) => r.timings.duration < 5000,
  });

  tokenRequestSuccess.add(success);

  // エラーハンドリング
  if (response.status === 401 || response.status === 403) {
    authErrors.add(1);
  }
  if (response.status === 429) {
    rateLimitErrors.add(1);
  }
  if (response.status >= 500) {
    serverErrors.add(1);
  }

  if (!success && PRESET === 'light') {
    // デバッグ: どのチェックが失敗したか確認
    console.error(`❌ Check failed:`);
    console.error(`   status: ${response.status} (expected 200)`);
    console.error(`   has access_token: ${responseBody.access_token !== undefined}`);
    console.error(`   token_type: ${responseBody.token_type} (expected Bearer)`);
    console.error(`   duration: ${response.timings.duration}ms (expected < 1000ms)`);
  }

  // Light プリセットでは Think Time あり
  if (PRESET === 'light') {
    sleep(0.1);
  }
}

// ティアダウン（テスト終了後に1回だけ実行）
export function teardown(data) {
  console.log(``);
  console.log(`✅ ${TEST_NAME} テスト完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
}

// サマリーハンドラー
export function handleSummary(data) {
  const preset = PRESET;
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\..+/, '')
    .replace('T', '_');
  const resultsDir = __ENV.RESULTS_DIR || '../results';

  return {
    [`${resultsDir}/${TEST_ID}-${preset}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    [`${resultsDir}/${TEST_ID}-${preset}_${timestamp}.log`]: textSummary(data, {
      indent: ' ',
      enableColors: false,
    }),
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

  summary += `${indent}📈 リクエスト統計:\n`;
  summary += `${indent}  総リクエスト数: ${totalRequests}\n`;
  summary += `${indent}  成功: ${successRequests}\n`;
  summary += `${indent}  失敗: ${failedRequests}\n`;
  summary += `${indent}  失敗率: ${((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%\n\n`;

  // レスポンスタイム
  summary += `${indent}⏱️  レスポンスタイム:\n`;
  summary += `${indent}  平均: ${metrics.http_req_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p50: ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p90: ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p95: ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p99: ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  認証エラー (401/403): ${metrics.auth_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate Limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  サーバーエラー (5xx): ${metrics.server_errors?.values?.count || 0}\n\n`;

  // 判定
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const errorRate = (metrics.http_req_failed?.values?.rate || 0) * 100;

  summary += `${indent}✅ 判定:\n`;

  // プリセットごとの閾値で判定
  let p95Threshold, p99Threshold, errorThreshold;
  if (PRESET === 'light') {
    p95Threshold = 200;
    p99Threshold = 250;
    errorThreshold = 0.1;
  } else if (PRESET === 'rps50') {
    p95Threshold = 250;
    p99Threshold = 300;
    errorThreshold = 0.1;
  } else if (PRESET === 'rps100') {
    p95Threshold = 250;
    p99Threshold = 400;
    errorThreshold = 0.1;
  } else if (PRESET === 'rps200') {
    p95Threshold = 300;
    p99Threshold = 500;
    errorThreshold = 0.1;
  } else if (PRESET === 'rps300') {
    p95Threshold = 300;
    p99Threshold = 500;
    errorThreshold = 0.1;
  } else if (PRESET === 'rps500') {
    p95Threshold = 400;
    p99Threshold = 600;
    errorThreshold = 1;
  } else {
    p95Threshold = 500;
    p99Threshold = 750;
    errorThreshold = 5;
  }

  const p95Pass = p95 < p95Threshold;
  const p99Pass = p99 < p99Threshold;
  const errorPass = errorRate < errorThreshold;
  const pass = p95Pass && p99Pass && errorPass;

  summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
  summary += `${indent}  - p95 < ${p95Threshold}ms: ${p95Pass ? '✅' : '❌'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  - p99 < ${p99Threshold}ms: ${p99Pass ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  - エラーレート < ${errorThreshold}%: ${errorPass ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;

  summary += `${indent}\n${'='.repeat(70)}\n`;

  return summary;
}
