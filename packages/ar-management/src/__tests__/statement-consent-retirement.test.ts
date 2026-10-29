import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateVersion, computeContentHash, type DatabaseAdapter } from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';

const state = vi.hoisted(() => ({
  metadata: null as DatabaseAdapter | null,
  accounts: [] as DatabaseAdapter[],
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
  createAuthContextFromHono: () => ({ coreAdapter: state.metadata }),
  getLogger: () => ({ module: () => ({ info: vi.fn(), error: vi.fn() }) }),
}));
vi.mock('../rbac-account-stores', () => ({
  tenantRBACStores: async () => ({ accounts: state.accounts }),
}));
import {
  adminConsentStatementUpdateHandler,
  adminConsentStatementDeleteHandler,
  adminConsentLocalizationUpsertHandler,
  adminConsentLocalizationDeleteHandler,
  adminConsentVersionDeleteHandler,
} from '../admin-consent-statements';

const stores: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});
function setup(status = 'active') {
  const store = openCoreStore();
  stores.push(store);
  state.metadata = store.adapter;
  state.accounts = [store.adapter];
  store.db
    .exec(`INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at) VALUES('terms','tenant-a','terms',1,1);
    INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,created_at,updated_at)
      VALUES('v1','tenant-a','terms','20261029',1,'${status}',1,1);
    INSERT INTO consent_statement_localizations(id,tenant_id,version_id,language,title,description,created_at,updated_at)
      VALUES('l1','tenant-a','v1','en','Original','Evidence',1,1);
    INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,created_at,updated_at)
      VALUES('r1','tenant-a','u1','terms','v1','20261029','granted',1,1);
    INSERT INTO consent_item_history(id,tenant_id,user_id,statement_id,action,created_at) VALUES('h1','tenant-a','u1','terms','granted',1);`);
  return store;
}
function context(body: unknown = { title: 'Changed', description: 'Changed' }) {
  const params: Record<string, string> = { id: 'terms', sid: 'terms', vid: 'v1', lang: 'en' };
  return {
    req: { param: (name: string) => params[name], json: async () => body },
    env: {},
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as never;
}
describe('statement retirement and immutable evidence (real SQLite)', () => {
  it('retires without deleting any evidence, and atomically enqueues closed projection', async () => {
    const f = setup();
    const response = await adminConsentStatementDeleteHandler(context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, disposition: 'retired' });
    const retired = await f.adapter.queryOne<{ retired_at: number }>(
      'SELECT is_active,retired_at,definition_generation,closed_generation FROM consent_statements'
    );
    expect(retired).toMatchObject({ is_active: 0, definition_generation: 1, closed_generation: 1 });
    expect(typeof retired?.retired_at).toBe('number');
    for (const table of [
      'user_consent_records',
      'consent_item_history',
      'consent_statement_versions',
      'consent_statement_localizations',
    ])
      expect(await f.adapter.query(`SELECT * FROM ${table}`)).toHaveLength(1);
    expect(await f.adapter.queryOne('SELECT mode FROM statement_consent_projection_jobs')).toEqual({
      mode: 'closed',
    });
  });
  it.each(['active', 'archived'])(
    'rejects localization PUT/DELETE and version DELETE for %s',
    async (status) => {
      const f = setup(status);
      expect((await adminConsentLocalizationUpsertHandler(context())).status).toBe(409);
      expect((await adminConsentLocalizationDeleteHandler(context())).status).toBe(409);
      expect((await adminConsentVersionDeleteHandler(context())).status).toBe(400);
      expect(await f.adapter.queryOne('SELECT title FROM consent_statement_localizations')).toEqual(
        { title: 'Original' }
      );
    }
  );

  it('only physically removes untouched inactive drafts after checking every shard', async () => {
    const f = setup('draft');
    f.db.exec(
      'DELETE FROM user_consent_records; DELETE FROM consent_item_history; UPDATE consent_statements SET is_active=0'
    );
    const shard = openCoreStore();
    stores.push(shard);
    state.accounts = [f.adapter, shard.adapter];
    const count = vi.spyOn(shard.adapter, 'query');
    const response = await adminConsentStatementDeleteHandler(context());
    expect(await response.json()).toEqual({ success: true, disposition: 'deleted' });
    expect(count).toHaveBeenCalled();
    expect(await f.adapter.query('SELECT * FROM consent_statements')).toEqual([]);
    expect(await f.adapter.query('SELECT * FROM consent_statement_localizations')).toEqual([]);
  });
  it('does not delete draft bodies when publication wins before the deletion batch', async () => {
    const f = setup('draft');
    f.db.exec(
      'DELETE FROM user_consent_records; DELETE FROM consent_item_history; UPDATE consent_statements SET is_active=0'
    );
    const batch = f.adapter.batch.bind(f.adapter);
    let race = true;
    f.adapter.batch = async (...args: Parameters<typeof batch>) => {
      if (race) {
        race = false;
        expect(args[0][0].sql).toContain('UPDATE consent_statements SET updated_at=updated_at');
        f.db.exec(
          "UPDATE consent_statements SET is_active=1,definition_generation=1; UPDATE consent_statement_versions SET status='active',content_hash='published'"
        );
      }
      return batch(...args);
    };
    expect(await (await adminConsentStatementDeleteHandler(context())).json()).toEqual({
      success: true,
      disposition: 'retired',
    });
    expect(await f.adapter.queryOne('SELECT title FROM consent_statement_localizations')).toEqual({
      title: 'Original',
    });
    expect(await f.adapter.query('SELECT * FROM consent_statement_versions')).toHaveLength(1);
  });
  it('preserves drafts with evidence on another shard and fails closed on unreadable shards', async () => {
    const f = setup('draft');
    const shard = openCoreStore();
    stores.push(shard);
    shard.db.exec(
      "PRAGMA foreign_keys=OFF; INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,created_at,updated_at) VALUES('r2','tenant-a','u2','terms','v1','20261029','denied',1,1)"
    );
    f.db.exec(
      'DELETE FROM user_consent_records; DELETE FROM consent_item_history; UPDATE consent_statements SET is_active=0'
    );
    state.accounts = [f.adapter, shard.adapter];
    const query = shard.adapter.query.bind(shard.adapter);
    shard.adapter.query = vi.fn().mockRejectedValue(new Error('count unavailable'));
    expect((await adminConsentStatementDeleteHandler(context())).status).toBe(500);
    expect(await f.adapter.queryOne('SELECT retired_at FROM consent_statements')).toEqual({
      retired_at: null,
    });
    shard.adapter.query = async <T>(...args: Parameters<typeof query>): Promise<T[]> =>
      (await query(...args)).map(() => ({ cnt: '1' })) as T[];
    expect(await (await adminConsentStatementDeleteHandler(context())).json()).toEqual({
      success: true,
      disposition: 'retired',
    });
    expect(await shard.adapter.queryOne('SELECT id FROM user_consent_records')).toEqual({
      id: 'r2',
    });
    expect(await f.adapter.query('SELECT * FROM consent_statement_versions')).toHaveLength(1);
  });
  it('does not reactivate retired statements or bump retirement generations on retries', async () => {
    const f = setup();
    await adminConsentStatementDeleteHandler(context());
    await adminConsentStatementDeleteHandler(context());
    expect(
      await f.adapter.queryOne(
        'SELECT definition_generation,closed_generation FROM consent_statements'
      )
    ).toEqual({ definition_generation: 1, closed_generation: 1 });
    expect((await adminConsentStatementUpdateHandler(context({ is_active: true }))).status).toBe(
      409
    );
    expect(await f.adapter.queryOne('SELECT is_active FROM consent_statements')).toEqual({
      is_active: 0,
    });
  });
  it('allows draft localization edits but rejects edits that race activation', async () => {
    const f = setup('draft');
    expect((await adminConsentLocalizationUpsertHandler(context())).status).toBe(200);
    const batch = f.adapter.batch.bind(f.adapter);
    f.adapter.batch = async (...args: Parameters<typeof batch>) => {
      f.db.exec("UPDATE consent_statement_versions SET status='active'");
      return batch(...args);
    };
    expect((await adminConsentLocalizationUpsertHandler(context())).status).toBe(409);
    f.db.exec("UPDATE consent_statement_versions SET status='draft'");
    expect((await adminConsentLocalizationDeleteHandler(context())).status).toBe(409);
    expect(await f.adapter.queryOne('SELECT title FROM consent_statement_localizations')).toEqual({
      title: 'Changed',
    });
  });
  it.each(['put', 'delete'])(
    'rejects activation if draft localization %s commits after hashing',
    async (action) => {
      const f = setup('draft');
      f.db.exec(
        "INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,is_current,current_statement_guard,content_hash,created_at,updated_at) VALUES('v0','tenant-a','terms','20261028',1,'active',1,'terms','old-hash',1,1)"
      );
      const batch = f.adapter.batch.bind(f.adapter);
      let race = true;
      f.adapter.batch = async (...args: Parameters<typeof batch>) => {
        if (race) {
          race = false;
          const response =
            action === 'put'
              ? await adminConsentLocalizationUpsertHandler(context())
              : await adminConsentLocalizationDeleteHandler(context());
          expect(response.status).toBe(200);
        }
        return batch(...args);
      };
      await expect(activateVersion(f.adapter, 'tenant-a', 'terms', 'v1')).rejects.toThrow(
        'document_changed'
      );
      expect(
        await f.adapter.queryOne(
          "SELECT status,is_current,current_statement_guard FROM consent_statement_versions WHERE id='v1'"
        )
      ).toEqual({ status: 'draft', is_current: 0, current_statement_guard: null });
      expect(
        await f.adapter.queryOne(
          "SELECT status,is_current,content_hash FROM consent_statement_versions WHERE id='v0'"
        )
      ).toEqual({ status: 'active', is_current: 1, content_hash: 'old-hash' });
      expect(
        await f.adapter.queryOne('SELECT definition_generation FROM consent_statements')
      ).toEqual({ definition_generation: 0 });
      expect(await f.adapter.query('SELECT * FROM statement_consent_projection_jobs')).toEqual([]);
      if (action === 'put') {
        await activateVersion(f.adapter, 'tenant-a', 'terms', 'v1');
        expect(
          await f.adapter.queryOne(
            "SELECT status,content_hash FROM consent_statement_versions WHERE id='v1'"
          )
        ).toEqual({
          status: 'active',
          content_hash: await computeContentHash(f.adapter, 'v1', 'tenant-a'),
        });
      }
    }
  );
  it('rolls retirement back if durable enqueue fails', async () => {
    const f = setup();
    f.db.exec(
      "CREATE TRIGGER injected_failure BEFORE INSERT ON statement_consent_projection_jobs BEGIN SELECT RAISE(ABORT,'enqueue_failure'); END"
    );
    expect((await adminConsentStatementDeleteHandler(context())).status).toBe(500);
    expect(
      await f.adapter.queryOne(
        'SELECT is_active,retired_at,definition_generation FROM consent_statements'
      )
    ).toEqual({ is_active: 1, retired_at: null, definition_generation: 0 });
  });
});
