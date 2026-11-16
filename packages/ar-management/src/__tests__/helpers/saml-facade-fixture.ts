import { expect, vi } from 'vitest';
import { z } from 'zod';
import { adminAuthMiddleware, type DatabaseAdapter, type SAMLSPConfig } from '@authrim/ar-lib-core';
import { validateSAMLSPReleaseBinding } from '@authrim/ar-saml/release-explain';
import { IdentityMappingControlPlaneRepository } from '../../identity-mapping-control-plane';
import {
  adminIdentityMappingSetCreateHandler,
  adminIdentityMappingSetPutHandler,
  adminIdentityMappingSetGetHandler,
  adminIdentityMappingSetDeleteHandler,
} from '../../identity-mapping-set-facade';
import { adminIdentityMappingSetChangePreviewHandler } from '../../identity-mapping-set-change-preview';
import { adminIdentityMappingExplainHandler } from '../../identity-mapping-explain';
import {
  setupApp,
  signIn,
  sqliteAdapter,
  TENANT,
  TENANT_SUPER_ADMIN,
} from './admin-authority-fixture';
import { insertTenant, openCoreDatabase } from './core-database';
import { seedDestinationProfile } from './identity-mapping-seed';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: vi.fn(async () => undefined),
    createAuthContextFromHono: (c: { env: { DB_CORE: DatabaseAdapter } }) => ({
      coreAdapter: c.env.DB_CORE,
    }),
    resolveAuthCorePersistenceAdapterFromEnv: async (env: { DB_CORE: DatabaseAdapter }) =>
      env.DB_CORE,
  };
});

export const SETS = '/api/admin/identity-mapping/sets';
const savedSet = z.object({ id: z.string(), version_id: z.string() });
export async function setup() {
  const core = openCoreDatabase();
  insertTenant(core, TENANT);
  const settings = { get: vi.fn(async (_key: string): Promise<string | null> => null) };
  const envExtras = {
    DB_CORE: sqliteAdapter(core),
    DB: sqliteAdapter(core),
    SETTINGS: settings,
    AUTHRIM_CONFIG: settings,
    ISSUER_URL: 'https://idp.example.test',
  };
  let bindingConfig: SAMLSPConfig | undefined;
  const t = setupApp((app) => {
    app.post('/api/admin/check-saml-binding', async (c) => {
      if (!bindingConfig) return c.json({ error: 'missing_fixture' }, 400);
      return c.json({ result: await validateSAMLSPReleaseBinding(c.env, TENANT, bindingConfig) });
    });
    app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
    app.post(SETS, adminIdentityMappingSetCreateHandler);
    app.put(`${SETS}/:id`, adminIdentityMappingSetPutHandler);
    app.get(`${SETS}/:id`, adminIdentityMappingSetGetHandler);
    app.delete(`${SETS}/:id`, adminIdentityMappingSetDeleteHandler);
    app.post(`${SETS}/:id/preview-change`, adminIdentityMappingSetChangePreviewHandler);
    app.post('/api/admin/identity-mapping/explain', adminIdentityMappingExplainHandler);
  }, envExtras);
  const repository = new IdentityMappingControlPlaneRepository(t.adapter);
  const catalog = await repository.createCatalog(TENANT, {
    catalogKey: 'saml-catalog',
    displayName: 'SAML catalog',
    versionLabel: 'v1',
    entries: ['email', 'nickname'].map((path) => ({
      id: `field.${path}`,
      namespace: 'authrim.profile',
      path,
      targetType: 'canonical',
      valueType: 'string',
      cardinality: 'single',
      classification: 'internal',
    })),
  });
  seedDestinationProfile(t.db, {
    owner: TENANT,
    id: 'saml-profile',
    destinationType: 'saml',
    attributes: ['mail', 'subject', 'optional'],
  });
  seedDestinationProfile(t.db, {
    owner: TENANT,
    id: 'saml-other',
    destinationType: 'saml',
    attributes: ['mail', 'subject', 'optional'],
  });
  for (const profileId of ['saml-profile', 'saml-other']) {
    t.db
      .prepare(
        "UPDATE destination_profile_versions SET schema_json = json_set(schema_json, '$.nameId', json(?)) WHERE profile_id = ?"
      )
      .run(
        JSON.stringify({
          format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          classification: 'internal',
        }),
        profileId
      );
  }
  seedDestinationProfile(t.db, { owner: TENANT, id: 'oidc-profile' });
  const cookie = signIn(t.db, TENANT_SUPER_ADMIN).cookie;
  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    t.call(cookie, method, path, body, headers);
  const target = (path: string, namespace = 'saml.attribute', profileId = 'saml-profile') => ({
    side: 'destination',
    profileId,
    namespace,
    path,
  });
  const copy = (
    path: string,
    source = 'email',
    namespace = 'saml.attribute',
    profileId = 'saml-profile'
  ) => ({
    ruleKey: `rule-${path}`,
    ruleKind: 'direct',
    action: 'allow',
    targetRef: target(path, namespace, profileId),
    edges: [
      {
        sourceRef: { side: 'source', namespace: 'authrim.profile', path: source },
        targetRef: target(path, namespace, profileId),
      },
    ],
    output: { edgeIndex: 0 },
  });
  const content = (
    rules: unknown[] = [copy('mail'), copy('subject', 'nickname', 'saml.nameid')]
  ) => ({ catalogVersionId: catalog.activeVersion.id, rules });
  const setKey = crypto.randomUUID();
  const body = (draft: unknown = content(), extra = {}) => ({
    display_name: 'Shared SAML',
    field_mapping_key: setKey,
    content: draft,
    ...extra,
  });
  const create = async (draft: unknown = content()) => {
    const result = await call('POST', SETS, body(draft));
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    return savedSet.parse(result.json);
  };
  const config = (setId: string, entityId = 'https://sp.example.test'): SAMLSPConfig => ({
    entityId,
    acsUrl: `${entityId}/acs`,
    certificate: '',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    attributeMapping: {},
    signAssertions: true,
    signResponses: false,
    allowedBindings: ['post'],
    identityMapping: {
      fieldMappingSetId: setId,
      destinationFieldPolicies: { mail: 'required', subject: 'hidden', optional: 'hidden' },
    },
  });
  const bind = (setId: string, id: string) => {
    const sp = config(setId, `https://${id}.example.test`);
    core
      .prepare(
        `INSERT INTO identity_providers (id, tenant_id, name, provider_type, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 'saml_sp', ?, 1, 1, 1)`
      )
      .run(id, TENANT, id, JSON.stringify(sp));
    return sp;
  };
  t.db
    .prepare(
      `INSERT INTO identity_mapping_test_users
    (tenant_id, id, label, attributes_json, position, created_at, updated_at)
    VALUES (?, 'tu_saml', 'SAML fixture', ?, 0, 1, 1)`
    )
    .run(TENANT, JSON.stringify({ email: 'fixture@example.test', nickname: 'legacy-subject' }));
  const explain = (sp: SAMLSPConfig, consent = 'all') =>
    call('POST', '/api/admin/identity-mapping/explain', {
      sp_entity_id: sp.entityId,
      subject: { kind: 'test_user', id: 'tu_saml' },
      consent,
    });
  const validate = async (value: SAMLSPConfig) => {
    bindingConfig = value;
    return z.unknown().parse((await call('POST', '/api/admin/check-saml-binding')).json.result);
  };
  const identifier = (path: string, namespace = 'saml.nameid', parameters = {}) => ({
    ruleKey: `identifier-${path}`,
    ruleKind: 'direct',
    action: 'allow',
    targetRef: target(path, namespace),
    edges: [],
    transforms: [
      {
        operation: 'persistent_identifier',
        inputs: [],
        parameters: {
          input: 'account',
          algorithm: 'shibboleth',
          format: 'plain',
          audience: 'sp_entity_id',
          ...parameters,
        },
      },
    ],
    output: { stepIndex: 0 },
  });
  return {
    ...t,
    callAs: t.call,
    settings,
    core,
    call,
    repository,
    validate,
    identifier,
    copy,
    target,
    content,
    body,
    create,
    config,
    bind,
    explain,
  };
}
