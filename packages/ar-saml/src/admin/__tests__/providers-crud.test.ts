import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async () => undefined),
  safeFetchText: vi.fn(),
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
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => mocks.runtimeBinding),
    loadDestinationProfileConsentDescriptor: vi.fn(async () => mocks.destinationDescriptor),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    safeFetchText: mocks.safeFetchText,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

vi.mock('../metadata-polling', () => ({
  refreshFederationMetadataSource: mocks.refreshFederationSource,
}));

import {
  getIdPConfig,
  getIdPConfigByEntityId,
  getSPConfig,
  handleCreateAttributePreset,
  handleCreateProvider,
  handleDeleteAttributePreset,
  handleDeleteProvider,
  handleGetProvider,
  handleImportMetadata,
  handleListAttributePresets,
  handleListProviders,
  handleRefreshMetadata,
  handleRefreshFederationMetadataSource,
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
    id?: string;
    permissions?: string[] | null;
    tenantId?: string;
  } = {}
) {
  return {
    env: {},
    req: {
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
  return (await response.json()) as T;
}

describe('SAML provider CRUD boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter = createAdapter();
    mocks.safeFetchText.mockReset();
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
            attributeReleaseConsent: { enabled: true, mode: 'every_time' },
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
      attributeReleaseConsent: { enabled: true, mode: 'every_time' },
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

  it('rejects an unsupported attribute release consent mode', async () => {
    const response = await handleCreateProvider(
      context({
        body: {
          name: 'Provider',
          providerType: 'saml_sp',
          config: {
            entityId: 'https://sp.example.test',
            acsUrl: 'https://sp.example.test/acs',
            attributeReleaseConsent: { enabled: true, mode: 'unsupported' },
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
    expect(await response.json()).toMatchObject({
      enabled: false,
      config: {
        metadataRefreshPolicy: {
          mode: 'manual',
          intervalSeconds: 3_600,
          sourceState: 'missing',
          lastErrorCode: 'federation_entity_missing',
          suspendedByMetadataSync: true,
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
    mocks.adapter!.execute.mockResolvedValueOnce({ rowsAffected: 0, insertId: undefined });
    expect((await handleDeleteProvider(context({ id: 'missing' }))).status).toBe(404);

    mocks.adapter!.execute.mockResolvedValueOnce({ rowsAffected: 1, insertId: undefined });
    expect((await handleDeleteProvider(context({ id: 'provider-a' }))).status).toBe(200);
  });

  it('does not expose provider deletion storage errors', async () => {
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
        context({ id: 'provider-a', body: { metadataUrl } })
      );
      expect(response.status).toBe(400);
      expect(mocks.safeFetchText).not.toHaveBeenCalled();
    }
  );

  it('imports inline SP metadata and preserves tenant-scoped custom configuration', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const response = await handleImportMetadata(
      context({ id: 'provider-a', body: { metadataXml: validSpMetadata() } })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, enabled: true });
    expect(mocks.adapter!.execute).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('fetches HTTPS metadata with a bounded response size', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    mocks.safeFetchText.mockResolvedValue(validSpMetadata());
    const response = await handleImportMetadata(
      context({
        id: 'provider-a',
        body: { metadataUrl: 'https://metadata.example.test/sp.xml' },
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
    ['aggregate XML', aggregateMetadata()],
  ])('rejects %s during metadata import', async (_name, metadataXml) => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const response = await handleImportMetadata(
      context({ id: 'provider-a', body: { metadataXml } })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('does not expose metadata import persistence failures', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    mocks.adapter!.execute.mockRejectedValue(new Error('database unavailable'));
    const response = await handleImportMetadata(
      context({ id: 'provider-a', body: { metadataXml: validSpMetadata() } })
    );
    expect(response.status).toBe(500);
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
      'manual'
    );
  });

  it('returns conflict when another federation refresh owns the source lease', async () => {
    mocks.refreshFederationSource.mockRejectedValue(new Error('metadata_refresh_conflict'));

    const response = await handleRefreshFederationMetadataSource(
      context({ id: 'source-a', tenantId: 'tenant-a' })
    );

    expect(response.status).toBe(409);
  });

  it('rejects aggregate refresh without the stored aggregate entity snapshot', async () => {
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
    mocks.safeFetchText.mockResolvedValue(aggregateMetadata());
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

function aggregateMetadata() {
  return `<?xml version="1.0"?>
  <md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">
    ${validSpMetadata().replace('<?xml version="1.0"?>', '')}
  </md:EntitiesDescriptor>`;
}
