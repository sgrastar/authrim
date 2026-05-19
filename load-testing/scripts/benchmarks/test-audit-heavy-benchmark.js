/**
 * Audit-heavy benchmark.
 *
 * Purpose:
 * - Measure audit sink behavior under high-volume token activity.
 * - Compare D1-primary audit profiles with queue/R2/archive-oriented profiles.
 * - Keep critical refresh-token replay/theft paths out of the default run.
 *
 * Seed first:
 *   BASE_URL=https://auth.example.com \
 *   CLIENT_ID=client \
 *   CLIENT_SECRET=secret \
 *   ADMIN_API_SECRET=... \
 *   COUNT=2000 \
 *   node load-testing/scripts/seeds/seed-refresh-tokens.js
 *
 * Run:
 *   k6 run \
 *     -e BASE_URL=https://auth.example.com \
 *     -e CLIENT_ID=client \
 *     -e CLIENT_SECRET=secret \
 *     -e PRESET=rps100 \
 *     load-testing/scripts/benchmarks/test-audit-heavy-benchmark.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

const TEST_NAME = 'Audit-heavy token activity benchmark';
const TEST_ID = 'audit-heavy';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const CLIENT_ID = __ENV.CLIENT_ID || 'test-client';
const CLIENT_SECRET = __ENV.CLIENT_SECRET || '';
const TENANT_ID = __ENV.TENANT_ID || 'default';
const PRESET = __ENV.PRESET || 'rps100';
const REFRESH_TOKEN_PATH = __ENV.REFRESH_TOKEN_PATH || '../seeds/refresh_tokens.json';

const PRESETS = {
  smoke: {
    rate: 5,
    duration: '30s',
    preAllocatedVUs: 10,
    maxVUs: 20,
    thresholds: {
      http_req_failed: ['rate<0.02'],
      http_req_duration: ['p(95)<1500'],
      audit_activity_success: ['rate>0.98'],
    },
  },
  rps100: {
    rate: 100,
    duration: '5m',
    preAllocatedVUs: 150,
    maxVUs: 300,
    thresholds: {
      http_req_failed: ['rate<0.01'],
      http_req_duration: ['p(95)<1000'],
      audit_activity_success: ['rate>0.99'],
    },
  },
  rps300: {
    rate: 300,
    duration: '5m',
    preAllocatedVUs: 400,
    maxVUs: 800,
    thresholds: {
      http_req_failed: ['rate<0.01'],
      http_req_duration: ['p(95)<1500'],
      audit_activity_success: ['rate>0.99'],
    },
  },
};

const selectedPreset = PRESETS[PRESET] || PRESETS.rps100;

export const options = {
  scenarios: {
    audit_heavy_refresh_rotation: {
      executor: 'constant-arrival-rate',
      rate: selectedPreset.rate,
      timeUnit: '1s',
      duration: selectedPreset.duration,
      preAllocatedVUs: selectedPreset.preAllocatedVUs,
      maxVUs: selectedPreset.maxVUs,
      tags: { test_id: TEST_ID, scenario: 'audit_heavy_refresh_rotation' },
    },
  },
  thresholds: selectedPreset.thresholds,
};

const refreshTokenFamilies = new SharedArray('audit_heavy_refresh_tokens', () => {
  const raw = open(REFRESH_TOKEN_PATH);
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('refresh token seed file is empty');
  }

  return parsed.map((item) => ({
    refreshToken: item.refresh_token || item.token,
    clientId: item.client_id || CLIENT_ID,
    clientSecret: item.client_secret || CLIENT_SECRET,
  }));
});

const auditActivitySuccess = new Rate('audit_activity_success');
const refreshSuccess = new Rate('audit_refresh_success');
const refreshDuration = new Trend('audit_refresh_duration');
const refreshErrors = new Counter('audit_refresh_errors');

const vuState = {};

function getVuTokenFamily() {
  const vuId = exec.vu.idInTest;

  if (!vuState[vuId]) {
    const index = (vuId - 1) % refreshTokenFamilies.length;
    vuState[vuId] = { ...refreshTokenFamilies[index] };
  }

  return vuState[vuId];
}

function buildBasicAuth(clientId, clientSecret) {
  if (!clientSecret) {
    return null;
  }
  return `Basic ${encoding.b64encode(`${clientId}:${clientSecret}`)}`;
}

export default function auditHeavyRefreshRotation() {
  const family = getVuTokenFamily();
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Tenant-Id': TENANT_ID,
  };
  const basicAuth = buildBasicAuth(family.clientId, family.clientSecret);

  if (basicAuth) {
    headers.Authorization = basicAuth;
  }

  const payloadParts = [
    'grant_type=refresh_token',
    `refresh_token=${encodeURIComponent(family.refreshToken)}`,
  ];

  if (!basicAuth) {
    payloadParts.push(`client_id=${encodeURIComponent(family.clientId)}`);
  }

  const started = Date.now();
  const response = http.post(`${BASE_URL}/token`, payloadParts.join('&'), {
    headers,
    tags: { test_id: TEST_ID, flow: 'refresh_token' },
  });
  const duration = Date.now() - started;

  refreshDuration.add(duration);

  let body = {};
  try {
    body = response.json();
  } catch {
    body = {};
  }

  const success = check(response, {
    'refresh status is 200': (r) => r.status === 200,
    'refresh token rotated': () =>
      typeof body.refresh_token === 'string' && body.refresh_token !== family.refreshToken,
  });

  refreshSuccess.add(success);
  auditActivitySuccess.add(success);

  if (success && body.refresh_token) {
    family.refreshToken = body.refresh_token;
  } else {
    refreshErrors.add(1);
  }
}

export function handleSummary(data) {
  const summary = {
    test: TEST_NAME,
    preset: PRESET,
    target: BASE_URL,
    tenantId: TENANT_ID,
    refreshTokenFamilies: refreshTokenFamilies.length,
    observedRequests: data.metrics.http_reqs?.values?.count ?? 0,
    observedRate: data.metrics.http_reqs?.values?.rate ?? 0,
    failedRate: data.metrics.http_req_failed?.values?.rate ?? 0,
    p95DurationMs: data.metrics.http_req_duration?.values?.['p(95)'] ?? 0,
    auditActivitySuccessRate: data.metrics.audit_activity_success?.values?.rate ?? 0,
    notes: [
      'Compare Cloudflare Analytics D1 read/write counts, AUDIT_QUEUE backlog/retries, and R2 object writes between audit profiles.',
      'Default run avoids intentional replay/theft events so refresh-token families remain usable across the test.',
    ],
  };

  return {
    stdout: `${JSON.stringify(summary, null, 2)}\n`,
  };
}
