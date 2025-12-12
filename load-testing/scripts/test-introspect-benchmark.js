/**
 * Token Introspection Endpoint ベンチマークテスト
 *
 * 目的:
 * - Token Introspection API (/introspect) の最大スループットを測定
 * - Valid/Expired/Invalid/Revoked トークンの混在環境でのパフォーマンス評価
 * - false positive/negative の検出
 * - Auth0/Keycloak/Ory との比較指標
 *
 * テスト仕様:
 * - ターゲット: POST /introspect
 * - 認証: HTTP Basic (client_id:client_secret)
 * - トークンミックス: Valid 70%, Expired 10%, Invalid 10%, Revoked 10%
 * - 成功判定: active フラグが期待値と一致
 *
 * 使い方:
 * k6 run --env PRESET=rps300 scripts/test-introspect-benchmark.js
 * k6 run --env PRESET=rps600 scripts/test-introspect-benchmark.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

// テスト識別情報
const TEST_NAME = 'Token Introspection Benchmark';
const TEST_ID = 'introspect-benchmark';

// カスタムメトリクス
const introspectDuration = new Trend('introspect_duration');
const introspectSuccess = new Rate('introspect_success');
const activeCorrect = new Rate('active_correct'); // active フラグが期待値と一致
const falsePositives = new Counter('false_positives'); // active=true for invalid/expired/revoked
const falseNegatives = new Counter('false_negatives'); // active=false for valid
const clientAuthErrors = new Counter('client_auth_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const PRESET = __ENV.PRESET || 'rps300';
const TOKEN_PATH = __ENV.TOKEN_PATH || '../seeds/access_tokens.json';
// K6 Cloud用: R2からシードをフェッチするURL
const TOKEN_URL = __ENV.TOKEN_URL || '';

/**
 * プリセット設定
 *
 * 仕様書準拠:
 * - RPS: 300, 600, 800, 1000
 * - Duration: 120秒
 * - 成功率: > 99%
 * - p95: < 300ms, p99: < 400ms
 * - false positive/negative: 0%
 */
const PRESETS = {
  // 軽量テスト（開発・確認用）
  rps100: {
    description: '100 RPS - Quick smoke test (30s)',
    stages: [
      { target: 50, duration: '10s' },
      { target: 100, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<600'],
      http_req_failed: ['rate<0.02'],
      introspect_success: ['rate>0.98'],
      active_correct: ['rate>0.99'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
    },
    preAllocatedVUs: 120,
    maxVUs: 150,
  },

  // ベンチマーク: 300 RPS (3分)
  rps300: {
    description: '300 RPS - Introspection benchmark (3 min)',
    stages: [
      { target: 150, duration: '15s' },
      { target: 300, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
    },
    preAllocatedVUs: 400,
    maxVUs: 500,
  },

  // ベンチマーク: 600 RPS (3分)
  rps600: {
    description: '600 RPS - Introspection high throughput (3 min)',
    stages: [
      { target: 300, duration: '15s' },
      { target: 600, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
    },
    preAllocatedVUs: 700,
    maxVUs: 900,
  },

  // ベンチマーク: 800 RPS (3分)
  rps800: {
    description: '800 RPS - Introspection stress test (3 min)',
    stages: [
      { target: 400, duration: '15s' },
      { target: 800, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
    },
    preAllocatedVUs: 950,
    maxVUs: 1200,
  },

  // ベンチマーク: 1000 RPS (3分)
  rps1000: {
    description: '1000 RPS - Introspection maximum capacity (3 min)',
    stages: [
      { target: 500, duration: '15s' },
      { target: 1000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
    },
    preAllocatedVUs: 1200,
    maxVUs: 1500,
  },
};

// プリセット検証
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Unknown preset: ${PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`);
}

// K6オプション
export const options = {
  scenarios: {
    introspect_benchmark: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
    },
  },
  thresholds: selectedPreset.thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
};

// Basic認証ヘッダー生成
function getBasicAuthHeader() {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${encoding.b64encode(credentials)}`;
}

// ローカルモード: SharedArrayでトークンを読み込み
let allTokens = null;
let useRemoteData = false;

if (!TOKEN_URL) {
  try {
    allTokens = new SharedArray('all_tokens', function () {
      const raw = open(TOKEN_PATH);
      const data = JSON.parse(raw);
      return data.tokens;
    });

    // トークンをタイプ別に分類
    const validTokens = allTokens.filter((t) => t.type === 'valid');
    const expiredTokens = allTokens.filter((t) => t.type === 'expired');
    const invalidTokens = allTokens.filter((t) => t.type === 'invalid');
    const revokedTokens = allTokens.filter((t) => t.type === 'revoked');

    console.log(`📂 Loaded tokens from local file:`);
    console.log(`   Valid:   ${validTokens.length}`);
    console.log(`   Expired: ${expiredTokens.length}`);
    console.log(`   Invalid: ${invalidTokens.length}`);
    console.log(`   Revoked: ${revokedTokens.length}`);
  } catch (e) {
    console.warn(`⚠️  Failed to load local tokens: ${e.message}`);
    console.warn('   Make sure to run: node scripts/seed-access-tokens.js first');
  }
} else {
  useRemoteData = true;
  console.log('☁️  K6 Cloud mode: Will fetch tokens from URL');
}

/**
 * 重み付けでトークンタイプを選択
 * Valid: 70%, Expired: 10%, Invalid: 10%, Revoked: 10%
 */
function selectTokenType() {
  const rand = Math.random() * 100;
  if (rand < 70) return 'valid';
  if (rand < 80) return 'expired';
  if (rand < 90) return 'invalid';
  return 'revoked';
}

/**
 * タイプ別にトークンを取得
 */
function selectTokenByType(tokens, type, vuId) {
  const filtered = tokens.filter((t) => t.type === type);
  if (filtered.length === 0) {
    // フォールバック: 全トークンから選択
    return tokens[vuId % tokens.length];
  }
  return filtered[vuId % filtered.length];
}

// セットアップ（テスト開始前に1回だけ実行）
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔐 Client: ${CLIENT_ID}`);
  console.log(``);

  let tokens = [];

  // K6 Cloud: リモートからトークンを取得
  if (TOKEN_URL) {
    console.log(`☁️  Fetching tokens from: ${TOKEN_URL}`);
    const response = http.get(TOKEN_URL, { timeout: '120s' });
    if (response.status !== 200) {
      throw new Error(`Failed to fetch tokens: ${response.status}`);
    }
    const data = JSON.parse(response.body);
    tokens = data.tokens;
    console.log(`   Loaded ${tokens.length} tokens from remote`);
  } else if (allTokens) {
    tokens = allTokens;
  }

  if (tokens.length === 0) {
    throw new Error(
      'No tokens available. Run: node scripts/seed-access-tokens.js to generate tokens'
    );
  }

  // トークン分布の確認
  const counts = {
    valid: tokens.filter((t) => t.type === 'valid').length,
    expired: tokens.filter((t) => t.type === 'expired').length,
    invalid: tokens.filter((t) => t.type === 'invalid').length,
    revoked: tokens.filter((t) => t.type === 'revoked').length,
  };
  console.log(`📊 Token distribution:`);
  console.log(`   Valid:   ${counts.valid} (${((counts.valid / tokens.length) * 100).toFixed(1)}%)`);
  console.log(
    `   Expired: ${counts.expired} (${((counts.expired / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Invalid: ${counts.invalid} (${((counts.invalid / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Revoked: ${counts.revoked} (${((counts.revoked / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(``);

  // ウォームアップ: 最初の数リクエストでDOを初期化
  console.log(`🔥 Warming up...`);
  const validToken = tokens.find((t) => t.type === 'valid');
  if (validToken) {
    for (let i = 0; i < 5; i++) {
      http.post(
        `${BASE_URL}/introspect`,
        `token=${encodeURIComponent(validToken.access_token)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: getBasicAuthHeader(),
          },
          tags: { name: 'Warmup' },
        }
      );
    }
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    tokens: useRemoteData ? tokens : null,
    tokenCount: tokens.length,
    counts,
    preset: PRESET,
    baseUrl: BASE_URL,
  };
}

// メインテスト関数（各VUで繰り返し実行）
export default function (data) {
  const tokens = useRemoteData ? data.tokens : allTokens;

  // 重み付けでトークンタイプを選択
  const tokenType = selectTokenType();
  const tokenData = selectTokenByType(tokens, tokenType, __VU);

  // 期待される active フラグ
  const expectedActive = tokenData.type === 'valid';

  // /introspect リクエスト
  const payload = `token=${encodeURIComponent(tokenData.access_token)}`;

  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: getBasicAuthHeader(),
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
    tags: {
      name: 'IntrospectRequest',
      preset: PRESET,
      tokenType: tokenData.type,
    },
  };

  const response = http.post(`${BASE_URL}/introspect`, payload, params);
  const duration = response.timings.duration;

  // メトリクス記録
  introspectDuration.add(duration);

  // レスポンス検証
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (_) {
    // ignore parse errors
  }

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has active field': () => responseBody.active !== undefined,
    'response time < 1000ms': (r) => r.timings.duration < 1000,
  });

  introspectSuccess.add(success);

  // active フラグの正確性検証
  if (response.status === 200 && responseBody.active !== undefined) {
    const isCorrect = responseBody.active === expectedActive;
    activeCorrect.add(isCorrect ? 1 : 0);

    if (!isCorrect) {
      if (responseBody.active === true && !expectedActive) {
        // False positive: active=true for expired/invalid/revoked
        falsePositives.add(1);
        console.error(
          `⚠️  False Positive: Token type '${tokenData.type}' returned active=true (VU ${__VU})`
        );
      } else if (responseBody.active === false && expectedActive) {
        // False negative: active=false for valid
        falseNegatives.add(1);
        console.error(
          `⚠️  False Negative: Token type '${tokenData.type}' returned active=false (VU ${__VU})`
        );
      }
    }
  } else {
    activeCorrect.add(0);
  }

  // エラー分類
  if (response.status === 401) {
    clientAuthErrors.add(1);
  }
  if (response.status === 429) {
    rateLimitErrors.add(1);
  }
  if (response.status >= 500) {
    serverErrors.add(1);
  }

  // デバッグ（失敗時のみ）
  if (!success && exec.vu.iterationInInstance < 3) {
    console.error(`❌ Check failed (VU ${__VU}, iter ${exec.vu.iterationInInstance}):`);
    console.error(`   status: ${response.status} (expected 200)`);
    console.error(`   tokenType: ${tokenData.type}`);
    console.error(`   active: ${responseBody.active} (expected ${expectedActive})`);
    if (response.status !== 200) {
      console.error(`   body: ${response.body.substring(0, 200)}`);
    }
  }
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
  const successRate = ((metrics.introspect_success?.values?.rate || 0) * 100).toFixed(2);

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

  // Active フラグの精度
  const activeCorrectRate = ((metrics.active_correct?.values?.rate || 0) * 100).toFixed(3);
  const fp = metrics.false_positives?.values?.count || 0;
  const fn = metrics.false_negatives?.values?.count || 0;

  summary += `${indent}🎯 Active フラグ精度:\n`;
  summary += `${indent}  正解率: ${activeCorrectRate}%\n`;
  summary += `${indent}  False Positives: ${fp}\n`;
  summary += `${indent}  False Negatives: ${fn}\n\n`;

  // 仕様書準拠チェック
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.introspect_success?.values?.rate || 0;

  summary += `${indent}📋 仕様書準拠チェック:\n`;
  summary += `${indent}  成功率 > 99%: ${rate > 0.99 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 300ms: ${p95 < 300 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 400ms: ${p99 < 400 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  False Positive = 0: ${fp === 0 ? '✅ PASS' : '❌ FAIL'} (${fp})\n`;
  summary += `${indent}  False Negative = 0: ${fn === 0 ? '✅ PASS' : '❌ FAIL'} (${fn})\n\n`;

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  クライアント認証エラー (401): ${metrics.client_auth_errors?.values?.count || 0}\n`;
  summary += `${indent}  レート制限 (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  サーバーエラー (5xx): ${metrics.server_errors?.values?.count || 0}\n\n`;

  // スループット
  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 スループット: ${rps.toFixed(2)} req/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
