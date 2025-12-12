/**
 * Authorization Endpoint ベンチマークテスト - サイレント認証 (prompt=none)
 *
 * 目的:
 * - ログイン済みユーザーの認可処理 (/authorize?prompt=none) の最大スループットを測定
 * - SSO / 定期ログインのピークトラフィック耐性を評価
 * - Auth0/Keycloak/Ory との比較指標
 *
 * テスト仕様:
 * - ターゲット: GET /authorize?prompt=none
 * - 認証: Session Cookie (事前にAdmin APIで作成)
 * - 成功判定: 302 redirect + code パラメータ
 *
 * 使い方:
 * k6 run --env PRESET=rps200 scripts/test-authorize-silent-benchmark.js
 * k6 run --env PRESET=rps400 scripts/test-authorize-silent-benchmark.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import { randomBytes, sha256 } from 'k6/crypto';
import exec from 'k6/execution';

// テスト識別情報
const TEST_NAME = 'Authorization Endpoint Benchmark - Silent Auth (prompt=none)';
const TEST_ID = 'authorize-silent-benchmark';

// カスタムメトリクス
const authorizeDuration = new Trend('authorize_duration');
const authorizeSuccess = new Rate('authorize_success');
const redirectSuccess = new Counter('redirect_success');
const codeReceived = new Counter('code_received');
const sessionErrors = new Counter('session_errors');
const loginRequired = new Counter('login_required');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const ADMIN_API_SECRET = __ENV.ADMIN_API_SECRET || '';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://localhost:3000/callback';
const PRESET = __ENV.PRESET || 'rps200';
const USER_LIST_PATH = __ENV.USER_LIST_PATH || '../seeds/test_users.txt';
// K6 Cloud用: R2からユーザーリストをフェッチするURL
const USER_LIST_URL = __ENV.USER_LIST_URL || '';
// セッション数（事前に作成するテストセッション数）
const SESSION_COUNT = Number.parseInt(__ENV.SESSION_COUNT || '500', 10);

/**
 * プリセット設定
 *
 * 仕様書準拠:
 * - RPS: 200, 400, 600, 800
 * - Duration: 120秒
 * - 成功率: > 99%
 * - p95: < 1500ms, p99: < 2000ms
 * - 5xx: < 0.1%
 */
const PRESETS = {
  // 軽量テスト（開発・確認用）
  rps50: {
    description: '50 RPS - Quick smoke test (30s)',
    stages: [
      { target: 25, duration: '10s' },
      { target: 50, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<2000', 'p(99)<3000'],
      http_req_failed: ['rate<0.02'],
      authorize_success: ['rate>0.98'],
    },
    preAllocatedVUs: 80,
    maxVUs: 100,
    sessionCount: 100,
  },

  // ベンチマーク: 200 RPS (3分)
  rps200: {
    description: '200 RPS - Authorization benchmark (3 min)',
    stages: [
      { target: 100, duration: '15s' },
      { target: 200, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.01'],
      authorize_success: ['rate>0.99'],
    },
    preAllocatedVUs: 300,
    maxVUs: 400,
    sessionCount: 500,
  },

  // ベンチマーク: 400 RPS (3分)
  rps400: {
    description: '400 RPS - Authorization high throughput (3 min)',
    stages: [
      { target: 200, duration: '15s' },
      { target: 400, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.01'],
      authorize_success: ['rate>0.99'],
    },
    preAllocatedVUs: 500,
    maxVUs: 700,
    sessionCount: 500,
  },

  // ベンチマーク: 600 RPS (3分)
  rps600: {
    description: '600 RPS - Authorization stress test (3 min)',
    stages: [
      { target: 300, duration: '15s' },
      { target: 600, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.01'],
      authorize_success: ['rate>0.99'],
    },
    preAllocatedVUs: 750,
    maxVUs: 1000,
    sessionCount: 500,
  },

  // ベンチマーク: 800 RPS (3分)
  rps800: {
    description: '800 RPS - Authorization maximum capacity (3 min)',
    stages: [
      { target: 400, duration: '15s' },
      { target: 800, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.01'],
      authorize_success: ['rate>0.99'],
    },
    preAllocatedVUs: 1000,
    maxVUs: 1300,
    sessionCount: 500,
  },

  // ベンチマーク: 1000 RPS (3分)
  rps1000: {
    description: '1000 RPS - Authorization ultra high (3 min)',
    stages: [
      { target: 500, duration: '15s' },
      { target: 1000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.05'],
      authorize_success: ['rate>0.95'],
    },
    preAllocatedVUs: 1200,
    maxVUs: 1600,
    sessionCount: 500,
  },

  // ベンチマーク: 1200 RPS (3分)
  rps1200: {
    description: '1200 RPS - Authorization extreme (3 min)',
    stages: [
      { target: 600, duration: '15s' },
      { target: 1200, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.10'],
      authorize_success: ['rate>0.90'],
    },
    preAllocatedVUs: 1500,
    maxVUs: 2000,
    sessionCount: 500,
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
    authorize_benchmark: {
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
  setupTimeout: '180s', // 500セッション作成に十分な時間
};

// ユーザーリスト読み込み（ローカル実行時のみ）
let userList = null;
let useRemoteUserList = false;

if (USER_LIST_URL) {
  useRemoteUserList = true;
  console.log(`🌐 Remote user list mode: Will fetch from ${USER_LIST_URL}`);
} else {
  try {
    userList = new SharedArray('users', function () {
      const content = open(USER_LIST_PATH);
      return content
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
    });
    console.log(`📂 Loaded ${userList.length} users from ${USER_LIST_PATH}`);
  } catch (e) {
    console.warn(`⚠️  Could not load user list: ${e.message}`);
  }
}

/**
 * ランダムなcode_verifierを生成（PKCE用）
 * RFC 7636: 43〜128文字、[A-Z]/[a-z]/[0-9]/"-"/"."/"_"/"~" のみ
 */
function generateCodeVerifier() {
  const buffer = randomBytes(32);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = encoding.b64encode(binary, 'std');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * code_challengeを生成（S256方式）
 */
function generateCodeChallenge(verifier) {
  return sha256(verifier, 'base64rawurl');
}

/**
 * ランダムなstate/nonceを生成
 */
function generateRandomHex(bytes) {
  const buffer = randomBytes(bytes);
  const arr = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Admin APIでテストセッションを作成
 */
function createTestSession(userId) {
  const response = http.post(
    `${BASE_URL}/api/admin/test/sessions`,
    JSON.stringify({
      user_id: userId,
      ttl_seconds: 7200, // 2時間
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_API_SECRET}`,
      },
      tags: { name: 'CreateTestSession' },
    }
  );

  if (response.status !== 200 && response.status !== 201) {
    console.error(`Failed to create session for ${userId}: ${response.status} - ${response.body}`);
    return null;
  }

  try {
    const body = JSON.parse(response.body);
    return {
      userId,
      sessionId: body.session_id,
      cookie: `authrim_session=${body.session_id}`,
    };
  } catch (e) {
    console.error(`Failed to parse session response: ${e.message}`);
    return null;
  }
}

// セットアップ（テスト開始前に1回だけ実行）
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔑 Client: ${CLIENT_ID}`);
  console.log(``);

  if (!ADMIN_API_SECRET) {
    throw new Error('ADMIN_API_SECRET is required for creating test sessions');
  }

  // ユーザーリスト取得
  let users = [];
  if (useRemoteUserList && USER_LIST_URL) {
    console.log(`🌐 Fetching user list from: ${USER_LIST_URL}`);
    const response = http.get(USER_LIST_URL, {
      timeout: '120s',
      tags: { name: 'FetchUserList' },
    });
    if (response.status !== 200) {
      throw new Error(`Failed to fetch user list: ${response.status}`);
    }
    users = response.body
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    console.log(`   Loaded ${users.length} users from remote`);
  } else if (userList) {
    users = userList;
  }

  if (users.length === 0) {
    throw new Error('No users available. Run: node scripts/seed-users.js to generate test users');
  }

  // テストセッション作成
  const sessionCountToCreate = Math.min(selectedPreset.sessionCount || SESSION_COUNT, users.length);
  console.log(`📦 Creating ${sessionCountToCreate} test sessions...`);

  const sessions = [];
  const batchSize = 50;
  const totalBatches = Math.ceil(sessionCountToCreate / batchSize);

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * batchSize;
    const end = Math.min(start + batchSize, sessionCountToCreate);

    for (let i = start; i < end; i++) {
      const userId = users[i];
      const session = createTestSession(userId);
      if (session) {
        sessions.push(session);
      }
    }

    if ((batch + 1) % 2 === 0 || batch === totalBatches - 1) {
      console.log(`   [${sessions.length}/${sessionCountToCreate}] sessions created`);
    }

    // バッチ間でスリープ（レート制限回避）
    if (batch < totalBatches - 1) {
      sleep(0.5);
    }
  }

  if (sessions.length === 0) {
    throw new Error('Failed to create any test sessions');
  }

  console.log(`✅ Created ${sessions.length} test sessions`);
  console.log(``);

  // ウォームアップ
  console.log(`🔥 Warming up...`);
  for (let i = 0; i < Math.min(10, sessions.length); i++) {
    const session = sessions[i];
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateRandomHex(16);

    const url =
      `${BASE_URL}/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(CLIENT_ID)}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      `scope=openid&` +
      `state=${state}&` +
      `prompt=none&` +
      `code_challenge=${codeChallenge}&` +
      `code_challenge_method=S256`;

    http.get(url, {
      headers: { Cookie: session.cookie },
      redirects: 0,
      tags: { name: 'Warmup' },
    });
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    sessions,
    sessionCount: sessions.length,
    preset: PRESET,
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
  };
}

// メインテスト関数（各VUで繰り返し実行）
export default function (data) {
  const { sessions, sessionCount, clientId, redirectUri, baseUrl } = data;

  // VU IDベースでセッションを選択（ラウンドロビン）
  const sessionIndex = (__VU - 1) % sessionCount;
  const session = sessions[sessionIndex];

  // PKCE パラメータ生成
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateRandomHex(16);
  const nonce = generateRandomHex(16);

  // /authorize リクエスト（prompt=none）
  const url =
    `${baseUrl}/authorize?` +
    `response_type=code&` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=openid&` +
    `state=${state}&` +
    `nonce=${nonce}&` +
    `prompt=none&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256`;

  const params = {
    headers: {
      Cookie: session.cookie,
      Accept: 'text/html,application/xhtml+xml',
      Connection: 'keep-alive',
    },
    redirects: 0, // 302を直接キャッチ
    tags: {
      name: 'AuthorizeRequest',
      preset: PRESET,
    },
  };

  const response = http.get(url, params);
  const duration = response.timings.duration;

  // メトリクス記録
  authorizeDuration.add(duration);

  // レスポンス検証
  const isRedirect = response.status === 302;
  const location = response.headers.Location || response.headers.location || '';
  const hasCode = location.includes('code=');
  const hasLoginRequired = location.includes('error=login_required');
  const hasState = location.includes(`state=${state}`);

  const success = check(response, {
    'status is 302': () => isRedirect,
    'has code parameter': () => hasCode,
    'state matches': () => hasState,
    'response time < 3000ms': () => duration < 3000,
  });

  authorizeSuccess.add(success);

  if (isRedirect) {
    redirectSuccess.add(1);
  }
  if (hasCode) {
    codeReceived.add(1);
  }
  if (hasLoginRequired) {
    loginRequired.add(1);
  }

  // エラー分類
  if (response.status === 401 || response.status === 403) {
    sessionErrors.add(1);
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
    console.error(`   status: ${response.status} (expected 302)`);
    console.error(`   location: ${location.substring(0, 100)}`);
    console.error(`   hasCode: ${hasCode}, hasLoginRequired: ${hasLoginRequired}`);
    console.error(`   duration: ${duration}ms`);
    if (response.status !== 302) {
      console.error(`   body: ${(response.body || '').substring(0, 200)}`);
    }
  }
}

// ティアダウン（テスト終了後に1回だけ実行）
export function teardown(data) {
  console.log(``);
  console.log(`✅ ${TEST_NAME} テスト完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
  console.log(`📈 セッション数: ${data.sessionCount}`);
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
  const successRate = ((metrics.authorize_success?.values?.rate || 0) * 100).toFixed(2);

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

  // 認可結果
  const redirects = metrics.redirect_success?.values?.count || 0;
  const codes = metrics.code_received?.values?.count || 0;
  const loginReq = metrics.login_required?.values?.count || 0;

  summary += `${indent}🔐 認可結果:\n`;
  summary += `${indent}  302 リダイレクト: ${redirects}\n`;
  summary += `${indent}  認可コード取得: ${codes}\n`;
  summary += `${indent}  login_required: ${loginReq}\n\n`;

  // 仕様書準拠チェック
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.authorize_success?.values?.rate || 0;
  const serverErr = metrics.server_errors?.values?.count || 0;
  const serverErrRate = totalRequests > 0 ? (serverErr / totalRequests) * 100 : 0;

  summary += `${indent}📋 仕様書準拠チェック:\n`;
  summary += `${indent}  成功率 > 99%: ${rate > 0.99 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 1500ms: ${p95 < 1500 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 2000ms: ${p99 < 2000 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  5xx < 0.1%: ${serverErrRate < 0.1 ? '✅ PASS' : '❌ FAIL'} (${serverErrRate.toFixed(3)}%)\n\n`;

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  セッションエラー (401/403): ${metrics.session_errors?.values?.count || 0}\n`;
  summary += `${indent}  レート制限 (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  サーバーエラー (5xx): ${serverErr}\n\n`;

  // スループット
  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 スループット: ${rps.toFixed(2)} req/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
