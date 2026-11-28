import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCoreMock,
  executionCtx,
  objectContaining,
  must,
  probe,
  request,
} from './helpers/index-mutation-helpers';
import { createRateLimiterStub } from './rate-limiter-stub';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/index-mutation-helpers')).buildCoreMock(
    await importOriginal<Parameters<typeof buildCoreMock>[0]>()
  )
);
vi.mock('../rebac-storage-adapter', async () =>
  (await import('./helpers/index-mutation-helpers')).buildAdapterMock()
);

import app from '../index';

const NOW_MS = 1_700_000_123_456;
const NOW_S = 1_700_000_123;
const KV = { marker: 'kv' };
/** REBAC_CACHE: where the tenant's ReBAC version is kept. */
const VERSIONS = { marker: 'versions' };
const HUB = { marker: 'hub' };

const ADMIN = { 'X-Test-Admin': 'alice', 'X-Test-Admin-Tenant': 't1' };
/** An administrator who may also grant roles (group usersets need it). */
const ROLE_ADMIN = { ...ADMIN, 'X-Test-Perms': 'roles' };

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    POLICY_API_SECRET: 'policy-secret',
    ENABLE_REBAC: 'true',
    RATE_LIMITER: createRateLimiterStub(),
    REBAC_CACHE_KV: KV,
    REBAC_CACHE: VERSIONS,
    PERMISSION_CHANGE_HUB: HUB,
    ...overrides,
  };
}

async function call(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = ADMIN,
  env: Record<string, unknown> = makeEnv()
) {
  const response = await app.request(
    request(path, { method, body, headers, auth: null }),
    undefined,
    env,
    executionCtx
  );
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

const tupleBody = {
  tenant_id: 't1',
  object_type: 'document',
  object_id: 'doc1',
  relation: 'viewer',
  subject_type: 'user',
  subject_id: 'u1',
};

beforeEach(() => {
  probe.reset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ['POST', '/api/rebac/write'],
  ['DELETE', '/api/rebac/tuples'],
  ['POST', '/api/rebac/invalidate'],
])('%s %s admin gate', (method, path) => {
  it('rejects a request without an administrator', async () => {
    const result = await call(method, path, { ...tupleBody, type: 'user', user_id: 'u1' }, {});
    expect(result.status).toBe(401);
    expect(probe.adapter.execute).not.toHaveBeenCalled();
    expect(probe.service.invalidateCache).not.toHaveBeenCalled();
  });

  it('rejects an administrator without the policy:rebac:write permission', async () => {
    const result = await call(
      method,
      path,
      { ...tupleBody, type: 'user', user_id: 'u1' },
      { ...ADMIN, 'X-Test-Perms': 'none' }
    );
    expect(result.status).toBe(403);
    expect(result.json.error).toBe('insufficient_permissions');
    expect(probe.adapter.execute).not.toHaveBeenCalled();
    expect(probe.service.invalidateUserCache).not.toHaveBeenCalled();
  });

  it('answers the missing tenant_id with a required-field error naming it', async () => {
    for (const tenant_id of [undefined, '\u00a0  ']) {
      probe.errors = [];
      const result = await call(method, path, { ...tupleBody, type: 'user', tenant_id });
      expect(result.status).toBe(400);
      expect(probe.errors).toEqual([
        { code: 'AR130001', options: { variables: { field: 'tenant_id' } } },
      ]);
    }
  });

  it('refuses a body tenant other than the authenticated administrator tenant', async () => {
    const result = await call(
      method,
      path,
      { ...tupleBody, type: 'user', user_id: 'u1', tenant_id: 'other' },
      ADMIN
    );
    expect(result.status).toBe(403);
    expect(result.json).toEqual({
      error: 'access_denied',
      error_description: 'Authenticated admin tenant does not match request tenant.',
    });
    expect(probe.adapter.execute).not.toHaveBeenCalled();
    expect(probe.service.invalidateUserCache).not.toHaveBeenCalled();
  });

  // Documents the CURRENT behaviour of rejectTenantMismatch (an admin context without a tenant is
  // not compared with the body tenant, so no mismatch is raised). This is not a confirmed
  // requirement; it is pinned only so that mutations of that branch are detected.
  it('currently skips the tenant comparison for a blank authenticated tenant (documents existing behaviour), and trims the body tenant', async () => {
    for (const adminTenant of ['', '\u00a0\u00a0']) {
      probe.reset();
      const result = await call(
        method,
        path,
        { ...tupleBody, type: 'user', user_id: 'u1', tenant_id: '\u00a0anything\u00a0' },
        { ...ADMIN, 'X-Test-Admin-Tenant': adminTenant }
      );
      expect(result.status).toBe(200);
    }
  });

  it('accepts a body tenant equal to the padded authenticated tenant', async () => {
    const result = await call(
      method,
      path,
      { ...tupleBody, type: 'user', user_id: 'u1', tenant_id: 't1' },
      { ...ADMIN, 'X-Test-Admin-Tenant': 't1\u00a0' }
    );
    expect(result.status).toBe(200);
  });
});

describe.each([
  ['POST', '/api/rebac/write'],
  ['DELETE', '/api/rebac/tuples'],
])('%s %s tuple validation', (method, path) => {
  it.each(['object_type', 'object_id', 'relation', 'subject_type', 'subject_id'])(
    'rejects a body without %s',
    async (field) => {
      const result = await call(method, path, { ...tupleBody, [field]: '' });
      expect(result.status).toBe(400);
      expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
      expect(probe.adapter.queryOne).not.toHaveBeenCalled();
      expect(probe.adapter.execute).not.toHaveBeenCalled();
    }
  );

  it('fails closed when ReBAC is disabled for the tenant, before the tenant check', async () => {
    const result = await call(
      method,
      path,
      { ...tupleBody, tenant_id: 'other' },
      ADMIN,
      makeEnv({ ENABLE_REBAC: 'false' })
    );
    expect(result.status).toBe(403);
    expect(probe.errors).toEqual([{ code: 'AR050001', options: undefined }]);
    expect(probe.flagCalls).toEqual([['other']]);
    expect(probe.adapter.execute).not.toHaveBeenCalled();
  });

  it('checks the flag of the trimmed body tenant', async () => {
    await call(method, path, { ...tupleBody, tenant_id: 't1\u00a0' });
    expect(probe.flagCalls).toEqual([['t1']]);
  });

  it('logs an unexpected storage failure and answers 500', async () => {
    probe.adapter.queryOne.mockRejectedValue(new Error('disk'));
    probe.adapter.execute.mockRejectedValue(new Error('disk'));
    const result = await call(method, path, tupleBody);
    expect(result.status).toBe(500);
    expect(probe.errors).toEqual([{ code: 'AR900001', options: undefined }]);
    expect(probe.logs).toHaveLength(1);
    const logged = must(probe.logs[0]);
    expect(logged.module).toBe('REBAC');
    expect(logged.level).toBe('error');
    expect(logged.message).toBe(method === 'POST' ? 'ReBAC write error' : 'ReBAC delete error');
    expect(logged.data).toEqual({ error: 'Error: disk' });
  });
});

describe('POST /api/rebac/write', () => {
  it('creates a new tuple, invalidates the cache and publishes a grant event', async () => {
    const result = await call('POST', '/api/rebac/write', {
      ...tupleBody,
      expires_at: 1_800_000_000,
    });
    expect(result.status).toBe(200);

    // A direct subject sent as `user` is stored and matched as `subject` (the type the check reads).
    // ... and also matches a row an older write stored as `user`.
    const lookupParams = ['t1', 'subject', 'user', 'u1', 'document', 'doc1', 'viewer'];
    expect(probe.adapter.queryOne).toHaveBeenCalledTimes(1);
    const lookup = must(probe.adapter.queryOne.mock.calls[0]);
    expect(lookup[0]).toContain('SELECT id FROM relationships');
    expect(lookup[1]).toEqual(lookupParams);

    expect(probe.adapter.execute).toHaveBeenCalledTimes(1);
    const insert = must(probe.adapter.execute.mock.calls[0]);
    expect(insert[0]).toContain('INSERT INTO relationships');
    const params = insert[1] as unknown[];
    const id = params[0];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(params).toEqual([
      id,
      't1',
      'viewer',
      'subject',
      'u1',
      null,
      'document',
      'doc1',
      'full',
      1_800_000_000,
      0,
      NOW_S,
      NOW_S,
    ]);

    expect(result.json).toEqual({
      success: true,
      tuple: {
        id,
        tenant_id: 't1',
        object_type: 'document',
        object_id: 'doc1',
        relation: 'viewer',
        subject_type: 'subject',
        subject_id: 'u1',
        from_relation: null,
        expires_at: 1_800_000_000,
        created_at: NOW_S,
      },
    });

    expect(probe.service.invalidateCache).toHaveBeenCalledTimes(1);
    expect(probe.service.invalidateCache).toHaveBeenCalledWith('t1', 'document', 'doc1', 'viewer');
    expect(probe.serviceFactoryArgs).toEqual([[probe.adapter, KV, expect.any(Function), VERSIONS]]);
    // The tenant's ReBAC version is bumped (cached results retired) on every write.
    expect(probe.versionBumps).toEqual(['t1']);

    expect(probe.notifierOptions).toEqual([
      {
        env: objectContaining({ PERMISSION_CHANGE_HUB: HUB }),
        cache: KV,
        permissionChangeHub: HUB,
        debug: false,
      },
    ]);
    expect(probe.events).toEqual([
      {
        event: 'grant',
        tenant_id: 't1',
        subject_id: 'u1',
        resource: 'document:doc1',
        relation: 'viewer',
        permission: undefined,
        timestamp: NOW_MS,
      },
    ]);
  });

  it('stores a null expiry when none is given', async () => {
    const result = await call('POST', '/api/rebac/write', tupleBody);
    expect(result.status).toBe(200);
    const params = must(probe.adapter.execute.mock.calls[0])[1] as unknown[];
    expect(params[9]).toBeNull();
    expect(result.json.tuple).not.toHaveProperty('expires_at');
  });

  it('updates the expiry of an existing tuple and keeps its id', async () => {
    probe.adapter.queryOne.mockResolvedValue({ id: 'existing-1' });
    const result = await call('POST', '/api/rebac/write', {
      ...tupleBody,
      expires_at: 1_800_000_000,
    });
    expect(result.status).toBe(200);
    expect(probe.adapter.execute).toHaveBeenCalledTimes(1);
    const update = must(probe.adapter.execute.mock.calls[0]);
    expect(update[0]).toContain('UPDATE relationships');
    // The row is normalised to the stored source shape as well.
    expect(update[1]).toEqual([1_800_000_000, NOW_S, 'subject', null, 'existing-1', 't1']);
    expect((result.json.tuple as { id: string }).id).toBe('existing-1');
  });

  it('clears the expiry of an existing tuple when none is given', async () => {
    probe.adapter.queryOne.mockResolvedValue({ id: 'existing-1' });
    await call('POST', '/api/rebac/write', tupleBody);
    expect(must(probe.adapter.execute.mock.calls[0])[1]).toEqual([
      null,
      NOW_S,
      'subject',
      null,
      'existing-1',
      't1',
    ]);
  });

  it('resolves a unique-constraint race to the winning tuple', async () => {
    probe.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'raced-1' });
    probe.adapter.execute
      .mockRejectedValueOnce(new Error('D1_ERROR: UNIQUE constraint failed: relationships.id'))
      .mockResolvedValueOnce({ rowsAffected: 1 });
    const result = await call('POST', '/api/rebac/write', { ...tupleBody, expires_at: 5 });
    expect(result.status).toBe(200);
    expect(probe.adapter.queryOne).toHaveBeenCalledTimes(2);
    const relookup = must(probe.adapter.queryOne.mock.calls[1]);
    expect(relookup[0]).toContain('SELECT id FROM relationships');
    expect(relookup[1]).toEqual(['t1', 'subject', 'user', 'u1', 'document', 'doc1', 'viewer']);
    const update = must(probe.adapter.execute.mock.calls[1]);
    expect(update[0]).toContain('UPDATE relationships');
    expect(update[1]).toEqual([5, NOW_S, 'subject', null, 'raced-1', 't1']);
    expect((result.json.tuple as { id: string }).id).toBe('raced-1');
  });

  it('recognises a unique-constraint failure wrapped in cause (as the D1 adapter throws it)', async () => {
    probe.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'raced-1' });
    probe.adapter.execute
      .mockRejectedValueOnce(
        new Error('D1 operation failed after retries exhausted', {
          cause: new Error('D1_ERROR: UNIQUE constraint failed: relationships.tenant_id'),
        })
      )
      .mockResolvedValueOnce({ rowsAffected: 1 });
    const result = await call('POST', '/api/rebac/write', tupleBody);
    expect(result.status).toBe(200);
    expect((result.json.tuple as { id: string }).id).toBe('raced-1');
  });

  it('clears the expiry of the raced tuple when none is given', async () => {
    probe.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'raced-1' });
    probe.adapter.execute
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
      .mockResolvedValueOnce({ rowsAffected: 1 });
    await call('POST', '/api/rebac/write', tupleBody);
    expect(must(probe.adapter.execute.mock.calls[1])[1]).toEqual([
      null,
      NOW_S,
      'subject',
      null,
      'raced-1',
      't1',
    ]);
  });

  it('fails when the raced tuple cannot be found again', async () => {
    probe.adapter.queryOne.mockResolvedValue(null);
    probe.adapter.execute.mockRejectedValueOnce(new Error('UNIQUE constraint failed'));
    const result = await call('POST', '/api/rebac/write', tupleBody);
    expect(result.status).toBe(500);
    expect(probe.logs.map((l) => l.data)).toEqual([
      { error: 'Error: Failed to resolve raced relationship tuple' },
    ]);
  });

  it('rethrows an insert failure that is not a unique-constraint violation', async () => {
    probe.adapter.execute.mockRejectedValueOnce(new Error('disk full'));
    const result = await call('POST', '/api/rebac/write', tupleBody);
    expect(result.status).toBe(500);
    expect(probe.adapter.queryOne).toHaveBeenCalledTimes(1);
    expect(probe.logs.map((l) => l.data)).toEqual([{ error: 'Error: disk full' }]);
  });

  it('succeeds without cache invalidation when the ReBAC service cannot be created', async () => {
    probe.serviceThrows = true;
    const result = await call('POST', '/api/rebac/write', tupleBody);
    expect(result.status).toBe(200);
    expect(probe.service.invalidateCache).not.toHaveBeenCalled();
    expect(probe.events).toHaveLength(1);
  });

  it('still succeeds, logging a warning, when the change notification fails', async () => {
    probe.publishThrows = true;
    const result = await call('POST', '/api/rebac/write', tupleBody);
    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(probe.logs).toEqual([
      {
        module: 'REBAC',
        level: 'warn',
        message: 'Permission change notification failed',
        data: { error: 'Error: hub down' },
      },
    ]);
  });
});

describe('ReBAC tuple type rules on /api/rebac/write and DELETE /api/rebac/tuples', () => {
  const PARENT_DEFINITION = JSON.stringify({
    type: 'tuple_to_userset',
    tupleset: { relation: 'parent' },
    computed_userset: { relation: 'viewer' },
  });

  function withDefinitions(rows: Array<{ definition_json: string }>) {
    const query = vi.fn().mockResolvedValue(rows);
    (probe.adapter as unknown as { query: typeof query }).query = query;
    return query;
  }

  it('stores a subject sent as subject unchanged', async () => {
    const result = await call('POST', '/api/rebac/write', {
      ...tupleBody,
      subject_type: 'subject',
    });
    expect(result.status).toBe(200);
    expect((must(probe.adapter.execute.mock.calls[0])[1] as unknown[])[3]).toBe('subject');
  });

  it('accepts a group tuple only with no from_relation or member, on write and delete', async () => {
    for (const [method, path] of [
      ['POST', '/api/rebac/write'],
      ['DELETE', '/api/rebac/tuples'],
    ] as const) {
      const group = { ...tupleBody, subject_type: 'group', subject_id: 'grp1' };
      expect(
        (await call(method, path, { ...group, from_relation: 'member' }, ROLE_ADMIN)).status
      ).toBe(200);
      for (const body of [
        { ...group, from_relation: 'owner' },
        { ...group, from_relation: 7 },
        { ...tupleBody, from_relation: 'member' },
      ]) {
        probe.adapter.execute.mockClear();
        const result = await call(method, path, body, ROLE_ADMIN);
        expect(result.status).toBe(400);
        expect(result.text).toContain('AR050010');
        expect(probe.adapter.execute).not.toHaveBeenCalled();
      }
    }
  });

  it('needs the role-grant permission for a group userset, on write and delete', async () => {
    for (const [method, path] of [
      ['POST', '/api/rebac/write'],
      ['DELETE', '/api/rebac/tuples'],
    ] as const) {
      probe.adapter.execute.mockClear();
      const result = await call(method, path, {
        ...tupleBody,
        subject_type: 'group',
        subject_id: 'grp1',
      });
      expect(result.status).toBe(403);
      expect(probe.adapter.execute).not.toHaveBeenCalled();
    }
    // A direct subject tuple needs no more than the ReBAC write permission.
    expect((await call('POST', '/api/rebac/write', tupleBody)).status).toBe(200);
  });

  it('refuses a group userset on a group a self-writable service group decides', async () => {
    probe.groupGuard.mockResolvedValueOnce({ kind: 'group_self_writable_attribute' });
    const result = await call(
      'POST',
      '/api/rebac/write',
      { ...tupleBody, subject_type: 'group', subject_id: 'grp1' },
      ROLE_ADMIN
    );
    expect(result.status).toBe(400);
    expect(result.json.error).toBe('group_self_writable_attribute');
    expect(probe.groupGuard).toHaveBeenCalledWith(
      probe.adapter,
      't1',
      'grp1',
      expect.any(Function)
    );
    expect(probe.adapter.execute).not.toHaveBeenCalled();
    // Taking one away is not refused for that reason.
    const removed = await call(
      'DELETE',
      '/api/rebac/tuples',
      { ...tupleBody, subject_type: 'group', subject_id: 'grp1' },
      ROLE_ADMIN
    );
    expect(removed.status).toBe(200);
  });

  it('normalises a legacy group row (no from_relation) found on write', async () => {
    probe.adapter.queryOne.mockResolvedValue({ id: 'legacy-group' });
    const result = await call(
      'POST',
      '/api/rebac/write',
      { ...tupleBody, subject_type: 'group', subject_id: 'grp1' },
      ROLE_ADMIN
    );
    expect(result.status).toBe(200);
    const update = must(probe.adapter.execute.mock.calls[0]);
    expect(update[0]).toContain('from_type = ?, from_relation = ?');
    // Under the catalog fence of the guarded write.
    expect(update[0]).toContain('AND FENCE');
    expect(update[1]).toEqual([
      null,
      NOW_S,
      'group',
      'member',
      'legacy-group',
      't1',
      'fence-param',
    ]);
  });

  it('refuses an expires_at that is not integer seconds', async () => {
    for (const expires_at of [1.5, '1800000000', 1e300]) {
      const result = await call('POST', '/api/rebac/write', { ...tupleBody, expires_at });
      expect(result.status).toBe(400);
    }
    expect(probe.adapter.execute).not.toHaveBeenCalled();
    expect(
      (await call('POST', '/api/rebac/write', { ...tupleBody, expires_at: null })).status
    ).toBe(200);
  });

  it('deletes a group userset through the guarded write (409 when its fence fails)', async () => {
    const group = { ...tupleBody, subject_type: 'group', subject_id: 'grp1' };
    probe.adapter.queryOne.mockResolvedValue({ id: 'u1' });
    const removed = await call('DELETE', '/api/rebac/tuples', group, ROLE_ADMIN);
    expect(removed.status).toBe(200);
    expect(removed.json.deleted).toBe(true);
    const [sql, params] = must(probe.adapter.execute.mock.calls[0]) as [string, unknown[]];
    expect(sql).toContain('DELETE FROM relationships');
    expect(sql).toContain('AND FENCE');
    expect(params.at(-1)).toBe('fence-param');
    expect(probe.groupGuard.mock.calls[0]?.[4]).toEqual({ refuseSelfWritable: false });
    probe.groupGuard.mockResolvedValueOnce({ kind: 'group_version_conflict' });
    const conflict = await call('DELETE', '/api/rebac/tuples', group, ROLE_ADMIN);
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toBe('group_version_conflict');
  });

  it('answers 409 when the catalog fence of a group userset write does not hold', async () => {
    probe.adapter.execute.mockResolvedValue({ rowsAffected: 0 });
    const result = await call(
      'POST',
      '/api/rebac/write',
      { ...tupleBody, subject_type: 'group', subject_id: 'grp1' },
      ROLE_ADMIN
    );
    expect(result.status).toBe(409);
    expect(result.json.error).toBe('group_version_conflict');
    const [sql, params] = must(probe.adapter.execute.mock.calls[0]) as [string, unknown[]];
    expect(sql).toContain('WHERE FENCE');
    expect(params.at(-1)).toBe('fence-param');
    expect(probe.versionBumps).toEqual([]);
  });

  it('stores a group userset as group with from_relation member, sent or not', async () => {
    for (const extra of [{}, { from_relation: 'member' }]) {
      probe.adapter.execute.mockClear();
      const result = await call(
        'POST',
        '/api/rebac/write',
        {
          ...tupleBody,
          subject_type: 'group',
          subject_id: 'grp1',
          ...extra,
        },
        ROLE_ADMIN
      );
      expect(result.status).toBe(200);
      const params = must(probe.adapter.execute.mock.calls[0])[1] as unknown[];
      expect(params.slice(2, 6)).toEqual(['viewer', 'group', 'grp1', 'member']);
      expect(result.json.tuple).toMatchObject({ subject_type: 'group', from_relation: 'member' });
    }
  });

  it('accepts an object edge declared as the source of a tuple_to_userset', async () => {
    const query = withDefinitions([{ definition_json: PARENT_DEFINITION }]);
    const result = await call('POST', '/api/rebac/write', {
      tenant_id: 't1',
      subject_type: 'document',
      subject_id: 'doc1',
      relation: 'parent',
      object_type: 'folder',
      object_id: 'f1',
    });
    expect(result.status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM relation_definitions'), [
      't1',
      'document',
    ]);
    const params = must(probe.adapter.execute.mock.calls[0])[1] as unknown[];
    expect(params.slice(2, 8)).toEqual(['parent', 'document', 'doc1', null, 'folder', 'f1']);
  });

  it.each([
    ['an undeclared object edge', { subject_type: 'document', relation: 'viewer' }],
    ['a service subject', { subject_type: 'service' }],
    ['an organization subject', { subject_type: 'org' }],
  ])('refuses %s on write and delete with 400', async (_label, override) => {
    withDefinitions([{ definition_json: PARENT_DEFINITION }]);
    for (const [method, path] of [
      ['POST', '/api/rebac/write'],
      ['DELETE', '/api/rebac/tuples'],
    ] as const) {
      probe.adapter.execute.mockClear();
      probe.adapter.queryOne.mockClear();
      const result = await call(method, path, { ...tupleBody, ...override });
      expect(result.status).toBe(400);
      expect(result.json).toMatchObject({ error: 'invalid_request' });
      expect(result.text).toContain('AR050010');
      expect(probe.adapter.queryOne).not.toHaveBeenCalled();
      expect(probe.adapter.execute).not.toHaveBeenCalled();
    }
    expect(probe.events).toEqual([]);
  });
});

describe('legacy user rows', () => {
  it('deletes a row an older write stored as user, sent as user or subject', async () => {
    for (const subject_type of ['user', 'subject']) {
      probe.adapter.execute.mockClear();
      probe.adapter.execute.mockResolvedValue({ rowsAffected: 1 });
      const result = await call('DELETE', '/api/rebac/tuples', { ...tupleBody, subject_type });
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ success: true, deleted: true });
      const del = must(probe.adapter.execute.mock.calls[0]);
      expect(del[0]).toContain('from_type IN (?, ?)');
      expect((del[1] as unknown[]).slice(1, 3)).toEqual(['subject', 'user']);
    }
  });
});

describe('DELETE /api/rebac/tuples', () => {
  it('deletes the tuple, invalidates the cache and publishes a revoke event', async () => {
    const result = await call('DELETE', '/api/rebac/tuples', tupleBody);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ success: true, deleted: true });

    expect(probe.adapter.execute).toHaveBeenCalledTimes(1);
    const del = must(probe.adapter.execute.mock.calls[0]);
    expect(del[0]).toContain('DELETE FROM relationships');
    expect(del[1]).toEqual(['t1', 'subject', 'user', 'u1', 'document', 'doc1', 'viewer']);
    expect(del[0]).toContain('from_type IN (?, ?)');

    expect(probe.service.invalidateCache).toHaveBeenCalledWith('t1', 'document', 'doc1', 'viewer');
    expect(probe.notifierOptions).toEqual([
      {
        env: objectContaining({ PERMISSION_CHANGE_HUB: HUB }),
        cache: KV,
        permissionChangeHub: HUB,
        debug: false,
      },
    ]);
    expect(probe.events).toEqual([
      {
        event: 'revoke',
        tenant_id: 't1',
        subject_id: 'u1',
        resource: 'document:doc1',
        relation: 'viewer',
        permission: undefined,
        timestamp: NOW_MS,
      },
    ]);
  });

  it.each([0, undefined])(
    'reports nothing deleted and publishes no event when rowsAffected is %s',
    async (rowsAffected) => {
      probe.adapter.execute.mockResolvedValue({ rowsAffected });
      const result = await call('DELETE', '/api/rebac/tuples', tupleBody);
      expect(result.json).toEqual({ success: true, deleted: false });
      expect(probe.events).toEqual([]);
      expect(probe.service.invalidateCache).toHaveBeenCalledTimes(1);
    }
  );

  it('reports a deletion for a single affected row', async () => {
    probe.adapter.execute.mockResolvedValue({ rowsAffected: 1 });
    const result = await call('DELETE', '/api/rebac/tuples', tupleBody);
    expect(result.json.deleted).toBe(true);
  });

  it('still succeeds without a ReBAC service', async () => {
    probe.serviceThrows = true;
    const result = await call('DELETE', '/api/rebac/tuples', tupleBody);
    expect(result.json).toEqual({ success: true, deleted: true });
    expect(probe.service.invalidateCache).not.toHaveBeenCalled();
  });

  it('still succeeds, logging a warning, when the revoke notification fails', async () => {
    probe.publishThrows = true;
    const result = await call('DELETE', '/api/rebac/tuples', tupleBody);
    expect(result.json).toEqual({ success: true, deleted: true });
    expect(probe.logs).toEqual([
      {
        module: 'REBAC',
        level: 'warn',
        message: 'Permission change notification failed',
        data: { error: 'Error: hub down' },
      },
    ]);
  });
});

describe('POST /api/rebac/invalidate', () => {
  it('answers 500 before reading the body when the ReBAC service cannot be created', async () => {
    probe.serviceThrows = true;
    const result = await call('POST', '/api/rebac/invalidate', {
      tenant_id: 't1',
      type: 'user',
      user_id: 'u1',
    });
    expect(result.status).toBe(500);
    expect(probe.errors).toEqual([{ code: 'AR900001', options: undefined }]);
    expect(probe.logs).toEqual([]);
  });

  it('invalidates the cache of a user', async () => {
    const result = await call('POST', '/api/rebac/invalidate', {
      tenant_id: 't1\u00a0',
      type: 'user',
      user_id: 'u1',
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ success: true });
    expect(probe.service.invalidateUserCache).toHaveBeenCalledTimes(1);
    expect(probe.service.invalidateUserCache).toHaveBeenCalledWith('t1', 'u1');
    expect(probe.service.invalidateCache).not.toHaveBeenCalled();
  });

  it('requires user_id for a user invalidation', async () => {
    const result = await call('POST', '/api/rebac/invalidate', { tenant_id: 't1', type: 'user' });
    expect(result.status).toBe(400);
    expect(probe.errors).toEqual([
      { code: 'AR130001', options: { variables: { field: 'user_id' } } },
    ]);
    expect(probe.service.invalidateUserCache).not.toHaveBeenCalled();
  });

  it('invalidates the cache of an object', async () => {
    const result = await call('POST', '/api/rebac/invalidate', {
      tenant_id: 't1',
      type: 'object',
      object_type: 'document',
      object_id: 'doc1',
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ success: true });
    expect(probe.service.invalidateCache).toHaveBeenCalledTimes(1);
    expect(probe.service.invalidateCache.mock.calls[0]).toEqual(['t1', 'document', 'doc1']);
    expect(probe.service.invalidateUserCache).not.toHaveBeenCalled();
  });

  it.each([{ object_type: 'document' }, { object_id: 'doc1' }, {}])(
    'requires both object_type and object_id for an object invalidation: %j',
    async (extra) => {
      const result = await call('POST', '/api/rebac/invalidate', {
        tenant_id: 't1',
        type: 'object',
        ...extra,
      });
      expect(result.status).toBe(400);
      expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
      expect(probe.service.invalidateCache).not.toHaveBeenCalled();
    }
  );

  it.each([{ type: 'tenant', user_id: 'u1', object_type: 'd', object_id: 'o' }, {}])(
    'rejects an unknown or missing type: %j',
    async (extra) => {
      const result = await call('POST', '/api/rebac/invalidate', { tenant_id: 't1', ...extra });
      expect(result.status).toBe(400);
      expect(probe.errors).toEqual([{ code: 'AR130003', options: undefined }]);
      expect(probe.service.invalidateCache).not.toHaveBeenCalled();
      expect(probe.service.invalidateUserCache).not.toHaveBeenCalled();
    }
  );

  it('logs a failing invalidation and answers 500', async () => {
    probe.service.invalidateUserCache.mockRejectedValue(new Error('kv down'));
    const result = await call('POST', '/api/rebac/invalidate', {
      tenant_id: 't1',
      type: 'user',
      user_id: 'u1',
    });
    expect(result.status).toBe(500);
    expect(probe.logs).toEqual([
      {
        module: 'REBAC',
        level: 'error',
        message: 'ReBAC invalidate error',
        data: { error: 'Error: kv down' },
      },
    ]);
  });
});
