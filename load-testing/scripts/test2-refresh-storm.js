/**
 * TEST 2: Refresh Token Storm
 *
 * 目的:
 * - 実世界の最大トラフィックを測定
 * - D1 書き込み負荷の確認
 * - DO Token Rotator の競合チェック
 *
 * 使い方:
 * k6 run --env PRESET=light scripts/test2-refresh-storm.js
 * k6 run --env PRESET=standard scripts/test2-refresh-storm.js
 * k6 run --env PRESET=heavy scripts/test2-refresh-storm.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';

// カスタムメトリクス
const refreshRequestDuration = new Trend('refresh_request_duration');
const refreshRequestSuccess = new Rate('refresh_request_success');
const tokenRotationSuccess = new Rate('token_rotation_success');
const d1WriteErrors = new Counter('d1_write_errors');
const doLockContention = new Counter('do_lock_contention');
const refreshTokenReuse = new Counter('refresh_token_reuse');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const PRESET = __ENV.PRESET || 'light';
const REFRESH_TOKEN_PATH = __ENV.REFRESH_TOKEN_PATH || '../seeds/refresh_tokens.json';

// プリセット設定
const PRESETS = {
  light: {
    startRate: 50,
    stages: [
      { target: 50, duration: '60s' },   // Ramp up to 50 RPS
      { target: 50, duration: '180s' },  // Stay at 50 RPS (5 min total)
      { target: 25, duration: '60s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<300'],
      http_req_failed: ['rate<0.001'],
      refresh_request_duration: ['p(99)<300'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 50,
    maxVUs: 75,
    thinkTime: 0.1, // 100ms
  },
  standard: {
    startRate: 200,
    stages: [
      { target: 200, duration: '60s' },   // Ramp up to 200 RPS
      { target: 500, duration: '180s' },  // Ramp up to 500 RPS
      { target: 500, duration: '300s' },  // Stay at 500 RPS (10 min total)
      { target: 200, duration: '60s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<500'],
      http_req_failed: ['rate<0.001'],
      refresh_request_duration: ['p(99)<500'],
      d1_write_errors: ['rate<0.001'],
    },
    preAllocatedVUs: 200,
    maxVUs: 500,
    thinkTime: 0.05, // 50ms
  },
  heavy: {
    startRate: 800,
    stages: [
      { target: 800, duration: '60s' },    // Ramp up to 800 RPS
      { target: 1200, duration: '120s' },  // Ramp up to 1200 RPS
      { target: 1200, duration: '300s' },  // Stay at 1200 RPS (10 min total)
      { target: 600, duration: '120s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<1000'],
      http_req_failed: ['rate<0.02'],
      refresh_request_duration: ['p(99)<1000'],
      d1_write_errors: ['rate<0.02'],
      refresh_request_success: ['rate>0.90'],
      token_rotation_success: ['rate>0.90'],
    },
    preAllocatedVUs: 800,
    maxVUs: 1200,
    thinkTime: 0, // No think time
  },
  custom: {
    startRate: 100,
    stages: [
      { target: 100, duration: '30s' },    // Warm up at 100 RPS
      { target: 200, duration: '60s' },    // Ramp to 200 RPS
      { target: 400, duration: '60s' },    // Ramp to 400 RPS
      { target: 600, duration: '60s' },    // Ramp to 600 RPS
      { target: 600, duration: '180s' },   // Sustain at 600 RPS (3 min)
      { target: 300, duration: '30s' },    // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<500'],
      http_req_failed: ['rate<0.01'],
      refresh_request_duration: ['p(99)<500'],
      d1_write_errors: ['count<10'],
    },
    preAllocatedVUs: 100,
    maxVUs: 150,
    thinkTime: 0, // No think time for max throughput
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
    refresh_storm: {
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

// テストデータ: 事前生成された Refresh Token
const refreshTokens = new SharedArray('refresh_tokens', function () {
  try {
    const raw = open(REFRESH_TOKEN_PATH);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('refresh_tokens is empty');
    }
    const normalized = parsed
      .map((item, idx) => ({
        token: item.refresh_token || item.token,
        userId: item.user_id || item.userId || `user_${idx}`,
      }))
      .filter((item) => item.token);

    if (normalized.length === 0) {
      throw new Error('refresh_tokens has no usable entries');
    }
    return normalized;
  } catch (err) {
    throw new Error(
      `Refresh token seed not found or invalid at "${REFRESH_TOKEN_PATH}". Run scripts/generate-seeds.js to create it. (${err.message})`,
    );
  }
});
if (!refreshTokens.length) {
  throw new Error('No refresh tokens available for test2. Aborting.');
}

// VU ごとの状態管理（Token Rotation 追跡用）
let currentToken = null;

// Basic 認証ヘッダーの生成
function getBasicAuthHeader() {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${encoding.b64encode(credentials)}`;
}

// セットアップ
export function setup() {
  console.log(`🚀 TEST 2: Refresh Token Storm`);
  console.log(`📊 プリセット: ${PRESET}`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);
  console.log(`📝 Refresh Token 数: ${refreshTokens.length}`);

  return {
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    preset: PRESET,
  };
}

// メインテスト関数
export default function (data) {
  // 初回または前回のリクエストでトークンがローテーションされた場合は新しいトークンを取得
  if (!currentToken) {
    currentToken = refreshTokens[Math.floor(Math.random() * refreshTokens.length)];
  }

  // /token リクエストのパラメータ
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': getBasicAuthHeader(),
    },
    tags: {
      name: 'RefreshTokenRequest',
      preset: PRESET,
    },
  };

  const payload = [
    `grant_type=refresh_token`,
    `refresh_token=${currentToken.token}`,
  ].join('&');

  // リクエスト送信
  const response = http.post(`${BASE_URL}/token`, payload, params);
  const duration = response.timings.duration;

  // メトリクス記録
  refreshRequestDuration.add(duration);

  // レスポンスチェック
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (e) {
    // JSON パースエラー
  }

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has access_token': (r) => responseBody.access_token !== undefined,
    'has refresh_token': (r) => responseBody.refresh_token !== undefined,
    'token_type is Bearer': (r) => responseBody.token_type === 'Bearer',
    'new refresh_token differs': (r) => {
      // Token Rotation が有効な場合、新しい Refresh Token は古いものと異なるはず
      if (responseBody.refresh_token) {
        return responseBody.refresh_token !== currentToken.token;
      }
      return false;
    },
  });

  refreshRequestSuccess.add(success);

  // Token Rotation の成功チェック
  if (responseBody.refresh_token && responseBody.refresh_token !== currentToken.token) {
    tokenRotationSuccess.add(1);
    // 次回は新しいトークンを使用
    currentToken = {
      token: responseBody.refresh_token,
      userId: currentToken.userId,
    };
  } else {
    tokenRotationSuccess.add(0);
  }

  // エラーハンドリング
  if (response.status === 400 && response.body.includes('invalid_grant')) {
    // Refresh Token が既に使用済み（重複使用検出）
    refreshTokenReuse.add(1);

    // 新しいトークンを取得
    currentToken = refreshTokens[Math.floor(Math.random() * refreshTokens.length)];
  }

  if (response.status === 500) {
    // D1 書き込みエラーの可能性
    if (response.body.includes('D1') || response.body.includes('database')) {
      d1WriteErrors.add(1);
    }

    // DO ロック競合の可能性
    if (response.body.includes('lock') || response.body.includes('contention')) {
      doLockContention.add(1);
    }
  }

  if (!success && PRESET === 'light') {
    console.error(`❌ Refresh failed: ${response.status} - ${response.body}`);
  }

  // Think Time
  if (selectedPreset.thinkTime > 0) {
    sleep(selectedPreset.thinkTime);
  }
}

// ティアダウン
export function teardown(data) {
  console.log(`✅ TEST 2 完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
}

// サマリーハンドラー
export function handleSummary(data) {
  const preset = PRESET;
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const resultsDir = __ENV.RESULTS_DIR || '../results';

  return {
    [`${resultsDir}/test2-${preset}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// テキストサマリー生成
function textSummary(data, options) {
  const indent = options.indent || '';

  let summary = '\n';
  summary += `${indent}📊 TEST 2: Refresh Token Storm - サマリー\n`;
  summary += `${indent}${'='.repeat(60)}\n\n`;

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

  // Token Rotation 統計
  if (metrics.token_rotation_success) {
    const rotationRate = metrics.token_rotation_success.values.rate * 100;
    summary += `${indent}🔄 Token Rotation:\n`;
    summary += `${indent}  成功率: ${rotationRate.toFixed(2)}%\n`;
    summary += `${indent}  成功数: ${metrics.token_rotation_success.values.passes}\n\n`;
  }

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  D1 書き込みエラー: ${metrics.d1_write_errors?.values?.count || 0}\n`;
  summary += `${indent}  DO ロック競合: ${metrics.do_lock_contention?.values?.count || 0}\n`;
  summary += `${indent}  Refresh Token 重複使用: ${metrics.refresh_token_reuse?.values?.count || 0}\n\n`;

  // 判定
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const errorRate = (metrics.http_req_failed?.values?.rate || 0) * 100;
  const d1Errors = metrics.d1_write_errors?.values?.count || 0;

  summary += `${indent}✅ 判定:\n`;

  if (PRESET === 'light') {
    const pass = p99 < 300 && errorRate < 0.1 && d1Errors === 0;
    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - p99 < 300ms: ${p99 < 300 ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 0.1%: ${errorRate < 0.1 ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - D1 エラー = 0: ${d1Errors === 0 ? '✅' : '❌'} (${d1Errors})\n`;
  } else if (PRESET === 'standard') {
    const pass = p99 < 500 && errorRate < 0.1 && (d1Errors / totalRequests) < 0.001;
    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - p99 < 500ms: ${p99 < 500 ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 0.1%: ${errorRate < 0.1 ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - D1 エラー < 0.1%: ${(d1Errors / totalRequests) < 0.001 ? '✅' : '❌'} (${((d1Errors / totalRequests) * 100).toFixed(2)}%)\n`;
  } else if (PRESET === 'heavy') {
    const pass = errorRate < 2 && (d1Errors / totalRequests) < 0.02;
    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - エラーレート < 2%: ${errorRate < 2 ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - D1 エラー < 2%: ${(d1Errors / totalRequests) < 0.02 ? '✅' : '❌'} (${((d1Errors / totalRequests) * 100).toFixed(2)}%)\n`;
    summary += `${indent}  - DO 競合観測: ${metrics.do_lock_contention?.values?.count || 0} 件\n`;
  } else if (PRESET === 'custom') {
    const pass = p99 < 500 && errorRate < 1 && d1Errors < 10;
    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - p99 < 500ms: ${p99 < 500 ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 1%: ${errorRate < 1 ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - D1 エラー < 10: ${d1Errors < 10 ? '✅' : '❌'} (${d1Errors})\n`;
    summary += `${indent}  - DO 競合観測: ${metrics.do_lock_contention?.values?.count || 0} 件\n`;
  }

  summary += `${indent}\n${'='.repeat(60)}\n`;

  return summary;
}
