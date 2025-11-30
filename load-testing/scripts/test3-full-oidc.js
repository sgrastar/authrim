/**
 * TEST 3: フル OIDC 認証フロー
 *
 * 目的:
 * - 実サービス最も近いワークロードを再現
 * - PKCE / DO / D1 の全パスを通過
 * - エンドツーエンドのパフォーマンス測定
 *
 * 使い方:
 * k6 run --env PRESET=light scripts/test3-full-oidc.js
 * k6 run --env PRESET=standard scripts/test3-full-oidc.js
 * k6 run --env PRESET=heavy scripts/test3-full-oidc.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { sha256 } from 'k6/crypto';
import encoding from 'k6/encoding';
import { randomString, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// カスタムメトリクス
const authorizeRequestDuration = new Trend('authorize_request_duration');
const tokenRequestDuration = new Trend('token_request_duration');
const fullFlowDuration = new Trend('full_flow_duration');
const flowCompletionRate = new Rate('flow_completion_rate');
const authorizeSuccess = new Rate('authorize_success');
const tokenSuccess = new Rate('token_success');
const pkceValidationErrors = new Counter('pkce_validation_errors');
const codeExchangeErrors = new Counter('code_exchange_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://example.com/callback';
const PRESET = __ENV.PRESET || 'light';
const SESSION_COOKIE = __ENV.SESSION_COOKIE || '';

// プリセット設定
const PRESETS = {
  light: {
    startRate: 10,
    stages: [
      { target: 10, duration: '20s' },   // Ramp up to 10 RPS
      { target: 20, duration: '40s' },   // Ramp up to 20 RPS
      { target: 20, duration: '40s' },   // Stay at 20 RPS
      { target: 10, duration: '20s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<300'],
      http_req_failed: ['rate<0.005'],
      full_flow_duration: ['p(99)<300'],
      flow_completion_rate: ['rate>0.99'],
    },
    preAllocatedVUs: 20,
    maxVUs: 30,
    thinkTime: { min: 0.5, max: 2.0 }, // 500ms-2s
  },
  standard: {
    startRate: 30,
    stages: [
      { target: 30, duration: '30s' },   // Ramp up to 30 RPS
      { target: 50, duration: '60s' },   // Ramp up to 50 RPS
      { target: 50, duration: '60s' },   // Stay at 50 RPS
      { target: 30, duration: '30s' },   // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<500'],
      http_req_failed: ['rate<0.01'],
      full_flow_duration: ['p(99)<500'],
      flow_completion_rate: ['rate>0.98'],
    },
    preAllocatedVUs: 50,
    maxVUs: 75,
    thinkTime: { min: 0.2, max: 1.0 }, // 200ms-1s
  },
  heavy: {
    startRate: 80,
    stages: [
      { target: 80, duration: '30s' },    // Ramp up to 80 RPS
      { target: 100, duration: '60s' },   // Ramp up to 100 RPS
      { target: 100, duration: '60s' },   // Stay at 100 RPS
      { target: 80, duration: '30s' },    // Ramp down
    ],
    thresholds: {
      http_req_duration: ['p(99)<1000'],
      http_req_failed: ['rate<0.05'],
      flow_completion_rate: ['rate>0.95'],
    },
    preAllocatedVUs: 100,
    maxVUs: 150,
    thinkTime: { min: 0.1, max: 0.5 }, // 100ms-500ms
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
    full_oidc_flow: {
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

// PKCE ヘルパー関数
function generateCodeVerifier() {
  // 43-128文字のランダム文字列
  return randomString(64, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~');
}

function generateCodeChallenge(verifier) {
  const hashed = sha256(verifier, 'arraybuffer');
  return encoding.b64encode(hashed, 'url');
}

// Basic 認証ヘッダーの生成
function getBasicAuthHeader() {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${encoding.b64encode(credentials)}`;
}

// セットアップ
export function setup() {
  console.log(`🚀 TEST 3: フル OIDC 認証フロー`);
  console.log(`📊 プリセット: ${PRESET}`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);

  return {
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    preset: PRESET,
  };
}

// メインテスト関数
export default function (data) {
  const flowStartTime = new Date();
  let flowSuccess = false;

  // PKCE パラメータ生成
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = randomString(16);
  const nonce = randomString(16);

  // ========================================
  // STEP 1: Authorization Request
  // ========================================

  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    nonce: nonce,
  });

  const authorizeUrl = `${BASE_URL}/authorize?${authorizeParams.toString()}`;

  const authorizeResponse = http.get(authorizeUrl, {
    redirects: 0, // リダイレクトを自動で追わない
    headers: SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : undefined,
    tags: {
      name: 'AuthorizeRequest',
      preset: PRESET,
    },
  });
  const authorizeDuration = authorizeResponse.timings.duration;

  authorizeRequestDuration.add(authorizeDuration);

  // Authorization レスポンスのチェック
  const authorizeOk = check(authorizeResponse, {
    'authorize: status is 302 or 200': (r) => r.status === 302 || r.status === 200,
    'authorize: has location or code': (r) => {
      return r.headers['Location'] !== undefined || (r.body && r.body.includes('code='));
    },
    'authorize: not redirected to login': (r) => {
      const location = r.headers['Location'] || '';
      return !(location.includes('login') || location.includes('signin'));
    },
  });

  authorizeSuccess.add(authorizeOk);

  if (!authorizeOk) {
    console.error(`❌ Authorize failed: ${authorizeResponse.status}`);
    if (SESSION_COOKIE === '') {
      console.error('ℹ️ SESSION_COOKIE が設定されていないため、ログイン/コンセントで停止している可能性があります。');
    }
    flowCompletionRate.add(0);
    return;
  }

  // 認可コードの抽出
  let authorizationCode = null;

  // Location ヘッダーから code を抽出
  const locationHeader = authorizeResponse.headers['Location'];
  if (locationHeader) {
    const codeMatch = locationHeader.match(/code=([^&]+)/);
    if (codeMatch) {
      authorizationCode = codeMatch[1];
    }
  }

  // ボディから code を抽出（リダイレクトしない実装の場合）
  if (!authorizationCode && authorizeResponse.body) {
    const codeMatch = authorizeResponse.body.match(/code=([^&"]+)/);
    if (codeMatch) {
      authorizationCode = codeMatch[1];
    }
  }

  if (!authorizationCode) {
    console.error(`❌ Authorization code not found`);
    codeExchangeErrors.add(1);
    flowCompletionRate.add(0);
    return;
  }

  // Think Time（ユーザーがリダイレクトされる時間をシミュレート）
  const thinkTime = randomIntBetween(
    selectedPreset.thinkTime.min * 1000,
    selectedPreset.thinkTime.max * 1000
  ) / 1000;
  sleep(thinkTime);

  // ========================================
  // STEP 2: Token Request（Code Exchange）
  // ========================================

  const tokenParams = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': getBasicAuthHeader(),
      ...(SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {}),
    },
    tags: {
      name: 'TokenRequest',
      preset: PRESET,
    },
  };

  const tokenPayload = [
    `grant_type=authorization_code`,
    `code=${authorizationCode}`,
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    `code_verifier=${codeVerifier}`,
  ].join('&');

  const tokenResponse = http.post(`${BASE_URL}/token`, tokenPayload, tokenParams);
  const tokenDuration = tokenResponse.timings.duration;

  tokenRequestDuration.add(tokenDuration);

  // Token レスポンスのチェック
  let tokenBody = {};
  try {
    tokenBody = JSON.parse(tokenResponse.body);
  } catch (e) {
    // JSON パースエラー
  }

  const tokenOk = check(tokenResponse, {
    'token: status is 200': (r) => r.status === 200,
    'token: has access_token': (r) => tokenBody.access_token !== undefined,
    'token: has id_token': (r) => tokenBody.id_token !== undefined,
    'token: has refresh_token': (r) => tokenBody.refresh_token !== undefined,
    'token: token_type is Bearer': (r) => tokenBody.token_type === 'Bearer',
  });

  tokenSuccess.add(tokenOk);

  if (tokenResponse.status === 400 && tokenResponse.body.includes('invalid_grant')) {
    pkceValidationErrors.add(1);
  }

  if (!tokenOk) {
    console.error(`❌ Token exchange failed: ${tokenResponse.status} - ${tokenResponse.body}`);
    codeExchangeErrors.add(1);
    flowCompletionRate.add(0);
    return;
  }

  // ========================================
  // フロー完了
  // ========================================

  flowSuccess = true;
  const flowTotalDuration = new Date() - flowStartTime;
  fullFlowDuration.add(flowTotalDuration);
  flowCompletionRate.add(1);
}

// ティアダウン
export function teardown(data) {
  console.log(`✅ TEST 3 完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
}

// サマリーハンドラー
export function handleSummary(data) {
  const preset = PRESET;
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const resultsDir = __ENV.RESULTS_DIR || '../results';

  return {
    [`${resultsDir}/test3-${preset}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// テキストサマリー生成
function textSummary(data, options) {
  const indent = options.indent || '';

  let summary = '\n';
  summary += `${indent}📊 TEST 3: フル OIDC 認証フロー - サマリー\n`;
  summary += `${indent}${'='.repeat(60)}\n\n`;

  // 基本統計
  const metrics = data.metrics;
  const totalIterations = metrics.iterations?.values?.count || 0;
  const flowCompletions = (metrics.flow_completion_rate?.values?.rate || 0) * totalIterations;

  summary += `${indent}📈 フロー統計:\n`;
  summary += `${indent}  開始したフロー数: ${totalIterations}\n`;
  summary += `${indent}  完了したフロー数: ${flowCompletions.toFixed(0)}\n`;
  summary += `${indent}  完了率: ${((metrics.flow_completion_rate?.values?.rate || 0) * 100).toFixed(2)}%\n\n`;

  // ステップ別レスポンスタイム
  summary += `${indent}⏱️  ステップ別レスポンスタイム:\n`;
  summary += `${indent}  Authorize リクエスト:\n`;
  summary += `${indent}    平均: ${metrics.authorize_request_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}    p90: ${metrics.authorize_request_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}    p99: ${metrics.authorize_request_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  summary += `${indent}  Token リクエスト:\n`;
  summary += `${indent}    平均: ${metrics.token_request_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}    p90: ${metrics.token_request_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}    p99: ${metrics.token_request_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  summary += `${indent}  フル OIDC フロー合計:\n`;
  summary += `${indent}    平均: ${metrics.full_flow_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}    p90: ${metrics.full_flow_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}    p99: ${metrics.full_flow_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  PKCE 検証エラー: ${metrics.pkce_validation_errors?.values?.count || 0}\n`;
  summary += `${indent}  Code 交換エラー: ${metrics.code_exchange_errors?.values?.count || 0}\n\n`;

  // 成功率
  summary += `${indent}✅ 成功率:\n`;
  summary += `${indent}  Authorize 成功率: ${((metrics.authorize_success?.values?.rate || 0) * 100).toFixed(2)}%\n`;
  summary += `${indent}  Token 成功率: ${((metrics.token_success?.values?.rate || 0) * 100).toFixed(2)}%\n\n`;

  // 判定
  const flowCompletionRate = (metrics.flow_completion_rate?.values?.rate || 0) * 100;
  const p99 = metrics.full_flow_duration?.values?.['p(99)'] || 0;
  const errorRate = (metrics.http_req_failed?.values?.rate || 0) * 100;

  summary += `${indent}📊 判定:\n`;

  if (PRESET === 'light') {
    const pass = flowCompletionRate > 99 && p99 < 300 && errorRate < 0.5;
    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - 完了率 > 99%: ${flowCompletionRate > 99 ? '✅' : '❌'} (${flowCompletionRate.toFixed(2)}%)\n`;
    summary += `${indent}  - p99 < 300ms: ${p99 < 300 ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 0.5%: ${errorRate < 0.5 ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
  } else if (PRESET === 'standard') {
    const pass = flowCompletionRate > 98 && p99 < 500 && errorRate < 1;
    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - 完了率 > 98%: ${flowCompletionRate > 98 ? '✅' : '❌'} (${flowCompletionRate.toFixed(2)}%)\n`;
    summary += `${indent}  - p99 < 500ms: ${p99 < 500 ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
    summary += `${indent}  - エラーレート < 1%: ${errorRate < 1 ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
  } else if (PRESET === 'heavy') {
    const pass = flowCompletionRate > 95 && errorRate < 5;
    summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
    summary += `${indent}  - 完了率 > 95%: ${flowCompletionRate > 95 ? '✅' : '❌'} (${flowCompletionRate.toFixed(2)}%)\n`;
    summary += `${indent}  - エラーレート < 5%: ${errorRate < 5 ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
    summary += `${indent}  - p99: ${p99.toFixed(2)}ms\n`;
  }

  summary += `${indent}\n${'='.repeat(60)}\n`;

  return summary;
}
