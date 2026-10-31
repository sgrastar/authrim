import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  arrayBufferToBase64Url,
  recordIdentityMappingFailure,
  type AdminAuthContext,
  type Env,
  type IdentityMappingFailureRow,
} from '@authrim/ar-lib-core';
import { adminIdentityMappingFailuresHandler } from '../identity-mapping-failures';
import { setupApp, signIn, TENANT, TENANT_SUPER_ADMIN } from './helpers/admin-authority-fixture';
import { d1OverSqlite } from './helpers/d1-over-sqlite';

const PATH = '/api/admin/identity-mapping/failures';
interface Page {
  entries: IdentityMappingFailureRow[];
  next_cursor: string | null;
}
function setup() {
  const fixture = setupApp((app) => {
    app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
    app.get(PATH, adminIdentityMappingFailuresHandler);
  });
  const { cookie } = signIn(fixture.db, TENANT_SUPER_ADMIN);
  const binding = d1OverSqlite(fixture.db);
  return {
    ...fixture,
    binding,
    get: (query = '') =>
      fixture.app.request(
        `${PATH}${query}`,
        {
          headers: { Cookie: cookie, 'X-Tenant-Id': TENANT },
        },
        { DB_ADMIN: binding }
      ),
    seed: (clientId: string, now: number, tenantId = TENANT, code = 'set_missing') =>
      recordIdentityMappingFailure(fixture.adapter, { tenantId, clientId, code, now }),
  };
}

function direct(auth: AdminAuthContext | undefined, env: Partial<Env> = {}, tenantId = TENANT) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, tenantId as never);
    if (auth) c.set('adminAuth' as never, auth as never);
    await next();
  });
  app.get(PATH, adminIdentityMappingFailuresHandler);
  return (query = '') => app.request(`${PATH}${query}`, {}, env);
}
function machine(
  permissions: string[] = [ADMIN_PERMISSIONS.SETTINGS_READ],
  tenantScope = [TENANT]
): AdminAuthContext {
  return {
    userId: 'machine-1',
    tenantId: TENANT,
    roles: [],
    permissions,
    actorType: 'machine',
    authMethod: 'machine_access_token',
    tenantScope,
    hierarchyLevel: 0,
    mfaVerified: false,
  };
}

describe('mapping failure list with the real Admin schema', () => {
  it('lists only this tenant, including a deleted client, and returns fixed safe columns', async () => {
    const f = setup();
    await f.seed('deleted-client', 100);
    await f.seed('foreign-client', 200, 'tenant-other');
    const response = await f.get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body: Page = await response.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual({
      id: body.entries[0].id,
      tenant_id: TENANT,
      client_id: 'deleted-client',
      code: 'set_missing',
      tier: null,
      set_id: null,
      first_at: 100,
      last_at: 100,
      count: 1,
    });
    expect(body.next_cursor).toBeNull();
    const missing: Page = await (await f.get('?client_id=foreign-client')).json();
    expect(missing.entries).toEqual([]);
  });

  it('filters by last occurrence inclusively without pretending cumulative counts are period counts', async () => {
    const f = setup();
    await f.seed('a', 10);
    await f.seed('a', 100);
    await f.seed('b', 99);
    const body: Page = await (await f.get('?since=100')).json();
    expect(
      body.entries.map(({ client_id, first_at, last_at, count }) => ({
        client_id,
        first_at,
        last_at,
        count,
      }))
    ).toEqual([{ client_id: 'a', first_at: 10, last_at: 100, count: 2 }]);
  });

  it('paginates equal timestamps deterministically and binds the cursor to tenant and filters', async () => {
    const f = setup();
    for (const client of ['a', 'b', 'c']) await f.seed(client, 100);
    const all: Page = await (await f.get()).json();
    let query = '?limit=1';
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page: Page = await (await f.get(query)).json();
      ids.push(...page.entries.map((row) => row.id));
      if (i === 0) {
        expect((await f.get(`?limit=1&since=0&cursor=${page.next_cursor}`)).status).toBe(400);
        expect((await f.get(`?limit=1&client_id=a&cursor=${page.next_cursor}`)).status).toBe(400);
        const other = direct(
          { ...machine(), tenantId: 'tenant-other', tenantScope: ['tenant-other'] },
          { DB_ADMIN: f.binding },
          'tenant-other'
        );
        expect((await other(`?cursor=${page.next_cursor}`)).status).toBe(400);
      }
      query = `?limit=1&cursor=${page.next_cursor}`;
      if (i === 2) expect(page.next_cursor).toBeNull();
    }
    expect(ids).toEqual(all.entries.map((row) => row.id));
    expect(new Set(ids).size).toBe(3);
  });

  it('round-trips a maximum length Unicode client filter in a bounded cursor', async () => {
    const f = setup();
    const client = '界'.repeat(256);
    await f.seed(client, 100);
    await f.seed(client, 200, TENANT, 'set_inactive');
    const query = `?limit=1&client_id=${encodeURIComponent(client)}`;
    const first: Page = await (await f.get(query)).json();
    expect(first.next_cursor?.length).toBeLessThan(2048);
    const second: Page = await (await f.get(`${query}&cursor=${first.next_cursor}`)).json();
    expect(second.entries[0].client_id).toBe(client);
    expect(second.entries[0].last_at).toBe(100);
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=1.5',
    '?since=-1',
    '?since=',
    '?since=9007199254740992',
    '?since=1e3',
    '?client_id=',
    '?client_id=%20x',
    '?limit=1&limit=2',
    '?cursor=bad',
    '?cursor=',
  ])('rejects malformed %s before querying storage', async (query) => {
    const f = setup();
    const spy = vi.spyOn(f.binding, 'prepare');
    const get = direct(machine(), { DB_ADMIN: f.binding });
    expect((await get(query)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a forged cursor with unexpected fields', async () => {
    const get = direct(machine());
    const value = arrayBufferToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          v: 1,
          last_at: 1,
          id: 'a'.repeat(64),
          filter: 'b'.repeat(64),
          user_id: 'private-value',
        })
      )
    );
    expect((await get(`?cursor=${value}`)).status).toBe(400);
  });

  it('checks authentication, settings read and tenant scope for people, machines and agents', async () => {
    expect((await direct(undefined)()).status).toBe(401);
    expect((await direct(machine([ADMIN_PERMISSIONS.CLIENTS_READ]))()).status).toBe(403);
    expect((await direct(machine(undefined, ['another']))()).status).toBe(403);
    const f = setup();
    expect((await direct(machine(), { DB_ADMIN: f.binding })()).status).toBe(200);
    expect(
      (await direct({ ...machine(), actorType: 'agent' }, { DB_ADMIN: f.binding })()).status
    ).toBe(200);
    expect((await f.call('', 'GET', PATH)).status).toBe(401);
  });

  it('fails safely on absent or wrong Admin schema and never falls back to Core or writes', async () => {
    const f = setup();
    await f.seed('a', 1);
    const query = vi.spyOn(f.binding, 'prepare');
    const missing = await direct(machine(), { DB: f.binding })();
    expect(missing.status).toBe(503);
    expect(query).not.toHaveBeenCalled();
    const get = direct(machine(), { DB_ADMIN: f.binding });
    expect((await get()).status).toBe(200);
    expect(query.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT '))).toBe(true);
    f.db.exec('DROP TABLE identity_mapping_failures');
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('identity_mapping_failures');
  });
});
