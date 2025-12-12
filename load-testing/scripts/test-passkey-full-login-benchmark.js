/**
 * Passkey フルログイン ベンチマークテスト
 *
 * ⚠️ 重要: このスクリプトは現在動作しません
 *
 * 【問題点】
 * k6はECDSA P-256署名（crypto.subtle.sign）をサポートしていないため、
 * WebAuthn認証のStep 4（/api/auth/passkey/login/verify）でサーバー側の
 * 署名検証が必ず失敗します。
 *
 * 【技術的制限】
 * - k6/crypto: sha256, hmac, randomBytesのみサポート
 * - k6/experimental/webcrypto: 廃止済み（k6 v0.50で卒業）
 * - crypto.subtle.sign: k6では利用不可
 *
 * 【代替案】
 * 1. サーバー側にテストモード追加（署名検証スキップフラグ）
 * 2. Node.jsで署名生成するハイブリッド方式（k6 + 外部プロセス）
 * 3. Playwright等のブラウザ自動化ツールでE2Eテスト
 * 4. Mail OTPベンチマーク（test-mail-otp-full-login-benchmark.js）を使用
 *
 * 【テスト結果（2024-12-12）】
 * - 300イテレーション実行
 * - Step 1-3: 正常動作（Authorize Init p95=64ms, Passkey Options p95=73ms）
 * - Step 4: 全件セッションエラー（署名検証失敗）
 *
 * ---
 *
 * 目的:
 * - Authrim の最も重いログインフローを再現し、負荷ポイントを測定
 * - Passkey認証 → セッション発行 → 認可コード発行 → トークン発行の全フロー
 *
 * テストフロー（6ステップ）:
 * 1. GET /authorize - 認可リクエスト開始
 * 2. POST /api/auth/passkey/login/options - WebAuthnチャレンジ取得
 * 3. k6内部 - ECDSA P-256署名生成
 * 4. POST /api/auth/passkey/login/verify - WebAuthn検証 + セッション発行
 * 5. GET /authorize (Cookie付き) - 認可コード生成
 * 6. POST /token - トークン発行
 *
 * 負荷ポイント:
 * - ChallengeStore DO write (Step 2)
 * - WebAuthn signature verify + SessionStore DO write (Step 4)
 * - AuthCodeStore DO write (Step 5)
 * - RefreshTokenRotator DO write + JWT署名 (Step 6)
 *
 * 使い方:
 * k6 run --env PRESET=rps30 scripts/test-passkey-full-login-benchmark.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import { randomBytes, sha256 } from 'k6/crypto';
import exec from 'k6/execution';

// テスト識別情報
const TEST_NAME = 'Passkey Full Login Benchmark';
const TEST_ID = 'passkey-full-login-benchmark';

// カスタムメトリクス - ステップ別レイテンシ
const authorizeInitLatency = new Trend('authorize_init_latency');
const passkeyOptionsLatency = new Trend('passkey_options_latency');
const passkeyVerifyLatency = new Trend('passkey_verify_latency');
const authorizeCodeLatency = new Trend('authorize_code_latency');
const tokenLatency = new Trend('token_latency');
const fullFlowLatency = new Trend('full_flow_latency');

// 成功率
const passkeySuccess = new Rate('passkey_success');
const authorizeSuccess = new Rate('authorize_success');
const tokenSuccess = new Rate('token_success');
const flowSuccess = new Rate('flow_success');

// エラーカウント
const signatureErrors = new Counter('signature_errors');
const challengeErrors = new Counter('challenge_errors');
const sessionErrors = new Counter('session_errors');
const codeErrors = new Counter('code_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// 環境変数
const BASE_URL = __ENV.BASE_URL || 'https://conformance.authrim.com';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://localhost:3000/callback';
const PRESET = __ENV.PRESET || 'rps30';
const PASSKEY_USERS_PATH = __ENV.PASSKEY_USERS_PATH || '../seeds/passkey_users.json';
const PASSKEY_USERS_URL = __ENV.PASSKEY_USERS_URL || '';

// RP ID（署名検証で使用）
// k6 doesn't have URL constructor, so extract hostname manually
function extractHostname(url) {
  const match = url.match(/^https?:\/\/([^/:]+)/);
  return match ? match[1] : url;
}
const RP_ID = extractHostname(BASE_URL);
const ORIGIN = BASE_URL.replace(/^http:/, 'https:');

/**
 * プリセット設定
 *
 * フルログインフローは重いため、silent authより低いRPSを設定
 */
const PRESETS = {
  // スモークテスト
  rps10: {
    description: '10 RPS - Smoke test (30s)',
    stages: [
      { target: 5, duration: '10s' },
      { target: 10, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<6000', 'p(99)<8000'],
      flow_success: ['rate>0.85'],
    },
    preAllocatedVUs: 30,
    maxVUs: 50,
    passkeyUserCount: 100,
  },

  // 標準ベンチマーク
  rps30: {
    description: '30 RPS - Standard benchmark (2 min)',
    stages: [
      { target: 15, duration: '15s' },
      { target: 30, duration: '120s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000', 'p(99)<7000'],
      flow_success: ['rate>0.90'],
    },
    preAllocatedVUs: 80,
    maxVUs: 120,
    passkeyUserCount: 200,
  },

  // 高スループット
  rps50: {
    description: '50 RPS - High throughput (3 min)',
    stages: [
      { target: 25, duration: '15s' },
      { target: 50, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000', 'p(99)<7000'],
      flow_success: ['rate>0.90'],
    },
    preAllocatedVUs: 150,
    maxVUs: 200,
    passkeyUserCount: 300,
  },

  // ストレステスト
  rps100: {
    description: '100 RPS - Stress test (3 min)',
    stages: [
      { target: 50, duration: '15s' },
      { target: 100, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<6000', 'p(99)<8000'],
      flow_success: ['rate>0.85'],
    },
    preAllocatedVUs: 300,
    maxVUs: 400,
    passkeyUserCount: 500,
  },

  // 限界テスト
  rps200: {
    description: '200 RPS - Maximum capacity (3 min)',
    stages: [
      { target: 100, duration: '15s' },
      { target: 200, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<8000', 'p(99)<10000'],
      flow_success: ['rate>0.80'],
    },
    preAllocatedVUs: 500,
    maxVUs: 700,
    passkeyUserCount: 500,
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
    passkey_full_login: {
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
  setupTimeout: '180s',
};

// Passkeyユーザー読み込み
let passkeyUsers = null;
let useRemoteUsers = false;

if (PASSKEY_USERS_URL) {
  useRemoteUsers = true;
  console.log(`🌐 Remote passkey users mode: Will fetch from ${PASSKEY_USERS_URL}`);
} else {
  try {
    passkeyUsers = new SharedArray('passkey_users', function () {
      const content = open(PASSKEY_USERS_PATH);
      const data = JSON.parse(content);
      return data.users;
    });
    console.log(`📂 Loaded ${passkeyUsers.length} passkey users from ${PASSKEY_USERS_PATH}`);
  } catch (e) {
    console.warn(`⚠️  Could not load passkey users: ${e.message}`);
  }
}

// ============================================================================
// k6互換ユーティリティ関数（TextEncoder/URLなしで動作）
// ============================================================================

/**
 * 文字列をUTF-8バイト配列に変換（k6向け、TextEncoderの代替）
 */
function stringToBytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Base64URL エンコード（パディングなし）
 */
function base64UrlEncode(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = encoding.b64encode(binary, 'std');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * ランダムなcode_verifierを生成（PKCE用）
 * RFC 7636準拠
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
 * k6のsha256を使用
 */
function generateCodeChallenge(verifier) {
  return sha256(verifier, 'base64rawurl');
}

/**
 * ランダムなstate/nonceを生成
 */
function generateRandomHex(numBytes) {
  const buffer = randomBytes(numBytes);
  const arr = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * SHA-256ハッシュを計算（k6 crypto使用）
 * 戻り値: Uint8Array (32 bytes)
 */
function sha256Bytes(data) {
  // k6のsha256は文字列を受け取り、hexを返す
  const hex = sha256(data, 'hex');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * WebAuthn assertion を生成（認証用）
 *
 * 注意: k6ではcrypto.subtleが制限されているため、署名生成はできません。
 * 代わりに、事前にNode.jsで生成した署名データを使用するか、
 * サーバー側でテスト用の署名検証スキップを実装する必要があります。
 *
 * この実装では、正しいフォーマットのassertionを生成しますが、
 * 署名は無効（ダミー）です。テスト環境では署名検証をスキップするか、
 * 別の方法で対応してください。
 */
function generateWebAuthnAssertion(credentialId, privateKeyJwk, challenge, rpId, counter) {
  // 1. Build clientDataJSON
  const clientData = {
    type: 'webauthn.get',
    challenge: challenge,
    origin: ORIGIN,
    crossOrigin: false,
  };
  const clientDataJSON = JSON.stringify(clientData);
  const clientDataBytes = stringToBytes(clientDataJSON);

  // 2. Build authenticatorData
  // rpIdHash (32 bytes) - SHA-256 of rpId
  const rpIdBytes = stringToBytes(rpId);
  let rpIdBinary = '';
  for (let i = 0; i < rpIdBytes.length; i++) {
    rpIdBinary += String.fromCharCode(rpIdBytes[i]);
  }
  const rpIdHash = sha256Bytes(rpIdBinary);

  // flags (1 byte): UP=1, UV=1
  const flags = 0x05;

  // signCount (4 bytes, big-endian)
  const newCounter = counter + 1;
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, newCounter, false);

  // Concatenate authenticatorData (37 bytes)
  const authenticatorData = new Uint8Array(37);
  authenticatorData.set(rpIdHash, 0);
  authenticatorData[32] = flags;
  authenticatorData.set(counterBytes, 33);

  // 3. 署名生成
  // k6ではECDSA署名をネイティブに生成できないため、
  // 事前に計算された署名を使用するか、テスト環境で署名検証をスキップする必要があります。
  //
  // ここではダミー署名を生成します。
  // 本番テストでは以下のいずれかの対応が必要:
  // a) Node.jsで事前に署名を生成してシードファイルに含める
  // b) サーバー側でテストモード時に署名検証をスキップ
  // c) k6のxk6-crypto拡張を使用

  // 署名対象データ: authenticatorData || SHA-256(clientDataJSON)
  let clientDataBinary = '';
  for (let i = 0; i < clientDataBytes.length; i++) {
    clientDataBinary += String.fromCharCode(clientDataBytes[i]);
  }
  const clientDataHash = sha256Bytes(clientDataBinary);

  // ダミー署名（64 bytes for P-256 raw signature）
  // 実際のテストでは、事前計算された署名を使用してください
  const dummySignature = new Uint8Array(64);
  const sigBuffer = randomBytes(64);
  const sigBytes = new Uint8Array(sigBuffer);
  for (let i = 0; i < 64; i++) {
    dummySignature[i] = sigBytes[i];
  }

  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: base64UrlEncode(clientDataBytes),
      authenticatorData: base64UrlEncode(authenticatorData),
      signature: base64UrlEncode(dummySignature),
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };
}

// セットアップ
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔑 Client: ${CLIENT_ID}`);
  console.log(`🌐 RP ID: ${RP_ID}`);
  console.log(``);

  if (!CLIENT_SECRET) {
    throw new Error('CLIENT_SECRET is required for token endpoint');
  }

  // Passkeyユーザー取得
  let users = [];
  if (useRemoteUsers && PASSKEY_USERS_URL) {
    console.log(`🌐 Fetching passkey users from: ${PASSKEY_USERS_URL}`);
    const response = http.get(PASSKEY_USERS_URL, {
      timeout: '120s',
      tags: { name: 'FetchPasskeyUsers' },
    });
    if (response.status !== 200) {
      throw new Error(`Failed to fetch passkey users: ${response.status}`);
    }
    const data = JSON.parse(response.body);
    users = data.users;
    console.log(`   Loaded ${users.length} passkey users from remote`);
  } else if (passkeyUsers) {
    // SharedArray はそのまま setup() から返せないため、配列にコピーする
    // k6の SharedArray は特殊オブジェクトで、VU間で共有されるがシリアライズ不可
    for (let i = 0; i < passkeyUsers.length; i++) {
      users.push(passkeyUsers[i]);
    }
  }

  if (users.length === 0) {
    throw new Error(
      'No passkey users available. Run: node scripts/seed-passkey-users.js to generate test users'
    );
  }

  console.log(`📦 Loaded ${users.length} passkey users`);
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
    // Passkey options ウォームアップ
    http.post(`${BASE_URL}/api/auth/passkey/login/options`, JSON.stringify({ email: user.email }), {
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      tags: { name: 'Warmup' },
    });
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    users,
    userCount: users.length,
    preset: PRESET,
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
  };
}

// メインテスト関数
export default function (data) {
  const { users, userCount, clientId, redirectUri, baseUrl } = data;

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

  // Step 1は通常ログイン画面へリダイレクト（302）またはHTML返却（200）
  if (step1Response.status !== 200 && step1Response.status !== 302) {
    success = false;
    if (step1Response.status >= 500) serverErrors.add(1);
    if (step1Response.status === 429) rateLimitErrors.add(1);
  }

  // ===============================
  // Step 2: POST /api/auth/passkey/login/options
  // ===============================
  if (success) {
    const step2Response = http.post(
      `${baseUrl}/api/auth/passkey/login/options`,
      JSON.stringify({ email: user.email }),
      {
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Connection: 'keep-alive',
        },
        tags: { name: 'PasskeyOptions' },
      }
    );
    passkeyOptionsLatency.add(step2Response.timings.duration);

    if (step2Response.status !== 200) {
      success = false;
      challengeErrors.add(1);
      if (step2Response.status >= 500) serverErrors.add(1);
      if (step2Response.status === 429) rateLimitErrors.add(1);
    } else {
      try {
        const optionsData = JSON.parse(step2Response.body);
        const challenge = optionsData.options.challenge;
        const challengeId = optionsData.challengeId;

        // ===============================
        // Step 3: k6内部で WebAuthn assertion 構築
        // ===============================
        let credential;
        try {
          credential = generateWebAuthnAssertion(
            user.credentialId,
            user.privateKeyJwk,
            challenge,
            RP_ID,
            user.counter
          );
        } catch (e) {
          success = false;
          signatureErrors.add(1);
          console.error(`❌ Assertion generation failed (VU ${__VU}): ${e.message}`);
        }

        // ===============================
        // Step 4: POST /api/auth/passkey/login/verify
        // ===============================
        if (success && credential) {
          const step4Response = http.post(
            `${baseUrl}/api/auth/passkey/login/verify`,
            JSON.stringify({ challengeId, credential }),
            {
              headers: {
                'Content-Type': 'application/json',
                Origin: ORIGIN,
                Connection: 'keep-alive',
              },
              tags: { name: 'PasskeyVerify' },
            }
          );
          passkeyVerifyLatency.add(step4Response.timings.duration);

          const step4Success = check(step4Response, {
            'passkey verify status 200': (r) => r.status === 200,
          });
          passkeySuccess.add(step4Success);

          if (!step4Success) {
            success = false;
            sessionErrors.add(1);
            if (step4Response.status >= 500) serverErrors.add(1);
            if (step4Response.status === 429) rateLimitErrors.add(1);

            // デバッグ情報
            if (exec.vu.iterationInInstance < 3) {
              console.error(
                `❌ Passkey verify failed (VU ${__VU}): ${step4Response.status} - ${step4Response.body}`
              );
            }
          } else {
            try {
              const verifyData = JSON.parse(step4Response.body);
              sessionCookie = `authrim_session=${verifyData.sessionId}`;
            } catch (e) {
              success = false;
              console.error(`❌ Failed to parse verify response (VU ${__VU})`);
            }
          }
        }
      } catch (e) {
        success = false;
        console.error(`❌ Failed to parse options response (VU ${__VU}): ${e.message}`);
      }
    }
  }

  // ===============================
  // Step 5: GET /authorize (認可コード発行)
  // ===============================
  if (success && sessionCookie) {
    const step5Response = http.get(authorizeInitUrl, {
      headers: {
        Cookie: sessionCookie,
        Accept: 'text/html',
        Connection: 'keep-alive',
      },
      redirects: 0,
      tags: { name: 'AuthorizeCode' },
    });
    authorizeCodeLatency.add(step5Response.timings.duration);

    const location = step5Response.headers.Location || step5Response.headers.location || '';
    const hasCode = location.includes('code=');

    const step5Success = check(step5Response, {
      'authorize status 302': (r) => r.status === 302,
      'has authorization code': () => hasCode,
    });
    authorizeSuccess.add(step5Success);

    if (!step5Success) {
      success = false;
      codeErrors.add(1);
      if (step5Response.status >= 500) serverErrors.add(1);
      if (step5Response.status === 429) rateLimitErrors.add(1);
    } else {
      // Extract authorization code from Location header
      const codeMatch = location.match(/code=([^&]+)/);
      if (codeMatch) {
        authCode = decodeURIComponent(codeMatch[1]);
      } else {
        success = false;
        codeErrors.add(1);
      }
    }
  }

  // ===============================
  // Step 6: POST /token
  // ===============================
  if (success && authCode) {
    const tokenPayload =
      `grant_type=authorization_code&` +
      `code=${encodeURIComponent(authCode)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `code_verifier=${codeVerifier}`;

    const basicAuth = encoding.b64encode(`${clientId}:${CLIENT_SECRET}`, 'std');

    const step6Response = http.post(`${baseUrl}/token`, tokenPayload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
        Connection: 'keep-alive',
      },
      tags: { name: 'Token' },
    });
    tokenLatency.add(step6Response.timings.duration);

    const step6Success = check(step6Response, {
      'token status 200': (r) => r.status === 200,
      'has access_token': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.access_token !== undefined;
        } catch {
          return false;
        }
      },
    });
    tokenSuccess.add(step6Success);

    if (!step6Success) {
      success = false;
      if (step6Response.status >= 500) serverErrors.add(1);
      if (step6Response.status === 429) rateLimitErrors.add(1);
    }
  }

  // フロー全体のメトリクス記録
  const flowDuration = Date.now() - flowStartTime;
  fullFlowLatency.add(flowDuration);
  flowSuccess.add(success);

  // デバッグ（最初の数回の失敗のみ）
  if (!success && exec.vu.iterationInInstance < 3) {
    console.error(`❌ Flow failed (VU ${__VU}, iter ${exec.vu.iterationInInstance})`);
  }
}

// ティアダウン
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
  const totalIterations = metrics.iterations?.values?.count || 0;
  const flowSuccessRate = ((metrics.flow_success?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}📈 フロー統計:\n`;
  summary += `${indent}  総イテレーション数: ${totalIterations}\n`;
  summary += `${indent}  フロー成功率: ${flowSuccessRate}%\n\n`;

  // ステップ別レイテンシ
  summary += `${indent}⏱️  ステップ別レイテンシ:\n`;
  summary += `${indent}  1. Authorize Init:\n`;
  summary += `${indent}     p50: ${metrics.authorize_init_latency?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}     p95: ${metrics.authorize_init_latency?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  2. Passkey Options:\n`;
  summary += `${indent}     p50: ${metrics.passkey_options_latency?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}     p95: ${metrics.passkey_options_latency?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  3. Passkey Verify:\n`;
  summary += `${indent}     p50: ${metrics.passkey_verify_latency?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}     p95: ${metrics.passkey_verify_latency?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  4. Authorize Code:\n`;
  summary += `${indent}     p50: ${metrics.authorize_code_latency?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}     p95: ${metrics.authorize_code_latency?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  5. Token:\n`;
  summary += `${indent}     p50: ${metrics.token_latency?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}     p95: ${metrics.token_latency?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  Full Flow:\n`;
  summary += `${indent}     p50: ${metrics.full_flow_latency?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}     p95: ${metrics.full_flow_latency?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}     p99: ${metrics.full_flow_latency?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  // 成功率
  const passkeyRate = ((metrics.passkey_success?.values?.rate || 0) * 100).toFixed(2);
  const authorizeRate = ((metrics.authorize_success?.values?.rate || 0) * 100).toFixed(2);
  const tokenRate = ((metrics.token_success?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}✅ ステップ別成功率:\n`;
  summary += `${indent}  Passkey認証: ${passkeyRate}%\n`;
  summary += `${indent}  認可コード: ${authorizeRate}%\n`;
  summary += `${indent}  トークン発行: ${tokenRate}%\n\n`;

  // エラー統計
  summary += `${indent}❌ エラー統計:\n`;
  summary += `${indent}  署名エラー: ${metrics.signature_errors?.values?.count || 0}\n`;
  summary += `${indent}  チャレンジエラー: ${metrics.challenge_errors?.values?.count || 0}\n`;
  summary += `${indent}  セッションエラー: ${metrics.session_errors?.values?.count || 0}\n`;
  summary += `${indent}  認可コードエラー: ${metrics.code_errors?.values?.count || 0}\n`;
  summary += `${indent}  レート制限 (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  サーバーエラー (5xx): ${metrics.server_errors?.values?.count || 0}\n\n`;

  // スループット
  const rps = metrics.iterations?.values?.rate || 0;
  summary += `${indent}🚀 スループット: ${rps.toFixed(2)} flows/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
