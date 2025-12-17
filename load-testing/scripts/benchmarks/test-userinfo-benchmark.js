/**
 * UserInfo Endpoint Benchmark Test
 *
 * Purpose:
 * - Measure maximum throughput of UserInfo API (/userinfo)
 * - Evaluate Bearer token authentication performance
 * - Comparison metrics with Auth0/Keycloak/Ory
 *
 * Test Specifications:
 * - Target: GET /userinfo
 * - Authentication: Authorization: Bearer {access_token}
 * - Success criteria: status 200 + sub claim present
 *
 * Usage:
 * k6 run --env PRESET=rps500 scripts/test-userinfo-benchmark.js
 * k6 run --env PRESET=rps1000 scripts/test-userinfo-benchmark.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

// Test identification
const TEST_NAME = 'UserInfo Endpoint Benchmark';
const TEST_ID = 'userinfo-benchmark';

// Custom metrics
const userinfoDuration = new Trend('userinfo_duration');
const userinfoSuccess = new Rate('userinfo_success');
const tokenErrors = new Counter('token_errors');
const rateLimitErrors = new Counter('rate_limit_errors');
const serverErrors = new Counter('server_errors');
const validationErrors = new Counter('validation_errors');

// Environment variables
const BASE_URL = __ENV.BASE_URL || '';
const PRESET = __ENV.PRESET || 'rps500';
const TOKEN_PATH = __ENV.TOKEN_PATH || '../seeds/access_tokens.json';
// For K6 Cloud: URL to fetch seed data from R2
const TOKEN_URL = __ENV.TOKEN_URL || '';

/**
 * Preset Configuration
 *
 * Specification compliance:
 * - RPS: 500, 1000, 1500, 2000
 * - Duration: 120 seconds
 * - Success rate: > 99.9%
 * - p95: < 200ms, p99: < 300ms
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
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.01'],
      userinfo_success: ['rate>0.99'],
    },
    preAllocatedVUs: 120,
    maxVUs: 150,
  },

  // Benchmark: 500 RPS (3 min)
  rps500: {
    description: '500 RPS - UserInfo benchmark (3 min)',
    stages: [
      { target: 250, duration: '15s' },
      { target: 500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 600,
    maxVUs: 800,
  },

  // Benchmark: 1000 RPS (3 min)
  rps1000: {
    description: '1000 RPS - UserInfo high throughput (3 min)',
    stages: [
      { target: 500, duration: '15s' },
      { target: 1000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 1200,
    maxVUs: 1500,
  },

  // Benchmark: 1500 RPS (3 min)
  rps1500: {
    description: '1500 RPS - UserInfo stress test (3 min)',
    stages: [
      { target: 750, duration: '15s' },
      { target: 1500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 1800,
    maxVUs: 2200,
  },

  // Benchmark: 2000 RPS (3 min)
  rps2000: {
    description: '2000 RPS - UserInfo maximum capacity (3 min)',
    stages: [
      { target: 1000, duration: '15s' },
      { target: 2000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<200', 'p(99)<300'],
      http_req_failed: ['rate<0.001'],
      userinfo_success: ['rate>0.999'],
    },
    preAllocatedVUs: 2400,
    maxVUs: 3000,
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
    userinfo_benchmark: {
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

// Local mode: Load tokens with SharedArray
let accessTokens = null;
let useRemoteData = false;

if (!TOKEN_URL) {
  try {
    accessTokens = new SharedArray('access_tokens', function () {
      const raw = open(TOKEN_PATH);
      const data = JSON.parse(raw);
      // Use only valid tokens
      return data.tokens.filter((t) => t.type === 'valid');
    });
    console.log(`📂 Loaded ${accessTokens.length} valid tokens from local file`);
  } catch (e) {
    console.warn(`⚠️  Failed to load local tokens: ${e.message}`);
    console.warn('   Make sure to run: node scripts/seed-access-tokens.js first');
  }
} else {
  useRemoteData = true;
  console.log('☁️  K6 Cloud mode: Will fetch tokens from URL');
}

// Setup (runs once before test starts)
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
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
    tokens = data.tokens.filter((t) => t.type === 'valid');
    console.log(`   Loaded ${tokens.length} valid tokens from remote`);
  } else if (accessTokens) {
    tokens = accessTokens;
  }

  if (tokens.length === 0) {
    throw new Error(
      'No valid tokens available. Run: node scripts/seed-access-tokens.js to generate tokens'
    );
  }

  // Warmup: Initialize DO with first few requests
  console.log(`🔥 Warming up...`);
  for (let i = 0; i < Math.min(10, tokens.length); i++) {
    const token = tokens[i];
    http.get(`${BASE_URL}/userinfo`, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
      },
      tags: { name: 'Warmup' },
    });
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    tokens: useRemoteData ? tokens : null,
    tokenCount: tokens.length,
    preset: PRESET,
    baseUrl: BASE_URL,
  };
}

// Main test function (executed repeatedly by each VU)
export default function (data) {
  const tokens = useRemoteData ? data.tokens : accessTokens;
  const tokenCount = data.tokenCount;

  // Select token based on VU ID (round robin)
  const tokenIndex = (__VU - 1) % tokenCount;
  const tokenData = tokens[tokenIndex];

  // /userinfo request
  const params = {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
    tags: {
      name: 'UserInfoRequest',
      preset: PRESET,
    },
  };

  const response = http.get(`${BASE_URL}/userinfo`, params);
  const duration = response.timings.duration;

  // Record metrics
  userinfoDuration.add(duration);

  // Response validation
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (_) {
    // ignore parse errors
  }

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has sub claim': () => responseBody.sub !== undefined,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  userinfoSuccess.add(success);

  // Error classification
  if (response.status === 401 || response.status === 403) {
    tokenErrors.add(1);
  }
  if (response.status === 429) {
    rateLimitErrors.add(1);
  }
  if (response.status >= 500) {
    serverErrors.add(1);
  }
  if (response.status === 200 && !responseBody.sub) {
    validationErrors.add(1);
  }

  // Debug (only on failure)
  if (!success && exec.vu.iterationInInstance < 3) {
    console.error(`❌ Check failed (VU ${__VU}, iter ${exec.vu.iterationInInstance}):`);
    console.error(`   status: ${response.status} (expected 200)`);
    console.error(`   has sub: ${responseBody.sub !== undefined}`);
    console.error(`   duration: ${response.timings.duration}ms`);
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
  const successRate = ((metrics.userinfo_success?.values?.rate || 0) * 100).toFixed(2);

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
  const rate = metrics.userinfo_success?.values?.rate || 0;

  summary += `${indent}📋 Specification Compliance Check:\n`;
  summary += `${indent}  Success rate > 99.9%: ${rate > 0.999 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 200ms: ${p95 < 200 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 300ms: ${p99 < 300 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n\n`;

  // Error statistics
  summary += `${indent}❌ Error Statistics:\n`;
  summary += `${indent}  Token errors (401/403): ${metrics.token_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  Server errors (5xx): ${metrics.server_errors?.values?.count || 0}\n`;
  summary += `${indent}  Validation errors: ${metrics.validation_errors?.values?.count || 0}\n\n`;

  // Throughput
  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 Throughput: ${rps.toFixed(2)} req/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
