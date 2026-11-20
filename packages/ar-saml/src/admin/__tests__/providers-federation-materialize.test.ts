import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async () => undefined),
  bump: vi.fn(async () => undefined),
  logError: vi.fn(),
  runtimeBinding: {
    fieldMappingSetId: 'mapping-sp',
    fieldMappingVersionId: 'version-1',
    destinationProfileId: 'destination-profile-saml',
    destinationProfileIds: ['destination-profile-saml'],
  },
  destinationDescriptor: {
    profileId: 'destination-profile-saml',
    profileVersionId: 'destination-profile-saml-v1',
    destinationType: 'saml',
    fields: [{ key: 'mail' }, { key: 'displayName' }, { key: 'eduPersonAffiliation' }],
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    bumpAuthenticationMethodsCacheRevision: mocks.bump,
    readLiteModeAuthoritative: vi.fn(async () => 'off'),
    getUIConfig: vi.fn(async () => null),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => mocks.runtimeBinding),
    loadDestinationProfileConsentDescriptor: vi.fn(async () => mocks.destinationDescriptor),
    getLogger: () => ({
      module: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import { handleMaterializeFederationEntity } from '../providers';

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
  } = {}
): Parameters<typeof handleMaterializeFederationEntity>[0] {
  return {
    env: {},
    req: {
      json: vi.fn(async () => options.body),
      param: vi.fn((name: string) => (name === 'id' ? options.id : undefined)),
      query: vi.fn(() => undefined),
      queries: vi.fn(() => undefined),
      header: vi.fn((name: string) =>
        name.toLowerCase() === 'content-type' && options.body !== undefined
          ? 'application/json'
          : undefined
      ),
    },
    executionCtx: { waitUntil: () => {} },
    get: vi.fn((name: string) => {
      if (name === 'tenantId') return 'tenant-a';
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

function spMetadata(entityId = 'https://sp.example.test') {
  return `<?xml version="1.0"?>
  <md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
    <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${entityId}/acs" index="0" />
    </md:SPSSODescriptor>
  </md:EntityDescriptor>`;
}

function runtimeRow(overrides: Record<string, unknown> = {}) {
  return {
    trust_source_id: 'source-a',
    trust_context_snapshot_hash: 'trust-hash-a',
    metadata_document_id: 'doc-a',
    source_url: 'https://metadata.example.test/federation.xml',
    source_display_name: 'Research Federation',
    protocol_payload_json: JSON.stringify({
      runtimeResolution: {
        mode: 'automatic',
        roles: ['saml_sp'],
        spFieldMappingSetId: 'mapping-sp',
      },
      exceptions: { excludedEntityIds: ['https://sp.example.test'] },
    }),
    metadata_xml: spMetadata(),
    entity_categories_json: null,
    entity_category_support_json: null,
    registration_authority: 'https://federation.example.test',
    valid_until: '2099-01-01T00:00:00Z',
    validated_at: 1_700_000_000_000,
    ...overrides,
  };
}

const body = { entityId: 'https://sp.example.test', providerType: 'saml_sp' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter = createAdapter();
});

describe('materialising a federation entity as an explicit provider', () => {
  it('refuses without the create permission and never reads the directory', async () => {
    const response = await handleMaterializeFederationEntity(
      context({ id: 'source-a', body, permissions: [ADMIN_PERMISSIONS.SAML_PROVIDERS_READ] })
    );
    expect(response.status).toBe(403);
    expect(mocks.adapter!.query).not.toHaveBeenCalled();
  });

  it('validates the request before touching the directory', async () => {
    for (const bad of [
      { providerType: 'saml_sp' },
      { entityId: 'https://sp.example.test', providerType: 'oidc' },
      { ...body, fieldMappingSetId: '' },
      { ...body, attributePresetId: 'custom:mine' },
      { ...body, name: '   ' },
    ]) {
      const response = await handleMaterializeFederationEntity(
        context({ id: 'source-a', body: bad })
      );
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.adapter!.query).not.toHaveBeenCalled();
  });

  it("answers 404 when the entity is not in the source's current verified snapshot", async () => {
    const response = await handleMaterializeFederationEntity(context({ id: 'source-a', body }));
    expect(response.status).toBe(404);
    const [sql, params] = mocks.adapter!.query.mock.calls[0] as [string, unknown[]];
    // Narrowed to the named source, the active snapshot and the requested role.
    expect(sql).toContain('AND r.trust_source_id = ?');
    expect(sql).toContain('d.id = s.active_metadata_document_id');
    expect(params).toEqual(['tenant-a', 'https://sp.example.test', 'saml_sp', 'source-a']);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('creates a draft from the stored metadata, even for an excluded entity, without a step-up', async () => {
    mocks
      .adapter!.query.mockResolvedValueOnce([runtimeRow()]) // runtime rows
      .mockResolvedValueOnce([]); // explicit conflict check
    mocks.adapter!.queryOne.mockResolvedValueOnce({ display_name: 'Example SP' });

    const response = await handleMaterializeFederationEntity(context({ id: 'source-a', body }));
    expect(response.status).toBe(201);
    const created = await response.json<Record<string, unknown>>();
    expect(created).toMatchObject({
      providerType: 'saml_sp',
      entityId: 'https://sp.example.test',
      name: 'Example SP',
      enabled: false,
      sourceId: 'source-a',
    });
    expect(typeof created.providerId).toBe('string');

    // A draft does not change who may authenticate (resolution skips unapproved drafts), so
    // creating it asks for no step-up; enabling the provider later does.
    expect(mocks.stepUp).not.toHaveBeenCalled();
    const insert = mocks.adapter!.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO identity_providers')
    ) as [string, unknown[]];
    expect(insert[1][2]).toBe('Example SP');
    expect(insert[1][3]).toBe('saml_sp');
    expect(insert[1][5]).toBe(0);
    const config = JSON.parse(insert[1][4] as string) as Record<string, unknown>;
    // The aggregate's URL is provenance only: a provider-level metadataUrl would put the draft
    // under URL polling, which the metadata-URL capability gates for ordinary creation.
    expect(config).not.toHaveProperty('metadataUrl');
    expect(config).toMatchObject({
      entityId: 'https://sp.example.test',
      trustApproval: { state: 'draft' },
      identityMapping: { fieldMappingSetId: 'mapping-sp' },
      aggregateImport: {
        federationTrustProfileId: 'source-a',
        verification: { status: 'verified', trustProfileId: 'source-a' },
      },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'saml.federation.entity_materialized',
        resource: 'federation_trust_source',
        resourceId: 'source-a',
      })
    );
    const auditEntry = (mocks.audit.mock.calls[0] as unknown[])[1] as { metadata: string };
    expect(JSON.parse(auditEntry.metadata)).toMatchObject({
      entity_id: 'https://sp.example.test',
      provider_type: 'saml_sp',
      mapping_configuration_pending: false,
    });
    expect(mocks.bump).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
  });

  it('takes the mapping set and name from the request over the source defaults', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([runtimeRow()]).mockResolvedValueOnce([]);
    const response = await handleMaterializeFederationEntity(
      context({
        id: 'source-a',
        body: { ...body, fieldMappingSetId: 'mapping-chosen', name: 'Chosen' },
      })
    );
    expect(response.status).toBe(201);
    const insert = mocks.adapter!.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO identity_providers')
    ) as [string, unknown[]];
    expect(insert[1][2]).toBe('Chosen');
    const config = JSON.parse(insert[1][4] as string) as Record<string, unknown>;
    expect(config).toMatchObject({ identityMapping: { fieldMappingSetId: 'mapping-chosen' } });
  });

  it('answers 400, not 500, for a malformed or non-object body', async () => {
    const malformed = context({ id: 'source-a', body });
    (malformed.req.json as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new SyntaxError('Unexpected token')
    );
    expect((await handleMaterializeFederationEntity(malformed)).status).toBe(400);
    for (const bad of [null, 'text', 42, [body]]) {
      const response = await handleMaterializeFederationEntity(
        context({ id: 'source-a', body: bad })
      );
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.adapter!.query).not.toHaveBeenCalled();
  });

  it('answers 409 when the tenant already has its own provider for the entityID', async () => {
    mocks
      .adapter!.query.mockResolvedValueOnce([runtimeRow()])
      .mockResolvedValueOnce([
        { id: 'provider-1', config_json: JSON.stringify({ entityId: 'https://sp.example.test' }) },
      ]);
    const response = await handleMaterializeFederationEntity(context({ id: 'source-a', body }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'saml_explicit_provider_exists',
    });
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('answers 409 when the stored metadata does not describe the requested entityID', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([
      runtimeRow({ metadata_xml: spMetadata('https://other.example.test') }),
    ]);
    const response = await handleMaterializeFederationEntity(context({ id: 'source-a', body }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'saml_federation_entity_unusable',
    });
  });
});
