/**
 * Mail OTP Full Login Benchmark Test
 *
 * Purpose:
 * - Reproduce Authrim's full login flow and measure load points
 * - Full flow: OTP auth → Session issuance → Authorization code → Token issuance
 * - Uses pre-seeded existing users (no D1 writes)
 *
 * Prerequisites:
 * - Create users in advance with seed-otp-users.js
 * - Specify the generated otp_user_list.txt in USER_LIST_PATH
 *
 * Test flow (5 steps):
 * 1. GET /authorize - Start authorization request (light load)
 * 2. POST /api/admin/test/email-codes - Generate OTP code (ChallengeStore DO write)
 * 3. POST /api/auth/email-codes/verify - Verify OTP + issue session (SessionStore DO write)
 * 4. GET /authorize (with Cookie) - Generate authorization code (AuthCodeStore DO write)
 * 5. POST /token - Issue token (RefreshTokenRotator write, JWT signing)
 *
 * Load points (no D1 writes - using existing users):
 * - ChallengeStore DO write (Step 2)
 * - ChallengeStore consume + SessionStore DO write (Step 3)
 * - AuthCodeStore DO write (Step 4)
 * - RefreshTokenRotator DO write + JWT signing (Step 5)
 *
 * Environment variables:
 *   BASE_URL          - Authrim URL (default: https://your-authrim.example.com)
 *   CLIENT_ID         - OAuth client ID (required)
 *   CLIENT_SECRET     - OAuth client secret (required)
 *   ADMIN_MACHINE_ACCESS_TOKEN  - Admin Machine Access token (required)
 *   PRESET            - Preset name (default: rps10)
 *   TENANT_ID         - Tenant ID for tenant-d1 admin test endpoints (optional)
 *   USER_LIST_PATH    - User list file path (default: ../seeds/otp_user_list.txt)
 *
 * Usage:
 * # Step 0: Seed users
 * BASE_URL=https://your-authrim.example.com \
 *   ADMIN_MACHINE_ACCESS_TOKEN=xxx \
 *   OTP_USER_COUNT=500 \
 *   node scripts/seed-otp-users.js
 *
 * # Step 1: Run benchmark
 * k6 run -e PRESET=rps30 \
 *   -e BASE_URL=https://your-authrim.example.com \
 *   -e CLIENT_ID=xxx \
 *   -e CLIENT_SECRET=yyy \
 *   -e ADMIN_MACHINE_ACCESS_TOKEN=zzz \
 *   -e USER_LIST_PATH=../seeds/otp_user_list.txt \
 *   scripts/test-mail-otp-full-login-benchmark.js
 */

import http from 'k6/http';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import { randomBytes, sha256 } from 'k6/crypto';

// Test identification
const TEST_NAME = __ENV.TEST_NAME || 'Mail OTP Full Login Benchmark';
const TEST_ID = __ENV.TEST_ID || 'mail-otp-full-login-benchmark';

// Custom metrics - step-by-step latency
const authorizeInitLatency = new Trend('authorize_init_latency');
const emailCodeGenerateLatency = new Trend('email_code_generate_latency');
const emailCodeVerifyLatency = new Trend('email_code_verify_latency');
const authorizeCodeLatency = new Trend('authorize_code_latency');
const tokenLatency = new Trend('token_latency');
const fullFlowLatency = new Trend('full_flow_latency');
const authorizeInitWaiting = new Trend('authorize_init_waiting');
const emailCodeGenerateWaiting = new Trend('email_code_generate_waiting');
const emailCodeVerifyWaiting = new Trend('email_code_verify_waiting');
const authorizeCodeWaiting = new Trend('authorize_code_waiting');
const tokenWaiting = new Trend('token_waiting');
const authorizeInitTransport = new Trend('authorize_init_transport');
const emailCodeGenerateTransport = new Trend('email_code_generate_transport');
const emailCodeVerifyTransport = new Trend('email_code_verify_transport');
const authorizeCodeTransport = new Trend('authorize_code_transport');
const tokenTransport = new Trend('token_transport');

// Success rates
const emailCodeSuccess = new Rate('email_code_success');
const authorizeSuccess = new Rate('authorize_success');
const tokenSuccess = new Rate('token_success');
const flowSuccess = new Rate('flow_success');

// Error counters
const otpGenerateErrors = new Counter('otp_generate_errors');
const otpVerifyErrors = new Counter('otp_verify_errors');
const sessionErrors = new Counter('session_errors');
const codeErrors = new Counter('code_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');
const timeoutErrors = new Counter('timeout_errors');
const d1OverloadedErrors = new Counter('d1_overloaded_errors');

// Environment variables
const BASE_URL = __ENV.BASE_URL || '';
const CLIENT_ID = __ENV.CLIENT_ID || '';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const ADMIN_MACHINE_ACCESS_TOKEN = __ENV.ADMIN_MACHINE_ACCESS_TOKEN || '';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://localhost:3000/callback';
const PRESET = __ENV.PRESET || 'rps10';
const USER_LIST_PATH = __ENV.USER_LIST_PATH || '../seeds/otp_user_list.txt';
const STORAGE_PROFILE = __ENV.STORAGE_PROFILE || 'unspecified';
const TRANSIENT_AUTH_MIRROR_MODE = __ENV.TRANSIENT_AUTH_MIRROR_MODE || 'unspecified';
const TENANT_ID = __ENV.TENANT_ID || '';
const PHASE0C_RESULT = __ENV.PHASE0C_RESULT || '';
const PHASE0C_RUN_ID = __ENV.PHASE0C_RUN_ID || '';

// Hostname extraction function
function extractHostname(url) {
  const match = url.match(/^https?:\/\/([^/:]+)/);
  return match ? match[1] : url;
}

function extractPublicErrorCode(body) {
  try {
    const parsed = JSON.parse(body);
    const candidate = parsed.error_code || parsed.code || parsed.error?.code || parsed.error;
    return typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate)
      ? candidate
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function extractOAuthRedirectError(location) {
  if (typeof location !== 'string') return 'unknown';
  const match = location.match(/[?&]error=([^&]+)/);
  if (!match) return 'unknown';
  try {
    const candidate = decodeURIComponent(match[1]);
    return /^[a-z0-9_.:-]{1,80}$/.test(candidate) ? candidate : 'unknown';
  } catch {
    return 'unknown';
  }
}

const ORIGIN = BASE_URL.replace(/^http:/, 'https:');

// Preset Configuration
const PRESETS = {
  'phase0c-smoke': {
    description: 'Phase 0c one-flow smoke check before sustained load',
    preAllocatedVUs: 1,
    maxVUs: 1,
    userCount: 1,
  },
  'phase0c-sample': {
    description: 'Phase 0c bounded warm-path sample - 1 LPS for 60s after 15s warm-up',
    preAllocatedVUs: 25,
    maxVUs: 40,
    userCount: 32,
  },
  'phase0c-pre-gate': {
    description: 'Phase 0c diagnostic pre-gate - 2 LPS for 60s after 15s warm-up',
    preAllocatedVUs: 30,
    maxVUs: 50,
    userCount: 32,
  },
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
const isPhase0cSmoke = PRESET === 'phase0c-smoke';
const isPhase0cSample = PRESET === 'phase0c-sample';
const isPhase0cPreGate = PRESET === 'phase0c-pre-gate';
const isPhase0cFamily = isPhase0cSmoke || isPhase0cSample || isPhase0cPreGate;
const boundedSampleRate = isPhase0cPreGate ? 2 : 1;
const boundedSampleMaximumIterations = isPhase0cPreGate ? 122 : 61;
const phase0cDiagnosticHeaders = isPhase0cSmoke
  ? { 'X-Diagnostic-Session-Id': PHASE0C_RUN_ID }
  : {};

// K6 options configuration
export const options = {
  scenarios: isPhase0cSample || isPhase0cPreGate
      ? {
          warmup: {
            executor: 'constant-arrival-rate',
            exec: 'phase0cWarmup',
            rate: 1,
            timeUnit: '1s',
            duration: '15s',
            preAllocatedVUs: selectedPreset.preAllocatedVUs,
            maxVUs: selectedPreset.maxVUs,
            gracefulStop: '5s',
            tags: { phase: 'warmup', test_id: TEST_ID },
          },
          mail_otp_full_login: {
            executor: 'constant-arrival-rate',
            rate: boundedSampleRate,
            timeUnit: '1s',
            duration: '60s',
            startTime: '20s',
            preAllocatedVUs: selectedPreset.preAllocatedVUs,
            maxVUs: selectedPreset.maxVUs,
            gracefulStop: '10s',
            tags: {
              phase: 'measurement',
              test_id: TEST_ID,
              storage_profile: STORAGE_PROFILE,
              transient_auth_mirror_mode: TRANSIENT_AUTH_MIRROR_MODE,
            },
          },
        }
      : isPhase0cSmoke
        ? {
            mail_otp_full_login: {
              executor: 'shared-iterations',
              iterations: 1,
              vus: 1,
              maxDuration: '90s',
              gracefulStop: '5s',
              tags: {
                phase: 'smoke',
                test_id: TEST_ID,
                storage_profile: STORAGE_PROFILE,
                transient_auth_mirror_mode: TRANSIENT_AUTH_MIRROR_MODE,
              },
            },
          }
        : {
            mail_otp_full_login: {
              executor: 'ramping-arrival-rate',
              startRate: 0,
              timeUnit: '1s',
              preAllocatedVUs: selectedPreset.preAllocatedVUs,
              maxVUs: selectedPreset.maxVUs,
              stages: selectedPreset.stages,
              tags: {
                test_id: TEST_ID,
                storage_profile: STORAGE_PROFILE,
                transient_auth_mirror_mode: TRANSIENT_AUTH_MIRROR_MODE,
              },
            },
          },
  thresholds: isPhase0cSample || isPhase0cPreGate
      ? {
          'full_flow_latency{scenario:mail_otp_full_login}': ['p(95)>=0'],
          'flow_success{scenario:mail_otp_full_login}': ['rate==1'],
          'rate_limit_errors{scenario:mail_otp_full_login}': ['count==0'],
          'server_errors{scenario:mail_otp_full_login}': ['count==0'],
          'timeout_errors{scenario:mail_otp_full_login}': ['count==0'],
          'd1_overloaded_errors{scenario:mail_otp_full_login}': ['count==0'],
          'dropped_iterations{scenario:mail_otp_full_login}': ['count==0'],
          'iterations{scenario:mail_otp_full_login}': [
            `count>=${boundedSampleRate * 60}`,
            `count<=${boundedSampleMaximumIterations}`,
          ],
        }
      : isPhase0cSmoke
        ? {
            'flow_success{scenario:mail_otp_full_login}': ['rate==1'],
            'server_errors{scenario:mail_otp_full_login}': ['count==0'],
            'timeout_errors{scenario:mail_otp_full_login}': ['count==0'],
            'd1_overloaded_errors{scenario:mail_otp_full_login}': ['count==0'],
            'dropped_iterations{scenario:mail_otp_full_login}': ['count==0'],
            'iterations{scenario:mail_otp_full_login}': ['count==1'],
          }
        : selectedPreset.thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)'],
};

// Load user list (optional)
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
  console.warn('   Will generate random email addresses');
}

/**
 * Generate random code_verifier (for PKCE)
 */
function generateCodeVerifier() {
  const buffer = randomBytes(32);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = encoding.b64encode(binary, 'std');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

/**
 * Generate code_challenge (S256 method)
 */
function generateCodeChallenge(verifier) {
  return sha256(verifier, 'base64rawurl');
}

/**
 * Generate random state/nonce
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
 * Generate random email address
 */
function generateRandomEmail() {
  return `otp-user-${generateRandomHex(8)}@test.authrim.internal`;
}

function recordInfrastructureFailure(response) {
  if (response.status === 0) {
    timeoutErrors.add(1);
  }
  const body = String(response.body || '').toLowerCase();
  if (
    body.includes('d1 overloaded') ||
    body.includes('d1_overloaded') ||
    (body.includes('d1_error') && body.includes('overload'))
  ) {
    d1OverloadedErrors.add(1);
  }
}

function recordStepTiming(response, durationMetric, waitingMetric, transportMetric) {
  const duration = response.timings.duration;
  const waiting = response.timings.waiting;
  durationMetric.add(duration);
  waitingMetric.add(waiting);
  transportMetric.add(Math.max(0, duration - waiting));
}

function recordPhase0cServerTiming(step, response) {
  if (!isPhase0cSmoke) return;
  const raw = response.headers['Server-Timing'] || response.headers['server-timing'];
  if (typeof raw !== 'string') {
    console.log(`Phase 0c timing ${step}: unavailable`);
    return;
  }
  const safeSpans = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^(?:auth|mg|token)_[a-z0-9_]{1,63};dur=\d+(?:\.\d+)?$/u.test(value))
    .slice(0, 32);
  console.log(
    `Phase 0c timing ${step}: ${safeSpans.length > 0 ? safeSpans.join(', ') : 'unavailable'}`
  );
}

// Setup
export function setup() {
  console.log('');
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔑 Client: ${CLIENT_ID}`);
  console.log(`🗄️  Storage profile: ${STORAGE_PROFILE}`);
  console.log(`🪞 Transient auth mirror mode: ${TRANSIENT_AUTH_MIRROR_MODE}`);
  console.log('');

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('CLIENT_ID and CLIENT_SECRET are required');
  }

  if (!ADMIN_MACHINE_ACCESS_TOKEN) {
    throw new Error('ADMIN_MACHINE_ACCESS_TOKEN is required for generating test email codes');
  }
  if (
    isPhase0cFamily &&
    (!/^phase0c-mail-[0-9]{14}-[a-f0-9]{6}$/u.test(PHASE0C_RUN_ID) ||
      !/^\/(?:private\/)?tmp\/[^\0]+\.json$/u.test(PHASE0C_RESULT))
  ) {
    throw new Error('Phase 0c requires a run ID and a temporary absolute PHASE0C_RESULT path');
  }

  // Prepare user list
  let users = [];
  if (isPhase0cFamily && (!userList || userList.length < selectedPreset.userCount)) {
    throw new Error(
      `Phase 0c requires at least ${selectedPreset.userCount} pre-seeded users in USER_LIST_PATH`
    );
  }
  if (userList && userList.length > 0) {
    // Get email addresses from user list
    for (let i = 0; i < Math.min(userList.length, selectedPreset.userCount); i++) {
      users.push({ email: userList[i] });
    }
    console.log(`📦 Using ${users.length} users from user list`);
  } else {
    // Generate random email addresses
    for (let i = 0; i < selectedPreset.userCount; i++) {
      users.push({ email: generateRandomEmail() });
    }
    console.log(`📦 Generated ${users.length} random email addresses`);
  }
  console.log('');

  // Warmup
  if (!isPhase0cSmoke) {
    console.log('🔥 Warming up...');
    for (let i = 0; i < Math.min(5, users.length); i++) {
      const user = users[i];
      // Warmup authorize endpoint
      http.get(`${BASE_URL}/authorize?response_type=code&client_id=${CLIENT_ID}&scope=openid`, {
        redirects: 0,
        tags: { name: 'Warmup' },
      });
      // Warmup email code generation
      http.post(`${BASE_URL}/api/admin/test/email-codes`, JSON.stringify({ email: user.email }), {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_MACHINE_ACCESS_TOKEN}`,
          ...(TENANT_ID ? { 'X-Tenant-Id': TENANT_ID } : {}),
        },
        tags: { name: 'Warmup' },
      });
    }
    console.log('   Warmup complete');
    console.log('');
  }

  return {
    users,
    userCount: users.length,
    preset: PRESET,
    storageProfile: STORAGE_PROFILE,
    transientAuthMirrorMode: TRANSIENT_AUTH_MIRROR_MODE,
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    adminMachineAccessToken: ADMIN_MACHINE_ACCESS_TOKEN,
  };
}

// Main test function
export default function runMailOtpFlow(data) {
  const {
    users,
    userCount,
    clientId,
    clientSecret,
    redirectUri,
    baseUrl,
    adminMachineAccessToken,
  } = data;

  // Select user based on VU ID
  const userIndex = (__VU - 1) % userCount;
  const user = users[userIndex];

  const flowStartTime = Date.now();
  let success = true;
  let sessionCookie = null;
  let authCode = null;

  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateRandomHex(16);
  const nonce = generateRandomHex(16);

  // ===============================
  // Step 1: GET /authorize (initialization)
  // ===============================
  const authorizeInitUrl =
    `${baseUrl}/authorize?` +
    'response_type=code&' +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    'scope=openid&' +
    `state=${state}&` +
    `nonce=${nonce}&` +
    `code_challenge=${codeChallenge}&` +
    'code_challenge_method=S256';

  const step1Response = http.get(authorizeInitUrl, {
    headers: {
      Accept: 'text/html',
      Connection: 'keep-alive',
      ...phase0cDiagnosticHeaders,
    },
    redirects: 0,
    tags: { name: 'AuthorizeInit' },
  });
  recordInfrastructureFailure(step1Response);
  recordStepTiming(
    step1Response,
    authorizeInitLatency,
    authorizeInitWaiting,
    authorizeInitTransport
  );
  recordPhase0cServerTiming('authorize_init', step1Response);

  if (step1Response.status !== 200 && step1Response.status !== 302) {
    success = false;
    if (step1Response.status >= 500) serverErrors.add(1);
    if (step1Response.status === 429) rateLimitErrors.add(1);
  }

  // ===============================
  // Step 2: POST /api/admin/test/email-codes (OTP code generation)
  // ===============================
  // Note: Specify create_user: false to generate OTP only for existing users
  // Users must be seeded in advance with seed-otp-users.js
  let otpCode = null;
  let otpSessionId = null;

  if (success) {
    const step2Response = http.post(
      `${baseUrl}/api/admin/test/email-codes`,
      JSON.stringify({ email: user.email, create_user: false }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminMachineAccessToken}`,
          ...(TENANT_ID ? { 'X-Tenant-Id': TENANT_ID } : {}),
          Connection: 'keep-alive',
          ...phase0cDiagnosticHeaders,
        },
        tags: { name: 'EmailCodeGenerate' },
      }
    );
    recordPhase0cServerTiming('email_code_generate', step2Response);
    recordInfrastructureFailure(step2Response);
    recordStepTiming(
      step2Response,
      emailCodeGenerateLatency,
      emailCodeGenerateWaiting,
      emailCodeGenerateTransport
    );

    if (step2Response.status !== 200 && step2Response.status !== 201) {
      success = false;
      otpGenerateErrors.add(1);
      if (isPhase0cSmoke) {
        console.error(
          `OTP generate diagnostic: status=${step2Response.status} code=${extractPublicErrorCode(step2Response.body)}`
        );
      }
      if (step2Response.status >= 500) serverErrors.add(1);
      if (step2Response.status === 429) rateLimitErrors.add(1);
      if (step2Response.status === 404) {
        console.error('❌ Pre-seeded benchmark user not found - run seed-otp-users.js first');
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
  // Step 3: POST /api/auth/email-codes/verify (OTP verification + session issuance)
  // ===============================
  if (success && otpCode && otpSessionId) {
    const step3Response = http.post(
      `${baseUrl}/api/auth/email-codes/verify`,
      JSON.stringify({ email: user.email, code: otpCode }),
      {
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: `authrim_otp_session=${otpSessionId}`,
          Connection: 'keep-alive',
          ...phase0cDiagnosticHeaders,
        },
        tags: { name: 'EmailCodeVerify' },
      }
    );
    recordPhase0cServerTiming('email_code_verify', step3Response);
    recordInfrastructureFailure(step3Response);
    recordStepTiming(
      step3Response,
      emailCodeVerifyLatency,
      emailCodeVerifyWaiting,
      emailCodeVerifyTransport
    );

    if (step3Response.status !== 200) {
      success = false;
      otpVerifyErrors.add(1);
      sessionErrors.add(1);
      if (PRESET === 'phase0c-smoke') {
        console.error(
          `OTP verify diagnostic: status=${step3Response.status} code=${extractPublicErrorCode(step3Response.body)}`
        );
      }
      if (step3Response.status >= 500) serverErrors.add(1);
      if (step3Response.status === 429) rateLimitErrors.add(1);
    } else {
      // Get sessionId from response JSON
      // Note: email-code/verify endpoint returns sessionId in response body
      // instead of Set-Cookie header
      try {
        const verifyData = JSON.parse(step3Response.body);
        if (verifyData.sessionId) {
          sessionCookie = verifyData.sessionId;
        }
      } catch (e) {
        // JSON parse failed
      }

      if (!sessionCookie) {
        success = false;
        sessionErrors.add(1);
        console.error('❌ No session ID returned from verify endpoint');
      }
    }
  }

  emailCodeSuccess.add(success);

  // ===============================
  // Step 4: GET /authorize (with Cookie - get authorization code)
  // ===============================
  if (success && sessionCookie) {
    const authorizeCodeUrl =
      `${baseUrl}/authorize?` +
      'response_type=code&' +
      `client_id=${encodeURIComponent(clientId)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      'scope=openid&' +
      `state=${state}&` +
      `nonce=${nonce}&` +
      `code_challenge=${codeChallenge}&` +
      'code_challenge_method=S256&' +
      'prompt=none';

    const step4Response = http.get(authorizeCodeUrl, {
      headers: {
        Accept: 'text/html',
        Cookie: `authrim_session=${sessionCookie}`,
        Connection: 'keep-alive',
        ...phase0cDiagnosticHeaders,
      },
      redirects: 0,
      tags: { name: 'AuthorizeCode' },
    });
    recordPhase0cServerTiming('authorize_code', step4Response);
    recordInfrastructureFailure(step4Response);
    recordStepTiming(
      step4Response,
      authorizeCodeLatency,
      authorizeCodeWaiting,
      authorizeCodeTransport
    );

    // Authorization code is returned in 302 redirect
    if (step4Response.status === 302) {
      const location = step4Response.headers['Location'] || step4Response.headers['location'];
      if (location) {
        const codeMatch = location.match(/[?&]code=([^&]+)/);
        if (codeMatch) {
          authCode = decodeURIComponent(codeMatch[1]);
        }
      }
    }

    if (!authCode) {
      success = false;
      codeErrors.add(1);
      if (PRESET === 'phase0c-smoke') {
        const location = step4Response.headers['Location'] || step4Response.headers['location'];
        console.error(
          `Authorize code diagnostic: status=${step4Response.status} oauth_error=${extractOAuthRedirectError(location)} body_code=${extractPublicErrorCode(step4Response.body)}`
        );
      }
      if (step4Response.status >= 500) serverErrors.add(1);
      if (step4Response.status === 429) rateLimitErrors.add(1);
    }
  }

  authorizeSuccess.add(success);

  // ===============================
  // Step 5: POST /token (token issuance)
  // ===============================
  if (success && authCode) {
    const credentials = encoding.b64encode(`${clientId}:${clientSecret}`, 'std');

    const step5Response = http.post(
      `${baseUrl}/token`,
      'grant_type=authorization_code' +
        `&code=${encodeURIComponent(authCode)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_verifier=${codeVerifier}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
          Connection: 'keep-alive',
          ...phase0cDiagnosticHeaders,
        },
        tags: { name: 'Token' },
      }
    );
    recordPhase0cServerTiming('token', step5Response);
    recordInfrastructureFailure(step5Response);
    recordStepTiming(step5Response, tokenLatency, tokenWaiting, tokenTransport);

    if (step5Response.status !== 200) {
      success = false;
      if (PRESET === 'phase0c-smoke') {
        console.error(
          `Token diagnostic: status=${step5Response.status} code=${extractPublicErrorCode(step5Response.body)}`
        );
      }
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

  // Flow complete
  const flowEndTime = Date.now();
  fullFlowLatency.add(flowEndTime - flowStartTime);
  flowSuccess.add(success);
}

export function phase0cWarmup(data) {
  return runMailOtpFlow(data);
}

// Teardown
export function teardown(data) {
  console.log('');
  console.log(`✅ ${TEST_NAME} Test completed`);
  console.log(`📊 Preset: ${data.preset}`);
  console.log(`🗄️  Storage profile: ${data.storageProfile}`);
  console.log(`🪞 Transient auth mirror mode: ${data.transientAuthMirrorMode}`);
  console.log(`🎯 Target: ${data.baseUrl}`);
  console.log(`📈 User count: ${data.userCount}`);
}

// Summary handler
export function handleSummary(data) {
  const metrics = data.metrics;

  // Metrics helper functions
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

  // Generate summary text
  const summary = `
 📊 ${TEST_NAME} - Summary
 ======================================================================

 🎯 Preset: ${PRESET}
 📝 Description: ${selectedPreset.description}
 🗄️  Storage profile: ${STORAGE_PROFILE}
 🪞 Transient auth mirror mode: ${TRANSIENT_AUTH_MIRROR_MODE}

 📈 Flow Statistics:
   Total iterations: ${getCount('iterations')}
   Flow success rate: ${(getRate('flow_success') * 100).toFixed(2)}%

 ⏱️  Step-by-step Latency:
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

 🔎 p95 Timing Breakdown (TTFB / transport):
   Authorize Init: ${getMetric('authorize_init_waiting', 'p(95)').toFixed(2)}ms / ${getMetric('authorize_init_transport', 'p(95)').toFixed(2)}ms
   Email Code Generate: ${getMetric('email_code_generate_waiting', 'p(95)').toFixed(2)}ms / ${getMetric('email_code_generate_transport', 'p(95)').toFixed(2)}ms
   Email Code Verify: ${getMetric('email_code_verify_waiting', 'p(95)').toFixed(2)}ms / ${getMetric('email_code_verify_transport', 'p(95)').toFixed(2)}ms
   Authorize Code: ${getMetric('authorize_code_waiting', 'p(95)').toFixed(2)}ms / ${getMetric('authorize_code_transport', 'p(95)').toFixed(2)}ms
   Token: ${getMetric('token_waiting', 'p(95)').toFixed(2)}ms / ${getMetric('token_transport', 'p(95)').toFixed(2)}ms

 ✅ Step-by-step Success Rate:
   Email code auth: ${(getRate('email_code_success') * 100).toFixed(2)}%
   Authorization code: ${(getRate('authorize_success') * 100).toFixed(2)}%
   Token issuance: ${(getRate('token_success') * 100).toFixed(2)}%

 ❌ Error Statistics:
   OTP generate errors: ${getCount('otp_generate_errors')}
   OTP verify errors: ${getCount('otp_verify_errors')}
   Session errors: ${getCount('session_errors')}
   Authorization code errors: ${getCount('code_errors')}
   Rate limit (429): ${getCount('rate_limit_errors')}
   Server errors (5xx): ${getCount('server_errors')}
   Timeouts: ${getCount('timeout_errors')}
   D1 overloaded: ${getCount('d1_overloaded_errors')}

 🚀 Throughput: ${getMetric('iterations', 'rate').toFixed(2)} flows/s
 ======================================================================
`;

  console.log(summary);

  // Output results to file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const measurementSuffix = '{scenario:mail_otp_full_login}';
  const measurementValues = (name) => metrics[`${name}${measurementSuffix}`]?.values || {};
  const timingBreakdown = (prefix) => ({
    waiting: {
      p50: getMetric(`${prefix}_waiting`, 'med'),
      p95: getMetric(`${prefix}_waiting`, 'p(95)'),
      p99: getMetric(`${prefix}_waiting`, 'p(99)'),
    },
    transport: {
      p50: getMetric(`${prefix}_transport`, 'med'),
      p95: getMetric(`${prefix}_transport`, 'p(95)'),
      p99: getMetric(`${prefix}_transport`, 'p(99)'),
    },
  });
  const phase0cSample = isPhase0cSample
    ? {
        warmup: { durationSeconds: 15, ratePerSecond: 1, excludedFromMeasurement: true },
        measurement: {
          durationSeconds: 60,
          ratePerSecond: 1,
          successCount: measurementValues('flow_success').passes || 0,
          failureCount: measurementValues('flow_success').fails || 0,
          droppedIterations: measurementValues('dropped_iterations').count || 0,
          p50Ms: measurementValues('full_flow_latency')['p(50)'] || 0,
          p95Ms: measurementValues('full_flow_latency')['p(95)'] || 0,
          p99Ms: measurementValues('full_flow_latency')['p(99)'] || 0,
        },
        errors: {
          rateLimited: measurementValues('rate_limit_errors').count || 0,
          routing5xx: measurementValues('server_errors').count || 0,
          timeouts: measurementValues('timeout_errors').count || 0,
          d1Overloaded: measurementValues('d1_overloaded_errors').count || 0,
        },
      }
    : undefined;
  const phase0cPreGate = isPhase0cPreGate
    ? {
        warmup: { durationSeconds: 15, ratePerSecond: 1, excludedFromMeasurement: true },
        measurement: {
          durationSeconds: 60,
          ratePerSecond: 2,
          successCount: measurementValues('flow_success').passes || 0,
          failureCount: measurementValues('flow_success').fails || 0,
          droppedIterations: measurementValues('dropped_iterations').count || 0,
          p50Ms: measurementValues('full_flow_latency')['p(50)'] || 0,
          p95Ms: measurementValues('full_flow_latency')['p(95)'] || 0,
          p99Ms: measurementValues('full_flow_latency')['p(99)'] || 0,
        },
        errors: {
          rateLimited: measurementValues('rate_limit_errors').count || 0,
          routing5xx: measurementValues('server_errors').count || 0,
          timeouts: measurementValues('timeout_errors').count || 0,
          d1Overloaded: measurementValues('d1_overloaded_errors').count || 0,
        },
      }
    : undefined;
  const jsonResult = {
    ...(isPhase0cFamily ? { runId: PHASE0C_RUN_ID, tenantId: TENANT_ID } : {}),
    test_id: TEST_ID,
    test_name: TEST_NAME,
    preset: PRESET,
    description: selectedPreset.description,
    storage_profile: STORAGE_PROFILE,
    transient_auth_mirror_mode: TRANSIENT_AUTH_MIRROR_MODE,
    timestamp: new Date().toISOString(),
    target: BASE_URL,
    ...(phase0cSample ? { phase0c_sample: phase0cSample } : {}),
    ...(phase0cPreGate ? { phase0c_pre_gate: phase0cPreGate } : {}),
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
      timing_breakdown: {
        authorize_init: timingBreakdown('authorize_init'),
        email_code_generate: timingBreakdown('email_code_generate'),
        email_code_verify: timingBreakdown('email_code_verify'),
        authorize_code: timingBreakdown('authorize_code'),
        token: timingBreakdown('token'),
      },
      errors: {
        otp_generate: getCount('otp_generate_errors'),
        otp_verify: getCount('otp_verify_errors'),
        session: getCount('session_errors'),
        code: getCount('code_errors'),
        rate_limit: getCount('rate_limit_errors'),
        server: getCount('server_errors'),
        timeout: getCount('timeout_errors'),
        d1_overloaded: getCount('d1_overloaded_errors'),
      },
      throughput: getMetric('iterations', 'rate'),
    },
  };

  return {
    stdout: summary,
    [isPhase0cFamily ? PHASE0C_RESULT : `results/${TEST_ID}-${timestamp}.json`]: JSON.stringify(
      jsonResult,
      null,
      2
    ),
  };
}
