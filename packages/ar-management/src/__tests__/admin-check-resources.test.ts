/**
 * Admin API: the resource registry of self-contract checks (check resource types, read-only
 * registered resources), against the real D1 schema (core migration 021).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { openCoreStore } from './helpers/core-schema-sqlite';

const mocks = vi.hoisted(() => {
  const state: { adapter: unknown; tenantId: string } = {
    adapter: undefined,
    tenantId: 'tenant-a',
  };
  return {
    state,
    audit: vi.fn(
      async (_c: unknown, _input: { action: string }): Promise<string | null> => 'audit-1'
    ),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => mocks.state.tenantId,
  createAuthContextFromHono: () => ({ coreAdapter: mocks.state.adapter }),
}));
vi.mock('../admin-operation-audit', () => ({ recordAdminOperationAudit: mocks.audit }));

import {
  adminCheckResourceTypeDeleteHandler,
  adminCheckResourceTypeGetHandler,
  adminCheckResourceTypePutHandler,
  adminCheckResourceTypesListHandler,
  adminCheckResourcesListHandler,
} from '../admin-check-resources';

type Store = ReturnType<typeof openCoreStore>;

/** A response body (JSON). */
interface Json {
  [key: string]: unknown;
  relations?: Record<string, string>;
  resource_types?: { resource_type: string }[];
  resources?: (Record<string, unknown> & { resource_type: string; resource_id: string })[];
  next_cursor?: string | null;
}
let store: Store;

function app() {
  const routes = new Hono();
  routes.get('/api/admin/check-resource-types', adminCheckResourceTypesListHandler as never);
  routes.get('/api/admin/check-resource-types/:type', adminCheckResourceTypeGetHandler as never);
  routes.put('/api/admin/check-resource-types/:type', adminCheckResourceTypePutHandler as never);
  routes.delete(
    '/api/admin/check-resource-types/:type',
    adminCheckResourceTypeDeleteHandler as never
  );
  routes.get('/api/admin/check-resources', adminCheckResourcesListHandler as never);
  return routes;
}

async function call(method: string, path: string, body?: unknown) {
  const response = await app().request(path, {
    method,
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  });
  return { status: response.status, body: await response.json<Json>() };
}

function resource(
  tenantId: string,
  type: string,
  id: string,
  facts: { owner?: string; group?: string; attributes?: string | null } = {}
) {
  store.db
    .prepare(
      `INSERT INTO check_resources
         (tenant_id, resource_type, resource_id, owner_id, group_id, attributes_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 100)`
    )
    .run(tenantId, type, id, facts.owner ?? null, facts.group ?? null, facts.attributes ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  store = openCoreStore('tenant-a');
  mocks.state.adapter = store.adapter;
  mocks.state.tenantId = 'tenant-a';
});

describe('check resource types', () => {
  it('creates, replaces, reads, lists and deletes a type, with an audit entry per change', async () => {
    const created = await call('PUT', '/api/admin/check-resource-types/documents', {
      relations: { read: 'viewer', write: 'editor' },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      resource_type: 'documents',
      relations: { read: 'viewer', write: 'editor' },
    });
    expect(created.body.created_at).toBe(created.body.updated_at);
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'permission.check_resource_type.created',
        resourceType: 'check_resource_type',
        resourceId: 'documents',
      })
    );

    const replaced = await call('PUT', '/api/admin/check-resource-types/documents', {
      relations: { read: 'reader' },
    });
    expect(replaced.body.relations).toEqual({ read: 'reader' });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'permission.check_resource_type.updated',
        before: { relations: { read: 'viewer', write: 'editor' } },
        after: { relations: { read: 'reader' } },
      })
    );

    expect((await call('GET', '/api/admin/check-resource-types/documents')).body).toMatchObject({
      relations: { read: 'reader' },
    });
    await call('PUT', '/api/admin/check-resource-types/folders', { relations: {} });
    const listed = await call('GET', '/api/admin/check-resource-types');
    expect(listed.body.resource_types?.map((t) => t.resource_type)).toEqual([
      'documents',
      'folders',
    ]);
    expect(listed.body.next_cursor).toBeNull();

    expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(200);
    expect((await call('GET', '/api/admin/check-resource-types/documents')).status).toBe(404);
    expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(404);
  });

  it.each([
    ['a body that is not an object', '[]'],
    ['an unknown key', { relations: {}, description: 'x' }],
    ['no relations', {}],
    ['relations that are not an object', { relations: ['viewer'] }],
    ['an action outside the grammar', { relations: { Read: 'viewer' } }],
    ['an action with a colon', { relations: { 'doc:read': 'viewer' } }],
    ['a relation outside the grammar', { relations: { read: 'viewer-1' } }],
    ['a relation that is not a string', { relations: { read: 1 } }],
    [
      'more than 64 actions',
      { relations: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a${i}`, 'viewer'])) },
    ],
    ['JSON that does not parse', '{'],
  ])('refuses %s with 400', async (_name, body) => {
    const response = await call('PUT', '/api/admin/check-resource-types/documents', body);
    expect(response.status).toBe(400);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(['Documents', '1docs', 'doc-s'])('refuses the type %s in the path', async (type) => {
    expect(
      (await call('PUT', `/api/admin/check-resource-types/${type}`, { relations: {} })).status
    ).toBe(400);
    expect((await call('GET', `/api/admin/check-resource-types/${type}`)).status).toBe(400);
  });

  it('keeps each tenant to its own types', async () => {
    await call('PUT', '/api/admin/check-resource-types/documents', { relations: { read: 'v' } });
    mocks.state.tenantId = 'tenant-b';
    expect((await call('GET', '/api/admin/check-resource-types/documents')).status).toBe(404);
    expect((await call('GET', '/api/admin/check-resource-types')).body.resource_types).toEqual([]);
    expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(404);
  });

  it('pages types with a cursor', async () => {
    for (const type of ['c', 'a', 'b']) {
      await call('PUT', `/api/admin/check-resource-types/${type}`, { relations: {} });
    }
    const first = await call('GET', '/api/admin/check-resource-types?limit=2');
    expect(first.body.resource_types?.map((t) => t.resource_type)).toEqual(['a', 'b']);
    const second = await call(
      'GET',
      `/api/admin/check-resource-types?limit=2&cursor=${first.body.next_cursor}`
    );
    expect(second.body.resource_types?.map((t) => t.resource_type)).toEqual(['c']);
    expect(second.body.next_cursor).toBeNull();
    expect((await call('GET', '/api/admin/check-resource-types?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/admin/check-resource-types?limit=201')).status).toBe(400);
    expect((await call('GET', '/api/admin/check-resource-types?cursor=@@')).status).toBe(400);
  });
});

describe('check resource type writes and their audit records (audit first)', () => {
  const typeRow = () =>
    store.db
      .prepare(
        `SELECT relations_json, revision, created_at FROM check_resource_types
          WHERE tenant_id = 'tenant-a' AND resource_type = 'documents'`
      )
      .get() as { relations_json: string; revision: number; created_at: number } | undefined;
  const actions = () => mocks.audit.mock.calls.map(([, input]) => input.action);
  const put = (relations: Record<string, string>) =>
    call('PUT', '/api/admin/check-resource-types/documents', { relations });

  it('records the change before writing it, with the map it replaces and the map it writes', async () => {
    mocks.audit.mockImplementationOnce(async () => {
      // Recorded first: nothing is written yet.
      expect(typeRow()).toBeUndefined();
      return 'audit-1';
    });
    await put({ read: 'viewer' });
    await put({ read: 'reader' });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'permission.check_resource_type.updated',
        before: { relations: { read: 'viewer' } },
        after: { relations: { read: 'reader' } },
      })
    );
    expect(typeRow()).toMatchObject({ relations_json: '{"read":"reader"}', revision: 1 });
    await call('DELETE', '/api/admin/check-resource-types/documents');
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'permission.check_resource_type.deleted',
        before: { relations: { read: 'reader' } },
      })
    );
    expect(typeRow()).toBeUndefined();
  });

  it('records its changes in the fail-closed audit class (a failed record fails the request)', async () => {
    const { resolveAuditEventFailureBehavior } = await import('@authrim/ar-lib-core');
    for (const action of ['created', 'updated', 'deleted']) {
      expect(
        resolveAuditEventFailureBehavior(`permission.check_resource_type.${action}`).behavior
      ).toBe('fail_closed_or_strong_retry');
    }
  });

  it('writes nothing when the audit record fails (creation, replacement, deletion)', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('admin_audit_write_failed'));
    expect((await put({ read: 'viewer' })).status).toBe(500);
    expect(typeRow()).toBeUndefined();

    await put({ read: 'viewer' });
    const stored = typeRow();
    mocks.audit.mockRejectedValueOnce(new Error('admin_audit_write_failed'));
    expect((await put({ read: 'reader' })).status).toBe(500);
    expect(typeRow()).toEqual(stored);

    mocks.audit.mockRejectedValueOnce(new Error('admin_audit_write_failed'));
    expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(500);
    expect(typeRow()).toEqual(stored);
  });

  it('lets one of two concurrent creations win; the other is 409, recorded as aborted', async () => {
    // Both requests read "no row" and record their creation before either writes.
    let release: () => void = () => {};
    const bothRecorded = new Promise<void>((resolve) => (release = resolve));
    let recorded = 0;
    mocks.audit.mockImplementation(async (_c: unknown, input: { action: string }) => {
      if (input.action.endsWith('.created') && ++recorded === 2) release();
      if (input.action.endsWith('.created')) await bothRecorded;
      return 'audit';
    });
    const [first, second] = await Promise.all([put({ read: 'viewer' }), put({ read: 'reader' })]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const lost = first.status === 409 ? first : second;
    expect(lost.body.error).toBe('check_resource_type_conflict');
    expect(actions()).toEqual([
      'permission.check_resource_type.created',
      'permission.check_resource_type.created',
      'permission.check_resource_type.aborted',
    ]);
    const winner = first.status === 200 ? first : second;
    expect(typeRow()?.relations_json).toBe(JSON.stringify(winner.body.relations));
  });

  it('refuses with 409 a replacement another write overtook, writing nothing', async () => {
    await put({ read: 'viewer' });
    mocks.audit.mockClear();
    mocks.audit.mockImplementationOnce(async () => {
      // Another administrator's write lands after this request's read.
      store.db
        .prepare(
          `UPDATE check_resource_types SET relations_json = '{"read":"other"}', revision = revision + 1
            WHERE tenant_id = 'tenant-a' AND resource_type = 'documents'`
        )
        .run();
      return 'audit-1';
    });
    const response = await put({ read: 'mine' });
    expect(response.status).toBe(409);
    expect(typeRow()?.relations_json).toBe('{"read":"other"}');
    expect(actions()).toEqual([
      'permission.check_resource_type.updated',
      'permission.check_resource_type.aborted',
    ]);
  });

  it('answers 409 even when the aborted record cannot be written', async () => {
    await put({ read: 'viewer' });
    mocks.audit.mockImplementationOnce(async () => {
      store.db
        .prepare(
          `UPDATE check_resource_types SET revision = revision + 1 WHERE tenant_id = 'tenant-a'`
        )
        .run();
      return 'audit-1';
    });
    mocks.audit.mockRejectedValueOnce(new Error('admin_audit_write_failed'));
    expect((await put({ read: 'mine' })).status).toBe(409);
  });

  it('never deletes or overwrites a type deleted and created again in the same millisecond', async () => {
    // Every write in this test happens at the same millisecond: timestamps cannot tell rows apart.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      await put({ read: 'viewer' });
      // Another administrator deletes the type and creates it again (same map, revision 0, same
      // created_at): only its row token differs.
      const recreate = async () => {
        expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(
          200
        );
        expect((await put({ read: 'viewer' })).status).toBe(200);
      };
      const recreatedRow = async () => {
        await recreate();
        return store.db
          .prepare(`SELECT * FROM check_resource_types WHERE tenant_id = 'tenant-a'`)
          .get();
      };

      // A DELETE that read the first row, the type re-created meanwhile.
      let recreated: unknown;
      mocks.audit.mockImplementationOnce(async () => {
        recreated = await recreatedRow();
        return 'audit-1';
      });
      expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(409);
      expect(
        store.db.prepare(`SELECT * FROM check_resource_types WHERE tenant_id = 'tenant-a'`).get()
      ).toEqual(recreated);

      // A PUT that read the row, the type re-created meanwhile: the new row is not overwritten.
      mocks.audit.mockImplementationOnce(async () => {
        recreated = await recreatedRow();
        return 'audit-1';
      });
      expect((await put({ read: 'stale' })).status).toBe(409);
      expect(
        store.db.prepare(`SELECT * FROM check_resource_types WHERE tenant_id = 'tenant-a'`).get()
      ).toEqual(recreated);
      expect(actions().filter((action) => action.endsWith('.aborted'))).toHaveLength(2);

      // Deleted for good: nothing brings it back.
      expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(200);
      expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(404);
      expect(typeRow()).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  describe('a write retried after it had landed (D1 transport retry)', () => {
    /** An adapter that applies each type write, then answers as its retry did (nothing changed). */
    function retryingAdapter() {
      const adapter = store.adapter;
      return {
        ...adapter,
        execute: async (sql: string, params?: unknown[]) => {
          if (!/check_resource_types/.test(sql) || /^\s*SELECT/i.test(sql)) {
            return adapter.execute(sql, params);
          }
          await adapter.execute(sql, params);
          // The response was lost to a retryable transport error; the retry finds nothing to do.
          return adapter.execute(sql, params);
        },
      };
    }

    it('answers success, without an aborted record, for a creation, an update and a deletion', async () => {
      mocks.state.adapter = retryingAdapter();
      const created = await put({ read: 'viewer' });
      expect(created.status).toBe(200);
      const updated = await put({ read: 'reader' });
      expect(updated.status).toBe(200);
      expect(typeRow()).toMatchObject({ relations_json: '{"read":"reader"}', revision: 1 });
      expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(200);
      expect(typeRow()).toBeUndefined();
      expect(actions()).toEqual([
        'permission.check_resource_type.created',
        'permission.check_resource_type.updated',
        'permission.check_resource_type.deleted',
      ]);
    });

    it('still answers 409 when the row is not this request change', async () => {
      await put({ read: 'viewer' });
      mocks.audit.mockClear();
      mocks.audit.mockImplementationOnce(async () => {
        store.db
          .prepare(
            `UPDATE check_resource_types SET relations_json = '{"read":"other"}', revision = revision + 1
              WHERE tenant_id = 'tenant-a'`
          )
          .run();
        return 'audit-1';
      });
      mocks.state.adapter = retryingAdapter();
      expect((await put({ read: 'reader' })).status).toBe(409);
      expect(actions()).toEqual([
        'permission.check_resource_type.updated',
        'permission.check_resource_type.aborted',
      ]);
    });
  });

  describe('outcomes of the conditional write', () => {
    const abortedReasons = () =>
      mocks.audit.mock.calls
        .map(([, input]) => input as { action: string; metadata?: { reason?: string } })
        .filter((input) => input.action.endsWith('.aborted'))
        .map((input) => input.metadata?.reason);
    const isTypeWrite = (sql: string) =>
      /^\s*(UPDATE|INSERT|DELETE)/i.test(sql) && /check_resource_types/.test(sql);

    it('answers 500 with an aborted record (error) when the read-back after a 0-row write fails', async () => {
      await put({ read: 'viewer' });
      const adapter = store.adapter;
      let reads = 0;
      mocks.state.adapter = {
        ...adapter,
        execute: async (sql: string, params?: unknown[]) =>
          isTypeWrite(sql) ? { success: true, rowsAffected: 0 } : adapter.execute(sql, params),
        queryOne: async (sql: string, params?: unknown[]) => {
          // The first read is the request's own; the read-back after the 0-row write fails.
          if (/check_resource_types/.test(sql) && ++reads === 2) throw new Error('D1 unavailable');
          return adapter.queryOne(sql, params);
        },
      };
      expect((await put({ read: 'reader' })).status).toBe(500);
      reads = 0;
      expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(500);
      expect(abortedReasons()).toEqual(['error', 'error']);
      expect(typeRow()?.relations_json).toBe('{"read":"viewer"}');
    });

    it('treats a write reported as failed (success false) as an error, not a conflict', async () => {
      await put({ read: 'viewer' });
      const adapter = store.adapter;
      mocks.state.adapter = {
        ...adapter,
        execute: async (sql: string, params?: unknown[]) =>
          isTypeWrite(sql) ? { success: false, rowsAffected: 0 } : adapter.execute(sql, params),
      };
      expect((await put({ read: 'reader' })).status).toBe(500);
      expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(500);
      expect(abortedReasons()).toEqual(['error', 'error']);
      expect(typeRow()?.relations_json).toBe('{"read":"viewer"}');
    });

    it('answers an already-applied write with the row as stored, not this request values', async () => {
      const adapter = store.adapter;
      mocks.state.adapter = {
        ...adapter,
        execute: async (sql: string, params?: unknown[]) => {
          if (!isTypeWrite(sql)) return adapter.execute(sql, params);
          await adapter.execute(sql, params);
          // The retried write had landed earlier: the row carries that attempt's time.
          store.db
            .prepare(
              `UPDATE check_resource_types SET created_at = 1000, updated_at = 2000 WHERE tenant_id = 'tenant-a'`
            )
            .run();
          return { success: true, rowsAffected: 0 };
        },
      };
      const created = await put({ read: 'viewer' });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        relations: { read: 'viewer' },
        created_at: 1000,
        updated_at: 2000,
      });
      const updated = await put({ read: 'reader' });
      expect(updated.body).toMatchObject({ relations: { read: 'reader' }, updated_at: 2000 });
      expect(abortedReasons()).toEqual([]);
    });
  });

  describe('a write that fails after its audit record', () => {
    function failingAdapter(applyFirst: boolean) {
      const adapter = store.adapter;
      return {
        ...adapter,
        execute: async (sql: string, params?: unknown[]) => {
          if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql) && /check_resource_types/.test(sql)) {
            if (applyFirst) await adapter.execute(sql, params);
            throw new Error('D1_ERROR: database rejected the write');
          }
          return adapter.execute(sql, params);
        },
      };
    }
    const aborted = () =>
      mocks.audit.mock.calls
        .map(([, input]) => input as { action: string; metadata?: Record<string, unknown> })
        .filter((input) => input.action.endsWith('.aborted'));

    it('answers 500 after an aborted record with reason error (creation, update, deletion)', async () => {
      mocks.state.adapter = failingAdapter(false);
      expect((await put({ read: 'viewer' })).status).toBe(500);
      expect(typeRow()).toBeUndefined();
      mocks.state.adapter = store.adapter;
      await put({ read: 'viewer' });
      mocks.state.adapter = failingAdapter(false);
      expect((await put({ read: 'reader' })).status).toBe(500);
      expect((await call('DELETE', '/api/admin/check-resource-types/documents')).status).toBe(500);
      expect(typeRow()?.relations_json).toBe('{"read":"viewer"}');
      expect(aborted().map((input) => input.metadata)).toEqual([
        { intended: 'permission.check_resource_type.created', reason: 'error' },
        { intended: 'permission.check_resource_type.updated', reason: 'error' },
        { intended: 'permission.check_resource_type.deleted', reason: 'error' },
      ]);
    });

    it('answers 500 when the aborted record fails too (logged only)', async () => {
      mocks.state.adapter = failingAdapter(false);
      mocks.audit.mockResolvedValueOnce('audit-1');
      mocks.audit.mockRejectedValueOnce(new Error('admin_audit_write_failed'));
      expect((await put({ read: 'viewer' })).status).toBe(500);
    });

    it('answers success when the failed write had landed after all (no aborted record)', async () => {
      mocks.state.adapter = failingAdapter(true);
      expect((await put({ read: 'viewer' })).status).toBe(200);
      expect(typeRow()?.relations_json).toBe('{"read":"viewer"}');
      expect(aborted()).toEqual([]);
    });
  });

  it('stores times in milliseconds', async () => {
    const before = Date.now();
    const created = await put({ read: 'viewer' });
    expect(created.body.updated_at).toBeGreaterThanOrEqual(before);
    expect(typeRow()?.created_at).toBe(created.body.created_at);
  });
});

describe('registered check resources (read only)', () => {
  beforeEach(() => {
    resource('tenant-a', 'documents', 'doc_1', {
      owner: 'user-1',
      group: 'group-1',
      attributes: '{"classification":"internal"}',
    });
    resource('tenant-a', 'documents', 'doc_2');
    resource('tenant-a', 'folders', 'f_1');
    resource('tenant-b', 'documents', 'doc_1', { owner: 'user-9' });
  });

  it('lists the resources of the tenant in type and id order, with their facts', async () => {
    const listed = await call('GET', '/api/admin/check-resources');
    expect(listed.status).toBe(200);
    expect(listed.body.resources).toEqual([
      {
        resource_type: 'documents',
        resource_id: 'doc_1',
        owner_id: 'user-1',
        group_id: 'group-1',
        attributes: { classification: 'internal' },
        updated_at: 100,
      },
      {
        resource_type: 'documents',
        resource_id: 'doc_2',
        owner_id: null,
        group_id: null,
        attributes: null,
        updated_at: 100,
      },
      expect.objectContaining({ resource_type: 'folders', resource_id: 'f_1' }),
    ]);
    expect(listed.body.next_cursor).toBeNull();
  });

  it('filters by type and id', async () => {
    const byType = await call('GET', '/api/admin/check-resources?resource_type=folders');
    expect(byType.body.resources?.map((r) => r.resource_id)).toEqual(['f_1']);
    const byId = await call(
      'GET',
      '/api/admin/check-resources?resource_type=documents&resource_id=doc_1'
    );
    expect(byId.body.resources).toHaveLength(1);
    expect(byId.body.resources?.[0]?.owner_id).toBe('user-1');
  });

  it('pages across types with a cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: Json } = await call(
        'GET',
        `/api/admin/check-resources?limit=1${cursor ? `&cursor=${cursor}` : ''}`
      );
      seen.push(...(page.body.resources ?? []).map((r) => `${r.resource_type}:${r.resource_id}`));
      cursor = page.body.next_cursor ?? null;
    } while (cursor);
    expect(seen).toEqual(['documents:doc_1', 'documents:doc_2', 'folders:f_1']);
  });

  it.each([
    'resource_type=Docs',
    'resource_id=has%20space',
    'resource_id=a%3Ab',
    'limit=x',
    'cursor=bm90LWpzb24',
  ])('refuses %s with 400', async (query) => {
    expect((await call('GET', `/api/admin/check-resources?${query}`)).status).toBe(400);
  });

  it('answers a stored attribute value that is not an object as invalid, not as an error', async () => {
    store.db
      .prepare(
        `UPDATE check_resources SET attributes_json = '[1]' WHERE tenant_id = 'tenant-a' AND resource_id = 'doc_2'`
      )
      .run();
    const listed = await call('GET', '/api/admin/check-resources?resource_id=doc_2');
    expect(listed.body.resources?.[0]).toMatchObject({
      attributes: null,
      attributes_invalid: true,
    });
  });
});
