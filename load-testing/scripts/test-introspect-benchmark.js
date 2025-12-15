/**
 * Token Introspection Control Plane Test
 *
 * RFC 7662 Token Introspection エンドポイントのベンチマークテスト
 *
 * ┌───────────────────────────────────────────────────────────────────────────────┐
 * │ テスト設計 (RFC 7662 + 業界標準準拠)                                          │
 * ├────────────────────┬───────┬─────────────┬─────────────────────────────────────┤
 * │ 種別               │ 比率  │ 期待active  │ 検証項目                            │
 * ├────────────────────┼───────┼─────────────┼─────────────────────────────────────┤
 * │ Active (標準)      │ 60%   │ true        │ scope/sub整合性                     │
 * │ Active (TE)        │ 5%    │ true        │ act/resource claim (RFC 8693)       │
 * │ Expired            │ 12%   │ false       │ 即時反映                            │
 * │ Revoked            │ 12%   │ false       │ 即時反映                            │
 * │ Wrong audience     │ 6%    │ false       │ aud検証 (strictValidation=true時)   │
 * │ Wrong client       │ 5%    │ false       │ client_id検証 (strictValidation時)  │
 * └────────────────────┴───────┴─────────────┴─────────────────────────────────────┘
 *
 * 成功基準 (RFC 7662 + Keycloak/Auth0 benchmark):
 * - 成功率: > 99%
 * - p95: < 300ms, p99: < 400ms
 * - False Positive/Negative: 0
 * - Token Exchange act claim整合性: 100%
 *
 * 注意: テスト実行前に strictValidation=true を設定する必要あり
 *   curl -X PUT https://conformance.authrim.com/api/admin/settings/introspection-validation \
 *     -H "Authorization: Bearer $ADMIN_API_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"strictValidation": true}'
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
const TEST_NAME = 'Token Introspection Control Plane Test';
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

// 新しいカテゴリ用メトリクス
const exchangedTokenCorrect = new Rate('exchanged_token_correct'); // Token Exchangeトークンのactive=true検証
const wrongAudienceRejected = new Rate('wrong_audience_rejected'); // Wrong audienceの正しい拒否
const wrongClientRejected = new Rate('wrong_client_rejected'); // Wrong clientの正しい拒否

// 評価軸3: scope/aud/sub/iss の整合性検証
const claimIntegrity = new Rate('claim_integrity'); // 基本クレームの整合性
// 評価軸5: Token Exchange act/resource claim 検証
const actClaimPresent = new Rate('act_claim_present'); // act claim存在確認
const resourceClaimPresent = new Rate('resource_claim_present'); // resource claim存在確認

// 環境変数
// Note: Replace default values with actual credentials when running tests
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID; // Required: OAuth client ID
const CLIENT_SECRET = __ENV.CLIENT_SECRET; // Required: OAuth client secret
const PRESET = __ENV.PRESET || 'rps300';

// Validate required credentials
if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    'CLIENT_ID and CLIENT_SECRET are required. Set them via environment variables:\n' +
      '  k6 run --env CLIENT_ID=your_client_id --env CLIENT_SECRET=your_secret scripts/test-introspect-benchmark.js'
  );
}
const TOKEN_PATH = __ENV.TOKEN_PATH || '../seeds/access_tokens.json';
// K6 Cloud用: R2からシードをフェッチするURL
const TOKEN_URL = __ENV.TOKEN_URL || '';

/**
 * トークン種別の比率 (RFC 7662 + 業界標準ベンチマーク準拠)
 *
 * シード生成スクリプトと一致させる
 */
const TOKEN_MIX = {
  valid: 0.6, // 60% - 通常のアクセストークン
  valid_exchanged: 0.05, // 5%  - Token Exchange (act claim付き)
  expired: 0.12, // 12% - 期限切れ
  revoked: 0.12, // 12% - 無効化済み
  wrong_audience: 0.06, // 6%  - 署名OK, aud不一致
  wrong_client: 0.05, // 5%  - 別client_idで発行
};

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
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      // 評価軸3: scope/aud/sub/iss 整合性
      claim_integrity: ['rate>0.99'],
      // 評価軸5: Token Exchange act/resource claim
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
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
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      claim_integrity: ['rate>0.99'],
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
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
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      claim_integrity: ['rate>0.99'],
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
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
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      claim_integrity: ['rate>0.99'],
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
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
    const validExchangedTokens = allTokens.filter((t) => t.type === 'valid_exchanged');
    const expiredTokens = allTokens.filter((t) => t.type === 'expired');
    const revokedTokens = allTokens.filter((t) => t.type === 'revoked');
    const wrongAudienceTokens = allTokens.filter((t) => t.type === 'wrong_audience');
    const wrongClientTokens = allTokens.filter((t) => t.type === 'wrong_client');

    console.log(`📂 Loaded tokens from local file:`);
    console.log(`   Valid:           ${validTokens.length}`);
    console.log(`   Valid (TE/act):  ${validExchangedTokens.length}`);
    console.log(`   Expired:         ${expiredTokens.length}`);
    console.log(`   Revoked:         ${revokedTokens.length}`);
    console.log(`   Wrong audience:  ${wrongAudienceTokens.length}`);
    console.log(`   Wrong client:    ${wrongClientTokens.length}`);
  } catch (e) {
    console.warn(`⚠️  Failed to load local tokens: ${e.message}`);
    console.warn('   Make sure to run: node scripts/seed-access-tokens.js first');
  }
} else {
  useRemoteData = true;
  console.log('☁️  K6 Cloud mode: Will fetch tokens from URL');
}

/**
 * 期待されるactive値を取得
 * valid, valid_exchanged → true
 * それ以外 → false
 */
function getExpectedActive(tokenType) {
  return tokenType === 'valid' || tokenType === 'valid_exchanged';
}

/**
 * 重み付けでトークンタイプを選択
 */
function selectTokenType() {
  const rand = Math.random();
  let cumulative = 0;

  cumulative += TOKEN_MIX.valid;
  if (rand < cumulative) return 'valid';

  cumulative += TOKEN_MIX.valid_exchanged;
  if (rand < cumulative) return 'valid_exchanged';

  cumulative += TOKEN_MIX.expired;
  if (rand < cumulative) return 'expired';

  cumulative += TOKEN_MIX.revoked;
  if (rand < cumulative) return 'revoked';

  cumulative += TOKEN_MIX.wrong_audience;
  if (rand < cumulative) return 'wrong_audience';

  return 'wrong_client';
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
    valid_exchanged: tokens.filter((t) => t.type === 'valid_exchanged').length,
    expired: tokens.filter((t) => t.type === 'expired').length,
    revoked: tokens.filter((t) => t.type === 'revoked').length,
    wrong_audience: tokens.filter((t) => t.type === 'wrong_audience').length,
    wrong_client: tokens.filter((t) => t.type === 'wrong_client').length,
  };
  console.log(`📊 Token distribution:`);
  console.log(
    `   Valid:           ${counts.valid} (${((counts.valid / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Valid (TE/act):  ${counts.valid_exchanged} (${((counts.valid_exchanged / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Expired:         ${counts.expired} (${((counts.expired / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Revoked:         ${counts.revoked} (${((counts.revoked / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Wrong audience:  ${counts.wrong_audience} (${((counts.wrong_audience / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Wrong client:    ${counts.wrong_client} (${((counts.wrong_client / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(``);

  // ウォームアップ: 最初の数リクエストでDOを初期化
  console.log(`🔥 Warming up...`);
  const validToken = tokens.find((t) => t.type === 'valid');
  if (validToken) {
    for (let i = 0; i < 5; i++) {
      http.post(`${BASE_URL}/introspect`, `token=${encodeURIComponent(validToken.access_token)}`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: getBasicAuthHeader(),
        },
        tags: { name: 'Warmup' },
      });
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
  const expectedActive = getExpectedActive(tokenData.type);

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

    // カテゴリ別メトリクス
    if (tokenData.type === 'valid_exchanged') {
      exchangedTokenCorrect.add(responseBody.active === true ? 1 : 0);

      // 評価軸5: Token Exchange act/resource claim 検証 (RFC 8693)
      if (responseBody.active === true) {
        // act claim の存在確認
        const hasActClaim =
          responseBody.act !== undefined &&
          responseBody.act !== null &&
          typeof responseBody.act === 'object' &&
          responseBody.act.sub !== undefined;
        actClaimPresent.add(hasActClaim ? 1 : 0);

        // resource claim の存在確認
        const hasResourceClaim =
          responseBody.resource !== undefined &&
          typeof responseBody.resource === 'string' &&
          responseBody.resource.length > 0;
        resourceClaimPresent.add(hasResourceClaim ? 1 : 0);

        if (!hasActClaim || !hasResourceClaim) {
          console.warn(
            `⚠️  Token Exchange claim missing: act=${hasActClaim}, resource=${hasResourceClaim} (VU ${__VU})`
          );
        }
      }
    }
    if (tokenData.type === 'wrong_audience') {
      wrongAudienceRejected.add(responseBody.active === false ? 1 : 0);
    }
    if (tokenData.type === 'wrong_client') {
      wrongClientRejected.add(responseBody.active === false ? 1 : 0);
    }

    // 評価軸3: scope/aud/sub/iss の整合性検証 (active=true の場合のみ)
    if (responseBody.active === true) {
      const hasScope = responseBody.scope !== undefined && responseBody.scope !== null;
      const hasAud = responseBody.aud !== undefined && responseBody.aud !== null;
      const hasSub = responseBody.sub !== undefined && responseBody.sub !== null;
      const hasIss = responseBody.iss !== undefined && responseBody.iss !== null;
      const hasClientId = responseBody.client_id !== undefined && responseBody.client_id !== null;

      const allClaimsPresent = hasScope && hasAud && hasSub && hasIss && hasClientId;
      claimIntegrity.add(allClaimsPresent ? 1 : 0);

      if (!allClaimsPresent) {
        console.warn(
          `⚠️  Claim integrity issue: scope=${hasScope}, aud=${hasAud}, sub=${hasSub}, iss=${hasIss}, client_id=${hasClientId} (VU ${__VU})`
        );
      }
    }

    if (!isCorrect) {
      if (responseBody.active === true && !expectedActive) {
        // False positive: active=true for expired/invalid/revoked/wrong_audience/wrong_client
        falsePositives.add(1);
        console.error(
          `⚠️  False Positive: Token type '${tokenData.type}' returned active=true (VU ${__VU})`
        );
      } else if (responseBody.active === false && expectedActive) {
        // False negative: active=false for valid/valid_exchanged
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

  // カテゴリ別精度
  const exchangedRate = ((metrics.exchanged_token_correct?.values?.rate || 0) * 100).toFixed(2);
  const wrongAudRate = ((metrics.wrong_audience_rejected?.values?.rate || 0) * 100).toFixed(2);
  const wrongClientRate = ((metrics.wrong_client_rejected?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}📋 カテゴリ別精度:\n`;
  summary += `${indent}  Token Exchange (act) 正解: ${exchangedRate}%\n`;
  summary += `${indent}  Wrong audience 拒否: ${wrongAudRate}%\n`;
  summary += `${indent}  Wrong client 拒否: ${wrongClientRate}%\n\n`;

  // 評価軸3: scope/aud/sub/iss 整合性
  const claimIntegrityRate = ((metrics.claim_integrity?.values?.rate || 0) * 100).toFixed(2);
  summary += `${indent}🔍 評価軸3 - クレーム整合性 (scope/aud/sub/iss):\n`;
  summary += `${indent}  整合性率: ${claimIntegrityRate}%\n\n`;

  // 評価軸5: Token Exchange act/resource claim
  const actClaimRate = ((metrics.act_claim_present?.values?.rate || 0) * 100).toFixed(2);
  const resourceClaimRate = ((metrics.resource_claim_present?.values?.rate || 0) * 100).toFixed(2);
  summary += `${indent}🔄 評価軸5 - Token Exchange claim (RFC 8693):\n`;
  summary += `${indent}  act claim 存在率: ${actClaimRate}%\n`;
  summary += `${indent}  resource claim 存在率: ${resourceClaimRate}%\n\n`;

  // 仕様書準拠チェック
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.introspect_success?.values?.rate || 0;

  const claimIntegrityRateNum = metrics.claim_integrity?.values?.rate || 0;
  const actClaimRateNum = metrics.act_claim_present?.values?.rate || 0;
  const resourceClaimRateNum = metrics.resource_claim_present?.values?.rate || 0;

  summary += `${indent}📋 仕様書準拠チェック (RFC 7662 + Keycloak/Auth0):\n`;
  summary += `${indent}  成功率 > 99%: ${rate > 0.99 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 300ms: ${p95 < 300 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 400ms: ${p99 < 400 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  False Positive = 0: ${fp === 0 ? '✅ PASS' : '❌ FAIL'} (${fp})\n`;
  summary += `${indent}  False Negative = 0: ${fn === 0 ? '✅ PASS' : '❌ FAIL'} (${fn})\n`;
  summary += `${indent}  クレーム整合性 > 99%: ${claimIntegrityRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${claimIntegrityRate}%)\n`;
  summary += `${indent}  Token Exchange act > 99%: ${actClaimRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${actClaimRate}%)\n`;
  summary += `${indent}  Token Exchange resource > 99%: ${resourceClaimRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${resourceClaimRate}%)\n\n`;

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
