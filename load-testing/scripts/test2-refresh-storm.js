/**
 * TEST 2: Refresh Token Storm (Production-like)
 *
 * 本番運用に近い設計:
 * - Token Rotation を有効化
 * - VU ごとに独立した token family を持つ
 * - すべて正常な rotation path のみ（エラーケースなし）
 * - Family depth = 1 で常に rotation
 *
 * 使い方:
 * k6 run --env PRESET=rps100 scripts/test2-refresh-storm.js
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
const familyDepthMetric = new Trend('token_family_depth');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const PRESET = __ENV.PRESET || 'rps100';
const REFRESH_TOKEN_PATH = __ENV.REFRESH_TOKEN_PATH || '../seeds/refresh_tokens.json';

// プリセット設定
const PRESETS = {
  rps100: {
    description: '100 RPS sustained load - Production baseline',
    stages: [
      { target: 50, duration: '30s' },    // Warm up
      { target: 100, duration: '30s' },   // Ramp to 100 RPS
      { target: 100, duration: '120s' },  // Sustain 100 RPS (2 min)
      { target: 50, duration: '15s' },    // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      refresh_request_duration: ['p(99)<300'],
      token_rotation_success: ['rate>0.99'], // 99% rotation success
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 100,
    maxVUs: 120,
    thinkTime: 0,
  },
  rps200: {
    description: '200 RPS sustained load - High traffic scenario',
    stages: [
      { target: 100, duration: '30s' },   // Warm up
      { target: 200, duration: '30s' },   // Ramp to 200 RPS
      { target: 200, duration: '120s' },  // Sustain 200 RPS (2 min)
      { target: 100, duration: '15s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.001'],
      refresh_request_duration: ['p(99)<400'],
      token_rotation_success: ['rate>0.99'],
      d1_write_errors: ['count<2'],
    },
    preAllocatedVUs: 200,
    maxVUs: 240,
    thinkTime: 0,
  },
  rps300: {
    description: '300 RPS sustained load - Peak traffic scenario',
    stages: [
      { target: 150, duration: '30s' },   // Warm up
      { target: 300, duration: '30s' },   // Ramp to 300 RPS
      { target: 300, duration: '120s' },  // Sustain 300 RPS (2 min)
      { target: 150, duration: '15s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.005'],
      refresh_request_duration: ['p(99)<500'],
      token_rotation_success: ['rate>0.98'], // Slightly relaxed for high load
      d1_write_errors: ['count<5'],
    },
    preAllocatedVUs: 300,
    maxVUs: 360,
    thinkTime: 0,
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
      startRate: selectedPreset.stages[0].target,
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
        client_id: item.client_id,
        client_secret: item.client_secret,
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

// VU ごとの独立した token family（VU初期化時に設定）
let vuTokenFamily = null;
let familyDepth = 0;

// Basic 認証ヘッダーの生成
function getBasicAuthHeader() {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${encoding.b64encode(credentials)}`;
}

// セットアップ
export function setup() {
  console.log(`🚀 TEST 2: Refresh Token Storm (Production-like)`);
  console.log(`📊 プリセット: ${PRESET}`);
  console.log(`📝 説明: ${selectedPreset.description}`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);
  console.log(`📦 Refresh Token プール: ${refreshTokens.length}`);
  console.log(``);
  console.log(`✨ 本番運用に近い設計:`);
  console.log(`   - Token Rotation 有効化`);
  console.log(`   - VU ごとに独立した token family`);
  console.log(`   - すべて正常な rotation path（エラーケースなし）`);
  console.log(`   - Family depth = 1 で常に rotation`);

  return {
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    preset: PRESET,
  };
}

// メインテスト関数
export default function (data) {
  // VU 初回実行時: 独立した token family を取得
  if (!vuTokenFamily) {
    // VU ID をベースにユニークなインデックスを生成
    const vuId = __VU;
    const tokenIndex = (vuId - 1) % refreshTokens.length;
    vuTokenFamily = {
      ...refreshTokens[tokenIndex],
      vuId: vuId,
    };
    familyDepth = 0;
  }

  // /token リクエストのパラメータ
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    tags: {
      name: 'RefreshTokenRequest',
      preset: PRESET,
      vuId: vuTokenFamily.vuId,
    },
  };

  const payload = [
    `grant_type=refresh_token`,
    `refresh_token=${vuTokenFamily.token}`,
    `client_id=${vuTokenFamily.client_id}`,
    `client_secret=${vuTokenFamily.client_secret}`,
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
    'new refresh_token differs (rotation)': (r) => {
      // Token Rotation が有効な場合、新しい Refresh Token は古いものと異なるはず
      if (responseBody.refresh_token) {
        return responseBody.refresh_token !== vuTokenFamily.token;
      }
      return false;
    },
  });

  refreshRequestSuccess.add(success);

  // Token Rotation の成功チェック
  if (success && responseBody.refresh_token && responseBody.refresh_token !== vuTokenFamily.token) {
    tokenRotationSuccess.add(1);

    // Token family を更新（次回は新しいトークンを使用）
    vuTokenFamily.token = responseBody.refresh_token;
    familyDepth++;
    familyDepthMetric.add(familyDepth);
  } else {
    tokenRotationSuccess.add(0);

    // Rotation 失敗時のデバッグ情報（light モードのみ）
    if (!success && PRESET === 'rps100') {
      console.error(`❌ Token rotation failed for VU ${vuTokenFamily.vuId}:`);
      console.error(`   Status: ${response.status}`);
      console.error(`   Response: ${response.body}`);
    }
  }

  // エラーハンドリング
  if (response.status === 500) {
    // D1 書き込みエラーの可能性
    if (response.body.includes('D1') || response.body.includes('database')) {
      d1WriteErrors.add(1);
    }
  }

  // Think Time（通常は0）
  if (selectedPreset.thinkTime > 0) {
    sleep(selectedPreset.thinkTime);
  }
}

// ティアダウン
export function teardown(data) {
  console.log(``);
  console.log(`✅ TEST 2 完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
}

// サマリーハンドラー
export function handleSummary(data) {
  const preset = PRESET;
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '').replace('T', '_');
  const resultsDir = __ENV.RESULTS_DIR || '../results';

  return {
    [`${resultsDir}/test2-${preset}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    [`${resultsDir}/test2-${preset}_${timestamp}.log`]: textSummary(data, { indent: ' ', enableColors: false }),
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// テキストサマリー生成
function textSummary(data, options) {
  const indent = options.indent || '';

  let summary = '\n';
  summary += `${indent}📊 TEST 2: Refresh Token Storm - サマリー\n`;
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

  // Token Rotation 統計
  if (metrics.token_rotation_success) {
    const rotationRate = metrics.token_rotation_success.values.rate * 100;
    summary += `${indent}🔄 Token Rotation:\n`;
    summary += `${indent}  成功率: ${rotationRate.toFixed(2)}%\n`;
    summary += `${indent}  成功数: ${metrics.token_rotation_success.values.passes || 0}\n`;
    summary += `${indent}  失敗数: ${metrics.token_rotation_success.values.fails || 0}\n`;

    if (metrics.token_family_depth) {
      summary += `${indent}  Family Depth 平均: ${metrics.token_family_depth.values.avg?.toFixed(2) || 0}\n`;
      summary += `${indent}  Family Depth 最大: ${metrics.token_family_depth.values.max || 0}\n`;
    }
    summary += '\n';
  }

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  D1 書き込みエラー: ${metrics.d1_write_errors?.values?.count || 0}\n\n`;

  // 判定
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const errorRate = (metrics.http_req_failed?.values?.rate || 0) * 100;
  const rotationRate = (metrics.token_rotation_success?.values?.rate || 0) * 100;
  const d1Errors = metrics.d1_write_errors?.values?.count || 0;

  summary += `${indent}✅ 判定:\n`;

  if (PRESET === 'rps100') {
    const p95Pass = p95 < 200;
    const p99Pass = p99 < 300;
    const errorPass = errorRate < 0.1;
    const rotationPass = rotationRate > 99;
    const d1Pass = d1Errors === 0;
    const pass = p95Pass && p99Pass && errorPass && rotationPass && d1Pass;

    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - p95 < 200ms: ${p95Pass ? '✅' : '❌'} (${p95.toFixed(2)}ms)\n`;
    summary += `${indent}  - p99 < 300ms: ${p99Pass ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 0.1%: ${errorPass ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - Rotation 成功率 > 99%: ${rotationPass ? '✅' : '❌'} (${rotationRate.toFixed(2)}%)\n`;
    summary += `${indent}  - D1 エラー = 0: ${d1Pass ? '✅' : '❌'} (${d1Errors})\n`;
  } else if (PRESET === 'rps200') {
    const p95Pass = p95 < 250;
    const p99Pass = p99 < 400;
    const errorPass = errorRate < 0.1;
    const rotationPass = rotationRate > 99;
    const d1Pass = d1Errors < 2;
    const pass = p95Pass && p99Pass && errorPass && rotationPass && d1Pass;

    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - p95 < 250ms: ${p95Pass ? '✅' : '❌'} (${p95.toFixed(2)}ms)\n`;
    summary += `${indent}  - p99 < 400ms: ${p99Pass ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 0.1%: ${errorPass ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - Rotation 成功率 > 99%: ${rotationPass ? '✅' : '❌'} (${rotationRate.toFixed(2)}%)\n`;
    summary += `${indent}  - D1 エラー < 2: ${d1Pass ? '✅' : '❌'} (${d1Errors})\n`;
  } else if (PRESET === 'rps300') {
    const p95Pass = p95 < 300;
    const p99Pass = p99 < 500;
    const errorPass = errorRate < 0.5;
    const rotationPass = rotationRate > 98;
    const d1Pass = d1Errors < 5;
    const pass = p95Pass && p99Pass && errorPass && rotationPass && d1Pass;

    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - p95 < 300ms: ${p95Pass ? '✅' : '❌'} (${p95.toFixed(2)}ms)\n`;
    summary += `${indent}  - p99 < 500ms: ${p99Pass ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 0.5%: ${errorPass ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - Rotation 成功率 > 98%: ${rotationPass ? '✅' : '❌'} (${rotationRate.toFixed(2)}%)\n`;
    summary += `${indent}  - D1 エラー < 5: ${d1Pass ? '✅' : '❌'} (${d1Errors})\n`;
  }

  summary += `${indent}\n${'='.repeat(70)}\n`;

  return summary;
}
