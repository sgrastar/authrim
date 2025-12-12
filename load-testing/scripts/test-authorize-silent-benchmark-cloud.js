/**
 * Authorization Endpoint ベンチマークテスト - サイレント認証 (prompt=none) - K6 Cloud版
 *
 * 目的:
 * - ログイン済みユーザーの認可処理 (/authorize?prompt=none) の最大スループットを測定
 * - SSO / 定期ログインのピークトラフィック耐性を評価
 * - Auth0/Keycloak/Ory との比較指標
 * - **K6 Cloud経由で分散負荷テストを実行**
 *
 * テスト仕様:
 * - ターゲット: GET /authorize?prompt=none
 * - 認証: Session Cookie (事前にAdmin APIで作成)
 * - 成功判定: 302 redirect + code パラメータ
 *
 * K6 Cloud実行方法:
 * 1. K6_CLOUD_TOKEN環境変数を設定
 * 2. k6 cloud --env PRESET=rps500 scripts/test-authorize-silent-benchmark-cloud.js
 *
 * ローカル実行（デバッグ用）:
 * k6 run --env PRESET=rps200 scripts/test-authorize-silent-benchmark-cloud.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import { randomBytes, sha256 } from 'k6/crypto';
import exec from 'k6/execution';

// テスト識別情報
const TEST_NAME = 'Authorization Endpoint Benchmark - Silent Auth (prompt=none) [Cloud]';
const TEST_ID = 'authorize-silent-benchmark-cloud';

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
const PRESET = __ENV.PRESET || 'rps500';
const USER_LIST_PATH = __ENV.USER_LIST_PATH || '../seeds/test_users.txt';
// K6 Cloud用: R2からユーザーリストをフェッチするURL
const USER_LIST_URL = __ENV.USER_LIST_URL || '';
// セッション数（事前に作成するテストセッション数）
const SESSION_COUNT = Number.parseInt(__ENV.SESSION_COUNT || '500', 10);

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
 * - 成功率: > 99%
 * - p95: < 1500ms, p99: < 2000ms
 * - 5xx: < 0.1%
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
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.01'],
      authorize_success: ['rate>0.99'],
    },
    preAllocatedVUs: 150,
    maxVUs: 200,
    sessionCount: 200,
  },

  // ベンチマーク: 200 RPS (3分)
  rps200: {
    description: '200 RPS - Cloud baseline (3 min)',
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

  // ベンチマーク: 500 RPS (3分) - Cloud推奨スタート
  rps500: {
    description: '500 RPS - Cloud standard (3 min)',
    stages: [
      { target: 250, duration: '15s' },
      { target: 500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.01'],
      authorize_success: ['rate>0.99'],
    },
    preAllocatedVUs: 700,
    maxVUs: 900,
    sessionCount: 500,
  },

  // ベンチマーク: 1000 RPS (3分)
  rps1000: {
    description: '1000 RPS - Cloud high throughput (3 min)',
    stages: [
      { target: 500, duration: '15s' },
      { target: 1000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.01'],
      authorize_success: ['rate>0.99'],
    },
    preAllocatedVUs: 1200,
    maxVUs: 1600,
    sessionCount: 500,
  },

  // ベンチマーク: 1500 RPS (3分)
  rps1500: {
    description: '1500 RPS - Cloud stress test (3 min)',
    stages: [
      { target: 750, duration: '15s' },
      { target: 1500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.02'],
      authorize_success: ['rate>0.98'],
    },
    preAllocatedVUs: 1800,
    maxVUs: 2400,
    sessionCount: 500,
  },

  // ベンチマーク: 2000 RPS (3分)
  rps2000: {
    description: '2000 RPS - Cloud maximum (3 min)',
    stages: [
      { target: 1000, duration: '15s' },
      { target: 2000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1500', 'p(99)<2000'],
      http_req_failed: ['rate<0.05'],
      authorize_success: ['rate>0.95'],
    },
    preAllocatedVUs: 2500,
    maxVUs: 3500,
    sessionCount: 500,
  },

  // ベンチマーク: 2500 RPS (3分)
  rps2500: {
    description: '2500 RPS - Cloud high stress (3 min)',
    stages: [
      { target: 1250, duration: '15s' },
      { target: 2500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1800', 'p(99)<2500'],
      http_req_failed: ['rate<0.05'],
      authorize_success: ['rate>0.95'],
    },
    preAllocatedVUs: 3200,
    maxVUs: 4200,
    sessionCount: 500,
  },

  // 限界テスト: 3000 RPS (3分)
  rps3000: {
    description: '3000 RPS - Cloud extreme (3 min)',
    stages: [
      { target: 1500, duration: '20s' },
      { target: 3000, duration: '180s' },
      { target: 0, duration: '20s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<2000', 'p(99)<3000'],
      http_req_failed: ['rate<0.10'],
      authorize_success: ['rate>0.90'],
    },
    preAllocatedVUs: 4000,
    maxVUs: 5000,
    sessionCount: 500,
  },

  // 限界テスト: 3500 RPS (3分)
  rps3500: {
    description: '3500 RPS - Cloud limit test (3 min)',
    stages: [
      { target: 1750, duration: '20s' },
      { target: 3500, duration: '180s' },
      { target: 0, duration: '20s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<2500', 'p(99)<4000'],
      http_req_failed: ['rate<0.15'],
      authorize_success: ['rate>0.85'],
    },
    preAllocatedVUs: 4500,
    maxVUs: 6000,
    sessionCount: 500,
  },

  // 限界テスト: 4000 RPS (3分)
  rps4000: {
    description: '4000 RPS - Cloud absolute limit (3 min)',
    stages: [
      { target: 2000, duration: '20s' },
      { target: 4000, duration: '180s' },
      { target: 0, duration: '20s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<3000', 'p(99)<5000'],
      http_req_failed: ['rate<0.20'],
      authorize_success: ['rate>0.80'],
    },
    preAllocatedVUs: 5500,
    maxVUs: 7000,
    sessionCount: 500,
  },

  // シャード増加テスト: 4500 RPS (3分) - 128シャード構成
  rps4500: {
    description: '4500 RPS - Cloud 128-shard test (3 min)',
    stages: [
      { target: 2250, duration: '20s' },
      { target: 4500, duration: '180s' },
      { target: 0, duration: '20s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<3500', 'p(99)<5500'],
      http_req_failed: ['rate<0.20'],
      authorize_success: ['rate>0.80'],
    },
    preAllocatedVUs: 6000,
    maxVUs: 8000,
    sessionCount: 500,
  },
};

// プリセット検証
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Unknown preset: ${PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`);
}

// K6オプション（Cloud最適化）
export const options = {
  // K6 Cloud設定
  cloud: {
    projectID: K6_CLOUD_PROJECT_ID ? Number.parseInt(K6_CLOUD_PROJECT_ID, 10) : undefined,
    name: `${TEST_ID} - ${PRESET}`,
    distribution: {
      // 単一リージョン（Cloudflareエッジに近いリージョン）
      'amazon:us:ashburn': { loadZone: 'amazon:us:ashburn', percent: 100 },
    },
  },

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
  setupTimeout: '600s', // Cloud環境では余裕を持たせる（128シャード対応）
};

// ユーザーリスト読み込み
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
    console.warn(`⚠️  Could not load user list from file: ${e.message}`);
    console.warn(`   Will attempt to fetch from USER_LIST_URL if provided`);
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
  console.log(`☁️  K6 Cloud Mode`);
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
  } else if (userList && userList.length > 0) {
    users = userList;
  } else if (USER_LIST_URL) {
    // SharedArrayが空でもURLがあれば取得を試みる
    console.log(`🌐 Attempting to fetch user list from: ${USER_LIST_URL}`);
    const response = http.get(USER_LIST_URL, {
      timeout: '120s',
      tags: { name: 'FetchUserList' },
    });
    if (response.status === 200) {
      users = response.body
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      console.log(`   Loaded ${users.length} users from remote`);
    }
  }

  if (users.length === 0) {
    throw new Error(
      'No users available. Set USER_LIST_URL environment variable or ensure test_users.txt exists'
    );
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
  for (let i = 0; i < Math.min(20, sessions.length); i++) {
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

  // デバッグ（失敗時のみ、最初の数回）
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
  summary += `${indent}📝 説明: ${selectedPreset.description}\n`;
  summary += `${indent}☁️  実行環境: K6 Cloud\n\n`;

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
