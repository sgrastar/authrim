import { CanonicalRuntimeUserWriter, CanonicalIdentityRepository } from '@authrim/ar-lib-core';
import { Hono } from 'hono';
import * as groupRuntime from '../dynamic-groups-runtime';
import {
  serviceGroupsRead,
  serviceGroupWrite,
  serviceGroupValidate,
  serviceGroupSubject,
  serviceGroupMembers,
} from '../service-groups';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import {
  DynamicGroupStore,
  type GroupInputReader,
} from '../../../ar-lib-core/dist/services/dynamic-groups/store';
import {
  SavedGroupInputReader,
  loadGroupFields,
} from '../../../ar-lib-core/dist/services/dynamic-groups/inputs';
import {
  BUILTIN_GROUP_FIELDS,
  type ServiceGroup,
} from '../../../ar-lib-core/dist/services/dynamic-groups/model';
import { withGroupInputWrite } from '../../../ar-lib-core/dist/services/dynamic-groups/write-boundary';
import { processServiceGroupShard } from '../dynamic-groups-runtime';
let databases: SQLiteDatabase[];
function database(family: 'core' | 'pii') {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const files =
    family === 'core'
      ? [
          '001_0_4_0_core_baseline.sql',
          '002_guest_account_lifecycle.sql',
          '003_account_registration_state.sql',
          '005_account_webhook_outbox.sql',
          '006_webhook_payload_fields.sql',
          '007_service_dynamic_groups.sql',
        ]
      : [
          '001_0_4_0_pii_baseline.sql',
          '003_account_webhook_outbox.sql',
          '004_account_webhook_snapshots.sql',
          '005_service_dynamic_groups.sql',
        ];
  for (const file of files)
    db.exec(
      renderPortableMigrationSql(
        readFileSync(
          new URL(`../../../../migrations/${family}/d1/${file}`, import.meta.url),
          'utf8'
        ),
        'sqlite'
      )
    );
  const adapter: DatabaseAdapter = {
    query: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as SQLInputValue[])) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) =>
      (db.prepare(sql).get(...(params as SQLInputValue[])) ?? null) as T | null,
    execute: async (sql, params = []) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
    }),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const result = [];
        for (const s of statements) result.push(await adapter.execute(s.sql, s.params));
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: async (fn) => {
      db.exec('BEGIN');
      try {
        const result = await fn(adapter);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    getType: () => 'mock',
    close: async () => {},
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'mock' }),
  };
  return { db, adapter };
}
let meta: ReturnType<typeof database>,
  core: ReturnType<typeof database>,
  pii: ReturnType<typeof database>,
  store: DynamicGroupStore,
  reader: SavedGroupInputReader;
const group = (id = 'japan'): ServiceGroup => ({
  id,
  tenantId: 't',
  key: id,
  displayName: id,
  description: '',
  enabled: true,
  condition: { op: 'attribute', field: 'country', compare: 'eq', value: 'JP' },
});
function account(id = 'u', tenant = 't') {
  core.db
    .prepare(
      `INSERT INTO identity_accounts(id, tenant_id, legacy_user_id, account_type, lifecycle_state, registration_state, directory_publication_state, created_at, updated_at) VALUES (?, ?, ?, 'user', 'active', 'registered', 'active', 1, 1)`
    )
    .run(`account:${tenant}:${id}`, tenant, id);
}
function country(value: string) {
  pii.db
    .prepare(
      `INSERT INTO identity_sensitive_values(id, tenant_id, owner_type, owner_id, value_key, value_json, classification, lifecycle_state, created_at, updated_at) VALUES ('country', 't', 'runtime_user', 'u', 'address_country', ?, 'sensitive', 'active', 1, 1) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json`
    )
    .run(JSON.stringify(value));
}
beforeEach(() => {
  databases = [];
  meta = database('core');
  core = database('core');
  pii = database('pii');
  store = new DynamicGroupStore(meta.adapter, 't');
  reader = new SavedGroupInputReader(meta.adapter, core.adapter, pii.adapter, 't', 'u');
  account();
  country('JP');
});
afterEach(() => {
  vi.restoreAllMocks();
  databases.forEach((db) => db.close());
});
describe('durable service membership publication', () => {
  it.each(['', '{', 'null', '[]', 'true', '"value"'])(
    'rejects invalid JSON object body %j without changing state',
    async (raw) => {
      vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockResolvedValue({ store, reader: null });
      const app = new Hono<{
        Bindings: import('@authrim/ar-lib-core').Env;
        Variables: { adminAuth: { userId?: string } };
      }>();
      app.post('/api/admin/service-groups', serviceGroupWrite);
      app.put('/api/admin/service-groups/:id', serviceGroupWrite);
      app.delete('/api/admin/service-groups/:id', serviceGroupWrite);
      app.post('/api/admin/service-groups/validate', serviceGroupValidate);
      for (const [method, path] of [
        ['POST', ''],
        ['PUT', '/japan'],
        ['DELETE', '/japan'],
        ['POST', '/validate'],
      ]) {
        const response = await app.request(`/api/admin/service-groups${path}`, {
          method,
          headers: { 'X-Tenant-Id': 't', 'Content-Type': 'application/json' },
          body: raw,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'group_request_invalid' });
      }
      expect(await store.catalog()).toBeNull();
      expect(meta.db.prepare('SELECT * FROM service_group_audit').all()).toEqual([]);
    }
  );
  it('retains a failed freshness marker when one member cannot be routed, without failing the page', async () => {
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    await store.evaluate('u', reader);
    vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockImplementation(async (_env, tenant, id) => {
      if (tenant !== 't' || id) throw new Error('group_input_unavailable');
      return { store, reader: null };
    });
    const app = new Hono<{
      Bindings: import('@authrim/ar-lib-core').Env;
      Variables: { adminAuth: { userId?: string } };
    }>();
    app.get('/api/admin/service-groups/:id/members', serviceGroupMembers);
    const response = await app.request('/api/admin/service-groups/japan/members', {
      headers: { 'X-Tenant-Id': 't' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      members: [{ userId: 'u', freshness: 'failed', ruleVersion: 1 }],
      nextCursor: null,
    });
  });
  it('validates, previews and edits through the management HTTP contract without publishing previews', async () => {
    vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockImplementation(async (_env, tenant, id) => {
      if (tenant !== 't' || (id && id !== 'u')) throw new Error('group_subject_invalid');
      return { store, reader: id ? reader : null };
    });
    const app = new Hono<{
      Bindings: import('@authrim/ar-lib-core').Env;
      Variables: { adminAuth: { userId?: string } };
    }>();
    app.use('*', async (c, next) => {
      c.set('adminAuth', { userId: 'operator' });
      await next();
    });
    app.get('/api/admin/service-groups', serviceGroupsRead);
    app.post('/api/admin/service-groups', serviceGroupWrite);
    app.put('/api/admin/service-groups/:id', serviceGroupWrite);
    app.delete('/api/admin/service-groups/:id', serviceGroupWrite);
    app.post('/api/admin/service-groups/validate', serviceGroupValidate);
    app.get('/api/admin/service-groups/subjects/:userId', serviceGroupSubject);
    const request = (path: string, method = 'GET', body?: unknown, tenant = 't') =>
      app.request('/api/admin/service-groups' + path, {
        method,
        headers: { 'X-Tenant-Id': tenant, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const created = await request('', 'POST', { ...group(), ifMatch: 0 });
    expect(created.status).toBe(200);
    const catalog = (await created.json()) as { revision: number; groups: ServiceGroup[] };
    const id = catalog.groups[0].id;
    expect(id).not.toBe('japan');
    const preview = await request('/validate', 'POST', { ...group(), id, userId: 'u' });
    expect(preview.status).toBe(200);
    expect(meta.db.prepare('SELECT * FROM service_group_results').all()).toHaveLength(0);
    expect((await request('/' + id, 'PUT', { ...group(), ifMatch: 0 })).status).toBe(409);
    expect(
      (
        await request('/' + id, 'PUT', {
          ...group(),
          condition: { op: 'member', groupId: id },
          ifMatch: 1,
        })
      ).status
    ).toBe(400);
    expect((await request('/validate', 'POST', { ...group(), userId: 'u' }, 'other')).status).toBe(
      400
    );
    expect((await request('/' + id, 'DELETE', { ifMatch: 1 })).status).toBe(200);
    expect((await store.catalog())?.plan.groups).toEqual([]);
  });
  it('observes canonical registration and verified-email writes through the shared writer', async () => {
    const writer = new CanonicalRuntimeUserWriter(
      new CanonicalIdentityRepository(core.adapter, 't'),
      pii.adapter
    );
    await writer.createFromRuntimeUser({
      tenantId: 't',
      userId: 'created',
      active: true,
      emailVerified: false,
      userType: 'end_user',
      piiFields: { email: true },
      sensitiveValues: { email: 'person@Example.com' },
    });
    // Model the existing directory producer's final publication, after the authoritative write.
    core.db.exec(
      "UPDATE identity_accounts SET directory_publication_state = 'active' WHERE tenant_id = 't' AND legacy_user_id = 'created'"
    );
    await store.save(
      [
        {
          ...group(),
          condition: {
            op: 'attribute',
            field: 'email_domain',
            compare: 'eq',
            value: 'example.com',
          },
        },
      ],
      BUILTIN_GROUP_FIELDS,
      0,
      'admin'
    );
    const createdReader = new SavedGroupInputReader(
      meta.adapter,
      core.adapter,
      pii.adapter,
      't',
      'created'
    );
    expect((await store.evaluate('created', createdReader)).evaluation?.groups.japan.member).toBe(
      'unknown'
    );
    await writer.syncFromRuntimeUser({
      tenantId: 't',
      userId: 'created',
      active: true,
      emailVerified: true,
      userType: 'end_user',
      piiFields: { email: true },
      sensitiveValues: { email: 'person@Example.com' },
    });
    expect((await store.snapshot('created', createdReader)).freshness).toBe('stale');
    expect((await store.evaluate('created', createdReader)).evaluation?.groups.japan.member).toBe(
      true
    );
    expect(await createdReader.unsettledWrites()).toEqual([]);
  });
  it('publishes a whole snapshot with versions and becomes stale on a PII-only change', async () => {
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(true);
    country('US');
    expect((await store.snapshot('u', reader)).freshness).toBe('stale');
    const next = await store.evaluate('u', reader);
    expect(next.freshness).toBe('fresh');
    expect(next.evaluation?.groups.japan.member).toBe(false);
    expect(next.explanation).toContainEqual(
      expect.objectContaining({
        field: 'country',
        compare: 'eq',
        expected: 'JP',
        result: false,
        children: [],
      })
    );
    expect(
      meta.db
        .prepare('SELECT detail_json FROM service_group_audit')
        .all()
        .map((r) => JSON.stringify(r))
        .join('')
    ).not.toContain('address_country');
  });
  it('changes routing generations without comparing counters from different shards', async () => {
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    let route = 'old';
    let count = 100;
    const routed: GroupInputReader = {
      tenantId: 't',
      userId: 'u',
      load: (plan) => reader.load(plan),
      version: async () => ({ core: count, pii: count, metadata: 0, epoch: 0, route }),
    };
    expect((await store.evaluate('u', routed)).freshness).toBe('fresh');
    route = 'new';
    count = 1;
    country('US');
    expect((await store.snapshot('u', routed)).freshness).toBe('stale');
    const next = await store.evaluate('u', routed);
    expect(next.inputVersion.route).toBe('new');
    expect(next.evaluation?.groups.japan.member).toBe(false);
    const obsolete = new SavedGroupInputReader(meta.adapter, core.adapter, pii.adapter, 't', 'u', {
      stamp: 'old',
      verify: async () => {
        throw new Error('group_input_route_changed');
      },
    });
    await expect(store.evaluate('u', obsolete)).rejects.toThrow('route_changed');
    expect((await store.snapshot('u', routed)).generation).toBe(next.generation);
  });
  it('rejects racing rule saves and never publishes with an old catalog', async () => {
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    await expect(store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'other')).rejects.toThrow(
      'conflict'
    );
    const racing: GroupInputReader = {
      tenantId: 't',
      userId: 'u',
      version: () => reader.version(),
      load: async (plan) => {
        const data = await reader.load(plan);
        await store.save([], BUILTIN_GROUP_FIELDS, 1, 'admin');
        return data;
      },
    };
    await expect(store.evaluate('u', racing)).rejects.toThrow('superseded');
    expect((await store.snapshot('u', reader)).evaluation).toBeNull();
  });
  it('rejects mixed versions, read failure and concurrent evaluation; retries current input', async () => {
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    const racing: GroupInputReader = {
      tenantId: 't',
      userId: 'u',
      version: () => reader.version(),
      load: async (plan) => {
        const data = await reader.load(plan);
        country('US');
        return data;
      },
    };
    await expect(store.evaluate('u', racing)).rejects.toThrow('input_changed');
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(false);
    const failing: GroupInputReader = {
      tenantId: 't',
      userId: 'u',
      version: () => reader.version(),
      load: async () => {
        throw new Error('PII failure');
      },
    };
    await expect(store.evaluate('u', failing)).rejects.toThrow('input_unavailable');
    expect((await store.snapshot('u', reader)).freshness).toBe('failed');
    await meta.adapter.execute(
      `UPDATE service_group_results SET lease_until = ? WHERE tenant_id = 't' AND user_id = 'u'`,
      [Date.now() + 60000]
    );
    await expect(store.evaluate('u', reader)).rejects.toThrow('busy');
  });
  it('fences a worker whose lease was superseded', async () => {
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    const stale: GroupInputReader = {
      tenantId: 't',
      userId: 'u',
      version: () => reader.version(),
      load: async (plan) => {
        await meta.adapter.execute(
          "UPDATE service_group_results SET lease_token = 'new-worker' WHERE tenant_id = 't' AND user_id = 'u'"
        );
        return reader.load(plan);
      },
    };
    await expect(store.evaluate('u', stale)).rejects.toThrow('superseded');
    expect(meta.db.prepare('SELECT result_json FROM service_group_results').get()).toEqual({
      result_json: null,
    });
  });
  it('keeps manual and explicitly linked SCIM memberships independent', async () => {
    meta.db.exec(
      "INSERT INTO roles(id, tenant_id, name, permissions_json, created_at) VALUES ('scim', 't', 'Scim', '[]', 1); INSERT INTO users_core(id, tenant_id, created_at, updated_at) VALUES ('u', 't', 1, 1); INSERT INTO user_roles(tenant_id, user_id, role_id, created_at) VALUES ('t', 'u', 'scim', 1)"
    );
    await store.save([{ ...group(), scimRoleId: 'scim' }], BUILTIN_GROUP_FIELDS, 0, 'admin');
    await store.setManual('u', 'japan', true, 'admin');
    country('US');
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.sources).toEqual([
      'manual',
      'scim',
    ]);
    meta.db.exec("DELETE FROM user_roles WHERE tenant_id = 't'");
    expect((await store.snapshot('u', reader)).freshness).toBe('stale');
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.sources).toEqual([
      'manual',
    ]);
    await store.setManual('u', 'japan', false, 'admin');
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(false);
  });
  it('does not turn deleted SCIM links into membership through negation', async () => {
    meta.db.exec(
      "INSERT INTO roles(id, tenant_id, name, permissions_json, created_at) VALUES ('scim', 't', 'Scim', '[]', 1)"
    );
    await store.save(
      [
        { ...group(), condition: null, scimRoleId: 'scim' },
        { ...group('inverse'), condition: { op: 'not', arg: { op: 'member', groupId: 'japan' } } },
      ],
      BUILTIN_GROUP_FIELDS,
      0,
      'admin'
    );
    meta.db.exec("DELETE FROM roles WHERE id = 'scim'");
    expect((await store.evaluate('u', reader)).evaluation?.groups.inverse.member).toBe('unknown');
  });
  it('prevents cross-tenant reads even with the same legacy user ID', async () => {
    const other = new SavedGroupInputReader(meta.adapter, core.adapter, pii.adapter, 'other', 'u');
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    await expect(store.evaluate('u', other)).rejects.toThrow('tenant_or_subject_mismatch');
  });
  it('blocks partial multi-field writes and retains failed boundaries until explicit recovery', async () => {
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    await withGroupInputWrite(core.adapter, 't', 'u', 'custom-claims', async () => {
      country('US');
      await expect(reader.version()).rejects.toThrow('unsettled');
    });
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(false);
    await expect(
      withGroupInputWrite(pii.adapter, 't', 'u', 'canonical-user', async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');
    expect((await store.snapshot('u', reader)).freshness).toBe('failed');
    const boundaries = await reader.unsettledWrites();
    expect(boundaries).toHaveLength(1);
    await expect(reader.acceptFailedWrites(['another-user-boundary'], 'admin')).rejects.toThrow(
      'conflict'
    );
    await reader.acceptFailedWrites(
      boundaries.map((row) => row.id),
      'admin'
    );
    expect((await store.evaluate('u', reader)).freshness).toBe('fresh');
    expect(
      meta.db
        .prepare("SELECT event_type FROM service_group_audit WHERE event_type = 'input_recovery'")
        .all()
    ).toHaveLength(1);
    await withGroupInputWrite(core.adapter, 't', 'u', 'active', async () => {
      const active = await reader.unsettledWrites();
      await expect(
        reader.acceptFailedWrites(
          active.map((row) => row.id),
          'admin'
        )
      ).rejects.toThrow('conflict');
    });
  });
  it('picks up registration state and custom-claim schema changes without event payloads', async () => {
    await store.save(
      [
        {
          ...group(),
          condition: {
            op: 'attribute',
            field: 'registration_state',
            compare: 'eq',
            value: 'guest',
          },
        },
      ],
      await loadGroupFields(meta.adapter, 't'),
      0,
      'admin'
    );
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(false);
    core.db.exec("UPDATE identity_accounts SET registration_state = 'guest' WHERE tenant_id = 't'");
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(true);
    core.db.exec(
      "UPDATE identity_accounts SET registration_state = 'registered' WHERE tenant_id = 't'"
    );
    expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(false);
  });
  it('resumes bounded rule scans after a failure without skipping users', async () => {
    account('v');
    account('w');
    await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
    const visited: string[] = [];
    const evaluate = async (id: string) => {
      visited.push(id);
      if (id === 'v') throw new Error('retry');
    };
    await processServiceGroupShard(store, core.adapter, 'core-1', evaluate, 2);
    expect(visited).toEqual(['u', 'v']);
    await processServiceGroupShard(store, core.adapter, 'core-1', evaluate, 2);
    expect(visited).toEqual(['u', 'v', 'w']);
    expect(meta.db.prepare('SELECT status, failures FROM service_group_scans').get()).toEqual({
      status: 'failed',
      failures: 1,
    });
    await processServiceGroupShard(store, core.adapter, 'core-1', evaluate, 2);
    expect(visited.slice(-2)).toEqual(['u', 'v']);
  });
});
