import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminAuthMiddleware,
  PLATFORM_MAPPING_TENANT_ID,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    // Tenant routing is not set up here: each tenant's Core database is the one the test gives it.
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(
      async (env: { TEST_CORES?: Record<string, unknown> }, _partition: string, options) => {
        const adapter = env.TEST_CORES?.[options?.tenantId ?? ''];
        if (!adapter) throw new Error('tenant_database_unavailable');
        return adapter;
      }
    ),
  };
});

import { ADMIN_ROUTE_ACCESS_RULES, enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import { adminIdentityMappingEffectiveHandler } from '../identity-mapping-effective';
import {
  TENANT,
  TENANT_SUPER_ADMIN,
  setupApp,
  signIn,
  sqliteAdapter,
  type Assignment,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, openCoreDatabase } from './helpers/core-database';
import { seedDestinationProfile, seedMapping } from './helpers/identity-mapping-seed';

/**
 * The effective selection of an app: the shared `selectIdentityMapping` over the real
 * effective-settings reader (a KV double), the real admin authentication and route access, and
 * the real Admin schema and Core `oauth_clients` on SQLite.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const EFFECTIVE = '/api/admin/identity-mapping/effective';
const TENANT_DOC = `settings:tenant:${TENANT}:identity-mapping`;
const PLATFORM_DOC = 'settings:platform:identity-mapping';

const TENANT_VIEWER: Assignment[] = [{ role: 'role_viewer', scope: 'tenant' }];

function setup(options: { unreadableSettings?: boolean } = {}) {
  const store = new Map<string, string>();
  const namespace = {
    get: vi.fn(async (key: string) => {
      if (options.unreadableSettings) throw new Error('KV is down');
      return store.get(key) ?? null;
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
  const core = openCoreDatabase();
  const coreAdapter = sqliteAdapter(core);

  const context = setupApp(
    (app) => {
      app.use('*', async (c, next) => {
        (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
          tenantId: TENANT,
          coreDb: coreAdapter,
          route: {},
        });
        await next();
      });
      app.use(
        '/api/admin/*',
        adminAuthMiddleware({ plane: 'tenant' }),
        enforceDeclaredAdminRouteAccess()
      );
      app.get(EFFECTIVE, adminIdentityMappingEffectiveHandler);
    },
    {
      SETTINGS: namespace,
      AUTHRIM_CONFIG: namespace,
      TEST_CORES: { [TENANT]: coreAdapter },
      BASE_DOMAIN: 'example.com',
      ISSUER_URL: 'https://id.example.com',
    }
  );
  // A set of the tenant, one of the platform and one of another tenant, each with a profile.
  for (const [owner, id] of [
    [TENANT, 'a'],
    [PLATFORM_MAPPING_TENANT_ID, 'plat'],
    ['tenant-b', 'other'],
  ] as const) {
    seedMapping(context.db, { owner, id });
    seedDestinationProfile(context.db, { owner, id: `profile-${id}` });
  }

  const save = (document: string, values: Record<string, unknown>) =>
    store.set(document, JSON.stringify(values));
  const cookie = (assignments: Assignment[] = TENANT_SUPER_ADMIN) =>
    signIn(context.db, assignments).cookie;
  const get = (query = '', who = cookie()) => context.call(who, 'GET', `${EFFECTIVE}${query}`);
  const client = (clientId: string, identityMapping?: unknown, tenantId = TENANT) =>
    insertOAuthClient(core, { tenantId, clientId, identityMapping });
  return { ...context, core, namespace, store, save, cookie, get, client };
}

beforeEach(() => {
  vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mockClear();
});

describe('the tenant’s view (no client_id)', () => {
  it('is no default when nothing is saved', async () => {
    const t = setup();
    const response = await t.get();

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      tenantId: TENANT,
      clientId: null,
      selection: { kind: 'none', reason: 'no_default' },
      chain: [
        { tier: 'client', state: 'unset' },
        { tier: 'tenant_default', state: 'unset' },
        { tier: 'platform_default', state: 'unset' },
      ],
    });
  });

  it('shows the tenant default with the name, owner and state of its set', async () => {
    const t = setup();
    t.save(TENANT_DOC, { [KEY]: 'set-a' });

    const { json } = await t.get();

    expect(json.selection).toEqual({
      kind: 'bound',
      tier: 'tenant_default',
      setId: 'set-a',
      setFound: true,
      setName: 'Set a',
      setOwner: 'tenant',
      setLifecycleState: 'active',
    });
    expect(json.chain[1]).toEqual({
      tier: 'tenant_default',
      state: 'set',
      setId: 'set-a',
      setFound: true,
      setName: 'Set a',
      setOwner: 'tenant',
      setLifecycleState: 'active',
      source: 'kv',
    });
  });

  it('shows the platform default as the platform’s, owned by the platform, when the tenant sets none', async () => {
    const t = setup();
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });

    const { json } = await t.get();

    expect(json.selection).toMatchObject({
      kind: 'bound',
      tier: 'platform_default',
      setId: 'set-plat',
      setOwner: 'platform',
      setName: 'Set plat',
    });
    expect(json.chain.map((entry: { state: string }) => entry.state)).toEqual([
      'unset',
      'unset',
      'set',
    ]);
    expect(json.chain[2].source).toBe('platform');
  });

  it('shows both defaults when the tenant’s wins, and the tenant opting out of the platform’s', async () => {
    const t = setup();
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });
    t.save(TENANT_DOC, { [KEY]: 'set-a' });
    const both = await t.get();
    expect(both.json.selection).toMatchObject({ tier: 'tenant_default', setId: 'set-a' });
    expect(both.json.chain.map((e: { state: string }) => e.state)).toEqual(['unset', 'set', 'set']);

    t.save(TENANT_DOC, { [KEY]: 'none' });
    const optedOut = await t.get();
    expect(optedOut.json.selection).toEqual({ kind: 'none', reason: 'tenant_opt_out' });
    expect(optedOut.json.chain.map((e: { state: string }) => e.state)).toEqual([
      'unset',
      'none',
      'set',
    ]);
  });

  it('reads past the cache, so a default just saved shows at once', async () => {
    const t = setup();
    await t.get();
    t.save(TENANT_DOC, { [KEY]: 'set-a' });

    expect((await t.get()).json.selection).toMatchObject({ setId: 'set-a' });
  });
});

describe('an app', () => {
  it('is bound to its own set whatever the defaults say, and the chain still shows them', async () => {
    const t = setup();
    t.client('app-1', { fieldMappingSetId: 'set-a', fieldMappingVersionId: 'ver-a' });
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });

    const { json } = await t.get('?client_id=app-1');

    expect(json.clientId).toBe('app-1');
    expect(json.selection).toMatchObject({
      kind: 'bound',
      tier: 'client',
      setId: 'set-a',
      pinnedVersionId: 'ver-a',
      setName: 'Set a',
    });
    expect(json.chain.map((e: { tier: string; state: string }) => `${e.tier}:${e.state}`)).toEqual([
      'client:set',
      'tenant_default:unset',
      'platform_default:set',
    ]);
  });

  it('follows the tenant default when it names none (the row is NULL)', async () => {
    const t = setup();
    t.client('app-1');
    t.save(TENANT_DOC, { [KEY]: 'set-plat' });

    const { json } = await t.get('?client_id=app-1');

    expect(json.selection).toMatchObject({
      tier: 'tenant_default',
      setId: 'set-plat',
      // A tenant may name a set the platform owns.
      setOwner: 'platform',
    });
  });

  it('takes no mapping when it opts out, whatever the defaults say', async () => {
    const t = setup();
    t.client('app-1', { mode: 'none' });
    t.save(TENANT_DOC, { [KEY]: 'set-a' });

    const { json } = await t.get('?client_id=app-1');

    expect(json.selection).toEqual({ kind: 'none', reason: 'client_opt_out' });
    expect(json.chain[0]).toEqual({ tier: 'client', state: 'none' });
  });

  it('reads the older spelling of the set ID the way the selection does', async () => {
    const t = setup();
    t.client('app-1', { policySetId: 'set-a' });
    expect((await t.get('?client_id=app-1')).json.selection).toMatchObject({
      tier: 'client',
      setId: 'set-a',
    });
  });

  it('is 404 for an app that does not exist, and for another tenant’s app', async () => {
    const t = setup();
    t.client('app-b', { fieldMappingSetId: 'set-a' }, 'tenant-b');

    expect((await t.get('?client_id=nope')).status).toBe(404);
    const other = await t.get('?client_id=app-b');
    expect(other.status).toBe(404);
    // Nothing of the other tenant's app: the same answer as a missing one.
    expect(other.json).toEqual((await t.get('?client_id=nope')).json);
  });

  it.each(['?client_id=', '?client_id=%20app-1', `?client_id=${'a'.repeat(257)}`])(
    'is 400 for the client_id %s',
    async (query) => {
      const t = setup();
      expect((await t.get(query)).status).toBe(400);
    }
  );
});

describe('a default that is set and cannot be used', () => {
  it('is a failure at its level, not the next level’s answer', async () => {
    const t = setup();
    t.client('app-1');
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });
    t.save(TENANT_DOC, { [KEY]: '' });

    const { status, json } = await t.get('?client_id=app-1');

    expect(status).toBe(200);
    expect(json.selection).toEqual({
      kind: 'failed',
      code: 'default_setting_invalid',
      tier: 'tenant_default',
    });
    expect(json.chain.map((e: { tier: string; state: string }) => `${e.tier}:${e.state}`)).toEqual([
      'client:unset',
      'tenant_default:invalid',
      'platform_default:set',
    ]);
    // The value that was saved is not echoed.
    expect(JSON.stringify(json)).not.toContain('""');
  });

  it('is a failure at the app when its own value is not a choice', async () => {
    const t = setup();
    t.client('app-1', '{"fieldMappingSetId":');
    t.save(TENANT_DOC, { [KEY]: 'set-a' });

    const { json } = await t.get('?client_id=app-1');

    expect(json.selection).toEqual({
      kind: 'failed',
      code: 'client_selector_invalid',
      tier: 'client',
    });
    // Nothing below the app's own value is looked at.
    expect(json.chain.map((e: { tier: string; state: string }) => `${e.tier}:${e.state}`)).toEqual([
      'client:invalid',
      'tenant_default:not_consulted',
      'platform_default:not_consulted',
    ]);
  });

  it('answers an app that decides with the defaults not consulted when the settings cannot be read', async () => {
    const t = setup({ unreadableSettings: true });
    t.client('app-1', { fieldMappingSetId: 'set-a' });

    const { status, json } = await t.get('?client_id=app-1');

    expect(status).toBe(200);
    expect(json.selection).toMatchObject({ kind: 'bound', tier: 'client', setId: 'set-a' });
    expect(json.chain.map((e: { tier: string; state: string }) => `${e.tier}:${e.state}`)).toEqual([
      'client:set',
      'tenant_default:not_consulted',
      'platform_default:not_consulted',
    ]);
  });

  it('does not stop the app that decides for itself', async () => {
    const t = setup();
    t.client('app-1', { fieldMappingSetId: 'set-a' });
    t.save(TENANT_DOC, { [KEY]: '' });

    const { json } = await t.get('?client_id=app-1');

    expect(json.selection).toMatchObject({ kind: 'bound', tier: 'client' });
    expect(json.chain[1].state).toBe('invalid');
  });
});

describe('the sets it names', () => {
  it('says so when a set is gone, and does not name another tenant’s set', async () => {
    const t = setup();
    t.save(TENANT_DOC, { [KEY]: 'set-gone' });
    const gone = await t.get();
    expect(gone.json.selection).toEqual({
      kind: 'bound',
      tier: 'tenant_default',
      setId: 'set-gone',
      setFound: false,
    });

    t.save(TENANT_DOC, { [KEY]: 'set-other' });
    const foreign = await t.get();
    expect(foreign.json.selection).toEqual({
      kind: 'bound',
      tier: 'tenant_default',
      setId: 'set-other',
      setFound: false,
    });
    expect(JSON.stringify(foreign.json)).not.toContain('Set other');
    expect(JSON.stringify(foreign.json)).not.toContain('tenant-b');
  });

  it('reads the sets in one query', async () => {
    const t = setup();
    t.client('app-1', { fieldMappingSetId: 'set-a' });
    t.save(TENANT_DOC, { [KEY]: 'set-plat' });
    t.save(PLATFORM_DOC, { [KEY]: 'set-plat' });
    const queries: string[] = [];
    const original = t.adapter.query.bind(t.adapter);
    t.adapter.query = async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      return original(sql, params);
    };

    const { status } = await t.get('?client_id=app-1');

    expect(status).toBe(200);
    expect(queries.filter((sql) => sql.includes('FROM field_mapping_sets'))).toHaveLength(1);
  });

  it('answers without the names when the Admin database cannot be read', async () => {
    const t = setup();
    t.save(TENANT_DOC, { [KEY]: 'set-a' });
    t.db.exec('DROP TABLE field_mapping_sets');

    const { status, json } = await t.get();

    // The selection does not need the database; only the names do.
    expect(status).toBe(200);
    expect(json.selection).toEqual({ kind: 'bound', tier: 'tenant_default', setId: 'set-a' });
  });
});

describe('the settings cannot be read', () => {
  it('is 503, not "no default"', async () => {
    const t = setup({ unreadableSettings: true });

    const { status, json } = await t.get();

    expect(status).toBe(503);
    expect(json.error).toBe('temporarily_unavailable');
    expect(JSON.stringify(json)).not.toContain('KV is down');
  });
});

describe('who may ask', () => {
  it('wants a signed-in admin', async () => {
    const t = setup();
    expect((await t.call('authrim_admin_session=none', 'GET', EFFECTIVE)).status).toBe(401);
  });

  it('is allowed to a viewer, who can read settings', async () => {
    const t = setup();
    expect((await t.get('', t.cookie(TENANT_VIEWER))).status).toBe(200);
  });

  it('is refused to an admin who cannot read settings (support can read apps, not settings)', async () => {
    const t = setup();
    const who = t.cookie([{ role: 'role_support', scope: 'tenant' }]);

    expect((await t.get('', who)).status).toBe(403);
  });

  it('is a read: it declares the permission to read settings, and no write', () => {
    const rule = ADMIN_ROUTE_ACCESS_RULES.find((candidate) => candidate.pattern === EFFECTIVE);
    expect(rule).toMatchObject({ permissions: ['admin:settings:read'] });
    expect(rule?.methods).toEqual(['GET']);
  });
});
