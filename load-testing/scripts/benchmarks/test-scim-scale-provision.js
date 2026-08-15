/**
 * Controlled single-resource SCIM scale seeding (no Bulk requests).
 * Required: BASE_URL, SCIM_TOKEN. Optional: TENANT_ID, RUN_ID, TARGET_USERS, VUS.
 */
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/$/, '');
const SCIM_TOKEN = __ENV.SCIM_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'default';
const RUN_ID = (__ENV.RUN_ID || `scale-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-');
const TARGET_USERS = Math.max(1, Number.parseInt(__ENV.TARGET_USERS || '1000', 10));
const VUS = Math.max(1, Math.min(20, Number.parseInt(__ENV.VUS || '3', 10)));
if (!BASE_URL || !SCIM_TOKEN) throw new Error('BASE_URL and SCIM_TOKEN are required');

export const options = {
  scenarios: {
    scim_scale_seed: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: TARGET_USERS,
      maxDuration: __ENV.MAX_DURATION || '30m',
      tags: { test_id: 'scim-scale-seed' },
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    scim_scale_accepted: ['rate>0.99'],
    scim_scale_server_errors: ['count<1'],
  },
};

const accepted = new Rate('scim_scale_accepted');
const createdSynchronously = new Counter('scim_scale_created_201');
const acceptedAsynchronously = new Counter('scim_scale_accepted_202');
const conflicts = new Counter('scim_scale_conflicts_409');
const serverErrors = new Counter('scim_scale_server_errors');

const displayNames = [
  'Scale User',
  '負荷試験ユーザー',
  'Élodie Ångström',
  'Scale 🚀 User',
  'O’Connor / QA + Ops',
];

export default function scimScaleSeed() {
  const sequence = exec.scenario.iterationInTest;
  const suffix = `${RUN_ID}-${sequence}`;
  const primaryEmail = `scale-${suffix}@example.test`;
  const payload = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: `scale-${suffix}`,
    externalId: `source-${suffix}`,
    active: sequence % 7 !== 0,
    displayName: `${displayNames[sequence % displayNames.length]} ${sequence}`,
    name: {
      givenName: sequence % 3 === 0 ? '太郎' : `Given-${sequence}`,
      familyName: sequence % 3 === 0 ? '試験' : `Family-${sequence}`,
    },
    emails:
      sequence % 4 === 0
        ? [
            { value: `alternate-${suffix}@example.test`, type: 'other' },
            { value: primaryEmail, type: 'work', primary: true },
          ]
        : [{ value: primaryEmail, type: 'work', primary: true }],
  };
  const response = http.post(`${BASE_URL}/scim/v2/Users`, JSON.stringify(payload), {
    headers: {
      Authorization: `Bearer ${SCIM_TOKEN}`,
      'Content-Type': 'application/scim+json',
      'X-Tenant-Id': TENANT_ID,
      'Idempotency-Key': `scim-scale-${suffix}`,
    },
    timeout: __ENV.HTTP_TIMEOUT || '60s',
    tags: { flow: 'scale_create' },
  });

  if (response.status === 201) createdSynchronously.add(1);
  if (response.status === 202) acceptedAsynchronously.add(1);
  if (response.status === 409) conflicts.add(1);
  if (response.status >= 500) serverErrors.add(1);
  accepted.add(
    check(response, {
      'SCIM scale create accepted': (value) => value.status === 201 || value.status === 202,
    })
  );
}

export function handleSummary(data) {
  return {
    stdout: `${JSON.stringify(
      {
        test: 'SCIM controlled single-resource scale seed',
        runId: RUN_ID,
        target: BASE_URL,
        targetUsers: TARGET_USERS,
        completedIterations: data.metrics.iterations?.values?.count ?? 0,
        acceptedRate: data.metrics.scim_scale_accepted?.values?.rate ?? 0,
        created201: data.metrics.scim_scale_created_201?.values?.count ?? 0,
        accepted202: data.metrics.scim_scale_accepted_202?.values?.count ?? 0,
        conflicts409: data.metrics.scim_scale_conflicts_409?.values?.count ?? 0,
        serverErrors: data.metrics.scim_scale_server_errors?.values?.count ?? 0,
        p95DurationMs: data.metrics.http_req_duration?.values?.['p(95)'] ?? 0,
      },
      null,
      2
    )}\n`,
  };
}
