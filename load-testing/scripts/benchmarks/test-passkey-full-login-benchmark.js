/**
 * Passkey Full Login Benchmark Test
 *
 * Purpose:
 * - Reproduce Authrim's heaviest login flow and measure load points
 * - Full flow: Passkey auth → Session issuance → Auth code issuance → Token issuance
 *
 * Implementation:
 * - Use xk6-passkeys extension (Authrim fork) to generate ECDSA P-256 signatures
 * - setup() performs user registration (excluded from benchmark)
 * - default() runs login benchmark (metrics measurement target)
 * - ExportCredential/ImportCredential shares credentials between setup() and default()
 *
 * Requirements:
 * - Custom k6 binary (./bin/k6-passkeys)
 *   Build with: ./scripts/build-k6-passkeys.sh
 *
 * Usage:
 * ./bin/k6-passkeys run \
 *   --env BASE_URL=https://your-authrim.example.com \
 *   --env ADMIN_API_SECRET=xxx \
 *   --env CLIENT_ID=xxx \
 *   --env CLIENT_SECRET=xxx \
 *   --env PRESET=rps30 \
 *   scripts/test-passkey-full-login-benchmark.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import encoding from 'k6/encoding';
import { randomBytes } from 'k6/crypto';
import { sha256 } from 'k6/crypto';
import exec from 'k6/execution';
import passkeys from 'k6/x/passkeys';

// Test identification
const TEST_NAME = 'Passkey Full Login Benchmark';
const TEST_ID = 'passkey-full-login-benchmark';

// Custom metrics - Latency per step
const authorizeInitLatency = new Trend('authorize_init_latency');
const passkeyOptionsLatency = new Trend('passkey_options_latency');
const passkeyVerifyLatency = new Trend('passkey_verify_latency');
const authorizeCodeLatency = new Trend('authorize_code_latency');
const tokenLatency = new Trend('token_latency');
const fullFlowLatency = new Trend('full_flow_latency');

// Success rates
const passkeySuccess = new Rate('passkey_success');
const authorizeSuccess = new Rate('authorize_success');
const tokenSuccess = new Rate('token_success');
const flowSuccess = new Rate('flow_success');

// Error counts
const signatureErrors = new Counter('signature_errors');
const challengeErrors = new Counter('challenge_errors');
const sessionErrors = new Counter('session_errors');
const codeErrors = new Counter('code_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');
const registrationErrors = new Counter('registration_errors');

// Environment variables
const BASE_URL = __ENV.BASE_URL || '';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const REDIRECT_URI = __ENV.REDIRECT_URI || 'https://localhost:3000/callback';
const ADMIN_API_SECRET = __ENV.ADMIN_API_SECRET || '';
const PRESET = __ENV.PRESET || 'rps30';
const USER_ID_PREFIX = __ENV.USER_ID_PREFIX || 'pk-bench';

// RP ID (used for signature verification)
function extractHostname(url) {
  const match = url.match(/^https?:\/\/([^/:]+)/);
  return match ? match[1] : url;
}
const RP_ID = extractHostname(BASE_URL);
const ORIGIN = BASE_URL.replace(/^http:/, 'https:');

/**
 * Preset Configuration
 *
 * Full login flow is heavy, so RPS is set lower than silent auth
 */
const PRESETS = {
  // Smoke test
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
    passkeyUserCount: 50,
  },

  // Standard benchmark
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
    passkeyUserCount: 100,
  },

  // High throughput
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
    passkeyUserCount: 150,
  },

  // Stress test
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
    passkeyUserCount: 200,
  },

  // Maximum capacity test
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
    passkeyUserCount: 300,
  },
};

// Preset validation
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Unknown preset: ${PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`);
}

// K6 options
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
  setupTimeout: '300s', // User registration may take time
};

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Generate random code_verifier (for PKCE)
 * RFC 7636 compliant
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
 * Uses k6's sha256
 */
function generateCodeChallenge(verifier) {
  return sha256(verifier, 'base64rawurl');
}

/**
 * Generate random state/nonce
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
 * Create user via Admin API
 */
function createUser(index, timestamp) {
  const email = `${USER_ID_PREFIX}-${timestamp}-${index}@test.authrim.internal`;

  const res = http.post(
    `${BASE_URL}/api/admin/users`,
    JSON.stringify({
      email,
      name: `Passkey Benchmark User ${index}`,
      email_verified: true,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_API_SECRET}`,
      },
      tags: { name: 'AdminCreateUser' },
    }
  );

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to create user: ${res.status} - ${res.body}`);
  }

  const data = JSON.parse(res.body);
  return {
    userId: data.user.id,
    email,
  };
}

// Setup - User registration (excluded from benchmark)
export function setup() {
  console.log("");
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔑 Client: ${CLIENT_ID}`);
  console.log(`🌐 RP ID: ${RP_ID}`);
  console.log(`👥 User Count: ${selectedPreset.passkeyUserCount}`);
  console.log("");

  if (!CLIENT_SECRET) {
    throw new Error('CLIENT_SECRET is required for token endpoint');
  }

  if (!ADMIN_API_SECRET) {
    throw new Error('ADMIN_API_SECRET is required for user creation');
  }

  console.log(`📝 Registering ${selectedPreset.passkeyUserCount} passkey users...`);
  console.log("   (Setup phase, not included in benchmark)");
  console.log("");

  const users = [];
  const timestamp = Date.now();

  // Relying Party configuration
  const rp = passkeys.newRelyingParty('Authrim', RP_ID, ORIGIN);
  const rpJson = passkeys.exportRelyingParty(rp);

  const startTime = Date.now();
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < selectedPreset.passkeyUserCount; i++) {
    try {
      // Step 1: Create user via Admin API
      const { userId, email } = createUser(i, timestamp);

      // Step 2: Generate key pair with passkeys.newCredential()
      const credential = passkeys.newCredential();

      // Step 3: Get registration options
      const optionsRes = http.post(
        `${BASE_URL}/api/auth/passkey/register/options`,
        JSON.stringify({ email, userId }),
        {
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
          },
          tags: { name: 'SetupRegisterOptions' },
        }
      );

      if (optionsRes.status !== 200) {
        throw new Error(`Register options failed: ${optionsRes.status} - ${optionsRes.body}`);
      }

      // Step 4: Generate registration response with passkeys.createAttestationResponse()
      // Authrim's response is in { options: {...}, userId: "..." } format
      // xk6-passkey expects direct WebAuthn format, so extract options portion
      const optionsData = JSON.parse(optionsRes.body);
      const attestation = passkeys.createAttestationResponse(
        rp,
        credential,
        JSON.stringify(optionsData.options)
      );

      // Step 5: Complete registration
      const verifyRes = http.post(
        `${BASE_URL}/api/auth/passkey/register/verify`,
        JSON.stringify({
          userId,
          credential: JSON.parse(attestation),
          deviceName: `Benchmark Device ${i}`,
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
          },
          tags: { name: 'SetupRegisterVerify' },
        }
      );

      if (verifyRes.status !== 200) {
        throw new Error(`Register verify failed: ${verifyRes.status} - ${verifyRes.body}`);
      }

      // Step 6: Save credential as JSON string (to pass to VUs)
      // Using passkeys.exportCredential() ensures Key data is properly serialized
      users.push({
        userId,
        email,
        credentialJson: passkeys.exportCredential(credential),
        rpJson,
      });

      successCount++;

      // Progress display (every 10 users)
      if ((i + 1) % 10 === 0 || i === selectedPreset.passkeyUserCount - 1) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = successCount / elapsed;
        console.log(
          `   [${successCount}/${selectedPreset.passkeyUserCount}] ${rate.toFixed(1)}/s, errors: ${errorCount}`
        );
      }
    } catch (e) {
      errorCount++;
      console.error(`   ❌ User ${i}: ${e.message}`);
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;

  if (users.length === 0) {
    throw new Error('No users registered successfully. Aborting.');
  }

  console.log("");
  console.log(`✅ Setup complete: ${users.length} users registered in ${totalTime.toFixed(2)}s`);
  console.log(`   Rate: ${(users.length / totalTime).toFixed(1)} users/sec`);
  console.log(`   Errors: ${errorCount}`);
  console.log("");

  // Warmup
  console.log("🔥 Warming up...");
  for (let i = 0; i < Math.min(5, users.length); i++) {
    const user = users[i];
    http.get(`${BASE_URL}/authorize?response_type=code&client_id=${CLIENT_ID}&scope=openid`, {
      redirects: 0,
      tags: { name: 'Warmup' },
    });
    http.post(`${BASE_URL}/api/auth/passkey/login/options`, JSON.stringify({ email: user.email }), {
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      tags: { name: 'Warmup' },
    });
  }
  console.log("   Warmup complete");
  console.log("");

  return {
    users,
    userCount: users.length,
    preset: PRESET,
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
  };
}

// Main test function - Login benchmark (metrics measurement target)
export default function (data) {
  const { users, userCount, clientId, redirectUri, baseUrl } = data;

  // Select user based on VU ID
  const userIndex = (__VU - 1) % userCount;
  const user = users[userIndex];

  // Restore credential
  // Using passkeys.importCredential() properly reconstructs Key.signingKey
  const credential = passkeys.importCredential(user.credentialJson);
  const rp = passkeys.importRelyingParty(user.rpJson);

  const flowStartTime = Date.now();
  let success = true;
  let sessionCookie = null;
  let authCode = null;

  // PKCE parameter generation
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateRandomHex(16);
  const nonce = generateRandomHex(16);

  // ===============================
  // Step 1: GET /authorize (init)
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
  // Step 2: POST /api/auth/passkey/login/options
  // ===============================
  let challengeId = null;

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
        challengeId = optionsData.challengeId;

        // ===============================
        // Step 3: Generate auth response with passkeys.createAssertionResponse()
        // ===============================
        // Authrim's response is in { options: {...}, challengeId: "..." } format
        // xk6-passkey expects direct WebAuthn format, so extract options portion
        let assertion;
        try {
          // Argument order: rp, credential, userHandle, assertionOptions
          assertion = passkeys.createAssertionResponse(
            rp,
            credential,
            user.userId,
            JSON.stringify(optionsData.options)
          );
        } catch (e) {
          success = false;
          signatureErrors.add(1);
          if (exec.vu.iterationInInstance < 3) {
            console.error(`❌ Assertion generation failed (VU ${__VU}): ${e.message}`);
          }
        }

        // ===============================
        // Step 4: POST /api/auth/passkey/login/verify
        // ===============================
        if (success && assertion) {
          const step4Response = http.post(
            `${baseUrl}/api/auth/passkey/login/verify`,
            JSON.stringify({
              challengeId,
              credential: JSON.parse(assertion),
            }),
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
  // Step 5: GET /authorize (get authorization code)
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
      "grant_type=authorization_code&" +
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

  // Record overall flow metrics
  const flowDuration = Date.now() - flowStartTime;
  fullFlowLatency.add(flowDuration);
  flowSuccess.add(success);

  // Debug (only first few failures)
  if (!success && exec.vu.iterationInInstance < 3) {
    console.error(`❌ Flow failed (VU ${__VU}, iter ${exec.vu.iterationInInstance})`);
  }
}

// Teardown
export function teardown(data) {
  console.log("");
  console.log(`✅ ${TEST_NAME} Test completed`);
  console.log(`📊 Preset: ${data.preset}`);
  console.log(`🎯 Target: ${data.baseUrl}`);
  console.log(`📈 User count: ${data.userCount}`);
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

  return {
    [`${resultsDir}/${TEST_ID}-${preset}_${timestamp}.json`]: JSON.stringify(data, null, 2),
    [`${resultsDir}/${TEST_ID}-${preset}_${timestamp}.log`]: textSummary(data, {
      indent: ' ',
      enableColors: false,
    }),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

// Generate text summary
function textSummary(data, options) {
  const indent = options.indent || '';

  let summary = '\n';
  summary += `${indent}📊 ${TEST_NAME} - Summary\n`;
  summary += `${indent}${'='.repeat(70)}\n\n`;

  // Test information
  summary += `${indent}🎯 Preset: ${PRESET}\n`;
  summary += `${indent}📝 Description: ${selectedPreset.description}\n\n`;

  // Basic statistics
  const metrics = data.metrics;
  const totalIterations = metrics.iterations?.values?.count || 0;
  const flowSuccessRate = ((metrics.flow_success?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}📈 Flow Statistics:\n`;
  summary += `${indent}  Total iterations: ${totalIterations}\n`;
  summary += `${indent}  Flow success rate: ${flowSuccessRate}%\n\n`;

  // Latency per step
  summary += `${indent}⏱️  Latency per Step:\n`;
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

  // Success rates
  const passkeyRate = ((metrics.passkey_success?.values?.rate || 0) * 100).toFixed(2);
  const authorizeRate = ((metrics.authorize_success?.values?.rate || 0) * 100).toFixed(2);
  const tokenRate = ((metrics.token_success?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}✅ Success Rate per Step:\n`;
  summary += `${indent}  Passkey auth: ${passkeyRate}%\n`;
  summary += `${indent}  Auth code: ${authorizeRate}%\n`;
  summary += `${indent}  Token issuance: ${tokenRate}%\n\n`;

  // Error statistics
  summary += `${indent}❌ Error Statistics:\n`;
  summary += `${indent}  Signature errors: ${metrics.signature_errors?.values?.count || 0}\n`;
  summary += `${indent}  Challenge errors: ${metrics.challenge_errors?.values?.count || 0}\n`;
  summary += `${indent}  Session errors: ${metrics.session_errors?.values?.count || 0}\n`;
  summary += `${indent}  Auth code errors: ${metrics.code_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  Server errors (5xx): ${metrics.server_errors?.values?.count || 0}\n`;
  summary += `${indent}  Registration errors: ${metrics.registration_errors?.values?.count || 0}\n\n`;

  // Throughput
  const rps = metrics.iterations?.values?.rate || 0;
  summary += `${indent}🚀 Throughput: ${rps.toFixed(2)} flows/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
