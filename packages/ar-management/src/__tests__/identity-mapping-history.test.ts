import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminAuthMiddleware,
  applyOIDCIdentityMapping,
  ClientRepository,
  loadMappingBindingBySetId,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  bindingReads: vi.fn((_input: { setId: string; clientId?: string }) => undefined),
  afterReference: undefined as (() => void) | undefined,
  bindingFailure: undefined as Error | undefined,
}));
vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: mocks.audit,
    publishEvent: vi.fn(async () => undefined),
    loadMappingBindingBySetId: vi.fn(
      async (input: Parameters<typeof actual.loadMappingBindingBySetId>[0]) => {
        mocks.bindingReads(input);
        if (input.setId === 'set-b' && mocks.bindingFailure) throw mocks.bindingFailure;
        return actual.loadMappingBindingBySetId(input);
      }
    ),
    validateOidcMappingSetReference: vi.fn(
      async (input: Parameters<typeof actual.validateOidcMappingSetReference>[0]) => {
        const result = await actual.validateOidcMappingSetReference(input);
        const hook = mocks.afterReference;
        mocks.afterReference = undefined;
        hook?.();
        return result;
      }
    ),
  };
});

import { adminClientUpdateHandler } from '../admin-clients';
import {
  adminIdentityMappingHistoryHandler,
  adminIdentityMappingHistoryRestoreHandler,
} from '../identity-mapping-history';
import { adminIdentityMappingEffectiveHandler } from '../identity-mapping-effective';
import {
  adminIdentityMappingDestinationProfileUpdateHandler,
  adminIdentityFieldMappingVersionCompileHandler,
} from '../identity-mapping-control-plane';
import settingsV2 from '../routes/settings-v2';
import {
  TENANT,
  TENANT_SUPER_ADMIN,
  setupApp,
  signIn,
  sqliteAdapter,
  type AdapterHooks,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';
import {
  seedDestinationProfile,
  seedMapping,
  seedMappingVersion,
} from './helpers/identity-mapping-seed';
import {
  UNACKNOWLEDGED_EXPIRES_AT,
  readIdentityMappingClientHistoryReceipt,
} from '@authrim/ar-lib-core/services/identity-mapping-client-history-receipt';

const HISTORY = '/api/admin/identity-mapping/history';
const KEY = 'identity_mapping.oidc_default_set_id';

interface TestResponse {
  status: number;
  json: {
    version: string;
    expected_version: string;
    operation_id: string;
    next_cursor: string;
    reason: string;
    warning: string;
    restores: { state: string };
    later_changes: unknown[];
    selection: unknown;
    values: Record<string, unknown>;
    apps: Array<{
      before_unavailable?: string;
      before: { selection: unknown };
      after: { selection: unknown };
      changes: Array<{
        kind: string;
        claim: string;
        previous_claim?: string;
        namespace: string;
        previous_namespace?: string;
      }>;
    }>;
    apps_truncated: boolean;
    entries: Array<{
      id: string;
      before: { state: string };
      restorable: boolean;
      not_restorable_reason?: string;
    }>;
  };
}

function setup() {
  const kv = new Map<string, string>();
  let kvWrites = 0;
  const namespace = {
    get: async (key: string) => kv.get(key) ?? null,
    put: async (key: string, value: string) => {
      kvWrites++;
      kv.set(key, value);
    },
    delete: async (key: string) => {
      kv.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
  const core = openCoreDatabase();
  insertTenant(core, TENANT);
  const coreHooks: AdapterHooks = {};
  const coreAdapter = sqliteAdapter(core, coreHooks);
  const fixture = setupApp(
    (app) => {
      app.use('*', async (c, next) => {
        c.set(
          'tenantMetadataContext' as never,
          { tenantId: TENANT, coreDb: coreAdapter, route: {} } as never
        );
        Object.defineProperty(c, 'executionCtx', {
          value: { waitUntil: (_promise: Promise<unknown>) => undefined },
        });
        await next();
      });
      app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
      app.use('/api/admin/*', async (c, next) => {
        const admin = c.get('adminAuth' as never) as AdminAuthContext;
        if (c.req.header('X-Test-Agent')) {
          c.set('adminAuth' as never, { ...admin, actorType: 'agent' } as never);
          c.set(
            'agentExpectedClientUpdatedAt' as never,
            Number(c.req.header('X-Test-Version')) as never
          );
        }
        await next();
      });
      app.get(HISTORY, adminIdentityMappingHistoryHandler);
      app.post(`${HISTORY}/:id/restore`, adminIdentityMappingHistoryRestoreHandler);
      app.put('/api/admin/clients/:id', adminClientUpdateHandler);
      app.get('/api/admin/identity-mapping/effective', adminIdentityMappingEffectiveHandler);
      app.put(
        '/api/admin/field-mapping/destination-profiles/:destinationProfileId',
        adminIdentityMappingDestinationProfileUpdateHandler
      );
      app.post(
        '/api/admin/field-mapping/field-mapping-sets/:fieldMappingSetId/versions/:fieldMappingVersionId/compile',
        adminIdentityFieldMappingVersionCompileHandler
      );
      app.route('/api/admin', settingsV2);
    },
    {
      SETTINGS: namespace,
      AUTHRIM_CONFIG: namespace,
      ISSUER_URL: 'https://id.example.com',
      BASE_DOMAIN: 'example.com',
      RATE_LIMITER: {
        idFromName: (name: string) => name,
        get: () => ({
          incrementRpc: async () => ({
            allowed: true,
            current: 1,
            limit: 100,
            resetAt: Math.floor(Date.now() / 1000) + 60,
          }),
        }),
      },
    }
  );
  const root = resolve(__dirname, '../../../..');
  for (const file of [
    '028_tenant_settings_documents.sql',
    '038_tenant_settings_reconciled_at.sql',
    '039_platform_settings_documents.sql',
    '040_settings_legacy_import_state.sql',
  ]) {
    fixture.db.exec(readFileSync(resolve(root, `migrations/admin/d1/${file}`), 'utf8'));
  }
  for (const id of ['a', 'b', 'tenant']) {
    seedMapping(fixture.db, { owner: TENANT, id });
    seedDestinationProfile(fixture.db, { owner: TENANT, id: `profile-${id}` });
  }
  kv.set(`settings:tenant:${TENANT}:identity-mapping`, JSON.stringify({ [KEY]: 'set-tenant' }));
  insertOAuthClient(core, { tenantId: TENANT, clientId: 'app' });
  const cookie = signIn(fixture.db, TENANT_SUPER_ADMIN).cookie;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<TestResponse> =>
    (await fixture.call(cookie, method, path, body, headers)) as unknown as TestResponse;
  const historyRows = () =>
    fixture.db
      .prepare('SELECT * FROM identity_mapping_level_history ORDER BY created_at,id')
      .all() as Array<Record<string, unknown>>;
  const client = () =>
    core
      .prepare(
        'SELECT identity_mapping,client_name,updated_at FROM oauth_clients WHERE client_id=?'
      )
      .get('app') as { identity_mapping: string | null; client_name: string; updated_at: number };
  return {
    ...fixture,
    core,
    coreAdapter,
    coreHooks,
    call,
    historyRows,
    client,
    kvWrites: () => kvWrites,
  };
}

describe('mapping selection history, restore and committed evidence', () => {
  beforeEach(() => {
    mocks.audit.mockReset();
    mocks.bindingReads.mockClear();
    mocks.afterReference = undefined;
    mocks.bindingFailure = undefined;
  });

  it.each(['set_missing', 'set_inactive', 'destination_profile_invalid'] as const)(
    'previews and restores a valid choice while the current binding is %s',
    async (code) => {
      const f = setup();
      f.core.prepare("UPDATE oauth_clients SET scope='openid email'").run();
      await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-a' },
      });
      await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-b' },
      });
      const id = String(f.historyRows()[1].id);
      if (code === 'set_missing')
        f.db.prepare('DELETE FROM field_mapping_sets WHERE id=?').run('set-b');
      else if (code === 'set_inactive')
        f.db
          .prepare("UPDATE field_mapping_sets SET lifecycle_state='draft' WHERE id=?")
          .run('set-b');
      else {
        const updated = await f.call(
          'PUT',
          '/api/admin/field-mapping/destination-profiles/profile-b',
          {
            schema: {
              destinationType: 'oidc',
              claims: [
                {
                  claimName: 'sub',
                  required: true,
                  surfaces: ['id_token', 'userinfo'],
                  requiredScopes: [],
                  classification: 'internal',
                },
                {
                  claimName: 'email',
                  surfaces: ['id_token', 'userinfo'],
                  requiredScopes: ['email'],
                  classification: 'pii',
                },
              ],
            },
          },
          { 'Idempotency-Key': 'test-profile-update' }
        );
        expect(updated.status, JSON.stringify(updated.json)).toBe(200);
        expect(
          f.db
            .prepare('SELECT lifecycle_state FROM destination_profiles WHERE id=?')
            .get('profile-b')
        ).toMatchObject({ lifecycle_state: 'draft' });
      }
      const page = await f.call('GET', HISTORY);
      expect(page.status).toBe(200);
      expect(page.json.entries.find((entry) => entry.id === id)?.restorable).toBe(true);
      const preview = await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true });
      expect(preview.status).toBe(200);
      expect(preview.json.apps[0].before_unavailable).toBe(code);
      expect(preview.json.apps[0].before.selection).toMatchObject({
        kind: 'bound',
        setId: 'set-b',
      });
      expect(preview.json.apps[0].changes).toContainEqual(
        expect.objectContaining({ kind: 'added', claim: 'email' })
      );
      expect(
        (
          await f.call('POST', `${HISTORY}/${id}/restore`, {
            expected_version: preview.json.expected_version,
          })
        ).status
      ).toBe(200);
      expect(f.client().identity_mapping).toBe('{"fieldMappingSetId":"set-a"}');
      expect(f.historyRows()).toHaveLength(3);
      expect(f.historyRows()[2].via).toBe('restore');
    }
  );

  it.each(['database', 'unknown'] as const)(
    'fails closed when the current binding has an %s failure',
    async (failure) => {
      const f = setup();
      await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-a' },
      });
      await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-b' },
      });
      const id = String(f.historyRows()[1].id);
      if (failure === 'unknown') mocks.bindingFailure = new Error('injected_unknown');
      else {
        const queryOne = f.adapter.queryOne.bind(f.adapter);
        f.adapter.queryOne = async (sql, params, options) => {
          if (
            sql.includes('SELECT tenant_id, lifecycle_state FROM field_mapping_sets') &&
            params?.[0] === 'set-b'
          )
            throw new Error('injected_database_failure');
          return queryOne(sql, params, options);
        };
      }
      expect((await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true })).status).toBe(
        503
      );
      expect(f.client().identity_mapping).toBe('{"fieldMappingSetId":"set-b"}');
      expect(f.historyRows()).toHaveLength(2);
    }
  );

  it('keeps after-binding failures strict even when a generic activation is valid', async () => {
    const f = setup();
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-a' },
    });
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-b' },
    });
    const id = String(f.historyRows()[1].id);
    seedDestinationProfile(f.db, { owner: TENANT, id: 'profile-invalid' });
    seedMappingVersion(f.db, {
      owner: TENANT,
      setSeed: 'a',
      id: 'invalid-after',
      profiles: ['profile-invalid'],
      snapshotState: 'active',
    });
    f.db
      .prepare("UPDATE destination_profiles SET lifecycle_state='draft' WHERE id=?")
      .run('profile-invalid');
    f.db
      .prepare(
        `INSERT INTO field_mapping_activations
      (id,tenant_id,field_mapping_set_id,field_mapping_version_id,activation_scope_json,lifecycle_state,activated_at,created_at,updated_at)
      VALUES ('act-invalid-after',?,'set-a','ver-invalid-after',?,'active',200,200,200)`
      )
      .run(TENANT, JSON.stringify({ clientId: 'app' }));
    expect((await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true })).status).toBe(503);
    expect(f.client().identity_mapping).toBe('{"fieldMappingSetId":"set-b"}');
  });

  it('uses the active runtime catalog when a newer draft snapshot was compiled for the same version', async () => {
    const f = setup();
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-a' },
    });
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-b' },
    });
    f.core.prepare("UPDATE oauth_clients SET scope='openid email'").run();
    const id = String(f.historyRows()[1].id);
    f.db
      .prepare(
        `INSERT INTO field_catalog_versions
      (id,tenant_id,catalog_id,version_label,bundle_hash,lifecycle_state,created_at,updated_at)
      VALUES ('catalog-a-draft',?,'catalog-def-a','draft','draft-hash','draft',2,2)`
      )
      .run(TENANT);
    f.db
      .prepare(
        `INSERT INTO field_catalog_entries
      (id,tenant_id,catalog_version_id,stable_field_id,namespace,path,target_taxonomy,value_type,classification,created_at,updated_at)
      VALUES ('entry-a-draft',?,'catalog-a-draft','field.profile.email.a','authrim.profile','email','canonical','number','pii',2,2)`
      )
      .run(TENANT);
    const compiled = await f.call(
      'POST',
      '/api/admin/field-mapping/field-mapping-sets/set-a/versions/ver-a/compile',
      { catalogVersionId: 'catalog-a-draft' },
      { 'Idempotency-Key': 'test-draft-compile' }
    );
    expect(compiled.status, JSON.stringify(compiled.json)).toBe(200);
    expect(
      f.db
        .prepare(
          "SELECT lifecycle_state FROM compiled_mapping_snapshots WHERE catalog_version_id='catalog-a-draft'"
        )
        .get()
    ).toMatchObject({ lifecycle_state: 'draft' });
    const runtime = await loadMappingBindingBySetId({
      adapter: f.adapter,
      tenantId: TENANT,
      setId: 'set-a',
      tier: 'client',
      protocol: 'oidc',
      role: 'op',
      clientId: 'app',
    });
    expect(runtime.catalog.identity.id).toBe('catalog-a');
    expect(runtime.catalog.entries.find((entry) => entry.path === 'email')?.valueType).toBe(
      'string'
    );
    const preview = await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true });
    expect(preview.status).toBe(200);
    expect(preview.json.apps[0].changes.filter((change) => change.kind === 'type_changed')).toEqual(
      []
    );
  });

  it('protects an explicitly unchanged mapping PUT against a later mapping writer', async () => {
    const f = setup();
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-a' },
    });
    const repository = new ClientRepository(f.coreAdapter, TENANT);
    const update = repository.update.bind(repository);
    const spy = vi.spyOn(ClientRepository.prototype, 'update');
    spy.mockImplementationOnce(async (...args: Parameters<typeof update>) => {
      expect(
        (
          await f.call('PUT', '/api/admin/clients/app', {
            identity_mapping: { fieldMappingSetId: 'set-b' },
          })
        ).status
      ).toBe(200);
      return update(...args);
    });
    try {
      const stale = await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-a' },
        client_name: 'Stale',
      });
      expect(stale.status).toBe(409);
      expect(f.client().identity_mapping).toBe('{"fieldMappingSetId":"set-b"}');
      expect(f.historyRows()).toHaveLength(2);
      expect(f.historyRows()[1].after_json).toBe('{"fieldMappingSetId":"set-b"}');
      expect(f.client().client_name).toBe('Client app');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a delayed ordinary PUT version above later mapping writes and rejects an old restore token', async () => {
    const f = setup();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-a' },
      });
      const id = String(f.historyRows()[0].id);
      let staleToken = '';
      let laterVersion = 0;
      let inject = true;
      const execute = f.coreAdapter.execute.bind(f.coreAdapter);
      f.coreAdapter.execute = async (sql, params) => {
        if (inject && sql.startsWith('UPDATE oauth_clients SET')) {
          inject = false;
          expect(
            (
              await f.call('PUT', '/api/admin/clients/app', {
                identity_mapping: { fieldMappingSetId: 'set-b' },
              })
            ).status
          ).toBe(200);
          const preview = await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true });
          expect(preview.status).toBe(200);
          staleToken = preview.json.expected_version;
          expect(
            (
              await f.call('PUT', '/api/admin/clients/app', {
                identity_mapping: { fieldMappingSetId: 'set-a' },
              })
            ).status
          ).toBe(200);
          laterVersion = f.client().updated_at;
        }
        return execute(sql, params);
      };
      expect(
        (await f.call('PUT', '/api/admin/clients/app', { client_name: 'Slow ordinary edit' }))
          .status
      ).toBe(200);
      const monotonic = f.client().updated_at > laterVersion;
      const replay = await f.call('POST', `${HISTORY}/${id}/restore`, {
        expected_version: staleToken,
      });
      expect({ monotonic, restoreStatus: replay.status }).toEqual({
        monotonic: true,
        restoreStatus: 409,
      });
      expect(f.client().identity_mapping).toBe('{"fieldMappingSetId":"set-a"}');
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['explicit', 'activation fallback'] as const)(
    'previews the emitted claims when the same set namespace is restored (%s)',
    async (source) => {
      const f = setup();
      if (source === 'activation fallback') {
        f.db
          .prepare('UPDATE field_mapping_activations SET activation_scope_json=? WHERE id=?')
          .run(JSON.stringify({ destinationNamespace: 'custom.claim' }), 'act-a');
        f.db
          .prepare(
            `INSERT INTO field_mapping_activations
        (id,tenant_id,field_mapping_set_id,field_mapping_version_id,activation_scope_json,lifecycle_state,activated_at,created_at,updated_at)
        VALUES ('act-a-decoy',?,'set-a','ver-a',?,'active',200,200,200)`
          )
          .run(
            TENANT,
            JSON.stringify({ clientId: 'another-app', destinationNamespace: 'oidc.claim' })
          );
      }
      f.core.prepare("UPDATE oauth_clients SET scope='openid email profile'").run();
      for (const [namespace, path] of [
        ['oidc.claim', 'email'],
        ['custom.claim', 'nickname'],
        ['authrim.profile', 'name'],
      ]) {
        f.db
          .prepare(
            `INSERT INTO field_catalog_entries
        (id,tenant_id,catalog_version_id,stable_field_id,namespace,path,target_taxonomy,value_type,classification,created_at,updated_at)
        VALUES (?,?, 'catalog-a',?,?,?,'canonical','string','pii',1,1)`
          )
          .run(`destination-${path}`, TENANT, `destination.${path}`, namespace, path);
      }
      f.db
        .prepare(
          `INSERT INTO mapping_rule_edges
      (id,tenant_id,rule_id,source_ref_json,target_ref_json,edge_kind,display_order,created_at,updated_at)
      VALUES ('edge-namespace',?,'rule-a',?,?,'direct',1,1,1)`
        )
        .run(
          TENANT,
          JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'name' }),
          JSON.stringify({
            side: 'destination',
            profileId: 'profile-a',
            namespace: 'custom.claim',
            path: 'nickname',
          })
        );
      f.db.prepare('UPDATE destination_profile_versions SET schema_json=? WHERE profile_id=?').run(
        JSON.stringify({
          destinationType: 'oidc',
          claims: ['sub', 'email', 'nickname'].map((claimName) => ({
            claimName,
            required: claimName === 'sub',
            surfaces: ['id_token', 'userinfo'],
            requiredScopes: [
              claimName === 'email' ? 'email' : claimName === 'sub' ? 'openid' : 'profile',
            ],
            classification: 'pii',
          })),
        }),
        'profile-a'
      );
      f.core
        .prepare(
          `INSERT INTO consent_records
      (id,tenant_id,subject_user_id,protocol,consent_kind,recipient_type,recipient_id,binding_type,binding_key,statement_id,statement_version,decision,released_claims_json,created_at,updated_at)
      VALUES ('consent-namespace',?,'test-subject','oidc','scope_claim_release','oidc_client','app','destination_field_mapping_set','profile-a','destination_profile:profile-a','profile-a-v1','accepted','["email","nickname"]',1,1)`
        )
        .run(TENANT);
      const save = (destinationNamespace?: string) =>
        f.call('PUT', '/api/admin/clients/app', {
          identity_mapping: {
            fieldMappingSetId: 'set-a',
            ...(destinationNamespace ? { destinationNamespace } : {}),
          },
        });
      const restoredNamespace = source === 'explicit' ? 'oidc.claim' : undefined;
      const currentNamespace = source === 'explicit' ? 'custom.claim' : 'oidc.claim';
      expect((await save(restoredNamespace)).status).toBe(200);
      expect((await save(currentNamespace)).status).toBe(200);
      const id = String(f.historyRows()[1].id);
      const issue = async (destinationNamespace?: string) =>
        applyOIDCIdentityMapping({
          adapter: f.coreAdapter,
          env: { DB_ADMIN: f.adapter } as unknown as Partial<Env>,
          tenantId: TENANT,
          clientId: 'app',
          selector: {
            fieldMappingSetId: 'set-a',
            ...(destinationNamespace ? { destinationNamespace } : {}),
          },
          destinationSurface: 'id_token',
          fresh: true,
          grantedScopes: ['openid', 'email', 'profile'],
          claims: { sub: 'test-subject' },
          sourceAttributes: { email: 'fixture@example.com', name: 'Fixture' },
        });
      const before = Object.keys((await issue(currentNamespace)).claims).sort();
      expect(before).toEqual([source === 'explicit' ? 'nickname' : 'email', 'sub']);
      expect(Object.keys((await issue(restoredNamespace)).claims).sort()).toEqual([
        source === 'explicit' ? 'email' : 'nickname',
        'sub',
      ]);
      const preview = await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true });
      expect(preview.status).toBe(200);
      expect(mocks.bindingReads).toHaveBeenCalledTimes(2);
      expect(preview.json.apps[0].changes).toContainEqual(
        expect.objectContaining({
          kind: 'added',
          claim: source === 'explicit' ? 'email' : 'nickname',
          namespace: source === 'explicit' ? 'oidc.claim' : 'custom.claim',
        })
      );
      expect(preview.json.apps[0].changes).toContainEqual(
        expect.objectContaining({
          kind: 'removed',
          claim: source === 'explicit' ? 'nickname' : 'email',
          namespace: currentNamespace,
        })
      );
      expect(
        (
          await f.call('POST', `${HISTORY}/${id}/restore`, {
            expected_version: preview.json.expected_version,
          })
        ).status
      ).toBe(200);
      expect(Object.keys((await issue(restoredNamespace)).claims).sort()).toEqual([
        source === 'explicit' ? 'email' : 'nickname',
        'sub',
      ]);
    }
  );

  it.each(['set', 'client'] as const)(
    'reports a %s deleted between restore validation and PUT as a conflict',
    async (target) => {
      const f = setup();
      await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-a' },
      });
      await f.call('PUT', '/api/admin/clients/app', {
        identity_mapping: { fieldMappingSetId: 'set-b' },
      });
      const id = String(f.historyRows()[1].id);
      const preview = await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true });
      expect(preview.status).toBe(200);
      mocks.afterReference = () =>
        target === 'set'
          ? void f.db.prepare('DELETE FROM field_mapping_sets WHERE id=?').run('set-a')
          : void f.core.prepare('DELETE FROM oauth_clients WHERE client_id=?').run('app');
      const result = await f.call('POST', `${HISTORY}/${id}/restore`, {
        expected_version: preview.json.expected_version,
      });
      expect(result.status).toBe(409);
      expect(result.json.reason).toBe(target === 'set' ? 'set_deleted' : 'client_deleted');
      expect(f.historyRows()).toHaveLength(2);
    }
  );

  it('restores an unset client level through PUT while retaining later history and unrelated fields', async () => {
    const f = setup();
    expect(
      (
        await f.call('PUT', '/api/admin/clients/app', {
          identity_mapping: { fieldMappingSetId: 'set-a' },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await f.call('PUT', '/api/admin/clients/app', {
          identity_mapping: { fieldMappingSetId: 'set-b' },
          client_name: 'Kept',
        })
      ).status
    ).toBe(200);
    const first = f.historyRows()[0];
    expect(first.status).toBe('committed');
    expect(first.before_json).toBe('null');
    expect(first.receipt_acknowledged_at).toEqual(expect.any(Number));
    const preview = await f.call('POST', `${HISTORY}/${String(first.id)}/restore`, {
      preview: true,
    });
    expect(preview.status).toBe(200);
    expect(preview.json.restores).toEqual({ state: 'unset' });
    expect(preview.json.later_changes).toHaveLength(1);
    expect(preview.json.warning).toBe('later_changes_will_be_overwritten');
    expect(preview.json.apps).toHaveLength(1);
    expect(preview.json.apps[0].after.selection).toMatchObject({
      kind: 'bound',
      tier: 'tenant_default',
      setId: 'set-tenant',
    });
    const restored = await f.call('POST', `${HISTORY}/${String(first.id)}/restore`, {
      expected_version: preview.json.expected_version,
      reason: 'Restore selection',
    });
    expect(restored.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'client.updated',
      'client',
      'app',
      expect.objectContaining({ restored_from: first.id, restore_reason: 'Restore selection' })
    );
    expect(f.client()).toMatchObject({ identity_mapping: null, client_name: 'Kept' });
    expect(f.historyRows()).toHaveLength(3);
    expect(f.historyRows()[2].via).toBe('restore');
    expect(
      (await f.call('GET', '/api/admin/identity-mapping/effective?client_id=app')).json.selection
    ).toMatchObject({ kind: 'bound', tier: 'tenant_default', setId: 'set-tenant' });
    const page = await f.call('GET', `${HISTORY}?tier=client&limit=1`);
    expect(page.status).toBe(200);
    expect(page.json.entries).toHaveLength(1);
    expect(page.json.next_cursor).toEqual(expect.any(String));
    expect(
      (
        await f.call(
          'GET',
          `${HISTORY}?tier=tenant_default&cursor=${encodeURIComponent(page.json.next_cursor)}`
        )
      ).status
    ).toBe(400);
  });

  it('checks the source version again and refuses unavailable restore sets at read time', async () => {
    const f = setup();
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-a' },
    });
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-b' },
    });
    const second = f.historyRows()[1];
    const preview = await f.call('POST', `${HISTORY}/${String(second.id)}/restore`, {
      preview: true,
    });
    await f.call('PUT', '/api/admin/clients/app', { client_name: 'Concurrent' });
    expect(
      (
        await f.call('POST', `${HISTORY}/${String(second.id)}/restore`, {
          expected_version: preview.json.expected_version,
        })
      ).status
    ).toBe(409);
    f.db.prepare("UPDATE field_mapping_sets SET lifecycle_state='disabled' WHERE id='set-a'").run();
    const disabled = await f.call('POST', `${HISTORY}/${String(second.id)}/restore`, {
      preview: true,
    });
    expect(disabled.status).toBe(409);
    expect(disabled.json.reason).toBe('set_inactive');
    const listed = await f.call('GET', `${HISTORY}?tier=client`);
    expect(listed.json.entries.find((row: { id: string }) => row.id === second.id)).toMatchObject({
      restorable: false,
      not_restorable_reason: 'set_inactive',
    });
    f.db.prepare('DELETE FROM field_mapping_sets WHERE id=?').run('set-a');
    expect(
      (await f.call('POST', `${HISTORY}/${String(second.id)}/restore`, { preview: true })).json
        .reason
    ).toBe('set_deleted');
  });

  it('paginates a maximum-length Unicode client ID across two UTF-8 cursor pages', async () => {
    const f = setup();
    const clientId = 'あ'.repeat(256);
    insertOAuthClient(f.core, { tenantId: TENANT, clientId });
    const path = `/api/admin/clients/${encodeURIComponent(clientId)}`;
    expect((await f.call('PUT', path, { identity_mapping: { mode: 'none' } })).status).toBe(200);
    expect(
      (await f.call('PUT', path, { identity_mapping: { fieldMappingSetId: 'set-a' } })).status
    ).toBe(200);
    const query = `${HISTORY}?tier=client&client_id=${encodeURIComponent(clientId)}&limit=1`;
    const first = await f.call('GET', query);
    expect(first.status).toBe(200);
    expect(first.json.entries).toHaveLength(1);
    expect(first.json.next_cursor.length).toBeGreaterThan(1024);
    expect(first.json.next_cursor.length).toBeLessThanOrEqual(2048);
    const second = await f.call(
      'GET',
      `${query}&cursor=${encodeURIComponent(first.json.next_cursor)}`
    );
    expect(second.status).toBe(200);
    expect(second.json.entries).toHaveLength(1);
    expect(second.json.entries[0].id).not.toBe(first.json.entries[0].id);
    expect(second.json.next_cursor).toBeNull();
  });

  it('rejects cross-tenant IDs, malformed requests, spoofed internal fields and Agents', async () => {
    const f = setup();
    await f.call('PUT', '/api/admin/clients/app', { identity_mapping: { mode: 'none' } });
    const id = String(f.historyRows()[0].id);
    for (const body of [
      { preview: false },
      { preview: true, expected_version: '1' },
      { expected_version: '1', via: 'restore' },
      { expected_version: '1', reason: '' },
    ]) {
      expect((await f.call('POST', `${HISTORY}/${id}/restore`, body)).status).toBe(400);
    }
    expect(
      (
        await f.call(
          'POST',
          `${HISTORY}/${id}/restore`,
          { preview: true },
          { 'X-Test-Agent': '1', 'X-Test-Version': String(f.client().updated_at) }
        )
      ).status
    ).toBe(403);
    f.db
      .prepare('UPDATE identity_mapping_level_history SET tenant_id=? WHERE id=?')
      .run('tenant-other', id);
    expect((await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true })).status).toBe(404);
    expect((await f.call('GET', HISTORY)).json.entries).toHaveLength(0);
  });

  it('stops before the client write when history preparation fails', async () => {
    const f = setup();
    f.db.exec(
      "CREATE TRIGGER fail_history BEFORE INSERT ON identity_mapping_level_history BEGIN SELECT RAISE(ABORT,'injected_prepare'); END"
    );
    expect(
      (
        await f.call('PUT', '/api/admin/clients/app', {
          identity_mapping: { mode: 'none' },
          client_name: 'Denied',
        })
      ).status
    ).toBe(503);
    expect(f.client()).toMatchObject({ identity_mapping: null, client_name: 'Client app' });
    expect(f.historyRows()).toHaveLength(0);
  });

  it('keeps a pending intent and non-expiring receipt when Core commits before its reply is lost', async () => {
    const f = setup();
    const batch = f.coreAdapter.batch.bind(f.coreAdapter);
    f.coreAdapter.batch = async (statements) => {
      await batch(statements);
      throw new Error('reply_lost');
    };
    const result = await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { mode: 'none' },
    });
    expect(result.status).toBe(503);
    expect(result.json.operation_id).toEqual(expect.any(String));
    expect(f.historyRows()[0].status).toBe('pending');
    expect((await f.call('GET', HISTORY)).json.entries).toHaveLength(0);
    expect(f.client().identity_mapping).toBe('{"mode":"none"}');
    expect(
      (
        await readIdentityMappingClientHistoryReceipt(
          f.coreAdapter,
          TENANT,
          result.json.operation_id
        )
      )?.sourceVersion
    ).toBe(String(f.client().updated_at));
    expect(
      (f.core.prepare('SELECT expires_at FROM idempotency_keys').get() as { expires_at: number })
        .expires_at
    ).toBe(UNACKNOWLEDGED_EXPIRES_AT);
  });

  it('keeps committed history after a later HTTP failure and never acknowledges before Admin commit', async () => {
    const f = setup();
    f.db.exec(
      "CREATE TRIGGER fail_finalize BEFORE UPDATE ON identity_mapping_level_history WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'injected_finalize'); END"
    );
    const uncertain = await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { mode: 'none' },
    });
    expect(uncertain.status).toBe(503);
    expect(f.historyRows()[0].status).toBe('pending');
    expect(
      (f.core.prepare('SELECT expires_at FROM idempotency_keys').get() as { expires_at: number })
        .expires_at
    ).toBe(UNACKNOWLEDGED_EXPIRES_AT);
    f.db.exec('DROP TRIGGER fail_finalize');
    mocks.audit.mockRejectedValueOnce(new Error('later_http_failure'));
    const failed = await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-a' },
    });
    expect(failed.status).toBe(500);
    expect(f.historyRows()[1].status).toBe('committed');
  });

  it('aborts a failed CAS with no body write and preserves the Agent 412 contract', async () => {
    const f = setup();
    const race = async () => {
      f.core.prepare('UPDATE oauth_clients SET updated_at=updated_at+1').run();
    };
    f.coreHooks.beforeBatch = race;
    expect(
      (
        await f.call('PUT', '/api/admin/clients/app', {
          identity_mapping: { mode: 'none' },
          client_name: 'Denied',
        })
      ).status
    ).toBe(409);
    expect(f.historyRows()[0].status).toBe('aborted');
    expect(f.client().client_name).toBe('Client app');
    expect(f.core.prepare('SELECT id FROM idempotency_keys').all()).toHaveLength(0);
    f.coreHooks.beforeBatch = race;
    expect(
      (
        await f.call(
          'PUT',
          '/api/admin/clients/app',
          { identity_mapping: { mode: 'none' } },
          { 'X-Test-Agent': '1', 'X-Test-Version': String(f.client().updated_at) }
        )
      ).status
    ).toBe(412);
  });

  it('returns the CAS conflict when another writer changes the mapping after Admin preparation', async () => {
    const f = setup();
    const execute = f.adapter.execute.bind(f.adapter);
    f.adapter.execute = async (sql, params) => {
      const result = await execute(sql, params);
      if (sql.includes('INSERT INTO identity_mapping_level_history')) {
        f.core
          .prepare('UPDATE oauth_clients SET updated_at=updated_at+1,identity_mapping=?')
          .run('{"fieldMappingSetId":"set-b"}');
      }
      return result;
    };
    expect(
      (
        await f.call('PUT', '/api/admin/clients/app', {
          identity_mapping: { mode: 'none' },
          client_name: 'Denied',
        })
      ).status
    ).toBe(409);
    expect(f.historyRows()[0].status).toBe('aborted');
    expect(f.client().identity_mapping).toBe('{"fieldMappingSetId":"set-b"}');
    expect(f.client().client_name).toBe('Client app');
    expect(f.core.prepare('SELECT id FROM idempotency_keys').all()).toHaveLength(0);
  });

  it('lists and previews without bootstrapping settings documents or writing KV', async () => {
    const f = setup();
    await f.call('PUT', '/api/admin/clients/app', { identity_mapping: { mode: 'none' } });
    const id = String(f.historyRows()[0].id);
    const writes = f.kvWrites();
    expect(f.db.prepare('SELECT category FROM tenant_settings_documents').all()).toHaveLength(0);
    expect((await f.call('GET', HISTORY)).status).toBe(200);
    expect((await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true })).status).toBe(200);
    expect(f.db.prepare('SELECT category FROM tenant_settings_documents').all()).toHaveLength(0);
    expect(f.kvWrites()).toBe(writes);
    expect(f.historyRows()).toHaveLength(1);
  });

  it.each([false, true])(
    'restores the tenant default and bounds a 200-app preview (scoped versions: %s)',
    async (scoped) => {
      const f = setup();
      const path = `/api/admin/tenants/${TENANT}/settings/identity-mapping`;
      const state = await f.call('GET', path);
      const saved = await f.call('PATCH', path, {
        ifMatch: state.json.version,
        set: { [KEY]: 'set-b' },
      });
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      const entry = f.historyRows()[0];
      if (scoped) {
        seedMappingVersion(f.db, {
          owner: TENANT,
          setSeed: 'tenant',
          id: 'tenant-custom',
          snapshotState: 'active',
        });
        f.db.prepare('UPDATE mapping_rule_edges SET target_ref_json=? WHERE id=?').run(
          JSON.stringify({
            side: 'destination',
            profileId: 'profile-tenant',
            namespace: 'custom.claim',
            path: 'nickname',
          }),
          'edge-tenant-custom-0'
        );
        f.db
          .prepare(
            "UPDATE destination_profile_versions SET schema_json=json_insert(schema_json,'$.claims[#]',json(?)) WHERE profile_id=?"
          )
          .run(
            JSON.stringify({
              claimName: 'nickname',
              surfaces: ['id_token', 'userinfo'],
              requiredScopes: ['profile'],
              classification: 'pii',
            }),
            'profile-tenant'
          );
        for (const [id, clientId, namespace] of [
          ['selected', 'app-000', 'custom.claim'],
          ['decoy', 'another-app', 'oidc.claim'],
        ]) {
          f.db
            .prepare(
              `INSERT INTO field_mapping_activations
          (id,tenant_id,field_mapping_set_id,field_mapping_version_id,activation_scope_json,lifecycle_state,activated_at,created_at,updated_at)
          VALUES (?,?,'set-tenant','ver-tenant-custom',?,'active',200,200,200)`
            )
            .run(
              `act-tenant-${id}`,
              TENANT,
              JSON.stringify({ clientId, destinationNamespace: namespace })
            );
        }
      }
      for (let index = 0; index < 200; index++)
        insertOAuthClient(f.core, {
          tenantId: TENANT,
          clientId: `app-${String(index).padStart(3, '0')}`,
        });
      f.core.prepare("UPDATE oauth_clients SET scope='openid email profile'").run();
      let queries = 0;
      for (const adapter of [f.adapter, f.coreAdapter]) {
        const query = adapter.query.bind(adapter),
          queryOne = adapter.queryOne.bind(adapter);
        adapter.query = async (...args) => {
          queries++;
          return query(...args);
        };
        adapter.queryOne = async (...args) => {
          queries++;
          return queryOne(...args);
        };
      }
      const before = f.db.prepare('SELECT COUNT(*) AS n FROM identity_mapping_level_history').get();
      const preview = await f.call('POST', `${HISTORY}/${String(entry.id)}/restore`, {
        preview: true,
      });
      expect(preview.status).toBe(200);
      expect(preview.json.apps).toHaveLength(200);
      expect(preview.json.apps_truncated).toBe(true);
      expect(queries).toBeLessThan(50);
      expect(new Set(mocks.bindingReads.mock.calls.map(([input]) => input.clientId)).size).toBe(
        200
      );
      if (scoped) {
        expect(preview.json.apps[1].changes).toContainEqual(
          expect.objectContaining({ kind: 'added', claim: 'nickname', namespace: 'custom.claim' })
        );
        expect(
          preview.json.apps[2].changes.some(
            (change) => change.claim === 'nickname' && !change.kind.startsWith('profile_field_')
          )
        ).toBe(false);
        expect(preview.json.apps[2].changes).toContainEqual(
          expect.objectContaining({
            kind: 'profile_changed',
            claim: 'email',
            namespace: 'oidc.claim',
          })
        );
      }
      expect(
        f.db.prepare('SELECT COUNT(*) AS n FROM identity_mapping_level_history').get()
      ).toEqual(before);
      expect(
        (
          await f.call('POST', `${HISTORY}/${String(entry.id)}/restore`, {
            expected_version: preview.json.expected_version,
          })
        ).status
      ).toBe(200);
      expect((await f.call('GET', path)).json.values[KEY]).toBe('set-tenant');
      expect(f.historyRows()[1].via).toBe('restore');
    }
  );

  it('resolves an explicit namespace once and performs no binding read for a none selection', async () => {
    const f = setup();
    await f.call('PUT', '/api/admin/clients/app', { identity_mapping: { mode: 'none' } });
    await f.call('PUT', '/api/admin/clients/app', {
      identity_mapping: { fieldMappingSetId: 'set-a', destinationNamespace: 'oidc.claim' },
    });
    const id = String(f.historyRows()[1].id);
    const preview = await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true });
    expect(preview.status).toBe(200);
    expect(mocks.bindingReads).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ setId: 'set-a', clientId: 'app' })
    );
    expect(preview.json.apps[0].after.selection).toMatchObject({ kind: 'none' });
  });

  it('truncates before the 21st runtime content when app-scoped versions share one selector', async () => {
    const f = setup();
    const path = `/api/admin/tenants/${TENANT}/settings/identity-mapping`;
    const state = await f.call('GET', path);
    expect(
      (await f.call('PATCH', path, { ifMatch: state.json.version, set: { [KEY]: 'set-b' } })).status
    ).toBe(200);
    const entry = f.historyRows()[0];
    for (let index = 0; index < 21; index++) {
      const clientId = `app-${String(index).padStart(3, '0')}`;
      const id = `bounded-${index}`;
      insertOAuthClient(f.core, { tenantId: TENANT, clientId });
      seedMappingVersion(f.db, { owner: TENANT, setSeed: 'tenant', id, snapshotState: 'active' });
      f.db
        .prepare(
          `INSERT INTO field_mapping_activations
        (id,tenant_id,field_mapping_set_id,field_mapping_version_id,activation_scope_json,lifecycle_state,activated_at,created_at,updated_at)
        VALUES (?,?,'set-tenant',?,?,'active',200,200,200)`
        )
        .run(`act-${id}`, TENANT, `ver-${id}`, JSON.stringify({ clientId }));
    }
    const preview = await f.call('POST', `${HISTORY}/${String(entry.id)}/restore`, {
      preview: true,
    });
    expect(preview.status).toBe(200);
    expect(preview.json.apps_truncated).toBe(true);
    // Both the current set-b and the general tenant binding count toward the 20-content budget.
    expect(preview.json.apps).toHaveLength(19);
  });

  it('rejects a tenant restore after the level changes away and back to the same settings hash', async () => {
    const f = setup();
    const path = `/api/admin/tenants/${TENANT}/settings/identity-mapping`;
    const save = async (value: string) => {
      const state = await f.call('GET', path);
      expect(
        (await f.call('PATCH', path, { ifMatch: state.json.version, set: { [KEY]: value } })).status
      ).toBe(200);
    };
    await save('set-a');
    await save('set-b');
    const entry = f.historyRows()[1];
    const preview = await f.call('POST', `${HISTORY}/${String(entry.id)}/restore`, {
      preview: true,
    });
    expect(preview.status).toBe(200);
    await save('set-tenant');
    await save('set-b');
    const replay = await f.call('POST', `${HISTORY}/${String(entry.id)}/restore`, {
      expected_version: preview.json.expected_version,
    });
    expect(replay.status).toBe(409);
    expect(replay.json.reason).toBe('version_conflict');
  });

  it.each([
    { before: {}, state: 'unset', restored: null },
    { before: { policySetId: 'set-a' }, state: 'set', restored: 'set-a' },
    { before: { destinationProfileId: 'legacy' }, state: 'invalid', restored: undefined },
  ])(
    'describes legacy client choices without breaking the page: $state',
    async ({ before, state, restored }) => {
      const f = setup();
      f.core.prepare('UPDATE oauth_clients SET identity_mapping=?').run(JSON.stringify(before));
      expect(
        (await f.call('PUT', '/api/admin/clients/app', { identity_mapping: { mode: 'none' } }))
          .status
      ).toBe(200);
      const id = String(f.historyRows()[0].id);
      const page = await f.call('GET', `${HISTORY}?tier=client`);
      expect(page.status).toBe(200);
      expect(page.json.entries[0].before.state).toBe(state);
      if (state === 'invalid') {
        expect(page.json.entries[0].not_restorable_reason).toBe('invalid_history');
        expect((await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true })).status).toBe(
          409
        );
      } else {
        const preview = await f.call('POST', `${HISTORY}/${id}/restore`, { preview: true });
        expect(preview.status).toBe(200);
        expect(
          (
            await f.call('POST', `${HISTORY}/${id}/restore`, {
              expected_version: preview.json.expected_version,
            })
          ).status
        ).toBe(200);
        const value: unknown =
          f.client().identity_mapping === null
            ? null
            : JSON.parse(f.client().identity_mapping as string);
        expect(value).toEqual(restored === null ? null : { fieldMappingSetId: restored });
      }
    }
  );
});
