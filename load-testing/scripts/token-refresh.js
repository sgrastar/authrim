/**
 * /token (refresh_token) 負荷テスト
 *
 * 本番運用に近い設計:
 * - Token Rotation を有効化
 * - VU ごとに独立した token family を持つ
 * - すべて正常な rotation path のみ（エラーケースなし）
 * - Family depth = 1 で常に rotation
 *
 * 使い方:
 * k6 run --env PRESET=rps100 scripts/token-refresh.js
 * k6 run --env PRESET=rps300 scripts/token-refresh.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';

// テスト識別情報
const TEST_NAME = '/token (refresh_token)';
const TEST_ID = 'token-refresh';

// カスタムメトリクス
const tokenRequestDuration = new Trend('token_request_duration');
const tokenRequestSuccess = new Rate('token_request_success');
const tokenRotationSuccess = new Rate('token_rotation_success');
const authErrors = new Counter('auth_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');
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
      { target: 50, duration: '30s' },
      { target: 100, duration: '30s' },
      { target: 100, duration: '120s' },
      { target: 50, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<300'],
      token_rotation_success: ['rate>0.99'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 100,
    maxVUs: 120,
    thinkTime: 0,
  },
  rps200: {
    description: '200 RPS sustained load - High traffic scenario',
    stages: [
      { target: 100, duration: '30s' },
      { target: 200, duration: '30s' },
      { target: 200, duration: '120s' },
      { target: 100, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<400'],
      token_rotation_success: ['rate>0.99'],
      d1_write_errors: ['count<2'],
    },
    preAllocatedVUs: 200,
    maxVUs: 240,
    thinkTime: 0,
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
      token_rotation_success: ['rate>0.999'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 300,
    maxVUs: 360,
    thinkTime: 0,
  },
  // 高VUベンチマーク: 2分間 300 RPS テスト（VU 3倍でキューイング回避）
  rps300_highvu: {
    description: '300 RPS with 3x VUs - Reduced queueing latency',
    stages: [
      { target: 300, duration: '10s' },
      { target: 300, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<500'],
      token_rotation_success: ['rate>0.999'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 900,
    maxVUs: 1080,
    thinkTime: 0,
  },
  // VU500ベンチマーク: 2分間 300 RPS テスト（Ethernet環境向け）
  rps300_vu500: {
    description: '300 RPS with 500 VUs - Ethernet optimized',
    stages: [
      { target: 300, duration: '10s' },
      { target: 300, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<500'],
      token_rotation_success: ['rate>0.999'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 500,
    maxVUs: 600,
    thinkTime: 0,
  },
};

// 選択されたプリセット
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Invalid PRESET "${PRESET}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
}

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
      `Refresh token seed not found or invalid at "${REFRESH_TOKEN_PATH}". Run scripts/generate-seeds.js to create it. (${err.message})`
    );
  }
});
if (!refreshTokens.length) {
  throw new Error(`No refresh tokens available for ${TEST_ID}. Aborting.`);
}
if (refreshTokens.length < selectedPreset.maxVUs) {
  throw new Error(
    `Not enough refresh tokens for preset "${PRESET}". Required at least ${selectedPreset.maxVUs} (max VUs), found ${refreshTokens.length}. Increase REFRESH_COUNT or lower maxVUs.`
  );
}

// テストオプション
export const options = {
  // K6 Cloud 設定
  cloud: {
    projectID: 5942435,
    name: `Authrim - Token Refresh (${PRESET})`,
    distribution: {
      'amazon:jp:tokyo': { loadZone: 'amazon:jp:tokyo', percent: 100 },
    },
  },
  scenarios: {
    token_refresh: {
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

// VU ごとの独立した token family（VU初期化時に設定）
let vuTokenFamily = null;
let familyDepth = 0;
let hasLoggedServerError = false;

// セットアップ
export function setup() {
  console.log(`🚀 ${TEST_NAME} 負荷テスト`);
  console.log(`📊 プリセット: ${PRESET}`);
  console.log(`📝 説明: ${selectedPreset.description}`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);
  console.log(`📦 Refresh Token プール: ${refreshTokens.length}`);
  console.log(``);
  console.log(`✨ 本番運用に近い設計:`);
  console.log(`   - Token Rotation 有効化`);
  console.log(`   - VU ごとに独立した token family`);
  console.log(`   - すべて正常な rotation path（エラーケースなし）`);
  console.log(
    `   - Token pool: ${refreshTokens.length} (requires >= ${selectedPreset.maxVUs} for 1 token/VU)`
  );

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
    const vuId = __VU;
    const tokenIndex = vuId - 1;
    if (tokenIndex >= refreshTokens.length) {
      throw new Error(
        `No refresh token available for VU ${vuId}. Token pool=${refreshTokens.length}, required=${selectedPreset.maxVUs}`
      );
    }
    vuTokenFamily = {
      ...refreshTokens[tokenIndex],
      vuId: vuId,
    };
    familyDepth = 0;
    hasLoggedServerError = false;
  }

  // Basic 認証ヘッダーの生成
  const credentials = `${vuTokenFamily.client_id}:${vuTokenFamily.client_secret}`;
  const basicAuth = `Basic ${encoding.b64encode(credentials)}`;

  // /token リクエストのパラメータ
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Connection: 'keep-alive',
      Authorization: basicAuth,
    },
    tags: {
      name: 'TokenRefreshRequest',
      preset: PRESET,
      vuId: vuTokenFamily.vuId,
    },
  };

  const payload = `grant_type=refresh_token&refresh_token=${vuTokenFamily.token}`;

  // リクエスト送信
  const response = http.post(`${BASE_URL}/token`, payload, params);
  const duration = response.timings.duration;

  // メトリクス記録
  tokenRequestDuration.add(duration);

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
      if (responseBody.refresh_token) {
        return responseBody.refresh_token !== vuTokenFamily.token;
      }
      return false;
    },
  });

  tokenRequestSuccess.add(success);

  // Token Rotation の成功チェック
  if (success && responseBody.refresh_token && responseBody.refresh_token !== vuTokenFamily.token) {
    tokenRotationSuccess.add(1);

    // Token family を更新（次回は新しいトークンを使用）
    vuTokenFamily.token = responseBody.refresh_token;
    familyDepth++;
    familyDepthMetric.add(familyDepth);
  } else {
    tokenRotationSuccess.add(0);

    // Rotation 失敗時のデバッグ情報（rps100 のみ）
    if (!success && PRESET === 'rps100') {
      console.error(`❌ Token rotation failed for VU ${vuTokenFamily.vuId}:`);
      console.error(`   Status: ${response.status}`);
      console.error(`   Response: ${response.body}`);
    }
  }

  // エラーハンドリング
  if (response.status === 401 || response.status === 403) {
    authErrors.add(1);
  }
  if (response.status === 429) {
    rateLimitErrors.add(1);
  }
  if (response.status >= 500) {
    serverErrors.add(1);
    if (!hasLoggedServerError) {
      console.error(
        `❌ 5xx from /token (VU ${vuTokenFamily.vuId}): status=${response.status}, body=${response.body}`
      );
      hasLoggedServerError = true;
    }

    // D1 書き込みエラーの可能性
    if (
      response.status === 500 &&
      (response.body.includes('D1') || response.body.includes('database'))
    ) {
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
  summary += `${indent}  認証エラー (401/403): ${metrics.auth_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate Limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  サーバーエラー (5xx): ${metrics.server_errors?.values?.count || 0}\n`;
  summary += `${indent}  D1 書き込みエラー: ${metrics.d1_write_errors?.values?.count || 0}\n\n`;

  // 判定
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const errorRate = (metrics.http_req_failed?.values?.rate || 0) * 100;
  const rotationRate = (metrics.token_rotation_success?.values?.rate || 0) * 100;
  const d1Errors = metrics.d1_write_errors?.values?.count || 0;

  summary += `${indent}✅ 判定:\n`;

  // プリセットごとの閾値で判定
  let p95Threshold, p99Threshold, errorThreshold, rotationThreshold, d1Threshold;
  if (PRESET === 'rps100') {
    p95Threshold = 200;
    p99Threshold = 300;
    errorThreshold = 0.1;
    rotationThreshold = 99;
    d1Threshold = 0;
  } else if (PRESET === 'rps200') {
    p95Threshold = 250;
    p99Threshold = 400;
    errorThreshold = 0.1;
    rotationThreshold = 99;
    d1Threshold = 2;
  } else if (PRESET === 'rps300' || PRESET === 'rps300_highvu' || PRESET === 'rps300_vu500') {
    p95Threshold = 300;
    p99Threshold = 500;
    errorThreshold = 0.1;
    rotationThreshold = 99.9;
    d1Threshold = 1;
  } else {
    p95Threshold = 300;
    p99Threshold = 500;
    errorThreshold = 0.5;
    rotationThreshold = 98;
    d1Threshold = 5;
  }

  const p95Pass = p95 < p95Threshold;
  const p99Pass = p99 < p99Threshold;
  const errorPass = errorRate < errorThreshold;
  const rotationPass = rotationRate > rotationThreshold;
  const d1Pass = d1Errors <= d1Threshold;
  const pass = p95Pass && p99Pass && errorPass && rotationPass && d1Pass;

  summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
  summary += `${indent}  - p95 < ${p95Threshold}ms: ${p95Pass ? '✅' : '❌'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  - p99 < ${p99Threshold}ms: ${p99Pass ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  - エラーレート < ${errorThreshold}%: ${errorPass ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
  summary += `${indent}  - Rotation 成功率 > ${rotationThreshold}%: ${rotationPass ? '✅' : '❌'} (${rotationRate.toFixed(2)}%)\n`;
  summary += `${indent}  - D1 エラー <= ${d1Threshold}: ${d1Pass ? '✅' : '❌'} (${d1Errors})\n`;

  summary += `${indent}\n${'='.repeat(70)}\n`;

  return summary;
}
