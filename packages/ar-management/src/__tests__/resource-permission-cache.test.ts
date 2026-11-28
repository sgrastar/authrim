import { describe, expect, it, vi } from 'vitest';
import { evaluateIdLevelPermissions, type DatabaseAdapter } from '@authrim/ar-lib-core';

const store = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsTenantId: () => 'tenant-a',
  resolveSettingsCoreAdapter: () => store.adapter,
}));

import {
  checkResourcePermission,
  createResourcePermission,
  deleteResourcePermission,
} from '../routes/settings/resource-permissions';

function kv() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void values.set(key, value)),
    delete: vi.fn(async (key: string) => void values.delete(key)),
  };
}

function database(rows: Array<Record<string, unknown>>): DatabaseAdapter {
  return {
    query: vi.fn(async (sql: string) => (sql.includes('FROM resource_permissions') ? rows : [])),
    queryOne: vi.fn(async (sql: string) =>
      sql.includes('FROM resource_permissions WHERE id = ?') ? (rows[0] ?? null) : null
    ),
    execute: vi.fn(async () => {
      rows.splice(0, rows.length);
      return { success: true, rowsAffected: 1 };
    }),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn(),
    getType: () => 'mock',
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe('resource permission cache', () => {
  it('drops the cached ID-level permissions of the subject a removed grant was for', async () => {
    const rows = [
      {
        id: 'rp-1',
        tenant_id: 'tenant-a',
        subject_type: 'user',
        subject_id: 'user-1',
        resource_type: 'documents',
        resource_id: 'doc-1',
        actions_json: '["read"]',
        condition_json: null,
        is_active: 1,
        expires_at: null,
      },
    ];
    const db = database(rows);
    store.adapter = db;
    const cache = kv();
    const dbs = { metadata: db, account: db };

    await expect(
      evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a', { cache: cache as never })
    ).resolves.toEqual(['documents:doc-1:read']);

    const response = await deleteResourcePermission({
      req: { param: () => 'rp-1' },
      env: { REBAC_CACHE: cache },
      get: () => undefined,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as never);

    expect(response.status).toBe(200);
    await expect(
      evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a', { cache: cache as never })
    ).resolves.toEqual([]);
  });

  it('reads a revoked grant as gone for a token even when the cache could not be invalidated', async () => {
    const rows = [
      {
        id: 'rp-1',
        tenant_id: 'tenant-a',
        subject_type: 'user',
        subject_id: 'user-1',
        resource_type: 'documents',
        resource_id: 'doc-1',
        actions_json: '["read"]',
        condition_json: null,
        is_active: 1,
        expires_at: null,
      },
    ];
    const db = database(rows);
    store.adapter = db;
    const cache = kv();
    const dbs = { metadata: db, account: db };
    // The cache is populated, then every write to it (the generation bump, the delete) fails.
    await evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a', { cache: cache as never });
    cache.put.mockRejectedValue(new Error('kv down'));
    cache.delete.mockRejectedValue(new Error('kv down'));

    const response = await deleteResourcePermission({
      req: { param: () => 'rp-1' },
      env: { REBAC_CACHE: cache },
      get: () => undefined,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as never);
    expect(response.status).toBe(200);

    // The token path (ar-token embeddedResourcePermissions) passes no cache: it reads the
    // database, so the revoked grant is gone whatever the cache still holds.
    cache.get.mockClear();
    await expect(evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a', {})).resolves.toEqual([]);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('grants a permission to a group of the tenant only, checked like a role grant to a group', async () => {
    const execute = vi.fn(async () => ({ success: true, rowsAffected: 1 }));
    const known = new Set(['grp-1']);
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(adapter));
    const adapter = {
      query: vi.fn(async () => []),
      queryOne: vi.fn(async (sql: string, params: unknown[] = []) =>
        sql.includes('FROM "groups"') && known.has(String(params[1])) ? { id: params[1] } : null
      ),
      execute,
      transaction,
      getType: () => 'mock',
    };
    store.adapter = adapter;
    const create = (subjectId: string) =>
      createResourcePermission({
        req: {
          json: async () => ({
            subject_type: 'group',
            subject_id: subjectId,
            resource_type: 'documents',
            resource_id: 'doc-1',
            actions: ['read'],
          }),
        },
        env: {},
        get: () => undefined,
        json: (body: unknown, status = 200) => Response.json(body, { status }),
      } as never);

    const refused = await create('grp-other');
    expect(refused.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect((await create('grp-1')).status).toBe(201);
    // The group's check and the insert ran in one transaction (under the catalog lock on PG).
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO resource_permissions'),
      expect.arrayContaining(['group', 'grp-1'])
    );
  });

  it.each([
    [{ resource_type: 'My-Docs' }, 'resource_type must match'],
    [{ resource_id: 'doc:1' }, 'resource_id must not contain whitespace'],
    [{ resource_id: 'doc 1' }, 'resource_id must not contain whitespace'],
    [{ resource_id: 'doc\u00001' }, 'resource_id must not contain whitespace'],
    [{ resource_id: 'doc\u007f1' }, 'resource_id must not contain whitespace'],
    [{ subject_id: 42 }, 'subject_id is required and must be a string'],
    [{ resource_type: ['documents'] }, 'resource_type is required and must be a string'],
    [{ resource_id: { id: 'doc_1' } }, 'resource_id is required and must be a string'],
    [{ subject_type: 1 }, 'subject_type must be'],
    [{ condition: false }, 'condition must be a JSON object'],
    [{ condition: null }, 'condition must be a JSON object'],
    [{ condition: 'ip=10/8' }, 'condition must be a JSON object'],
    [{ condition: [{ ip: '10/8' }] }, 'condition must be a JSON object'],
    [{ condition: 1 }, 'condition must be a JSON object'],
    [{ actions: ['Read'] }, 'each action must match'],
    [{ actions: ['read', 7] }, 'each action must match'],
  ])('refuses an ID-level grant outside the permission grammar %#', async (change, message) => {
    const execute = vi.fn();
    store.adapter = { query: vi.fn(), queryOne: vi.fn(), execute, getType: () => 'mock' };
    const response = await createResourcePermission({
      req: {
        json: async () => ({
          subject_type: 'user',
          subject_id: 'user-1',
          resource_type: 'documents',
          resource_id: 'doc_42',
          actions: ['read', '*'],
          ...change,
        }),
      },
      env: {},
      get: () => undefined,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as never);
    expect(response.status).toBe(400);
    const body = await response.json<{ error_description: string }>();
    expect(body.error_description).toContain(message);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a non-object body with 400', async () => {
    store.adapter = { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), getType: () => 'mock' };
    const response = await createResourcePermission({
      req: { json: async () => ['documents'] },
      env: {},
      get: () => undefined,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as never);
    expect(response.status).toBe(400);
  });

  it.each([
    { resource_type: 'My-Docs' },
    { resource_id: 'doc:1' },
    { resource_id: 'doc\u00001' },
    { action: '*' },
    { action: 'Read' },
    { resource_type: 7 },
    { subject_id: '' },
  ])('refuses a check outside the permission grammar %j', async (change) => {
    const query = vi.fn();
    store.adapter = { query, queryOne: query, execute: vi.fn(), getType: () => 'mock' };
    const response = await checkResourcePermission({
      req: {
        json: async () => ({
          subject_id: 'user-1',
          resource_type: 'documents',
          resource_id: 'doc_1',
          action: 'read',
          ...change,
        }),
      },
      env: {},
      get: () => undefined,
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    } as never);
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
