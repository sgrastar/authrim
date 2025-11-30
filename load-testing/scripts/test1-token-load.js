/**
 * TEST 1: /token 単体負荷テスト
 *
 * 目的:
 * - Authrim の最大RPS上限を測定
 * - DO ロック競合の発生域を確認
 * - JWT 署名の CPU-ms の実負荷を測る
 *
 * 使い方:
 * k6 run --env PRESET=light scripts/test1-token-load.js
 * k6 run --env PRESET=standard scripts/test1-token-load.js
 * k6 run --env PRESET=heavy scripts/test1-token-load.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';

// カスタムメトリクス
const tokenRequestDuration = new Trend('token_request_duration');
const tokenRequestSuccess = new Rate('token_request_success');
const authErrors = new Counter('auth_errors');
const rateLimitErrors = new Counter('rate_limit_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://example.com/callback';
const PRESET = __ENV.PRESET || 'light';
const AUTH_CODE_PATH = __ENV.AUTH_CODE_PATH || '../seeds/authorization_codes.json';

// プリセット設定
const PRESETS = {
  light: {
    startRate: 5,
    stages: [
      { target: 5, duration: '10s' },   // Ramp up to 5 RPS
      { target: 20, duration: '20s' },  // Ramp up to 20 RPS
      { target: 20, duration: '20s' },  // Stay at 20 RPS
      { target: 5, duration: '10s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<250'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<250'],
    },
    preAllocatedVUs: 20,
    maxVUs: 30,
  },
  standard: {
    startRate: 30,
    stages: [
      { target: 30, duration: '20s' },  // Ramp up to 30 RPS
      { target: 100, duration: '40s' }, // Ramp up to 100 RPS
      { target: 100, duration: '40s' }, // Stay at 100 RPS
      { target: 30, duration: '20s' },  // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<500'],
      http_req_failed: ['rate<0.01'],
      token_request_duration: ['p(99)<500'],
    },
    preAllocatedVUs: 100,
    maxVUs: 150,
  },
  heavy: {
    startRate: 200,
    stages: [
      { target: 200, duration: '30s' },  // Ramp up to 200 RPS
      { target: 400, duration: '60s' },  // Ramp up to 400 RPS
      { target: 600, duration: '60s' },  // Ramp up to 600 RPS
      { target: 400, duration: '30s' },  // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<750'],
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
  scenarios: {
    token_load: {
      executor: 'ramping-arrival-rate',
      startRate: selectedPreset.startRate,
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
      `Authorization code seed not found or invalid at "${AUTH_CODE_PATH}". Run scripts/generate-seeds.js to create it. (${err.message})`,
    );
  }
});
if (!authorizationCodes.length) {
  throw new Error('No authorization codes available for test1. Aborting.');
}

// Basic 認証ヘッダーの生成
function getBasicAuthHeader() {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${encoding.b64encode(credentials)}`;
}

// セットアップ（テスト開始前に1回だけ実行）
export function setup() {
  console.log(`🚀 TEST 1: /token 単体負荷テスト`);
  console.log(`📊 プリセット: ${PRESET}`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);
  console.log(`📝 認可コード数: ${authorizationCodes.length}`);

  return {
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    preset: PRESET,
  };
}

// メインテスト関数
export default function (data) {
  // ランダムに認可コードを選択
  const codeData = authorizationCodes[Math.floor(Math.random() * authorizationCodes.length)];

  // /token リクエストのパラメータ
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': getBasicAuthHeader(),
    },
    tags: {
      name: 'TokenRequest',
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
    'response time < 1000ms': (r) => r.timings.duration < 1000,
  });

  tokenRequestSuccess.add(success);

  // エラーハンドリング
  if (response.status === 401 || response.status === 403) {
    authErrors.add(1);
  }

  if (response.status === 429) {
    rateLimitErrors.add(1);
  }

  if (!success && PRESET === 'light') {
    console.error(`❌ Request failed: ${response.status} - ${response.body}`);
  }

  // Heavy プリセットでは Think Time なし
  if (PRESET === 'light') {
    sleep(0.1); // 100ms
  }
}

// ティアダウン（テスト終了後に1回だけ実行）
export function teardown(data) {
  console.log(`✅ TEST 1 完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
}

// サマリーハンドラー
export function handleSummary(data) {
  const preset = PRESET;
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const resultsDir = __ENV.RESULTS_DIR || '../results';

  return {
    [`${resultsDir}/test1-${preset}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// テキストサマリー生成
function textSummary(data, options) {
  const indent = options.indent || '';
  const colors = options.enableColors;

  let summary = '\n';
  summary += `${indent}📊 TEST 1: /token 単体負荷テスト - サマリー\n`;
  summary += `${indent}${'='.repeat(60)}\n\n`;

  // 基本統計
  const metrics = data.metrics;
  summary += `${indent}📈 リクエスト統計:\n`;
  summary += `${indent}  総リクエスト数: ${metrics.http_reqs?.values?.count || 0}\n`;
  summary += `${indent}  成功: ${metrics.http_req_failed ? (metrics.http_reqs.values.count - metrics.http_req_failed.values.passes) : 0}\n`;
  summary += `${indent}  失敗: ${metrics.http_req_failed?.values?.passes || 0}\n`;
  summary += `${indent}  失敗率: ${((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%\n\n`;

  // レスポンスタイム
  summary += `${indent}⏱️  レスポンスタイム:\n`;
  summary += `${indent}  p50: ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p90: ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p95: ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p99: ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  // カスタムメトリクス
  if (metrics.auth_errors) {
    summary += `${indent}❌ 認証エラー: ${metrics.auth_errors.values.count}\n`;
  }
  if (metrics.rate_limit_errors) {
    summary += `${indent}⚠️  Rate Limit エラー: ${metrics.rate_limit_errors.values.count}\n`;
  }

  summary += `${indent}\n${'='.repeat(60)}\n`;

  return summary;
}
