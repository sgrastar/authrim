/**
 * UserInfo Endpoint Benchmark Test - K6 Cloud Edition
 *
 * Purpose:
 * - Measure maximum throughput of UserInfo API (/userinfo)
 * - Evaluate Bearer token authentication performance
 * - Benchmark comparison with Auth0/Keycloak/Ory
 * - **Execute distributed load testing via K6 Cloud**
 *
 * Test Specification:
 * - Target: GET /userinfo
 * - Authentication: Authorization: Bearer {access_token}
 * - Success Criteria: status 200 + sub claim present
 *
 * K6 Cloud Execution:
 * 1. Set K6_CLOUD_TOKEN environment variable
 * 2. k6 cloud --env PRESET=rps500 scripts/test-userinfo-benchmark-cloud.js
 *
 * Local Execution (for debugging):
 * k6 run --env PRESET=rps100 scripts/test-userinfo-benchmark-cloud.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import exec from 'k6/execution';

// Test identification
const TEST_NAME = 'UserInfo Endpoint Benchmark [Cloud]';
const TEST_ID = 'userinfo-benchmark-cloud';

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
// K6 Cloud: URL to fetch seed data from R2
// Note: Due to K6 setup() 4MB limit, fetch only valid tokens file from URL
// TOKEN_URL environment variable required
const TOKEN_URL = __ENV.TOKEN_URL || '';

// K6 Cloud Project ID (can be overridden via environment variable)
const K6_CLOUD_PROJECT_ID = __ENV.K6_CLOUD_PROJECT_ID || '';

/**
 * Preset Configuration - K6 Cloud Optimized Version
 *
 * K6 Cloud distributed execution enables higher RPS than local version
 * - No client-side TCP limitations
 * - Distributed load from multiple regions
 *
 * Compliance Requirements:
 * - Success rate: > 99.9%
 * - p95: < 200ms, p99: < 300ms
 */
const PRESETS = {
  // Lightweight test (smoke test)
  rps100: {
    description: '100 RPS - Cloud smoke test (1 min)',
    stages: [
      { target: 50, duration: '10s' },
      { target: 100, duration: '60s' },
      { target: 0, duration: '10s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.01'],
      userinfo_success: ['rate>0.99'],
    },
    preAllocatedVUs: 150,
    maxVUs: 200,
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

  // Benchmark: 2500 RPS (3 min)
  rps2500: {
    description: '2500 RPS - UserInfo capacity limit (3 min)',
    stages: [
      { target: 1250, duration: '15s' },
      { target: 2500, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<250', 'p(99)<400'],
      http_req_failed: ['rate<0.002'],
      userinfo_success: ['rate>0.998'],
    },
    preAllocatedVUs: 3000,
    maxVUs: 3800,
  },

  // Benchmark: 3000 RPS (3 min)
  rps3000: {
    description: '3000 RPS - UserInfo high stress (3 min)',
    stages: [
      { target: 1500, duration: '15s' },
      { target: 3000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<300', 'p(99)<500'],
      http_req_failed: ['rate<0.005'],
      userinfo_success: ['rate>0.995'],
    },
    preAllocatedVUs: 3600,
    maxVUs: 4500,
  },

  // Benchmark: 4000 RPS (3 min)
  rps4000: {
    description: '4000 RPS - UserInfo extreme (3 min)',
    stages: [
      { target: 2000, duration: '15s' },
      { target: 4000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<800'],
      http_req_failed: ['rate<0.01'],
      userinfo_success: ['rate>0.99'],
    },
    preAllocatedVUs: 4800,
    maxVUs: 6000,
  },

  // Benchmark: 5000 RPS (3 min)
  rps5000: {
    description: '5000 RPS - UserInfo ultimate (3 min)',
    stages: [
      { target: 2500, duration: '15s' },
      { target: 5000, duration: '180s' },
      { target: 0, duration: '15s' },
    ],
    thresholds: {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.02'],
      userinfo_success: ['rate>0.98'],
    },
    preAllocatedVUs: 6000,
    maxVUs: 7500,
  },
};

// Preset validation
const selectedPreset = PRESETS[PRESET];
if (!selectedPreset) {
  throw new Error(`Unknown preset: ${PRESET}. Available: ${Object.keys(PRESETS).join(', ')}`);
}

// Warmup settings
const WARMUP_DURATION = '30s';
const WARMUP_RPS = 50;
const WARMUP_VUS = 100;

// Extract target RPS (parsed from preset name)
const targetRps = parseInt(PRESET.replace('rps', ''), 10) || 500;

// K6 options - 2 scenario configuration: warmup + main benchmark
export const options = {
  scenarios: {
    // Scenario 1: Warmup (cold start mitigation)
    warmup: {
      executor: 'constant-arrival-rate',
      rate: WARMUP_RPS,
      timeUnit: '1s',
      duration: WARMUP_DURATION,
      preAllocatedVUs: WARMUP_VUS,
      maxVUs: WARMUP_VUS * 2,
      tags: { scenario: 'warmup' },
      exec: 'warmupScenario',
    },
    // Scenario 2: Main benchmark (starts after warmup)
    userinfo_benchmark: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      stages: selectedPreset.stages,
      startTime: WARMUP_DURATION, // Starts after warmup completes
      tags: { scenario: 'benchmark' },
      exec: 'benchmarkScenario',
    },
  },
  thresholds: {
    // Apply thresholds only to benchmark scenario
    'http_req_duration{scenario:benchmark}': selectedPreset.thresholds.http_req_duration,
    'http_req_failed{scenario:benchmark}': selectedPreset.thresholds.http_req_failed,
    'userinfo_success{scenario:benchmark}': selectedPreset.thresholds.userinfo_success,
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  // K6 Cloud configuration
  cloud: {
    projectID: K6_CLOUD_PROJECT_ID ? parseInt(K6_CLOUD_PROJECT_ID, 10) : undefined,
    name: `${TEST_ID}-${PRESET}`,
    distribution: {
      // US Oregon region to test DO location hypothesis
      'amazon:us:portland': { loadZone: 'amazon:us:portland', percent: 100 },
    },
  },
};

// Setup (runs once before test starts)
export function setup() {
  console.log(``);
  console.log(`🚀 ${TEST_NAME}`);
  console.log(`📋 Preset: ${PRESET} - ${selectedPreset.description}`);
  console.log(`🎯 Target: ${BASE_URL}`);
  console.log(`☁️  K6 Cloud Mode: Fetching tokens from R2`);
  console.log(``);

  // K6 Cloud: Fetch tokens from R2
  // Format: Array of token strings (K6 setup() 4MB limit compliant)
  console.log(`📥 Fetching tokens from: ${TOKEN_URL}`);
  const response = http.get(TOKEN_URL, { timeout: '120s' });
  if (response.status !== 200) {
    throw new Error(`Failed to fetch tokens: ${response.status} - ${response.body}`);
  }

  const tokens = JSON.parse(response.body); // Array: ["eyJ...", "eyJ...", ...]
  console.log(`   Loaded ${tokens.length} valid tokens from R2`);

  if (tokens.length === 0) {
    throw new Error('No valid tokens found in R2. Upload valid_tokens_4k.json to R2 first.');
  }

  // Warmup: Initialize DO with first few requests
  console.log(`🔥 Warming up...`);
  for (let i = 0; i < Math.min(10, tokens.length); i++) {
    const token = tokens[i];
    http.get(`${BASE_URL}/userinfo`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'Warmup' },
    });
  }
  console.log(`   Warmup complete`);
  console.log(``);

  return {
    tokens: tokens,
    tokenCount: tokens.length,
    preset: PRESET,
    baseUrl: BASE_URL,
  };
}

// Common UserInfo request processing
function executeUserInfoRequest(data, scenarioTag) {
  const tokens = data.tokens;
  const tokenCount = data.tokenCount;

  // Select token based on VU ID (round-robin)
  const tokenIndex = (__VU - 1) % tokenCount;
  const token = tokens[tokenIndex]; // Use directly as string

  // /userinfo request
  const params = {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Connection: 'keep-alive',
    },
    tags: {
      name: 'UserInfoRequest',
      preset: PRESET,
      scenario: scenarioTag,
    },
  };

  const response = http.get(`${BASE_URL}/userinfo`, params);
  const duration = response.timings.duration;

  // Record metrics
  userinfoDuration.add(duration, { scenario: scenarioTag });

  // Response validation
  let responseBody = {};
  try {
    responseBody = JSON.parse(response.body);
  } catch (_) {
    // ignore parse errors
  }

  // Compliance: Validate sub / email_verified claims
  const success = check(
    response,
    {
      'status is 200': (r) => r.status === 200,
      'has sub claim': () => responseBody.sub !== undefined,
      'has email_verified claim': () => responseBody.email_verified !== undefined,
      'response time < 500ms': (r) => r.timings.duration < 500,
    },
    { scenario: scenarioTag }
  );

  userinfoSuccess.add(success, { scenario: scenarioTag });

  // Error classification
  if (response.status === 401 || response.status === 403) {
    tokenErrors.add(1, { scenario: scenarioTag });
  }
  if (response.status === 429) {
    rateLimitErrors.add(1, { scenario: scenarioTag });
  }
  if (response.status >= 500) {
    serverErrors.add(1, { scenario: scenarioTag });
  }
  if (!success) {
    validationErrors.add(1, { scenario: scenarioTag });
  }
}

// Warmup scenario (cold start mitigation)
export function warmupScenario(data) {
  executeUserInfoRequest(data, 'warmup');
}

// Main benchmark scenario (thresholds applied)
export function benchmarkScenario(data) {
  executeUserInfoRequest(data, 'benchmark');
}

// K6 Cloud only calls scenario functions specified via exec
// default is not needed. Kept minimal for local debugging
export default function () {
  // This function is not called in K6 Cloud execution (when exec is specified)
  // Fallback for local k6 run execution
  console.log('Warning: default function should not be called in Cloud mode');
}

// Teardown (runs once after test ends)
export function teardown(data) {
  console.log(``);
  console.log(`✅ ${TEST_NAME} Test Complete`);
  console.log(`📊 Preset: ${data.preset}`);
  console.log(`🎯 Target: ${data.baseUrl}`);
  console.log(`📈 Token Count: ${data.tokenCount}`);
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
  summary += `${indent}  Total Requests: ${totalRequests}\n`;
  summary += `${indent}  Success: ${successRequests}\n`;
  summary += `${indent}  Failed: ${failedRequests}\n`;
  summary += `${indent}  Success Rate: ${successRate}%\n\n`;

  // Response time
  summary += `${indent}⏱️  Response Time:\n`;
  summary += `${indent}  Average: ${metrics.http_req_duration?.values?.avg?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p50: ${metrics.http_req_duration?.values?.['p(50)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p90: ${metrics.http_req_duration?.values?.['p(90)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p95: ${metrics.http_req_duration?.values?.['p(95)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p99: ${metrics.http_req_duration?.values?.['p(99)']?.toFixed(2) || 0}ms\n`;
  summary += `${indent}  p999: ${metrics.http_req_duration?.values?.['p(99.9)']?.toFixed(2) || 0}ms\n\n`;

  // Compliance check
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const rate = metrics.userinfo_success?.values?.rate || 0;

  summary += `${indent}📋 Compliance Check:\n`;
  summary += `${indent}  Success Rate > 99.9%: ${rate > 0.999 ? '✅ PASS' : '❌ FAIL'} (${successRate}%)\n`;
  summary += `${indent}  p95 < 200ms: ${p95 < 200 ? '✅ PASS' : '❌ FAIL'} (${p95.toFixed(2)}ms)\n`;
  summary += `${indent}  p99 < 300ms: ${p99 < 300 ? '✅ PASS' : '❌ FAIL'} (${p99.toFixed(2)}ms)\n\n`;

  // Error statistics
  summary += `${indent}❌ Error Statistics:\n`;
  summary += `${indent}  Token Errors (401/403): ${metrics.token_errors?.values?.count || 0}\n`;
  summary += `${indent}  Rate Limit (429): ${metrics.rate_limit_errors?.values?.count || 0}\n`;
  summary += `${indent}  Server Errors (5xx): ${metrics.server_errors?.values?.count || 0}\n`;
  summary += `${indent}  Validation Errors: ${metrics.validation_errors?.values?.count || 0}\n\n`;

  // Throughput
  const rps = metrics.http_reqs?.values?.rate || 0;
  summary += `${indent}🚀 Throughput: ${rps.toFixed(2)} req/s\n`;

  summary += `${indent}${'='.repeat(70)}\n`;

  return summary;
}
