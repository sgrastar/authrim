import { describe, expect, it, vi } from 'vitest';
import { evaluateIdLevelPermissions, type DatabaseAdapter } from '@authrim/ar-lib-core';

const store = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../routes/settings/tenant-resolver', () => ({
  resolveSettingsTenantId: () => 'tenant-a',
  resolveSettingsCoreAdapter: () => store.adapter,
}));

import { deleteResourcePermission } from '../routes/settings/resource-permissions';

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
});
