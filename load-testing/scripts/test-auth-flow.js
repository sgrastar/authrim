/**
 * 認証フロー全体の負荷テスト（事前データ不要版）
 *
 * テストフロー:
 * 1. テストセッション作成 (POST /api/admin/test-sessions)
 * 2. 認可コード取得 (GET /authorize)
 * 3. トークン交換 (POST /token)
 *
 * メリット:
 * - 事前のシードデータ生成が不要
 * - K6 Cloudのサイズ制限を完全回避
 * - より本番に近い負荷パターン
 *
 * 使い方:
 * k6 run --env PRESET=rps10 scripts/test-auth-flow.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';
import { randomBytes, sha256 } from 'k6/crypto';

// テスト識別情報
const TEST_NAME = 'Auth Flow (session → authorize → token)';
const TEST_ID = 'auth-flow';

// カスタムメトリクス
const flowDuration = new Trend('auth_flow_duration');
const sessionDuration = new Trend('session_create_duration');
const authorizeDuration = new Trend('authorize_duration');
const tokenDuration = new Trend('token_duration');
const flowSuccess = new Rate('auth_flow_success');
const sessionErrors = new Counter('session_errors');
const authorizeErrors = new Counter('authorize_errors');
const tokenErrors = new Counter('token_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const ADMIN_API_SECRET = __ENV.ADMIN_API_SECRET || '';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://localhost:3000/callback';
const PRESET = __ENV.PRESET || 'rps10';
const USER_LIST_PATH = __ENV.USER_LIST_PATH || '../seeds/test_users.txt';
const USER_LIST_URL = __ENV.USER_LIST_URL || ''; // K6 Cloud用: R2からフェッチ

// プリセット設定
const PRESETS = {
  rps1: {
    description: '1 RPS - Minimal smoke test (20s)',
    stages: [
      { target: 1, duration: '5s' },
      { target: 1, duration: '15s' },
      { target: 0, duration: '5s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<2000', 'p(99)<5000'],
      http_req_failed: ['rate<0.10'],
      auth_flow_duration: ['p(99)<10000'],
    },
    preAllocatedVUs: 3,
    maxVUs: 5,
  },
  rps10: {
    description: '10 RPS - Quick smoke test (30s)',
    stages: [
      { target: 10, duration: '5s' },
      { target: 10, duration: '30s' },
      { target: 0, duration: '5s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1000', 'p(99)<2000'],
      http_req_failed: ['rate<0.05'],
      auth_flow_duration: ['p(99)<3000'],
    },
    preAllocatedVUs: 15,
    maxVUs: 20,
  },
  rps50: {
    description: '50 RPS - Light load (60s)',
    stages: [
      { target: 25, duration: '10s' },
      { target: 50, duration: '60s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<800', 'p(99)<1500'],
      http_req_failed: ['rate<0.03'],
      auth_flow_duration: ['p(99)<2500'],
    },
    preAllocatedVUs: 75,
    maxVUs: 100,
  },
  rps100: {
    description: '100 RPS - Medium load (90s)',
    stages: [
      { target: 50, duration: '15s' },
      { target: 100, duration: '90s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<700', 'p(99)<1200'],
      http_req_failed: ['rate<0.02'],
      auth_flow_duration: ['p(99)<2000'],
    },
    preAllocatedVUs: 150,
    maxVUs: 200,
  },
  rps150: {
    description: '150 RPS - Medium-high load (90s)',
    stages: [
      { target: 75, duration: '15s' },
      { target: 150, duration: '90s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<800', 'p(99)<1500'],
      http_req_failed: ['rate<0.03'],
      auth_flow_duration: ['p(99)<2500'],
    },
    preAllocatedVUs: 225,
    maxVUs: 300,
  },
  rps200: {
    description: '200 RPS - High load (90s)',
    stages: [
      { target: 100, duration: '15s' },
      { target: 200, duration: '90s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<700', 'p(99)<1300'],
      http_req_failed: ['rate<0.03'],
      auth_flow_duration: ['p(99)<2200'],
    },
    preAllocatedVUs: 300,
    maxVUs: 400,
  },
  rps300: {
    description: '300 RPS - High load (120s)',
    stages: [
      { target: 100, duration: '20s' },
      { target: 300, duration: '120s' },
      { target: 0, duration: '20s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<600', 'p(99)<1000'],
      http_req_failed: ['rate<0.02'],
      auth_flow_duration: ['p(99)<1800'],
    },
    preAllocatedVUs: 450,
    maxVUs: 600,
  },
  rps500: {
    description: '500 RPS - Very high load (120s)',
    stages: [
      { target: 200, duration: '30s' },
      { target: 500, duration: '120s' },
      { target: 0, duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<900'],
      http_req_failed: ['rate<0.02'],
      auth_flow_duration: ['p(99)<1500'],
    },
    preAllocatedVUs: 750,
    maxVUs: 1000,
  },
  rps1000: {
    description: '1000 RPS - Stress test (150s)',
    stages: [
      { target: 300, duration: '30s' },
      { target: 1000, duration: '150s' },
      { target: 0, duration: '30s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.03'],
      auth_flow_duration: ['p(99)<2000'],
    },
    preAllocatedVUs: 1500,
    maxVUs: 2000,
  },
};

const selectedPreset = PRESETS[PRESET] || PRESETS.rps10;

// K6 Options
export const options = {
  scenarios: {
    auth_flow: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: selectedPreset.stages,
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
    },
  },
  thresholds: selectedPreset.thresholds,
  tags: {
    test_id: TEST_ID,
    preset: PRESET,
  },
};

// Basic Auth ヘッダー
const basicAuthHeader = encoding.b64encode(`${CLIENT_ID}:${CLIENT_SECRET}`);
const adminAuthHeader = ADMIN_API_SECRET ? `Bearer ${ADMIN_API_SECRET}` : '';

// ユーザーリスト読み込み（ローカル実行時のみ）
// K6 Cloudではsetup()でR2からフェッチ
let userList = null;
let useRemoteUserList = false;

if (USER_LIST_URL) {
  useRemoteUserList = true;
  console.log(`🌐 Remote user list mode: Will fetch from ${USER_LIST_URL}`);
} else {
  try {
    userList = new SharedArray('users', function () {
      const content = open(USER_LIST_PATH);
      return content.trim().split('\n').filter(line => line.length > 0);
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
  // 標準base64でエンコード
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = encoding.b64encode(binary, 'std');
  // Base64URL変換: + → -, / → _, パディング削除
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * code_challengeを生成（S256方式）
 * SHA-256ハッシュをBase64URLエンコード
 */
function generateCodeChallenge(verifier) {
  // K6のsha256は 'base64rawurl' でパディングなしBase64URLを返す
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
 * オブジェクトをURLエンコードされたクエリ文字列に変換
 * (K6ではURLSearchParamsが使えないため)
 */
function toQueryString(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * ランダムなUUIDv4を生成
 */
function generateUUID() {
  const bytes = randomBytes(16);
  const arr = new Uint8Array(bytes);
  // Version 4
  arr[6] = (arr[6] & 0x0f) | 0x40;
  // Variant 1
  arr[8] = (arr[8] & 0x3f) | 0x80;

  const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function setup() {
  console.log(`🚀 ${TEST_NAME} 負荷テスト`);
  console.log(`📊 プリセット: ${PRESET}`);
  console.log(`📝 説明: ${selectedPreset.description}`);
  console.log(`🎯 ターゲット: ${BASE_URL}`);
  console.log(`🔑 クライアントID: ${CLIENT_ID}`);

  if (!adminAuthHeader) {
    console.warn('⚠️  ADMIN_API_SECRET が設定されていません。テストセッション作成に失敗します。');
  }

  // K6 Cloud用: R2からユーザーリストをフェッチ
  let users = [];
  if (useRemoteUserList && USER_LIST_URL) {
    console.log(`🌐 Fetching user list from R2: ${USER_LIST_URL}`);
    const response = http.get(USER_LIST_URL, {
      timeout: '120s',
      tags: { name: 'FetchUserList' },
    });
    if (response.status === 200) {
      users = response.body.trim().split('\n').filter(line => line.length > 0);
      console.log(`✅ Fetched ${users.length} users from R2`);
    } else {
      console.error(`❌ Failed to fetch user list: HTTP ${response.status}`);
    }
  }

  const userCount = useRemoteUserList ? users.length : (userList ? userList.length : 0);
  console.log(`📦 使用可能ユーザー数: ${userCount}`);

  return { users: users, userCount: userCount };
}

export default function (data) {
  const flowStart = Date.now();
  let flowSucceeded = false;

  // ユーザーリストからランダムにユーザーを選択
  // ローカル: SharedArrayから、K6 Cloud: setup()で取得した配列から
  let userId;
  if (useRemoteUserList && data.users && data.users.length > 0) {
    const index = Math.floor(Math.random() * data.users.length);
    userId = data.users[index];
  } else if (userList && userList.length > 0) {
    const index = Math.floor(Math.random() * userList.length);
    userId = userList[index];
  } else {
    // フォールバック: ランダムUUID（エラーになる可能性が高い）
    userId = generateUUID();
  }

  // Step 1: テストセッション作成
  const sessionStart = Date.now();
  const sessionPayload = JSON.stringify({
    user_id: userId,
    ttl_seconds: 300, // 5分（テスト用に短め）
  });

  const sessionRes = http.post(
    `${BASE_URL}/api/admin/test-sessions`,
    sessionPayload,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: adminAuthHeader,
      },
      tags: { name: 'CreateSession' },
    }
  );

  sessionDuration.add(Date.now() - sessionStart);

  const sessionOk = check(sessionRes, {
    'session: status is 200/201': (r) => r.status === 200 || r.status === 201,
    'session: has session_id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.session_id !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (!sessionOk) {
    sessionErrors.add(1);
    if (sessionRes.status === 429) {
      rateLimitErrors.add(1);
    } else if (sessionRes.status >= 500) {
      serverErrors.add(1);
    }
    flowSuccess.add(0);
    flowDuration.add(Date.now() - flowStart);
    return;
  }

  let sessionId;
  try {
    const sessionBody = JSON.parse(sessionRes.body);
    sessionId = sessionBody.session_id;
  } catch {
    sessionErrors.add(1);
    flowSuccess.add(0);
    flowDuration.add(Date.now() - flowStart);
    return;
  }

  // Step 2: 認可コード取得
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateRandomHex(12);
  const nonce = generateRandomHex(12);

  const authorizeParams = toQueryString({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email',
    state: state,
    nonce: nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authorizeStart = Date.now();
  const authorizeRes = http.get(
    `${BASE_URL}/authorize?${authorizeParams}`,
    {
      headers: {
        Cookie: `authrim_session=${sessionId}`,
      },
      redirects: 0, // リダイレクトを追跡しない
      tags: { name: 'Authorize' },
    }
  );

  authorizeDuration.add(Date.now() - authorizeStart);

  // リダイレクトレスポンスからcodeを抽出
  const location = authorizeRes.headers['Location'] || '';
  const codeMatch = location.match(/[?&]code=([^&]+)/);
  const code = codeMatch ? codeMatch[1] : null;

  const authorizeOk = check(authorizeRes, {
    'authorize: status is 302': (r) => r.status === 302,
    'authorize: has code in redirect': () => code !== null,
    'authorize: state matches': () => location.includes(`state=${state}`),
  });

  if (!authorizeOk) {
    authorizeErrors.add(1);
    if (authorizeRes.status === 429) {
      rateLimitErrors.add(1);
    } else if (authorizeRes.status >= 500) {
      serverErrors.add(1);
    }
    flowSuccess.add(0);
    flowDuration.add(Date.now() - flowStart);
    return;
  }

  // Step 3: トークン交換
  const tokenStart = Date.now();
  const tokenPayload = toQueryString({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const tokenRes = http.post(
    `${BASE_URL}/token`,
    tokenPayload,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuthHeader}`,
      },
      tags: { name: 'Token' },
    }
  );

  tokenDuration.add(Date.now() - tokenStart);

  const tokenOk = check(tokenRes, {
    'token: status is 200': (r) => r.status === 200,
    'token: has access_token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.access_token !== undefined;
      } catch {
        return false;
      }
    },
    'token: has id_token': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.id_token !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (!tokenOk) {
    tokenErrors.add(1);
    if (tokenRes.status === 429) {
      rateLimitErrors.add(1);
    } else if (tokenRes.status >= 500) {
      serverErrors.add(1);
    }
    // デバッグ: 最初の数件のエラー内容を出力
    if (exec.scenario.iterationInTest < 3) {
      console.log(`❌ Token error [iter ${exec.scenario.iterationInTest}]:`);
      console.log(`   Status: ${tokenRes.status}`);
      console.log(`   Body: ${tokenRes.body.substring(0, 300)}`);
      console.log(`   Code used: ${code ? code.substring(0, 20) + '...' : 'null'}`);
    }
    flowSuccess.add(0);
  } else {
    flowSucceeded = true;
    flowSuccess.add(1);
  }

  flowDuration.add(Date.now() - flowStart);
}

export function handleSummary(data) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // サマリー出力
  console.log('\n' + '='.repeat(60));
  console.log(`📊 ${TEST_NAME} テスト結果サマリー`);
  console.log('='.repeat(60));
  console.log(`プリセット: ${PRESET} (${selectedPreset.description})`);
  console.log(`ターゲット: ${BASE_URL}`);
  console.log('-'.repeat(60));

  // フロー全体のメトリクス
  if (data.metrics.auth_flow_duration) {
    const flowMetrics = data.metrics.auth_flow_duration;
    console.log('\n🔄 認証フロー全体:');
    console.log(`  平均: ${flowMetrics.values.avg?.toFixed(2) || 'N/A'}ms`);
    console.log(`  中央値: ${flowMetrics.values.med?.toFixed(2) || 'N/A'}ms`);
    console.log(`  p95: ${flowMetrics.values['p(95)']?.toFixed(2) || 'N/A'}ms`);
    console.log(`  p99: ${flowMetrics.values['p(99)']?.toFixed(2) || 'N/A'}ms`);
  }

  // 各ステップのメトリクス
  const steps = [
    { key: 'session_create_duration', name: 'セッション作成' },
    { key: 'authorize_duration', name: '認可コード取得' },
    { key: 'token_duration', name: 'トークン交換' },
  ];

  for (const step of steps) {
    if (data.metrics[step.key]) {
      const m = data.metrics[step.key];
      console.log(`\n📍 ${step.name}:`);
      console.log(`  平均: ${m.values.avg?.toFixed(2) || 'N/A'}ms`);
      console.log(`  p95: ${m.values['p(95)']?.toFixed(2) || 'N/A'}ms`);
    }
  }

  // エラー統計
  console.log('\n❌ エラー統計:');
  const errorKeys = ['session_errors', 'authorize_errors', 'token_errors', 'rate_limit_errors', 'server_errors'];
  for (const key of errorKeys) {
    if (data.metrics[key]) {
      console.log(`  ${key}: ${data.metrics[key].values.count || 0}`);
    }
  }

  // 成功率
  if (data.metrics.auth_flow_success) {
    const successRate = (data.metrics.auth_flow_success.values.rate * 100).toFixed(2);
    console.log(`\n✅ フロー成功率: ${successRate}%`);
  }

  console.log('\n' + '='.repeat(60));

  return {};
}
