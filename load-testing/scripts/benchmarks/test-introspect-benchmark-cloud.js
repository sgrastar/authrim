/**
 * Token Introspection Control Plane Test - K6 Cloud Edition
 *
 * RFC 7662 Token Introspection endpoint benchmark test
 * Execute distributed load testing via K6 Cloud
 *
 * ┌───────────────────────────────────────────────────────────────────────────────┐
 * │ Test Design (RFC 7662 + Industry Standard Compliant)                         │
 * ├────────────────────┬───────┬─────────────┬─────────────────────────────────────┤
 * │ Type               │ Ratio │ Expected    │ Validation                          │
 * ├────────────────────┼───────┼─────────────┼─────────────────────────────────────┤
 * │ Active (Standard)  │ 60%   │ true        │ scope/sub integrity                 │
 * │ Active (TE)        │ 5%    │ true        │ act/resource claim (RFC 8693)       │
 * │ Expired            │ 12%   │ false       │ Immediate detection                 │
 * │ Revoked            │ 12%   │ false       │ Immediate detection                 │
 * │ Wrong audience     │ 6%    │ false       │ aud validation (strictValidation)   │
 * │ Wrong client       │ 5%    │ false       │ client_id validation (strictValid.) │
 * └────────────────────┴───────┴─────────────┴─────────────────────────────────────┘
 *
 * Threshold Design:
 * - active_correct: Match rate with expected > 99.9% (all tokens)
 * - false_positives/negatives: 0 (security requirement)
 * - introspect_success: HTTP 200 success rate > 99%
 *
 * K6 Cloud Execution:
 * 1. Upload seed data to R2
 * 2. Enable strictValidation=true
 * 3. k6 cloud --env PRESET=rps300 \
 *      --env TOKEN_URL=https://your-bucket/access_tokens.json \
 *      scripts/test-introspect-benchmark-cloud.js
 *
 * Local Execution (for debugging):
 * k6 run --env PRESET=rps100 \
 *   --env TOKEN_PATH=../seeds/access_tokens.json \
 *   scripts/test-introspect-benchmark-cloud.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

// Test identification
const TEST_NAME = 'Token Introspection Control Plane Test [Cloud]';
const TEST_ID = 'introspect-benchmark-cloud';

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
const exchangedTokenCorrect = new Rate('exchanged_token_correct');
const wrongAudienceRejected = new Rate('wrong_audience_rejected');
const wrongClientRejected = new Rate('wrong_client_rejected');

// Evaluation axis 3: scope/aud/sub/iss integrity verification
const claimIntegrity = new Rate('claim_integrity');
// Evaluation axis 5: Token Exchange act/resource claim verification
const actClaimPresent = new Rate('act_claim_present');
const resourceClaimPresent = new Rate('resource_claim_present');

// Environment variables
const BASE_URL = __ENV.BASE_URL || '';
const CLIENT_ID = __ENV.CLIENT_ID;
const CLIENT_SECRET = __ENV.CLIENT_SECRET;
const PRESET = __ENV.PRESET || 'rps300';
const TOKEN_PATH = __ENV.TOKEN_PATH || '../seeds/access_tokens.json';
const TOKEN_URL = __ENV.TOKEN_URL || '';

// K6 Cloud Project ID
const K6_CLOUD_PROJECT_ID = __ENV.K6_CLOUD_PROJECT_ID || '';

// Credentials validation
if (!CLIENT_ID || !CLIENT_SECRET) {
  throw new Error(
    'CLIENT_ID and CLIENT_SECRET are required. Set them via environment variables:\n' +
      '  k6 cloud --env CLIENT_ID=your_client_id --env CLIENT_SECRET=your_secret ...'
  );
}

/**
 * Token type distribution (RFC 7662 + Industry Standard Benchmark Compliant)
 */
const TOKEN_MIX = {
  valid: 0.6, // 60% - Standard access tokens
  valid_exchanged: 0.05, // 5%  - Token Exchange (with act claim)
  expired: 0.12, // 12% - Expired tokens
  revoked: 0.12, // 12% - Revoked tokens
  wrong_audience: 0.06, // 6%  - Valid signature, wrong aud
  wrong_client: 0.05, // 5%  - Issued by different client_id
};

/**
 * Preset Configuration - K6 Cloud Optimized Version
 *
 * Threshold Configuration:
 * - introspect_success: HTTP 200 success rate (> 99%)
 * - active_correct: Expected value match rate (> 99.9%) - All categories
 * - false_positives/negatives: Must be 0 (security requirement)
 */
const PRESETS = {
  // Lightweight test (for development/verification)
  rps100: {
    description: '100 RPS - Quick smoke test (30s)',
    stages: [
      { target: 50, duration: '10s' },
      { target: 100, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<800'],
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
      http_req_duration: ['p(95)<400', 'p(99)<600'],
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
    preAllocatedVUs: 400,
    maxVUs: 500,
  },

  // Benchmark: 500 RPS (3 min)
  rps500: {
    description: '500 RPS - Introspection mid-high throughput (3 min)',
    stages: [
      { target: 250, duration: '15s' },
      { target: 500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<400', 'p(99)<600'],
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
    preAllocatedVUs: 550,
    maxVUs: 700,
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
      http_req_duration: ['p(95)<400', 'p(99)<600'],
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

  // Benchmark: 750 RPS (3 min)
  rps750: {
    description: '750 RPS - Introspection high stress (3 min)',
    stages: [
      { target: 375, duration: '15s' },
      { target: 750, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<800'],
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
    preAllocatedVUs: 850,
    maxVUs: 1100,
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
      http_req_duration: ['p(95)<400', 'p(99)<600'],
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
      http_req_duration: ['p(95)<400', 'p(99)<600'],
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

// K6 options - Cloud optimized
export const options = {
  // K6 Cloud configuration
  cloud: {
    projectID: K6_CLOUD_PROJECT_ID || undefined,
    name: `${TEST_NAME} - ${PRESET}`,
    distribution: {
      // Distributed load test configuration - Execute from Portland (wnam region)
      'amazon:us:portland': { loadZone: 'amazon:us:portland', percent: 100 },
    },
  },
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

// Local mode: Load tokens via SharedArray
let allTokens = null;
let useRemoteData = false;

if (!TOKEN_URL) {
  try {
    allTokens = new SharedArray('all_tokens', function () {
      const raw = open(TOKEN_PATH);
      const data = JSON.parse(raw);
      return data.tokens;
    });

    const counts = {
      valid: allTokens.filter((t) => t.type === 'valid').length,
      valid_exchanged: allTokens.filter((t) => t.type === 'valid_exchanged').length,
      expired: allTokens.filter((t) => t.type === 'expired').length,
      revoked: allTokens.filter((t) => t.type === 'revoked').length,
      wrong_audience: allTokens.filter((t) => t.type === 'wrong_audience').length,
      wrong_client: allTokens.filter((t) => t.type === 'wrong_client').length,
    };

    console.log(`📂 Loaded tokens from local file:`);
    console.log(`   Valid:           ${counts.valid}`);
    console.log(`   Valid (TE/act):  ${counts.valid_exchanged}`);
    console.log(`   Expired:         ${counts.expired}`);
    console.log(`   Revoked:         ${counts.revoked}`);
    console.log(`   Wrong audience:  ${counts.wrong_audience}`);
    console.log(`   Wrong client:    ${counts.wrong_client}`);
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
 */
function getExpectedActive(tokenType) {
  return tokenType === 'valid' || tokenType === 'valid_exchanged';
}

/**
 * Select token type by weighted distribution
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
 * Select token by type
 */
function selectTokenByType(tokens, type, vuId) {
  const filtered = tokens.filter((t) => t.type === type);
  if (filtered.length === 0) {
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

  // Warmup
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

  const tokenType = selectTokenType();
  const tokenData = selectTokenByType(tokens, tokenType, __VU);
  const expectedActive = getExpectedActive(tokenData.type);

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

  introspectDuration.add(duration);

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

  // Active flag accuracy verification
  if (response.status === 200 && responseBody.active !== undefined) {
    const isCorrect = responseBody.active === expectedActive;
    activeCorrect.add(isCorrect ? 1 : 0);

    // Per-category metrics
    if (tokenData.type === 'valid_exchanged') {
      exchangedTokenCorrect.add(responseBody.active === true ? 1 : 0);

      if (responseBody.active === true) {
        const hasActClaim =
          responseBody.act !== undefined &&
          responseBody.act !== null &&
          typeof responseBody.act === 'object' &&
          responseBody.act.sub !== undefined;
        actClaimPresent.add(hasActClaim ? 1 : 0);

        const hasResourceClaim =
          responseBody.resource !== undefined &&
          typeof responseBody.resource === 'string' &&
          responseBody.resource.length > 0;
        resourceClaimPresent.add(hasResourceClaim ? 1 : 0);
      }
    }
    if (tokenData.type === 'wrong_audience') {
      wrongAudienceRejected.add(responseBody.active === false ? 1 : 0);
    }
    if (tokenData.type === 'wrong_client') {
      wrongClientRejected.add(responseBody.active === false ? 1 : 0);
    }

    // Evaluation axis 3: scope/aud/sub/iss integrity verification
    if (responseBody.active === true) {
      const hasScope = responseBody.scope !== undefined && responseBody.scope !== null;
      const hasAud = responseBody.aud !== undefined && responseBody.aud !== null;
      const hasSub = responseBody.sub !== undefined && responseBody.sub !== null;
      const hasIss = responseBody.iss !== undefined && responseBody.iss !== null;
      const hasClientId = responseBody.client_id !== undefined && responseBody.client_id !== null;

      const allClaimsPresent = hasScope && hasAud && hasSub && hasIss && hasClientId;
      claimIntegrity.add(allClaimsPresent ? 1 : 0);
    }

    if (!isCorrect) {
      if (responseBody.active === true && !expectedActive) {
        falsePositives.add(1);
        console.error(
          `⚠️  False Positive: Token type '${tokenData.type}' returned active=true (VU ${__VU})`
        );
      } else if (responseBody.active === false && expectedActive) {
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

  summary += `${indent}🎯 Preset: ${PRESET}\n`;
  summary += `${indent}📝 Description: ${selectedPreset.description}\n\n`;

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

  summary += `${indent}⏱️  Response Time:\n`;
  summary += `${indent}  Average: ${metrics.http_req_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p50: ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p90: ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p95: ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p99: ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p999: ${metrics.http_req_duration?.values?.['p(99.9)']?.toFixed(2) || 0}ms\n\n`;

  const activeCorrectRate = ((metrics.active_correct?.values?.rate || 0) * 100).toFixed(3);
  const fp = metrics.false_positives?.values?.count || 0;
  const fn = metrics.false_negatives?.values?.count || 0;

  summary += `${indent}🎯 Active Flag Accuracy:\n`;
  summary += `${indent}  Accuracy rate: ${activeCorrectRate}%\n`;
  summary += `${indent}  False Positives: ${fp}\n`;
  summary += `${indent}  False Negatives: ${fn}\n\n`;

  const exchangedRate = ((metrics.exchanged_token_correct?.values?.rate || 0) * 100).toFixed(2);
  const wrongAudRate = ((metrics.wrong_audience_rejected?.values?.rate || 0) * 100).toFixed(2);
  const wrongClientRate = ((metrics.wrong_client_rejected?.values?.rate || 0) * 100).toFixed(2);

  summary += `${indent}📋 Category Accuracy:\n`;
  summary += `${indent}  Token Exchange (act) correct: ${exchangedRate}%\n`;
  summary += `${indent}  Wrong audience rejected: ${wrongAudRate}%\n`;
  summary += `${indent}  Wrong client rejected: ${wrongClientRate}%\n\n`;

  const claimIntegrityRate = ((metrics.claim_integrity?.values?.rate || 0) * 100).toFixed(2);
  summary += `${indent}🔍 Axis 3 - Claim Integrity (scope/aud/sub/iss):\n`;
  summary += `${indent}  Integrity rate: ${claimIntegrityRate}%\n\n`;

  const actClaimRate = ((metrics.act_claim_present?.values?.rate || 0) * 100).toFixed(2);
  const resourceClaimRate = ((metrics.resource_claim_present?.values?.rate || 0) * 100).toFixed(2);
  summary += `${indent}🔄 Axis 5 - Token Exchange claims (RFC 8693):\n`;
  summary += `${indent}  act claim presence rate: ${actClaimRate}%\n`;
  summary += `${indent}  resource claim presence rate: ${resourceClaimRate}%\n\n`;

  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.introspect_success?.values?.rate || 0;

  const claimIntegrityRateNum = metrics.claim_integrity?.values?.rate || 0;
  const actClaimRateNum = metrics.act_claim_present?.values?.rate || 0;
  const resourceClaimRateNum = metrics.resource_claim_present?.values?.rate || 0;

  summary += `${indent}📋 RFC 7662 + Cloud Compliance Check:\n`;
  summary += `${indent}  Success rate > 99%: ${rate > 0.99 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 400ms: ${p95 < 400 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 600ms: ${p99 < 600 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  False Positive = 0: ${fp === 0 ? '✅ PASS' : '❌ FAIL'} (${fp})\n`;
  summary += `${indent}  False Negative = 0: ${fn === 0 ? '✅ PASS' : '❌ FAIL'} (${fn})\n`;
  summary += `${indent}  Claim integrity > 99%: ${claimIntegrityRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${claimIntegrityRate}%)\n`;
  summary += `${indent}  Token Exchange act > 99%: ${actClaimRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${actClaimRate}%)\n`;
  summary += `${indent}  Token Exchange resource > 99%: ${resourceClaimRateNum > 0.99 ? '✅ PASS' : '❌ FAIL'} (${resourceClaimRate}%)\n\n`;

  summary += `${indent}❌ Error Statistics:\n`;
  summary += `${indent}  Client auth errors (401): ${metrics.client_auth_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  Server errors (5xx): ${metrics.server_errors?.values?.count || 0}\n\n`;

  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 Throughput: ${rps.toFixed(2)} req/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
