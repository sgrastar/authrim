/**
 * Mail OTP フルログイン ベンチマークテスト - K6 Cloud版
 *
 * 目的:
 * - Authrim のフルログインフローを再現し、負荷ポイントを測定
 * - OTP認証 → セッション発行 → 認可コード発行 → トークン発行の全フロー
 * - 事前シードされた既存ユーザーを使用（D1書き込みなし）
 * - **K6 Cloud経由で分散負荷テストを実行**
 *
 * 前提条件:
 * - seed-otp-users.js でユーザーを事前作成しておく
 * - 出力された otp_user_list.txt を R2/S3 等にアップロード
 * - USER_LIST_URL で取得可能にする
 *
 * テストフロー（5ステップ）:
 * 1. GET /authorize - 認可リクエスト開始（軽負荷）
 * 2. POST /api/admin/test/email-codes - OTPコード生成（ChallengeStore DO write）
 * 3. POST /api/auth/email-code/verify - OTP検証 + セッション発行（SessionStore DO write）
 * 4. GET /authorize (Cookie付き) - 認可コード生成（AuthCodeStore DO write）
 * 5. POST /token - トークン発行（RefreshTokenRotator write, JWT署名）
 *
 * 負荷ポイント（D1書き込みなし - 既存ユーザー使用）:
 * - ChallengeStore DO write (Step 2)
 * - ChallengeStore consume + SessionStore DO write (Step 3)
 * - AuthCodeStore DO write (Step 4)
 * - RefreshTokenRotator DO write + JWT署名 (Step 5)
 *
 * K6 Cloud実行方法:
 * 1. K6_CLOUD_TOKEN環境変数を設定
 * 2. ユーザーリストをR2/S3にアップロード
 * 3. k6 cloud --env PRESET=rps500 \
 *      --env USER_LIST_URL=https://your-bucket/otp_user_list.txt \
 *      scripts/test-mail-otp-full-login-benchmark-cloud.js
 *
 * ローカル実行（デバッグ用）:
 * k6 run --env PRESET=rps100 \
 *   --env USER_LIST_PATH=../seeds/otp_user_list.txt \
 *   scripts/test-mail-otp-full-login-benchmark-cloud.js
 */

import http from 'k6/http';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import { randomBytes, sha256 } from 'k6/crypto';
import exec from 'k6/execution';

// テスト識別情報
const TEST_NAME = 'Mail OTP Full Login Benchmark [Cloud]';
const TEST_ID = 'mail-otp-full-login-benchmark-cloud';

// カスタムメトリクス - ステップ別レイテンシ
const authorizeInitLatency = new Trend('authorize_init_latency');
const emailCodeGenerateLatency = new Trend('email_code_generate_latency');
const emailCodeVerifyLatency = new Trend('email_code_verify_latency');
const authorizeCodeLatency = new Trend('authorize_code_latency');
const tokenLatency = new Trend('token_latency');
const fullFlowLatency = new Trend('full_flow_latency');

// 成功率
const emailCodeSuccess = new Rate('email_code_success');
const authorizeSuccess = new Rate('authorize_success');
const tokenSuccess = new Rate('token_success');
const flowSuccess = new Rate('flow_success');

// エラーカウント
const otpGenerateErrors = new Counter('otp_generate_errors');
const otpVerifyErrors = new Counter('otp_verify_errors');
const sessionErrors = new Counter('session_errors');
const codeErrors = new Counter('code_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || '';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const ADMIN_API_SECRET = __ENV.ADMIN_API_SECRET || '';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://localhost:3000/callback';
const PRESET = __ENV.PRESET || 'rps100';
const USER_LIST_PATH = __ENV.USER_LIST_PATH || '../seeds/otp_user_list.txt';
// K6 Cloud用: R2からユーザーリストをフェッチするURL
const USER_LIST_URL = __ENV.USER_LIST_URL || '';

// K6 Cloud Project ID（環境変数で上書き可能）
const K6_CLOUD_PROJECT_ID = __ENV.K6_CLOUD_PROJECT_ID || '';

// ホスト名抽出用関数
function extractHostname(url) {
  const match = url.match(/^https?:\/\/([^/:]+)/);
  return match ? match[1] : url;
}

const ORIGIN = BASE_URL.replace(/^http:/, 'https:');

/**
 * プリセット設計 - K6 Cloud最適化版
 *
 * フルログインフローは5ステップあるため、サイレント認証より低いRPS目標
 * - 各ステップがDO write を伴う（ChallengeStore, SessionStore, AuthCodeStore, RefreshTokenRotator）
 * - 1フローあたり5 HTTPリクエスト = 5倍のサーバー負荷
 *
 * 目標:
 * - 成功率: > 95%
 * - Full Flow p95: < 5000ms
 * - 5xx: < 1%
 */
const PRESETS = {
  // 軽量テスト（確認用）
  rps50: {
    description: '50 RPS - Cloud smoke test (1 min)',
    stages: [
      { target: 25, duration: '10s' },
      { target: 50, duration: '60s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.90'],
    },
    preAllocatedVUs: 150,
    maxVUs: 250,
    userCount: 500,
  },

  // ベンチマーク: 100 RPS (2分)
  rps100: {
    description: '100 RPS - Cloud baseline (2 min)',
    stages: [
      { target: 50, duration: '15s' },
      { target: 100, duration: '120s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 300,
    maxVUs: 500,
    userCount: 1000,
  },

  // ベンチマーク: 200 RPS (3分)
  rps200: {
    description: '200 RPS - Cloud standard (3 min)',
    stages: [
      { target: 100, duration: '15s' },
      { target: 200, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 600,
    maxVUs: 900,
    userCount: 2000,
  },

  // ベンチマーク: 300 RPS (3分)
  rps300: {
    description: '300 RPS - Cloud high throughput (3 min)',
    stages: [
      { target: 150, duration: '15s' },
      { target: 300, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 900,
    maxVUs: 1200,
    userCount: 3000,
  },

  // ベンチマーク: 500 RPS (3分) - 高負荷テスト
  rps500: {
    description: '500 RPS - Cloud stress test (3 min)',
    stages: [
      { target: 250, duration: '15s' },
      { target: 500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<6000'],
      flow_success: ['rate>0.90'],
    },
    preAllocatedVUs: 1500,
    maxVUs: 2000,
    userCount: 5000,
  },

  // ベンチマーク: 750 RPS (3分) - 限界テスト
  rps750: {
    description: '750 RPS - Cloud limit test (3 min)',
    stages: [
      { target: 375, duration: '20s' },
      { target: 750, duration: '180s' },
      { target: 0, duration: '20s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<8000'],
      flow_success: ['rate>0.85'],
    },
    preAllocatedVUs: 2200,
    maxVUs: 3000,
    userCount: 7500,
  },

  // ベンチマーク: 1000 RPS (3分) - 極限テスト
  rps1000: {
    description: '1000 RPS - Cloud extreme (3 min)',
    stages: [
      { target: 500, duration: '20s' },
      { target: 1000, duration: '180s' },
      { target: 0, duration: '20s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<10000'],
      flow_success: ['rate>0.80'],
    },
    preAllocatedVUs: 3000,
    maxVUs: 4000,
    userCount: 10000,
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
      // US西海岸（Cloudflare Workers に近いリージョン）
      'amazon:us:portland': { loadZone: 'amazon:us:portland', percent: 100 },
    },
  },

  scenarios: {
    // ウォームアップシナリオ（メインテスト前にワーカーをウォーム状態に）
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 10, // 10 RPS
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 30,
      maxVUs: 50,
      startTime: '0s',
      gracefulStop: '5s',
    },
    // メインベンチマークシナリオ
    mail_otp_full_login: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
      startTime: '35s', // ウォームアップ後に開始
    },
  },
  thresholds: selectedPreset.thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  setupTimeout: '300s', // Cloud環境では余裕を持たせる
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

// セットアップ
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔑 Client: ${CLIENT_ID}`);
  console.log(`☁️  K6 Cloud Mode`);
  console.log(``);

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('CLIENT_ID and CLIENT_SECRET are required');
  }

  if (!ADMIN_API_SECRET) {
    throw new Error('ADMIN_API_SECRET is required for generating test email codes');
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
    const allUsers = response.body
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    console.log(`   Loaded ${allUsers.length} users from remote`);
    users = allUsers;
  } else if (userList && userList.length > 0) {
    for (let i = 0; i < userList.length; i++) {
      users.push(userList[i]);
    }
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
      'No users available. Set USER_LIST_URL environment variable or ensure otp_user_list.txt exists'
    );
  }

  // ユーザー数をプリセットのuserCountに制限
  const userCount = Math.min(users.length, selectedPreset.userCount);
  const selectedUsers = users.slice(0, userCount).map((email) => ({ email }));
  console.log(`📦 Using ${selectedUsers.length} users for benchmark`);
  console.log(``);

  // ウォームアップ
  console.log(`🔥 Warming up...`);
  for (let i = 0; i < Math.min(10, selectedUsers.length); i++) {
    const user = selectedUsers[i];
    // 認可エンドポイントウォームアップ
    http.get(`${BASE_URL}/authorize?response_type=code&client_id=${CLIENT_ID}&scope=openid`, {
      redirects: 0,
      tags: { name: 'Warmup' },
    });
    // Email code生成ウォームアップ
    http.post(
      `${BASE_URL}/api/admin/test/email-codes`,
      JSON.stringify({ email: user.email, create_user: false }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_API_SECRET}`,
        },
        tags: { name: 'Warmup' },
      }
    );
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    users: selectedUsers,
    userCount: selectedUsers.length,
    preset: PRESET,
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    adminSecret: ADMIN_API_SECRET,
  };
}

// メインテスト関数
export default function (data) {
  const { users, userCount, clientId, clientSecret, redirectUri, baseUrl, adminSecret } = data;

  // VU IDベースでユーザーを選択
  const userIndex = (__VU - 1) % userCount;
  const user = users[userIndex];

  const flowStartTime = Date.now();
  let success = true;
  let sessionCookie = null;
  let authCode = null;

  // PKCE パラメータ生成
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateRandomHex(16);
  const nonce = generateRandomHex(16);

  // ===============================
  // Step 1: GET /authorize (初期化)
  // ===============================
  const authorizeInitUrl =
    `${baseUrl}/authorize?` +
    `response_type=code&` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `scope=openid&` +
    `state=${state}&` +
    `nonce=${nonce}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256`;

  const step1Response = http.get(authorizeInitUrl, {
    headers: { Accept: 'text/html', Connection: 'keep-alive' },
    redirects: 0,
    tags: { name: 'AuthorizeInit' },
  });
  authorizeInitLatency.add(step1Response.timings.duration);

  if (step1Response.status !== 200 && step1Response.status !== 302) {
    success = false;
    if (step1Response.status >= 500) serverErrors.add(1);
    if (step1Response.status === 429) rateLimitErrors.add(1);
  }

  // ===============================
  // Step 2: POST /api/admin/test/email-codes (OTPコード生成)
  // ===============================
  let otpCode = null;
  let otpSessionId = null;

  if (success) {
    const step2Response = http.post(
      `${baseUrl}/api/admin/test/email-codes`,
      JSON.stringify({ email: user.email, create_user: false }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminSecret}`,
          Connection: 'keep-alive',
        },
        tags: { name: 'EmailCodeGenerate' },
      }
    );
    emailCodeGenerateLatency.add(step2Response.timings.duration);

    if (step2Response.status !== 200 && step2Response.status !== 201) {
      success = false;
      otpGenerateErrors.add(1);
      if (step2Response.status >= 500) serverErrors.add(1);
      if (step2Response.status === 429) rateLimitErrors.add(1);
      if (step2Response.status === 404 && exec.vu.iterationInInstance < 3) {
        console.error(`❌ User not found: ${user.email} - Run seed-otp-users.js first`);
      }
    } else {
      try {
        const otpData = JSON.parse(step2Response.body);
        otpCode = otpData.code;
        otpSessionId = otpData.otpSessionId;
      } catch (e) {
        success = false;
        otpGenerateErrors.add(1);
        if (exec.vu.iterationInInstance < 3) {
          console.error(`❌ Failed to parse OTP response: ${e.message}`);
        }
      }
    }
  }

  // ===============================
  // Step 3: POST /api/auth/email-code/verify (OTP検証 + セッション発行)
  // ===============================
  if (success && otpCode && otpSessionId) {
    const step3Response = http.post(
      `${baseUrl}/api/auth/email-code/verify`,
      JSON.stringify({ email: user.email, code: otpCode }),
      {
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `authrim_otp_session=${otpSessionId}`,
          Connection: 'keep-alive',
        },
        tags: { name: 'EmailCodeVerify' },
      }
    );
    emailCodeVerifyLatency.add(step3Response.timings.duration);

    if (step3Response.status !== 200) {
      success = false;
      otpVerifyErrors.add(1);
      sessionErrors.add(1);
      if (step3Response.status >= 500) serverErrors.add(1);
      if (step3Response.status === 429) rateLimitErrors.add(1);
    } else {
      try {
        const verifyData = JSON.parse(step3Response.body);
        if (verifyData.sessionId) {
          sessionCookie = verifyData.sessionId;
        }
      } catch (e) {
        // JSONパース失敗
      }

      if (!sessionCookie) {
        success = false;
        sessionErrors.add(1);
        if (exec.vu.iterationInInstance < 3) {
          console.error(`❌ No session ID returned from verify endpoint`);
        }
      }
    }
  }

  emailCodeSuccess.add(success);

  // ===============================
  // Step 4: GET /authorize (Cookie付き - 認可コード取得)
  // ===============================
  if (success && sessionCookie) {
    const authorizeCodeUrl =
      `${baseUrl}/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(clientId)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=openid&` +
      `state=${state}&` +
      `nonce=${nonce}&` +
      `code_challenge=${codeChallenge}&` +
      `code_challenge_method=S256&` +
      `prompt=none`;

    const step4Response = http.get(authorizeCodeUrl, {
      headers: {
        Accept: 'text/html',
        Cookie: `authrim_session=${sessionCookie}`,
        Connection: 'keep-alive',
      },
      redirects: 0,
      tags: { name: 'AuthorizeCode' },
    });
    authorizeCodeLatency.add(step4Response.timings.duration);

    // 302 リダイレクトで認可コードが返される
    if (step4Response.status === 302) {
      const location = step4Response.headers['Location'] || step4Response.headers['location'];
      if (location) {
        const codeMatch = location.match(/[?&]code=([^&]+)/);
        if (codeMatch) {
          authCode = codeMatch[1];
        }
      }
    }

    if (!authCode) {
      success = false;
      codeErrors.add(1);
      if (step4Response.status >= 500) serverErrors.add(1);
      if (step4Response.status === 429) rateLimitErrors.add(1);
    }
  }

  authorizeSuccess.add(success);

  // ===============================
  // Step 5: POST /token (トークン発行)
  // ===============================
  if (success && authCode) {
    const credentials = encoding.b64encode(`${clientId}:${clientSecret}`);

    const step5Response = http.post(
      `${baseUrl}/token`,
      `grant_type=authorization_code` +
        `&code=${encodeURIComponent(authCode)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_verifier=${codeVerifier}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
          Connection: 'keep-alive',
        },
        tags: { name: 'Token' },
      }
    );
    tokenLatency.add(step5Response.timings.duration);

    if (step5Response.status !== 200) {
      success = false;
      if (step5Response.status >= 500) serverErrors.add(1);
      if (step5Response.status === 429) rateLimitErrors.add(1);
    } else {
      try {
        const tokenData = JSON.parse(step5Response.body);
        if (!tokenData.access_token) {
          success = false;
        }
      } catch (e) {
        success = false;
      }
    }
  }

  tokenSuccess.add(success);

  // フロー完了
  const flowEndTime = Date.now();
  fullFlowLatency.add(flowEndTime - flowStartTime);
  flowSuccess.add(success);
}

// テアダウン
export function teardown(data) {
  console.log(``);
  console.log(`✅ ${TEST_NAME} テスト完了`);
  console.log(`📊 プリセット: ${data.preset}`);
  console.log(`🎯 ターゲット: ${data.baseUrl}`);
  console.log(`📈 ユーザー数: ${data.userCount}`);
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

  const summary = generateTextSummary(data);
  console.log(summary);

  const jsonResult = generateJsonResult(data);

  return {
    [`${resultsDir}/${TEST_ID}-${preset}_${timestamp}.json`]: JSON.stringify(jsonResult, null, 2),
    [`${resultsDir}/${TEST_ID}-${preset}_${timestamp}.log`]: summary,
    stdout: summary,
  };
}

// テキストサマリー生成
function generateTextSummary(data) {
  const metrics = data.metrics;

  // メトリクス取得ヘルパー
  const getMetric = (name, stat = 'avg') => {
    const metric = metrics[name];
    if (!metric || !metric.values) return 0;
    return metric.values[stat] || 0;
  };

  const getRate = (name) => {
    const metric = metrics[name];
    if (!metric || !metric.values) return 0;
    return metric.values.rate || 0;
  };

  const getCount = (name) => {
    const metric = metrics[name];
    if (!metric || !metric.values) return 0;
    return metric.values.count || 0;
  };

  // 基本統計
  const totalIterations = getCount('iterations');
  const flowSuccessRate = getRate('flow_success') * 100;

  let summary = '\n';
  summary += `📊 ${TEST_NAME} - サマリー\n`;
  summary += `${'='.repeat(70)}\n\n`;

  // テスト情報
  summary += `🎯 プリセット: ${PRESET}\n`;
  summary += `📝 説明: ${selectedPreset.description}\n`;
  summary += `☁️  実行環境: K6 Cloud\n\n`;

  // フロー統計
  summary += `📈 フロー統計:\n`;
  summary += `  総イテレーション数: ${totalIterations}\n`;
  summary += `  フロー成功率: ${flowSuccessRate.toFixed(2)}%\n\n`;

  // ステップ別レイテンシ
  summary += `⏱️  ステップ別レイテンシ:\n`;
  summary += `  1. Authorize Init:\n`;
  summary += `     med: ${getMetric('authorize_init_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('authorize_init_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('authorize_init_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('authorize_init_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += `  2. Email Code Generate:\n`;
  summary += `     med: ${getMetric('email_code_generate_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('email_code_generate_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('email_code_generate_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('email_code_generate_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += `  3. Email Code Verify:\n`;
  summary += `     med: ${getMetric('email_code_verify_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('email_code_verify_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('email_code_verify_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('email_code_verify_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += `  4. Authorize Code:\n`;
  summary += `     med: ${getMetric('authorize_code_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('authorize_code_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('authorize_code_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('authorize_code_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += `  5. Token:\n`;
  summary += `     med: ${getMetric('token_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('token_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('token_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('token_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += `  Full Flow:\n`;
  summary += `     med: ${getMetric('full_flow_latency', 'med').toFixed(2)}ms\n`;
  summary += `     p95: ${getMetric('full_flow_latency', 'p(95)').toFixed(2)}ms\n`;
  summary += `     p99: ${getMetric('full_flow_latency', 'p(99)').toFixed(2)}ms\n`;
  summary += `     p999: ${getMetric('full_flow_latency', 'p(99.9)').toFixed(2)}ms\n\n`;

  // ステップ別成功率
  summary += `✅ ステップ別成功率:\n`;
  summary += `  Email Code認証: ${(getRate('email_code_success') * 100).toFixed(2)}%\n`;
  summary += `  認可コード: ${(getRate('authorize_success') * 100).toFixed(2)}%\n`;
  summary += `  トークン発行: ${(getRate('token_success') * 100).toFixed(2)}%\n\n`;

  // エラー統計
  summary += `❌ エラー統計:\n`;
  summary += `  OTP生成エラー: ${getCount('otp_generate_errors')}\n`;
  summary += `  OTP検証エラー: ${getCount('otp_verify_errors')}\n`;
  summary += `  セッションエラー: ${getCount('session_errors')}\n`;
  summary += `  認可コードエラー: ${getCount('code_errors')}\n`;
  summary += `  レート制限 (429): ${getCount('rate_limit_errors')}\n`;
  summary += `  サーバーエラー (5xx): ${getCount('server_errors')}\n\n`;

  // 仕様書準拠チェック
  const p95 = getMetric('full_flow_latency', 'p(95)');
  const rate = getRate('flow_success');
  const serverErr = getCount('server_errors');
  const serverErrRate = totalIterations > 0 ? (serverErr / totalIterations) * 100 : 0;

  summary += `📋 目標達成チェック:\n`;
  summary += `  成功率 > 95%: ${rate > 0.95 ? '✅ PASS' : '❌ FAIL'} (${flowSuccessRate.toFixed(2)}%)\n`;
  summary += `  Full Flow p95 < 5000ms: ${p95 < 5000 ? '✅ PASS' : '⚠️  WARN'} (${p95.toFixed(2)}ms)\n`;
  summary += `  5xx < 1%: ${serverErrRate < 1 ? '✅ PASS' : '❌ FAIL'} (${serverErrRate.toFixed(3)}%)\n\n`;

  // スループット
  summary += `🚀 スループット: ${getMetric('iterations', 'rate').toFixed(2)} flows/s\n`;
  summary += `${'='.repeat(70)}\n`;

  return summary;
}

// JSON結果生成
function generateJsonResult(data) {
  const metrics = data.metrics;

  const getMetric = (name, stat = 'avg') => {
    const metric = metrics[name];
    if (!metric || !metric.values) return 0;
    return metric.values[stat] || 0;
  };

  const getRate = (name) => {
    const metric = metrics[name];
    if (!metric || !metric.values) return 0;
    return metric.values.rate || 0;
  };

  const getCount = (name) => {
    const metric = metrics[name];
    if (!metric || !metric.values) return 0;
    return metric.values.count || 0;
  };

  return {
    test_id: TEST_ID,
    test_name: TEST_NAME,
    preset: PRESET,
    description: selectedPreset.description,
    timestamp: new Date().toISOString(),
    target: BASE_URL,
    cloud_mode: true,
    metrics: {
      iterations: getCount('iterations'),
      flow_success_rate: getRate('flow_success'),
      email_code_success_rate: getRate('email_code_success'),
      authorize_success_rate: getRate('authorize_success'),
      token_success_rate: getRate('token_success'),
      latency: {
        authorize_init: {
          med: getMetric('authorize_init_latency', 'med'),
          p95: getMetric('authorize_init_latency', 'p(95)'),
          p99: getMetric('authorize_init_latency', 'p(99)'),
          p999: getMetric('authorize_init_latency', 'p(99.9)'),
        },
        email_code_generate: {
          med: getMetric('email_code_generate_latency', 'med'),
          p95: getMetric('email_code_generate_latency', 'p(95)'),
          p99: getMetric('email_code_generate_latency', 'p(99)'),
          p999: getMetric('email_code_generate_latency', 'p(99.9)'),
        },
        email_code_verify: {
          med: getMetric('email_code_verify_latency', 'med'),
          p95: getMetric('email_code_verify_latency', 'p(95)'),
          p99: getMetric('email_code_verify_latency', 'p(99)'),
          p999: getMetric('email_code_verify_latency', 'p(99.9)'),
        },
        authorize_code: {
          med: getMetric('authorize_code_latency', 'med'),
          p95: getMetric('authorize_code_latency', 'p(95)'),
          p99: getMetric('authorize_code_latency', 'p(99)'),
          p999: getMetric('authorize_code_latency', 'p(99.9)'),
        },
        token: {
          med: getMetric('token_latency', 'med'),
          p95: getMetric('token_latency', 'p(95)'),
          p99: getMetric('token_latency', 'p(99)'),
          p999: getMetric('token_latency', 'p(99.9)'),
        },
        full_flow: {
          med: getMetric('full_flow_latency', 'med'),
          p95: getMetric('full_flow_latency', 'p(95)'),
          p99: getMetric('full_flow_latency', 'p(99)'),
          p999: getMetric('full_flow_latency', 'p(99.9)'),
        },
      },
      errors: {
        otp_generate: getCount('otp_generate_errors'),
        otp_verify: getCount('otp_verify_errors'),
        session: getCount('session_errors'),
        code: getCount('code_errors'),
        rate_limit: getCount('rate_limit_errors'),
        server: getCount('server_errors'),
      },
      throughput: getMetric('iterations', 'rate'),
    },
  };
}
