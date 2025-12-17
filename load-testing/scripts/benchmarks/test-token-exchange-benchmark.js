/**
 * Token Exchange (RFC 8693) Benchmark Test
 *
 * Purpose:
 * - Measure performance under high volume of "service-to-service authentication" in microservices
 * - Evaluate audience switching after SSO and Service Token issuance capability
 * - Verify TOKEN_REVOCATION_STORE DO bottlenecks
 * - Verify reliable rejection of revoked tokens
 *
 * Test Specifications (Section 4.7):
 * - Target: POST /token
 * - Grant Type: urn:ietf:params:oauth:grant-type:token-exchange
 * - subject_token: Pre-generated access_token
 * - Token mix: Valid 70%, Expired 10%, Invalid 10%, Revoked 10%
 *
 * Success Criteria:
 * - Success rate: > 99%
 * - p95 latency: < 400ms
 * - p99 latency: < 700ms
 * - Invalid token false acceptance: 0%
 * - Revoked token false acceptance: 0%
 * - Generated token signature error rate: 0%
 *
 * Usage:
 * k6 run --env PRESET=rps100 scripts/test-token-exchange-benchmark.js
 * k6 run --env PRESET=rps300 scripts/test-token-exchange-benchmark.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

// Test identification
const TEST_NAME = 'Token Exchange (RFC 8693) Benchmark';
const TEST_ID = 'token-exchange-benchmark';

// Custom metrics
const tokenExchangeDuration = new Trend('token_exchange_duration');
const tokenExchangeSuccess = new Rate('token_exchange_success');
const invalidTokenAccepted = new Counter('invalid_token_accepted'); // Invalid token false acceptance
const revokedTokenAccepted = new Counter('revoked_token_accepted'); // Revoked token false acceptance
const signatureErrors = new Counter('signature_errors'); // Generated token signature errors
const clientAuthErrors = new Counter('client_auth_errors');
const invalidGrantErrors = new Counter('invalid_grant_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');
const featureDisabledErrors = new Counter('feature_disabled_errors');

// Metrics per token type
const validTokenRequests = new Counter('valid_token_requests');
const validTokenSuccess = new Counter('valid_token_success');
const expiredTokenRequests = new Counter('expired_token_requests');
const expiredTokenSuccess = new Counter('expired_token_success'); // Correctly rejected = success
const invalidTokenRequests = new Counter('invalid_token_requests');
const invalidTokenSuccess = new Counter('invalid_token_success'); // Correctly rejected = success
const revokedTokenRequests = new Counter('revoked_token_requests');
const revokedTokenSuccess = new Counter('revoked_token_success'); // Correctly rejected = success

// Environment variables
const BASE_URL = __ENV.BASE_URL || '';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const PRESET = __ENV.PRESET || 'rps100';
const TOKEN_PATH = __ENV.TOKEN_PATH || '../seeds/access_tokens.json';
// For K6 Cloud: URL to fetch seed data from R2
const TOKEN_URL = __ENV.TOKEN_URL || '';
// Request parameters for Token Exchange
const TARGET_AUDIENCE = __ENV.TARGET_AUDIENCE || '';
const TARGET_SCOPE = __ENV.TARGET_SCOPE || 'openid profile';
// JWKS URL for signature verification (Optional)
const JWKS_URL = __ENV.JWKS_URL || `${BASE_URL}/.well-known/jwks.json`;

// Token Exchange grant type
const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

// Token type ratio (per specification)
// Revoked is explicitly managed as a separate type (identifiable in test results)
const TOKEN_MIX = {
  valid: 0.7, // 70%
  expired: 0.1, // 10%
  invalid: 0.1, // 10%
  revoked: 0.1, // 10% - Invalidated via POST /revoke
};

/**
 * Preset Configuration
 *
 * Specification compliance:
 * - Duration: 180 seconds (3 min)
 * - Success rate: > 99%
 * - p95: < 400ms
 * - p99: < 700ms
 */
const PRESETS = {
  // Light test (for development/verification)
  rps50: {
    description: '50 RPS - Quick smoke test (30s)',
    stages: [
      { target: 25, duration: '10s' },
      { target: 50, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<800'],
      http_req_failed: ['rate<0.02'],
      token_exchange_success: ['rate>0.98'],
      invalid_token_accepted: ['count<1'],
      revoked_token_accepted: ['count<1'],
      signature_errors: ['count<1'],
    },
    preAllocatedVUs: 80,
    maxVUs: 100,
  },

  // Benchmark: 100 RPS (3 min)
  rps100: {
    description: '100 RPS - Token Exchange baseline (3 min)',
    stages: [
      { target: 50, duration: '15s' },
      { target: 100, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<700'],
      http_req_failed: ['rate<0.01'],
      token_exchange_success: ['rate>0.99'],
      invalid_token_accepted: ['count<1'],
      revoked_token_accepted: ['count<1'],
      signature_errors: ['count<1'],
    },
    preAllocatedVUs: 150,
    maxVUs: 200,
  },

  // Benchmark: 200 RPS (3 min)
  rps200: {
    description: '200 RPS - Token Exchange moderate load (3 min)',
    stages: [
      { target: 100, duration: '15s' },
      { target: 200, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<700'],
      http_req_failed: ['rate<0.01'],
      token_exchange_success: ['rate>0.99'],
      invalid_token_accepted: ['count<1'],
      revoked_token_accepted: ['count<1'],
      signature_errors: ['count<1'],
    },
    preAllocatedVUs: 300,
    maxVUs: 400,
  },

  // Benchmark: 300 RPS (3 min) - SSO high load scenario
  rps300: {
    description: '300 RPS - Token Exchange SSO high load (3 min)',
    stages: [
      { target: 150, duration: '15s' },
      { target: 300, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<700'],
      http_req_failed: ['rate<0.01'],
      token_exchange_success: ['rate>0.99'],
      invalid_token_accepted: ['count<1'],
      revoked_token_accepted: ['count<1'],
      signature_errors: ['count<1'],
    },
    preAllocatedVUs: 450,
    maxVUs: 600,
  },

  // Benchmark: 500 RPS (3 min) - Stress test
  rps500: {
    description: '500 RPS - Token Exchange stress test (3 min)',
    stages: [
      { target: 250, duration: '15s' },
      { target: 500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<700'],
      http_req_failed: ['rate<0.01'],
      token_exchange_success: ['rate>0.99'],
      invalid_token_accepted: ['count<1'],
      revoked_token_accepted: ['count<1'],
      signature_errors: ['count<1'],
    },
    preAllocatedVUs: 700,
    maxVUs: 900,
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
    token_exchange_benchmark: {
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
};

// Generate Basic auth header
function getBasicAuthHeader() {
  const credentials = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return `Basic ${encoding.b64encode(credentials)}`;
}

// Local mode: Load tokens with SharedArray
let allTokens = null;
let useRemoteData = false;

if (!TOKEN_URL) {
  try {
    allTokens = new SharedArray('all_tokens', function () {
      const raw = open(TOKEN_PATH);
      const data = JSON.parse(raw);
      return data.tokens;
    });

    // Check token distribution
    const validCount = allTokens.filter((t) => t.type === 'valid').length;
    const expiredCount = allTokens.filter((t) => t.type === 'expired').length;
    const invalidCount = allTokens.filter((t) => t.type === 'invalid').length;
    const revokedCount = allTokens.filter((t) => t.type === 'revoked').length;

    console.log(`📂 Loaded ${allTokens.length} tokens from local file:`);
    console.log(
      `   Valid:   ${validCount} (${((validCount / allTokens.length) * 100).toFixed(1)}%)`
    );
    console.log(
      `   Expired: ${expiredCount} (${((expiredCount / allTokens.length) * 100).toFixed(1)}%)`
    );
    console.log(
      `   Invalid: ${invalidCount} (${((invalidCount / allTokens.length) * 100).toFixed(1)}%)`
    );
    console.log(
      `   Revoked: ${revokedCount} (${((revokedCount / allTokens.length) * 100).toFixed(1)}%)`
    );
  } catch (e) {
    console.warn(`⚠️  Failed to load local tokens: ${e.message}`);
    console.warn('   Make sure to run: node scripts/seed-access-tokens.js first');
  }
} else {
  useRemoteData = true;
  console.log('☁️  K6 Cloud mode: Will fetch tokens from URL');
}

/**
 * Select token type with weighted probability
 * Valid: 70%, Expired: 10%, Invalid: 10%, Revoked: 10%
 */
function selectTokenType() {
  const rand = Math.random() * 100;
  if (rand < 70) return 'valid';
  if (rand < 80) return 'expired';
  if (rand < 90) return 'invalid';
  return 'revoked';
}

/**
 * Get token by type
 */
function selectTokenByType(tokens, type, vuId) {
  const filtered = tokens.filter((t) => t.type === type);
  if (filtered.length === 0) {
    // Fallback: select from valid tokens
    const validTokens = tokens.filter((t) => t.type === 'valid');
    if (validTokens.length === 0) {
      return tokens[vuId % tokens.length];
    }
    return validTokens[vuId % validTokens.length];
  }
  return filtered[vuId % filtered.length];
}

/**
 * Simple JWT validation (signature is verified server-side, only check structure)
 */
function validateJWTStructure(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  try {
    // Check if header and payload can be Base64 decoded
    const header = JSON.parse(encoding.b64decode(parts[0], 'rawurl', 's'));
    const payload = JSON.parse(encoding.b64decode(parts[1], 'rawurl', 's'));

    // Check for required fields
    if (!header.alg || !header.typ) return false;
    if (!payload.iss || !payload.sub || !payload.exp) return false;

    return true;
  } catch (_) {
    return false;
  }
}

// Setup (runs once before test starts)
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔐 Client: ${CLIENT_ID}`);
  if (TARGET_AUDIENCE) {
    console.log(`🎯 Target Audience: ${TARGET_AUDIENCE}`);
  }
  console.log(`📝 Target Scope: ${TARGET_SCOPE}`);
  console.log(``);
  console.log(`📊 Token Mix (per specification):`);
  console.log(`   Valid:   70%`);
  console.log(`   Expired: 10%`);
  console.log(`   Invalid: 10%`);
  console.log(`   Revoked: 10%`);
  console.log(``);

  let tokens = [];

  // K6 Cloud: Fetch tokens from remote
  if (TOKEN_URL) {
    console.log(`☁️  Fetching tokens from: ${TOKEN_URL}`);
    const response = http.get(TOKEN_URL, { timeout: '120s' });
    if (response.status !== 200) {
      throw new Error(`Failed to fetch tokens: ${response.status}`);
    }
    const data = JSON.parse(response.body);
    tokens = data.tokens;
    console.log(`   Loaded ${tokens.length} tokens from remote`);
  } else if (allTokens) {
    tokens = allTokens;
  }

  if (tokens.length === 0) {
    throw new Error(
      'No tokens available. Run: node scripts/seed-access-tokens.js to generate tokens'
    );
  }

  // Check token distribution
  const counts = {
    valid: tokens.filter((t) => t.type === 'valid').length,
    expired: tokens.filter((t) => t.type === 'expired').length,
    invalid: tokens.filter((t) => t.type === 'invalid').length,
    revoked: tokens.filter((t) => t.type === 'revoked').length,
  };

  // Warmup: Initialize Token Exchange endpoint
  console.log(`🔥 Warming up Token Exchange endpoint...`);
  const validToken = tokens.find((t) => t.type === 'valid');
  if (validToken) {
    for (let i = 0; i < 5; i++) {
      const payload = buildTokenExchangePayload(validToken.access_token);
      const response = http.post(`${BASE_URL}/token`, payload, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: getBasicAuthHeader(),
        },
        tags: { name: 'Warmup' },
      });

      // Feature flag disabled check
      if (response.status === 400) {
        const body = JSON.parse(response.body);
        if (
          body.error === 'unsupported_grant_type' &&
          body.error_description?.includes('not enabled')
        ) {
          console.error(`❌ Token Exchange is not enabled!`);
          console.error(`   Set ENABLE_TOKEN_EXCHANGE=true or enable via KV settings.`);
          throw new Error('Token Exchange feature is disabled');
        }
      }

      // Client not allowed check
      if (response.status === 403) {
        const body = JSON.parse(response.body);
        if (body.error === 'unauthorized_client') {
          console.error(`❌ Client is not allowed to use Token Exchange!`);
          console.error(`   Set token_exchange_allowed=true for client ${CLIENT_ID}`);
          throw new Error('Client not authorized for Token Exchange');
        }
      }
    }
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    tokens: useRemoteData ? tokens : null,
    tokenCount: tokens.length,
    counts,
    preset: PRESET,
    baseUrl: BASE_URL,
  };
}

// Build Token Exchange payload
function buildTokenExchangePayload(subjectToken) {
  let payload = `grant_type=${encodeURIComponent(TOKEN_EXCHANGE_GRANT_TYPE)}`;
  payload += `&subject_token=${encodeURIComponent(subjectToken)}`;
  payload += `&subject_token_type=${encodeURIComponent(ACCESS_TOKEN_TYPE)}`;
  payload += `&requested_token_type=${encodeURIComponent(ACCESS_TOKEN_TYPE)}`;
  payload += `&scope=${encodeURIComponent(TARGET_SCOPE)}`;

  if (TARGET_AUDIENCE) {
    payload += `&audience=${encodeURIComponent(TARGET_AUDIENCE)}`;
  }

  return payload;
}

// Main test function (executed repeatedly by each VU)
export default function (data) {
  const tokens = useRemoteData ? data.tokens : allTokens;

  // Select token type with weighted probability (70% valid, 10% expired, 10% invalid, 10% revoked)
  const tokenType = selectTokenType();
  const tokenData = selectTokenByType(tokens, tokenType, __VU);

  // Expected result
  const expectSuccess = tokenData.type === 'valid';

  // Token Exchange request
  const payload = buildTokenExchangePayload(tokenData.access_token);

  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: getBasicAuthHeader(),
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
    tags: {
      name: 'TokenExchangeRequest',
      preset: PRESET,
      tokenType: tokenData.type,
    },
  };

  const response = http.post(`${BASE_URL}/token`, payload, params);
  const duration = response.timings.duration;

  // Record metrics
  tokenExchangeDuration.add(duration);

  // Response validation
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (_) {
    // ignore parse errors
  }

  // Success determination
  const isSuccess = response.status === 200 && responseBody.access_token !== undefined;

  // Check for invalid token false acceptance
  if (!expectSuccess && isSuccess) {
    if (tokenData.type === 'revoked') {
      revokedTokenAccepted.add(1);
      console.error(
        `⚠️  Revoked token accepted! Token should have been rejected (VU ${__VU})`
      );
    } else {
      invalidTokenAccepted.add(1);
      console.error(
        `⚠️  Invalid token accepted! Token type '${tokenData.type}' should have been rejected (VU ${__VU})`
      );
    }
  }

  // Signature verification of generated token (structure check)
  if (isSuccess) {
    const validStructure = validateJWTStructure(responseBody.access_token);
    if (!validStructure) {
      signatureErrors.add(1);
      console.error(`⚠️  Generated token has invalid structure (VU ${__VU})`);
    }
  }

  // Check (expect success only for valid tokens)
  let success;
  if (expectSuccess) {
    success = check(response, {
      'status is 200': (r) => r.status === 200,
      'has access_token': () => responseBody.access_token !== undefined,
      'has issued_token_type': () => responseBody.issued_token_type !== undefined,
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });
  } else {
    // expired/invalid tokens should be rejected
    success = check(response, {
      'invalid token rejected': (r) => r.status === 400,
      'error is invalid_grant': () => responseBody.error === 'invalid_grant',
    });
  }

  tokenExchangeSuccess.add(success);

  // Record metrics per token type
  switch (tokenData.type) {
    case 'valid':
      validTokenRequests.add(1);
      if (isSuccess) validTokenSuccess.add(1);
      break;
    case 'expired':
      expiredTokenRequests.add(1);
      // Correctly rejected = success
      if (response.status === 400 && responseBody.error === 'invalid_grant') {
        expiredTokenSuccess.add(1);
      }
      break;
    case 'invalid':
      invalidTokenRequests.add(1);
      // Correctly rejected = success
      if (response.status === 400) {
        invalidTokenSuccess.add(1);
      }
      break;
    case 'revoked':
      revokedTokenRequests.add(1);
      // Correctly rejected = success
      if (response.status === 400 && responseBody.error === 'invalid_grant') {
        revokedTokenSuccess.add(1);
      }
      break;
  }

  // Error classification
  if (response.status === 401) {
    clientAuthErrors.add(1);
  }
  if (response.status === 400 && responseBody.error === 'invalid_grant') {
    invalidGrantErrors.add(1);
  }
  if (response.status === 400 && responseBody.error === 'unsupported_grant_type') {
    featureDisabledErrors.add(1);
  }
  if (response.status === 429) {
    rateLimitErrors.add(1);
  }
  if (response.status >= 500) {
    serverErrors.add(1);
  }

  // Debug (only on failure)
  if (!success && exec.vu.iterationInInstance < 3) {
    console.error(`❌ Check failed (VU ${__VU}, iter ${exec.vu.iterationInInstance}):`);
    console.error(`   tokenType: ${tokenData.type}`);
    console.error(`   expectSuccess: ${expectSuccess}`);
    console.error(`   status: ${response.status}`);
    console.error(`   duration: ${response.timings.duration}ms`);
    if (responseBody.error) {
      console.error(`   error: ${responseBody.error}`);
      console.error(`   error_description: ${responseBody.error_description}`);
    }
  }
}

// Teardown (runs once after test ends)
export function teardown(data) {
  console.log(``);
  console.log(`✅ ${TEST_NAME} Test completed`);
  console.log(`📊 Preset: ${data.preset}`);
  console.log(`🎯 Target: ${data.baseUrl}`);
  console.log(`📈 Token count: ${data.tokenCount}`);
  console.log(`📊 Token distribution:`);
  console.log(`   Valid:   ${data.counts.valid}`);
  console.log(`   Expired: ${data.counts.expired}`);
  console.log(`   Invalid: ${data.counts.invalid}`);
  console.log(`   Revoked: ${data.counts.revoked}`);
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
  const totalRequests = metrics.http_reqs?.values?.count || 0;
  const failedRequests = metrics.http_req_failed?.values?.passes || 0;
  const successRequests = totalRequests - failedRequests;
  const successRate = ((metrics.token_exchange_success?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}📈 Request Statistics:\n`;
  summary += `${indent}  Total requests: ${totalRequests}\n`;
  summary += `${indent}  Success: ${successRequests}\n`;
  summary += `${indent}  Failed: ${failedRequests}\n`;
  summary += `${indent}  Success rate: ${successRate}%\n\n`;

  // Response time
  summary += `${indent}⏱️  Response Time:\n`;
  summary += `${indent}  Average: ${metrics.http_req_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p50: ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p90: ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p95: ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p99: ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p999: ${metrics.http_req_duration?.values?.['p(99.9)']?.toFixed(2) || 0}ms\n\n`;

  // Specification compliance check
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.token_exchange_success?.values?.rate || 0;
  const invalidAccepted = metrics.invalid_token_accepted?.values?.count || 0;
  const revokedAccepted = metrics.revoked_token_accepted?.values?.count || 0;
  const sigErrors = metrics.signature_errors?.values?.count || 0;

  summary += `${indent}📋 Specification Compliance Check (Section 4.7):\n`;
  summary += `${indent}  Success rate > 99%: ${rate > 0.99 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 400ms: ${p95 < 400 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 700ms: ${p99 < 700 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  Invalid token false accept = 0: ${invalidAccepted === 0 ? '✅ PASS' : '❌ FAIL'} (${invalidAccepted})\n`;
  summary += `${indent}  Revoked false accept = 0: ${revokedAccepted === 0 ? '✅ PASS' : '❌ FAIL'} (${revokedAccepted})\n`;
  summary += `${indent}  Signature errors = 0: ${sigErrors === 0 ? '✅ PASS' : '❌ FAIL'} (${sigErrors})\n\n`;

  // Success rate per token type
  const validReqs = metrics.valid_token_requests?.values?.count || 0;
  const validSucc = metrics.valid_token_success?.values?.count || 0;
  const validRate = validReqs > 0 ? ((validSucc / validReqs) * 100).toFixed(2) : '0.00';

  const expiredReqs = metrics.expired_token_requests?.values?.count || 0;
  const expiredSucc = metrics.expired_token_success?.values?.count || 0;
  const expiredRate = expiredReqs > 0 ? ((expiredSucc / expiredReqs) * 100).toFixed(2) : '0.00';

  const invalidReqs = metrics.invalid_token_requests?.values?.count || 0;
  const invalidSucc = metrics.invalid_token_success?.values?.count || 0;
  const invalidRate = invalidReqs > 0 ? ((invalidSucc / invalidReqs) * 100).toFixed(2) : '0.00';

  const revokedReqs = metrics.revoked_token_requests?.values?.count || 0;
  const revokedSucc = metrics.revoked_token_success?.values?.count || 0;
  const revokedRate = revokedReqs > 0 ? ((revokedSucc / revokedReqs) * 100).toFixed(2) : '0.00';

  summary += `${indent}📊 Success Rate per Token Type:\n`;
  summary += `${indent}  ┌─────────────┬──────────┬──────────┬──────────┬────────────────────────────┐\n`;
  summary += `${indent}  │ Token Type  │ Requests │ Success  │ Rate     │ Expected                   │\n`;
  summary += `${indent}  ├─────────────┼──────────┼──────────┼──────────┼────────────────────────────┤\n`;
  summary += `${indent}  │ Valid       │ ${String(validReqs).padStart(8)} │ ${String(validSucc).padStart(8)} │ ${validRate.padStart(6)}% │ Token Exchange success     │\n`;
  summary += `${indent}  │ Expired     │ ${String(expiredReqs).padStart(8)} │ ${String(expiredSucc).padStart(8)} │ ${expiredRate.padStart(6)}% │ Correctly rejected (inv_gr)│\n`;
  summary += `${indent}  │ Invalid     │ ${String(invalidReqs).padStart(8)} │ ${String(invalidSucc).padStart(8)} │ ${invalidRate.padStart(6)}% │ Correctly rejected (400)   │\n`;
  summary += `${indent}  │ Revoked     │ ${String(revokedReqs).padStart(8)} │ ${String(revokedSucc).padStart(8)} │ ${revokedRate.padStart(6)}% │ Correctly rejected (inv_gr)│\n`;
  summary += `${indent}  └─────────────┴──────────┴──────────┴──────────┴────────────────────────────┘\n\n`;

  // Evaluation
  const validPass = parseFloat(validRate) >= 99;
  const expiredPass = parseFloat(expiredRate) >= 99;
  const invalidPass = parseFloat(invalidRate) >= 99;
  const revokedPass = parseFloat(revokedRate) >= 99;

  summary += `${indent}  Valid success rate >= 99%: ${validPass ? '✅ PASS' : '❌ FAIL'} (${validRate}%)\n`;
  summary += `${indent}  Expired rejection rate >= 99%: ${expiredPass ? '✅ PASS' : '❌ FAIL'} (${expiredRate}%)\n`;
  summary += `${indent}  Invalid rejection rate >= 99%: ${invalidPass ? '✅ PASS' : '❌ FAIL'} (${invalidRate}%)\n`;
  summary += `${indent}  Revoked rejection rate >= 99%: ${revokedPass ? '✅ PASS' : '❌ FAIL'} (${revokedRate}%)\n\n`;

  // Error statistics
  summary += `${indent}❌ Error Statistics:\n`;
  summary += `${indent}  Client auth errors (401): ${metrics.client_auth_errors?.values?.count || 0}\n`;
  summary += `${indent}  Invalid Grant (400): ${metrics.invalid_grant_errors?.values?.count || 0}\n`;
  summary += `${indent}  Feature Disabled: ${metrics.feature_disabled_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  Server errors (5xx): ${metrics.server_errors?.values?.count || 0}\n`;
  summary += `${indent}  Revoked false accept: ${metrics.revoked_token_accepted?.values?.count || 0}\n\n`;

  // Throughput
  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 Throughput: ${rps.toFixed(2)} req/s\n`;

  // DO bottleneck warning
  if (p95 > 300 || p99 > 500) {
    summary += `\n${indent}⚠️  Performance Warning:\n`;
    summary += `${indent}  If latency is high, consider sharding TOKEN_REVOCATION_STORE DO.\n`;
    summary += `${indent}  Current sharding: Single instance (tenant:default:token-revocation)\n`;
  }

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
