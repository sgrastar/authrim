/** Real canonical SQL + signed runtime inventory. No owner-search or registry resolver seam. */
const piiLogRows = vi.hoisted(() => [] as Array<import('@authrim/ar-lib-core').PIIAuditLog>);
vi.mock('../../../ar-lib-core/dist/repositories/pii/audit-log', async (original) => ({
  ...(await original<typeof import('../../../ar-lib-core/dist/repositories/pii/audit-log')>()),
  writePiiAccessAuditRows: async (
    _env: unknown,
    _tenantId: string,
    rows: import('@authrim/ar-lib-core').PIIAuditLog[]
  ) => {
    piiLogRows.push(...structuredClone(rows));
  },
}));
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearTenantDatabaseResolverMemoryCache, generateUserId } from '@authrim/ar-lib-core';
const errors = vi.hoisted(() => [] as unknown[]);

// Contact SQL is real; the new audit writer is observed as its own transport port.
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  schedulePiiAccessLog: async (
    _env: unknown,
    execution: { waitUntil(promise: Promise<unknown>): void } | undefined,
    access: { write(env: unknown): Promise<unknown> }
  ) => {
    const result = access.write(_env);
    execution?.waitUntil(result);
    await result;
  },
}));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  logSanitizedError: (_label: string, error: unknown) => {
    errors.push(error);
  },
}));
import { contactFixture, registryKeys, TENANT } from './helpers/admin-contact-budget-fixture';

type Fixture = Awaited<ReturnType<typeof contactFixture>>;
let keys: Awaited<ReturnType<typeof registryKeys>>;
const fixtures: Fixture[] = [];
beforeAll(async () => {
  keys = await registryKeys();
});
afterEach(() => {
  fixtures.splice(0).forEach((fixture) => fixture.close());
});
async function fixture(options: Parameters<typeof contactFixture>[1] = {}) {
  errors.length = 0;
  piiLogRows.length = 0;
  clearTenantDatabaseResolverMemoryCache();
  const value = await contactFixture(keys, options);
  fixtures.push(value);
  return value;
}
async function sessions(response: Response) {
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('sessions' in body) || !Array.isArray(body.sessions))
    throw new Error('expected_session_response');
  return body.sessions as Array<{
    user_id: string;
    user_email: string | null;
    user_name: string | null;
  }>;
}
const n = (db: Fixture['metadata']['db'], table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('bounded admin session contacts with actual signed inventory', () => {
  it.for([100, 500])(
    '%i distinct users across 32 Core/PII stores stay below the Paid D1 contact-query budget with the audit transport observed separately',
    { timeout: 30_000 },
    async (users, context) => {
      const f = await fixture({ shards: 32, users });
      const response = await f.fetch(`/sessions?limit=${users}`);
      await context.annotate(
        JSON.stringify({
          d1Calls: f.counter.calls,
          statements: f.counter.statements,
          maxBinds: f.counter.maxBinds,
          maxBatch: f.counter.maxBatch,
          maxConcurrent: f.counter.maxConcurrent,
          registryReads: [...f.registryReads.values()],
          audited: piiLogRows.length,
          budgetExceeded: f.counter.budgetExceeded,
          cap: f.counter.cap,
        }),
        'd1-budget'
      );
      expect(f.counter.budgetExceeded, 'D1 API budget cap must not be reached').toBe(0);
      expect(
        response.status,
        errors.map((error) => (error instanceof Error ? error.message : String(error))).join(',')
      ).toBe(200);
      const rows = await sessions(response);
      expect(rows).toHaveLength(users);
      for (const row of rows) {
        expect(row.user_email).toBe(`${row.user_id}@example.test`);
        expect(row.user_name).toBe(`Name ${row.user_id}`);
      }
      expect(f.counter.calls).toBeLessThan(1000);
      expect(f.counter.maxBinds).toBeLessThanOrEqual(100);
      expect(f.counter.maxBatch).toBeLessThanOrEqual(50);
      expect(f.counter.maxConcurrent).toBeLessThanOrEqual(4);
      expect(f.counter.sessions.every((constraint) => constraint === 'first-primary')).toBe(true);
      expect([...f.registryReads.values()]).toEqual([1, 1]);
      expect(piiLogRows.length).toBe(users);
      expect(n(f.defaultPii.db, 'audit_log_pii')).toBe(0);
      expect(n(f.metadata.db, 'account_routing_outbox')).toBe(0);
      for (let index = 0; index < users; index++) {
        const store = f.pii[index % 32];
        const records = piiLogRows.filter(
          (row) => row.tenant_id === TENANT && row.target_user_id === `user-${index}`
        );
        expect(n(store.db, 'audit_log_pii')).toBe(0);
        expect(records).toHaveLength(1);
        expect(JSON.stringify(records)).not.toContain('@example.test');
      }
    }
  );

  it('a nonrouted default 20-user page stays below the Free D1 budget and does not read registry', async (context) => {
    const f = await fixture({ routed: false, users: 20 });
    f.counter.cap = 50;
    const response = await f.fetch('/sessions');
    expect(
      response.status,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join(',')
    ).toBe(200);
    expect(await sessions(response)).toHaveLength(20);
    await context.annotate(
      JSON.stringify({
        d1Calls: f.counter.calls,
        maxBinds: f.counter.maxBinds,
        maxBatch: f.counter.maxBatch,
        maxConcurrent: f.counter.maxConcurrent,
        audited: 20,
      }),
      'd1-budget'
    );
    expect(f.counter.calls).toBeLessThanOrEqual(50);
    expect(f.registryReads.size).toBe(0);
    expect(piiLogRows).toHaveLength(20);
    expect(n(f.defaultPii.db, 'audit_log_pii')).toBe(0);
  });

  it('keeps suspended and locked contact selection including profile-over-contact precedence', async () => {
    const f = await fixture({ scope: 'tenant_exclusive' });
    f.core[0].db
      .prepare(
        `INSERT INTO profile_attribute_values(
      id,tenant_id,profile_id,catalog_entry_id,value_type,value_storage_ref,created_at,updated_at
    ) SELECT 'profile-email-precedence',tenant_id,id,'field.canonical.email','string',
      'canonical-sensitive://tenant-a/user-0/email',1,1 FROM profiles`
      )
      .run();
    for (const [index, state] of ['suspended', 'locked'].entries()) {
      f.core[index].db
        .prepare('UPDATE identity_accounts SET lifecycle_state=? WHERE legacy_user_id=?')
        .run(state, `user-${index}`);
      f.core[index].db.prepare('UPDATE identity_subjects SET lifecycle_state=?').run(state);
    }
    f.core[0].db
      .prepare(
        "UPDATE contact_points SET value_storage_ref='canonical-sensitive://tenant-a/user-0/name' WHERE contact_type='email'"
      )
      .run();
    const response = await f.fetch();
    expect(
      response.status,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join(',')
    ).toBe(200);
    expect((await sessions(response)).map((row) => row.user_email).sort()).toEqual([
      'user-0@example.test',
      'user-1@example.test',
    ]);
    expect(f.counter.maxConcurrent).toBeLessThanOrEqual(4);
  });

  it('PII missing only removes that contact; another owner and its audit are retained', async () => {
    const f = await fixture();
    f.pii[0].db.exec('DELETE FROM identity_sensitive_values');
    const response = await f.fetch();
    expect(
      response.status,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join(',')
    ).toBe(200);
    const rows = await sessions(response);
    expect(rows.find((row) => row.user_id === 'user-0')).toMatchObject({
      user_email: null,
      user_name: null,
    });
    expect(rows.find((row) => row.user_id === 'user-1')).toMatchObject({
      user_email: 'user-1@example.test',
    });
    expect(n(f.pii[0].db, 'audit_log_pii')).toBe(0);
    expect(piiLogRows.filter((row) => row.target_user_id === 'user-1')).toHaveLength(1);
    expect(n(f.pii[1].db, 'audit_log_pii')).toBe(0);
    expect(n(f.defaultPii.db, 'audit_log_pii')).toBe(0);
  });

  it.each(['core', 'pii'] as const)(
    'a partial %s store failure returns no partial 200 and performs no audit write',
    async (role) => {
      const f = await fixture();
      f.counter.failures.add(f[role][1].key);
      const response = await f.fetch();
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain('@example.test');
      expect(piiLogRows.length).toBe(0);
    }
  );

  it('foreign-tenant rows and contacts never establish an owner', async () => {
    const f = await fixture({ users: 0 });
    await f.seed('user-0', 0, 'tenant-b');
    f.metadata.db
      .prepare('INSERT INTO users_core(id,tenant_id,created_at,updated_at) VALUES(?,?,1,1)')
      .run('user-0', TENANT);
    f.metadata.db
      .prepare(
        'INSERT INTO sessions(id,tenant_id,user_id,created_at,expires_at) VALUES(?,?,?,1,2000000000)'
      )
      .run('session-0', TENANT, 'user-0');
    const response = await f.fetch();
    expect(
      response.status,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join(',')
    ).toBe(200);
    expect(await sessions(response)).toEqual([
      expect.objectContaining({ user_email: null, user_name: null }),
    ]);
    expect(piiLogRows.length).toBe(0);
  });

  it('duplicate current owners fail closed even when each owner has a valid publication', async () => {
    const f = await fixture();
    await f.seed('user-0', 1);
    expect((await f.fetch()).status).toBe(500);
    expect(piiLogRows.length).toBe(0);
  });

  it.each(['generation', 'residency', 'owner', 'tenant'] as const)(
    'an invalid %s publication cannot disclose a contact',
    async (invalid) => {
      const f = await fixture();
      await f.seed('user-0', 0, TENANT, (publication) => {
        if (invalid === 'generation')
          publication.routeProjection.targets[0].requiredBindingRouteGeneration = 4;
        if (invalid === 'residency')
          publication.routeProjection.targets[1].residencyPartition = 'elsewhere';
        if (invalid === 'owner') publication.routeProjection.targets[0].bindingRef = f.core[1].key;
        if (invalid === 'tenant') publication.tenantId = 'tenant-b';
      });
      expect((await f.fetch()).status).toBe(500);
      expect(piiLogRows.length).toBe(0);
    }
  );

  it('an unsigned or expired inventory fails instead of scanning unassigned bindings', async () => {
    const f = await fixture();
    const snapshot = JSON.parse(f.documents.get(f.snapshotKey) ?? 'null') as { expiresAt: string };
    snapshot.expiresAt = '2020-01-01T00:00:00.000Z';
    f.documents.set(f.snapshotKey, JSON.stringify(snapshot));
    expect((await f.fetch()).status).toBe(500);
    expect(f.counter.statements).toBeLessThan(10);
    expect(n(f.defaultPii.db, 'audit_log_pii')).toBe(0);
  });

  it.each(['deleting', 'deleted'] as const)(
    '%s accounts are not contact owners and default decoys cannot supply them',
    async (state) => {
      const f = await fixture({ users: 1 });
      f.core[0].db.prepare('UPDATE identity_accounts SET lifecycle_state=?').run(state);
      const response = await f.fetch();
      expect(
        response.status,
        errors.map((error) => (error instanceof Error ? error.message : String(error))).join(',')
      ).toBe(200);
      expect(await sessions(response)).toEqual([
        expect.objectContaining({ user_email: null, user_name: null }),
      ]);
      expect(n(f.defaultPii.db, 'audit_log_pii')).toBe(0);
    }
  );

  it('an account present only in an unassigned bound store remains unknown without metadata/default fallback', async () => {
    const f = await fixture({ users: 1 });
    f.inventory.splice(0, 1);
    await f.publish();
    const response = await f.fetch();
    expect(response.status).toBe(200);
    expect(await sessions(response)).toEqual([
      expect.objectContaining({ user_email: null, user_name: null }),
    ]);
    expect(piiLogRows.length).toBe(0);
  });

  it('a legacy ID mismatch cannot disclose a different account matching its synthetic account ID', async () => {
    const f = await fixture({ users: 1 });
    f.core[0].db.prepare("UPDATE identity_accounts SET legacy_user_id='someone-else'").run();
    const response = await f.fetch();
    expect(response.status).toBe(200);
    expect(await sessions(response)).toEqual([
      expect.objectContaining({ user_email: null, user_name: null }),
    ]);
    expect(n(f.pii[0].db, 'audit_log_pii')).toBe(0);
  });

  it.each(['uuid', 'nanoid'] as const)(
    'keeps automatically generated %s account IDs routable',
    async (format) => {
      const f = await fixture({ users: 0 });
      const id = generateUserId(format);
      await f.seed(id, 0);
      f.metadata.db
        .prepare('INSERT INTO users_core(id,tenant_id,created_at,updated_at) VALUES(?,?,1,1)')
        .run(id, TENANT);
      f.metadata.db
        .prepare(
          'INSERT INTO sessions(id,tenant_id,user_id,created_at,expires_at) VALUES(?,?,?,1,2000000000)'
        )
        .run('generated-id-session', TENANT, id);
      const response = await f.fetch();
      expect(response.status).toBe(200);
      expect(await sessions(response)).toEqual([
        expect.objectContaining({
          user_id: id,
          user_email: `${id}@example.test`,
          user_name: `Name ${id}`,
        }),
      ]);
      expect(piiLogRows).toHaveLength(1);
      expect(n(f.pii[0].db, 'audit_log_pii')).toBe(0);
    }
  );

  it.each(['0', '-1', '501', '1.5', '10junk', '', 'Infinity', '9007199254740992'])(
    'rejects invalid limit %j before touching D1',
    async (limit) => {
      const f = await fixture({ users: 0 });
      const response = await f.fetch(`/sessions?limit=${encodeURIComponent(limit)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
      expect(f.counter.calls).toBe(0);
      expect(f.registryReads.size).toBe(0);
    }
  );

  it.each(['0', '-1', '1.5', '2junk', '', 'Infinity', '9007199254740992'])(
    'rejects invalid page %j before touching D1',
    async (page) => {
      const f = await fixture({ users: 0 });
      expect((await f.fetch(`/sessions?page=${encodeURIComponent(page)}`)).status).toBe(400);
      expect(f.counter.calls).toBe(0);
    }
  );
});
