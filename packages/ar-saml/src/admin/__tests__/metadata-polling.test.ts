import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SAMLMetadataRefreshPolicy } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  admin: null as ReturnType<typeof createAdapter> | null,
  core: null as ReturnType<typeof createAdapter> | null,
  safeFetch: vi.fn(),
  isAggregate: vi.fn(),
  extract: vi.fn(),
  verify: vi.fn(),
  refreshProvider: vi.fn(),
  audit: vi.fn(async () => undefined),
  bumpCache: vi.fn(async () => undefined),
  listTenants: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.core),
    safeFetch: mocks.safeFetch,
    createAuditLog: mocks.audit,
    bumpAuthenticationMethodsCacheRevision: mocks.bumpCache,
    listEnvironmentTenantDefaultStores: mocks.listTenants,
    createLogger: () => ({
      module: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }),
  };
});

vi.mock('../aggregate-metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aggregate-metadata')>();
  return {
    ...actual,
    isAggregateMetadata: mocks.isAggregate,
    extractEntityDescriptorXmls: mocks.extract,
    verifyAggregateMetadata: mocks.verify,
  };
});

vi.mock('../providers', () => ({
  listFederationTrustProfiles: vi.fn(async () => [
    {
      id: 'source-a',
      tenantId: 'tenant-a',
      name: 'Federation A',
      metadataUrlPatterns: ['https://metadata.example.test/federation.xml'],
      certificates: [{ id: 'cert-a', certificate: 'CERT', fingerprintSha256: 'AA', createdAt: 1 }],
      policy: 'strict',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ]),
  refreshSAMLProviderConfigFromMetadata: mocks.refreshProvider,
}));

import {
  pollSAMLMetadata,
  refreshFederationMetadataSource,
  resolveFederationSourceMetadataUrl,
} from '../metadata-polling';

function createAdapter() {
  const execute = vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rowsAffected: 1,
    insertId: undefined,
  }));
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute,
    transaction: vi.fn(async (callback: (adapter: ReturnType<typeof createAdapter>) => unknown) =>
      callback(mocks.admin!)
    ),
    batch: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
}

describe('SAML federation metadata polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin = createAdapter();
    mocks.core = createAdapter();
    mocks.listTenants.mockResolvedValue([]);
    mocks.safeFetch.mockResolvedValue(
      new Response('<md:EntitiesDescriptor/>', {
        status: 200,
        headers: { ETag: '"aggregate-v1"' },
      })
    );
    mocks.isAggregate.mockReturnValue(true);
    mocks.verify.mockResolvedValue({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: [
          {
            entityId: 'https://idp.example.test/entity',
            role: 'saml_idp',
            certificateCount: 1,
          },
        ],
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: { status: 'verified', policy: 'strict', trustProfileId: 'source-a' },
    });
    mocks.extract.mockReturnValue(
      new Map([['https://idp.example.test/entity', '<md:EntityDescriptor/>']])
    );
    mocks.refreshProvider.mockResolvedValue({
      config: {
        entityId: 'https://idp.example.test/entity',
        ssoUrl: 'https://idp.example.test/sso',
        certificate: 'CERT',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMapping: {},
        allowedBindings: ['post'],
        metadataRefreshPolicy: { mode: 'automatic', intervalSeconds: 21_600 },
      },
      metadataRefreshStatus: {
        lastCheckedAt: 1,
        currentHash: 'hash-a',
        current: {
          entityId: 'https://idp.example.test/entity',
          certificates: [],
          endpoints: [],
        },
        diff: {
          changed: true,
          entityIdChanged: false,
          validUntilChanged: false,
          certificatesAdded: [],
          certificatesRemoved: [],
          endpointsAdded: [],
          endpointsRemoved: [],
          expired: false,
        },
      },
      changed: true,
      expired: false,
    });
  });

  it('prefers the explicit aggregate source URL', () => {
    expect(
      resolveFederationSourceMetadataUrl({
        metadataUrl: ' https://metadata.example.test/federation.xml ',
        metadataUrlPatterns: ['https://metadata.example.test/*'],
      })
    ).toBe('https://metadata.example.test/federation.xml');
  });

  it('supports one exact legacy URL pattern but not wildcard trust scopes', () => {
    expect(
      resolveFederationSourceMetadataUrl({
        metadataUrlPatterns: ['https://metadata.example.test/federation.xml'],
      })
    ).toBe('https://metadata.example.test/federation.xml');
    expect(
      resolveFederationSourceMetadataUrl({
        metadataUrlPatterns: ['https://metadata.example.test/*'],
      })
    ).toBeNull();
    expect(
      resolveFederationSourceMetadataUrl({
        metadataUrlPatterns: ['https://metadata.example.test/federation.xml?feed=research'],
      })
    ).toBe('https://metadata.example.test/federation.xml?feed=research');
  });

  it('polls the default tenant when no tenant registry rows exist', async () => {
    const result = await pollSAMLMetadata({} as never, 1_000);

    expect(result.tenantsProcessed).toBe(1);
    expect(mocks.core?.query).toHaveBeenCalled();
  });

  it('verifies one aggregate and reconciles its activated providers', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
              polling: { mode: 'automatic', intervalSeconds: 21_600 },
            }),
          }
        : null
    );
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://metadata.example.test/federation.xml',
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
            aggregateEntityId: 'https://idp.example.test/entity',
            federationTrustProfileId: 'source-a',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
      {
        id: 'provider-for-another-trust-profile',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://metadata.example.test/federation.xml',
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
            aggregateEntityId: 'https://idp.example.test/entity',
            federationTrustProfileId: 'source-b',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
    ]);

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'manual',
      1_000
    );

    expect(result).toMatchObject({ entityCount: 1, providersUpdated: 1, providersMissing: 0 });
    expect(mocks.safeFetch).toHaveBeenCalledOnce();
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.refreshProvider).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalled();
    const runtimeStatement = (mocks.admin!.batch.mock.calls[0]?.[0] as Array<{ sql: string }>).find(
      (statement) => statement.sql.includes('federation_saml_runtime_entities')
    );
    expect(runtimeStatement).toBeDefined();
    const pollingWrite = mocks.admin!.execute.mock.calls.find(([sql]) =>
      String(sql).includes('json_set')
    );
    expect(String(pollingWrite?.[0])).toContain('$.polling.lastAttemptAt');
    expect(pollingWrite?.[1]?.at(-1)).toBe(1_000);
  });

  it('binds runtime rows to the trust snapshot used for aggregate verification', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            updated_at: 10,
            trust_context_snapshot_hash: 'trust-hash-a',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.verify.mockResolvedValueOnce({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: [
          {
            entityId: 'https://idp.example.test/entity',
            role: 'saml_idp',
            certificateCount: 1,
          },
        ],
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'trust-hash-a',
      },
    });

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000);

    const statements = mocks.admin!.batch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    const runtimeInsert = statements.find((statement) =>
      statement.sql.includes('INSERT OR IGNORE INTO federation_saml_runtime_entities')
    );
    expect(runtimeInsert?.sql).toContain('trust_context_snapshot_hash');
    expect(runtimeInsert?.params).toContain('trust-hash-a');
  });

  it('rejects a refresh verified under a different trust generation', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            updated_at: 10,
            trust_context_snapshot_hash: 'trust-hash-current',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.verify.mockResolvedValueOnce({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: [],
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'trust-hash-old',
      },
    });

    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000)
    ).rejects.toThrow('federation_trust_context_changed');
    expect(mocks.admin!.batch).not.toHaveBeenCalled();
  });

  it('rejects a refresh that cannot acquire the source lease before side effects', async () => {
    mocks.admin!.queryOne.mockResolvedValue({
      id: 'source-a',
      tenant_id: 'tenant-a',
      source_type: 'saml_aggregate',
      updated_at: 10,
      active_metadata_document_id: null,
      trust_context_snapshot_hash: 'trust-hash-a',
      protocol_payload_json: JSON.stringify({
        metadataUrl: 'https://metadata.example.test/federation.xml',
      }),
    });
    mocks.admin!.execute.mockImplementation(async (sql: string) => ({
      rowsAffected: sql.includes('SET refresh_operation_token = ?') ? 0 : 1,
      insertId: undefined,
    }));

    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000)
    ).rejects.toThrow('metadata_refresh_conflict');

    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.admin!.batch).not.toHaveBeenCalled();
    expect(mocks.core!.execute).not.toHaveBeenCalled();
    expect(mocks.bumpCache).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('revalidates the source lease before persisting linked provider changes', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            updated_at: 10,
            active_metadata_document_id: null,
            trust_context_snapshot_hash: 'trust-hash-a',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.verify.mockResolvedValueOnce({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: [
          {
            entityId: 'https://idp.example.test/entity',
            role: 'saml_idp',
            certificateCount: 1,
          },
        ],
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'trust-hash-a',
      },
    });
    mocks.admin!.execute.mockImplementation(async (sql: string) => ({
      rowsAffected: sql.includes('SET refresh_operation_expires_at = ?') ? 0 : 1,
      insertId: undefined,
    }));

    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000)
    ).rejects.toThrow('metadata_refresh_superseded');

    expect(mocks.admin!.batch).toHaveBeenCalledOnce();
    expect(mocks.core!.query).not.toHaveBeenCalled();
    expect(mocks.core!.execute).not.toHaveBeenCalled();
    expect(mocks.bumpCache).not.toHaveBeenCalled();
  });

  it('renews the lease again for each linked provider mutation', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            updated_at: 10,
            active_metadata_document_id: null,
            trust_context_snapshot_hash: 'trust-hash-a',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.verify.mockResolvedValueOnce({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: [
          {
            entityId: 'https://idp.example.test/entity',
            role: 'saml_idp',
            certificateCount: 1,
          },
        ],
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'trust-hash-a',
      },
    });
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          aggregateImport: {
            aggregateEntityId: 'https://idp.example.test/entity',
            federationTrustProfileId: 'source-a',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
    ]);
    let renewals = 0;
    mocks.admin!.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('SET refresh_operation_expires_at = ?')) {
        renewals += 1;
        return { rowsAffected: renewals === 1 ? 1 : 0, insertId: undefined };
      }
      return { rowsAffected: 1, insertId: undefined };
    });

    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('metadata_refresh_superseded');

    expect(renewals).toBe(2);
    expect(mocks.core!.query).toHaveBeenCalledOnce();
    expect(mocks.core!.execute).not.toHaveBeenCalled();
  });

  it('bounds automatic provider reconciliation and persists its continuation cursor', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            updated_at: 10,
            active_metadata_document_id: null,
            trust_context_snapshot_hash: 'trust-hash-a',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.verify.mockResolvedValueOnce({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: [],
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'trust-hash-a',
      },
    });
    mocks.core!.query.mockResolvedValue(
      Array.from({ length: 26 }, (_, index) => ({
        id: `provider-${String(index).padStart(2, '0')}`,
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({ entityId: `https://idp-${index}.example.test/entity` }),
      }))
    );

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000);

    expect(mocks.core!.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT ?'), [
      'tenant-a',
      '',
      26,
    ]);
    const completedJobWrite = mocks.admin!.execute.mock.calls.find(
      ([sql, params]) =>
        String(sql).includes('UPDATE federation_metadata_refresh_jobs') &&
        params?.[0] === 'completed'
    );
    expect(JSON.parse(String(completedJobWrite?.[1]?.[1]))).toMatchObject({
      providerCursor: 'provider-24',
    });
  });

  it('pins a legacy aggregate provider to the trust profile that verifies it', async () => {
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://metadata.example.test/federation.xml',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            nextRefreshAt: 0,
          },
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
            aggregateEntityId: 'https://idp.example.test/entity',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
    ]);

    await pollSAMLMetadata({} as never, 2_000);

    expect(mocks.refreshProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateImport: expect.objectContaining({
          federationTrustProfileId: 'source-a',
          aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
        }),
      })
    );
  });

  it('keeps a missing entity once, then disables it after a second valid snapshot', async () => {
    const provider = {
      id: 'provider-a',
      provider_type: 'saml_idp' as const,
      enabled: 1,
      config_json: JSON.stringify({
        entityId: 'https://idp.example.test/entity',
        metadataUrl: 'https://metadata.example.test/federation.xml',
        metadataRefreshPolicy: { mode: 'automatic', intervalSeconds: 21_600 },
        aggregateImport: {
          aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
          aggregateEntityId: 'https://idp.example.test/entity',
          federationTrustProfileId: 'source-a',
          verification: { status: 'verified', policy: 'strict' },
          importedAt: 1,
        },
      }),
    };
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.core!.query.mockImplementation(async () => [provider]);
    mocks.core!.execute.mockImplementation(async (_sql: string, params?: unknown[]) => {
      provider.config_json = String(params?.[0]);
      provider.enabled = Number(params?.[1]);
      return { rowsAffected: 1, insertId: undefined };
    });
    mocks.extract.mockReturnValue(new Map());

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000);
    expect(provider.enabled).toBe(1);

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 2_000);
    expect(provider.enabled).toBe(0);
    const persisted = JSON.parse(provider.config_json) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(persisted.metadataRefreshPolicy).toMatchObject({
      sourceState: 'missing',
      consecutiveFailures: 2,
    });
  });

  it('does not send cached HTTP validators for an explicit manual federation refresh', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
              polling: {
                mode: 'manual',
                intervalSeconds: 21_600,
                etag: '"aggregate-old"',
                validatorSourceUrl: 'https://metadata.example.test/federation.xml',
              },
            }),
          }
        : null
    );

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000);

    const init = mocks.safeFetch.mock.calls[0]?.[1] as unknown as { headers: Headers };
    const headers = init.headers;
    expect(headers.has('If-None-Match')).toBe(false);
  });

  it('rejects an unsolicited 304 when no conditional validator was sent', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            updated_at: 10,
            trust_context_snapshot_hash: 'trust-hash-a',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
              polling: { mode: 'automatic', intervalSeconds: 21_600 },
            }),
          }
        : null
    );
    mocks.safeFetch.mockResolvedValue(new Response(null, { status: 304 }));

    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000)
    ).rejects.toThrow('metadata_unexpected_not_modified');
    expect(mocks.admin!.batch).not.toHaveBeenCalled();
  });

  it('drops obsolete validators after a modified response and advances source OCC time', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            updated_at: 1_000,
            trust_context_snapshot_hash: 'trust-hash-a',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
              polling: {
                mode: 'automatic',
                intervalSeconds: 21_600,
                etag: '"aggregate-old"',
                lastModified: 'Mon, 01 Sep 2026 00:00:00 GMT',
                validatorSourceUrl: 'https://metadata.example.test/federation.xml',
              },
            }),
          }
        : null
    );
    mocks.safeFetch.mockResolvedValue(new Response('<md:EntitiesDescriptor/>', { status: 200 }));
    mocks.verify.mockResolvedValue({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: [],
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'trust-hash-a',
      },
    });

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000);

    const pollingWrite = mocks.admin!.execute.mock.calls.find(([sql]) =>
      String(sql).includes('json_set')
    );
    const persisted = JSON.parse(String(pollingWrite?.[1]?.[0])) as SAMLMetadataRefreshPolicy;
    expect(persisted.etag).toBeUndefined();
    expect(persisted.lastModified).toBeUndefined();
    expect(Number(pollingWrite?.[1]?.[2])).toBeGreaterThan(1_001);
  });

  it('fails a 304 response after the last accepted federation document expires', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
              polling: {
                mode: 'automatic',
                intervalSeconds: 21_600,
                etag: '"aggregate-v1"',
                validatorSourceUrl: 'https://metadata.example.test/federation.xml',
                acceptedValidUntil: '1970-01-01T00:00:01Z',
              },
            }),
          }
        : null
    );
    mocks.safeFetch.mockResolvedValue(
      new Response(null, { status: 304, headers: { ETag: '"aggregate-v1"' } })
    );

    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 2_000)
    ).rejects.toThrow('metadata_expired');

    const pollingWrite = mocks.admin!.execute.mock.calls.find(([sql]) =>
      String(sql).includes('json_set')
    );
    expect(JSON.parse(String(pollingWrite?.[1]?.[0]))).toMatchObject({
      sourceState: 'expired',
      lastErrorCode: 'metadata_expired',
    });
    expect(
      mocks.admin!.execute.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM federation_metadata_validation_events')
      )
    ).toBe(true);
    expect(
      mocks.admin!.execute.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM federation_metadata_refresh_jobs')
      )
    ).toBe(true);
  });

  it('does not attach new HTTP validators to an expired provider candidate', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://metadata.example.test/federation.xml',
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
            aggregateEntityId: 'https://idp.example.test/entity',
            federationTrustProfileId: 'source-a',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
    ]);
    mocks.refreshProvider.mockResolvedValueOnce({
      config: {
        entityId: 'https://idp.example.test/entity',
        metadataUrl: 'https://metadata.example.test/federation.xml',
        metadataRefreshPolicy: {
          mode: 'automatic',
          intervalSeconds: 21_600,
          sourceState: 'expired',
          etag: '"accepted-v1"',
          validatorSourceUrl: 'https://metadata.example.test/federation.xml',
        },
      },
      metadataRefreshStatus: {
        current: {
          entityId: 'https://idp.example.test/entity',
          validUntil: '1970-01-01T00:00:01Z',
          certificates: [],
          endpoints: [],
        },
      },
      changed: true,
      expired: true,
    });

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'automatic',
      2_000
    );

    expect(result).toMatchObject({ providersUpdated: 0, providersFailed: 1 });
    const persisted = JSON.parse(String(mocks.core!.execute.mock.calls[0]?.[1]?.[0])) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(persisted.metadataRefreshPolicy.etag).toBeUndefined();
    expect(persisted.metadataRefreshPolicy.etag).not.toBe('"aggregate-v1"');
    expect(persisted.metadataRefreshPolicy.suspendedByMetadataSync).toBe(true);
    expect(mocks.core!.execute.mock.calls[0]?.[1]?.[1]).toBe(0);
  });

  it('resets the missing counter when the previous failure had a different cause', async () => {
    const provider = {
      id: 'provider-a',
      provider_type: 'saml_idp' as const,
      enabled: 1,
      updated_at: 10,
      config_json: JSON.stringify({
        entityId: 'https://idp.example.test/entity',
        metadataUrl: 'https://metadata.example.test/federation.xml',
        metadataRefreshPolicy: {
          mode: 'automatic',
          intervalSeconds: 21_600,
          consecutiveFailures: 4,
          lastErrorCode: 'metadata_http_500',
        },
        aggregateImport: {
          aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
          aggregateEntityId: 'https://idp.example.test/entity',
          federationTrustProfileId: 'source-a',
          verification: { status: 'verified', policy: 'strict' },
          importedAt: 1,
        },
      }),
    };
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.core!.query.mockResolvedValue([provider]);
    mocks.core!.execute.mockImplementation(async (_sql: string, params?: unknown[]) => {
      provider.config_json = String(params?.[0]);
      provider.enabled = Number(params?.[1]);
      return { rowsAffected: 1, insertId: undefined };
    });
    mocks.extract.mockReturnValue(new Map());

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 2_000);

    const persisted = JSON.parse(provider.config_json) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(provider.enabled).toBe(1);
    expect(persisted.metadataRefreshPolicy).toMatchObject({
      consecutiveFailures: 1,
      lastErrorCode: 'federation_entity_missing',
    });
  });

  it('records large entity inventories with bounded set-based D1 statements', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM federation_trust_sources')
        ? {
            id: 'source-a',
            tenant_id: 'tenant-a',
            source_type: 'saml_aggregate',
            protocol_payload_json: JSON.stringify({
              metadataUrl: 'https://metadata.example.test/federation.xml',
            }),
          }
        : null
    );
    mocks.verify.mockResolvedValueOnce({
      aggregate: {
        metadataXml: '<md:EntitiesDescriptor/>',
        entities: Array.from({ length: 1_200 }, (_, index) => ({
          entityId: `https://idp.example.test/entity/${index}`,
          role: 'saml_idp',
          certificateCount: 1,
        })),
        validUntil: '2030-01-01T00:00:00Z',
      },
      verification: { status: 'verified', policy: 'strict', trustProfileId: 'source-a' },
    });

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000);

    const statements = mocks.admin!.batch.mock.calls[0]?.[0] as Array<{ sql: string }>;
    expect(statements).toHaveLength(10);
    expect(statements.filter((statement) => statement.sql.includes('json_each'))).toHaveLength(3);
    expect(statements.filter((statement) => statement.sql.includes('DELETE FROM'))).toHaveLength(5);
    expect(
      statements
        .filter((statement) => statement.sql.includes('DELETE FROM'))
        .every((statement) => statement.sql.includes('document_type'))
    ).toBe(true);
    const documentInsert = statements.find((statement) =>
      statement.sql.includes('INSERT OR IGNORE INTO federation_metadata_documents')
    ) as { params?: unknown[] } | undefined;
    expect(documentInsert?.params?.[3]).toBe('saml_aggregate_runtime_snapshot');
  });

  it('creates a fresh document observation when aggregate content returns from B to A', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM federation_trust_sources')) {
        return {
          id: 'source-a',
          tenant_id: 'tenant-a',
          source_type: 'saml_aggregate',
          protocol_payload_json: JSON.stringify({
            metadataUrl: 'https://metadata.example.test/federation.xml',
          }),
        };
      }
      if (sql.includes('FROM federation_metadata_documents')) {
        return { id: 'samlmd_previous-b', document_hash: 'hash-of-b' };
      }
      return null;
    });

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000);

    const statements = mocks.admin!.batch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    const insert = statements.find((statement) =>
      statement.sql.includes('INSERT OR IGNORE INTO federation_metadata_documents')
    );
    expect(insert?.params?.[0]).toMatch(
      /^samlmd_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(insert?.params?.[0]).not.toBe('samlmd_previous-b');
  });

  it('does not let an older refresh rewrite a newer document observation', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM federation_trust_sources')) {
        return {
          id: 'source-a',
          tenant_id: 'tenant-a',
          source_type: 'saml_aggregate',
          protocol_payload_json: JSON.stringify({
            metadataUrl: 'https://metadata.example.test/federation.xml',
          }),
        };
      }
      if (sql.includes('FROM federation_metadata_documents')) {
        return {
          id: 'samlmd_newer',
          document_hash: 'newer-hash',
          source_url: 'https://metadata.example.test/federation.xml',
          fetched_at: 2_000,
        };
      }
      return null;
    });

    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000)
    ).rejects.toThrow('metadata_refresh_superseded');
    expect(mocks.admin!.batch).not.toHaveBeenCalled();
    expect(mocks.admin!.execute.mock.calls.some(([sql]) => String(sql).includes('json_set'))).toBe(
      false
    );
  });

  it('records a fresh fenced observation for identical bytes and source URL', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM federation_trust_sources')) {
        return {
          id: 'source-a',
          tenant_id: 'tenant-a',
          source_type: 'saml_aggregate',
          protocol_payload_json: JSON.stringify({
            metadataUrl: 'https://metadata.example.test/federation.xml',
          }),
        };
      }
      if (sql.includes('FROM federation_metadata_documents')) {
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode('<md:EntitiesDescriptor/>')
        );
        return {
          id: 'samlmd_latest-a',
          document_hash: [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(''),
          source_url: 'https://metadata.example.test/federation.xml',
        };
      }
      return null;
    });

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'automatic',
      1_000
    );

    expect(result.changed).toBe(false);
    const statements = mocks.admin!.batch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params?: unknown[];
    }>;
    expect(
      statements.some((statement) =>
        statement.sql.includes('INSERT OR IGNORE INTO federation_metadata_documents')
      )
    ).toBe(true);
    expect(statements[0]?.params?.[6]).toEqual(expect.any(String));
  });

  it('creates a fresh observation when a source URL returns to previously seen bytes', async () => {
    mocks.admin!.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM federation_trust_sources')) {
        return {
          id: 'source-a',
          tenant_id: 'tenant-a',
          source_type: 'saml_aggregate',
          protocol_payload_json: JSON.stringify({
            metadataUrl: 'https://metadata.example.test/source-a.xml',
          }),
        };
      }
      if (sql.includes('FROM federation_metadata_documents')) {
        const bytes = new TextEncoder().encode('<md:EntitiesDescriptor/>');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const documentHash = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        return {
          id: 'samlmd_historical-a',
          document_hash: documentHash,
          source_url: 'https://metadata.example.test/source-b.xml',
        };
      }
      return null;
    });

    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 1_000);

    const statements = mocks.admin!.batch.mock.calls[0]?.[0] as Array<{ sql: string }>;
    expect(
      statements.some((statement) =>
        statement.sql.includes('INSERT OR IGNORE INTO federation_metadata_documents')
      )
    ).toBe(true);
  });

  it('marks a cached individual provider expired instead of treating its 304 as healthy', async () => {
    mocks.safeFetch.mockResolvedValue(
      new Response(null, { status: 304, headers: { ETag: '"provider-v1"' } })
    );
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://idp.example.test/metadata.xml',
          metadataCriticalFields: {
            entityId: 'https://idp.example.test/entity',
            validUntil: '1970-01-01T00:00:01Z',
            certificates: [],
            endpoints: [],
          },
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            nextRefreshAt: 0,
            etag: '"provider-v1"',
            validatorSourceUrl: 'https://idp.example.test/metadata.xml',
          },
        }),
      },
    ]);

    const result = await pollSAMLMetadata({} as never, 2_000);

    expect(result).toMatchObject({ individualProvidersProcessed: 0, individualProvidersFailed: 1 });
    const persisted = JSON.parse(String(mocks.core!.execute.mock.calls[0]?.[1]?.[0])) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(persisted.metadataRefreshPolicy).toMatchObject({
      sourceState: 'expired',
      lastErrorCode: 'metadata_expired',
      suspendedByMetadataSync: true,
    });
    expect(mocks.core!.execute.mock.calls[0]?.[1]?.[1]).toBe(0);
  });

  it('restores a provider only when metadata automation previously suspended it', async () => {
    mocks.isAggregate.mockReturnValueOnce(false);
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 0,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://idp.example.test/metadata.xml',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            nextRefreshAt: 0,
            sourceState: 'expired',
            suspendedByMetadataSync: true,
          },
        }),
      },
    ]);

    const result = await pollSAMLMetadata({} as never, 2_000);

    expect(result.individualProvidersProcessed).toBe(1);
    expect(mocks.core!.execute.mock.calls[0]?.[1]?.[1]).toBe(1);
    const persisted = JSON.parse(String(mocks.core!.execute.mock.calls[0]?.[1]?.[0])) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(persisted.metadataRefreshPolicy.suspendedByMetadataSync).toBeUndefined();
  });

  it('disables an individual provider when all cached metadata certificates expire on a 304', async () => {
    mocks.safeFetch.mockResolvedValue(
      new Response(null, { status: 304, headers: { ETag: '"provider-v1"' } })
    );
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://idp.example.test/metadata.xml',
          certificateValidation: {
            checkedAt: 1,
            allExpired: false,
            hasExpired: false,
            hasWeakSignature: false,
            warnings: [],
            certificates: [
              {
                validTo: '1970-01-01T00:00:01Z',
                expired: false,
                notYetValid: false,
                warnings: [],
              },
            ],
          },
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            nextRefreshAt: 0,
            etag: '"provider-v1"',
            validatorSourceUrl: 'https://idp.example.test/metadata.xml',
          },
        }),
      },
    ]);

    const result = await pollSAMLMetadata({} as never, 2_000);

    expect(result.individualProvidersFailed).toBe(1);
    expect(mocks.core!.execute.mock.calls[0]?.[1]?.[1]).toBe(0);
    const persisted = JSON.parse(String(mocks.core!.execute.mock.calls[0]?.[1]?.[0])) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(persisted.metadataRefreshPolicy.lastErrorCode).toBe('metadata_certificates_expired');
  });

  it('continues individual polling when the federation inventory scan is unavailable', async () => {
    mocks.admin!.query.mockRejectedValueOnce(new Error('admin unavailable'));

    const result = await pollSAMLMetadata({} as never, 1_000);

    expect(result.federationSourcesFailed).toBe(1);
    expect(result.tenantsProcessed).toBe(1);
    expect(mocks.core!.query).toHaveBeenCalled();
  });

  it('rejects a legacy aggregate provider when its source downgrades to one entity', async () => {
    mocks.isAggregate.mockReturnValue(false);
    mocks.safeFetch.mockResolvedValue(
      new Response('<md:EntityDescriptor entityID="https://idp.example.test/entity"/>', {
        status: 200,
      })
    );
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://metadata.example.test/federation.xml',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            nextRefreshAt: 0,
          },
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
            aggregateEntityId: 'https://idp.example.test/entity',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
    ]);

    const result = await pollSAMLMetadata({} as never, 2_000);

    expect(result.individualProvidersFailed).toBe(1);
    expect(mocks.refreshProvider).not.toHaveBeenCalled();
    const persisted = JSON.parse(String(mocks.core!.execute.mock.calls[0]?.[1]?.[0])) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(persisted.metadataRefreshPolicy.lastErrorCode).toBe('metadata_refresh_failed');
  });

  it('disables a provider whose linked federation source was deleted', async () => {
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://metadata.example.test/federation.xml',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
          },
          aggregateImport: {
            aggregateSourceUrl: 'https://metadata.example.test/federation.xml',
            aggregateEntityId: 'https://idp.example.test/entity',
            federationTrustProfileId: 'deleted-source',
            verification: { status: 'verified', policy: 'strict' },
            importedAt: 1,
          },
        }),
      },
    ]);
    mocks.admin!.query.mockResolvedValue([]);

    const result = await pollSAMLMetadata({} as never, 2_000);

    expect(result.individualProvidersFailed).toBe(1);
    expect(mocks.core!.execute.mock.calls[0]?.[1]?.[1]).toBe(0);
    const persisted = JSON.parse(String(mocks.core!.execute.mock.calls[0]?.[1]?.[0])) as {
      metadataRefreshPolicy: SAMLMetadataRefreshPolicy;
    };
    expect(persisted.metadataRefreshPolicy).toMatchObject({
      sourceState: 'missing',
      lastErrorCode: 'federation_source_missing',
      suspendedByMetadataSync: true,
    });
  });

  it('does not overwrite a provider changed concurrently with automatic polling', async () => {
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 10,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://idp.example.test/metadata.xml',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            nextRefreshAt: 0,
          },
        }),
      },
    ]);
    mocks.core!.execute.mockResolvedValue({ rowsAffected: 0, insertId: undefined });

    const result = await pollSAMLMetadata({} as never, 2_000);

    expect(result.individualProvidersFailed).toBe(1);
    expect(mocks.core!.execute).toHaveBeenCalledOnce();
    expect(String(mocks.core!.execute.mock.calls[0]?.[0])).toContain('AND updated_at = ?');
  });

  it('keeps provider updatedAt monotonic when a scheduled observation is delayed', async () => {
    mocks.isAggregate.mockReturnValue(false);
    mocks.core!.query.mockResolvedValue([
      {
        id: 'provider-a',
        provider_type: 'saml_idp',
        enabled: 1,
        updated_at: 2_000,
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test/entity',
          metadataUrl: 'https://idp.example.test/metadata.xml',
          metadataRefreshPolicy: {
            mode: 'automatic',
            intervalSeconds: 21_600,
            nextRefreshAt: 0,
          },
        }),
      },
    ]);

    const result = await pollSAMLMetadata({} as never, 1_000);

    expect(result.individualProvidersProcessed).toBe(1);
    expect(mocks.core!.execute.mock.calls[0]?.[1]?.[2]).toBe(2_001);
  });
});
