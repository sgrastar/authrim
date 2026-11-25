import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { buildCoreMock } from './helpers/index-mutation-helpers';
import { executionCtx, must, probe, request } from './helpers/index-mutation-helpers';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/index-mutation-helpers')).buildCoreMock(
    await importOriginal<Parameters<typeof buildCoreMock>[0]>()
  )
);
vi.mock('../rebac-storage-adapter', async () =>
  (await import('./helpers/index-mutation-helpers')).buildAdapterMock()
);

import app from '../index';

const KV = { marker: 'kv' };

function makeEnv(overrides: Record<string, unknown> = {}) {
  return { POLICY_API_SECRET: 'policy-secret', ENABLE_REBAC: 'true', ...overrides };
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; auth?: string | null } = {},
  env: Record<string, unknown> = makeEnv()
) {
  const response = await app.request(request(path, options), undefined, env, executionCtx);
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
}

const post = (path: string, body: unknown, env?: Record<string, unknown>) =>
  call(path, { method: 'POST', body }, env);

const checkBody = { tenant_id: 't1', user_id: 'user:1', relation: 'viewer', object: 'doc:1' };
const listObjectsBody = {
  tenant_id: 't1',
  user_id: 'user:1',
  relation: 'viewer',
  object_type: 'doc',
};
const listUsersBody = { tenant_id: 't1', object: 'doc:1', relation: 'viewer' };

beforeEach(() => {
  probe.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

const FROZEN_MS = 1_700_000_123_456;

const routes: Array<[string, Record<string, unknown>, string]> = [
  ['/api/rebac/check', checkBody, 'ReBAC check error'],
  ['/api/rebac/batch-check', { checks: [{ ...checkBody }] }, 'ReBAC batch check error'],
  ['/api/rebac/list-objects', listObjectsBody, 'ReBAC list objects error'],
  ['/api/rebac/list-users', listUsersBody, 'ReBAC list users error'],
];

describe.each(routes)('POST %s', (path, validBody, errorMessage) => {
  it('requires internal authentication before creating the service', async () => {
    const result = await call(path, { method: 'POST', body: validBody, auth: null });
    expect(result.status).toBe(401);
    expect(probe.errors).toEqual([{ code: 'AR000003', options: undefined }]);
    expect(probe.modules).toEqual(['REBAC']);
    expect(probe.serviceFactoryArgs).toEqual([]);
  });

  it('answers 500 without touching the body when the ReBAC service cannot be created', async () => {
    probe.serviceThrows = true;
    const result = await post(path, validBody);
    expect(result.status).toBe(500);
    expect(probe.errors).toEqual([{ code: 'AR900001', options: undefined }]);
    expect(probe.logs).toEqual([]);
    expect(probe.flagCalls).toEqual([]);
  });

  it('builds the service from the core adapter and the cache KV', async () => {
    await post(path, validBody, makeEnv({ REBAC_CACHE_KV: KV }));
    expect(probe.serviceFactoryArgs).toEqual([[probe.adapter, KV]]);
  });

  it('fails closed when ReBAC is disabled for the trimmed tenant', async () => {
    const body =
      'checks' in validBody
        ? { checks: [{ ...checkBody, tenant_id: 't1 ' }] }
        : { ...validBody, tenant_id: 't1 ' };
    const result = await post(path, body, makeEnv({ ENABLE_REBAC: 'false' }));
    expect(result.status).toBe(403);
    expect(probe.errors).toEqual([{ code: 'AR050001', options: undefined }]);
    expect(probe.flagCalls).toEqual([['t1']]);
    for (const fn of [
      probe.service.check,
      probe.service.batchCheck,
      probe.service.listObjects,
      probe.service.listUsers,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('logs a failing service call and answers 500', async () => {
    for (const fn of [
      probe.service.check,
      probe.service.batchCheck,
      probe.service.listObjects,
      probe.service.listUsers,
    ]) {
      fn.mockRejectedValue(new Error('db down'));
    }
    const result = await post(path, validBody);
    expect(result.status).toBe(500);
    expect(probe.errors).toEqual([{ code: 'AR900001', options: undefined }]);
    expect(probe.logs).toEqual([
      { module: 'REBAC', level: 'error', message: errorMessage, data: { error: 'Error: db down' } },
    ]);
  });
});

describe.each([
  ['/api/rebac/check', checkBody, ['user_id', 'relation', 'object']],
  ['/api/rebac/list-objects', listObjectsBody, ['user_id', 'relation', 'object_type']],
  ['/api/rebac/list-users', listUsersBody, ['object', 'relation']],
] as const)('POST %s validation', (path, body, fields) => {
  it.each(fields)('rejects a body without %s', async (field) => {
    const result = await post(path, { ...body, [field]: undefined });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
    expect(probe.flagCalls).toEqual([]);
  });

  it.each([undefined, '', '  '])('requires a tenant_id (%j)', async (tenant_id) => {
    const result = await post(path, { ...body, tenant_id });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([
      { code: 'AR130001', options: { variables: { field: 'tenant_id' } } },
    ]);
    expect(probe.flagCalls).toEqual([]);
  });
});

describe('POST /api/rebac/check', () => {
  it('passes the trimmed tenant and the request fields to the service and returns its answer', async () => {
    probe.service.check.mockResolvedValue({ allowed: true, resolved_via: 'direct' });
    const result = await post('/api/rebac/check', {
      ...checkBody,
      tenant_id: 't1 ',
      object_type: 'doc',
      extra: 'dropped',
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ allowed: true, resolved_via: 'direct' });
    expect(probe.service.check).toHaveBeenCalledTimes(1);
    expect(probe.service.check.mock.calls[0]?.[0]).toStrictEqual({
      tenant_id: 't1',
      user_id: 'user:1',
      relation: 'viewer',
      object: 'doc:1',
      object_type: 'doc',
    });
    expect(probe.flagCalls).toEqual([['t1']]);
  });
});

describe('POST /api/rebac/batch-check', () => {
  const route = '/api/rebac/batch-check';

  it.each([{}, { checks: [] }, { checks: 'abc' }, { checks: { length: 3 } }])(
    'requires a non-empty checks array: %j',
    async (body) => {
      const result = await post(route, body);
      expect(result.status).toBe(400);
      expect(probe.errors).toEqual([
        { code: 'AR130001', options: { variables: { field: 'checks' } } },
      ]);
      expect(probe.service.batchCheck).not.toHaveBeenCalled();
    }
  );

  it('accepts exactly 100 checks and rejects 101', async () => {
    const make = (n: number) => ({
      checks: Array.from({ length: n }, (_, i) => ({ ...checkBody, object: `doc:${i}` })),
    });
    const accepted = await post(route, make(100));
    expect(accepted.status).toBe(200);
    expect(
      (must(probe.service.batchCheck.mock.calls[0])[0] as { checks: unknown[] }).checks
    ).toHaveLength(100);

    probe.errors = [];
    const rejected = await post(route, make(101));
    expect(rejected.status).toBe(400);
    expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
    expect(probe.service.batchCheck).toHaveBeenCalledTimes(1);
  });

  it('requires a tenant_id on every check', async () => {
    const result = await post(route, {
      checks: [checkBody, { ...checkBody, tenant_id: '  ' }],
    });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([
      { code: 'AR130001', options: { variables: { field: 'checks[].tenant_id' } } },
    ]);
    expect(probe.service.batchCheck).not.toHaveBeenCalled();
  });

  it('checks the flag of every tenant and forwards the checks with trimmed tenants', async () => {
    probe.service.batchCheck.mockResolvedValue({
      results: [{ allowed: true }, { allowed: false }],
    });
    const result = await post(route, {
      checks: [
        { ...checkBody, tenant_id: 't1 ' },
        { ...checkBody, tenant_id: 't2', object_type: 'doc' },
      ],
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ results: [{ allowed: true }, { allowed: false }] });
    expect(probe.flagCalls).toEqual([['t1'], ['t2']]);
    expect(probe.service.batchCheck.mock.calls[0]?.[0]).toStrictEqual({
      checks: [
        { ...checkBody, tenant_id: 't1' },
        { ...checkBody, tenant_id: 't2', object_type: 'doc' },
      ],
    });
  });
});

describe('POST /api/rebac/list-objects', () => {
  const route = '/api/rebac/list-objects';

  it.each([
    [undefined, 100],
    [0, 100],
    [7, 7],
    [1000, 1000],
    [5000, 1000],
  ])('limits %s to %s', async (limit, expected) => {
    probe.service.listObjects.mockResolvedValue({ objects: ['doc:1'] });
    const result = await post(route, { ...listObjectsBody, limit, cursor: 'next' });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ objects: ['doc:1'] });
    expect(probe.service.listObjects.mock.calls[0]?.[0]).toStrictEqual({
      tenant_id: 't1',
      user_id: 'user:1',
      relation: 'viewer',
      object_type: 'doc',
      limit: expected,
      cursor: 'next',
    });
  });
});

describe('POST /api/rebac/list-users', () => {
  const route = '/api/rebac/list-users';

  it.each([
    [undefined, 100],
    [0, 100],
    [7, 7],
    [1000, 1000],
    [5000, 1000],
  ])('limits %s to %s', async (limit, expected) => {
    probe.service.listUsers.mockResolvedValue({ users: ['user:1'] });
    const result = await post(route, {
      ...listUsersBody,
      object_type: 'doc',
      limit,
      cursor: 'next',
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ users: ['user:1'] });
    expect(probe.service.listUsers.mock.calls[0]?.[0]).toStrictEqual({
      tenant_id: 't1',
      object: 'doc:1',
      object_type: 'doc',
      relation: 'viewer',
      limit: expected,
      cursor: 'next',
    });
  });
});

describe('GET /api/rebac/health', () => {
  it.each([
    [true, true, true, 'ok'],
    [true, true, false, 'ok'],
    [true, false, true, 'limited'],
    [false, true, true, 'limited'],
    [false, false, false, 'limited'],
  ])(
    'with rebac=%s, database=%s, cache=%s the status is %s',
    async (rebac, database, cache, status) => {
      const values = {
        POLICY_API_SECRET: 'policy-secret',
        ENABLE_REBAC: rebac ? 'true' : 'false',
        ...(cache ? { REBAC_CACHE_KV: KV } : {}),
      };
      probe.healthAdapter = database ? {} : null;
      const env = values;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FROZEN_MS);
      const result = await call('/api/rebac/health', { auth: null }, env);
      expect(result.status).toBe(200);
      expect(result.json).toEqual({
        status,
        service: 'ar-policy-rebac',
        version: '0.1.0',
        timestamp: new Date(FROZEN_MS).toISOString(),
        enabled: rebac,
        database,
        cache,
      });
      expect(probe.flagCalls).toEqual([[undefined]]);
      expect(probe.healthAdapterNames).toEqual(['policy-health']);
    }
  );
});
