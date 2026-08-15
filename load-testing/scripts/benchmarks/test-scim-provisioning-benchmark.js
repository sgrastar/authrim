/**
 * SCIM single-resource and lifecycle load benchmark.
 * Required: BASE_URL, SCIM_TOKEN. Optional: TENANT_ID, PRESET, RUN_ID.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const SCIM_TOKEN = __ENV.SCIM_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'default';
const PRESET = __ENV.PRESET || 'smoke';
const RUN_ID = (__ENV.RUN_ID || `run-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-');
if (!BASE_URL || !SCIM_TOKEN) throw new Error('BASE_URL and SCIM_TOKEN are required');

const PRESETS = {
  smoke: { rate: 1, duration: '20s', preAllocatedVUs: 4, maxVUs: 10 },
  rps5: { rate: 5, duration: '2m', preAllocatedVUs: 20, maxVUs: 60 },
  rps10: { rate: 10, duration: '3m', preAllocatedVUs: 40, maxVUs: 120 },
  rps25: { rate: 25, duration: '5m', preAllocatedVUs: 100, maxVUs: 300 },
};
const selected = PRESETS[PRESET] || PRESETS.smoke;

export const options = {
  scenarios: {
    scim_single_lifecycle: {
      executor: 'constant-arrival-rate',
      rate: selected.rate,
      timeUnit: '1s',
      duration: selected.duration,
      preAllocatedVUs: selected.preAllocatedVUs,
      maxVUs: selected.maxVUs,
      tags: { test_id: 'scim-single-lifecycle' },
    },
  },
  thresholds: {
    dropped_iterations: ['count<1'],
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<3000', 'p(99)<8000'],
    scim_create_success: ['rate>0.98'],
    scim_lifecycle_success: ['rate>0.97'],
    scim_server_errors: ['count<1'],
  },
};

const createSuccess = new Rate('scim_create_success');
const lifecycleSuccess = new Rate('scim_lifecycle_success');
const createDuration = new Trend('scim_create_duration', true);
const getDuration = new Trend('scim_get_duration', true);
const deactivateDuration = new Trend('scim_deactivate_duration', true);
const reactivateDuration = new Trend('scim_reactivate_duration', true);
const operationPollDuration = new Trend('scim_operation_poll_duration');
const serverErrors = new Counter('scim_server_errors');
const headers = {
  Authorization: `Bearer ${SCIM_TOKEN}`,
  'Content-Type': 'application/scim+json',
  'X-Tenant-Id': TENANT_ID,
};

function recordServerError(response) {
  if (response.status >= 500) serverErrors.add(1);
}

function readJson(response) {
  try {
    return response.json();
  } catch {
    return {};
  }
}

function resolveCreatedUser(response) {
  const body = readJson(response);
  if (response.status === 201) return body;
  if (response.status !== 202 || typeof body.operationId !== 'string') return null;
  const started = Date.now();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    sleep(0.2);
    const operation = http.get(
      `${BASE_URL}/scim/v2/Operations/${encodeURIComponent(body.operationId)}`,
      { headers, tags: { flow: 'operation_poll' } }
    );
    recordServerError(operation);
    const operationBody = readJson(operation);
    if (operation.status === 200 && operationBody.status === 'succeeded') {
      operationPollDuration.add(Date.now() - started);
      const user = http.get(
        `${BASE_URL}/scim/v2/Users/${encodeURIComponent(operationBody.userId)}`,
        { headers, tags: { flow: 'created_user_get' } }
      );
      recordServerError(user);
      return user.status === 200 ? readJson(user) : null;
    }
    if (operation.status !== 200 || ['failed', 'blocked'].includes(operationBody.status)) break;
  }
  operationPollDuration.add(Date.now() - started);
  return null;
}

function patchActive(userId, active, etag) {
  const requestHeaders = { ...headers };
  if (etag) requestHeaders['If-Match'] = etag;
  const response = http.patch(
    `${BASE_URL}/scim/v2/Users/${encodeURIComponent(userId)}`,
    JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: active }],
    }),
    { headers: requestHeaders, tags: { flow: active ? 'reactivate' : 'deactivate' } }
  );
  (active ? reactivateDuration : deactivateDuration).add(response.timings.duration);
  recordServerError(response);
  return response;
}

export default function scimSingleLifecycle() {
  const sequence = exec.scenario.iterationInTest;
  const suffix = `${RUN_ID}-${sequence}`;
  const create = http.post(
    `${BASE_URL}/scim/v2/Users`,
    JSON.stringify({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: `load-${suffix}`,
      displayName: `SCIM Load ${suffix}`,
      emails: [{ value: `load-${suffix}@example.test`, primary: true, type: 'work' }],
      active: sequence % 5 !== 0,
    }),
    {
      headers: { ...headers, 'Idempotency-Key': `scim-load-${suffix}` },
      tags: { flow: 'create' },
    }
  );
  createDuration.add(create.timings.duration);
  recordServerError(create);
  const created = resolveCreatedUser(create);
  createSuccess.add(
    check(create, { 'SCIM create accepted': (response) => [201, 202].includes(response.status) }) &&
      created !== null
  );
  if (!created?.id) {
    lifecycleSuccess.add(false);
    return;
  }
  const current = http.get(`${BASE_URL}/scim/v2/Users/${encodeURIComponent(created.id)}`, {
    headers,
    tags: { flow: 'get' },
  });
  getDuration.add(current.timings.duration);
  recordServerError(current);
  const deactivated = patchActive(created.id, false, current.headers.ETag);
  const reactivated = patchActive(created.id, true, deactivated.headers.ETag);
  lifecycleSuccess.add(
    current.status === 200 && deactivated.status === 200 && reactivated.status === 200
  );
}

export function handleSummary(data) {
  return {
    stdout: `${JSON.stringify(
      {
        test: 'SCIM single-resource lifecycle benchmark',
        preset: PRESET,
        runId: RUN_ID,
        target: BASE_URL,
        completedFlows: data.metrics.iterations?.values?.count ?? 0,
        droppedFlows: data.metrics.dropped_iterations?.values?.count ?? 0,
        requests: data.metrics.http_reqs?.values?.count ?? 0,
        requestRate: data.metrics.http_reqs?.values?.rate ?? 0,
        failedRate: data.metrics.http_req_failed?.values?.rate ?? 0,
        p95DurationMs: data.metrics.http_req_duration?.values?.['p(95)'] ?? 0,
        p95ByFlowMs: {
          create: data.metrics.scim_create_duration?.values?.['p(95)'] ?? 0,
          get: data.metrics.scim_get_duration?.values?.['p(95)'] ?? 0,
          deactivate: data.metrics.scim_deactivate_duration?.values?.['p(95)'] ?? 0,
          reactivate: data.metrics.scim_reactivate_duration?.values?.['p(95)'] ?? 0,
          operationPoll: data.metrics.scim_operation_poll_duration?.values?.['p(95)'] ?? 0,
        },
        createSuccessRate: data.metrics.scim_create_success?.values?.rate ?? 0,
        lifecycleSuccessRate: data.metrics.scim_lifecycle_success?.values?.rate ?? 0,
        serverErrors: data.metrics.scim_server_errors?.values?.count ?? 0,
      },
      null,
      2
    )}\n`,
  };
}
