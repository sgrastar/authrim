/**
 * SCIM Bulk mapped-attribute PATCH load benchmark.
 * Required: BASE_URL, SCIM_TOKEN. Optional: TENANT_ID, PRESET, RUN_ID, POOL_SIZE, BULK_SIZE.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const SCIM_TOKEN = __ENV.SCIM_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'default';
const PRESET = __ENV.PRESET || 'single';
const RUN_ID = (__ENV.RUN_ID || `run-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-');
const POOL_SIZE = Math.max(100, Math.min(10_000, Number.parseInt(__ENV.POOL_SIZE || '2000', 10)));
const BULK_SIZE = Math.max(1, Math.min(100, Number.parseInt(__ENV.BULK_SIZE || '20', 10)));
if (!BASE_URL || !SCIM_TOKEN) throw new Error('BASE_URL and SCIM_TOKEN are required');

const PRESETS = {
  rps10: { rate: 1, timeUnit: '2s', duration: '1m', preAllocatedVUs: 30, maxVUs: 80 },
  rps30: { rate: 3, timeUnit: '2s', duration: '1m', preAllocatedVUs: 250, maxVUs: 400 },
  rps40: { rate: 2, timeUnit: '1s', duration: '1m', preAllocatedVUs: 350, maxVUs: 500 },
  rps50: { rate: 5, timeUnit: '2s', duration: '1m', preAllocatedVUs: 450, maxVUs: 650 },
};
const selected = PRESETS[PRESET] || PRESETS.rps30;
const scenario =
  PRESET === 'single'
    ? {
        executor: 'shared-iterations',
        vus: 1,
        iterations: 1,
        maxDuration: '3m',
        tags: { test_id: 'scim-bulk-attribute-update' },
      }
    : {
        executor: 'constant-arrival-rate',
        rate: selected.rate,
        timeUnit: selected.timeUnit,
        duration: selected.duration,
        gracefulStop: '3m',
        preAllocatedVUs: selected.preAllocatedVUs,
        maxVUs: selected.maxVUs,
        tags: { test_id: 'scim-bulk-attribute-update' },
      };

export const options = {
  setupTimeout: '5m',
  summaryTrendStats: ['avg', 'p(95)', 'p(99)', 'max'],
  scenarios: { scim_bulk_attribute_update: scenario },
  thresholds: {
    dropped_iterations: ['count<1'],
    http_req_failed: ['rate<0.02'],
    scim_bulk_attribute_update_success: ['rate>0.98'],
    scim_bulk_attribute_operation_success: ['rate>0.98'],
    scim_bulk_attribute_server_errors: ['count<1'],
  },
};

const bulkSuccess = new Rate('scim_bulk_attribute_update_success');
const operationSuccess = new Rate('scim_bulk_attribute_operation_success');
const successfulOperations = new Counter('scim_bulk_attribute_success_count');
const serverErrors = new Counter('scim_bulk_attribute_server_errors');
const networkFailures = new Counter('scim_bulk_attribute_network_failures');
const bulkDuration = new Trend('scim_bulk_attribute_update_duration', true);
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
  if (users.length < Math.max(100, BULK_SIZE)) {
    throw new Error(`SCIM update pool is too small: ${users.length}`);
  }
  return { users };
}

export default function scimBulkAttributeUpdate(data) {
  const batch = exec.scenario.iterationInTest;
  const operations = Array.from({ length: BULK_SIZE }, (_, index) => {
    const sequence = batch * BULK_SIZE + index;
    const userId = data.users[sequence % data.users.length];
    return {
      method: 'PATCH',
      path: `/Users/${userId}`,
      data: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          {
            op: 'replace',
            path: 'displayName',
            value: `Bulk Attribute Update ${RUN_ID} ${sequence}`,
          },
        ],
      },
    };
  });
  const response = http.post(
    `${BASE_URL}/scim/v2/Bulk`,
    JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      failOnErrors: 0,
      Operations: operations,
    }),
    { headers, tags: { flow: 'bulk_attribute_patch' }, timeout: '180s' }
  );
  bulkDuration.add(response.timings.duration);
  let body = {};
  try {
    body = response.json();
  } catch {
    body = {};
  }
  const statuses = Array.isArray(body.Operations)
    ? body.Operations.map((operation) => Number(operation.status))
    : [];
  const succeeded = statuses.filter((status) => status === 200).length;
  bulkSuccess.add(response.status === 200);
  operationSuccess.add(statuses.length === BULK_SIZE && succeeded === BULK_SIZE);
  successfulOperations.add(succeeded);
  if (response.status >= 500) serverErrors.add(1);
  if (response.status === 0) networkFailures.add(1);
  serverErrors.add(statuses.filter((status) => status >= 500).length);
}

export function handleSummary(data) {
  const batches = data.metrics.iterations?.values?.count ?? 0;
  const successful = data.metrics.scim_bulk_attribute_success_count?.values?.count ?? 0;
  const requestDurationSeconds =
    data.metrics.scim_bulk_attribute_update_duration?.values?.['p(95)'] / 1000 || 0;
  const elapsedSeconds = PRESET === 'single' ? requestDurationSeconds : 60;
  const effectiveRate = elapsedSeconds > 0 ? successful / elapsedSeconds : 0;
  const maxDurationSeconds =
    (data.metrics.scim_bulk_attribute_update_duration?.values?.max ?? 0) / 1000;
  const drainInclusiveSeconds = PRESET === 'single' ? maxDurationSeconds : 60 + maxDurationSeconds;
  const drainInclusiveRate = drainInclusiveSeconds > 0 ? successful / drainInclusiveSeconds : 0;
  const projectedHoursIncludingFinalDrain =
    effectiveRate > 0 ? (100_000 / effectiveRate + maxDurationSeconds) / 3600 : null;
  return {
    stdout: `${JSON.stringify(
      {
        test: 'SCIM Bulk mapped-attribute PATCH benchmark',
        preset: PRESET,
        runId: RUN_ID,
        target: BASE_URL,
        bulkSize: BULK_SIZE,
        peakVUs: data.metrics.vus?.values?.max ?? 0,
        batches,
        droppedBatches: data.metrics.dropped_iterations?.values?.count ?? 0,
        successfulUpdates: successful,
        effectiveUpdatesPerSecond: effectiveRate,
        estimatedHoursFor100k: effectiveRate > 0 ? 100_000 / effectiveRate / 3600 : null,
        projectedHoursFor100kIncludingFinalDrain: projectedHoursIncludingFinalDrain,
        drainInclusiveUpdatesPerSecond: drainInclusiveRate,
        drainInclusiveHoursFor100k:
          drainInclusiveRate > 0 ? 100_000 / drainInclusiveRate / 3600 : null,
        p95DurationMs: data.metrics.scim_bulk_attribute_update_duration?.values?.['p(95)'] ?? 0,
        p99DurationMs: data.metrics.scim_bulk_attribute_update_duration?.values?.['p(99)'] ?? 0,
        bulkSuccessRate: data.metrics.scim_bulk_attribute_update_success?.values?.rate ?? 0,
        operationSuccessRate: data.metrics.scim_bulk_attribute_operation_success?.values?.rate ?? 0,
        serverErrors: data.metrics.scim_bulk_attribute_server_errors?.values?.count ?? 0,
        networkFailures: data.metrics.scim_bulk_attribute_network_failures?.values?.count ?? 0,
      },
      null,
      2
    )}\n`,
  };
}
