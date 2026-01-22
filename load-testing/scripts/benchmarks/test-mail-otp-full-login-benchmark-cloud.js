/**
 * Mail OTP Full Login Benchmark Test - K6 Cloud Edition
 *
 * Purpose:
 * - Reproduce Authrim's full login flow and measure load points
 * - Complete flow: OTP auth → Session issuance → Auth code → Token issuance
 * - Use pre-seeded existing users (no D1 writes)
 * - **Execute distributed load testing via K6 Cloud**
 *
 * Prerequisites:
 * - Pre-create users using seed-otp-users.js
 * - Upload the generated otp_user_list.txt to R2/S3
 * - Make it accessible via USER_LIST_URL
 *
 * Test Flow (5 Steps):
 * 1. GET /authorize - Start authorization request (redirect to login page)
 * 2. POST /api/admin/test/email-codes - Generate OTP code (test API, no email sent)
 * 3. POST /api/auth/email-code/verify - Verify OTP + Issue session (Set-Cookie)
 * 4. GET /authorize (with Cookie, prompt=none) - Generate auth code (302 redirect)
 * 5. POST /token - Issue tokens (JWT signing)
 *
 * Load Points:
 * - ChallengeStore DO write (Step 2)
 * - ChallengeStore consume + SessionStore DO write (Step 3)
 * - AuthCodeStore DO write (Step 4)
 * - RefreshTokenRotator DO write + JWT signing (Step 5)
 *
 * K6 Cloud Execution:
 * 1. Set K6_CLOUD_TOKEN environment variable
 * 2. Upload user list to R2/S3
 * 3. k6 cloud --env PRESET=rps500 \
 *      --env USER_LIST_URL=https://your-bucket/otp_user_list.txt \
 *      scripts/test-mail-otp-full-login-benchmark-cloud.js
 *
 * Local Execution (for debugging):
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

// Test identification
const TEST_NAME = 'Mail OTP Full Login Benchmark [Cloud]';
const TEST_ID = 'mail-otp-full-login-benchmark-cloud';

// Custom metrics - Per-step latency
const authorizeInitLatency = new Trend('authorize_init_latency');
const emailCodeGenerateLatency = new Trend('email_code_generate_latency');
const emailCodeVerifyLatency = new Trend('email_code_verify_latency');
const authorizeCodeLatency = new Trend('authorize_code_latency');
const tokenLatency = new Trend('token_latency');
const fullFlowLatency = new Trend('full_flow_latency');

// Success rates
const emailCodeSuccess = new Rate('email_code_success');
const authorizeSuccess = new Rate('authorize_success');
const tokenSuccess = new Rate('token_success');
const flowSuccess = new Rate('flow_success');

// Error counts
const otpGenerateErrors = new Counter('otp_generate_errors');
const otpVerifyErrors = new Counter('otp_verify_errors');
const sessionErrors = new Counter('session_errors');
const codeErrors = new Counter('code_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// Environment variables
const BASE_URL = __ENV.BASE_URL || '';
const CLIENT_ID = __ENV.CLIENT_ID || '';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const ADMIN_API_SECRET = __ENV.ADMIN_API_SECRET || '';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://localhost:3000/callback';
const PRESET = __ENV.PRESET || 'rps100';
const USER_LIST_PATH = __ENV.USER_LIST_PATH || '../seeds/otp_user_list.txt';
// K6 Cloud: URL to fetch user list from R2
const USER_LIST_URL = __ENV.USER_LIST_URL || '';

// K6 Cloud Project ID (can be overridden via environment variable)
const K6_CLOUD_PROJECT_ID = __ENV.K6_CLOUD_PROJECT_ID || '';

// Hostname extraction helper function
function extractHostname(url) {
  const match = url.match(/^https?:\/\/([^/:]+)/);
  return match ? match[1] : url;
}

const ORIGIN = BASE_URL.replace(/^http:/, 'https:');

/**
 * Preset Design - K6 Cloud Optimized Version
 *
 * Full login flow has 5 steps, so lower RPS target than silent auth
 * - Each step involves DO write (ChallengeStore, SessionStore, AuthCodeStore, RefreshTokenRotator)
 * - 5 HTTP requests per flow = 5x server load
 *
 * Targets:
 * - Success rate: > 95%
 * - Full Flow p95: < 5000ms
 * - 5xx: < 1%
 */
/**
 * Preset Design - For ramping-arrival-rate executor
 *
 * stages.target = iterations per second (RPS)
 * preAllocatedVUs/maxVUs = VUs required for concurrent execution
 *   Calculation: maxVUs ≈ targetRPS × avg response time(sec) × 1.5(buffer)
 *   Full login takes ~2-3 seconds for 5 steps, so 100 RPS → 300-450 VUs needed
 */
const PRESETS = {
  // Benchmark: 50 RPS (3 min)
  rps50: {
    description: '50 RPS - Cloud baseline (3 min)',
    stages: [
      { target: 25, duration: '15s' },
      { target: 50, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.90'],
    },
    preAllocatedVUs: 200,
    maxVUs: 400,
    userCount: 500,
  },

  // Benchmark: 100 RPS (3 min)
  rps100: {
    description: '100 RPS - Cloud baseline (3 min)',
    stages: [
      { target: 50, duration: '15s' },
      { target: 100, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 400,
    maxVUs: 600,
    userCount: 1000,
  },

  // Benchmark: 125 RPS (3 min)
  rps125: {
    description: '125 RPS - Cloud intermediate (3 min)',
    stages: [
      { target: 62, duration: '15s' },
      { target: 125, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 500,
    maxVUs: 800,
    userCount: 1250,
  },

  // Benchmark: 150 RPS (3 min)
  rps150: {
    description: '150 RPS - Cloud intermediate (3 min)',
    stages: [
      { target: 75, duration: '15s' },
      { target: 150, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      full_flow_latency: ['p(95)<5000'],
      flow_success: ['rate>0.95'],
    },
    preAllocatedVUs: 600,
    maxVUs: 1000,
    userCount: 1500,
  },

  // Benchmark: 200 RPS (3 min)
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

  // Benchmark: 300 RPS (3 min)
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

  // Benchmark: 500 RPS (3 min) - High load test
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

  // Benchmark: 750 RPS (3 min) - Limit test
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

  // Benchmark: 1000 RPS (3 min) - Extreme test
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

// Preset validation
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Unknown preset: ${PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`);
}

// K6 options (Cloud optimized)
export const options = {
  // K6 Cloud configuration
  cloud: {
    projectID: K6_CLOUD_PROJECT_ID ? Number.parseInt(K6_CLOUD_PROJECT_ID, 10) : undefined,
    name: `${TEST_ID} - ${PRESET}`,
    distribution: {
      // US West Coast (close to Cloudflare Workers)
      'amazon:us:portland': { loadZone: 'amazon:us:portland', percent: 100 },
    },
  },

  scenarios: {
    // Warmup scenario (warm up workers before main test)
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
    // Main benchmark scenario
    mail_otp_full_login: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
      startTime: '35s', // Starts after warmup
    },
  },
  thresholds: selectedPreset.thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  setupTimeout: '300s', // Allow extra time for Cloud environment
};

// User list loading
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
    console.warn("   Will attempt to fetch from USER_LIST_URL if provided");
  }
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

// Setup (runs once before test starts)
export function setup() {
  console.log("");
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔑 Client: ${CLIENT_ID}`);
  console.log("☁️  K6 Cloud Mode");
  console.log("");

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('CLIENT_ID and CLIENT_SECRET are required');
  }

  if (!ADMIN_API_SECRET) {
    throw new Error('ADMIN_API_SECRET is required for generating test email codes');
  }

  // Fetch user list
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
    // Try fetching from URL even if SharedArray is empty
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

  // Limit user count to preset's userCount
  const userCount = Math.min(users.length, selectedPreset.userCount);
  const selectedUsers = users.slice(0, userCount).map((email) => ({ email }));
  console.log(`📦 Using ${selectedUsers.length} users for benchmark`);
  console.log("");

  // Warmup
  console.log("🔥 Warming up...");
  for (let i = 0; i < Math.min(10, selectedUsers.length); i++) {
    const user = selectedUsers[i];
    // Authorize endpoint warmup
    http.get(`${BASE_URL}/authorize?response_type=code&client_id=${CLIENT_ID}&scope=openid`, {
      redirects: 0,
      tags: { name: 'Warmup' },
    });
    // Email code generate warmup
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
  console.log("   Warmup complete");
  console.log("");

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

// Main test function (executed repeatedly by each VU)
export default function (data) {
  const { users, userCount, clientId, clientSecret, redirectUri, baseUrl, adminSecret } = data;

  // Select user based on VU ID (round-robin)
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
  // Step 1: GET /authorize (Initialize)
  // ===============================
  const authorizeInitUrl =
    `${baseUrl}/authorize?` +
    "response_type=code&" +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    "scope=openid&" +
    `state=${state}&` +
    `nonce=${nonce}&` +
    `code_challenge=${codeChallenge}&` +
    "code_challenge_method=S256";

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
  // Step 2: POST /api/admin/test/email-codes (Generate OTP Code)
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
  // Step 3: POST /api/auth/email-code/verify (OTP Verify + Session Issue)
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
      if (exec.vu.iterationInInstance < 3) {
        console.error(`❌ OTP verify failed: ${step3Response.status} - ${step3Response.body}`);
      }
    } else {
      // Get session cookie from Set-Cookie header (k6 parses cookies automatically)
      if (step3Response.cookies && step3Response.cookies['authrim_session']) {
        sessionCookie = step3Response.cookies['authrim_session'][0].value;
      }

      // Fallback: try to get from JSON response body
      if (!sessionCookie) {
        try {
          const verifyData = JSON.parse(step3Response.body);
          if (verifyData.sessionId) {
            sessionCookie = verifyData.sessionId;
          }
        } catch (e) {
          // JSON parse failed
        }
      }

      if (!sessionCookie) {
        success = false;
        sessionErrors.add(1);
        if (exec.vu.iterationInInstance < 3) {
          console.error("❌ No session cookie returned from verify endpoint");
        }
      }
    }
  }

  emailCodeSuccess.add(success);

  // ===============================
  // Step 4: GET /authorize (with Cookie - Get Auth Code)
  // ===============================
  if (success && sessionCookie) {
    const authorizeCodeUrl =
      `${baseUrl}/authorize?` +
      "response_type=code&" +
      `client_id=${encodeURIComponent(clientId)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      "scope=openid&" +
      `state=${state}&` +
      `nonce=${nonce}&` +
      `code_challenge=${codeChallenge}&` +
      "code_challenge_method=S256&" +
      "prompt=none";

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

    // 302 redirect returns auth code
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
      if (exec.vu.iterationInInstance < 3) {
        const location =
          step4Response.headers['Location'] || step4Response.headers['location'] || '';
        console.error(
          `❌ Authorize code failed: status=${step4Response.status}, location=${location}`
        );
      }
    }
  }

  authorizeSuccess.add(success);

  // ===============================
  // Step 5: POST /token (Token Issuance)
  // ===============================
  if (success && authCode) {
    const credentials = encoding.b64encode(`${clientId}:${clientSecret}`);

    const step5Response = http.post(
      `${baseUrl}/token`,
      "grant_type=authorization_code" +
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
      if (exec.vu.iterationInInstance < 3) {
        console.error(
          `❌ Token failed: status=${step5Response.status}, body=${step5Response.body}`
        );
      }
    } else {
      try {
        const tokenData = JSON.parse(step5Response.body);
        if (!tokenData.access_token) {
          success = false;
          if (exec.vu.iterationInInstance < 3) {
            console.error(`❌ Token response missing access_token: ${step5Response.body}`);
          }
        }
      } catch (e) {
        success = false;
        if (exec.vu.iterationInInstance < 3) {
          console.error(`❌ Token response parse error: ${e.message}`);
        }
      }
    }
  }

  tokenSuccess.add(success);

  // Flow complete
  const flowEndTime = Date.now();
  fullFlowLatency.add(flowEndTime - flowStartTime);
  flowSuccess.add(success);
}

// Teardown (runs once after test ends)
export function teardown(data) {
  console.log("");
  console.log(`✅ ${TEST_NAME} Test Complete`);
  console.log(`📊 Preset: ${data.preset}`);
  console.log(`🎯 Target: ${data.baseUrl}`);
  console.log(`📈 User Count: ${data.userCount}`);
}

// Summary handler
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

// Generate text summary
function generateTextSummary(data) {
  const metrics = data.metrics;

  // Metric extraction helper
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

  // Basic statistics
  const totalIterations = getCount('iterations');
  const flowSuccessRate = getRate('flow_success') * 100;

  let summary = '\n';
  summary += `📊 ${TEST_NAME} - Summary\n`;
  summary += `${'='.repeat(70)}\n\n`;

  // Test information
  summary += `🎯 Preset: ${PRESET}\n`;
  summary += `📝 Description: ${selectedPreset.description}\n`;
  summary += "☁️  Environment: K6 Cloud\n\n";

  // Flow statistics
  summary += "📈 Flow Statistics:\n";
  summary += `  Total Iterations: ${totalIterations}\n`;
  summary += `  Flow Success Rate: ${flowSuccessRate.toFixed(2)}%\n\n`;

  // Per-step latency
  summary += "⏱️  Per-Step Latency:\n";
  summary += "  1. Authorize Init:\n";
  summary += `     med: ${getMetric('authorize_init_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('authorize_init_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('authorize_init_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('authorize_init_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += "  2. Email Code Generate:\n";
  summary += `     med: ${getMetric('email_code_generate_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('email_code_generate_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('email_code_generate_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('email_code_generate_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += "  3. Email Code Verify:\n";
  summary += `     med: ${getMetric('email_code_verify_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('email_code_verify_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('email_code_verify_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('email_code_verify_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += "  4. Authorize Code:\n";
  summary += `     med: ${getMetric('authorize_code_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('authorize_code_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('authorize_code_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('authorize_code_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += "  5. Token:\n";
  summary += `     med: ${getMetric('token_latency', 'med').toFixed(2)}ms, `;
  summary += `p95: ${getMetric('token_latency', 'p(95)').toFixed(2)}ms, `;
  summary += `p99: ${getMetric('token_latency', 'p(99)').toFixed(2)}ms, `;
  summary += `p999: ${getMetric('token_latency', 'p(99.9)').toFixed(2)}ms\n`;
  summary += "  Full Flow:\n";
  summary += `     med: ${getMetric('full_flow_latency', 'med').toFixed(2)}ms\n`;
  summary += `     p95: ${getMetric('full_flow_latency', 'p(95)').toFixed(2)}ms\n`;
  summary += `     p99: ${getMetric('full_flow_latency', 'p(99)').toFixed(2)}ms\n`;
  summary += `     p999: ${getMetric('full_flow_latency', 'p(99.9)').toFixed(2)}ms\n\n`;

  // Per-step success rate
  summary += "✅ Per-Step Success Rate:\n";
  summary += `  Email Code Auth: ${(getRate('email_code_success') * 100).toFixed(2)}%\n`;
  summary += `  Auth Code: ${(getRate('authorize_success') * 100).toFixed(2)}%\n`;
  summary += `  Token Issuance: ${(getRate('token_success') * 100).toFixed(2)}%\n\n`;

  // Error statistics
  summary += "❌ Error Statistics:\n";
  summary += `  OTP Generate Errors: ${getCount('otp_generate_errors')}\n`;
  summary += `  OTP Verify Errors: ${getCount('otp_verify_errors')}\n`;
  summary += `  Session Errors: ${getCount('session_errors')}\n`;
  summary += `  Auth Code Errors: ${getCount('code_errors')}\n`;
  summary += `  Rate Limit (429): ${getCount('rate_limit_errors')}\n`;
  summary += `  Server Errors (5xx): ${getCount('server_errors')}\n\n`;

  // Target check
  const p95 = getMetric('full_flow_latency', 'p(95)');
  const rate = getRate('flow_success');
  const serverErr = getCount('server_errors');
  const serverErrRate = totalIterations > 0 ? (serverErr / totalIterations) * 100 : 0;

  summary += "📋 Target Check:\n";
  summary += `  Success Rate > 95%: ${rate > 0.95 ? '✅ PASS' : '❌ FAIL'} (${flowSuccessRate.toFixed(2)}%)\n`;
  summary += `  Full Flow p95 < 5000ms: ${p95 < 5000 ? '✅ PASS' : '⚠️  WARN'} (${p95.toFixed(2)}ms)\n`;
  summary += `  5xx < 1%: ${serverErrRate < 1 ? '✅ PASS' : '❌ FAIL'} (${serverErrRate.toFixed(3)}%)\n\n`;

  // Throughput
  summary += `🚀 Throughput: ${getMetric('iterations', 'rate').toFixed(2)} flows/s\n`;
  summary += `${'='.repeat(70)}\n`;

  return summary;
}

// Generate JSON result
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
