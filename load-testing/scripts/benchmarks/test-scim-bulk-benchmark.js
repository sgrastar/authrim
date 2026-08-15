/**
 * SCIM Bulk provisioning load benchmark.
 * Required: BASE_URL, SCIM_TOKEN. Optional: TENANT_ID, PRESET, RUN_ID, BULK_SIZE.
 */
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const SCIM_TOKEN = __ENV.SCIM_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'default';
const PRESET = __ENV.PRESET || 'smoke';
const RUN_ID = (__ENV.RUN_ID || `run-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-');
const BULK_SIZE = Math.max(1, Math.min(100, Number.parseInt(__ENV.BULK_SIZE || '20', 10)));
const FAIL_ON_ERRORS = Math.max(0, Number.parseInt(__ENV.FAIL_ON_ERRORS || '0', 10));
const P95_LIMIT_MS = Math.max(1, Number.parseInt(__ENV.P95_LIMIT_MS || '30000', 10));
const P99_LIMIT_MS = Math.max(1, Number.parseInt(__ENV.P99_LIMIT_MS || '60000', 10));
if (!BASE_URL || !SCIM_TOKEN) throw new Error('BASE_URL and SCIM_TOKEN are required');

const PRESETS = {
  smoke: { rate: 1, duration: '20s', preAllocatedVUs: 2, maxVUs: 8 },
  users4: { rate: 1, timeUnit: '5s', duration: '1m', preAllocatedVUs: 4, maxVUs: 8 },
  batches2: { rate: 2, duration: '2m', preAllocatedVUs: 10, maxVUs: 30 },
  batches5: { rate: 5, duration: '3m', preAllocatedVUs: 25, maxVUs: 80 },
  batches10: { rate: 10, duration: '5m', preAllocatedVUs: 50, maxVUs: 150 },
};
const selected = PRESETS[PRESET] || PRESETS.smoke;
const scenario =
  PRESET === 'single'
    ? {
        executor: 'shared-iterations',
        vus: 1,
        iterations: 1,
        maxDuration: '2m',
        tags: { test_id: 'scim-bulk-create' },
      }
    : {
        executor: 'constant-arrival-rate',
        rate: selected.rate,
        timeUnit: selected.timeUnit || '1s',
        duration: selected.duration,
        preAllocatedVUs: selected.preAllocatedVUs,
        maxVUs: selected.maxVUs,
        tags: { test_id: 'scim-bulk-create' },
      };

export const options = {
  scenarios: {
    scim_bulk_create: scenario,
  },
  thresholds: {
    dropped_iterations: ['count<1'],
    http_req_failed: ['rate<0.02'],
    http_req_duration: [`p(95)<${P95_LIMIT_MS}`, `p(99)<${P99_LIMIT_MS}`],
    scim_bulk_success: ['rate>0.98'],
    scim_bulk_operation_success: ['rate>0.98'],
    scim_bulk_server_errors: ['count<1'],
  },
};

const bulkSuccess = new Rate('scim_bulk_success');
const operationSuccess = new Rate('scim_bulk_operation_success');
const serverErrors = new Counter('scim_bulk_server_errors');

export default function scimBulkCreate() {
  const batch = exec.scenario.iterationInTest;
  const operations = Array.from({ length: BULK_SIZE }, (_, index) => {
    const suffix = `${RUN_ID}-${batch}-${index}`;
    return {
      method: 'POST',
      path: '/Users',
      bulkId: `user-${batch}-${index}`,
      data: {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: `bulk-${suffix}`,
        displayName: `SCIM Bulk ${suffix}`,
        emails: [{ value: `bulk-${suffix}@example.test`, primary: true, type: 'work' }],
        active: index % 5 !== 0,
      },
    };
  });
  const response = http.post(
    `${BASE_URL}/scim/v2/Bulk`,
    JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
      failOnErrors: FAIL_ON_ERRORS,
      Operations: operations,
    }),
    {
      headers: {
        Authorization: `Bearer ${SCIM_TOKEN}`,
        'Content-Type': 'application/scim+json',
        'X-Tenant-Id': TENANT_ID,
      },
      tags: { flow: 'bulk_create', bulk_size: String(BULK_SIZE) },
    }
  );
  if (response.status >= 500) serverErrors.add(1);
  let body = {};
  try {
    body = response.json();
  } catch {
    body = {};
  }
  const statuses = Array.isArray(body.Operations)
    ? body.Operations.map((operation) => Number(operation.status))
    : [];
  operationSuccess.add(
    statuses.length === BULK_SIZE && statuses.every((status) => [201, 202].includes(status))
  );
  bulkSuccess.add(
    check(response, { 'SCIM Bulk response is 200': (value) => value.status === 200 })
  );
  serverErrors.add(statuses.filter((status) => status >= 500).length);
}

export function handleSummary(data) {
  const batches = data.metrics.iterations?.values?.count ?? 0;
  return {
    stdout: `${JSON.stringify(
      {
        test: 'SCIM Bulk provisioning benchmark',
        preset: PRESET,
        runId: RUN_ID,
        target: BASE_URL,
        bulkSize: BULK_SIZE,
        failOnErrors: FAIL_ON_ERRORS,
        batches,
        droppedBatches: data.metrics.dropped_iterations?.values?.count ?? 0,
        requestedUsers: batches * BULK_SIZE,
        failedRate: data.metrics.http_req_failed?.values?.rate ?? 0,
        p95DurationMs: data.metrics.http_req_duration?.values?.['p(95)'] ?? 0,
        bulkSuccessRate: data.metrics.scim_bulk_success?.values?.rate ?? 0,
        operationSuccessRate: data.metrics.scim_bulk_operation_success?.values?.rate ?? 0,
        serverErrors: data.metrics.scim_bulk_server_errors?.values?.count ?? 0,
      },
      null,
      2
    )}\n`,
  };
}
