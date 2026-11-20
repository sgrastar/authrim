import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { generateSelfSignedCertificate } from '../../common/key-utils';
import { applySAMLAssertionEncryptionPolicy } from '../../idp/encryption';
import {
  ADMIN_PERMISSIONS,
  type Env,
  type SAMLIdPConfig,
  type SAMLSPConfig,
} from '@authrim/ar-lib-core';
import { handleSPLogin } from '../../sp/login';
import { hasApprovedSAMLProviderTrust } from '../provider-trust';
import { NAMEID_FORMATS } from '../../common/constants';
import { PRODUCTION_INPUT_EDGES } from '../../idp/__fixtures__/production-shaped-mapping';
import type { FieldCatalogBundle } from '@authrim/ar-lib-field-mapping/contract';

// Binding resolution is mocked below; its selected set belongs to the calling tenant.
vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async () => undefined),
  logError: vi.fn(),
  safeFetchText: vi.fn(),
  safeFetch: vi.fn(),
  refreshFederationSource: vi.fn(),
  runtimeBinding: {
    fieldMappingSetId: 'saml-sp',
    fieldMappingVersionId: 'version-1',
    destinationProfileId: 'destination-profile-saml',
    destinationProfileIds: ['destination-profile-saml'],
  } as Record<string, unknown> | null,
  destinationDescriptor: {
    profileId: 'destination-profile-saml',
    profileVersionId: 'destination-profile-saml-v1',
    destinationType: 'saml',
    fields: [{ key: 'mail' }, { key: 'displayName' }, { key: 'eduPersonAffiliation' }],
  } as Record<string, unknown> | null,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => mocks.runtimeBinding),
    loadDestinationProfileConsentDescriptor: vi.fn(async () => mocks.destinationDescriptor),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    safeFetchText: mocks.safeFetchText,
    safeFetch: mocks.safeFetch,
    listEnvironmentTenantDefaultStores: vi.fn(async () => [{ tenantId: 'tenant-a' }]),
    bumpAuthenticationMethodsCacheRevision: vi.fn(async () => undefined),
    readLiteModeAuthoritative: vi.fn(async () => 'off'),
    verifyHumanVerificationWithRunner: vi.fn(async () => ({ verified: true })),
    readExternalProviderUsagePolicy: vi.fn(async () => ({
      loginEnabled: true,
      signupEnabled: true,
    })),
    getUIConfig: vi.fn(async () => null),
    getLogger: () => ({
      module: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

vi.mock('../metadata-polling', () => ({
  refreshFederationMetadataSource: mocks.refreshFederationSource,
}));

import {
  getIdPConfig,
  getIdPConfigByEntityId,
  getIdPUsageKeyByEntityId,
  getSPConfig,
  handleCreateAttributePreset,
  handleCreateProvider,
  handleDeleteAttributePreset,
  handleDeleteProvider,
  handleGetProvider,
  handleImportMetadata,
  handlePreviewMetadata,
  handleListAttributePresets,
  handleListProviders,
  handleRefreshMetadata,
  handleRefreshFederationMetadataSource,
  handlePromoteSigningNext,
  handlePublishSigningNext,
  handleRetireSigningBackup,
  handleUpdateProvider,
  listIdPConfigs,
  listSPConfigs,
} from '../providers';

function createAdapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
}

function context(
  options: {
    body?: unknown;
    rawRequest?: Request;
    id?: string;
    permissions?: string[] | null;
    tenantId?: string;
    federation?: Record<string, unknown>;
  } = {}
): Parameters<typeof handleCreateProvider>[0] {
  return {
    env: options.federation
      ? {
          SETTINGS: {
            get: vi.fn(async (key: string) =>
              key === `settings:tenant:${options.tenantId ?? 'tenant-a'}:federation`
                ? JSON.stringify(options.federation)
                : null
            ),
          },
        }
      : {},
    req: {
      raw: options.rawRequest,
      json: vi.fn(async () => options.body),
      param: vi.fn((name: string) => (name === 'id' ? options.id : undefined)),
      header: vi.fn((name: string) =>
        options.body !== undefined && name.toLowerCase() === 'content-type'
          ? 'application/json'
          : undefined
      ),
    },
    get: vi.fn((name: string) => {
      if (name === 'tenantId') return options.tenantId ?? 'tenant-a';
      if (name === 'adminAuth') {
        return options.permissions === null
          ? undefined
          : { permissions: options.permissions ?? Object.values(ADMIN_PERMISSIONS) };
      }
      return undefined;
    }),
    json: vi.fn(
      (body: unknown, status: number = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
  } as never;
}

/** The config_json of the provider row the last create wrote. */
function persistedConfig(): Record<string, unknown> {
  const calls = (mocks.adapter as unknown as { execute: { mock: { calls: unknown[][] } } }).execute
    .mock.calls;
  return JSON.parse(String((calls[0]?.[1] as unknown[])[4])) as Record<string, unknown>;
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-a',
    name: 'Provider A',
    provider_type: 'saml_sp',
    config_json: JSON.stringify({
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      allowedBindings: ['post'],
      identityMapping: {
        fieldMappingSetId: 'saml-sp',
        destinationFieldPolicies: {
          mail: 'optional',
          displayName: 'optional',
          eduPersonAffiliation: 'optional',
        },
      },
    }),
    enabled: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
    ...overrides,
  };
}

async function responseBody<T>(response: Response): Promise<T> {
  return await response.json();
}

describe('SAML provider CRUD boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = createAdapter();
    mocks.safeFetchText.mockReset();
    mocks.safeFetch.mockReset();
    mocks.refreshFederationSource.mockReset();
    mocks.runtimeBinding = {
      fieldMappingSetId: 'saml-sp',
      fieldMappingVersionId: 'version-1',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    };
    mocks.destinationDescriptor = {
      profileId: 'destination-profile-saml',
      profileVersionId: 'destination-profile-saml-v1',
      destinationType: 'saml',
      fields: [{ key: 'mail' }, { key: 'displayName' }, { key: 'eduPersonAffiliation' }],
    };
  });

  it.each(['saml_sp', 'saml_idp'])(
    'creates an empty disabled %s draft and refuses enabling it',
    async (providerType) => {
      const created = await handleCreateProvider(
        context({ body: { name: 'Draft', providerType, enabled: false } })
      );
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ enabled: false, config: {} });
      expect(persistedConfig()).toEqual({});
      mocks.adapter!.queryOne.mockResolvedValue(
        providerRow({ provider_type: providerType, enabled: 0, config_json: '{}' })
      );
      const read = await handleGetProvider(context({ id: 'provider-a' }));
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ providerType, enabled: false });
      mocks.adapter!.query.mockResolvedValue([
        providerRow({ provider_type: providerType, enabled: 0, config_json: '{}' }),
      ]);
      const listed = await handleListProviders(context());
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ providers: [{ providerType, enabled: false }] });
      mocks.adapter!.query.mockResolvedValue([]);
      const refused = await handleUpdateProvider(
        context({
          id: 'provider-a',
          body: { enabled: true, expectedUpdatedAt: new Date(1_700_000_001_000).toISOString() },
        })
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: 'saml_configuration_required_to_enable',
      });
    }
  );

  it('fills an SP draft and enables it after its configuration and mapping are saved', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ enabled: 0, config_json: '{}' }));
    const completed = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies: {
                mail: 'optional',
                displayName: 'optional',
                eduPersonAffiliation: 'optional',
              },
            },
          },
        },
      })
    );
    expect(completed.status).toBe(200);
    const saved = await responseBody<{ config: Record<string, unknown>; updatedAt: string }>(
      completed
    );
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        enabled: 0,
        config_json: JSON.stringify(saved.config),
        updated_at: Date.parse(saved.updatedAt),
      })
    );
    const enabled = await handleUpdateProvider(
      context({ id: 'provider-a', body: { enabled: true, expectedUpdatedAt: saved.updatedAt } })
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ enabled: true });
  });

  it.each(['saml_sp', 'saml_idp'])(
    'imports metadata into a %s draft before enabling it',
    async (providerType) => {
      mocks.adapter!.queryOne.mockResolvedValue(
        providerRow({ provider_type: providerType, enabled: 0, config_json: '{}' })
      );
      const metadataXml =
        providerType === 'saml_sp'
          ? validSpMetadata()
          : `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:synthetic:idp"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>VEVTVA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/sso" /></md:IDPSSODescriptor></md:EntityDescriptor>`;
      const imported = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: { metadataXml, expectedUpdatedAt: new Date(1_700_000_001_000).toISOString() },
        })
      );
      expect(imported.status).toBe(200);
      const saved = await responseBody<{
        config: Record<string, unknown>;
        updatedAt: string;
        enabled: boolean;
      }>(imported);
      expect(saved.enabled).toBe(false);
      expect(saved.config.entityId).toBeTruthy();
      mocks.adapter!.queryOne.mockResolvedValue(
        providerRow({
          provider_type: providerType,
          enabled: 0,
          config_json: JSON.stringify(saved.config),
          updated_at: Date.parse(saved.updatedAt),
        })
      );
      const enabled = await handleUpdateProvider(
        context({
          id: 'provider-a',
          body: {
            enabled: true,
            expectedUpdatedAt: saved.updatedAt,
            config: {
              identityMapping: {
                fieldMappingSetId: 'saml-sp',
                destinationFieldPolicies: {
                  mail: 'optional',
                  displayName: 'optional',
                  eduPersonAffiliation: 'optional',
                },
              },
              ...(providerType === 'saml_idp'
                ? { jitEmailLinkingPolicy: 'disabled', allowSyntheticEmailFallback: false }
                : {}),
            },
          },
        })
      );
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ enabled: true });
    }
  );

  it('does not resolve disabled drafts with an absent or empty entity ID', async () => {
    mocks.adapter!.query.mockResolvedValue([{ config_json: '{}', enabled: 0 }]);
    expect(await getSPConfig(context().env, 'tenant-a', '')).toBeNull();
    expect(await getIdPConfigByEntityId(context().env, 'tenant-a', '')).toBeNull();
  });

  it.each(['disabled', 'jit_create_only', 'email_linking'])(
    'preserves the explicit %s IdP linking policy from draft creation through import and enable',
    async (jitEmailLinkingPolicy) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing adapter');
      const created = await handleCreateProvider(
        context({
          body: {
            name: 'Deferred IdP',
            providerType: 'saml_idp',
            enabled: false,
            config: { jitEmailLinkingPolicy, allowSyntheticEmailFallback: false },
          },
        })
      );
      expect(created.status).toBe(201);
      const draft = await responseBody<{ config: SAMLIdPConfig; updatedAt: string }>(created);
      expect(draft.config).toMatchObject({
        jitEmailLinkingPolicy,
        allowSyntheticEmailFallback: false,
      });
      expect(persistedConfig()).toMatchObject({
        jitEmailLinkingPolicy,
        allowSyntheticEmailFallback: false,
      });
      expect(draft.config).not.toHaveProperty('nameIdFormat');
      expect(persistedConfig()).not.toHaveProperty('nameIdFormat');
      adapter.queryOne.mockResolvedValue(
        providerRow({
          provider_type: 'saml_idp',
          enabled: 0,
          config_json: JSON.stringify(draft.config),
          updated_at: Date.parse(draft.updatedAt),
        })
      );
      const edited = await handleUpdateProvider(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: draft.updatedAt,
            name: 'Deferred IdP renamed',
            config: { entityId: 'urn:imported:idp' },
          },
        })
      );
      expect(edited.status).toBe(200);
      const incomplete = await responseBody<{ config: SAMLIdPConfig; updatedAt: string }>(edited);
      expect(incomplete.config).not.toHaveProperty('nameIdFormat');
      const updateParameters: unknown = adapter.execute.mock.calls.at(-1)?.[1];
      if (!Array.isArray(updateParameters)) throw new Error('Missing draft update');
      expect(JSON.parse(String(updateParameters[1]))).not.toHaveProperty('nameIdFormat');
      adapter.queryOne.mockResolvedValue(
        providerRow({
          provider_type: 'saml_idp',
          enabled: 0,
          config_json: JSON.stringify(incomplete.config),
          updated_at: Date.parse(incomplete.updatedAt),
        })
      );
      const imported = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: incomplete.updatedAt,
            metadataXml: validIdpMetadata('VEVTVA==', NAMEID_FORMATS.PERSISTENT),
          },
        })
      );
      expect(imported.status).toBe(200);
      const complete = await responseBody<{ config: SAMLIdPConfig; updatedAt: string }>(imported);
      expect(complete.config).toMatchObject({
        nameIdFormat: NAMEID_FORMATS.PERSISTENT,
        jitEmailLinkingPolicy,
        allowSyntheticEmailFallback: false,
      });
      adapter.queryOne.mockResolvedValue(
        providerRow({
          provider_type: 'saml_idp',
          enabled: 0,
          config_json: JSON.stringify(complete.config),
          updated_at: Date.parse(complete.updatedAt),
        })
      );
      const enabled = await handleUpdateProvider(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: complete.updatedAt,
            enabled: true,
            config: { identityMapping: { fieldMappingSetId: 'saml-sp' } },
          },
        })
      );
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({
        enabled: true,
        config: {
          jitEmailLinkingPolicy,
          allowSyntheticEmailFallback: false,
          allowedBindings: ['post'],
          nameIdFormat: NAMEID_FORMATS.PERSISTENT,
        },
      });
    }
  );

  it('preserves an explicit draft NameID format when the first metadata import names another', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    const created = await handleCreateProvider(
      context({
        body: {
          name: 'Explicit NameID choice',
          providerType: 'saml_idp',
          enabled: false,
          config: { jitEmailLinkingPolicy: 'disabled', nameIdFormat: NAMEID_FORMATS.EMAIL },
        },
      })
    );
    expect(created.status).toBe(201);
    const draft = await responseBody<{ config: SAMLIdPConfig; updatedAt: string }>(created);
    expect(persistedConfig().nameIdFormat).toBe(NAMEID_FORMATS.EMAIL);
    adapter.queryOne.mockResolvedValue(
      providerRow({
        provider_type: 'saml_idp',
        enabled: 0,
        config_json: JSON.stringify(draft.config),
        updated_at: Date.parse(draft.updatedAt),
      })
    );
    const imported = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: draft.updatedAt,
          metadataXml: validIdpMetadata('VEVTVA==', NAMEID_FORMATS.PERSISTENT),
        },
      })
    );
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      config: { nameIdFormat: NAMEID_FORMATS.EMAIL, jitEmailLinkingPolicy: 'disabled' },
    });
  });

  it.each(['complete-and-enable', 'complete-then-enable', 'enable-legacy-manual'])(
    'fills IdP defaults through %s and starts SP-initiated SSO',
    async (operation) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing adapter');
      const federation = {
        'federation.saml_sso_binding': 'HTTP-POST',
        'federation.saml_nameid_format': 'persistent',
      };
      const created = await handleCreateProvider(
        context({
          federation,
          body: { name: 'Manual draft', providerType: 'saml_idp', enabled: false },
        })
      );
      expect(created.status).toBe(201);
      const draft = await responseBody<{ config: SAMLIdPConfig; updatedAt: string }>(created);
      expect(draft.config).toEqual({});
      const signingKey = await generateKeyPair('RS256', { extractable: true });
      const certificate = await generateSelfSignedCertificate(
        await exportJWK(signingKey.publicKey),
        await exportPKCS8(signingKey.privateKey)
      );
      const manualConfig = {
        entityId: 'urn:manual:idp',
        ssoUrl: 'https://idp.example.test/sso',
        certificate,
        jitEmailLinkingPolicy: 'disabled',
        allowSyntheticEmailFallback: false,
        identityMapping: { fieldMappingSetId: 'saml-sp' },
      };
      adapter.queryOne.mockResolvedValue(
        providerRow({
          provider_type: 'saml_idp',
          enabled: 0,
          config_json: JSON.stringify(
            operation === 'enable-legacy-manual' ? manualConfig : draft.config
          ),
          updated_at: Date.parse(draft.updatedAt),
        })
      );
      const completed = await handleUpdateProvider(
        context({
          id: 'provider-a',
          federation,
          body: {
            expectedUpdatedAt: draft.updatedAt,
            ...(operation !== 'enable-legacy-manual' ? { config: manualConfig } : {}),
            enabled: operation !== 'complete-then-enable',
          },
        })
      );
      expect(completed.status).toBe(200);
      let saved = await responseBody<{
        config: SAMLIdPConfig;
        enabled: boolean;
        updatedAt: string;
      }>(completed);
      if (operation === 'complete-then-enable') {
        expect(saved.enabled).toBe(false);
        adapter.queryOne.mockResolvedValue(
          providerRow({
            provider_type: 'saml_idp',
            enabled: 0,
            config_json: JSON.stringify(saved.config),
            updated_at: Date.parse(saved.updatedAt),
          })
        );
        const enabled = await handleUpdateProvider(
          context({
            id: 'provider-a',
            federation,
            body: { expectedUpdatedAt: saved.updatedAt, enabled: true },
          })
        );
        expect(enabled.status).toBe(200);
        saved = await responseBody(enabled);
      }
      expect(saved.enabled).toBe(true);
      const parameters: unknown = adapter.execute.mock.calls.at(-1)?.[1];
      if (!Array.isArray(parameters) || typeof parameters[1] !== 'string')
        throw new Error('Missing persisted IdP configuration');
      const configJson = parameters[1];
      expect(JSON.parse(configJson)).toEqual(saved.config);
      adapter.queryOne.mockResolvedValue(
        providerRow({
          provider_type: 'saml_idp',
          enabled: 1,
          config_json: configJson,
          updated_at: Date.parse(saved.updatedAt),
        })
      );
      const storeRequest = vi.fn(async (_url: string, _init: RequestInit) => new Response('OK'));
      const env = Object.assign(context({ federation }).env, {
        ISSUER_URL: 'https://auth.example.test',
        SAML_REQUEST_STORE: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ fetch: storeRequest })),
        },
      });
      const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
      app.use('*', async (c, next) => {
        c.set('tenantId', 'tenant-a');
        await next();
      });
      app.get('/saml/sp/login', handleSPLogin);
      const response = await app.request('/saml/sp/login?idp=provider-a', {}, env);
      expect(
        mocks.logError.mock.calls.map((call) =>
          call[2] instanceof Error ? call[2].message : 'Unknown error'
        )
      ).toEqual([]);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('name="SAMLRequest"');
      expect(html).toContain('action="https://idp.example.test/sso"');
      expect(storeRequest).toHaveBeenCalledOnce();
      expect(saved.config).toMatchObject({
        allowedBindings: ['post'],
        nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        jitEmailLinkingPolicy: 'disabled',
        allowSyntheticEmailFallback: false,
      });
    }
  );

  it('unwraps a single entity and returns its detected role even when the hint differs', async () => {
    const response = await handlePreviewMetadata(
      context({ body: { providerType: 'saml_idp', metadataXml: aggregateMetadata() } })
    );
    expect(response.status).toBe(200);
    const body = await responseBody<{ config: { metadataXml: string } }>(response);
    expect(body).toMatchObject({ kind: 'single', providerType: 'saml_sp' });
    expect(body.config.metadataXml).not.toContain('EntitiesDescriptor');
  });

  it('distinguishes fetch failures from invalid XML without exposing fetch details', async () => {
    mocks.safeFetchText.mockRejectedValue(new Error('private network detail'));
    const fetched = await handlePreviewMetadata(
      context({
        body: { providerType: 'saml_sp', metadataUrl: 'https://metadata.example.test/sp.xml' },
      })
    );
    expect(fetched.status).toBe(400);
    expect(await fetched.json()).toMatchObject({ error_description: 'metadata_fetch_failed' });
    const invalid = await handlePreviewMetadata(
      context({ body: { providerType: 'saml_sp', metadataXml: '<broken' } })
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error_description: 'metadata_invalid_xml' });
  });

  it('requires authentication and the specific admin permission', async () => {
    let response = await handleListProviders(context({ permissions: null }));
    expect(response.status).toBe(401);

    response = await handleListProviders(context({ permissions: [] }));
    expect(response.status).toBe(403);
  });

  it('lists tenant-scoped providers and maps persisted values', async () => {
    mocks.adapter!.query.mockResolvedValue([
      providerRow(),
      providerRow({ id: 'disabled', enabled: 0, name: 'Disabled' }),
    ]);
    const response = await handleListProviders(context());
    expect(response.status).toBe(200);
    const body = await responseBody<{
      providers: Array<{ enabled: boolean; providerType: string }>;
    }>(response);
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]).toMatchObject({ enabled: true, providerType: 'saml_sp' });
    expect(body.providers[1].enabled).toBe(false);
    expect(mocks.adapter!.query).toHaveBeenCalledWith(expect.any(String), ['tenant-a']);
  });

  it('maps malformed persisted provider state to an internal error', async () => {
    mocks.adapter!.query.mockResolvedValue([providerRow({ config_json: '{' })]);
    expect((await handleListProviders(context())).status).toBe(500);

    mocks.adapter!.query.mockRejectedValue(new Error('database unavailable'));
    expect((await handleListProviders(context())).status).toBe(500);
  });

  it('lists built-in and custom presets and tolerates an unavailable custom table', async () => {
    mocks.adapter!.query.mockResolvedValue([
      {
        id: 'custom:a',
        label: 'Custom',
        description: null,
        applies_to: 'sp_attribute_release',
        profile: 'custom',
        stability: 'custom',
        application_mode: 'clone_edit',
        attribute_release_policy_json: JSON.stringify({ attributes: [{ name: 'mail' }] }),
        updated_at: 123,
      },
    ]);
    let response = await handleListAttributePresets(context());
    expect(response.status).toBe(200);
    expect(
      (await responseBody<{ presets: Array<{ id: string }> }>(response)).presets.some(
        (preset) => preset.id === 'custom:a'
      )
    ).toBe(true);

    mocks.adapter!.query.mockRejectedValue(new Error('table missing'));
    response = await handleListAttributePresets(context());
    expect(response.status).toBe(200);
    expect((await responseBody<{ presets: unknown[] }>(response)).presets.length).toBeGreaterThan(
      0
    );
  });

  it('validates custom preset content before writing', async () => {
    let response = await handleCreateAttributePreset(context({ body: {} }));
    expect(response.status).toBe(400);

    response = await handleCreateAttributePreset(
      context({ body: { label: 'Preset', attributeReleasePolicy: { attributes: [{}] } } })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('creates and trims a valid custom preset', async () => {
    const response = await handleCreateAttributePreset(
      context({
        body: {
          label: '  Preset  ',
          description: '  Description  ',
          profile: '',
          attributeReleasePolicy: {
            attributes: [{ name: 'mail', source: 'email', required: true }],
          },
        },
      })
    );
    expect(response.status).toBe(201);
    expect(
      (await responseBody<{ preset: Record<string, unknown> }>(response)).preset
    ).toMatchObject({
      label: 'Preset',
      description: 'Description',
      profile: 'custom',
    });
    expect(mocks.adapter!.execute).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('rejects deletion of built-ins and reports missing custom presets', async () => {
    expect((await handleDeleteAttributePreset(context({ id: 'builtin' }))).status).toBe(400);
    mocks.adapter!.execute.mockResolvedValue({ rowsAffected: 0, insertId: undefined });
    expect((await handleDeleteAttributePreset(context({ id: 'custom:missing' }))).status).toBe(404);
  });

  it('deletes tenant-scoped custom presets and handles storage failure', async () => {
    let response = await handleDeleteAttributePreset(context({ id: 'custom:a' }));
    expect(response.status).toBe(200);
    expect(mocks.audit).toHaveBeenCalled();

    mocks.adapter!.execute.mockRejectedValue(new Error('database unavailable'));
    response = await handleDeleteAttributePreset(context({ id: 'custom:a' }));
    expect(response.status).toBe(500);
  });

  it.each([
    [{}, 400],
    [{ name: 'X', providerType: 'oidc', config: {} }, 400],
    [{ name: 'X', providerType: 'saml_idp', config: {} }, 400],
    [{ name: 'X', providerType: 'saml_sp', config: { entityId: 'sp' } }, 400],
  ])('validates provider creation input', async (body, status) => {
    const response = await handleCreateProvider(context({ body }));
    expect(response.status).toBe(status);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      'saml_sp',
      {
        entityId: 'https://sp.example.test',
        acsUrl: 'https://sp.example.test/acs',
        allowedBindings: ['post'],
        identityMapping: {
          fieldMappingSetId: 'saml-sp',
          destinationFieldPolicies: {
            mail: 'optional',
            displayName: 'optional',
            eduPersonAffiliation: 'optional',
          },
        },
      },
      true,
    ],
    [
      'saml_idp',
      {
        entityId: 'https://idp.example.test',
        ssoUrl: 'https://idp.example.test/sso',
        certificate: 'not-a-certificate',
        identityMapping: { fieldMappingSetId: 'saml-idp' },
      },
      false,
    ],
  ] as const)('creates normalized %s configuration', async (providerType, config, enabled) => {
    const response = await handleCreateProvider(
      context({ body: { name: 'Provider', providerType, config, enabled } })
    );
    expect(response.status).toBe(201);
    expect((await responseBody<{ enabled: boolean }>(response)).enabled).toBe(enabled);
    expect(mocks.adapter!.execute).toHaveBeenCalled();
    if (providerType === 'saml_sp') {
      const persistedConfig = JSON.parse(String(mocks.adapter!.execute.mock.calls[0]?.[1]?.[4]));
      expect(persistedConfig).toMatchObject({
        signAssertions: false,
        signResponses: true,
      });
    }
  });

  describe('tenant defaults for what a new provider leaves open', () => {
    const idpWithoutChoices = {
      entityId: 'https://idp.example.test',
      ssoUrl: 'https://idp.example.test/sso',
      certificate: 'not-a-certificate',
      identityMapping: { fieldMappingSetId: 'saml-idp' },
    };
    const spWithLogout = {
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      sloUrl: 'https://sp.example.test/slo',
      identityMapping: {
        fieldMappingSetId: 'saml-sp',
        destinationFieldPolicies: {
          mail: 'optional',
          displayName: 'optional',
          eduPersonAffiliation: 'optional',
        },
      },
    };

    async function persisted(
      providerType: 'saml_idp' | 'saml_sp',
      config: Record<string, unknown>,
      federation?: Record<string, unknown>
    ) {
      const response = await handleCreateProvider(
        context({ body: { name: 'Provider', providerType, config }, federation })
      );
      expect(response.status).toBe(201);
      return persistedConfig();
    }

    it("gives an identity provider the tenant's NameID format and sign-in binding", async () => {
      expect(
        await persisted('saml_idp', idpWithoutChoices, {
          'federation.saml_nameid_format': 'persistent',
          'federation.saml_sso_binding': 'HTTP-POST',
        })
      ).toMatchObject({
        nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        allowedBindings: ['post'],
      });
    });

    it('gives a service provider the tenant NameID format and logout binding', async () => {
      expect(
        await persisted('saml_sp', spWithLogout, {
          'federation.saml_nameid_format': 'transient',
          'federation.saml_slo_binding': 'HTTP-POST',
        })
      ).toMatchObject({
        nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
        sloBinding: 'post',
      });
    });

    it('gives the behaviour providers always had where the tenant sets nothing', async () => {
      expect(await persisted('saml_idp', idpWithoutChoices)).toMatchObject({
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        allowedBindings: ['redirect'],
      });
      mocks.adapter?.execute.mockClear();
      expect(await persisted('saml_sp', spWithLogout)).toMatchObject({
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sloBinding: 'redirect',
      });
    });

    it('keeps what the request names', async () => {
      expect(
        await persisted(
          'saml_idp',
          {
            ...idpWithoutChoices,
            nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            allowedBindings: ['redirect'],
          },
          {
            'federation.saml_nameid_format': 'persistent',
            'federation.saml_sso_binding': 'HTTP-POST',
          }
        )
      ).toMatchObject({
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        allowedBindings: ['redirect'],
      });
    });

    it('applies the tenant defaults to what imported metadata leaves open', async () => {
      const response = await handleCreateProvider(
        context({
          body: {
            name: 'Provider',
            providerType: 'saml_sp',
            metadataXml: validSpMetadata(),
            config: { identityMapping: spWithLogout.identityMapping },
          },
          federation: { 'federation.saml_nameid_format': 'persistent' },
        })
      );
      expect(response.status).toBe(201);
      expect(persistedConfig()).toMatchObject({
        nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      });
    });

    describe('metadata and an allowedBindings list that disagree', () => {
      const idpXml = (offers: Array<'post' | 'redirect'>) => `<?xml version="1.0"?>
      <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
        xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.test">
        <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
          <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>CERT</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
          ${offers
            .map(
              (kind) =>
                `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-${kind === 'post' ? 'POST' : 'Redirect'}" Location="https://idp.example.test/sso/${kind}" />`
            )
            .join('')}
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>`;
      const create = (offers: Array<'post' | 'redirect'>, allowedBindings: string[]) =>
        handleCreateProvider(
          context({
            body: {
              name: 'IdP',
              providerType: 'saml_idp',
              metadataXml: idpXml(offers),
              config: { identityMapping: { fieldMappingSetId: 'saml-idp' }, allowedBindings },
              enabled: false,
            },
          })
        );

      it('takes an empty list as unspecified, so POST-only metadata is still signed in by POST', async () => {
        const response = await create(['post'], []);
        expect(response.status).toBe(201);
        expect(persistedConfig()).toMatchObject({
          ssoUrl: 'https://idp.example.test/sso/post',
          allowedBindings: ['post'],
        });
      });

      it('narrows the list to what the metadata offers, with the matching URL', async () => {
        const response = await create(['post'], ['post', 'redirect']);
        expect(response.status).toBe(201);
        expect(persistedConfig()).toMatchObject({
          ssoUrl: 'https://idp.example.test/sso/post',
          allowedBindings: ['post'],
        });
      });

      it('refuses a list none of which the metadata offers', async () => {
        const response = await create(['post'], ['redirect']);
        expect(response.status).toBe(400);
        expect(mocks.adapter?.execute).not.toHaveBeenCalled();
      });
    });

    describe('metadata and a requested logout binding that disagree', () => {
      const spXml = (binding: 'POST' | 'Redirect') => `<?xml version="1.0"?>
      <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.test">
        <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
          <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs" index="0" isDefault="true" />
          <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-${binding}" Location="https://sp.example.test/slo" />
        </md:SPSSODescriptor>
      </md:EntityDescriptor>`;
      const create = (metadataBinding: 'POST' | 'Redirect', sloBinding: string) =>
        handleCreateProvider(
          context({
            body: {
              name: 'SP',
              providerType: 'saml_sp',
              metadataXml: spXml(metadataBinding),
              config: { sloBinding, identityMapping: spWithLogout.identityMapping },
            },
          })
        );

      it('accepts the binding the metadata offers', async () => {
        expect((await create('POST', 'post')).status).toBe(201);
        expect(persistedConfig()).toMatchObject({ sloBinding: 'post' });
      });

      it('refuses a binding the metadata does not offer, which would have no matching URL', async () => {
        expect((await create('Redirect', 'post')).status).toBe(400);
        expect(mocks.adapter?.execute).not.toHaveBeenCalled();
      });
    });

    describe('metadata with the binding the request names', () => {
      const bothBindings = `<?xml version="1.0"?>
      <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
        xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.test">
        <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
          <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>CERT</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/sso/post" />
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/sso/redirect" />
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>`;

      async function created(allowedBindings: string[] | undefined, ssoBinding: string) {
        const response = await handleCreateProvider(
          context({
            body: {
              name: 'IdP',
              providerType: 'saml_idp',
              metadataXml: bothBindings,
              config: {
                identityMapping: { fieldMappingSetId: 'saml-idp' },
                ...(allowedBindings ? { allowedBindings } : {}),
              },
              enabled: false,
            },
            federation: { 'federation.saml_sso_binding': ssoBinding },
          })
        );
        expect(response.status).toBe(201);
        return persistedConfig();
      }

      it.each([
        [['redirect'], 'HTTP-POST', 'https://idp.example.test/sso/redirect'],
        [['post'], 'HTTP-Redirect', 'https://idp.example.test/sso/post'],
        [['post', 'redirect'], 'HTTP-POST', 'https://idp.example.test/sso/redirect'],
        [undefined, 'HTTP-POST', 'https://idp.example.test/sso/post'],
        [undefined, 'HTTP-Redirect', 'https://idp.example.test/sso/redirect'],
      ])(
        'with allowedBindings %j and tenant default %s uses %s',
        async (bindings, tenantDefault, url) => {
          const config = await created(bindings, tenantDefault);
          expect(config.ssoUrl).toBe(url);
          // The sign-in then goes through the binding that URL belongs to.
          const allowed = config.allowedBindings as string[];
          expect(allowed.includes('redirect') ? 'redirect' : 'post').toBe(
            url.endsWith('/redirect') ? 'redirect' : 'post'
          );
        }
      );
    });

    it('applies the tenant defaults when metadata is imported into a provider', async () => {
      mocks.adapter?.queryOne.mockResolvedValue(providerRow());
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
            metadataXml: validSpMetadata(),
          },
          federation: { 'federation.saml_nameid_format': 'unspecified' },
        })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        config: { nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified' },
      });
    });
  });

  it('rejects an explicitly unsigned SP configuration', async () => {
    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Unsigned SP',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            signAssertions: false,
            signResponses: false,
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies: {
                mail: 'optional',
                displayName: 'optional',
                eduPersonAffiliation: 'optional',
              },
            },
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('validates and persists per-SP destination field release policies', async () => {
    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            informationReleaseConsent: {
              enabled: true,
              ask: 'every_time',
              show_values: false,
              purpose_statement_id: 'purpose-1',
            },
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationProfileId: 'stale-destination-profile',
              destinationFieldPolicies: {
                ' mail ': 'required',
                displayName: 'optional',
                eduPersonAffiliation: 'hidden',
              },
            },
          },
        },
      })
    );

    expect(response.status).toBe(201);
    const executeArguments = mocks.adapter!.execute.mock.calls[0]?.[1] as unknown[];
    const persistedConfig = JSON.parse(String(executeArguments[4]));
    expect(persistedConfig).toMatchObject({
      informationReleaseConsent: {
        enabled: true,
        ask: 'every_time',
        show_values: false,
        purpose_statement_id: 'purpose-1',
      },
      identityMapping: {
        destinationFieldPolicies: {
          mail: 'required',
          displayName: 'optional',
          eduPersonAffiliation: 'hidden',
        },
      },
    });
    expect(persistedConfig.identityMapping).not.toHaveProperty('destinationProfileId');

    mocks.adapter!.execute.mockClear();
    const invalidResponse = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies: { mail: 'always' },
            },
          },
        },
      })
    );

    expect(invalidResponse.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  describe('a shared set containing canonical input and release rules', () => {
    const catalog: FieldCatalogBundle = {
      identity: {
        id: 'canonical',
        version: '1',
        contentHash: 'canonical-1',
        compatibilityRange: '*',
      },
      entries: [
        {
          id: 'field.canonical.preferred_username',
          namespace: 'authrim.canonical',
          path: 'preferred_username',
          targetType: 'canonical',
          valueType: 'string',
          cardinality: 'single',
          classification: 'internal',
        },
        {
          id: 'field.canonical.employee_code',
          namespace: 'authrim.custom_fields',
          path: 'employee_code',
          aliases: [{ namespace: 'custom_fields', path: 'employeeCode' }],
          targetType: 'canonical',
          valueType: 'string',
          cardinality: 'single',
          classification: 'internal',
        },
        {
          id: 'field.destination.external_code',
          namespace: 'authrim.custom_fields',
          path: 'external_code',
          targetType: 'destination-only',
          valueType: 'string',
          cardinality: 'single',
          classification: 'internal',
        },
        {
          id: 'field.oidc.email',
          namespace: 'oidc.claim',
          path: 'email',
          targetType: 'destination-only',
          valueType: 'string',
          cardinality: 'single',
          classification: 'internal',
        },
      ],
    };
    const config = {
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      identityMapping: {
        fieldMappingSetId: 'saml-sp',
        destinationFieldPolicies: {
          mail: 'optional',
          displayName: 'optional',
          eduPersonAffiliation: 'optional',
        },
      },
    };
    const save = (operation: string) => {
      if (operation === 'create') {
        return handleCreateProvider(
          context({ body: { name: 'Provider', providerType: 'saml_sp', config } })
        );
      }
      mocks.adapter?.queryOne.mockResolvedValue(providerRow());
      return handleUpdateProvider(
        context({
          id: 'provider-a',
          body: { expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(), config },
        })
      );
    };
    const bind = (
      namespace: string,
      projectionOnly = false,
      inputTarget: Record<string, unknown> = PRODUCTION_INPUT_EDGES[0].targetRef
    ) => {
      const binding = withExplicitMappingGraphs({
        ...mocks.runtimeBinding,
        catalog,
        edges: [
          ...PRODUCTION_INPUT_EDGES.map((edge) => ({ ...edge, targetRef: inputTarget })),
          {
            id: 'release-mail',
            sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
            targetRef: { side: 'destination', namespace, path: 'mail' },
          },
        ],
        transforms: [],
      });
      mocks.runtimeBinding = projectionOnly ? { ...binding, graphRules: [] } : binding;
      return binding;
    };

    it.each(['create', 'update'])('accepts canonical input rules on SP %s', async (operation) => {
      bind('saml.attribute');
      const response = await save(operation);
      expect(response.status).toBe(operation === 'create' ? 201 : 200);
      expect(mocks.adapter?.execute).toHaveBeenCalled();
    });

    describe.each(['create', 'update'])('custom canonical fields on SP %s', (operation) => {
      it.each([
        {
          label: 'catalog ID',
          namespace: 'authrim.custom_fields',
          path: 'employee_code',
          catalogEntryId: 'field.canonical.employee_code',
        },
        { label: 'catalog path', namespace: 'authrim.custom_fields', path: 'employee_code' },
        { label: 'catalog alias', namespace: 'custom_fields', path: 'employeeCode' },
        {
          label: 'catalog ID and alias',
          namespace: 'custom_fields',
          path: 'employeeCode',
          catalogEntryId: 'field.canonical.employee_code',
        },
      ])('accepts a canonical input identified by $label', async ({ label: _label, ...ref }) => {
        bind('saml.attribute', false, { side: 'destination', ...ref });
        expect((await save(operation)).status).toBe(operation === 'create' ? 201 : 200);
        expect(mocks.adapter?.execute).toHaveBeenCalled();
      });

      it.each([
        {
          label: 'an uncatalogued custom field',
          namespace: 'authrim.custom_fields',
          path: 'missing',
        },
        { label: 'an uncatalogued profile field', namespace: 'authrim.profile', path: 'missing' },
        {
          label: 'an unknown catalog ID',
          namespace: 'authrim.custom_fields',
          path: 'employee_code',
          catalogEntryId: 'unknown-entry',
        },
        {
          label: 'a conflicting catalog ID',
          namespace: 'authrim.custom_fields',
          path: 'employee_code',
          catalogEntryId: 'field.canonical.preferred_username',
        },
        {
          label: 'an OIDC output with a borrowed canonical ID',
          namespace: 'oidc.claim',
          path: 'employee_code',
          catalogEntryId: 'field.canonical.employee_code',
        },
        {
          label: 'an unknown output with a borrowed canonical ID',
          namespace: 'unknown.output',
          path: 'employee_code',
          catalogEntryId: 'field.canonical.employee_code',
        },
        {
          label: 'a destination-only catalog entry',
          namespace: 'authrim.custom_fields',
          path: 'external_code',
          catalogEntryId: 'field.destination.external_code',
        },
        {
          label: 'a custom input carrying a Destination Profile reference',
          namespace: 'authrim.custom_fields',
          path: 'employee_code',
          profileId: 'destination-profile-saml',
        },
        {
          label: 'an alias carrying a stored Destination Profile reference',
          namespace: 'custom_fields',
          path: 'employeeCode',
          profile_id: 'destination-profile-saml',
        },
      ])('rejects $label', async ({ label: _label, ...ref }) => {
        bind('saml.attribute', false, { side: 'destination', ...ref });
        expect((await save(operation)).status).toBe(400);
        expect(mocks.adapter?.execute).not.toHaveBeenCalled();
      });
    });

    it.each([
      ['create', false],
      ['update', false],
      ['create', true],
      ['update', true],
    ])(
      'rejects an OIDC output on SP %s (projection only: %s)',
      async (operation, projectionOnly) => {
        bind('oidc.claim', projectionOnly);
        const response = await save(operation);
        expect(response.status).toBe(400);
        expect(mocks.adapter?.execute).not.toHaveBeenCalled();
      }
    );

    it('rejects an unknown output namespace rather than treating it as an input rule', async () => {
      bind('unknown.output');
      expect((await save('create')).status).toBe(400);
      expect(mocks.adapter?.execute).not.toHaveBeenCalled();
    });

    it('judges the final graph target even when its projected edge targets SAML', async () => {
      const binding = bind('saml.attribute');
      mocks.runtimeBinding = {
        ...binding,
        graphRules: binding.graphRules.map((rule) =>
          rule.id === 'release-mail'
            ? { ...rule, targetRef: { ...rule.targetRef, namespace: 'oidc.claim' } }
            : rule
        ),
      };
      expect((await save('update')).status).toBe(400);
      expect(mocks.adapter?.execute).not.toHaveBeenCalled();
    });

    it('accepts an unused canonical input edge inside a SAML output graph', async () => {
      const binding = bind('saml.attribute');
      const input = binding.graphRules[0];
      const output = binding.graphRules[1];
      mocks.runtimeBinding = {
        ...binding,
        graphRules: [
          {
            ...output,
            edges: [...input.edges, ...output.edges],
            output: { edgeIndex: input.edges.length },
          },
        ],
      };
      expect((await save('update')).status).toBe(200);
    });
  });

  describe('an attribute descriptor that renames an attribute', () => {
    const create = (attributeDescriptors: Record<string, unknown>) => {
      mocks.runtimeBinding = withExplicitMappingGraphs(
        {
          ...mocks.runtimeBinding,
          edges: [
            { targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'mail' } },
            {
              targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'displayName' },
            },
          ],
          transforms: [],
        },
        true
      );
      return handleCreateProvider(
        context({
          body: {
            name: 'Provider',
            providerType: 'saml_sp',
            config: {
              entityId: 'https://sp.example.test',
              acsUrl: 'https://sp.example.test/acs',
              identityMapping: {
                fieldMappingSetId: 'saml-sp',
                attributeDescriptors,
                destinationFieldPolicies: {
                  mail: 'optional',
                  displayName: 'optional',
                  eduPersonAffiliation: 'optional',
                },
              },
            },
          },
        })
      );
    };

    it('is refused: the release policy and classification check are by profile field', async () => {
      const response = await create({ mail: { name: 'displayName' } });
      expect(response.status).toBe(400);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('may restate the name, and set the friendly name and format', async () => {
      const response = await create({
        mail: { name: 'mail', friendlyName: 'Email' },
        displayName: { friendlyName: 'Name' },
      });
      expect(response.status).toBe(201);
    });
  });

  it('rejects an invalid information release consent setting', async () => {
    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            informationReleaseConsent: { enabled: true, ask: 'unsupported' },
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies: {
                mail: 'optional',
                displayName: 'optional',
                eduPersonAffiliation: 'optional',
              },
            },
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('requires an explicit release policy for every field in the Mapping Set destination', async () => {
    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies: {
                mail: 'required',
                displayName: 'optional',
              },
            },
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid_request',
    });
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['an omitted policy map', undefined],
    ['a null policy map', null],
    ['an array policy map', []],
    [
      'more than 256 policy entries',
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`field-${index}`, 'optional'])),
    ],
    ['a blank destination field', { '   ': 'optional' }],
    ['an oversized destination field', { ['x'.repeat(1025)]: 'optional' }],
  ])('rejects %s', async (_label, destinationFieldPolicies) => {
    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies,
            },
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing Mapping Set binding', 'binding'],
    ['a Mapping Set binding with multiple destination profiles', 'profile-count'],
    ['a missing destination profile descriptor', 'descriptor'],
    ['a non-SAML destination profile descriptor', 'descriptor-type'],
  ])('rejects %s', async (_label, missingDependency) => {
    if (missingDependency === 'binding') {
      mocks.runtimeBinding = null;
    } else if (missingDependency === 'profile-count') {
      mocks.runtimeBinding = {
        ...(mocks.runtimeBinding ?? {}),
        destinationProfileIds: ['destination-profile-saml', 'destination-profile-secondary'],
      };
    } else if (missingDependency === 'descriptor') {
      mocks.destinationDescriptor = null;
    } else {
      mocks.destinationDescriptor = {
        ...(mocks.destinationDescriptor ?? {}),
        destinationType: 'oidc',
      };
    }

    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies: {
                mail: 'optional',
                displayName: 'optional',
                eduPersonAffiliation: 'optional',
              },
            },
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('records creation failures without exposing storage errors', async () => {
    mocks.adapter!.execute.mockRejectedValue(new Error('database unavailable'));
    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'sp',
            acsUrl: 'https://sp.example.test/acs',
            identityMapping: {
              fieldMappingSetId: 'saml-sp',
              destinationFieldPolicies: {
                mail: 'optional',
                displayName: 'optional',
                eduPersonAffiliation: 'optional',
              },
            },
          },
        },
      })
    );
    expect(response.status).toBe(500);
  });

  it('rejects missing and unknown provider IDs', async () => {
    expect((await handleGetProvider(context())).status).toBe(404);
    expect((await handleGetProvider(context({ id: 'missing' }))).status).toBe(404);
  });

  it('returns a provider and maps disabled state', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ enabled: 0 }));
    const response = await handleGetProvider(context({ id: 'provider-a' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'provider-a', enabled: false });
  });

  it('fails safely when the persisted provider JSON is malformed', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow({ config_json: '{' }));
    expect((await handleGetProvider(context({ id: 'provider-a' }))).status).toBe(500);
  });

  it('rejects update of an unknown provider', async () => {
    expect((await handleUpdateProvider(context({ id: 'missing', body: {} }))).status).toBe(404);
  });

  it('requires the current updatedAt value and rejects stale provider edits', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    expect(
      (await handleUpdateProvider(context({ id: 'provider-a', body: { name: 'Next' } }))).status
    ).toBe(400);

    const stale = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: { expectedUpdatedAt: new Date(1_700_000_000_000).toISOString(), name: 'Next' },
      })
    );
    expect(stale.status).toBe(409);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  describe('resulting SP encryption configuration', () => {
    let certificate: string;
    const config = {
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      allowedBindings: ['post'],
      identityMapping: {
        fieldMappingSetId: 'saml-sp',
        destinationFieldPolicies: {
          mail: 'optional',
          displayName: 'optional',
          eduPersonAffiliation: 'optional',
        },
      },
      extension: { preserve: true },
    };
    const expectedUpdatedAt = new Date(1_700_000_001_000).toISOString();
    const assertionXml =
      '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Assertion><saml:Subject><saml:NameID>fixture</saml:NameID></saml:Subject></saml:Assertion></samlp:Response>';
    beforeAll(async () => {
      const keys = await generateKeyPair('RS256', { extractable: true });
      certificate = await generateSelfSignedCertificate(
        await exportJWK(keys.publicKey),
        await exportPKCS8(keys.privateKey)
      );
    });
    it.each(['encryptAssertions', 'encryptNameID'])(
      'rejects enabling %s without a certificate in the merged state',
      async (field) => {
        const adapter = mocks.adapter;
        if (!adapter) throw new Error('Missing test adapter');
        adapter.queryOne.mockResolvedValue(providerRow({ config_json: JSON.stringify(config) }));
        const response = await handleUpdateProvider(
          context({
            id: 'provider-a',
            body: { expectedUpdatedAt, config: { [field]: true } },
          })
        );
        expect(response.status).toBe(400);
        expect(adapter.execute).not.toHaveBeenCalled();
      }
    );
    it.each(
      ['encryptionCertificate', 'encryptionCertificates'].flatMap((source) =>
        ['encryptAssertions', 'encryptNameID'].map((field) => ({ source, field }))
      )
    )(
      'uses stored/imported $source for $field during a partial update and actual encryption',
      async ({ source, field }) => {
        const adapter = mocks.adapter;
        if (!adapter) throw new Error('Missing test adapter');
        const encryption = {
          [source]: source === 'encryptionCertificate' ? certificate : [certificate],
        };
        adapter.queryOne.mockResolvedValue(
          providerRow({ config_json: JSON.stringify({ ...config, ...encryption }) })
        );
        const response = await handleUpdateProvider(
          context({
            id: 'provider-a',
            body: { expectedUpdatedAt, config: { [field]: true } },
          })
        );
        expect(response.status).toBe(200);
        const saved = await responseBody<{ config: SAMLSPConfig }>(response);
        expect(saved.config).toMatchObject({
          ...encryption,
          [field]: true,
          extension: { preserve: true },
        });
        const encrypted = await applySAMLAssertionEncryptionPolicy(assertionXml, saved.config);
        expect(encrypted).toContain(
          field === 'encryptAssertions' ? 'EncryptedAssertion' : 'EncryptedID'
        );
      }
    );
    it.each([
      { assertionEncryptionAlgorithm: 'aes256-cbc' },
      { keyEncryptionAlgorithm: 'rsa-oaep-sha1' },
    ])(
      'requires explicit legacy opt-in for the resulting enabled configuration %j',
      async (legacyAlgorithm) => {
        const adapter = mocks.adapter;
        if (!adapter) throw new Error('Missing test adapter');
        const encryptedConfig = {
          ...config,
          encryptAssertions: true,
          encryptionCertificate: certificate,
        };
        for (const policy of [{}, { encryptionAlgorithmPolicy: 'modern' }]) {
          adapter.queryOne.mockResolvedValue(null);
          const created = await handleCreateProvider(
            context({
              body: {
                name: 'Encrypted SP',
                providerType: 'saml_sp',
                config: { ...encryptedConfig, ...policy, ...legacyAlgorithm },
              },
            })
          );
          expect(created.status).toBe(400);
          adapter.queryOne.mockResolvedValue(
            providerRow({ config_json: JSON.stringify({ ...encryptedConfig, ...policy }) })
          );
          const updated = await handleUpdateProvider(
            context({
              id: 'provider-a',
              body: { expectedUpdatedAt, config: legacyAlgorithm },
            })
          );
          expect(updated.status).toBe(400);
          expect(adapter.execute).not.toHaveBeenCalled();
        }
        const draftConfig = {
          ...encryptedConfig,
          ...legacyAlgorithm,
          encryptionAlgorithmPolicy: 'modern',
        };
        adapter.queryOne.mockResolvedValue(null);
        expect(
          (
            await handleCreateProvider(
              context({
                body: {
                  name: 'Disabled legacy draft',
                  providerType: 'saml_sp',
                  enabled: false,
                  config: draftConfig,
                },
              })
            )
          ).status
        ).toBe(201);
        adapter.execute.mockClear();
        adapter.queryOne.mockResolvedValue(
          providerRow({ enabled: 0, config_json: JSON.stringify(draftConfig) })
        );
        expect(
          (
            await handleUpdateProvider(
              context({
                id: 'provider-a',
                body: { expectedUpdatedAt, name: 'Disabled draft' },
              })
            )
          ).status
        ).toBe(200);
        adapter.execute.mockClear();
        expect(
          (
            await handleUpdateProvider(
              context({
                id: 'provider-a',
                body: { expectedUpdatedAt, enabled: true },
              })
            )
          ).status
        ).toBe(400);
        expect(adapter.execute).not.toHaveBeenCalled();
        const enabled = await handleUpdateProvider(
          context({
            id: 'provider-a',
            body: {
              expectedUpdatedAt,
              enabled: true,
              config: { encryptionAlgorithmPolicy: 'legacy_opt_in' },
            },
          })
        );
        expect(enabled.status).toBe(200);
        const saved = await responseBody<{ config: SAMLSPConfig; updatedAt: string }>(enabled);
        expect(await applySAMLAssertionEncryptionPolicy(assertionXml, saved.config)).toContain(
          'EncryptedAssertion'
        );
        adapter.queryOne.mockResolvedValue(
          providerRow({
            config_json: JSON.stringify(saved.config),
            updated_at: Date.parse(saved.updatedAt),
          })
        );
        adapter.execute.mockClear();
        expect(
          (
            await handleUpdateProvider(
              context({
                id: 'provider-a',
                body: {
                  expectedUpdatedAt: saved.updatedAt,
                  config: { encryptionAlgorithmPolicy: 'modern' },
                },
              })
            )
          ).status
        ).toBe(400);
        expect(adapter.execute).not.toHaveBeenCalled();
        adapter.queryOne.mockResolvedValue(null);
        expect(
          (
            await handleCreateProvider(
              context({
                body: {
                  name: 'Legacy SP',
                  providerType: 'saml_sp',
                  config: {
                    ...encryptedConfig,
                    ...legacyAlgorithm,
                    encryptionAlgorithmPolicy: 'legacy_opt_in',
                  },
                },
              })
            )
          ).status
        ).toBe(201);
      }
    );
    it('creates usable explicit modern GCM/OAEP-256 encryption settings', async () => {
      const created = await handleCreateProvider(
        context({
          body: {
            name: 'Modern SP',
            providerType: 'saml_sp',
            config: {
              ...config,
              encryptAssertions: true,
              encryptionCertificate: certificate,
              encryptionAlgorithmPolicy: 'modern',
              assertionEncryptionAlgorithm: 'aes256-gcm',
              keyEncryptionAlgorithm: 'rsa-oaep-256',
            },
          },
        })
      );
      expect(created.status).toBe(201);
      const saved = await responseBody<{ config: SAMLSPConfig }>(created);
      expect(await applySAMLAssertionEncryptionPolicy(assertionXml, saved.config)).toContain(
        'EncryptedAssertion'
      );
    });
    it('allows incomplete disabled drafts but checks the stored configuration on enable', async () => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing test adapter');
      const draft = { ...config, encryptNameID: true };
      adapter.queryOne.mockResolvedValue(
        providerRow({ enabled: 0, config_json: JSON.stringify(draft) })
      );
      expect(
        (
          await handleUpdateProvider(
            context({
              id: 'provider-a',
              body: { expectedUpdatedAt, name: 'Draft' },
            })
          )
        ).status
      ).toBe(200);
      adapter.execute.mockClear();
      expect(
        (
          await handleUpdateProvider(
            context({
              id: 'provider-a',
              body: { expectedUpdatedAt, enabled: true },
            })
          )
        ).status
      ).toBe(400);
      expect(adapter.execute).not.toHaveBeenCalled();
      const enabled = await handleUpdateProvider(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt,
            enabled: true,
            config: { encryptionCertificates: [certificate] },
          },
        })
      );
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({
        enabled: true,
        config: { encryptNameID: true, encryptionCertificates: [certificate] },
      });
    });
    it('rejects removal of the active certificate and preserves emergency disabling', async () => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing test adapter');
      adapter.queryOne.mockResolvedValue(
        providerRow({
          config_json: JSON.stringify({
            ...config,
            encryptAssertions: true,
            encryptionCertificate: certificate,
          }),
        })
      );
      const patch = { encryptionCertificate: '', encryptionCertificates: [] };
      expect(
        (
          await handleUpdateProvider(
            context({
              id: 'provider-a',
              body: { expectedUpdatedAt, config: patch },
            })
          )
        ).status
      ).toBe(400);
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(
        (
          await handleUpdateProvider(
            context({
              id: 'provider-a',
              body: { expectedUpdatedAt, enabled: false, config: patch },
            })
          )
        ).status
      ).toBe(200);
    });
    it('checks enabled creation while permitting disabled drafts and valid encryption sources', async () => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing test adapter');
      const body = {
        name: 'Encrypted SP',
        providerType: 'saml_sp',
        config: { ...config, encryptAssertions: true },
      };
      expect((await handleCreateProvider(context({ body }))).status).toBe(400);
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(
        (await handleCreateProvider(context({ body: { ...body, enabled: false } }))).status
      ).toBe(201);
      for (const source of [
        { encryptionCertificate: certificate },
        { encryptionCertificates: [certificate] },
      ]) {
        expect(
          (
            await handleCreateProvider(
              context({ body: { ...body, config: { ...body.config, ...source } } })
            )
          ).status
        ).toBe(201);
      }
    });
  });

  it('does not accept client replay of metadata lifecycle state during provider update', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        enabled: 0,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: {
            fieldMappingSetId: 'saml-sp',
            destinationFieldPolicies: {
              mail: 'optional',
              displayName: 'optional',
              eduPersonAffiliation: 'optional',
            },
          },
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            sourceState: 'missing',
            lastErrorCode: 'federation_entity_missing',
            suspendedByMetadataSync: true,
          },
        }),
      })
    );

    const response = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          enabled: false,
          config: {
            metadataRefreshPolicy: {
              mode: 'manual',
              intervalSeconds: 3_600,
              sourceState: 'healthy',
              suspendedByMetadataSync: false,
            },
          },
        },
      })
    );

    expect(response.status).toBe(200);
    const saved = await responseBody<{ config: SAMLSPConfig }>(response);
    expect(saved.config.metadataRefreshPolicy).not.toHaveProperty('suspendedByMetadataSync');
    expect(saved).toMatchObject({
      enabled: false,
      config: {
        metadataRefreshPolicy: {
          mode: 'manual',
          intervalSeconds: 3_600,
          sourceState: 'missing',
          lastErrorCode: 'federation_entity_missing',
        },
      },
    });
  });

  it('updates an SP while retaining omitted name and enabled state', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const response = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          config: { acsUrl: 'https://sp.example.test/new-acs' },
        },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Provider A', enabled: true });
    expect(mocks.adapter!.execute).toHaveBeenCalled();
  });

  it('persists manual polling mode for a URL-backed provider', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: {
            fieldMappingSetId: 'saml-sp',
            destinationFieldPolicies: {
              mail: 'optional',
              displayName: 'optional',
              eduPersonAffiliation: 'optional',
            },
          },
        }),
      })
    );
    const response = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          config: {
            metadataRefreshPolicy: { mode: 'manual', intervalSeconds: 3_600 },
          },
        },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      config: { metadataRefreshPolicy: { mode: 'manual', intervalSeconds: 3_600 } },
    });
  });

  it('updates an IdP and honors explicit name and disabled state', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        provider_type: 'saml_idp',
        enabled: 1,
        config_json: JSON.stringify({
          entityId: 'idp',
          ssoUrl: 'https://idp.example.test/sso',
          certificate: 'not-a-certificate',
          identityMapping: { fieldMappingSetId: 'saml-idp' },
        }),
      })
    );
    const response = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          name: 'Next',
          enabled: false,
        },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Next', enabled: false });
  });

  it('returns internal error when update storage fails', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    mocks.adapter!.execute.mockRejectedValue(new Error('database unavailable'));
    expect(
      (
        await handleUpdateProvider(
          context({
            id: 'provider-a',
            body: { expectedUpdatedAt: new Date(1_700_000_001_000).toISOString() },
          })
        )
      ).status
    ).toBe(500);
  });

  it('distinguishes a missing provider from a successful deletion', async () => {
    expect((await handleDeleteProvider(context({ id: 'missing' }))).status).toBe(404);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    expect(mocks.stepUp).not.toHaveBeenCalled();

    mocks.adapter!.queryOne.mockResolvedValueOnce({ id: 'provider-a' });
    mocks.adapter!.execute.mockResolvedValueOnce({ rowsAffected: 1, insertId: undefined });
    expect((await handleDeleteProvider(context({ id: 'provider-a' }))).status).toBe(200);
  });

  it('does not expose provider deletion storage errors', async () => {
    mocks.adapter!.queryOne.mockResolvedValueOnce({ id: 'provider-a' });
    mocks.adapter!.execute.mockRejectedValue(new Error('database unavailable'));
    expect((await handleDeleteProvider(context({ id: 'provider-a' }))).status).toBe(500);
  });

  it('loads provider configs only from tenant-scoped enabled rows', async () => {
    mocks.adapter!.query.mockResolvedValue([
      { enabled: 1, config_json: JSON.stringify({ entityId: 'other' }) },
      {
        enabled: 1,
        config_json: JSON.stringify({ entityId: 'target', acsUrl: 'https://sp/acs' }),
      },
    ]);
    expect(await getSPConfig({} as never, 'tenant-a', 'target')).toMatchObject({
      entityId: 'target',
      signAssertions: false,
      signResponses: true,
    });
    expect(await getSPConfig({} as never, 'tenant-a', 'missing')).toBeNull();

    expect(await getIdPConfigByEntityId({} as never, 'tenant-a', 'target')).toMatchObject({
      entityId: 'target',
    });
    expect(await getIdPConfigByEntityId({} as never, 'tenant-a', 'missing')).toBeNull();
  });

  it('limits an alternate SAML runtime to its imported explicit SP inventory', async () => {
    const runtime = {
      serviceProviders: {
        isAllowed: vi.fn(
          ({ tenantId, entityId }: { tenantId: string; entityId: string }) =>
            tenantId === 'tenant-a' && entityId === 'https://sp.example.test'
        ),
      },
    };
    const env = { SAML_RUNTIME_PORTS: runtime } as never;
    expect(await getSPConfig(env, 'tenant-a', 'https://other.example.test')).toBeNull();
    expect(mocks.adapter!.query).not.toHaveBeenCalled();

    mocks.adapter!.query.mockResolvedValueOnce([
      {
        enabled: true,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
        }),
      },
    ]);
    expect(await getSPConfig(env, 'tenant-a', 'https://sp.example.test')).toMatchObject({
      entityId: 'https://sp.example.test',
    });
    expect(runtime.serviceProviders.isAllowed).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      entityId: 'https://sp.example.test',
    });
    expect(await getSPConfig(env, 'tenant-b', 'https://sp.example.test')).toBeNull();
  });

  it("files an IdP's saved sign-in switches under its provider id, found by entity id", async () => {
    mocks.adapter!.query.mockResolvedValue([
      { id: 'idp-other', config_json: JSON.stringify({ entityId: 'other' }) },
      { id: 'idp-1', config_json: JSON.stringify({ entityId: 'target' }) },
    ]);
    expect(await getIdPUsageKeyByEntityId({} as never, 'tenant-a', 'target')).toEqual({
      providerId: 'idp-1',
      ids: ['saml:idp-1', 'idp-1'],
    });
    // An IdP with no provider record of its own (federation metadata) has no switches saved.
    expect(await getIdPUsageKeyByEntityId({} as never, 'tenant-a', 'missing')).toBeNull();
    // An entity id two records claim is refused where the IdP is resolved; no key is guessed.
    mocks.adapter!.query.mockResolvedValue([
      { id: 'idp-1', config_json: JSON.stringify({ entityId: 'target' }) },
      { id: 'idp-2', config_json: JSON.stringify({ entityId: 'target' }) },
    ]);
    expect(await getIdPUsageKeyByEntityId({} as never, 'tenant-a', 'target')).toBeNull();
  });

  it('resolves an opted-in aggregate SP and applies its Entity Category preset', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        trust_source_id: 'source-a',
        trust_context_snapshot_hash: 'trust-hash-a',
        source_url: 'https://metadata.example.test/federation.xml',
        protocol_payload_json: JSON.stringify({
          runtimeResolution: {
            mode: 'automatic',
            roles: ['saml_sp'],
            priority: 10,
            spFieldMappingSetId: 'mapping-sp',
            entityCategoryPolicy: {
              defaultDecision: 'deny',
              rules: [
                {
                  entityCategory: 'http://refeds.org/category/research-and-scholarship',
                  decision: 'allow',
                  attributePresetId: 'research_federation.v1',
                },
              ],
            },
          },
        }),
        metadata_xml: validSpMetadata(),
        entity_categories_json: JSON.stringify([
          'http://refeds.org/category/research-and-scholarship',
        ]),
        registration_authority: 'https://federation.example.test',
        valid_until: '2099-01-01T00:00:00Z',
        validated_at: 1_700_000_000_000,
      },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toMatchObject({
      entityId: 'https://sp.example.test',
      identityMapping: { fieldMappingSetId: 'mapping-sp' },
      attributePresetId: 'research_federation.v1',
      aggregateImport: {
        federationTrustProfileId: 'source-a',
        verification: { status: 'verified' },
      },
    });
    const runtimeQuery = String(mocks.adapter!.query.mock.calls[1]?.[0]);
    expect(runtimeQuery).toContain("s.lifecycle_state = 'active'");
    expect(runtimeQuery).toContain("d.validation_state = 'valid'");
    expect(runtimeQuery).toContain("d.document_type = 'saml_aggregate_runtime_snapshot'");
    expect(runtimeQuery).toContain('r.trust_context_snapshot_hash');
    expect(runtimeQuery).toContain("current.lifecycle_state = 'active'");
    expect(runtimeQuery).toContain('d.id = s.active_metadata_document_id');
  });

  it('refuses a federation entity on the exception list, whatever the other rules allow', async () => {
    const payload = JSON.stringify({
      runtimeResolution: {
        mode: 'automatic',
        roles: ['saml_sp', 'saml_idp'],
        spFieldMappingSetId: 'mapping-sp',
        idpFieldMappingSetId: 'mapping-idp',
        entityCategoryPolicy: {
          defaultDecision: 'allow',
          rules: [
            {
              entityCategory: 'http://refeds.org/category/research-and-scholarship',
              decision: 'allow',
            },
          ],
        },
      },
      // Stored beside runtimeResolution, so an edit does not retire the runtime directory.
      exceptions: { excludedEntityIds: ['https://sp.example.test', 'urn:imported:idp'] },
    });
    const spRow = {
      trust_source_id: 'source-a',
      trust_context_snapshot_hash: 'trust-hash-a',
      source_url: 'https://metadata.example.test/federation.xml',
      protocol_payload_json: payload,
      metadata_xml: validSpMetadata(),
      entity_categories_json: JSON.stringify([
        'http://refeds.org/category/research-and-scholarship',
      ]),
      registration_authority: 'https://federation.example.test',
      valid_until: '2099-01-01T00:00:00Z',
      validated_at: 1_700_000_000_000,
    };
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([spRow]);
    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();

    // The same source without the exception resolves the SP: the list is the only difference.
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...spRow,
        protocol_payload_json: JSON.stringify({
          ...(JSON.parse(payload) as Record<string, unknown>),
          exceptions: { excludedEntityIds: ['urn:imported:idp'] },
        }),
      },
    ]);
    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toMatchObject({ entityId: 'https://sp.example.test' });

    // IdP role: the explicit lookup finds nothing, and the federation row is excluded.
    const idpRow = { ...spRow, metadata_xml: validIdpMetadata('VEVTVA==') };
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([idpRow]);
    await expect(
      getIdPConfigByEntityId({ DB_ADMIN: {} } as never, 'tenant-a', 'urn:imported:idp')
    ).resolves.toBeNull();
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...idpRow,
        protocol_payload_json: JSON.stringify({
          ...(JSON.parse(payload) as Record<string, unknown>),
          exceptions: { excludedEntityIds: ['https://sp.example.test'] },
        }),
      },
    ]);
    await expect(
      getIdPConfigByEntityId({ DB_ADMIN: {} } as never, 'tenant-a', 'urn:imported:idp')
    ).resolves.toMatchObject({ entityId: 'urn:imported:idp' });
  });

  it('does not treat Entity Category Support as Entity Category membership', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        trust_source_id: 'source-a',
        source_url: 'https://metadata.example.test/federation.xml',
        protocol_payload_json: JSON.stringify({
          runtimeResolution: {
            mode: 'automatic',
            roles: ['saml_sp'],
            spFieldMappingSetId: 'mapping-sp',
            entityCategoryPolicy: {
              defaultDecision: 'deny',
              rules: [
                {
                  entityCategory: 'http://refeds.org/category/research-and-scholarship',
                  decision: 'allow',
                },
              ],
            },
          },
        }),
        metadata_xml: validSpMetadata(),
        entity_categories_json: '[]',
        entity_category_support_json: JSON.stringify([
          'http://refeds.org/category/research-and-scholarship',
        ]),
        registration_authority: 'https://federation.example.test',
        valid_until: '2099-01-01T00:00:00Z',
        validated_at: 1_700_000_000_000,
      },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
  });

  it('fails closed for a malformed persisted Entity Category policy', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        trust_source_id: 'source-a',
        source_url: 'https://metadata.example.test/federation.xml',
        protocol_payload_json: JSON.stringify({
          runtimeResolution: {
            mode: 'automatic',
            roles: ['saml_sp'],
            spFieldMappingSetId: 'mapping-sp',
            entityCategoryPolicy: {
              defaultDecision: 'allow',
              rules: [null],
            },
          },
        }),
        metadata_xml: validSpMetadata(),
        entity_categories_json: '[]',
        registration_authority: null,
        valid_until: '2099-01-01T00:00:00Z',
        validated_at: 1_700_000_000_000,
      },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
  });

  it('does not fall back to an aggregate when an explicit provider trust is expired', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([
      {
        enabled: 1,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            sourceState: 'expired',
            suspendedByMetadataSync: true,
          },
        }),
      },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
    expect(mocks.adapter!.query).toHaveBeenCalledOnce();
  });

  it('parses legacy persisted metadata validity when refresh snapshots are absent', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([
      {
        enabled: 1,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataXml: validSpMetadata().replace(
            'entityID="https://sp.example.test"',
            'entityID="https://sp.example.test" validUntil="2020-01-01T00:00:00Z"'
          ),
        }),
      },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
    expect(mocks.adapter!.query).toHaveBeenCalledOnce();
  });

  it.each(['saml_sp', 'saml_idp'])(
    'keeps unapproved %s drafts out of federation fallback and usage resolution',
    async (role) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing adapter');
      const entityId = role === 'saml_sp' ? 'https://sp.example.test' : 'urn:imported:idp';
      const xml = role === 'saml_sp' ? validSpMetadata() : validIdpMetadata('VEVTVA==');
      const created = await handleCreateProvider(
        context({
          body: { name: 'Unapproved', providerType: role, enabled: false, metadataXml: xml },
        })
      );
      expect(created.status).toBe(201);
      const draft = await responseBody<{ config: SAMLIdPConfig | SAMLSPConfig; updatedAt: string }>(
        created
      );
      expect(draft.config.trustApproval).toEqual({ state: 'draft' });
      const federation = {
        trust_source_id: 'source-a',
        trust_context_snapshot_hash: 'context-a',
        source_url: 'https://metadata.example.test/federation.xml',
        protocol_payload_json: JSON.stringify({
          runtimeResolution: {
            mode: 'automatic',
            roles: [role],
            spFieldMappingSetId: 'saml-sp',
            idpFieldMappingSetId: 'saml-sp',
          },
        }),
        metadata_xml: xml,
        entity_categories_json: '[]',
        entity_category_support_json: '[]',
        registration_authority: null,
        valid_until: '2099-01-01T00:00:00Z',
        validated_at: 1,
      };
      adapter.query.mockImplementation(async (sql: string) =>
        sql.includes('federation_saml_runtime_entities')
          ? [federation]
          : [{ id: 'draft-a', enabled: 0, config_json: JSON.stringify(draft.config) }]
      );
      const resolve = () =>
        role === 'saml_sp'
          ? getSPConfig(context().env, 'tenant-a', entityId)
          : getIdPConfigByEntityId(context().env, 'tenant-a', entityId);
      expect(await resolve()).toMatchObject({
        entityId,
        aggregateImport: { federationTrustProfileId: 'source-a' },
      });
      if (role === 'saml_idp')
        expect(await getIdPUsageKeyByEntityId(context().env, 'tenant-a', entityId)).toBeNull();
      // Moving an existing draft to another federation entity remains non-authoritative too.
      adapter.queryOne.mockResolvedValue(
        providerRow({
          provider_type: role,
          enabled: 0,
          config_json: JSON.stringify({ ...draft.config, entityId: 'urn:unapproved:old' }),
          updated_at: Date.parse(draft.updatedAt),
        })
      );
      adapter.query.mockResolvedValueOnce([]);
      const changed = await handleUpdateProvider(
        context({
          id: 'draft-a',
          body: {
            expectedUpdatedAt: draft.updatedAt,
            config: { entityId },
          },
        })
      );
      expect(changed.status).toBe(200);
      const moved = await responseBody<{ config: SAMLIdPConfig | SAMLSPConfig }>(changed);
      expect(moved.config.trustApproval).toEqual({ state: 'draft' });
      expect(await resolve()).toMatchObject({ entityId });
      expect(mocks.stepUp).not.toHaveBeenCalled();
    }
  );

  it('does not fall back to an aggregate when an explicit provider is disabled', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([
      {
        enabled: 0,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
        }),
      },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
    expect(mocks.adapter!.query).toHaveBeenCalledOnce();
  });

  it('rejects an explicit aggregate-linked provider after its source is deleted', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([
      {
        enabled: 1,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
            aggregateEntityId: 'https://sp.example.test',
            federationTrustProfileId: 'deleted-source',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
    ]);
    mocks.adapter!.queryOne.mockResolvedValueOnce(null);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
  });

  it('requires an explicit aggregate-linked provider to match the active trust snapshot', async () => {
    const config = {
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
      aggregateImport: {
        aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
        aggregateEntityId: 'https://sp.example.test',
        federationTrustProfileId: 'source-a',
        verification: {
          status: 'verified',
          policy: 'strict',
          trustProfileId: 'source-a',
          trustContextSnapshotHash: 'trust-hash-old',
        },
        importedAt: 1,
      },
    };
    mocks.adapter!.query.mockResolvedValue([{ enabled: 1, config_json: JSON.stringify(config) }]);
    mocks.adapter!.queryOne.mockResolvedValue({ id: 'source-a', snapshot_hash: 'trust-hash-new' });

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();

    mocks.adapter!.queryOne.mockResolvedValue({ id: 'source-a', snapshot_hash: 'trust-hash-old' });
    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toMatchObject({ entityId: 'https://sp.example.test' });
  });

  it('fails closed when duplicate explicit providers share one role and entityID', async () => {
    const config = JSON.stringify({
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/acs',
    });
    mocks.adapter!.query.mockResolvedValue([
      { enabled: 1, config_json: config },
      { enabled: 1, config_json: config },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
    expect(mocks.adapter!.query).toHaveBeenCalledOnce();
  });

  it('fails closed when two aggregate sources have the same highest priority', async () => {
    const runtimeRow = {
      source_url: 'https://metadata.example.test/federation.xml',
      protocol_payload_json: JSON.stringify({
        runtimeResolution: {
          mode: 'automatic',
          roles: ['saml_sp'],
          priority: 10,
          spFieldMappingSetId: 'mapping-sp',
        },
      }),
      metadata_xml: validSpMetadata(),
      entity_categories_json: '[]',
      registration_authority: null,
      valid_until: '2099-01-01T00:00:00Z',
      validated_at: 1_700_000_000_000,
    };
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { ...runtimeRow, trust_source_id: 'source-a' },
      { ...runtimeRow, trust_source_id: 'source-b' },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
  });

  it('fails closed before filtering when the runtime candidate bound is exceeded', async () => {
    const runtimeRow = {
      trust_source_id: 'source-a',
      trust_context_snapshot_hash: 'trust-hash-a',
      source_url: 'https://metadata.example.test/federation.xml',
      protocol_payload_json: JSON.stringify({
        runtimeResolution: {
          mode: 'automatic',
          roles: ['saml_sp'],
          priority: 10,
          spFieldMappingSetId: 'mapping-sp',
        },
      }),
      metadata_xml: validSpMetadata(),
      entity_categories_json: '[]',
      registration_authority: null,
      valid_until: '2099-01-01T00:00:00Z',
      validated_at: 1_700_000_000_000,
    };
    mocks
      .adapter!.query.mockResolvedValueOnce([])
      .mockResolvedValueOnce(Array.from({ length: 101 }, () => runtimeRow));

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
  });

  it('does not resolve entities after the accepted aggregate validity expires', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        trust_source_id: 'source-a',
        source_url: 'https://metadata.example.test/federation.xml',
        protocol_payload_json: JSON.stringify({
          polling: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            acceptedValidUntil: '2020-01-01T00:00:00Z',
          },
          runtimeResolution: {
            mode: 'automatic',
            roles: ['saml_sp'],
            spFieldMappingSetId: 'mapping-sp',
          },
        }),
        metadata_xml: validSpMetadata(),
        entity_categories_json: '[]',
        registration_authority: null,
        valid_until: null,
        validated_at: 1_700_000_000_000,
      },
    ]);

    await expect(
      getSPConfig({ DB_ADMIN: {} } as never, 'tenant-a', 'https://sp.example.test')
    ).resolves.toBeNull();
  });

  it('gets and lists normalized provider summaries', async () => {
    mocks.adapter!.queryOne.mockResolvedValue({
      config_json: JSON.stringify({ entityId: 'idp' }),
    });
    expect(await getIdPConfig({} as never, 'tenant-a', 'provider-a')).toEqual({ entityId: 'idp' });
    mocks.adapter!.queryOne.mockResolvedValue(null);
    expect(await getIdPConfig({} as never, 'tenant-a', 'missing')).toBeNull();

    mocks.adapter!.query.mockResolvedValue([
      { id: 'a', name: 'A', config_json: JSON.stringify({ entityId: 'entity-a' }) },
    ]);
    expect(await listSPConfigs({} as never, 'tenant-a')).toEqual([
      { id: 'a', name: 'A', entityId: 'entity-a' },
    ]);
    expect(await listIdPConfigs({} as never, 'tenant-a')).toEqual([
      { id: 'a', name: 'A', entityId: 'entity-a' },
    ]);
  });

  it('rejects metadata import for missing providers and missing inputs', async () => {
    expect((await handleImportMetadata(context({ id: 'missing', body: {} }))).status).toBe(404);

    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    expect((await handleImportMetadata(context({ id: 'provider-a', body: {} }))).status).toBe(400);
  });

  it.each([['http://metadata.example.test/sp.xml'], ['https://127.0.0.1/sp.xml'], ['not-a-url']])(
    'rejects unsafe metadata URL %s',
    async (metadataUrl) => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: { expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(), metadataUrl },
        })
      );
      expect(response.status).toBe(400);
      expect(mocks.safeFetchText).not.toHaveBeenCalled();
    }
  );

  it('imports inline SP metadata and preserves tenant-scoped custom configuration', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const response = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          metadataXml: validSpMetadata(),
        },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, enabled: true });
    expect(mocks.adapter!.execute).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('preserves reviewed metadata and advanced settings across import then partial settings save', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing test adapter');
    const source = 'https://metadata.example.test/sp.xml';
    const identityMapping = {
      fieldMappingSetId: 'saml-sp',
      destinationFieldPolicies: {
        mail: 'optional',
        displayName: 'optional',
        eduPersonAffiliation: 'optional',
      },
    };
    const settings = {
      entityId: 'https://sp.example.test',
      acsUrl: 'https://sp.example.test/old-acs',
      allowedBindings: ['post'],
      identityMapping,
      assertionValiditySeconds: 480,
      signResponses: false,
      signAssertions: true,
      metadataUrl: source,
      metadataRefreshPolicy: { mode: 'manual', intervalSeconds: 7200 },
      extension: { preserve: true },
    };
    adapter.queryOne.mockResolvedValue(providerRow({ config_json: JSON.stringify(settings) }));
    const metadataXml = validSpMetadata();
    const importedResponse = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          metadataXml,
          metadataUrl: source,
        },
      })
    );
    expect(importedResponse.status).toBe(200);
    const imported = await responseBody<{ config: Record<string, unknown>; updatedAt: string }>(
      importedResponse
    );
    expect(imported.config).toMatchObject({
      assertionValiditySeconds: 480,
      signResponses: false,
      signAssertions: true,
      identityMapping,
      metadataXml,
      metadataUrl: source,
      metadataRefreshPolicy: { mode: 'manual', intervalSeconds: 7200 },
      extension: { preserve: true },
    });
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
    adapter.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify(imported.config),
        updated_at: Date.parse(imported.updatedAt),
      })
    );
    const response = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: imported.updatedAt,
          config: { assertionValiditySeconds: 600, metadataRefreshPolicy: { mode: 'automatic' } },
        },
      })
    );
    expect(response.status).toBe(200);
    const saved = await responseBody<{ config: SAMLSPConfig }>(response);
    expect(await hasApprovedSAMLProviderTrust(saved.config)).toBe(true);
    expect(saved).toMatchObject({
      config: {
        ...imported.config,
        trustApproval: saved.config.trustApproval,
        assertionValiditySeconds: 600,
        metadataRefreshPolicy: {
          mode: 'automatic',
          intervalSeconds: 7200,
        },
      },
    });
    expect(String(adapter.execute.mock.calls.at(-1)?.[0])).toContain('AND updated_at = ?');
    const parameters: unknown = adapter.execute.mock.calls.at(-1)?.[1];
    if (!Array.isArray(parameters)) throw new Error('Missing update parameters');
    expect(parameters.at(-1)).toBe(Date.parse(imported.updatedAt));
  });

  it('fetches HTTPS metadata with a bounded response size', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());
    const response = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          metadataUrl: 'https://metadata.example.test/sp.xml',
        },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.clone().json()).toMatchObject({
      config: { metadataRefreshPolicy: { mode: 'automatic', intervalSeconds: 21_600 } },
    });
    const fetchCalls = mocks.safeFetchText.mock.calls as unknown as Array<
      [string, { maxResponseSize?: number }]
    >;
    expect(fetchCalls[0]?.[0]).toBe('https://metadata.example.test/sp.xml');
    expect(typeof fetchCalls[0]?.[1].maxResponseSize).toBe('number');
  });

  it.each([
    ['malformed XML', '<not-metadata/>'],
    ['aggregate XML', aggregateMetadata(2)],
  ])('rejects %s during metadata import', async (_name, metadataXml) => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const response = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: { expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(), metadataXml },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('does not expose metadata import persistence failures', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    mocks.adapter!.execute.mockRejectedValue(new Error('database unavailable'));
    const response = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          metadataXml: validSpMetadata(),
        },
      })
    );
    expect(response.status).toBe(500);
  });

  describe('single-connection metadata contract', () => {
    const updatedAt = new Date(1_700_000_001_000).toISOString();
    it('rejects missing and stale loaded versions before fetch, trust step-up or persistence', async () => {
      mocks.adapter?.queryOne.mockResolvedValue(providerRow());
      for (const expectedUpdatedAt of [undefined, new Date(1).toISOString()]) {
        const response = await handleImportMetadata(
          context({
            id: 'provider-a',
            body: {
              expectedUpdatedAt,
              metadataUrl: 'https://metadata.example.test/sp.xml',
            },
          })
        );
        expect(response.status).toBe(expectedUpdatedAt ? 409 : 400);
      }
      expect(mocks.safeFetchText).not.toHaveBeenCalled();
      expect(mocks.stepUp).not.toHaveBeenCalled();
      expect(mocks.adapter?.execute).not.toHaveBeenCalled();
    });

    it('rejects an atomic update conflict after fetch and step-up without auditing success', async () => {
      mocks.adapter?.queryOne.mockResolvedValue(providerRow());
      mocks.safeFetchText.mockResolvedValue(validSpMetadata());
      mocks.adapter?.execute.mockResolvedValueOnce({ rowsAffected: 0, insertId: undefined });
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: updatedAt,
            metadataUrl: 'https://metadata.example.test/sp.xml',
          },
        })
      );
      expect(response.status).toBe(409);
      expect(mocks.stepUp).toHaveBeenCalledTimes(1);
      expect(mocks.adapter?.execute).toHaveBeenCalledWith(
        expect.stringContaining('AND updated_at = ?'),
        [expect.any(String), 1, expect.any(Number), 'provider-a', 'tenant-a', 1_700_000_001_000]
      );
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('persists the reviewed URL snapshot without refetching and preserves mapping/version and advanced choices', async () => {
      const identityMapping = {
        fieldMappingSetId: 'saved-set',
        fieldMappingVersionId: 'pinned-v7',
        extension: 'keep',
      };
      const attributeMapping = { email: 'mail' };
      mocks.adapter?.queryOne.mockResolvedValue(
        providerRow({
          enabled: 0,
          config_json: JSON.stringify({
            entityId: 'urn:old',
            acsUrl: 'https://sp.example.test/old',
            identityMapping,
            attributeMapping,
            nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
            signAssertions: true,
            signResponses: false,
            authnRequestSignaturePolicy: 'required',
            minimumAal: 'aal2',
            minimumIal: 'ial2',
            custom_extension: { keep: true },
          }),
        })
      );
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: updatedAt,
            metadataXml: validSpMetadata(),
            metadataUrl: 'https://metadata.example.test/sp.xml',
          },
        })
      );
      expect(response.status).toBe(200);
      const body = await responseBody<{
        updatedAt: string;
        enabled: boolean;
        config: Record<string, unknown>;
      }>(response);
      expect(body.enabled).toBe(false);
      expect(Date.parse(body.updatedAt)).toBeGreaterThan(Date.parse(updatedAt));
      expect(body.config).toMatchObject({
        metadataXml: validSpMetadata(),
        metadataUrl: 'https://metadata.example.test/sp.xml',
        identityMapping,
        attributeMapping,
        signAssertions: true,
        signResponses: false,
        authnRequestSignaturePolicy: 'required',
        minimumAal: 'aal2',
        minimumIal: 'ial2',
        custom_extension: { keep: true },
      });
      expect(mocks.safeFetchText).not.toHaveBeenCalled();
      expect(mocks.stepUp).not.toHaveBeenCalled();
    });

    it('preserves IdP mapping, custom logo and JIT settings when importing new SSO details', async () => {
      const identityMapping = {
        fieldMappingSetId: 'inbound-set',
        fieldMappingVersionId: 'inbound-version',
      };
      const metadataXml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:synthetic:idp">
        <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
          <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>VEVTVA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/new-sso" />
        </md:IDPSSODescriptor></md:EntityDescriptor>`;
      mocks.adapter?.queryOne.mockResolvedValue(
        providerRow({
          provider_type: 'saml_idp',
          enabled: 0,
          config_json: JSON.stringify({
            entityId: 'urn:old:idp',
            ssoUrl: 'https://idp.example.test/old-sso',
            certificate: 'old-public-test-cert',
            identityMapping,
            attributeMapping: { email: 'mail' },
            logoUrl: 'https://idp.example.test/custom-logo.svg',
            jitEmailLinkingPolicy: 'disabled',
            allowSyntheticEmailFallback: false,
          }),
        })
      );
      const response = await handleImportMetadata(
        context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, metadataXml } })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        enabled: false,
        providerType: 'saml_idp',
        config: {
          entityId: 'urn:synthetic:idp',
          ssoUrl: 'https://idp.example.test/new-sso',
          metadataXml,
          identityMapping,
          attributeMapping: { email: 'mail' },
          logoUrl: 'https://idp.example.test/custom-logo.svg',
          jitEmailLinkingPolicy: 'disabled',
          allowSyntheticEmailFallback: false,
        },
      });
    });

    it('keeps preview/create and import permissions separate', async () => {
      const input = { providerType: 'saml_sp', metadataXml: validSpMetadata() };
      expect(
        (
          await handlePreviewMetadata(
            context({
              body: input,
              permissions: [ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_IMPORT],
            })
          )
        ).status
      ).toBe(403);
      expect(
        (
          await handleImportMetadata(
            context({
              id: 'provider-a',
              body: { ...input, expectedUpdatedAt: updatedAt },
              permissions: [ADMIN_PERMISSIONS.SAML_PROVIDERS_CREATE],
            })
          )
        ).status
      ).toBe(403);
      expect(mocks.adapter?.execute).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown role', { providerType: 'unknown', metadataXml: validSpMetadata() }],
      ['malformed', { providerType: 'saml_sp', metadataXml: '<EntityDescriptor' }],
      [
        'XXE',
        {
          providerType: 'saml_sp',
          metadataXml: '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///synthetic">]><x>&x;</x>',
        },
      ],
      [
        'aggregate',
        {
          providerType: 'saml_sp',
          metadataXml: aggregateMetadata().replace(
            '</md:EntitiesDescriptor>',
            validSpMetadata()
              .replace('<?xml version="1.0"?>', '')
              .replaceAll('https://sp.example.test', 'https://second.example.test') +
              '</md:EntitiesDescriptor>'
          ),
        },
      ],
      [
        'oversize',
        { providerType: 'saml_sp', metadataXml: validSpMetadata() + ' '.repeat(1024 * 1024) },
      ],
    ])('rejects %s single-connection HTTP preview bodies without saving', async (_label, body) => {
      const rawRequest = new Request(
        'https://authrim.example.test/api/admin/saml-metadata/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const response = await handlePreviewMetadata(context({ rawRequest }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
      expect(mocks.adapter?.execute).not.toHaveBeenCalled();
    });

    it('previews a bounded URL with its expected role and saves a disabled provider from that exact snapshot', async () => {
      mocks.safeFetchText.mockResolvedValue(validSpMetadata());
      const preview = await handlePreviewMetadata(
        context({
          body: { providerType: 'saml_sp', metadataUrl: 'https://metadata.example.test/sp.xml' },
        })
      );
      expect(preview.status).toBe(200);
      const result = await responseBody<{
        kind: string;
        config: { metadataXml: string; metadataUrl: string };
      }>(preview);
      expect(result.kind).toBe('single');
      expect(mocks.adapter?.execute).not.toHaveBeenCalled();
      expect(mocks.safeFetchText).toHaveBeenCalledWith('https://metadata.example.test/sp.xml', {
        timeoutMs: 10000,
        maxResponseSize: 1024 * 1024,
      });
      const created = await handleCreateProvider(
        context({
          body: {
            name: 'From reviewed snapshot',
            providerType: 'saml_sp',
            enabled: false,
            metadataXml: result.config.metadataXml,
            metadataUrl: result.config.metadataUrl,
          },
        })
      );
      expect(created.status).toBe(201);
      expect(mocks.safeFetchText).toHaveBeenCalledTimes(1);
      expect(persistedConfig()).toMatchObject({
        metadataXml: validSpMetadata(),
        metadataUrl: 'https://metadata.example.test/sp.xml',
      });
    });
  });

  it('requires an existing provider and configured URL for refresh', async () => {
    expect((await handleRefreshMetadata(context({ body: {} }))).status).toBe(404);
    expect((await handleRefreshMetadata(context({ id: 'missing', body: {} }))).status).toBe(404);

    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    expect((await handleRefreshMetadata(context({ id: 'provider-a', body: {} }))).status).toBe(400);
  });

  it('rejects unsafe refresh URLs and upstream fetch failures', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    let response = await handleRefreshMetadata(
      context({ id: 'provider-a', body: { metadataUrl: 'http://metadata.example.test/sp.xml' } })
    );
    expect(response.status).toBe(400);

    mocks.safeFetchText.mockRejectedValue(new Error('upstream unavailable'));
    response = await handleRefreshMetadata(
      context({
        id: 'provider-a',
        body: { metadataUrl: 'https://metadata.example.test/sp.xml' },
      })
    );
    expect(response.status).toBe(400);
  });

  it('refreshes configured metadata and records its changed state', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/old-acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());
    const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, enabled: true });
    expect(mocks.adapter!.execute).toHaveBeenCalled();
  });

  it('writes nothing when a fetch from a different URL fails (the refresh policy is kept)', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/original.xml',
          metadataRefreshPolicy: { mode: 'manual' },
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockRejectedValue(new Error('unreachable'));

    const response = await handleRefreshMetadata(
      context({
        id: 'provider-a',
        body: { metadataUrl: 'https://metadata.example.test/other.xml' },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('keeps configured-URL refresh available to a refresh-only administrator', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/old-acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());

    const response = await handleRefreshMetadata(
      context({
        id: 'provider-a',
        body: {},
        permissions: [ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_REFRESH],
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.safeFetchText).toHaveBeenCalledOnce();
  });

  it('requires provider-update permission before fetching a different metadata URL', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/original.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );

    const response = await handleRefreshMetadata(
      context({
        id: 'provider-a',
        body: { metadataUrl: 'https://metadata.example.test/rebound.xml' },
        permissions: [ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_REFRESH],
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('requires provider-update permission before approving an entityID rebind', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://old-sp.example.test',
          acsUrl: 'https://old-sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());

    const response = await handleRefreshMetadata(
      context({
        id: 'provider-a',
        body: { allowEntityIdChange: true },
        permissions: [ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_REFRESH],
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('allows an explicitly approved entityID rebind with both permissions', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://old-sp.example.test',
          acsUrl: 'https://old-sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());

    const response = await handleRefreshMetadata(
      context({
        id: 'provider-a',
        body: { allowEntityIdChange: true },
        permissions: [
          ADMIN_PERMISSIONS.SAML_PROVIDERS_METADATA_REFRESH,
          ADMIN_PERMISSIONS.SAML_PROVIDERS_UPDATE,
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.adapter!.execute).toHaveBeenCalledOnce();
  });

  it('does not overwrite a provider edited while manual metadata refresh is in progress', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/old-acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());
    mocks.adapter!.execute.mockResolvedValue({ rowsAffected: 0, insertId: undefined });

    const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));

    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).toHaveBeenCalledTimes(1);
    expect(String(mocks.adapter!.execute.mock.calls[0]?.[0])).toContain('AND updated_at = ?');
    expect(mocks.adapter!.execute.mock.calls[0]?.[1]?.at(-1)).toBe(1_700_000_001_000);
  });

  it('updates only refresh mode while preserving its stored interval and operational state', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Expected adapter fixture');
    adapter.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          allowedBindings: ['post'],
          identityMapping: {
            fieldMappingSetId: 'saml-sp',
            destinationFieldPolicies: {
              mail: 'optional',
              displayName: 'optional',
              eduPersonAffiliation: 'optional',
            },
          },
          metadataUrl: 'https://metadata.example.test/sp.xml',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 7200,
            sourceState: 'healthy',
            consecutiveFailures: 2,
          },
        }),
      })
    );
    const response = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          config: { metadataRefreshPolicy: { mode: 'manual' } },
        },
      })
    );
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      config: {
        metadataRefreshPolicy: {
          mode: 'manual',
          intervalSeconds: 7200,
          sourceState: 'healthy',
          consecutiveFailures: 2,
        },
      },
    });
  });

  it('keeps last-known-good metadata when a manual refresh returns expired metadata', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/old-acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          metadataXml: '<old-metadata/>',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(
      validSpMetadata().replace(
        'entityID="https://sp.example.test"',
        'entityID="https://sp.example.test" validUntil="2020-01-01T00:00:00Z"'
      )
    );

    const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, expired: true, enabled: false });
    const persisted = JSON.parse(String(mocks.adapter!.execute.mock.calls.at(-1)?.[1]?.[0])) as {
      metadataXml: string;
      metadataRefreshPolicy: {
        sourceState: string;
        lastErrorCode: string;
        suspendedByMetadataSync: boolean;
      };
    };
    expect(persisted.metadataXml).toBe('<old-metadata/>');
    expect(persisted.metadataRefreshPolicy).toMatchObject({
      sourceState: 'expired',
      lastErrorCode: 'metadata_expired',
      suspendedByMetadataSync: true,
    });
    expect(mocks.adapter!.execute.mock.calls.at(-1)?.[1]?.[1]).toBe(0);
  });

  it('saves nothing when expired metadata comes from another URL (the refresh policy is kept)', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/old-acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          metadataRefreshPolicy: { mode: 'manual' },
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(
      validSpMetadata().replace(
        'entityID="https://sp.example.test"',
        'entityID="https://sp.example.test" validUntil="2020-01-01T00:00:00Z"'
      )
    );

    const response = await handleRefreshMetadata(
      context({
        id: 'provider-a',
        body: { metadataUrl: 'https://metadata.example.test/other.xml' },
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('rejects and records an unexpected entityID change during manual refresh', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://old-sp.example.test',
          acsUrl: 'https://old-sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());

    const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));

    expect(response.status).toBe(400);
    const persisted = JSON.parse(String(mocks.adapter!.execute.mock.calls.at(-1)?.[1]?.[0])) as {
      entityId: string;
      metadataRefreshPolicy: { sourceState: string; lastErrorCode: string };
    };
    expect(persisted.entityId).toBe('https://old-sp.example.test');
    expect(persisted.metadataRefreshPolicy).toMatchObject({
      sourceState: 'identity_change_pending',
      lastErrorCode: 'entity_id_change_pending',
    });
  });

  it('manually refreshes a federation source with the metadata refresh permission', async () => {
    mocks.refreshFederationSource.mockResolvedValue({
      sourceId: 'source-a',
      changed: true,
      entityCount: 2,
      providersUpdated: 1,
      providersMissing: 0,
      providersFailed: 0,
      verificationStatus: 'verified',
    });

    const response = await handleRefreshFederationMetadataSource(
      context({ id: 'source-a', tenantId: 'tenant-a' })
    );

    expect(response.status).toBe(200);
    expect(mocks.refreshFederationSource).toHaveBeenCalledWith(
      expect.anything(),
      'source-a',
      'tenant-a',
      'manual',
      undefined,
      expect.any(Function)
    );
  });

  it('returns conflict when another federation refresh owns the source lease', async () => {
    mocks.refreshFederationSource.mockRejectedValue(new Error('metadata_refresh_conflict'));

    const response = await handleRefreshFederationMetadataSource(
      context({ id: 'source-a', tenantId: 'tenant-a' })
    );

    expect(response.status).toBe(409);
  });

  it.each(['import', 'refresh', 'poll'])(
    'creates from a single-entity URL preview and applies certificate and endpoint changes through %s',
    async (operation) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing test adapter');
      const metadataUrl = 'https://metadata.example.test/wrapped.xml';
      mocks.safeFetchText.mockResolvedValue(aggregateMetadata());
      const previewResponse = await handlePreviewMetadata(
        context({ body: { providerType: 'saml_sp', metadataUrl } })
      );
      expect(previewResponse.status).toBe(200);
      const preview = await responseBody<{ config: { metadataXml: string; metadataUrl: string } }>(
        previewResponse
      );
      const createResponse = await handleCreateProvider(
        context({
          body: {
            name: 'Single wrapped entity',
            providerType: 'saml_sp',
            enabled: false,
            metadataXml: preview.config.metadataXml,
            metadataUrl: preview.config.metadataUrl,
          },
        })
      );
      expect(createResponse.status).toBe(201);
      const created = await responseBody<{ config: SAMLSPConfig; updatedAt: string }>(
        createResponse
      );
      expect(created.config.aggregateImport).toBeUndefined();
      expect(created.config.metadataUrl).toBe(metadataUrl);
      const row = providerRow({
        enabled: 0,
        config_json: JSON.stringify(created.config),
        updated_at: Date.parse(created.updatedAt),
      });
      adapter.queryOne.mockResolvedValue(row);
      adapter.query.mockImplementation(async (sql: string) =>
        sql.includes('FROM identity_providers') ? [row] : []
      );
      adapter.execute.mockClear();
      const signingKey = await generateKeyPair('RS256', { extractable: true });
      const certificate = await generateSelfSignedCertificate(
        await exportJWK(signingKey.publicKey),
        await exportPKCS8(signingKey.privateKey)
      );
      const certificateBody = certificate.replace(
        /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g,
        ''
      );
      const updatedMetadata = aggregateMetadata()
        .replace('https://sp.example.test/acs', 'https://sp.example.test/rotated-acs')
        .replace(
          '</md:SPSSODescriptor>',
          `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${certificateBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor></md:SPSSODescriptor>`
        );
      mocks.safeFetchText.mockResolvedValue(updatedMetadata);
      if (operation === 'poll') {
        mocks.safeFetch.mockResolvedValue(new Response(updatedMetadata));
        const { pollSAMLMetadata } =
          await vi.importActual<typeof import('../metadata-polling')>('../metadata-polling');
        expect(await pollSAMLMetadata(context().env, Date.now() + 86_400_000)).toMatchObject({
          individualProvidersProcessed: 1,
          individualProvidersFailed: 0,
        });
        expect(mocks.safeFetch).toHaveBeenCalledOnce();
      } else {
        const refreshed =
          operation === 'import'
            ? await handleImportMetadata(
                context({
                  id: row.id,
                  body: { metadataUrl, expectedUpdatedAt: created.updatedAt },
                })
              )
            : await handleRefreshMetadata(context({ id: row.id, body: {} }));
        expect(refreshed.status).toBe(200);
        expect(await refreshed.json()).toMatchObject({
          config: { acsUrl: 'https://sp.example.test/rotated-acs', metadataUrl },
        });
      }
      const parameters: unknown = adapter.execute.mock.calls.at(-1)?.[1];
      if (!Array.isArray(parameters)) throw new Error('Missing metadata update');
      const persisted: unknown = JSON.parse(String(parameters[0]));
      expect(persisted).toMatchObject({
        entityId: 'https://sp.example.test',
        acsUrl: 'https://sp.example.test/rotated-acs',
        certificates: [expect.stringContaining(certificateBody)],
        metadataUrl,
        metadataRefreshPolicy: { sourceState: 'healthy', consecutiveFailures: 0 },
      });
      expect(persisted).not.toHaveProperty('aggregateImport');
      expect(JSON.stringify(persisted)).not.toContain('EntitiesDescriptor');
    }
  );

  it.each([1, 2])(
    'creates from a wrapped metadata URL only when it has one entity (%i)',
    async (count) => {
      mocks.safeFetchText.mockResolvedValue(aggregateMetadata(count));
      const response = await handleCreateProvider(
        context({
          body: {
            name: 'Wrapped URL',
            providerType: 'saml_sp',
            enabled: false,
            metadataUrl: 'https://metadata.example.test/wrapped.xml',
          },
        })
      );
      expect(response.status).toBe(count === 1 ? 201 : 400);
      if (count === 1) {
        expect(persistedConfig()).toMatchObject({
          entityId: 'https://sp.example.test',
          metadataUrl: 'https://metadata.example.test/wrapped.xml',
        });
      } else expect(mocks.adapter?.execute).not.toHaveBeenCalled();
    }
  );

  it.each(['import', 'refresh', 'poll'])(
    'refuses a different entity from a wrapped metadata URL through %s',
    async (operation) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing test adapter');
      const metadataUrl = 'https://metadata.example.test/wrapped.xml';
      const row = providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl,
          metadataRefreshPolicy: { mode: 'automatic', intervalSeconds: 21_600, nextRefreshAt: 0 },
        }),
      });
      adapter.queryOne.mockResolvedValue(row);
      adapter.query.mockImplementation(async (sql: string) =>
        sql.includes('FROM identity_providers') ? [row] : []
      );
      const changed = aggregateMetadata().replaceAll(
        'https://sp.example.test',
        'https://other.test'
      );
      mocks.safeFetchText.mockResolvedValue(changed);
      if (operation === 'poll') {
        mocks.safeFetch.mockResolvedValue(new Response(changed));
        const { pollSAMLMetadata } =
          await vi.importActual<typeof import('../metadata-polling')>('../metadata-polling');
        expect(await pollSAMLMetadata(context().env)).toMatchObject({
          individualProvidersProcessed: 0,
          individualProvidersFailed: 1,
        });
      } else {
        const rejected =
          operation === 'import'
            ? await handleImportMetadata(
                context({
                  id: row.id,
                  body: { metadataUrl, expectedUpdatedAt: new Date(row.updated_at).toISOString() },
                })
              )
            : await handleRefreshMetadata(context({ id: row.id, body: {} }));
        expect(rejected.status).toBe(400);
      }
      if (operation === 'import') expect(adapter.execute).not.toHaveBeenCalled();
      else {
        const parameters: unknown = adapter.execute.mock.calls.at(-1)?.[1];
        if (!Array.isArray(parameters)) throw new Error('Missing refresh failure state');
        const persisted: unknown = JSON.parse(String(parameters[0]));
        expect(persisted).toMatchObject({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataRefreshPolicy: { sourceState: 'identity_change_pending' },
        });
      }
    }
  );

  it('rejects multi-entity aggregate refresh without the stored aggregate entity snapshot', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/aggregate.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(aggregateMetadata(2));
    const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));
    expect(response.status).toBe(400);
  });

  it('rejects a single-entity downgrade when refreshing an aggregate-linked provider', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          metadataUrl: 'https://metadata.example.test/aggregate.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/aggregate.xml',
            aggregateEntityId: 'https://sp.example.test',
            verification: {
              status: 'verified',
              policy: 'strict',
              trustProfileId: 'source-a',
              trustContextSnapshotHash: 'trust-hash-a',
            },
            importedAt: 1,
          },
        }),
      })
    );
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());

    const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));

    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).toHaveBeenCalledOnce();
    const persisted = JSON.parse(String(mocks.adapter!.execute.mock.calls[0]?.[1]?.[0])) as {
      metadataRefreshPolicy: { sourceState: string; lastErrorCode: string };
    };
    expect(persisted.metadataRefreshPolicy).toMatchObject({
      sourceState: 'error',
      lastErrorCode: 'metadata_validation_failed',
    });
  });
});

function validSpMetadata() {
  return `<?xml version="1.0"?>
  <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
    entityID="https://sp.example.test">
    <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:AssertionConsumerService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="https://sp.example.test/acs" index="0" isDefault="true" />
    </md:SPSSODescriptor>
  </md:EntityDescriptor>`;
}

function validIdpMetadata(certificate: string, nameIdFormat?: string) {
  const body = certificate.replace(
    /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g,
    ''
  );
  return `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:imported:idp">
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      ${nameIdFormat ? `<md:NameIDFormat>${nameIdFormat}</md:NameIDFormat>` : ''}
      <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.test/sso" />
    </md:IDPSSODescriptor>
  </md:EntityDescriptor>`;
}

function aggregateMetadata(entityCount = 1) {
  return `<?xml version="1.0"?>
  <md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">
    ${Array.from({ length: entityCount }, (_, index) =>
      validSpMetadata()
        .replace('<?xml version="1.0"?>', '')
        .replaceAll(
          'https://sp.example.test',
          index === 0 ? 'https://sp.example.test' : `https://sp-${index}.example.test`
        )
    ).join('')}
  </md:EntitiesDescriptor>`;
}

describe('SAML trust changes need a step-up', () => {
  const refusal = () =>
    new Response(JSON.stringify({ error: 'step_up_required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  const HEX64 = /^[0-9a-f]{64}$/;
  const effectiveConfigDigest: unknown = expect.stringMatching(HEX64);
  const spConfig = {
    entityId: 'https://sp-new.example.test',
    acsUrl: 'https://sp-new.example.test/acs',
    identityMapping: {
      fieldMappingSetId: 'saml-sp',
      destinationFieldPolicies: {
        mail: 'optional',
        displayName: 'optional',
        eduPersonAffiliation: 'optional',
      },
    },
  };
  const updatedAt = new Date(1_700_000_001_000).toISOString();
  const rolloverRow = () =>
    providerRow({
      config_json: JSON.stringify({
        entityId: 'https://sp.example.test',
        acsUrl: 'https://sp.example.test/acs',
        signingKeyPolicy: {
          active: { slot: 'active', keyRef: 'tenant:tenant-a:saml:idp:signing', state: 'active' },
          next: {
            slot: 'next',
            keyRef: 'tenant:tenant-a:saml:idp:next:signing',
            certificate: 'NEXT-CERT',
            state: 'published_next',
          },
        },
      }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = createAdapter();
    mocks.stepUp.mockResolvedValue(null);
    mocks.runtimeBinding = {
      fieldMappingSetId: 'saml-sp',
      fieldMappingVersionId: 'version-1',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    };
    mocks.destinationDescriptor = {
      profileId: 'destination-profile-saml',
      profileVersionId: 'destination-profile-saml-v1',
      destinationType: 'saml',
      fields: [{ key: 'mail' }, { key: 'displayName' }, { key: 'eduPersonAffiliation' }],
    };
  });

  it.each(['saml_sp', 'saml_idp'])('creates a disabled %s draft at L0', async (providerType) => {
    const response = await handleCreateProvider(
      context({ body: { name: 'Draft', providerType, enabled: false } })
    );
    expect(response.status).toBe(201);
    expect(mocks.stepUp).not.toHaveBeenCalled();
    expect(mocks.adapter?.execute).toHaveBeenCalledTimes(1);
  });

  it('edits a disabled provider and imports its metadata at L0', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    adapter.queryOne.mockResolvedValue(providerRow({ enabled: 0 }));
    const edited = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: updatedAt,
          config: { acsUrl: 'https://sp.example.test/draft-acs' },
          name: 'Draft edit',
        },
      })
    );
    expect(edited.status).toBe(200);
    adapter.queryOne.mockResolvedValue(providerRow({ enabled: 0 }));
    const imported = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: updatedAt,
          metadataXml: validSpMetadata(),
        },
      })
    );
    expect(imported.status).toBe(200);
    expect(mocks.stepUp).not.toHaveBeenCalled();
    expect(adapter.execute).toHaveBeenCalledTimes(2);
  });

  it('requires L2 for activation and binds even a config-free PUT to the configuration being activated', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    const refused = () =>
      new Response(JSON.stringify({ error: 'step_up_required', required_level: 'L2' }), {
        status: 403,
      });
    mocks.stepUp.mockImplementation(async () => refused());
    const request = () =>
      context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, enabled: true } });
    adapter.queryOne.mockResolvedValue(providerRow({ enabled: 0 }));
    const first = await handleUpdateProvider(request());
    expect(first.status).toBe(403);
    expect(await first.json()).toMatchObject({ error: 'step_up_required', required_level: 'L2' });
    const original = mocks.stepUp.mock.calls[0]?.[1];
    expect(original).toMatchObject({
      operation: 'federation.trust.activate',
      params: {
        enabled: true,
        effective_config_sha256: effectiveConfigDigest,
      },
    });
    await handleUpdateProvider(request());
    expect(mocks.stepUp.mock.calls[1]?.[1]).toEqual(original);
    adapter.queryOne.mockResolvedValue(
      providerRow({
        enabled: 0,
        config_json: JSON.stringify({ ...spConfig, acsUrl: 'https://changed.example.test/acs' }),
      })
    );
    await handleUpdateProvider(request());
    expect(mocks.stepUp.mock.calls[2]?.[1]).not.toEqual(original);
    expect(adapter.execute).not.toHaveBeenCalled();
    mocks.stepUp.mockResolvedValue(null);
  });

  it('requires fresh L2 approval to activate a tenant-cloned provider after selecting a destination mapping', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    adapter.queryOne.mockResolvedValue(
      providerRow({
        id: 'cloned-provider',
        enabled: 0,
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/acs',
          trustApproval: { state: 'draft' },
          identityMapping: { inboundContract: 'connection-v1' },
        }),
      })
    );
    const request = () =>
      context({
        id: 'cloned-provider',
        body: {
          expectedUpdatedAt: updatedAt,
          enabled: true,
          config: { identityMapping: spConfig.identityMapping },
        },
      });
    mocks.stepUp.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'step_up_required',
          required_level: 'L2',
        }),
        { status: 403 }
      )
    );
    const refused = await handleUpdateProvider(request());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ required_level: 'L2' });
    expect(mocks.stepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'federation.trust.activate',
        targetIds: ['cloned-provider'],
      })
    );
    expect(adapter.execute).not.toHaveBeenCalled();
    expect((await handleUpdateProvider(request())).status).toBe(200);
    const params: unknown = adapter.execute.mock.calls[0]?.[1];
    if (!Array.isArray(params)) throw new Error('Missing activated provider');
    const saved: unknown = JSON.parse(String(params[1]));
    expect(params[2]).toBe(1);
    expect(saved).toMatchObject({ trustApproval: { state: 'approved' } });
  });

  it('requires L1 before disabling and allows a rename with unchanged config at L0', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    adapter.queryOne.mockResolvedValue(providerRow());
    const renamed = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: {
          expectedUpdatedAt: updatedAt,
          name: 'Renamed',
          config: { acsUrl: 'https://sp.example.test/acs' },
        },
      })
    );
    expect(renamed.status).toBe(200);
    expect(mocks.stepUp).not.toHaveBeenCalled();
    adapter.execute.mockClear();
    mocks.stepUp.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'admin_fresh_auth_required', required_level: 'L1' }), {
        status: 403,
      })
    );
    const disabled = await handleUpdateProvider(
      context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, enabled: false } })
    );
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ required_level: 'L1' });
    expect(mocks.stepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'federation.trust.disable' })
    );
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['mapping', 'jit', 'import'])(
    'protects metadata-suspended trust changes at L2: %s',
    async (operation) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing adapter');
      adapter.queryOne.mockResolvedValue(
        providerRow({
          enabled: 0,
          config_json: JSON.stringify({
            ...spConfig,
            metadataRefreshPolicy: {
              mode: 'automatic',
              intervalSeconds: 21600,
              suspendedByMetadataSync: true,
              sourceState: 'expired',
            },
          }),
        })
      );
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response =
        operation === 'import'
          ? await handleImportMetadata(
              context({
                id: 'provider-a',
                body: { expectedUpdatedAt: updatedAt, metadataXml: validSpMetadata() },
              })
            )
          : await handleUpdateProvider(
              context({
                id: 'provider-a',
                body: {
                  expectedUpdatedAt: updatedAt,
                  config:
                    operation === 'mapping'
                      ? { identityMapping: { fieldMappingSetId: 'changed' } }
                      : { jitEmailLinkingPolicy: 'email_linking' },
                },
              })
            );
      expect(response.status).toBe(403);
      expect(mocks.stepUp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'federation.trust.activate' })
      );
      expect(adapter.execute).not.toHaveBeenCalled();
    }
  );

  it('requires L2 to delete or move an authoritative entity that masks federation trust', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    adapter.queryOne.mockResolvedValue(providerRow({ enabled: 0 }));
    adapter.query.mockImplementation(async (sql: string) =>
      sql.includes('federation_saml_runtime_entities')
        ? [{ entity_id: 'https://sp.example.test' }]
        : []
    );
    mocks.stepUp.mockResolvedValueOnce(refusal());
    const deleted = await handleDeleteProvider(context({ id: 'provider-a' }));
    expect(deleted.status).toBe(403);
    expect(mocks.stepUp).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'federation.trust.activate' })
    );
    mocks.stepUp.mockResolvedValueOnce(refusal());
    const moved = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: { expectedUpdatedAt: updatedAt, config: { entityId: 'urn:moved' } },
      })
    );
    expect(moved.status).toBe(403);
    expect(mocks.stepUp).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'federation.trust.activate' })
    );
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it.each(['import', 'refresh'])(
    'requires L2 when %s moves a disabled authoritative entity away from federation',
    async (operation) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing adapter');
      adapter.queryOne.mockResolvedValue(
        providerRow({
          enabled: 0,
          config_json: JSON.stringify({
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            metadataUrl: 'https://metadata.example.test/sp.xml',
          }),
        })
      );
      adapter.query.mockImplementation(async (sql: string) =>
        sql.includes('federation_saml_runtime_entities')
          ? [{ entity_id: 'https://sp.example.test' }]
          : []
      );
      const metadataXml = validSpMetadata().replaceAll(
        'https://sp.example.test',
        'https://moved.example.test'
      );
      mocks.safeFetchText.mockResolvedValue(metadataXml);
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const request = () =>
        operation === 'import'
          ? handleImportMetadata(
              context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, metadataXml } })
            )
          : handleRefreshMetadata(
              context({ id: 'provider-a', body: { allowEntityIdChange: true } })
            );
      const response = await request();
      expect(response.status).toBe(403);
      expect(mocks.stepUp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ operation: 'federation.trust.activate' })
      );
      expect(adapter.execute).not.toHaveBeenCalled();
      // An accepted L2 retry may move the entity and records approval for the new settings.
      expect((await request()).status).toBe(200);
      const params: unknown = adapter.execute.mock.calls[0]?.[1];
      if (!Array.isArray(params)) throw new Error('Missing saved configuration');
      const saved: unknown = JSON.parse(String(params[0]));
      expect(saved).toMatchObject({
        entityId: 'https://moved.example.test',
        trustApproval: { state: 'approved' },
      });
    }
  );

  it.each(['import', 'refresh'])(
    'keeps an unapproved draft entity move at L0 for %s without shadowing federation',
    async (operation) => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing adapter');
      adapter.queryOne.mockResolvedValue(
        providerRow({
          enabled: 0,
          config_json: JSON.stringify({
            entityId: 'urn:unapproved',
            acsUrl: 'https://sp.example.test/acs',
            metadataUrl: 'https://metadata.example.test/sp.xml',
            trustApproval: { state: 'draft' },
          }),
        })
      );
      adapter.query.mockImplementation(async (sql: string) =>
        sql.includes('federation_saml_runtime_entities') ? [{ entity_id: 'urn:unapproved' }] : []
      );
      mocks.safeFetchText.mockResolvedValue(validSpMetadata());
      const response =
        operation === 'import'
          ? await handleImportMetadata(
              context({
                id: 'provider-a',
                body: { expectedUpdatedAt: updatedAt, metadataXml: validSpMetadata() },
              })
            )
          : await handleRefreshMetadata(
              context({
                id: 'provider-a',
                body: { allowEntityIdChange: true },
              })
            );
      expect(response.status).toBe(200);
      expect(mocks.stepUp).not.toHaveBeenCalled();
      const params: unknown = adapter.execute.mock.calls[0]?.[1];
      if (!Array.isArray(params)) throw new Error('Missing saved draft');
      const saved: unknown = JSON.parse(String(params[0]));
      expect(saved).toMatchObject({
        entityId: 'https://sp.example.test',
        trustApproval: { state: 'draft' },
      });
    }
  );

  it('binds aggregate updates identically after verification clocks advance on receipt retry', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const current = {
        ...spConfig,
        aggregateImport: {
          aggregateEntityId: spConfig.entityId,
          importedAt: 100,
          verification: { status: 'skipped', policy: 'disabled', verifiedAt: 100 },
        },
      };
      adapter.queryOne.mockResolvedValue(providerRow({ config_json: JSON.stringify(current) }));
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const request = () =>
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: updatedAt,
            config: { acsUrl: 'https://new.example.test/acs' },
          },
        });
      expect((await handleUpdateProvider(request())).status).toBe(403);
      const original = mocks.stepUp.mock.calls[0]?.[1];
      vi.setSystemTime(Date.now() + 60_000);
      current.aggregateImport.verification.verifiedAt += 60_000;
      current.aggregateImport.importedAt += 60_000;
      adapter.queryOne.mockResolvedValue(providerRow({ config_json: JSON.stringify(current) }));
      expect((await handleUpdateProvider(request())).status).toBe(200);
      expect(mocks.stepUp.mock.calls[1]?.[1]).toEqual(original);
      const params: unknown = adapter.execute.mock.calls[0]?.[1];
      if (!Array.isArray(params)) throw new Error('Missing saved configuration');
      const saved: unknown = JSON.parse(String(params[1]));
      expect(saved).toMatchObject({ trustApproval: { state: 'approved' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores client-supplied approval and accepts a fetched config without trusting its approval', async () => {
    const adapter = mocks.adapter;
    if (!adapter) throw new Error('Missing adapter');
    const trustApproval = { state: 'approved', digest: 'forged' };
    const created = await handleCreateProvider(
      context({
        body: {
          name: 'Unapproved',
          providerType: 'saml_sp',
          enabled: false,
          config: { ...spConfig, trustApproval },
        },
      })
    );
    expect(created.status).toBe(201);
    expect(persistedConfig()).toMatchObject({ trustApproval: { state: 'draft' } });
    adapter.execute.mockClear();
    const storedConfig = { ...spConfig, trustApproval: { state: 'draft' } };
    adapter.queryOne.mockResolvedValue(
      providerRow({ enabled: 0, config_json: JSON.stringify(storedConfig) })
    );
    const fetched = await handleGetProvider(context({ id: 'provider-a' }));
    expect(fetched.status).toBe(200);
    const provider = await responseBody<{ config: unknown }>(fetched);
    const update = await handleUpdateProvider(
      context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, config: provider.config } })
    );
    expect(update.status).toBe(200);
    const forged = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: { expectedUpdatedAt: updatedAt, config: { trustApproval } },
      })
    );
    expect(forged.status).toBe(200);
    for (const call of adapter.execute.mock.calls) {
      const params: unknown = call[1];
      if (!Array.isArray(params)) throw new Error('Missing saved configuration');
      const saved: unknown = JSON.parse(String(params[1]));
      expect(saved).toMatchObject({ trustApproval: { state: 'draft' } });
    }
    expect(mocks.stepUp).not.toHaveBeenCalled();
  });

  describe('create', () => {
    const request = () =>
      context({ body: { name: 'New SP', providerType: 'saml_sp', config: spConfig } });

    it('writes nothing while the gate refuses', async () => {
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handleCreateProvider(request());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'step_up_required' });
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('goes ahead when the gate lets it, with a descriptor built from the request', async () => {
      const response = await handleCreateProvider(request());
      expect(response.status).toBe(201);
      expect(mocks.adapter!.execute).toHaveBeenCalledTimes(1);
      expect(mocks.stepUp).toHaveBeenCalledTimes(1);
      expect(mocks.stepUp.mock.calls[0]?.[1]).toEqual({
        operation: 'federation.trust.activate',
        targetTenantId: 'tenant-a',
        params: {
          action: 'provider.create',
          providerType: 'saml_sp',
          name: 'New SP',
          enabled: true,
          request_sha256: expect.stringMatching(HEX64) as string,
          effective_config_sha256: effectiveConfigDigest,
        },
      });
    });

    it('builds the same descriptor for the same request', async () => {
      await handleCreateProvider(request());
      await handleCreateProvider(request());
      expect(mocks.stepUp.mock.calls[1]?.[1]).toEqual(mocks.stepUp.mock.calls[0]?.[1]);
    });

    it('does not call the gate for an invalid request or a conflict', async () => {
      expect(
        (await handleCreateProvider(context({ body: { name: 'x', providerType: 'nope' } }))).status
      ).toBe(400);
      mocks.adapter!.query.mockResolvedValue([
        { id: 'other', config_json: JSON.stringify({ entityId: spConfig.entityId }) },
      ]);
      expect((await handleCreateProvider(request())).status).toBe(409);
      expect(mocks.stepUp).not.toHaveBeenCalled();
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('writes nothing while the gate refuses', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handleUpdateProvider(
        context({
          id: 'provider-a',
          body: { expectedUpdatedAt: updatedAt, config: { acsUrl: 'https://sp.example.test/new' } },
        })
      );
      expect(response.status).toBe(403);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('goes ahead when the gate lets it, with the config as a digest', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      const response = await handleUpdateProvider(
        context({
          id: 'provider-a',
          body: { expectedUpdatedAt: updatedAt, config: { acsUrl: 'https://sp.example.test/new' } },
        })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter!.execute).toHaveBeenCalledTimes(1);
      expect(mocks.stepUp.mock.calls[0]?.[1]).toEqual({
        operation: 'federation.trust.activate',
        targetTenantId: 'tenant-a',
        targetIds: ['provider-a'],
        params: {
          action: 'provider.update',
          expectedUpdatedAt: updatedAt,
          config_sha256: expect.stringMatching(HEX64) as string,
          effective_config_sha256: effectiveConfigDigest,
        },
      });
    });

    it('does not call the gate before the stale-edit and not-found checks', async () => {
      expect((await handleUpdateProvider(context({ id: 'missing', body: {} }))).status).toBe(404);
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      expect(
        (
          await handleUpdateProvider(
            context({
              id: 'provider-a',
              body: { expectedUpdatedAt: new Date(1).toISOString(), config: {} },
            })
          )
        ).status
      ).toBe(409);
      expect(mocks.stepUp).not.toHaveBeenCalled();
    });

    it('lets a rename through at L0 and requires L1 to disable', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      let response = await handleUpdateProvider(
        context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, name: 'Renamed' } })
      );
      expect(response.status).toBe(200);
      expect(mocks.stepUp).not.toHaveBeenCalled();
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      response = await handleUpdateProvider(
        context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, enabled: false } })
      );
      expect(response.status).toBe(200);
      expect(mocks.stepUp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'federation.trust.disable',
        })
      );
    });

    it('gates an enable', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow({ enabled: 0 }));
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handleUpdateProvider(
        context({ id: 'provider-a', body: { expectedUpdatedAt: updatedAt, enabled: true } })
      );
      expect(response.status).toBe(403);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes nothing while the gate refuses', async () => {
      mocks.adapter!.queryOne.mockResolvedValue({ id: 'provider-a' });
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handleDeleteProvider(context({ id: 'provider-a' }));
      expect(response.status).toBe(403);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('deletes when the gate lets it, naming the provider', async () => {
      mocks.adapter!.queryOne.mockResolvedValue({ id: 'provider-a' });
      const response = await handleDeleteProvider(context({ id: 'provider-a' }));
      expect(response.status).toBe(200);
      expect(mocks.adapter!.execute).toHaveBeenCalledTimes(1);
      expect(mocks.stepUp.mock.calls[0]?.[1]).toEqual({
        operation: 'federation.trust.disable',
        targetTenantId: 'tenant-a',
        targetIds: ['provider-a'],
        params: { action: 'provider.delete' },
      });
    });
  });

  describe('import metadata', () => {
    it('writes nothing while the gate refuses', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
            metadataXml: validSpMetadata(),
          },
        })
      );
      expect(response.status).toBe(403);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('goes ahead when the gate lets it, with the metadata as a digest', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
            metadataXml: validSpMetadata(),
          },
        })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter!.execute).toHaveBeenCalledTimes(1);
      const descriptor = mocks.stepUp.mock.calls[0]?.[1] as {
        targetIds: string[];
        params: Record<string, unknown>;
      };
      expect(descriptor.targetIds).toEqual(['provider-a']);
      expect(descriptor.params.action).toBe('provider.import_metadata');
      expect(descriptor.params.metadata_sha256).toMatch(HEX64);
      expect(JSON.stringify(descriptor)).not.toContain('EntityDescriptor');
    });

    it('binds the URL, not the fetched document, when importing from a URL', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      mocks.safeFetchText.mockResolvedValue(validSpMetadata());
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
            metadataUrl: 'https://metadata.example.test/sp.xml',
          },
        })
      );
      expect(response.status).toBe(200);
      const descriptor = mocks.stepUp.mock.calls[0]?.[1] as { params: Record<string, unknown> };
      // A document re-signed between the refused request and its repeat still matches.
      expect(descriptor.params).not.toHaveProperty('metadata_sha256');
      expect(descriptor.params.metadataUrl).toBe('https://metadata.example.test/sp.xml');
    });

    it('does not call the gate for invalid metadata', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      const response = await handleImportMetadata(
        context({
          id: 'provider-a',
          body: {
            expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
            metadataXml: '<not-metadata/>',
          },
        })
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mocks.stepUp).not.toHaveBeenCalled();
    });
  });

  describe('refresh metadata', () => {
    const refreshRow = () =>
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://sp.example.test',
          acsUrl: 'https://sp.example.test/old-acs',
          metadataUrl: 'https://metadata.example.test/sp.xml',
          identityMapping: { fieldMappingSetId: 'saml-sp' },
        }),
      });

    it('writes nothing while the gate refuses', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(refreshRow());
      mocks.safeFetchText.mockResolvedValue(validSpMetadata());
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));
      expect(response.status).toBe(403);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it('binds refresh to the resolved trust settings and request inputs', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(refreshRow());
      mocks.safeFetchText.mockResolvedValue(validSpMetadata());
      const response = await handleRefreshMetadata(context({ id: 'provider-a', body: {} }));
      expect(response.status).toBe(200);
      expect(mocks.adapter!.execute).toHaveBeenCalledTimes(1);
      expect(mocks.stepUp.mock.calls[0]?.[1]).toEqual({
        operation: 'federation.trust.activate',
        targetTenantId: 'tenant-a',
        targetIds: ['provider-a'],
        params: {
          action: 'provider.refresh_metadata',
          effective_config_sha256: effectiveConfigDigest,
          metadataUrl: 'https://metadata.example.test/sp.xml',
          allowEntityIdChange: false,
        },
      });
    });

    it('does not call the gate when the fetch fails or the URL is missing', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(providerRow());
      expect((await handleRefreshMetadata(context({ id: 'provider-a', body: {} }))).status).toBe(
        400
      );
      mocks.adapter!.queryOne.mockResolvedValue(refreshRow());
      mocks.safeFetchText.mockRejectedValue(new Error('upstream unavailable'));
      expect((await handleRefreshMetadata(context({ id: 'provider-a', body: {} }))).status).toBe(
        400
      );
      expect(mocks.stepUp).not.toHaveBeenCalled();
    });
  });

  describe('refresh federation source', () => {
    // The real refresh finds the source, then calls the hook, then fetches and writes.
    function refreshThroughHook(writes: { count: number }, exists = true) {
      mocks.refreshFederationSource.mockImplementation(async (...args: unknown[]) => {
        if (!exists) throw new Error('federation_source_not_found');
        const hook = args[5];
        if (typeof hook === 'function') await (hook as () => Promise<void>)();
        writes.count += 1;
        return { sourceId: 'source-a', changed: true, entityCount: 1 };
      });
    }

    it('fetches and writes nothing while the gate refuses', async () => {
      const writes = { count: 0 };
      refreshThroughHook(writes);
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handleRefreshFederationMetadataSource(context({ id: 'source-a' }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'step_up_required' });
      expect(writes.count).toBe(0);
    });

    it('goes ahead when the gate lets it, naming the source', async () => {
      const writes = { count: 0 };
      refreshThroughHook(writes);
      const response = await handleRefreshFederationMetadataSource(context({ id: 'source-a' }));
      expect(response.status).toBe(200);
      expect(writes.count).toBe(1);
      expect(mocks.stepUp.mock.calls[0]?.[1]).toEqual({
        operation: 'federation.trust.activate',
        targetTenantId: 'tenant-a',
        targetIds: ['source-a'],
        params: { action: 'federation_source.refresh_metadata' },
      });
    });

    it('does not call the gate for a missing source', async () => {
      refreshThroughHook({ count: 0 }, false);
      const response = await handleRefreshFederationMetadataSource(context({ id: 'missing' }));
      expect(response.status).toBe(404);
      expect(mocks.stepUp).not.toHaveBeenCalled();
    });
  });

  describe('signing rollover', () => {
    const cases = [
      [
        'publish_next',
        handlePublishSigningNext,
        {
          certificate: 'CERT-PEM-BODY',
          kid: 'next-kid',
          keyRef: 'tenant:tenant-a:saml:idp:next-2:signing',
        },
      ],
      ['promote_next', handlePromoteSigningNext, { keepPreviousAsBackup: true }],
      ['retire_backup', handleRetireSigningBackup, {}],
    ] as const;

    it.each(cases)('%s writes nothing while the gate refuses', async (_step, handler, body) => {
      mocks.adapter!.queryOne.mockResolvedValue(rolloverRow());
      mocks.stepUp.mockResolvedValueOnce(refusal());
      const response = await handler(context({ id: 'provider-a', body }));
      expect(response.status).toBe(403);
      expect(mocks.adapter!.execute).not.toHaveBeenCalled();
    });

    it.each(cases)('%s goes ahead when the gate lets it', async (step, handler, body) => {
      mocks.adapter!.queryOne.mockResolvedValue(rolloverRow());
      const response = await handler(context({ id: 'provider-a', body }));
      expect(response.status).not.toBe(403);
      if (response.status === 200) expect(mocks.adapter!.execute).toHaveBeenCalledTimes(1);
      const descriptor = mocks.stepUp.mock.calls[0]?.[1] as {
        params: Record<string, unknown>;
      };
      expect(mocks.stepUp.mock.calls[0]?.[1]).toMatchObject({
        operation: 'federation.trust.activate',
        targetTenantId: 'tenant-a',
        targetIds: ['provider-a'],
      });
      expect(descriptor.params.action).toBe(`provider.signing_rollover.${step}`);
      expect(descriptor.params.request_sha256).toMatch(HEX64);
      expect(JSON.stringify(descriptor)).not.toContain('CERT-PEM-BODY');
    });

    it.each(['entity', 'next', 'name'])(
      'invalidates a promotion receipt after an L0 draft %s edit',
      async (change) => {
        const adapter = mocks.adapter;
        if (!adapter) throw new Error('Missing adapter');
        const row = rolloverRow();
        row.enabled = 0;
        adapter.queryOne.mockResolvedValue(row);
        const request = () => context({ id: 'provider-a', body: { keepPreviousAsBackup: true } });
        let approvedDescriptor: unknown;
        mocks.stepUp.mockImplementation(async (_context, descriptor) =>
          JSON.stringify(descriptor) === JSON.stringify(approvedDescriptor) ? null : refusal()
        );
        expect((await handlePromoteSigningNext(request())).status).toBe(403);
        approvedDescriptor = mocks.stepUp.mock.calls[0]?.[1];
        expect((await handlePromoteSigningNext(request())).status).toBe(200);
        adapter.execute.mockClear();
        // A separate L0 draft request changes the entity, target key, or only the version/name.
        const edited = await handleUpdateProvider(
          context({
            id: 'provider-a',
            body: {
              expectedUpdatedAt: updatedAt,
              name: change === 'name' ? 'Renamed draft' : undefined,
              config:
                change === 'entity'
                  ? { entityId: 'urn:changed-draft' }
                  : change === 'next'
                    ? {
                        signingKeyPolicy: {
                          next: {
                            slot: 'next',
                            keyRef: 'tenant:tenant-a:saml:idp:changed:signing',
                            certificate: 'CHANGED-NEXT-CERT',
                            state: 'published_next',
                          },
                        },
                      }
                    : undefined,
            },
          })
        );
        expect(edited.status).toBe(200);
        const savedParams: unknown = adapter.execute.mock.calls[0]?.[1];
        if (!Array.isArray(savedParams)) throw new Error('Missing saved draft');
        row.config_json = String(savedParams[1]);
        row.updated_at = Number(savedParams[3]);
        adapter.execute.mockClear();
        expect((await handlePromoteSigningNext(request())).status).toBe(403);
        expect(adapter.execute).not.toHaveBeenCalled();
        expect(mocks.stepUp.mock.calls[2]?.[1]).not.toEqual(approvedDescriptor);
      }
    );

    it.each(cases)(
      '%s binds stable receipt params across a delayed retry',
      async (_step, handler, body) => {
        const adapter = mocks.adapter;
        if (!adapter) throw new Error('Missing adapter');
        vi.useFakeTimers();
        try {
          vi.setSystemTime(1_900_000_000_000);
          adapter.queryOne.mockResolvedValue(rolloverRow());
          mocks.stepUp.mockResolvedValueOnce(refusal());
          expect((await handler(context({ id: 'provider-a', body }))).status).toBe(403);
          const original = mocks.stepUp.mock.calls[0]?.[1];
          vi.setSystemTime(Date.now() + 60_000);
          expect((await handler(context({ id: 'provider-a', body }))).status).toBe(200);
          expect(mocks.stepUp.mock.calls[1]?.[1]).toEqual(original);
          expect(original).toMatchObject({
            params: {
              current_config_sha256: effectiveConfigDigest,
              target_key_sha256: effectiveConfigDigest,
              expectedUpdatedAt: updatedAt,
            },
          });
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it('changes the signing receipt descriptor when only the stored version changes', async () => {
      const adapter = mocks.adapter;
      if (!adapter) throw new Error('Missing adapter');
      const row = rolloverRow();
      adapter.queryOne.mockResolvedValue(row);
      mocks.stepUp.mockImplementation(async () => refusal());
      const request = () => context({ id: 'provider-a', body: {} });
      expect((await handlePromoteSigningNext(request())).status).toBe(403);
      const original = mocks.stepUp.mock.calls[0]?.[1];
      row.updated_at += 1;
      expect((await handlePromoteSigningNext(request())).status).toBe(403);
      expect(mocks.stepUp.mock.calls[1]?.[1]).not.toEqual(original);
      expect(adapter.execute).not.toHaveBeenCalled();
    });

    it.each(cases)(
      '%s refuses a concurrent config change at save time',
      async (_step, handler, body) => {
        const adapter = mocks.adapter;
        if (!adapter) throw new Error('Missing adapter');
        adapter.queryOne.mockResolvedValue(rolloverRow());
        adapter.execute.mockResolvedValueOnce({ rowsAffected: 0, insertId: undefined });
        const response = await handler(context({ id: 'provider-a', body }));
        expect(response.status).toBe(409);
        expect(adapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('AND updated_at = ?'),
          expect.arrayContaining([1_700_000_001_000])
        );
      }
    );

    it('does not call the gate for a missing certificate or provider', async () => {
      mocks.adapter!.queryOne.mockResolvedValue(rolloverRow());
      expect((await handlePublishSigningNext(context({ id: 'provider-a', body: {} }))).status).toBe(
        400
      );
      mocks.adapter!.queryOne.mockResolvedValue(null);
      expect((await handleRetireSigningBackup(context({ id: 'missing', body: {} }))).status).toBe(
        404
      );
      expect(mocks.stepUp).not.toHaveBeenCalled();
    });
  });
});
