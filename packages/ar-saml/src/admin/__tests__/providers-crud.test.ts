import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async () => undefined),
  safeFetchText: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => ({
      fieldMappingSetId: 'saml-sp',
      fieldMappingVersionId: 'version-1',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    })),
    loadDestinationProfileConsentDescriptor: vi.fn(async () => ({
      profileId: 'destination-profile-saml',
      profileVersionId: 'destination-profile-saml-v1',
      destinationType: 'saml',
      fields: [{ key: 'mail' }, { key: 'displayName' }, { key: 'eduPersonAffiliation' }],
    })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    safeFetchText: mocks.safeFetchText,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

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
      header: vi.fn(() => undefined),
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

  it('updates an SP while retaining omitted name and enabled state', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    const response = await handleUpdateProvider(
      context({
        id: 'provider-a',
        body: { config: { acsUrl: 'https://sp.example.test/new-acs' } },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Provider A', enabled: true });
    expect(mocks.adapter!.execute).toHaveBeenCalled();
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
      context({ id: 'provider-a', body: { name: 'Next', enabled: false } })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: 'Next', enabled: false });
  });

  it('returns internal error when update storage fails', async () => {
    mocks.adapter!.queryOne.mockResolvedValue(providerRow());
    mocks.adapter!.execute.mockRejectedValue(new Error('database unavailable'));
    expect((await handleUpdateProvider(context({ id: 'provider-a', body: {} }))).status).toBe(500);
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
      { config_json: JSON.stringify({ entityId: 'other' }) },
      { config_json: JSON.stringify({ entityId: 'target', acsUrl: 'https://sp/acs' }) },
    ]);
    expect(await getSPConfig({} as never, 'tenant-a', 'target')).toMatchObject({
      entityId: 'target',
    });
    expect(await getSPConfig({} as never, 'tenant-a', 'missing')).toBeNull();

    expect(await getIdPConfigByEntityId({} as never, 'tenant-a', 'target')).toMatchObject({
      entityId: 'target',
    });
    expect(await getIdPConfigByEntityId({} as never, 'tenant-a', 'missing')).toBeNull();
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
