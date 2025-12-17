/**
 * /token (refresh_token) Load Test
 *
 * Production-like design:
 * - Token Rotation enabled
 * - Each VU has an independent token family
 * - All normal rotation paths only (no error cases)
 * - Family depth = 1 for always rotating
 *
 * ===================================================================
 * Seed Generation (Required before test):
 * ===================================================================
 * Generate V3 sharding-compatible Refresh Tokens:
 *
 *   BASE_URL="https://your-authrim.example.com" \
 *   CLIENT_ID="<your-client-id>" \
 *   CLIENT_SECRET="<your-client-secret>" \
 *   ADMIN_API_SECRET="<your-admin-secret>" \
 *   COUNT=100 \
 *   CONCURRENCY=10 \
 *   node scripts/generate-refresh-tokens-parallel.js
 *
 * Set COUNT to maxVUs or higher (1 VU = 1 token family)
 * Output: seeds/refresh_tokens.json
 *
 * ===================================================================
 * Usage:
 * ===================================================================
 * k6 run --env PRESET=rps10 scripts/token-refresh.js   # Debug (10 RPS, 40s)
 * k6 run --env PRESET=rps100 scripts/token-refresh.js  # Production baseline (100 RPS)
 * k6 run --env PRESET=rps300 scripts/token-refresh.js  # Benchmark (300 RPS)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';

// Test identification
const TEST_NAME = '/token (refresh_token)';
const TEST_ID = 'token-refresh';

// Custom metrics
const tokenRequestDuration = new Trend('token_request_duration');
const tokenRequestSuccess = new Rate('token_request_success');
const tokenRotationSuccess = new Rate('token_rotation_success');
const authErrors = new Counter('auth_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');
const d1WriteErrors = new Counter('d1_write_errors');
const familyDepthMetric = new Trend('token_family_depth');

// Environment variables
const BASE_URL = __ENV.BASE_URL || '';
const CLIENT_ID = __ENV.CLIENT_ID || 'test_client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || 'test_secret';
const PRESET = __ENV.PRESET || 'rps100';
const REFRESH_TOKEN_PATH = __ENV.REFRESH_TOKEN_PATH || '../seeds/refresh_tokens.json';

// Preset Configuration
const PRESETS = {
  // Debug: 10 RPS light test
  rps10: {
    description: '10 RPS light load - Debug/validation test (30s)',
    stages: [
      { target: 10, duration: '5s' },
      { target: 10, duration: '30s' },
      { target: 0, duration: '5s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.05'],
      token_request_duration: ['p(99)<1000'],
      token_rotation_success: ['rate>0.95'],
      d1_write_errors: ['count<5'],
    },
    preAllocatedVUs: 10,
    maxVUs: 15,
    thinkTime: 0,
  },
  rps100: {
    description: '100 RPS sustained load - Production baseline',
    stages: [
      { target: 50, duration: '30s' },
      { target: 100, duration: '30s' },
      { target: 100, duration: '120s' },
      { target: 50, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<300'],
      token_rotation_success: ['rate>0.99'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 100,
    maxVUs: 120,
    thinkTime: 0,
  },
  rps200: {
    description: '200 RPS sustained load - High traffic scenario',
    stages: [
      { target: 100, duration: '30s' },
      { target: 200, duration: '30s' },
      { target: 200, duration: '120s' },
      { target: 100, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<400'],
      token_rotation_success: ['rate>0.99'],
      d1_write_errors: ['count<2'],
    },
    preAllocatedVUs: 200,
    maxVUs: 240,
    thinkTime: 0,
  },
  // Standard Benchmark: 300 RPS for 2 minutes
  rps300: {
    description: '300 RPS sustained load - Standard benchmark (2 min)',
    stages: [
      { target: 300, duration: '10s' },
      { target: 300, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<500'],
      token_rotation_success: ['rate>0.999'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 300,
    maxVUs: 360,
    thinkTime: 0,
  },
  // High VU Benchmark: 300 RPS for 2 min (3x VUs to avoid queueing)
  rps300_highvu: {
    description: '300 RPS with 3x VUs - Reduced queueing latency',
    stages: [
      { target: 300, duration: '10s' },
      { target: 300, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<500'],
      token_rotation_success: ['rate>0.999'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 900,
    maxVUs: 1080,
    thinkTime: 0,
  },
  // VU500 Benchmark: 300 RPS for 2 min (Ethernet optimized)
  rps300_vu500: {
    description: '300 RPS with 500 VUs - Ethernet optimized',
    stages: [
      { target: 300, duration: '10s' },
      { target: 300, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.001'],
      token_request_duration: ['p(99)<500'],
      token_rotation_success: ['rate>0.999'],
      d1_write_errors: ['count<1'],
    },
    preAllocatedVUs: 500,
    maxVUs: 600,
    thinkTime: 0,
  },
  // 1000 RPS Benchmark: 1000 RPS for 2 minutes
  rps1000: {
    description: '1000 RPS sustained load - High throughput benchmark (2 min)',
    stages: [
      { target: 500, duration: '10s' },
      { target: 1000, duration: '10s' },
      { target: 1000, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.01'],
      token_request_duration: ['p(99)<1000'],
      token_rotation_success: ['rate>0.99'],
      d1_write_errors: ['count<10'],
    },
    preAllocatedVUs: 1500,
    maxVUs: 2000,
    thinkTime: 0,
  },
  // 2000 RPS Benchmark: 2000 RPS for 2 minutes
  rps2000: {
    description: '2000 RPS sustained load - Extreme throughput benchmark (2 min)',
    stages: [
      { target: 1000, duration: '10s' },
      { target: 2000, duration: '10s' },
      { target: 2000, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<600', 'p(99)<1200'],
      http_req_failed: ['rate<0.02'],
      token_request_duration: ['p(99)<1200'],
      token_rotation_success: ['rate>0.98'],
      d1_write_errors: ['count<20'],
    },
    preAllocatedVUs: 3000,
    maxVUs: 4000,
    thinkTime: 0,
  },
  // 3000 RPS Benchmark: 3000 RPS for 2 min (48 shards test)
  rps3000: {
    description: '3000 RPS sustained load - 48 shards test (2 min)',
    stages: [
      { target: 1500, duration: '10s' },
      { target: 3000, duration: '10s' },
      { target: 3000, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<800', 'p(99)<1500'],
      http_req_failed: ['rate<0.03'],
      token_request_duration: ['p(99)<1500'],
      token_rotation_success: ['rate>0.97'],
      d1_write_errors: ['count<30'],
    },
    preAllocatedVUs: 3000,
    maxVUs: 4000,
    thinkTime: 0,
  },
  // 4000 RPS Benchmark: 4000 RPS for 2 min (48 shards limit test)
  rps4000: {
    description: '4000 RPS sustained load - 48 shards limit test (2 min)',
    stages: [
      { target: 2000, duration: '10s' },
      { target: 4000, duration: '10s' },
      { target: 4000, duration: '120s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<1000', 'p(99)<2000'],
      http_req_failed: ['rate<0.05'],
      token_request_duration: ['p(99)<2000'],
      token_rotation_success: ['rate>0.95'],
      d1_write_errors: ['count<50'],
    },
    preAllocatedVUs: 3000,
    maxVUs: 3500,  // Time series limit mitigation: reduced from 5000 to 3500 due to 40,000 limit
    thinkTime: 0,
  },
};

// Selected preset
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Invalid PRESET "${PRESET}". Use one of: ${Object.keys(PRESETS).join(', ')}`);
}

// Test data: Pre-generated Refresh Tokens
const refreshTokens = new SharedArray('refresh_tokens', function () {
  try {
    const raw = open(REFRESH_TOKEN_PATH);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('refresh_tokens is empty');
    }
    const normalized = parsed
      .map((item, idx) => ({
        token: item.refresh_token || item.token,
        client_id: item.client_id,
        client_secret: item.client_secret,
        userId: item.user_id || item.userId || `user_${idx}`,
      }))
      .filter((item) => item.token);

    if (normalized.length === 0) {
      throw new Error('refresh_tokens has no usable entries');
    }
    return normalized;
  } catch (err) {
    throw new Error(
      `Refresh token seed not found or invalid at "${REFRESH_TOKEN_PATH}". Run scripts/generate-seeds.js to create it. (${err.message})`
    );
  }
});
if (!refreshTokens.length) {
  throw new Error(`No refresh tokens available for ${TEST_ID}. Aborting.`);
}
if (refreshTokens.length < selectedPreset.maxVUs) {
  throw new Error(
    `Not enough refresh tokens for preset "${PRESET}". Required at least ${selectedPreset.maxVUs} (max VUs), found ${refreshTokens.length}. Increase REFRESH_COUNT or lower maxVUs.`
  );
}

// Test options
export const options = {
  // K6 Cloud configuration
  cloud: {
    projectID: 5942435,
    name: `Authrim - Token Refresh (${PRESET})`,
    distribution: {
      'amazon:jp:tokyo': { loadZone: 'amazon:jp:tokyo', percent: 100 },
    },
  },
  scenarios: {
    token_refresh: {
      executor: 'ramping-arrival-rate',
      startRate: selectedPreset.stages[0].target,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
    },
  },
  thresholds: selectedPreset.thresholds,
};

// Independent token family per VU (set during VU initialization)
let vuTokenFamily = null;
let familyDepth = 0;
let hasLoggedServerError = false;

/**
 * K6 Cloud Support: Global VU Index Calculation
 *
 * K6 Cloud runs distributed across multiple instances (load generators),
 * but __VU is numbered locally within each instance (1, 2, 3...).
 * Therefore, we use instance ID to calculate an offset and
 * assign a globally unique token index.
 *
 * @param localVuId - Local VU ID (__VU)
 * @param tokenPoolSize - Total size of token pool
 * @returns Globally unique token index
 */
function getGlobalTokenIndex(localVuId, tokenPoolSize) {
  // K6 Cloud: Get instance ID from environment variable
  const instanceId = __ENV.K6_CLOUDRUN_INSTANCE_ID;

  if (instanceId !== undefined && instanceId !== '') {
    // K6 Cloud mode: Calculate offset using instance ID
    const id = parseInt(instanceId, 10);
    // Evenly divide token pool across instances (assuming max 10 instances)
    const maxInstances = 10;
    const tokensPerInstance = Math.floor(tokenPoolSize / maxInstances);
    const offset = id * tokensPerInstance;

    // Debug log only on first VU
    if (localVuId === 1) {
      console.log(`[K6 Cloud] instance=${id}, tokensPerInstance=${tokensPerInstance}, offset=${offset}`);
    }

    return offset + localVuId - 1;
  }

  // Local mode: No offset
  return localVuId - 1;
}

// Setup
export function setup() {
  console.log(`🚀 ${TEST_NAME} Load Test`);
  console.log(`📊 Preset: ${PRESET}`);
  console.log(`📝 Description: ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`📦 Refresh Token pool: ${refreshTokens.length}`);
  console.log(``);
  console.log(`✨ Production-like design:`);
  console.log(`   - Token Rotation enabled`);
  console.log(`   - Independent token family per VU`);
  console.log(`   - All normal rotation paths (no error cases)`);
  console.log(
    `   - Token pool: ${refreshTokens.length} (requires >= ${selectedPreset.maxVUs} for 1 token/VU)`
  );

  return {
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    preset: PRESET,
  };
}

// Main test function
export default function (data) {
  // First VU execution: Get independent token family
  if (!vuTokenFamily) {
    const vuId = __VU;
    // K6 Cloud support: Calculate globally unique token index
    const tokenIndex = getGlobalTokenIndex(vuId, refreshTokens.length);

    if (tokenIndex >= refreshTokens.length || tokenIndex < 0) {
      throw new Error(
        `No refresh token available. tokenIndex=${tokenIndex}, VU=${vuId}, pool=${refreshTokens.length}, instance=${__ENV.K6_CLOUDRUN_INSTANCE_ID || 'local'}`
      );
    }

    vuTokenFamily = {
      ...refreshTokens[tokenIndex],
      vuId: vuId,
      globalIndex: tokenIndex, // For debugging: record global index
    };
    familyDepth = 0;
    hasLoggedServerError = false;

    // Debug log for initial assignment
    console.log(`[VU ${vuId}] Assigned token index: ${tokenIndex}`);
  }

  // Generate Basic auth header
  const credentials = `${vuTokenFamily.client_id}:${vuTokenFamily.client_secret}`;
  const basicAuth = `Basic ${encoding.b64encode(credentials)}`;

  // /token request parameters
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Connection: 'keep-alive',
      Authorization: basicAuth,
    },
    tags: {
      name: 'TokenRefreshRequest',
      preset: PRESET,
      vuId: vuTokenFamily.vuId,
    },
  };

  const payload = `grant_type=refresh_token&refresh_token=${vuTokenFamily.token}`;

  // Send request
  const response = http.post(`${BASE_URL}/token`, payload, params);
  const duration = response.timings.duration;

  // Record metrics
  tokenRequestDuration.add(duration);

  // Response check
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (e) {
    // JSON parse error
  }

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has access_token': (r) => responseBody.access_token !== undefined,
    'has refresh_token': (r) => responseBody.refresh_token !== undefined,
    'token_type is Bearer': (r) => responseBody.token_type === 'Bearer',
    'new refresh_token differs (rotation)': (r) => {
      if (responseBody.refresh_token) {
        return responseBody.refresh_token !== vuTokenFamily.token;
      }
      return false;
    },
  });

  tokenRequestSuccess.add(success);

  // Token Rotation success check
  if (success && responseBody.refresh_token && responseBody.refresh_token !== vuTokenFamily.token) {
    tokenRotationSuccess.add(1);

    // Update token family (use new token next time)
    vuTokenFamily.token = responseBody.refresh_token;
    familyDepth++;
    familyDepthMetric.add(familyDepth);
  } else {
    tokenRotationSuccess.add(0);

    // Debug info on rotation failure (rps100 only)
    if (!success && PRESET === 'rps100') {
      console.error(`❌ Token rotation failed for VU ${vuTokenFamily.vuId}:`);
      console.error(`   Status: ${response.status}`);
      console.error(`   Response: ${response.body}`);
    }
  }

  // Error handling
  if (response.status === 401 || response.status === 403) {
    authErrors.add(1);
  }
  if (response.status === 429) {
    rateLimitErrors.add(1);
  }
  if (response.status >= 500) {
    serverErrors.add(1);
    if (!hasLoggedServerError) {
      console.error(
        `❌ 5xx from /token (VU ${vuTokenFamily.vuId}): status=${response.status}, body=${response.body}`
      );
      hasLoggedServerError = true;
    }

    // Possible D1 write error
    if (
      response.status === 500 &&
      (response.body.includes('D1') || response.body.includes('database'))
    ) {
      d1WriteErrors.add(1);
    }
  }

  // Think Time (usually 0)
  if (selectedPreset.thinkTime > 0) {
    sleep(selectedPreset.thinkTime);
  }
}

// Teardown
export function teardown(data) {
  console.log(``);
  console.log(`✅ ${TEST_NAME} Test completed`);
  console.log(`📊 Preset: ${data.preset}`);
  console.log(`🎯 Target: ${data.baseUrl}`);
}

// Summary handler
export function handleSummary(data) {
  const preset = PRESET;
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\..+/, '')
    .replace('T', '_');
  const resultsDir = __ENV.RESULTS_DIR || '../results';

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

  summary += `${indent}📈 Request Statistics:\n`;
  summary += `${indent}  Total requests: ${totalRequests}\n`;
  summary += `${indent}  Success: ${successRequests}\n`;
  summary += `${indent}  Failed: ${failedRequests}\n`;
  summary += `${indent}  Failure rate: ${((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2)}%\n\n`;

  // Response time
  summary += `${indent}⏱️  Response Time:\n`;
  summary += `${indent}  Average: ${metrics.http_req_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p50: ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p90: ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p95: ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p99: ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n\n`;

  // Token Rotation statistics
  if (metrics.token_rotation_success) {
    const rotationRate = metrics.token_rotation_success.values.rate * 100;
    summary += `${indent}🔄 Token Rotation:\n`;
    summary += `${indent}  Success rate: ${rotationRate.toFixed(2)}%\n`;
    summary += `${indent}  Success count: ${metrics.token_rotation_success.values.passes || 0}\n`;
    summary += `${indent}  Failure count: ${metrics.token_rotation_success.values.fails || 0}\n`;

    if (metrics.token_family_depth) {
      summary += `${indent}  Family Depth average: ${metrics.token_family_depth.values.avg?.toFixed(2) || 0}\n`;
      summary += `${indent}  Family Depth max: ${metrics.token_family_depth.values.max || 0}\n`;
    }
    summary += '\n';
  }

  // Error statistics
  summary += `${indent}❌ Error Statistics:\n`;
  summary += `${indent}  Auth errors (401/403): ${metrics.auth_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate Limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  Server errors (5xx): ${metrics.server_errors?.values?.count || 0}\n`;
  summary += `${indent}  D1 write errors: ${metrics.d1_write_errors?.values?.count || 0}\n\n`;

  // Verdict
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const errorRate = (metrics.http_req_failed?.values?.rate || 0) * 100;
  const rotationRate = (metrics.token_rotation_success?.values?.rate || 0) * 100;
  const d1Errors = metrics.d1_write_errors?.values?.count || 0;

  summary += `${indent}✅ Verdict:\n`;

  // Determine by per-preset thresholds
  let p95Threshold, p99Threshold, errorThreshold, rotationThreshold, d1Threshold;
  if (PRESET === 'rps100') {
    p95Threshold = 200;
    p99Threshold = 300;
    errorThreshold = 0.1;
    rotationThreshold = 99;
    d1Threshold = 0;
  } else if (PRESET === 'rps200') {
    p95Threshold = 250;
    p99Threshold = 400;
    errorThreshold = 0.1;
    rotationThreshold = 99;
    d1Threshold = 2;
  } else if (PRESET === 'rps300' || PRESET === 'rps300_highvu' || PRESET === 'rps300_vu500') {
    p95Threshold = 300;
    p99Threshold = 500;
    errorThreshold = 0.1;
    rotationThreshold = 99.9;
    d1Threshold = 1;
  } else if (PRESET === 'rps1000') {
    p95Threshold = 500;
    p99Threshold = 1000;
    errorThreshold = 1.0;
    rotationThreshold = 99;
    d1Threshold = 10;
  } else if (PRESET === 'rps10') {
    p95Threshold = 500;
    p99Threshold = 1000;
    errorThreshold = 5.0;
    rotationThreshold = 95;
    d1Threshold = 5;
  } else {
    p95Threshold = 300;
    p99Threshold = 500;
    errorThreshold = 0.5;
    rotationThreshold = 98;
    d1Threshold = 5;
  }

  const p95Pass = p95 < p95Threshold;
  const p99Pass = p99 < p99Threshold;
  const errorPass = errorRate < errorThreshold;
  const rotationPass = rotationRate > rotationThreshold;
  const d1Pass = d1Errors <= d1Threshold;
  const pass = p95Pass && p99Pass && errorPass && rotationPass && d1Pass;

  summary += `${indent}  ${pass ? '✅ PASS' : '❌ FAIL'}\n`;
  summary += `${indent}  - p95 < ${p95Threshold}ms: ${p95Pass ? '✅' : '❌'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  - p99 < ${p99Threshold}ms: ${p99Pass ? '✅' : '❌'} (${p99.toFixed(2)}ms)\n`;
  summary += `${indent}  - Error rate < ${errorThreshold}%: ${errorPass ? '✅' : '❌'} (${errorRate.toFixed(2)}%)\n`;
  summary += `${indent}  - Rotation success rate > ${rotationThreshold}%: ${rotationPass ? '✅' : '❌'} (${rotationRate.toFixed(2)}%)\n`;
  summary += `${indent}  - D1 errors <= ${d1Threshold}: ${d1Pass ? '✅' : '❌'} (${d1Errors})\n`;

  summary += `${indent}\n${'='.repeat(70)}\n`;

  return summary;
}
