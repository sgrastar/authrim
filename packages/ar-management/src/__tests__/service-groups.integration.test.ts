import {
  listMigrationSourceFiles,
  readRenderedMigrationSql,
} from '../../../../test/helpers/migration-source.mjs';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { CanonicalRuntimeUserWriter, CanonicalIdentityRepository } from '@authrim/ar-lib-core';
import { Hono } from 'hono';
import * as groupRuntime from '../dynamic-groups-runtime';
import * as rbacStores from '../rbac-account-stores';
import {
  serviceGroupsRead,
  serviceGroupWrite,
  serviceGroupValidate,
  serviceGroupSubject,
  serviceGroupMembers,
  serviceGroupManual,
} from '../service-groups';

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
import {
  processServiceGroupShard,
  refreshExpiringDynamicMemberships,
} from '../dynamic-groups-runtime';
import {
  reevaluateDynamicMembershipsAfterErasure,
  stopDynamicMembershipsForErasure,
} from '../account-pii-only-erasure';
import { evaluateAndPublishDynamicMemberships } from '../../../ar-lib-core/dist/services/dynamic-groups/publication';
import { resolveSubjectGroups } from '../../../ar-lib-core/dist/services/group-membership';
let databases: SQLiteDatabase[];
function database(family: 'core' | 'pii') {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const directory = new URL(`../../../../migrations/${family}/d1/`, import.meta.url);
  // The core schema as deployed: the 0.5.0 baseline and the migrations after it (canonical
  // groups, SCIM membership input triggers).
  // The listing has the consolidated history first; the later migrations start where its
  // numbering drops (as sqliteAdapter in ar-lib-core reads them).
  const listed = listMigrationSourceFiles(directory);
  const number = (name: string) => Number(name.split('_')[0]);
  const start = listed.findIndex((name, i) => i > 0 && number(name) < number(listed[i - 1]));
  const later = start < 0 ? [] : listed.slice(start).filter((name) => number(name) > 2);
  const files =
    family === 'core' ? ['001_0_5_0_core_baseline.sql', ...later] : ['001_0_5_0_pii_baseline.sql'];
  for (const file of files)
    db.exec(renderPortableMigrationSql(readRenderedMigrationSql(directory, `${file}`), 'sqlite'));
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
let logs: Awaited<ReturnType<typeof logProducerFixture>>;
describe.each(['scheduled', 'pipeline'] as const)('service group log storage (%s)', (mode) => {
  beforeEach(async () => {
    databases = [];
    meta = database('core');
    core = database('core');
    pii = database('pii');
    logs = await logProducerFixture(mode, {
      separateAdmin: true,
      corePublicationAdapter: meta.adapter,
      tenantId: 't',
    });
    store = new DynamicGroupStore(meta.adapter, 't', {
      env: logs.env,
      source: logs.publicationSource,
    });
    reader = new SavedGroupInputReader(
      meta.adapter,
      core.adapter,
      pii.adapter,
      't',
      'u',
      undefined,
      logs.env
    );
    account();
    country('JP');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    logs.close();
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
      const canonical = () =>
        meta.db.prepare('SELECT kind, lifecycle_state FROM "groups" WHERE id = ?').get(id);
      expect(canonical()).toEqual({ kind: 'dynamic', lifecycle_state: 'active' });
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
      expect(
        (await request('/validate', 'POST', { ...group(), userId: 'u' }, 'other')).status
      ).toBe(400);
      // A parent of another group is not deleted.
      meta.db
        .prepare(
          `INSERT INTO "groups"(id, tenant_id, group_key, display_name, parent_group_id, created_at, updated_at) VALUES ('child', 't', 'child', 'Child', ?, 1, 1)`
        )
        .run(id);
      expect((await request('/' + id, 'DELETE', { ifMatch: 1 })).status).toBe(409);
      meta.db.exec(`DELETE FROM "groups" WHERE id = 'child'`);
      expect((await request('/' + id, 'DELETE', { ifMatch: 1 })).status).toBe(200);
      expect((await store.catalog())?.plan.groups).toEqual([]);
      // No account routing in this app: the canonical row is left inactive for the reconcile.
      expect(canonical()).toEqual({ kind: 'dynamic', lifecycle_state: 'inactive' });
    });
    it('publishes a subject evaluation into its dynamic group memberships', async () => {
      vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockImplementation(async (_env, tenant, id) => {
        if (tenant !== 't' || (id && id !== 'u')) throw new Error('group_subject_invalid');
        return { store, reader: id ? reader : null };
      });
      const app = new Hono<{
        Bindings: import('@authrim/ar-lib-core').Env;
        Variables: { adminAuth: { userId?: string } };
      }>();
      app.post('/api/admin/service-groups/subjects/:userId', serviceGroupSubject);
      const evaluate = async () => {
        const response = await app.request('/api/admin/service-groups/subjects/u', {
          method: 'POST',
          headers: { 'X-Tenant-Id': 't' },
        });
        expect(response.status).toBe(200);
        return response.json<{ generation: number; publication: { status: string } }>();
      };
      const dynamicRows = () =>
        core.db
          .prepare(
            "SELECT group_id, source_ref FROM group_memberships WHERE subject_id = 'u' AND assignment_source = 'dynamic' AND lifecycle_state = 'active'"
          )
          .all();
      await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
      const first = await evaluate();
      expect(first.publication.status).toBe('published');
      expect(dynamicRows()).toEqual([
        { group_id: 'japan', source_ref: `${String(first.generation).padStart(16, '0')}:1` },
      ]);
      // The publication does not make the result stale (no self-triggered re-evaluation).
      expect((await store.snapshot('u', reader)).freshness).toBe('fresh');
      country('US');
      expect((await evaluate()).publication.status).toBe('published');
      expect(dynamicRows()).toEqual([]);
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
        (await logs.rows('core.service_group_audit')).map((r) => JSON.stringify(r)).join('')
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
      const obsolete = new SavedGroupInputReader(
        meta.adapter,
        core.adapter,
        pii.adapter,
        't',
        'u',
        {
          stamp: 'old',
          verify: async () => {
            throw new Error('group_input_route_changed');
          },
        }
      );
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
      // The SCIM link: a SCIM-kind canonical group (metadata) and the subject's SCIM row on
      // its account database.
      meta.db.exec(
        "INSERT INTO \"groups\"(id, tenant_id, group_key, display_name, kind, created_at, updated_at) VALUES ('scim', 't', 'scim:scim', 'Scim', 'scim', 1, 1)"
      );
      core.db.exec(
        "INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source, source_ref, created_at, updated_at) VALUES ('m', 't', 'scim', 'u', 'scim', 'scim', 1, 1)"
      );
      await store.save([{ ...group(), scimRoleId: 'scim' }], BUILTIN_GROUP_FIELDS, 0, 'admin');
      await store.setManual('u', 'japan', true, 'admin');
      country('US');
      expect((await store.evaluate('u', reader)).evaluation?.groups.japan.sources).toEqual([
        'manual',
        'scim',
      ]);
      core.db.exec("DELETE FROM group_memberships WHERE tenant_id = 't' AND id = 'm'");
      expect((await store.snapshot('u', reader)).freshness).toBe('stale');
      expect((await store.evaluate('u', reader)).evaluation?.groups.japan.sources).toEqual([
        'manual',
      ]);
      await store.setManual('u', 'japan', false, 'admin');
      expect((await store.evaluate('u', reader)).evaluation?.groups.japan.member).toBe(false);
    });
    it('does not turn deleted SCIM links into membership through negation', async () => {
      meta.db.exec(
        "INSERT INTO \"groups\"(id, tenant_id, group_key, display_name, kind, created_at, updated_at) VALUES ('scim', 't', 'scim:scim', 'Scim', 'scim', 1, 1)"
      );
      await store.save(
        [
          { ...group(), condition: null, scimRoleId: 'scim' },
          {
            ...group('inverse'),
            condition: { op: 'not', arg: { op: 'member', groupId: 'japan' } },
          },
        ],
        BUILTIN_GROUP_FIELDS,
        0,
        'admin'
      );
      meta.db.exec(`DELETE FROM "groups" WHERE id = 'scim'`);
      expect((await store.evaluate('u', reader)).evaluation?.groups.inverse.member).toBe('unknown');
    });
    it('prevents cross-tenant reads even with the same legacy user ID', async () => {
      const other = new SavedGroupInputReader(
        meta.adapter,
        core.adapter,
        pii.adapter,
        'other',
        'u'
      );
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
        (await logs.rows('core.service_group_audit')).filter(
          (row) => row.event_type === 'input_recovery'
        )
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
      core.db.exec(
        "UPDATE identity_accounts SET registration_state = 'guest' WHERE tenant_id = 't'"
      );
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
    it('PII-only erasure stops dynamic memberships and re-evaluates on the erased inputs', async () => {
      const other = database('core'); // another account shard, with another subject
      other.db.exec(
        "INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source, source_ref, stale_after, created_at, updated_at) VALUES ('o', 't', 'japan', 'v', 'dynamic', 'x', 9999999999, 1, 1)"
      );
      vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockImplementation(async (_env, tenant, id) => {
        if (tenant !== 't' || id !== 'u') throw new Error('group_subject_invalid');
        return { store, reader };
      });
      await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
      await evaluateAndPublishDynamicMemberships(store, reader);
      const effective = async () => [
        ...(
          await resolveSubjectGroups(
            { metadata: meta.adapter, account: core.adapter },
            't',
            'u',
            Math.floor(Date.now() / 1000)
          )
        ).directGroupIds,
      ];
      expect(await effective()).toEqual(['japan']);
      // As the handler runs it: one group input write around the whole erasure.
      await withGroupInputWrite(core.adapter, 't', 'u', 'pii_only_erasure', async () => {
        await stopDynamicMembershipsForErasure(core.adapter, { tenantId: 't', userId: 'u' });
        expect(await effective()).toEqual([]);
        // An evaluation racing the erasure finds the inputs unsettled: nothing is published.
        await expect(evaluateAndPublishDynamicMemberships(store, reader)).rejects.toThrow(
          'group_input_write_unsettled'
        );
        expect(await effective()).toEqual([]);
        // The erasure's own statement for the account's values (eraseRetainedAccountPii's
        // first; this PII schema is the baseline only, without the later tables it clears).
        pii.db.exec(
          "UPDATE identity_sensitive_values SET value_json = NULL, lifecycle_state = 'deleted' WHERE tenant_id = 't' AND owner_id = 'u'"
        );
        await stopDynamicMembershipsForErasure(core.adapter, { tenantId: 't', userId: 'u' });
      });
      await reevaluateDynamicMembershipsAfterErasure({} as never, { tenantId: 't', userId: 'u' });
      // The country was erased: the rule no longer matches, nothing is published again.
      expect((await store.snapshot('u', reader)).evaluation?.groups.japan.dynamic).not.toBe(true);
      expect(await effective()).toEqual([]);
      expect(
        core.db
          .prepare(
            "SELECT COUNT(*) AS n FROM group_memberships WHERE assignment_source = 'dynamic' AND lifecycle_state = 'active'"
          )
          .get()
      ).toEqual({ n: 0 });
      // The other shard's subject is untouched.
      expect(other.db.prepare('SELECT stale_after FROM group_memberships').get()).toEqual({
        stale_after: 9999999999,
      });
    });

    describe('delegation and self-writable fields over HTTP', () => {
      let auth: Record<string, unknown>;
      const allowed = {
        userId: 'operator',
        permissions: ['admin:roles:write'],
        hierarchyLevel: 100,
      };
      const denied = { userId: 'operator', permissions: [] };
      const app = () => {
        vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockImplementation(
          async (_env, tenant, id) => {
            if (tenant !== 't' || (id && id !== 'u')) throw new Error('group_subject_invalid');
            return { store, reader: id ? reader : null };
          }
        );
        const hono = new Hono<{
          Bindings: import('@authrim/ar-lib-core').Env;
          Variables: { adminAuth: { userId?: string } };
        }>();
        hono.use('*', async (c, next) => {
          c.set('adminAuth', auth);
          await next();
        });
        hono.put('/api/admin/service-groups/:id', serviceGroupWrite);
        hono.delete('/api/admin/service-groups/:id', serviceGroupWrite);
        hono.post('/api/admin/service-groups/:id/manual/:userId', serviceGroupManual);
        return (path: string, method: string, body: unknown) =>
          hono.request(path, {
            method,
            headers: { 'X-Tenant-Id': 't', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      };
      const grant = (groupId: string) =>
        meta.db.exec(`INSERT INTO roles(id, tenant_id, name, permissions_json, created_at)
          VALUES ('reader', 't', 'Reader', '[]', 1) ON CONFLICT DO NOTHING;
          INSERT INTO group_role_assignments(id, tenant_id, group_id, role_id, created_at, updated_at)
          VALUES ('gr-${groupId}', 't', '${groupId}', 'reader', 1, 1)`);

      it('refuses rule and manual changes reaching a role-carrying group without delegation', async () => {
        const request = app();
        const referencing = {
          ...group('ref'),
          condition: { op: 'member' as const, groupId: 'japan' },
        };
        await store.save([group(), referencing], BUILTIN_GROUP_FIELDS, 0, 'admin');
        grant('ref'); // the role is on the group that references `japan`
        auth = denied;
        const changed = { ...group(), condition: null, ifMatch: 1 };
        expect((await request('/api/admin/service-groups/japan', 'PUT', changed)).status).toBe(403);
        // A rename alone reaches no membership.
        expect(
          (
            await request('/api/admin/service-groups/japan', 'PUT', {
              ...group(),
              displayName: 'Japan',
              ifMatch: 1,
            })
          ).status
        ).toBe(200);
        expect(
          (await request('/api/admin/service-groups/japan/manual/u', 'POST', { present: true }))
            .status
        ).toBe(403);
        auth = allowed;
        expect(
          (await request('/api/admin/service-groups/japan', 'PUT', { ...changed, ifMatch: 2 }))
            .status
        ).toBe(200);
        expect(
          (await request('/api/admin/service-groups/japan/manual/u', 'POST', { present: true }))
            .status
        ).toBe(200);
        // Not on one's own role-carrying memberships.
        auth = { ...allowed, userId: 'u' };
        expect(
          (await request('/api/admin/service-groups/japan/manual/u', 'POST', { present: false }))
            .status
        ).toBe(403);
      });

      it('refuses a self-writable field deciding a role-carrying group (400)', async () => {
        const request = app();
        auth = allowed;
        meta.db.exec(`INSERT INTO custom_claim_schemas(id, tenant_id, field_key, display_label,
          field_type, is_active, operation_status, schema_version, show_on_registration,
          created_at, updated_at) VALUES ('t:team', 't', 'team', 'Team', 'string', 1, 'active', 1,
          1, 1, 1)`);
        const team = (value: string) => ({
          ...group(),
          condition: { op: 'attribute', field: 'custom.team', compare: 'eq', value },
        });
        await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
        // No role on it: allowed.
        expect(
          (await request('/api/admin/service-groups/japan', 'PUT', { ...team('x'), ifMatch: 1 }))
            .status
        ).toBe(200);
        grant('japan');
        const refused = await request('/api/admin/service-groups/japan', 'PUT', {
          ...team('y'),
          ifMatch: 2,
        });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error: 'group_self_writable_attribute' });
      });

      it('expires the memberships of a changed rule at once, on every shard', async () => {
        const request = app();
        auth = allowed;
        const other = database('core');
        vi.spyOn(rbacStores, 'tenantRBACStores').mockResolvedValue({
          metadata: meta.adapter,
          accounts: [core.adapter, other.adapter],
          routed: true,
        });
        await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
        for (const [db, subject] of [
          [core, 'u'],
          [other, 'v'],
        ] as const)
          db.db
            .prepare(
              `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
                source_ref, stale_after, created_at, updated_at)
               VALUES (?, 't', 'japan', ?, 'dynamic', 'r', 9999999999, 1, 1)`
            )
            .run(`m-${subject}`, subject);
        const staleAfter = () =>
          [core, other].map(
            (db) =>
              (
                db.db.prepare('SELECT stale_after FROM group_memberships').get() as {
                  stale_after: number;
                }
              ).stale_after
          );
        // A rename keeps them.
        expect(
          (
            await request('/api/admin/service-groups/japan', 'PUT', {
              ...group(),
              displayName: 'Japan',
              ifMatch: 1,
            })
          ).status
        ).toBe(200);
        expect(staleAfter()).toEqual([9999999999, 9999999999]);
        // A changed condition stops them now.
        expect(
          (
            await request('/api/admin/service-groups/japan', 'PUT', {
              ...group(),
              condition: null,
              ifMatch: 2,
            })
          ).status
        ).toBe(200);
        const now = Math.floor(Date.now() / 1000);
        for (const value of staleAfter()) expect(value).toBeLessThanOrEqual(now);
        // The pending invalidation of each subject, recorded with the expiry on its shard.
        for (const [db, subject] of [
          [core, 'u'],
          [other, 'v'],
        ] as const)
          expect(
            db.db
              .prepare(
                'SELECT invalidation_pending FROM dynamic_membership_publications WHERE subject_id = ?'
              )
              .get(subject)
          ).toEqual({ invalidation_pending: 1 }); // no claims cache bound here: stays pending
      });

      it('expires on the shards it reaches when another fails, and says expiry_pending', async () => {
        const request = app();
        auth = allowed;
        const other = database('core');
        const broken = {
          ...other.adapter,
          query: async () => {
            throw new Error('shard down');
          },
        } as DatabaseAdapter;
        vi.spyOn(rbacStores, 'tenantRBACStores').mockResolvedValue({
          metadata: meta.adapter,
          accounts: [broken, core.adapter],
          routed: true,
        });
        await store.save([group()], BUILTIN_GROUP_FIELDS, 0, 'admin');
        core.db.exec(`INSERT INTO group_memberships(id, tenant_id, group_id, subject_id,
          assignment_source, source_ref, stale_after, created_at, updated_at)
          VALUES ('m-u', 't', 'japan', 'u', 'dynamic', 'r', 9999999999, 1, 1)`);
        const response = await request('/api/admin/service-groups/japan', 'PUT', {
          ...group(),
          condition: null,
          ifMatch: 1,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ publication: { status: 'expiry_pending' } });
        expect(
          (
            core.db.prepare('SELECT stale_after FROM group_memberships').get() as {
              stale_after: number;
            }
          ).stale_after
        ).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      });

      it('answers expiry_pending when the expiry after a failed evaluation cannot be written', async () => {
        const unreachable = Object.create(reader) as typeof reader;
        Object.defineProperty(unreachable, 'core', {
          value: {
            ...core.adapter,
            execute: async () => {
              throw new Error('shard down');
            },
            batch: async () => {
              throw new Error('shard down');
            },
          },
        });
        vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockResolvedValue({
          store,
          reader: unreachable,
        });
        vi.spyOn(store, 'evaluate').mockRejectedValue(new Error('group_input_unavailable'));
        const hono = new Hono<{ Bindings: import('@authrim/ar-lib-core').Env }>();
        hono.post('/api/admin/service-groups/subjects/:userId', serviceGroupSubject);
        const response = await hono.request('/api/admin/service-groups/subjects/u', {
          method: 'POST',
          headers: { 'X-Tenant-Id': 't' },
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: 'group_input_unavailable',
          publication: { status: 'expiry_pending' },
        });
      });

      it('answers expiry_pending when the subject account cannot be reached', async () => {
        vi.spyOn(groupRuntime, 'serviceGroupRuntime').mockImplementation(async (_env, _t, id) => {
          if (id) throw new Error('account_data_route_not_found');
          return { store, reader: null };
        });
        const hono = new Hono<{ Bindings: import('@authrim/ar-lib-core').Env }>();
        hono.post('/api/admin/service-groups/subjects/:userId', serviceGroupSubject);
        const response = await hono.request('/api/admin/service-groups/subjects/u', {
          method: 'POST',
          headers: { 'X-Tenant-Id': 't' },
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: 'group_input_unavailable',
          publication: { status: 'expiry_pending' },
        });
      });
    });

    it('refreshes the subjects whose rows expire soonest first, within a budget', async () => {
      const now = Math.floor(Date.now() / 1000);
      for (const [subject, staleAfter, lifecycle] of [
        ['late', now + 900, 'active'],
        ['soon', now + 10, 'active'],
        ['middle', now + 500, 'active'],
        ['expired', now - 1, 'active'], // left to the full scan
        ['beyond', now + 5000, 'active'], // outside the renewal window
        ['revoked', now + 5, 'revoked'],
      ] as const)
        core.db
          .prepare(
            `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
              source_ref, lifecycle_state, stale_after, created_at, updated_at)
             VALUES (?, 't', 'g', ?, 'dynamic', 'r', ?, ?, 1, 1)`
          )
          .run(`m-${subject}`, subject, lifecycle, staleAfter);
      const visited: string[] = [];
      const result = await refreshExpiringDynamicMemberships(
        store,
        core.adapter,
        async (subject) => {
          visited.push(subject);
          if (subject === 'middle') throw new Error('group_input_unavailable');
        },
        { renewBeforeSeconds: 1000 }
      );
      expect(visited).toEqual(['soon', 'middle', 'late']);
      expect(result.failures).toBe(1);
      visited.length = 0;
      await refreshExpiringDynamicMemberships(
        store,
        core.adapter,
        async (s) => void visited.push(s),
        {
          renewBeforeSeconds: 1000,
          budget: 2,
        }
      );
      expect(visited).toEqual(['soon', 'middle']);
    });
  });
});
