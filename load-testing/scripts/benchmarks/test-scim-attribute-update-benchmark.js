/**
 * SCIM mapped-attribute PATCH load benchmark.
 * Required: BASE_URL, SCIM_TOKEN. Optional: TENANT_ID, PRESET, RUN_ID, POOL_SIZE.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const SCIM_TOKEN = __ENV.SCIM_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'default';
const PRESET = __ENV.PRESET || 'smoke';
const RUN_ID = (__ENV.RUN_ID || `run-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-');
const POOL_SIZE = Math.max(100, Math.min(10_000, Number.parseInt(__ENV.POOL_SIZE || '2000', 10)));
if (!BASE_URL || !SCIM_TOKEN) throw new Error('BASE_URL and SCIM_TOKEN are required');

const PRESETS = {
  smoke: { rate: 1, duration: '20s', preAllocatedVUs: 4, maxVUs: 20 },
  rps14: { rate: 14, duration: '1m', preAllocatedVUs: 180, maxVUs: 320 },
  rps28: { rate: 28, duration: '1m', preAllocatedVUs: 600, maxVUs: 900 },
  rps40: { rate: 40, duration: '1m', preAllocatedVUs: 900, maxVUs: 1200 },
};
const selected = PRESETS[PRESET] || PRESETS.smoke;

export const options = {
  setupTimeout: '2m',
  summaryTrendStats: ['avg', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    scim_attribute_update: {
      executor: 'constant-arrival-rate',
      rate: selected.rate,
      timeUnit: '1s',
      duration: selected.duration,
      preAllocatedVUs: selected.preAllocatedVUs,
      maxVUs: selected.maxVUs,
      tags: { test_id: 'scim-attribute-update' },
    },
  },
  thresholds: {
    dropped_iterations: ['count<1'],
    http_req_failed: ['rate<0.02'],
    scim_attribute_update_success: ['rate>0.98'],
    scim_attribute_update_conflicts: ['count<1'],
    scim_attribute_update_server_errors: ['count<1'],
  },
};

const updateSuccess = new Rate('scim_attribute_update_success');
const successfulUpdates = new Counter('scim_attribute_update_success_count');
const conflicts = new Counter('scim_attribute_update_conflicts');
const serverErrors = new Counter('scim_attribute_update_server_errors');
const networkFailures = new Counter('scim_attribute_update_network_failures');
const updateDuration = new Trend('scim_attribute_update_duration', true);
const headers = {
  Authorization: `Bearer ${SCIM_TOKEN}`,
  'Content-Type': 'application/scim+json',
  'X-Tenant-Id': TENANT_ID,
};

export function setup() {
  const users = [];
  for (let startIndex = 1; users.length < POOL_SIZE; startIndex += 100) {
    const response = http.get(
      `${BASE_URL}/scim/v2/Users?startIndex=${startIndex}&count=${Math.min(100, POOL_SIZE - users.length)}`,
      { headers, tags: { flow: 'setup_user_pool' } }
    );
    if (response.status !== 200) throw new Error(`SCIM user pool load failed: ${response.status}`);
    const body = response.json();
    const resources = Array.isArray(body.Resources) ? body.Resources : [];
    for (const resource of resources) {
      if (typeof resource.id === 'string') users.push(resource.id);
    }
    if (resources.length === 0 || users.length >= Number(body.totalResults || 0)) break;
  }
  if (users.length < 100) throw new Error(`SCIM update pool is too small: ${users.length}`);
  return { users };
}

export default function scimAttributeUpdate(data) {
  const sequence = exec.scenario.iterationInTest;
  const userId = data.users[sequence % data.users.length];
  const response = http.patch(
    `${BASE_URL}/scim/v2/Users/${encodeURIComponent(userId)}`,
    JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [
        {
          op: 'replace',
          path: 'displayName',
          value: `Attribute Update ${RUN_ID} ${sequence}`,
        },
      ],
    }),
    { headers, tags: { flow: 'attribute_patch' }, timeout: '60s' }
  );
  updateDuration.add(response.timings.duration);
  const success = response.status === 200;
  updateSuccess.add(success);
  if (success) successfulUpdates.add(1);
  if (response.status === 409 || response.status === 412) conflicts.add(1);
  if (response.status >= 500) serverErrors.add(1);
  if (response.status === 0) networkFailures.add(1);
}

export function handleSummary(data) {
  const completed = data.metrics.iterations?.values?.count ?? 0;
  const successRate = data.metrics.scim_attribute_update_success?.values?.rate ?? 0;
  const durationSeconds = selected.duration === '20s' ? 20 : 60;
  const effectiveRate = (completed / durationSeconds) * successRate;
  return {
    stdout: `${JSON.stringify(
      {
        test: 'SCIM mapped-attribute PATCH benchmark',
        preset: PRESET,
        runId: RUN_ID,
        target: BASE_URL,
        poolSize: data.setup_data?.users?.length ?? POOL_SIZE,
        peakVUs: data.metrics.vus?.values?.max ?? 0,
        configuredMaxVUs: selected.maxVUs,
        completedUpdates: completed,
        droppedUpdates: data.metrics.dropped_iterations?.values?.count ?? 0,
        successRate,
        effectiveUpdatesPerSecond: effectiveRate,
        estimatedHoursFor100k: effectiveRate > 0 ? 100_000 / effectiveRate / 3600 : null,
        p95DurationMs: data.metrics.scim_attribute_update_duration?.values?.['p(95)'] ?? 0,
        p99DurationMs: data.metrics.scim_attribute_update_duration?.values?.['p(99)'] ?? 0,
        conflicts: data.metrics.scim_attribute_update_conflicts?.values?.count ?? 0,
        serverErrors: data.metrics.scim_attribute_update_server_errors?.values?.count ?? 0,
        networkFailures: data.metrics.scim_attribute_update_network_failures?.values?.count ?? 0,
      },
      null,
      2
    )}\n`,
  };
}
