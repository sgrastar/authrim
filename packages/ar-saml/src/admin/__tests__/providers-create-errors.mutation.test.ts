/**
 * Error and edge paths of handleCreateProvider / handleUpdateProvider / handleDeleteProvider:
 * uniqueness races, metadata validation messages, draft normalisation and audit failure records.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bodyOf,
  createAdapter,
  dig,
  harnessContext,
  parseJson,
  providerRow,
} from './helpers/provider-handler-harness';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async (..._args: unknown[]) => undefined),
  logError: vi.fn(),
  logWarn: vi.fn(),
  errors: [] as Array<{ code: string; options: unknown }>,
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
    tenantCapabilityRefusal: vi.fn(async () => null),
    createErrorResponse: (c: never, code: string, options?: unknown) => {
      mocks.errors.push({ code, options });
      return (actual.createErrorResponse as (...args: unknown[]) => unknown)(c, code, options);
    },
    listEnvironmentTenantDefaultStores: vi.fn(async () => [{ tenantId: 'tenant-a' }]),
    bumpAuthenticationMethodsCacheRevision: vi.fn(async () => undefined),
    readLiteModeAuthoritative: vi.fn(async () => 'off'),
    getUIConfig: vi.fn(async () => null),
    getLogger: () => ({
      module: () => ({
        error: mocks.logError,
        warn: mocks.logWarn,
        info: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  };
});

import {
  handleCreateProvider,
  handleDeleteProvider,
  handleGetProvider,
  handleUpdateProvider,
} from '../providers';

function adapter() {
  if (!mocks.adapter) throw new Error('adapter not initialised');
  return mocks.adapter;
}

function lastValidationField(): unknown {
  const last = mocks.errors.at(-1);
  return (last?.options as { variables?: { field?: unknown } } | undefined)?.variables?.field;
}

function auditActions(): string[] {
  return mocks.audit.mock.calls.map((call) => (call[1] as { action: string }).action);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.errors.length = 0;
  mocks.adapter = createAdapter();
});

describe('handleCreateProvider', () => {
  it('answers 409 when the database rejects a duplicate SAML entityID', async () => {
    adapter().execute.mockRejectedValue(
      new Error(
        'UNIQUE constraint failed: identity_providers.tenant_id, idx_identity_providers_saml_entity_id'
      )
    );

    const response = await handleCreateProvider(
      harnessContext({ body: { name: 'Dup', providerType: 'saml_sp', enabled: false } })
    );

    expect(response.status).toBe(409);
    expect(auditActions()).not.toContain('saml.provider.created');
  });

  it('also treats a bare identity_providers UNIQUE failure as an entityID conflict', async () => {
    adapter().execute.mockRejectedValue(
      new Error('UNIQUE constraint failed: identity_providers.id')
    );

    const response = await handleCreateProvider(
      harnessContext({ body: { name: 'Dup', providerType: 'saml_idp', enabled: false } })
    );

    expect(response.status).toBe(409);
  });

  it('answers 500 and records a failure audit for an unexpected storage error', async () => {
    adapter().execute.mockRejectedValue(new Error('disk full'));

    const response = await handleCreateProvider(
      harnessContext({ body: { name: 'Boom', providerType: 'saml_sp', enabled: false } })
    );

    expect(response.status).toBe(500);
    const failure = mocks.audit.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .find((entry) => entry.action === 'saml.provider.created');
    expect(failure).toMatchObject({
      resource: 'saml_provider',
      resourceId: 'unknown',
      severity: 'warning',
    });
    expect(JSON.parse(String(failure?.metadata))).toEqual({
      protocol: 'saml',
      error_class: 'Error',
      result: 'failure',
    });
    expect(mocks.logError).toHaveBeenCalledWith('Create provider error', {}, expect.any(Error));
  });

  it('reports a metadata/role mismatch as a 400 validation error naming the problem', async () => {
    const spMetadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.test"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;

    const response = await handleCreateProvider(
      harnessContext({
        body: { name: 'Wrong role', providerType: 'saml_idp', metadataXml: spMetadata },
      })
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await bodyOf(response))).toContain('Service Provider');
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'Create provider metadata validation failed',
      {},
      expect.any(Error)
    );
    expect(auditActions()).toEqual(['saml.provider.created']);
  });

  it('drops client-supplied trust state from a draft metadataRefreshPolicy when no metadata is supplied', async () => {
    const response = await handleCreateProvider(
      harnessContext({
        body: {
          name: 'Policy draft',
          providerType: 'saml_idp',
          enabled: false,
          config: {
            metadataRefreshPolicy: {
              mode: 'manual',
              intervalSeconds: 7200,
              sourceState: 'active',
              acceptedValidUntil: '2099-01-01T00:00:00Z',
            },
          },
        },
      })
    );

    expect(response.status).toBe(201);
    const stored = JSON.parse(String((adapter().execute.mock.calls[0]?.[1] as unknown[])[4])) as {
      metadataRefreshPolicy: Record<string, unknown>;
    };
    expect(stored.metadataRefreshPolicy).toMatchObject({
      mode: 'manual',
      intervalSeconds: 7200,
      sourceState: 'stale',
    });
    expect(stored.metadataRefreshPolicy).not.toHaveProperty('acceptedValidUntil');
  });

  it('rejects an unknown providerType and a request without name', async () => {
    const unknown = await handleCreateProvider(
      harnessContext({ body: { name: 'X', providerType: 'saml_other', config: {} } })
    );
    const nameless = await handleCreateProvider(
      harnessContext({ body: { providerType: 'saml_sp', config: {} } })
    );

    expect(unknown.status).toBe(400);
    expect(nameless.status).toBe(400);
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('refuses a caller without the create permission', async () => {
    const response = await handleCreateProvider(
      harnessContext({
        permissions: [],
        body: { name: 'X', providerType: 'saml_sp', enabled: false },
      })
    );

    expect(response.status).toBe(403);
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await handleCreateProvider(
      harnessContext({
        permissions: null,
        body: { name: 'X', providerType: 'saml_sp', enabled: false },
      })
    );

    expect(response.status).toBe(401);
  });
});

function auditEntry(action: string): Record<string, unknown> | undefined {
  return mocks.audit.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .find((entry) => entry.action === action);
}

describe('handleDeleteProvider', () => {
  it('answers 404 when the provider is not found', async () => {
    adapter().queryOne.mockResolvedValue(null);

    const response = await handleDeleteProvider(harnessContext({ id: 'missing' }));

    expect(response.status).toBe(404);
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('answers 404 when the row disappears between the lookup and the delete', async () => {
    adapter().queryOne.mockResolvedValue(providerRow());
    adapter().execute.mockResolvedValue({ rowsAffected: 0 });

    const response = await handleDeleteProvider(harnessContext({ id: 'provider-a' }));

    expect(response.status).toBe(404);
    expect(auditActions()).toEqual([]);
  });

  it('deletes within the tenant and audits the deletion as a warning', async () => {
    adapter().queryOne.mockResolvedValue(providerRow());

    const response = await handleDeleteProvider(harnessContext({ id: 'provider-a' }));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ success: true });
    expect(adapter().execute.mock.calls[0]?.[1]).toEqual(['provider-a', 'tenant-a']);
    expect(auditEntry('saml.provider.deleted')).toMatchObject({
      resource: 'saml_provider',
      resourceId: 'provider-a',
      severity: 'warning',
    });
  });

  it('audits under resourceId "unknown" when the route carries no id', async () => {
    adapter().queryOne.mockResolvedValue(providerRow());

    const response = await handleDeleteProvider(harnessContext({}));

    expect(response.status).toBe(200);
    expect(auditEntry('saml.provider.deleted')).toMatchObject({ resourceId: 'unknown' });
  });

  it('records a failure audit and answers 500 when the stored config is not JSON', async () => {
    adapter().queryOne.mockResolvedValue(providerRow({ config_json: '{not json' }));

    const response = await handleDeleteProvider(harnessContext({}));

    expect(response.status).toBe(500);
    expect(auditEntry('saml.provider.deleted')).toMatchObject({
      resource: 'saml_provider',
      resourceId: 'unknown',
      severity: 'warning',
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      'Delete provider error',
      { providerId: undefined },
      expect.any(SyntaxError)
    );
  });

  it('refuses a caller without the delete permission', async () => {
    const response = await handleDeleteProvider(
      harnessContext({ id: 'provider-a', permissions: [] })
    );

    expect(response.status).toBe(403);
    expect(adapter().queryOne).not.toHaveBeenCalled();
  });
});

describe('handleGetProvider', () => {
  it('answers 404 when the provider is not found in the tenant', async () => {
    const response = await handleGetProvider(harnessContext({ id: 'missing' }));

    expect(response.status).toBe(404);
    expect(adapter().queryOne.mock.calls[0]?.[1]).toEqual(['missing', 'tenant-a']);
  });
});

describe('handleUpdateProvider', () => {
  it('answers 404 for a missing provider', async () => {
    const response = await handleUpdateProvider(
      harnessContext({ id: 'missing', body: { name: 'New name' } })
    );

    expect(response.status).toBe(404);
  });

  it('rejects an update without expectedUpdatedAt or with a stale one', async () => {
    adapter().queryOne.mockResolvedValue(providerRow({ enabled: 0, config_json: '{}' }));

    const missing = await handleUpdateProvider(
      harnessContext({ id: 'provider-a', body: { name: 'Renamed' } })
    );
    const stale = await handleUpdateProvider(
      harnessContext({
        id: 'provider-a',
        body: { name: 'Renamed', expectedUpdatedAt: new Date(1).toISOString() },
      })
    );

    expect([missing.status, stale.status]).toEqual([400, 409]);
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  const updatedAt = 1_700_000_001_000;
  const draftSp = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    providerRow({
      enabled: 0,
      config_json: JSON.stringify({
        entityId: 'https://sp.example.test',
        acsUrl: 'https://sp.example.test/acs',
        allowedBindings: ['post'],
        ...config,
      }),
      ...extra,
    });
  const update = (body: Record<string, unknown>) =>
    handleUpdateProvider(
      harnessContext({
        id: 'provider-a',
        body: { expectedUpdatedAt: new Date(updatedAt).toISOString(), ...body },
      })
    );
  const storedConfig = (): unknown =>
    parseJson(String((adapter().execute.mock.calls[0]?.[1] as unknown[])[1]));

  it('merges a partial metadataRefreshPolicy over the stored one when the metadata URL is unchanged', async () => {
    adapter().queryOne.mockResolvedValue(
      draftSp({
        metadataUrl: 'https://md.example.test/a',
        metadataRefreshPolicy: { mode: 'auto', intervalSeconds: 3600, sourceState: 'active' },
      })
    );

    const response = await update({ config: { metadataRefreshPolicy: { mode: 'manual' } } });

    expect(response.status).toBe(200);
    expect(dig(storedConfig(), 'metadataRefreshPolicy')).toMatchObject({
      mode: 'manual',
      intervalSeconds: 3600,
      sourceState: 'active',
    });
  });

  it('restarts the metadataRefreshPolicy from the request when the metadata URL changes', async () => {
    adapter().queryOne.mockResolvedValue(
      draftSp({
        metadataUrl: 'https://md.example.test/a',
        metadataRefreshPolicy: { mode: 'auto', intervalSeconds: 3600, sourceState: 'active' },
      })
    );

    const response = await update({
      config: {
        metadataUrl: 'https://md.example.test/b',
        metadataRefreshPolicy: { mode: 'manual', intervalSeconds: 1800 },
      },
    });

    expect(response.status).toBe(200);
    const policy = dig(storedConfig(), 'metadataRefreshPolicy');
    expect(policy).toMatchObject({ mode: 'manual', intervalSeconds: 1800 });
    expect(dig(policy, 'sourceState')).not.toBe('active');
  });

  it('does not carry the stored metadataRefreshPolicy over to a different metadata URL', async () => {
    adapter().queryOne.mockResolvedValue(
      draftSp({
        metadataUrl: 'https://md.example.test/a',
        metadataRefreshPolicy: { mode: 'auto', intervalSeconds: 3600, sourceState: 'active' },
      })
    );

    const response = await update({ config: { metadataUrl: 'https://md.example.test/c' } });

    expect(response.status).toBe(200);
    expect(dig(storedConfig(), 'metadataRefreshPolicy')).not.toMatchObject({
      mode: 'auto',
      intervalSeconds: 3600,
    });
    expect(dig(storedConfig(), 'metadataRefreshPolicy', 'sourceState')).not.toBe('active');
  });

  it('answers 409 when another provider of the same type already uses the entityID', async () => {
    adapter().queryOne.mockResolvedValue(draftSp({}));
    adapter().query.mockResolvedValue([
      { id: 'provider-a', config_json: JSON.stringify({ entityId: 'https://sp.example.test' }) },
      { id: 'other', config_json: JSON.stringify({ entityId: 'https://taken.example.test' }) },
      { id: 'broken', config_json: '{not json' },
    ]);

    const free = await update({ name: 'Renamed' });
    adapter().execute.mockClear();
    const taken = await update({ config: { entityId: 'https://taken.example.test' } });

    expect(free.status).toBe(200);
    expect(taken.status).toBe(409);
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('answers 409 when the row changed between the read and the guarded UPDATE', async () => {
    adapter().queryOne.mockResolvedValue(draftSp({}));
    adapter().execute.mockResolvedValue({ rowsAffected: 0 });

    const response = await update({ name: 'Renamed' });

    expect(response.status).toBe(409);
    expect(auditActions()).not.toContain('saml.provider.updated');
  });

  it('answers 409 for a unique-index violation raised by the UPDATE itself', async () => {
    adapter().queryOne.mockResolvedValue(draftSp({}));
    adapter().execute.mockRejectedValue(
      new Error('UNIQUE constraint failed: index idx_identity_providers_saml_entity_id')
    );

    expect((await update({ name: 'Renamed' })).status).toBe(409);
  });

  it('records a failure audit and answers 500 for an unexpected UPDATE error', async () => {
    adapter().queryOne.mockResolvedValue(draftSp({}));
    adapter().execute.mockRejectedValue(new Error('disk full'));

    const response = await update({ name: 'Renamed' });

    expect(response.status).toBe(500);
    expect(auditEntry('saml.provider.updated')).toMatchObject({
      resource: 'saml_provider',
      resourceId: 'provider-a',
      severity: 'warning',
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      'Update provider error',
      { providerId: 'provider-a' },
      expect.any(Error)
    );
  });

  it('audits the update with the provider type as resource and the name change', async () => {
    adapter().queryOne.mockResolvedValue(draftSp({}));

    const response = await update({ name: 'Renamed' });

    expect(response.status).toBe(200);
    const entry = auditEntry('saml.provider.updated');
    expect(entry).toMatchObject({ resource: 'saml_sp', resourceId: 'provider-a' });
    expect(JSON.parse(String(entry?.metadata))).toMatchObject({
      previous_name: 'Provider A',
      next_name: 'Renamed',
      enabled_changed: false,
      config_updated: false,
    });
  });

  it('refuses to enable an SP whose identity mapping has not been chosen', async () => {
    adapter().queryOne.mockResolvedValue(draftSp({}));

    const response = await update({ enabled: true });

    expect(response.status).toBe(400);
    expect(lastValidationField()).toBe('identityMapping.fieldMappingSetId');
    expect(adapter().execute).not.toHaveBeenCalled();
  });

  it('refuses to enable a provider whose metadata trust state is expired', async () => {
    adapter().queryOne.mockResolvedValue(
      draftSp({
        identityMapping: { fieldMappingSetId: 'saml-sp' },
        metadataRefreshPolicy: { mode: 'auto', intervalSeconds: 3600, sourceState: 'expired' },
      })
    );

    const response = await update({ enabled: true });

    expect(response.status).toBe(400);
    expect(lastValidationField()).toBe('metadataRefreshPolicy.sourceState');
    expect(adapter().execute).not.toHaveBeenCalled();
  });
});
