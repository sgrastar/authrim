/**
 * Token Introspection Control Plane Test
 *
 * Benchmark test for RFC 7662 Token Introspection endpoint
 *
 * ┌───────────────────────────────────────────────────────────────────────────────┐
 * │ Test Design (RFC 7662 + Industry Standard Compliance)                        │
 * ├────────────────────┬───────┬─────────────┬─────────────────────────────────────┤
 * │ Type               │ Ratio │ Expected    │ Validation Items                    │
 * ├────────────────────┼───────┼─────────────┼─────────────────────────────────────┤
 * │ Active (standard)  │ 60%   │ true        │ scope/sub consistency               │
 * │ Active (TE)        │ 5%    │ true        │ act/resource claim (RFC 8693)       │
 * │ Expired            │ 12%   │ false       │ Immediate reflection                │
 * │ Revoked            │ 12%   │ false       │ Immediate reflection                │
 * │ Wrong audience     │ 6%    │ false       │ aud validation (strictValidation)   │
 * │ Wrong client       │ 5%    │ false       │ client_id validation (strictVal)    │
 * └────────────────────┴───────┴─────────────┴─────────────────────────────────────┘
 *
 * Success Criteria (RFC 7662 + Keycloak/Auth0 benchmark):
 * - Success rate: > 99%
 * - p95: < 300ms, p99: < 400ms
 * - False Positive/Negative: 0
 * - Token Exchange act claim consistency: 100%
 *
 * Note: strictValidation=true must be set before running tests
 *   curl -X PUT https://your-authrim.example.com/api/admin/settings/introspection-validation \
 *     -H "Authorization: Bearer $ADMIN_API_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"strictValidation": true}'
 *
 * Usage:
 * k6 run --env PRESET=rps300 scripts/test-introspect-benchmark.js
 * k6 run --env PRESET=rps600 scripts/test-introspect-benchmark.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

// Test identification
const TEST_NAME = 'Token Introspection Control Plane Test';
const TEST_ID = 'introspect-benchmark';

// Custom metrics
const introspectDuration = new Trend('introspect_duration');
const introspectSuccess = new Rate('introspect_success');
const activeCorrect = new Rate('active_correct'); // active flag matches expected value
const falsePositives = new Counter('false_positives'); // active=true for invalid/expired/revoked
const falseNegatives = new Counter('false_negatives'); // active=false for valid
const clientAuthErrors = new Counter('client_auth_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');

// New category metrics
const exchangedTokenCorrect = new Rate('exchanged_token_correct'); // Token Exchange token active=true validation
const wrongAudienceRejected = new Rate('wrong_audience_rejected'); // Wrong audience correct rejection
const wrongClientRejected = new Rate('wrong_client_rejected'); // Wrong client correct rejection

// Axis 3: scope/aud/sub/iss integrity verification
const claimIntegrity = new Rate('claim_integrity'); // Basic claim integrity
// Axis 5: Token Exchange act/resource claim verification
const actClaimPresent = new Rate('act_claim_present'); // act claim presence check
const resourceClaimPresent = new Rate('resource_claim_present'); // resource claim presence check

// Environment variables
// Note: Replace default values with actual credentials when running tests
const BASE_URL = __ENV.BASE_URL || '';
const CLIENT_ID = __ENV.CLIENT_ID; // Required: OAuth client ID
const CLIENT_SECRET = __ENV.CLIENT_SECRET; // Required: OAuth client secret
const PRESET = __ENV.PRESET || 'rps300';

// Validate required credentials
if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    'CLIENT_ID and CLIENT_SECRET are required. Set them via environment variables:\n' +
      '  k6 run --env CLIENT_ID=your_client_id --env CLIENT_SECRET=your_secret scripts/test-introspect-benchmark.js'
  );
}
const TOKEN_PATH = __ENV.TOKEN_PATH || '../seeds/access_tokens.json';
// For K6 Cloud: URL to fetch seed data from R2
const TOKEN_URL = __ENV.TOKEN_URL || '';

/**
 * Token type ratio (RFC 7662 + Industry Standard Benchmark Compliance)
 *
 * Must match seed generation script
 */
const TOKEN_MIX = {
  valid: 0.6, // 60% - Standard access token
  valid_exchanged: 0.05, // 5%  - Token Exchange (with act claim)
  expired: 0.12, // 12% - Expired
  revoked: 0.12, // 12% - Revoked
  wrong_audience: 0.06, // 6%  - Valid signature, aud mismatch
  wrong_client: 0.05, // 5%  - Issued by different client_id
};

/**
 * Preset Configuration
 *
 * Specification compliance:
 * - RPS: 300, 600, 800, 1000
 * - Duration: 120 seconds
 * - Success rate: > 99%
 * - p95: < 300ms, p99: < 400ms
 * - false positive/negative: 0%
 */
const PRESETS = {
  // Light test (for development/verification)
  rps100: {
    description: '100 RPS - Quick smoke test (30s)',
    stages: [
      { target: 50, duration: '10s' },
      { target: 100, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<600'],
      http_req_failed: ['rate<0.02'],
      introspect_success: ['rate>0.98'],
      active_correct: ['rate>0.99'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
    },
    preAllocatedVUs: 120,
    maxVUs: 150,
  },

  // Benchmark: 300 RPS (3 min)
  rps300: {
    description: '300 RPS - Introspection benchmark (3 min)',
    stages: [
      { target: 150, duration: '15s' },
      { target: 300, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      // Axis 3: scope/aud/sub/iss integrity
      claim_integrity: ['rate>0.99'],
      // Axis 5: Token Exchange act/resource claim
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
    },
    preAllocatedVUs: 400,
    maxVUs: 500,
  },

  // Benchmark: 600 RPS (3 min)
  rps600: {
    description: '600 RPS - Introspection high throughput (3 min)',
    stages: [
      { target: 300, duration: '15s' },
      { target: 600, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      claim_integrity: ['rate>0.99'],
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
    },
    preAllocatedVUs: 700,
    maxVUs: 900,
  },

  // Benchmark: 800 RPS (3 min)
  rps800: {
    description: '800 RPS - Introspection stress test (3 min)',
    stages: [
      { target: 400, duration: '15s' },
      { target: 800, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      claim_integrity: ['rate>0.99'],
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
    },
    preAllocatedVUs: 950,
    maxVUs: 1200,
  },

  // Benchmark: 1000 RPS (3 min)
  rps1000: {
    description: '1000 RPS - Introspection maximum capacity (3 min)',
    stages: [
      { target: 500, duration: '15s' },
      { target: 1000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<400'],
      http_req_failed: ['rate<0.01'],
      introspect_success: ['rate>0.99'],
      active_correct: ['rate>0.999'],
      false_positives: ['count<1'],
      false_negatives: ['count<1'],
      exchanged_token_correct: ['rate>0.99'],
      wrong_audience_rejected: ['rate>0.99'],
      wrong_client_rejected: ['rate>0.99'],
      claim_integrity: ['rate>0.99'],
      act_claim_present: ['rate>0.99'],
      resource_claim_present: ['rate>0.99'],
    },
    preAllocatedVUs: 1200,
    maxVUs: 1500,
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
    introspect_benchmark: {
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

    // Classify tokens by type
    const validTokens = allTokens.filter((t) => t.type === 'valid');
    const validExchangedTokens = allTokens.filter((t) => t.type === 'valid_exchanged');
    const expiredTokens = allTokens.filter((t) => t.type === 'expired');
    const revokedTokens = allTokens.filter((t) => t.type === 'revoked');
    const wrongAudienceTokens = allTokens.filter((t) => t.type === 'wrong_audience');
    const wrongClientTokens = allTokens.filter((t) => t.type === 'wrong_client');

    console.log(`📂 Loaded tokens from local file:`);
    console.log(`   Valid:           ${validTokens.length}`);
    console.log(`   Valid (TE/act):  ${validExchangedTokens.length}`);
    console.log(`   Expired:         ${expiredTokens.length}`);
    console.log(`   Revoked:         ${revokedTokens.length}`);
    console.log(`   Wrong audience:  ${wrongAudienceTokens.length}`);
    console.log(`   Wrong client:    ${wrongClientTokens.length}`);
  } catch (e) {
    console.warn(`⚠️  Failed to load local tokens: ${e.message}`);
    console.warn('   Make sure to run: node scripts/seed-access-tokens.js first');
  }
} else {
  useRemoteData = true;
  console.log('☁️  K6 Cloud mode: Will fetch tokens from URL');
}

/**
 * Get expected active value
 * valid, valid_exchanged → true
 * Others → false
 */
function getExpectedActive(tokenType) {
  return tokenType === 'valid' || tokenType === 'valid_exchanged';
}

/**
 * Select token type by weight
 */
function selectTokenType() {
  const rand = Math.random();
  let cumulative = 0;

  cumulative += TOKEN_MIX.valid;
  if (rand < cumulative) return 'valid';

  cumulative += TOKEN_MIX.valid_exchanged;
  if (rand < cumulative) return 'valid_exchanged';

  cumulative += TOKEN_MIX.expired;
  if (rand < cumulative) return 'expired';

  cumulative += TOKEN_MIX.revoked;
  if (rand < cumulative) return 'revoked';

  cumulative += TOKEN_MIX.wrong_audience;
  if (rand < cumulative) return 'wrong_audience';

  return 'wrong_client';
}

/**
 * Get token by type
 */
function selectTokenByType(tokens, type, vuId) {
  const filtered = tokens.filter((t) => t.type === type);
  if (filtered.length === 0) {
    // Fallback: Select from all tokens
    return tokens[vuId % tokens.length];
  }
  return filtered[vuId % filtered.length];
}

// Setup (runs once before test starts)
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`🔐 Client: ${CLIENT_ID}`);
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

  // Verify token distribution
  const counts = {
    valid: tokens.filter((t) => t.type === 'valid').length,
    valid_exchanged: tokens.filter((t) => t.type === 'valid_exchanged').length,
    expired: tokens.filter((t) => t.type === 'expired').length,
    revoked: tokens.filter((t) => t.type === 'revoked').length,
    wrong_audience: tokens.filter((t) => t.type === 'wrong_audience').length,
    wrong_client: tokens.filter((t) => t.type === 'wrong_client').length,
  };
  console.log(`📊 Token distribution:`);
  console.log(
    `   Valid:           ${counts.valid} (${((counts.valid / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Valid (TE/act):  ${counts.valid_exchanged} (${((counts.valid_exchanged / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Expired:         ${counts.expired} (${((counts.expired / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Revoked:         ${counts.revoked} (${((counts.revoked / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Wrong audience:  ${counts.wrong_audience} (${((counts.wrong_audience / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `   Wrong client:    ${counts.wrong_client} (${((counts.wrong_client / tokens.length) * 100).toFixed(1)}%)`
  );
  console.log(``);

  // Warmup: Initialize DO with first few requests
  console.log(`🔥 Warming up...`);
  const validToken = tokens.find((t) => t.type === 'valid');
  if (validToken) {
    for (let i = 0; i < 5; i++) {
      http.post(`${BASE_URL}/introspect`, `token=${encodeURIComponent(validToken.access_token)}`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: getBasicAuthHeader(),
        },
        tags: { name: 'Warmup' },
      });
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

// Main test function (executed repeatedly by each VU)
export default function (data) {
  const tokens = useRemoteData ? data.tokens : allTokens;

  // Select token type by weight
  const tokenType = selectTokenType();
  const tokenData = selectTokenByType(tokens, tokenType, __VU);

  // Expected active flag
  const expectedActive = getExpectedActive(tokenData.type);

  // /introspect request
  const payload = `token=${encodeURIComponent(tokenData.access_token)}`;

  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: getBasicAuthHeader(),
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
    tags: {
      name: 'IntrospectRequest',
      preset: PRESET,
      tokenType: tokenData.type,
    },
  };

  const response = http.post(`${BASE_URL}/introspect`, payload, params);
  const duration = response.timings.duration;

  // Record metrics
  introspectDuration.add(duration);

  // Response validation
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (_) {
    // ignore parse errors
  }

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has active field': () => responseBody.active !== undefined,
    'response time < 1000ms': (r) => r.timings.duration < 1000,
  });

  introspectSuccess.add(success);

  // Active flag accuracy validation
  if (response.status === 200 && responseBody.active !== undefined) {
    const isCorrect = responseBody.active === expectedActive;
    activeCorrect.add(isCorrect ? 1 : 0);

    // Category metrics
    if (tokenData.type === 'valid_exchanged') {
      exchangedTokenCorrect.add(responseBody.active === true ? 1 : 0);

      // Axis 5: Token Exchange act/resource claim validation (RFC 8693)
      if (responseBody.active === true) {
        // Check act claim presence
        const hasActClaim =
          responseBody.act !== undefined &&
          responseBody.act !== null &&
          typeof responseBody.act === 'object' &&
          responseBody.act.sub !== undefined;
        actClaimPresent.add(hasActClaim ? 1 : 0);

        // Check resource claim presence
        const hasResourceClaim =
          responseBody.resource !== undefined &&
          typeof responseBody.resource === 'string' &&
          responseBody.resource.length > 0;
        resourceClaimPresent.add(hasResourceClaim ? 1 : 0);

        if (!hasActClaim || !hasResourceClaim) {
          console.warn(
            `⚠️  Token Exchange claim missing: act=${hasActClaim}, resource=${hasResourceClaim} (VU ${__VU})`
          );
        }
      }
    }
    if (tokenData.type === 'wrong_audience') {
      wrongAudienceRejected.add(responseBody.active === false ? 1 : 0);
    }
    if (tokenData.type === 'wrong_client') {
      wrongClientRejected.add(responseBody.active === false ? 1 : 0);
    }

    // Axis 3: scope/aud/sub/iss integrity validation (only when active=true)
    if (responseBody.active === true) {
      const hasScope = responseBody.scope !== undefined && responseBody.scope !== null;
      const hasAud = responseBody.aud !== undefined && responseBody.aud !== null;
      const hasSub = responseBody.sub !== undefined && responseBody.sub !== null;
      const hasIss = responseBody.iss !== undefined && responseBody.iss !== null;
      const hasClientId = responseBody.client_id !== undefined && responseBody.client_id !== null;

      const allClaimsPresent = hasScope && hasAud && hasSub && hasIss && hasClientId;
      claimIntegrity.add(allClaimsPresent ? 1 : 0);

      if (!allClaimsPresent) {
        console.warn(
          `⚠️  Claim integrity issue: scope=${hasScope}, aud=${hasAud}, sub=${hasSub}, iss=${hasIss}, client_id=${hasClientId} (VU ${__VU})`
        );
      }
    }

    if (!isCorrect) {
      if (responseBody.active === true && !expectedActive) {
        // False positive: active=true for expired/invalid/revoked/wrong_audience/wrong_client
        falsePositives.add(1);
        console.error(
          `⚠️  False Positive: Token type '${tokenData.type}' returned active=true (VU ${__VU})`
        );
      } else if (responseBody.active === false && expectedActive) {
        // False negative: active=false for valid/valid_exchanged
        falseNegatives.add(1);
        console.error(
          `⚠️  False Negative: Token type '${tokenData.type}' returned active=false (VU ${__VU})`
        );
      }
    }
  } else {
    activeCorrect.add(0);
  }

  // Error classification
  if (response.status === 401) {
    clientAuthErrors.add(1);
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
    console.error(`   status: ${response.status} (expected 200)`);
    console.error(`   tokenType: ${tokenData.type}`);
    console.error(`   active: ${responseBody.active} (expected ${expectedActive})`);
    if (response.status !== 200) {
      console.error(`   body: ${response.body.substring(0, 200)}`);
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
  const successRate = ((metrics.introspect_success?.values?.rate || 0) * 100).toFixed(2);

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

  // Active flag accuracy
  const activeCorrectRate = ((metrics.active_correct?.values?.rate || 0) * 100).toFixed(3);
  const fp = metrics.false_positives?.values?.count || 0;
  const fn = metrics.false_negatives?.values?.count || 0;

  summary += `${indent}🎯 Active Flag Accuracy:\n`;
  summary += `${indent}  Accuracy rate: ${activeCorrectRate}%\n`;
  summary += `${indent}  False Positives: ${fp}\n`;
  summary += `${indent}  False Negatives: ${fn}\n\n`;

  // Category accuracy
  const exchangedRate = ((metrics.exchanged_token_correct?.values?.rate || 0) * 100).toFixed(2);
  const wrongAudRate = ((metrics.wrong_audience_rejected?.values?.rate || 0) * 100).toFixed(2);
  const wrongClientRate = ((metrics.wrong_client_rejected?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}📋 Category Accuracy:\n`;
  summary += `${indent}  Token Exchange (act) correct: ${exchangedRate}%\n`;
  summary += `${indent}  Wrong audience rejected: ${wrongAudRate}%\n`;
  summary += `${indent}  Wrong client rejected: ${wrongClientRate}%\n\n`;

  // Axis 3: scope/aud/sub/iss integrity
  const claimIntegrityRate = ((metrics.claim_integrity?.values?.rate || 0) * 100).toFixed(2);
  summary += `${indent}🔍 Axis 3 - Claim Integrity (scope/aud/sub/iss):\n`;
  summary += `${indent}  Integrity rate: ${claimIntegrityRate}%\n\n`;

  // Axis 5: Token Exchange act/resource claim
  const actClaimRate = ((metrics.act_claim_present?.values?.rate || 0) * 100).toFixed(2);
  const resourceClaimRate = ((metrics.resource_claim_present?.values?.rate || 0) * 100).toFixed(2);
  summary += `${indent}🔄 Axis 5 - Token Exchange claims (RFC 8693):\n`;
  summary += `${indent}  act claim presence rate: ${actClaimRate}%\n`;
  summary += `${indent}  resource claim presence rate: ${resourceClaimRate}%\n\n`;

  // Specification compliance check
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.introspect_success?.values?.rate || 0;

  const claimIntegrityRateNum = metrics.claim_integrity?.values?.rate || 0;
  const actClaimRateNum = metrics.act_claim_present?.values?.rate || 0;
  const resourceClaimRateNum = metrics.resource_claim_present?.values?.rate || 0;

  summary += `${indent}📋 RFC 7662 + Keycloak/Auth0 Compliance Check:\n`;
  summary += `${indent}  Success rate > 99%: ${rate > 0.99 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 300ms: ${p95 < 300 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 400ms: ${p99 < 400 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  False Positive = 0: ${fp === 0 ? '✅ PASS' : '❌ FAIL'} (${fp})\n`;
  summary += `${indent}  False Negative = 0: ${fn === 0 ? '✅ PASS' : '❌ FAIL'} (${fn})\n`;
  summary += `${indent}  Claim integrity > 99%: ${claimIntegrityRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${claimIntegrityRate}%)\n`;
  summary += `${indent}  Token Exchange act > 99%: ${actClaimRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${actClaimRate}%)\n`;
  summary += `${indent}  Token Exchange resource > 99%: ${resourceClaimRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${resourceClaimRate}%)\n\n`;

  // Error statistics
  summary += `${indent}❌ Error Statistics:\n`;
  summary += `${indent}  Client auth errors (401): ${metrics.client_auth_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  Server errors (5xx): ${metrics.server_errors?.values?.count || 0}\n\n`;

  // Throughput
  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 Throughput: ${rps.toFixed(2)} req/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
