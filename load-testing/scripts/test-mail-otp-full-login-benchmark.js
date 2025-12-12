/**
 * Mail OTP フルログイン ベンチマークテスト
 *
 * 目的:
 * - Authrim のフルログインフローを再現し、負荷ポイントを測定
 * - OTP認証 → セッション発行 → 認可コード発行 → トークン発行の全フロー
 * - 事前シードされた既存ユーザーを使用（D1書き込みなし）
 *
 * 前提条件:
 * - seed-otp-users.js でユーザーを事前作成しておく
 * - 出力された otp_user_list.txt を USER_LIST_PATH で指定
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
 * 環境変数:
 *   BASE_URL          - Authrim URL (default: https://conformance.authrim.com)
 *   CLIENT_ID         - OAuth クライアントID (required)
 *   CLIENT_SECRET     - OAuth クライアントシークレット (required)
 *   ADMIN_API_SECRET  - Admin API シークレット (required)
 *   PRESET            - プリセット名 (default: rps10)
 *   USER_LIST_PATH    - ユーザーリストファイルパス (default: ../seeds/otp_user_list.txt)
 *
 * 使い方:
 * # Step 0: ユーザーシード
 * BASE_URL=https://conformance.authrim.com \
 *   ADMIN_API_SECRET=xxx \
 *   OTP_USER_COUNT=500 \
 *   node scripts/seed-otp-users.js
 *
 * # Step 1: ベンチマーク実行
 * k6 run -e PRESET=rps30 \
 *   -e BASE_URL=https://conformance.authrim.com \
 *   -e CLIENT_ID=xxx \
 *   -e CLIENT_SECRET=yyy \
 *   -e ADMIN_API_SECRET=zzz \
 *   -e USER_LIST_PATH=../seeds/otp_user_list.txt \
 *   scripts/test-mail-otp-full-login-benchmark.js
 */

import http from 'k6/http';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import { randomBytes, sha256 } from 'k6/crypto';

// テスト識別情報
const TEST_NAME = 'Mail OTP Full Login Benchmark';
const TEST_ID = 'mail-otp-full-login-benchmark';

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
const PRESET = __ENV.PRESET || 'rps10';
const USER_LIST_PATH = __ENV.USER_LIST_PATH || '../seeds/otp_user_list.txt';

// ホスト名抽出用関数
function extractHostname(url) {
  const match = url.match(/^https?:\/\/([^/:]+)/);
  return match ? match[1] : url;
}

const ORIGIN = BASE_URL.replace(/^http:/, 'https:');

// プリセット設計
const PRESETS = {
  rps10: {
    description: '10 RPS - Smoke test (30s)',
    stages: [
      { target: 5, duration: '10s' },
      { target: 10, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.90'],
    },
    preAllocatedVUs: 30,
    maxVUs: 50,
    userCount: 100,
  },
  rps30: {
    description: '30 RPS - Standard benchmark (2 min)',
    stages: [
      { target: 15, duration: '15s' },
      { target: 30, duration: '120s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<4000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 80,
    maxVUs: 120,
    userCount: 200,
  },
  rps50: {
    description: '50 RPS - High throughput (3 min)',
    stages: [
      { target: 25, duration: '15s' },
      { target: 50, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<4000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 150,
    maxVUs: 200,
    userCount: 300,
  },
  rps100: {
    description: '100 RPS - Stress test (3 min)',
    stages: [
      { target: 50, duration: '15s' },
      { target: 100, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.90'],
    },
    preAllocatedVUs: 300,
    maxVUs: 400,
    userCount: 500,
  },
};

const selectedPreset = PRESETS[PRESET] || PRESETS.rps10;

// k6オプション設定
export const options = {
  scenarios: {
    mail_otp_full_login: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
    },
  },
  thresholds: selectedPreset.thresholds,
};

// ユーザーリスト読み込み（オプション）
let userList = null;
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
  console.warn(`   Will generate random email addresses`);
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

/**
 * ランダムなメールアドレスを生成
 */
function generateRandomEmail() {
  return `otp-user-${generateRandomHex(8)}@test.authrim.internal`;
}

// セットアップ
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔑 Client: ${CLIENT_ID}`);
  console.log(``);

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('CLIENT_ID and CLIENT_SECRET are required');
  }

  if (!ADMIN_API_SECRET) {
    throw new Error('ADMIN_API_SECRET is required for generating test email codes');
  }

  // ユーザーリスト準備
  let users = [];
  if (userList && userList.length > 0) {
    // ユーザーリストからメールアドレスを取得
    for (let i = 0; i < Math.min(userList.length, selectedPreset.userCount); i++) {
      users.push({ email: userList[i] });
    }
    console.log(`📦 Using ${users.length} users from user list`);
  } else {
    // ランダムなメールアドレスを生成
    for (let i = 0; i < selectedPreset.userCount; i++) {
      users.push({ email: generateRandomEmail() });
    }
    console.log(`📦 Generated ${users.length} random email addresses`);
  }
  console.log(``);

  // ウォームアップ
  console.log(`🔥 Warming up...`);
  for (let i = 0; i < Math.min(5, users.length); i++) {
    const user = users[i];
    // 認可エンドポイントウォームアップ
    http.get(`${BASE_URL}/authorize?response_type=code&client_id=${CLIENT_ID}&scope=openid`, {
      redirects: 0,
      tags: { name: 'Warmup' },
    });
    // Email code生成ウォームアップ
    http.post(
      `${BASE_URL}/api/admin/test/email-codes`,
      JSON.stringify({ email: user.email }),
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
    users,
    userCount: users.length,
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
  // Note: create_user: false を指定して、既存ユーザーのみOTP生成
  // 事前にseed-otp-users.jsでユーザーをシードしておく必要がある
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
      if (step2Response.status === 404) {
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
        console.error(`❌ Failed to parse OTP response: ${e.message}`);
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
      // レスポンスJSONからsessionIdを取得
      // Note: email-code/verify エンドポイントはSet-Cookieヘッダーではなく
      // レスポンスボディでsessionIdを返す
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
        console.error(`❌ No session ID returned from verify endpoint`);
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

  // サマリーテキスト生成
  const summary = `
 📊 ${TEST_NAME} - サマリー
 ======================================================================

 🎯 プリセット: ${PRESET}
 📝 説明: ${selectedPreset.description}

 📈 フロー統計:
   総イテレーション数: ${getCount('iterations')}
   フロー成功率: ${(getRate('flow_success') * 100).toFixed(2)}%

 ⏱️  ステップ別レイテンシ:
   1. Authorize Init:
      p50: ${getMetric('authorize_init_latency', 'med').toFixed(2)}ms
      p95: ${getMetric('authorize_init_latency', 'p(95)').toFixed(2)}ms
   2. Email Code Generate:
      p50: ${getMetric('email_code_generate_latency', 'med').toFixed(2)}ms
      p95: ${getMetric('email_code_generate_latency', 'p(95)').toFixed(2)}ms
   3. Email Code Verify:
      p50: ${getMetric('email_code_verify_latency', 'med').toFixed(2)}ms
      p95: ${getMetric('email_code_verify_latency', 'p(95)').toFixed(2)}ms
   4. Authorize Code:
      p50: ${getMetric('authorize_code_latency', 'med').toFixed(2)}ms
      p95: ${getMetric('authorize_code_latency', 'p(95)').toFixed(2)}ms
   5. Token:
      p50: ${getMetric('token_latency', 'med').toFixed(2)}ms
      p95: ${getMetric('token_latency', 'p(95)').toFixed(2)}ms
   Full Flow:
      p50: ${getMetric('full_flow_latency', 'med').toFixed(2)}ms
      p95: ${getMetric('full_flow_latency', 'p(95)').toFixed(2)}ms
      p99: ${getMetric('full_flow_latency', 'p(99)').toFixed(2)}ms

 ✅ ステップ別成功率:
   Email Code認証: ${(getRate('email_code_success') * 100).toFixed(2)}%
   認可コード: ${(getRate('authorize_success') * 100).toFixed(2)}%
   トークン発行: ${(getRate('token_success') * 100).toFixed(2)}%

 ❌ エラー統計:
   OTP生成エラー: ${getCount('otp_generate_errors')}
   OTP検証エラー: ${getCount('otp_verify_errors')}
   セッションエラー: ${getCount('session_errors')}
   認可コードエラー: ${getCount('code_errors')}
   レート制限 (429): ${getCount('rate_limit_errors')}
   サーバーエラー (5xx): ${getCount('server_errors')}

 🚀 スループット: ${getMetric('iterations', 'rate').toFixed(2)} flows/s
 ======================================================================
`;

  console.log(summary);

  // 結果をファイルに出力
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonResult = {
    test_id: TEST_ID,
    test_name: TEST_NAME,
    preset: PRESET,
    description: selectedPreset.description,
    timestamp: new Date().toISOString(),
    target: BASE_URL,
    metrics: {
      iterations: getCount('iterations'),
      flow_success_rate: getRate('flow_success'),
      email_code_success_rate: getRate('email_code_success'),
      authorize_success_rate: getRate('authorize_success'),
      token_success_rate: getRate('token_success'),
      latency: {
        authorize_init: {
          p50: getMetric('authorize_init_latency', 'med'),
          p95: getMetric('authorize_init_latency', 'p(95)'),
          p99: getMetric('authorize_init_latency', 'p(99)'),
        },
        email_code_generate: {
          p50: getMetric('email_code_generate_latency', 'med'),
          p95: getMetric('email_code_generate_latency', 'p(95)'),
          p99: getMetric('email_code_generate_latency', 'p(99)'),
        },
        email_code_verify: {
          p50: getMetric('email_code_verify_latency', 'med'),
          p95: getMetric('email_code_verify_latency', 'p(95)'),
          p99: getMetric('email_code_verify_latency', 'p(99)'),
        },
        authorize_code: {
          p50: getMetric('authorize_code_latency', 'med'),
          p95: getMetric('authorize_code_latency', 'p(95)'),
          p99: getMetric('authorize_code_latency', 'p(99)'),
        },
        token: {
          p50: getMetric('token_latency', 'med'),
          p95: getMetric('token_latency', 'p(95)'),
          p99: getMetric('token_latency', 'p(99)'),
        },
        full_flow: {
          p50: getMetric('full_flow_latency', 'med'),
          p95: getMetric('full_flow_latency', 'p(95)'),
          p99: getMetric('full_flow_latency', 'p(99)'),
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

  return {
    'stdout': summary,
    [`results/${TEST_ID}-${timestamp}.json`]: JSON.stringify(jsonResult, null, 2),
  };
}
