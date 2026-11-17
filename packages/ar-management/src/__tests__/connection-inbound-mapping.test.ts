import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateKeyPair, exportJWK, exportPKCS8 } from 'jose';
import {
  adminAuthMiddleware,
  type DatabaseAdapter,
  type SAMLIdPConfig,
} from '@authrim/ar-lib-core';
import { generateSelfSignedCertificate } from '@authrim/ar-saml/src/common/key-utils';
import { extractUserInfo } from '@authrim/ar-saml/inbound-receiver';
import { handleUpdateProvider } from '@authrim/ar-saml/admin-providers';
import {
  evaluateInboundMapping,
  inboundProfileTargets,
  oidcInboundSources,
} from '@authrim/ar-lib-core/services/inbound-identity-mapping';
import { findMappingSetReferences } from '@authrim/ar-lib-core/services/identity-mapping-set-references';
import { resolveRuntimeIdentityMappingBinding } from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
import {
  getConnectionInboundMapping,
  putConnectionInboundMapping,
  previewConnectionInboundMapping,
  inboundMappingIdempotency,
} from '../connection-inbound-mapping';
import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import { setupApp, signIn, TENANT, TENANT_SUPER_ADMIN } from './helpers/admin-authority-fixture';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { insertSamlProvider, insertTenant } from './helpers/core-database';
import type { SQLiteDatabase } from './test-sqlite';

const seams = vi.hoisted(() => ({ stepUp: vi.fn(async (): Promise<Response | null> => null) }));
vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: (c: { env: { DB_CORE: DatabaseAdapter } }) => ({
      coreAdapter: c.env.DB_CORE,
    }),
    resolveAuthCorePersistenceAdapterFromEnv: async (env: { DB_CORE: DatabaseAdapter }) =>
      env.DB_CORE,
    requireAdminStepUp: async (...args: Parameters<typeof actual.requireAdminStepUp>) => {
      const refused = await seams.stepUp();
      if (refused) actual.markIdempotentResponseRetryable(args[0]);
      return refused;
    },
    createAuditLogFromContext: vi.fn(async () => undefined),
    createAuditLog: vi.fn(async () => undefined),
    bumpAuthenticationMethodsCacheRevision: vi.fn(async () => undefined),
  };
});
const close: SQLiteDatabase[] = [];
afterEach(() => {
  for (const db of close.splice(0)) db.close();
  seams.stepUp.mockClear();
});
const BASE = '/api/admin/identity-mapping/inbound';
const selector = z.object({
  fieldMappingSetId: z.string(),
  fieldMappingVersionId: z.string(),
  inboundContract: z.literal('connection-v1').optional(),
});
const responseDocument = z.object({
  revision: z.string(),
  configured: z.boolean(),
  providerUpdatedAt: z.string(),
  content: z.object({ rules: z.array(z.unknown()) }),
});
async function fixture() {
  const core = openCoreStore(TENANT);
  const keys = await generateKeyPair('RS256', { extractable: true });
  const certificate = await generateSelfSignedCertificate(
    await exportJWK(keys.publicKey),
    await exportPKCS8(keys.privateKey)
  );
  const config: SAMLIdPConfig = {
    entityId: 'urn:synthetic:idp',
    ssoUrl: 'https://identity.example.test/sso',
    certificate,
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
    attributeMapping: {},
    allowedBindings: ['post'],
    jitEmailLinkingPolicy: 'disabled',
    allowSyntheticEmailFallback: false,
    profileUpdateFields: [],
  };
  insertSamlProvider(core.db, { tenantId: TENANT, id: 'idp', providerType: 'saml_idp', config });
  core.db
    .prepare(
      `INSERT INTO upstream_providers
    (id, tenant_id, name, provider_type, client_id, client_secret_encrypted, scopes, attribute_mapping, provider_quirks, created_at, updated_at)
    VALUES ('op', ?, 'Synthetic OP', 'oidc', 'synthetic-client', '', 'openid email profile', ?, ?, 1, 1)`
    )
    .run(
      TENANT,
      JSON.stringify({ name: 'old_name', 'custom_claims.stale': 'old_claim' }),
      JSON.stringify({ trustEmail: false, responseType: 'code' })
    );
  let activeConfig = config;
  const t = setupApp(
    (app) => {
      app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
      app.use('/api/admin/identity-mapping/*', enforceDeclaredAdminRouteAccess());
      app.get(`${BASE}/:kind/:id`, getConnectionInboundMapping);
      app.put(`${BASE}/:kind/:id`, inboundMappingIdempotency, putConnectionInboundMapping);
      app.post(`${BASE}/:kind/:id/preview`, previewConnectionInboundMapping);
      app.put('/api/admin/saml-providers/:id', handleUpdateProvider);
      app.get('/runtime/saml', async (c) => {
        const row = await core.adapter.queryOne<{ config_json: string }>(
          'SELECT config_json FROM identity_providers WHERE id = ? AND tenant_id = ?',
          ['idp', TENANT]
        );
        if (!row) return c.json({ error: 'missing_fixture' }, 500);
        const stored: unknown = JSON.parse(row.config_json);
        const binding = z.object({ identityMapping: selector }).parse(stored);
        activeConfig = { ...config, identityMapping: binding.identityMapping };
        return c.json(
          await extractUserInfo(
            c.env,
            TENANT,
            'urn:synthetic:authrim-sp',
            {
              id: 'synthetic-assertion',
              issueInstant: new Date().toISOString(),
              issuer: config.entityId,
              subject: { nameId: 'immutable-nameid', nameIdFormat: config.nameIdFormat },
              attributeStatement: [
                { name: 'mail', values: [' sample@example.test '] },
                { name: 'unmapped-attribute', values: ['ignored'] },
              ],
            },
            activeConfig
          )
        );
      });
      app.get('/runtime/oidc', async (c) => {
        const row = await core.adapter.queryOne<{ provider_quirks: string }>(
          "SELECT provider_quirks FROM upstream_providers WHERE id='op'"
        );
        const configured = z
          .object({ inboundIdentityMapping: selector })
          .parse(JSON.parse(row?.provider_quirks ?? '{}')).inboundIdentityMapping;
        const binding = await resolveRuntimeIdentityMappingBinding(t.adapter, {
          tenantId: TENANT,
          protocol: 'oidc',
          role: 'rp',
          providerId: 'op',
          ...configured,
        });
        if (!binding) return c.json({ error: 'missing_fixture' }, 500);
        return c.json(
          await evaluateInboundMapping({
            env: c.env,
            tenantId: TENANT,
            protocol: 'oidc',
            binding,
            targets: inboundProfileTargets(),
            sources: oidcInboundSources(
              { email: ' sample@example.test ', old_name: 'Stale legacy name' },
              binding.catalog.entries
            ),
          })
        );
      });
    },
    {
      DB_CORE: core.adapter,
      DB: core.adapter,
      AUTHRIM_CONFIG: { get: async () => null },
      SETTINGS: { get: async () => null },
      ISSUER_URL: 'https://authrim.example.test',
    }
  );
  close.push(t.db, core.db);
  const cookie = signIn(t.db, TENANT_SUPER_ADMIN).cookie;
  const call = (method: string, path: string, body?: unknown, key = crypto.randomUUID()) =>
    t.call(cookie, method, path, body, { 'Idempotency-Key': key });
  const read = async (kind: 'op' | 'idp') =>
    responseDocument.parse((await call('GET', `${BASE}/${kind}/${kind}`)).json);
  function draft(kind: 'op' | 'idp', revision: string) {
    const namespace = kind === 'op' ? 'oidc.userinfo' : 'saml.attribute';
    const sourceRef = { side: 'source', namespace, path: kind === 'op' ? 'email' : 'mail' };
    const targetRef = { side: 'destination', namespace: 'authrim.profile', path: 'email' };
    return {
      revision,
      sources: [{ namespace, path: sourceRef.path, cardinality: 'single' }],
      rules: [
        {
          ruleKey: 'email',
          ruleKind: 'transform',
          action: 'allow',
          targetRef,
          edges: [{ sourceRef, targetRef }],
          transforms: [{ operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
          output: { stepIndex: 0 },
        },
      ],
    };
  }
  return {
    ...t,
    authorityCall: t.call,
    core,
    cookie,
    call,
    read,
    draft,
    get config() {
      return activeConfig;
    },
  };
}

describe('incoming connection HTTP / SQL / receiver integration', () => {
  it.each(['op', 'idp'])(
    'saves, reopens and evaluates %s through the actual receiver',
    async (value) => {
      const kind = value === 'op' ? 'op' : 'idp';
      const t = await fixture();
      const before = await t.read(kind);
      const draft = t.draft(kind, before.revision);
      const sample =
        kind === 'op'
          ? { email: ' sample@example.test ' }
          : { 'saml.attribute': { mail: ' sample@example.test ' } };
      const preview = await t.call('POST', `${BASE}/${kind}/${kind}/preview`, { ...draft, sample });
      expect(preview.status).toBe(200);
      expect(preview.json).toEqual({ profile: { email: 'sample@example.test' }, customClaims: {} });
      if (kind === 'idp') {
        const singleton = await t.call('POST', `${BASE}/idp/idp/preview`, {
          ...draft,
          sample: { 'saml.attribute': { mail: [' sample@example.test '] } },
        });
        expect(singleton.status).toBe(200);
        expect(singleton.json).toEqual(preview.json);
      }

      const key = crypto.randomUUID();
      const saved = await t.call('PUT', `${BASE}/${kind}/${kind}`, draft, key);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      const read = await t.read(kind);
      expect(read.configured).toBe(true);
      expect(read.content.rules).toEqual(responseDocument.parse(saved.json).content.rules);
      expect(read.revision).not.toBe(before.revision);
      expect((await t.call('PUT', `${BASE}/${kind}/${kind}`, draft, key)).json).toEqual(saved.json);
      const runtime = await t.call('GET', `/runtime/${kind === 'op' ? 'oidc' : 'saml'}`);
      expect(runtime.status, JSON.stringify(runtime.json)).toBe(200);
      if (kind === 'op') {
        expect(runtime.json).toEqual({
          profile: { email: 'sample@example.test' },
          customClaims: {},
        });
        const row = await t.core.adapter.queryOne<{ provider_quirks: string }>(
          "SELECT provider_quirks FROM upstream_providers WHERE id='op'"
        );
        const binding = z
          .object({ inboundIdentityMapping: selector })
          .parse(JSON.parse(row?.provider_quirks ?? '{}'));
        const references = await findMappingSetReferences({
          adminAdapter: t.adapter,
          contextCoreAdapter: t.core.adapter,
          contextTenantId: TENANT,
          ownerTenantId: TENANT,
          setId: binding.inboundIdentityMapping.fieldMappingSetId,
        });
        expect(references.references).toContainEqual(
          expect.objectContaining({
            kind: 'upstream_provider',
            providerId: 'op',
            pinnedVersionId: binding.inboundIdentityMapping.fieldMappingVersionId,
          })
        );
      } else {
        expect(runtime.json).toMatchObject({
          nameId: 'immutable-nameid',
          email: 'sample@example.test',
        });
        const enabled = await t.call('PUT', '/api/admin/saml-providers/idp', {
          enabled: true,
          expectedUpdatedAt: read.providerUpdatedAt,
        });
        expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
        expect(enabled.json.enabled).toBe(true);
        expect(enabled.json.config).toMatchObject({
          profileUpdateFields: [],
          jitEmailLinkingPolicy: 'disabled',
          allowSyntheticEmailFallback: false,
          identityMapping: t.config.identityMapping,
        });
      }
    }
  );

  it('refuses stale revisions and cross-tenant/provider ownership without changing the binding', async () => {
    const t = await fixture();
    const before = await t.read('op');
    const draft = t.draft('op', before.revision);
    expect((await t.call('PUT', `${BASE}/op/op`, { ...draft, revision: 'stale' })).status).toBe(
      409
    );
    expect((await t.call('PUT', `${BASE}/idp/op`, draft)).status).toBe(404);
    insertTenant(t.core.db, 'other-tenant');
    t.core.db.prepare("UPDATE upstream_providers SET tenant_id='other-tenant' WHERE id='op'").run();
    expect((await t.call('GET', `${BASE}/op/op`)).status).toBe(404);
  });

  it('rejects outgoing/protected targets, source disguises, identifiers and dangling references', async () => {
    const t = await fixture();
    const before = await t.read('op');
    for (const target of [
      { side: 'destination', namespace: 'oidc.claim', path: 'email', profileId: 'outgoing' },
      { side: 'destination', namespace: 'authrim.profile', path: 'sub' },
      { side: 'destination', namespace: 'authrim.profile', path: 'email_verified' },
      { side: 'destination', namespace: 'authrim.custom_claims', path: 'permissions' },
    ]) {
      const draft = t.draft('op', before.revision);
      expect(
        (
          await t.call('PUT', `${BASE}/op/op`, {
            ...draft,
            rules: [{ ...draft.rules[0], targetRef: target }],
          })
        ).status
      ).toBe(400);
    }
    const draft = t.draft('op', before.revision);
    for (const changed of [
      { ...draft, protocol: 'saml' },
      { ...draft, rules: [{ ...draft.rules[0], metadata: { release: 'unsupported' } }] },
      {
        ...draft,
        rules: [
          { ...draft.rules[0], edges: [{ ...draft.rules[0].edges[0], edgeKind: 'unsupported' }] },
        ],
      },

      {
        ...draft,
        sources: [{ namespace: 'authrim.profile', path: 'email', cardinality: 'single' }],
      },
      { ...draft, rules: [{ ...draft.rules[0], output: { edgeIndex: 999 } }] },
      {
        ...draft,
        rules: [
          {
            ...draft.rules[0],
            transforms: [{ operation: 'persistent_identifier', inputs: [], parameters: {} }],
          },
        ],
      },
    ])
      expect((await t.call('PUT', `${BASE}/op/op`, changed)).status).toBe(400);
    expect((await t.read('op')).configured).toBe(false);
  });

  it('makes read-only routes inspectable and denies save before step-up or persistence', async () => {
    const t = await fixture();
    const cookie = signIn(t.db, [{ role: 'role_ar_viewer', scope: 'tenant' }]).cookie;
    expect((await t.authorityCall(cookie, 'GET', `${BASE}/op/op`)).status).toBe(200);
    const before = await t.read('op');
    const response = await t.authorityCall(
      cookie,
      'PUT',
      `${BASE}/op/op`,
      t.draft('op', before.revision),
      { 'Idempotency-Key': crypto.randomUUID() }
    );
    expect(response.status).toBe(403);
    expect(seams.stepUp).not.toHaveBeenCalled();
  });

  it('keeps pinned saved graphs from resolving for another tenant or direction', async () => {
    const t = await fixture();
    const before = await t.read('op');
    await t.call('PUT', `${BASE}/op/op`, t.draft('op', before.revision));
    const row = await t.core.adapter.queryOne<{ provider_quirks: string }>(
      "SELECT provider_quirks FROM upstream_providers WHERE id='op'"
    );
    const binding = z
      .object({ inboundIdentityMapping: selector })
      .parse(JSON.parse(row?.provider_quirks ?? '{}')).inboundIdentityMapping;
    expect(
      await resolveRuntimeIdentityMappingBinding(t.adapter, {
        tenantId: 'other-tenant',
        protocol: 'oidc',
        role: 'rp',
        providerId: 'op',
        ...binding,
      })
    ).toBeNull();
    expect(
      await resolveRuntimeIdentityMappingBinding(t.adapter, {
        tenantId: TENANT,
        protocol: 'oidc',
        role: 'op',
        providerId: 'op',
        ...binding,
      })
    ).toBeNull();
    expect(
      await resolveRuntimeIdentityMappingBinding(t.adapter, {
        tenantId: TENANT,
        protocol: 'oidc',
        role: 'rp',
        providerId: 'another-op',
        ...binding,
      })
    ).toBeNull();
  });
  it('keeps a concurrent provider edit and removes the new active set after a failed binding CAS', async () => {
    const t = await fixture();
    const before = await t.read('idp');
    const execute = t.core.adapter.execute.bind(t.core.adapter);
    let interleaved = false;
    t.core.adapter.execute = async (sql, params) => {
      if (!interleaved && sql.includes('UPDATE identity_providers SET config_json')) {
        interleaved = true;
        t.core.db
          .prepare(
            "UPDATE identity_providers SET config_json = json_set(config_json, '$.profileUpdateFields', json('[\"name\"]')), updated_at = updated_at + 1 WHERE id='idp'"
          )
          .run();
      }
      return execute(sql, params);
    };
    const response = await t.call('PUT', `${BASE}/idp/idp`, t.draft('idp', before.revision));
    expect(response.status, JSON.stringify(response.json)).toBe(409);
    expect((await t.read('idp')).configured).toBe(false);
    expect(
      await t.adapter.query('SELECT id FROM field_mapping_activations WHERE lifecycle_state = ?', [
        'active',
      ])
    ).toEqual([]);
    const row = await t.core.adapter.queryOne<{ config_json: string }>(
      "SELECT config_json FROM identity_providers WHERE id='idp'"
    );
    expect(
      z
        .object({ profileUpdateFields: z.array(z.string()) })
        .parse(JSON.parse(row?.config_json ?? '{}')).profileUpdateFields
    ).toEqual(['name']);
  });

  it('does not mutate before step-up and refuses a changed-body idempotency replay', async () => {
    const t = await fixture();
    const before = await t.read('op');
    const draft = t.draft('op', before.revision);
    const key = crypto.randomUUID();
    seams.stepUp.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
    );
    expect((await t.call('PUT', `${BASE}/op/op`, draft, key)).status).toBe(403);
    expect((await t.read('op')).configured).toBe(false);
    const saved = await t.call('PUT', `${BASE}/op/op`, draft, key);
    expect(saved.status).toBe(200);
    expect(
      (await t.call('PUT', `${BASE}/op/op`, { ...draft, revision: 'another-revision' }, key)).status
    ).toBe(409);
  });
  it('does not fall back to the legacy SAML projection if a saved incoming contract is invalidated', async () => {
    const t = await fixture();
    const before = await t.read('idp');
    expect((await t.call('PUT', `${BASE}/idp/idp`, t.draft('idp', before.revision))).status).toBe(
      200
    );
    t.db
      .prepare(
        "UPDATE field_mapping_activations SET activation_scope_json = json_remove(activation_scope_json, '$.inboundContract') WHERE lifecycle_state='active'"
      )
      .run();
    expect((await t.call('GET', `${BASE}/idp/idp`)).status).toBe(409);
    expect((await t.call('GET', '/runtime/saml')).status).toBe(500);
  });
});
