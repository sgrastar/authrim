import type { Env } from '@authrim/ar-lib-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleCreateProvider,
  handleGetAggregateBatchStatus,
  handleListAggregatePreviewEntities,
  handlePreviewMetadata,
  handleStartAggregateBatchCreate,
  handleUpdateProvider,
} from '../providers';

const mocks = vi.hoisted(() => ({
  safeFetchText: vi.fn(),
  createAuthContextFromHono: vi.fn(),
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    safeFetchText: mocks.safeFetchText,
    createAuthContextFromHono: mocks.createAuthContextFromHono,
    resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveAuthCorePersistenceAdapterFromEnv,
    requireAdminDatabaseAdapter: vi.fn(
      (env: { DB_ADMIN?: unknown }) => env.DB_ADMIN ?? mocks.createAuthContextFromHono().coreAdapter
    ),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => ({
      fieldMappingSetId: 'test-saml-outbound',
      fieldMappingVersionId: 'version-1',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    })),
    loadDestinationProfileConsentDescriptor: vi.fn(async () => ({
      profileId: 'destination-profile-saml',
      profileVersionId: 'destination-profile-saml-v1',
      destinationType: 'saml',
      fields: [{ key: 'mail' }],
    })),
    createAuditLog: mocks.createAuditLog,
    getLogger: () => ({
      module: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  };
});

const singleSPMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://sp.example.test/sp">
  <md:SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="false"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://sp.example.test/acs"
      index="0"
      isDefault="true" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

const expiredCertificate = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUF7MHaoSdF7RMgRQElv5lZZAWkZIwDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUZXhwaXJlZC5leGFtcGxlLnRlc3QwHhcNMjYwNTIyMTY1
MzMxWhcNMjYwNTIzMTY1MzMxWjAfMR0wGwYDVQQDDBRleHBpcmVkLmV4YW1wbGUu
dGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMG7NH941H6F3eIi
GEGCmTykMs8CjWOhTDjlE9d70Md7bJGAfbiBotNEWYjIo8GLySggWoHJ8U/GnG0n
g3HDDTjP0O6K6QuTMI0mQXqr75I9s2ZSxDDvyomL+02HwQK0iZ9gN4fxbA+T65gI
7inzt8fLEGqqx1+yBmgtKYX9F5nptT4DjVRKL9ucMrxpoiB6DBR1brcGkDhCew8m
1oyMf+jGo/m33+a1TqZP8TeQ6jqCwZl6dZOWNEAcqvDLTQFrZl8GWNqHQmCKspgN
vuAua4of0EQwFprh8l36ALBI58N6WfE0wKaj1VAIJ93/sGiKP+FADcSSyDjFYfHM
yOyK2y0CAwEAAaNTMFEwHQYDVR0OBBYEFORT4oGycoEMB9/K+gTPAM/KEYZ8MB8G
A1UdIwQYMBaAFORT4oGycoEMB9/K+gTPAM/KEYZ8MA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQELBQADggEBAEmUSKRdP2IPclAe4NrgVXm5ikNqZlLIO7mtOVyV
RyJ+le6OUcVZCwqNfqH+uPTovGj+CNrhhSpqlIXgnRPGwpKRASwvXgET2QDner5g
Y+Ai2YMpaTEBjaJu2jwebGLsqq2b0mIgNbb/yrrZn3Uf/tm0Rg9AJPKPKiqrOfnG
Fhu7ks1O+KVZTKyJbcORXbgHafugVqGxgQ6nNnOt0YD9BrBBEhUvCPeZ3+0vdJgH
5dKk1P3VukPi0tYWYFn6tVOpGSQYK28poXqhs+SKaQzV3DJ5hlLc9tG+Haj+s5Rn
umujb/SYqcIZQxAGJz7CNWlJgruDTwBXd0TE1f8LUr5mPzo=
-----END CERTIFICATE-----`;

const aggregateXml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntitiesDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  ID="_aggregate">
  <md:EntityDescriptor entityID="https://sp.example.test/sp">
    <md:SPSSODescriptor
      AuthnRequestsSigned="false"
      WantAssertionsSigned="false"
      protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:AssertionConsumerService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
        Location="https://sp.example.test/acs"
        index="0"
        isDefault="true" />
    </md:SPSSODescriptor>
  </md:EntityDescriptor>
</md:EntitiesDescriptor>`;

const mixedAggregateXml = aggregateXml.replace(
  '</md:EntitiesDescriptor>',
  `<md:EntityDescriptor entityID="https://idp.example.test/idp">
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="signing">
        <ds:KeyInfo><ds:X509Data><ds:X509Certificate>${expiredCertificate.replace(
          /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g,
          ''
        )}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
      </md:KeyDescriptor>
      <md:SingleSignOnService
        Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
        Location="https://idp.example.test/sso" />
    </md:IDPSSODescriptor>
  </md:EntityDescriptor>
</md:EntitiesDescriptor>`
);

interface StoredBatch {
  batchId: string;
  tenantId: string;
  status: 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: number;
  completedAt?: number;
  results: unknown[];
}

function createMockAdapter() {
  const adapter = {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(async (fn: (tx: typeof adapter) => Promise<unknown>) => fn(adapter)),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return adapter;
}

function createAggregateStoreNamespace(input: {
  previewId?: string;
  preview?: unknown;
}): DurableObjectNamespace {
  const batches = new Map<string, StoredBatch>();

  return {
    idFromName: vi.fn(() => ({ toString: () => 'aggregate-store' }) as unknown as DurableObjectId),
    get: vi.fn(() => ({
      fetch: vi.fn(async (request: Request | string, init?: RequestInit) => {
        const url = new URL(typeof request === 'string' ? request : request.url);
        const method = init?.method ?? (typeof request === 'string' ? 'GET' : request.method);
        const readJson = async () =>
          init?.body ? JSON.parse(init.body as string) : await (request as Request).json();

        if (url.pathname === `/preview/${input.previewId}` && method === 'GET') {
          return json(input.preview ?? {}, input.preview ? 200 : 404);
        }
        if (url.pathname === `/preview/${input.previewId}/entities` && method === 'GET') {
          const preview = input.preview as { entities?: unknown[] } | undefined;
          if (!preview) {
            return json({ error: 'not_found' }, 404);
          }
          return json({
            previewId: input.previewId,
            total: preview.entities?.length ?? 0,
            offset: Number(url.searchParams.get('offset') ?? 0),
            limit: Number(url.searchParams.get('limit') ?? 50),
            entities: preview.entities ?? [],
          });
        }
        if (url.pathname === '/preview' && method === 'POST') {
          const body = await readJson();
          return json({ ...body, expiresAt: Date.now() + 30 * 60 * 1000 });
        }
        if (url.pathname === '/batch' && method === 'POST') {
          const body = (await readJson()) as { batchId: string; tenantId: string; total: number };
          const status: StoredBatch = {
            batchId: body.batchId,
            tenantId: body.tenantId,
            status: 'running',
            total: body.total,
            processed: 0,
            succeeded: 0,
            failed: 0,
            startedAt: Date.now(),
            results: [],
          };
          batches.set(body.batchId, status);
          return json(status);
        }
        if (url.pathname.endsWith('/result') && method === 'POST') {
          const batchId = url.pathname.slice('/batch/'.length, -'/result'.length);
          const status = batches.get(batchId)!;
          const result = await readJson();
          status.results.push(result);
          status.processed = status.results.length;
          status.succeeded = status.results.filter(
            (item) => (item as { success: boolean }).success
          ).length;
          status.failed = status.results.filter(
            (item) => !(item as { success: boolean }).success
          ).length;
          return json({ success: true });
        }
        if (url.pathname.endsWith('/complete') && method === 'POST') {
          const batchId = url.pathname.slice('/batch/'.length, -'/complete'.length);
          const status = batches.get(batchId)!;
          status.status = 'completed';
          status.completedAt = Date.now();
          return json({ success: true });
        }
        if (url.pathname.startsWith('/batch/') && method === 'GET') {
          const batchId = url.pathname.substring('/batch/'.length);
          const status = batches.get(batchId);
          return status ? json(status) : json({ error: 'not_found' }, 404);
        }
        return json({ error: 'not_found' }, 404);
      }),
    })),
  } as unknown as DurableObjectNamespace;
}

function createContext(input: {
  body?: unknown;
  rawRequest?: Request;
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  tenantId?: string;
  env?: Partial<Env>;
  waitUntil?: Array<Promise<unknown>>;
}) {
  return {
    req: {
      raw: input.rawRequest,
      json: async () => input.body,
      header: () => undefined,
      query: (name: string) => input.query?.[name],
      param: (name: string) => input.params?.[name],
    },
    get: (key: string) => {
      if (key === 'adminAuth') {
        return {
          permissions: [
            'admin:saml_providers:create',
            'admin:saml_providers:list',
            'admin:saml_providers:update',
          ],
        };
      }
      if (key === 'tenantId') {
        return input.tenantId ?? 'tenant-a';
      }
      return undefined;
    },
    json: (value: unknown, status?: number) =>
      new Response(JSON.stringify(value), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    env: {
      DEFAULT_TENANT_ID: 'tenant-a',
      ...(input.env ?? {}),
    },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        input.waitUntil?.push(promise);
      },
    },
  } as never;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SAML aggregate provider API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('uses the 10 MiB fetch limit for aggregate preview URLs', async () => {
    const adminAdapter = createMockAdapter();
    mocks.safeFetchText.mockResolvedValue(aggregateXml);

    const response = await handlePreviewMetadata(
      createContext({
        body: { metadataUrl: 'https://metadata.example.test/aggregate.xml' },
        env: {
          DB_ADMIN: adminAdapter as never,
          SAML_AGGREGATE_METADATA_STORE: createAggregateStoreNamespace({}) as never,
          SAML_AGGREGATE_METADATA_SIGNATURE_POLICY: 'disabled',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.safeFetchText).toHaveBeenCalledWith(
      'https://metadata.example.test/aggregate.xml',
      expect.objectContaining({ maxResponseSize: 10 * 1024 * 1024 })
    );
  });

  it('rejects an oversized aggregate preview request before buffering its JSON body', async () => {
    const response = await handlePreviewMetadata(
      createContext({
        rawRequest: new Request('https://authrim.example.test/api/admin/saml-metadata/preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(12 * 1024 * 1024 + 1),
          },
          body: '{}',
        }),
      })
    );
    const body = (await response.json()) as { error_description: string };

    expect(response.status).toBe(400);
    expect(body.error_description).toContain('request body exceeds size limit');
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
  });

  it('rejects oversized single-entity XML received through the aggregate preview endpoint', async () => {
    const oversizedSingleMetadata = singleSPMetadata.replace(
      '</md:EntityDescriptor>',
      `<md:Extensions>${'x'.repeat(1024 * 1024)}</md:Extensions></md:EntityDescriptor>`
    );
    const response = await handlePreviewMetadata(
      createContext({ body: { metadataXml: oversizedSingleMetadata } }) as never
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error_description?: string };
    expect(body.error_description).toContain('Single-entity SAML metadata exceeds size limit');
  });

  it('loads normalized SAML federation trust sources during aggregate preview', async () => {
    const adminAdapter = createMockAdapter();
    adminAdapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'trust-source-1',
        tenant_id: 'tenant-a',
        source_type: 'saml_aggregate',
        display_name: 'Normalized federation',
        lifecycle_state: 'active',
        protocol_payload_json: JSON.stringify({
          metadataUrlPatterns: ['https://metadata.example.test/*.xml'],
          certificates: [
            {
              id: 'cert-1',
              certificate: expiredCertificate,
              fingerprintSha256: 'sha256:cert-1',
              createdAt: 1_700_000_000_000,
            },
          ],
          policy: 'warn',
        }),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
      },
    ]);
    mocks.safeFetchText.mockResolvedValue(aggregateXml);

    const response = await handlePreviewMetadata(
      createContext({
        body: { metadataUrl: 'https://metadata.example.test/aggregate.xml' },
        env: {
          DB_ADMIN: adminAdapter as never,
          SAML_AGGREGATE_METADATA_STORE: createAggregateStoreNamespace({}) as never,
          SAML_AGGREGATE_METADATA_SIGNATURE_POLICY: 'disabled',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(adminAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM federation_trust_sources'),
      ['tenant-a']
    );
  });

  it('returns a validation error for unsafe XML during metadata preview', async () => {
    const response = await handlePreviewMetadata(
      createContext({
        body: {
          metadataXml:
            '<!DOCTYPE md:EntityDescriptor [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><md:EntityDescriptor />',
        },
      })
    );
    const body = (await response.json()) as { error_description: string };

    expect(response.status).toBe(400);
    expect(body.error_description).toContain('DOCTYPE declarations are not allowed');
  });

  it('keeps the 1 MiB fetch limit for direct single-entity provider creation', async () => {
    const coreAdapter = createMockAdapter();
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });
    mocks.safeFetchText.mockResolvedValue(singleSPMetadata);

    const response = await handleCreateProvider(
      createContext({
        body: {
          name: 'Example SP',
          providerType: 'saml_sp',
          metadataUrl: 'https://sp.example.test/metadata.xml',
          config: {
            identityMapping: {
              fieldMappingSetId: 'test-saml-outbound',
              destinationFieldPolicies: { mail: 'optional' },
            },
          },
        },
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.safeFetchText).toHaveBeenCalledWith(
      'https://sp.example.test/metadata.xml',
      expect.objectContaining({ maxResponseSize: 1024 * 1024 })
    );
  });

  it('disables newly created providers when every configured signing certificate is expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    const coreAdapter = createMockAdapter();
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleCreateProvider(
      createContext({
        body: {
          name: 'Expired IdP',
          providerType: 'saml_idp',
          enabled: true,
          config: {
            entityId: 'https://idp.example.test/idp',
            ssoUrl: 'https://idp.example.test/sso',
            certificate: expiredCertificate,
            nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            identityMapping: { fieldMappingSetId: 'test-saml-inbound' },
          },
        },
      })
    );

    const body = (await response.json()) as {
      enabled: boolean;
      config: { certificateValidation?: { allExpired: boolean; validUntil?: string } };
    };

    expect(response.status).toBe(201);
    expect(body.enabled).toBe(false);
    expect(body.config.certificateValidation).toMatchObject({
      allExpired: true,
      validUntil: '2026-05-23T16:53:31.000Z',
    });
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO identity_providers'),
      expect.arrayContaining([0])
    );
  });

  it('normalizes SAML IdP JIT linking policy defaults on create', async () => {
    const coreAdapter = createMockAdapter();
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleCreateProvider(
      createContext({
        body: {
          name: 'Example IdP',
          providerType: 'saml_idp',
          enabled: true,
          config: {
            entityId: 'https://idp.example.test/idp',
            ssoUrl: 'https://idp.example.test/sso',
            certificate: 'invalid-test-certificate',
            nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            attributeMapping: { email: 'email' },
            identityMapping: { fieldMappingSetId: 'test-saml-inbound' },
            allowedBindings: ['post'],
          },
        },
      })
    );
    const body = (await response.json()) as {
      config: { jitEmailLinkingPolicy?: string; allowSyntheticEmailFallback?: boolean };
    };

    expect(response.status).toBe(201);
    expect(body.config).toMatchObject({
      jitEmailLinkingPolicy: 'email_linking',
      allowSyntheticEmailFallback: false,
    });
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO identity_providers'),
      expect.arrayContaining([expect.stringContaining('"jitEmailLinkingPolicy":"email_linking"')])
    );
  });

  it('registers a provider disabled when its Field Mapping Set will be configured later', async () => {
    const coreAdapter = createMockAdapter();
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleCreateProvider(
      createContext({
        body: {
          name: 'Draft SP',
          providerType: 'saml_sp',
          enabled: false,
          config: {
            entityId: 'https://sp.example.test/sp',
            acsUrl: 'https://sp.example.test/acs',
            signResponses: true,
          },
        },
      })
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ enabled: false });
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO identity_providers'),
      expect.arrayContaining([0])
    );
  });

  it('registers a disabled provider with a mapping that must be repaired before enablement', async () => {
    const coreAdapter = createMockAdapter();
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleCreateProvider(
      createContext({
        body: {
          name: 'Repairable SP',
          providerType: 'saml_sp',
          enabled: false,
          config: {
            entityId: 'https://sp.example.test/sp',
            acsUrl: 'https://sp.example.test/acs',
            signResponses: true,
            identityMapping: {
              fieldMappingSetId: 'mapping-set-pending-repair',
              fieldMappingVersionId: 'mapping-version-pending-repair',
            },
          },
        },
      })
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      enabled: false,
      config: {
        identityMapping: {
          fieldMappingSetId: 'mapping-set-pending-repair',
          fieldMappingVersionId: 'mapping-version-pending-repair',
        },
      },
    });
  });

  it('rejects enabling a provider until its Field Mapping Set is configured', async () => {
    const coreAdapter = createMockAdapter();
    coreAdapter.queryOne.mockResolvedValue({
      id: 'draft-sp',
      name: 'Draft SP',
      provider_type: 'saml_sp',
      enabled: 0,
      config_json: JSON.stringify({
        entityId: 'https://sp.example.test/sp',
        acsUrl: 'https://sp.example.test/acs',
        signResponses: true,
      }),
    });
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleUpdateProvider(
      createContext({ params: { id: 'draft-sp' }, body: { enabled: true } })
    );

    expect(response.status).toBe(400);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it('allows an invalidly mapped provider to be disabled for emergency containment', async () => {
    const coreAdapter = createMockAdapter();
    coreAdapter.queryOne.mockResolvedValue({
      id: 'broken-sp',
      name: 'Broken SP',
      provider_type: 'saml_sp',
      enabled: 1,
      config_json: JSON.stringify({
        entityId: 'https://sp.example.test/sp',
        acsUrl: 'https://sp.example.test/acs',
        signResponses: true,
        identityMapping: {
          fieldMappingSetId: 'deleted-mapping-set',
          fieldMappingVersionId: 'deleted-mapping-version',
          sourceProfileId: 'directory-subject',
          attributeDescriptors: { mail: { name: 'mail' } },
        },
      }),
    });
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleUpdateProvider(
      createContext({ params: { id: 'broken-sp' }, body: { enabled: false } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: false,
      config: {
        identityMapping: {
          fieldMappingSetId: 'deleted-mapping-set',
          fieldMappingVersionId: 'deleted-mapping-version',
          sourceProfileId: 'directory-subject',
          attributeDescriptors: { mail: { name: 'mail' } },
        },
      },
    });
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE identity_providers'),
      expect.arrayContaining([expect.stringContaining('deleted-mapping-version'), 0])
    );
  });

  it('revalidates a pending Mapping Set before a disabled provider can be enabled again', async () => {
    const coreAdapter = createMockAdapter();
    coreAdapter.queryOne.mockResolvedValue({
      id: 'repairable-sp',
      name: 'Repairable SP',
      provider_type: 'saml_sp',
      enabled: 0,
      config_json: JSON.stringify({
        entityId: 'https://sp.example.test/sp',
        acsUrl: 'https://sp.example.test/acs',
        signResponses: true,
        identityMapping: {
          fieldMappingSetId: 'mapping-set-pending-repair',
          fieldMappingVersionId: 'mapping-version-pending-repair',
        },
      }),
    });
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleUpdateProvider(
      createContext({ params: { id: 'repairable-sp' }, body: { enabled: true } })
    );

    expect(response.status).toBe(400);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid SAML IdP JIT linking policy values on create', async () => {
    const coreAdapter = createMockAdapter();
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleCreateProvider(
      createContext({
        body: {
          name: 'Example IdP',
          providerType: 'saml_idp',
          enabled: true,
          config: {
            entityId: 'https://idp.example.test/idp',
            ssoUrl: 'https://idp.example.test/sso',
            certificate: 'invalid-test-certificate',
            nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            attributeMapping: { email: 'email' },
            allowedBindings: ['post'],
            jitEmailLinkingPolicy: 'unsafe_email_takeover',
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid SAML IdP JIT linking policy values on update', async () => {
    const coreAdapter = createMockAdapter();
    coreAdapter.queryOne.mockResolvedValue({
      id: 'idp-1',
      name: 'Example IdP',
      provider_type: 'saml_idp',
      enabled: 1,
      config_json: JSON.stringify({
        entityId: 'https://idp.example.test/idp',
        ssoUrl: 'https://idp.example.test/sso',
        certificate: 'invalid-test-certificate',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMapping: { email: 'mail' },
        identityMapping: { fieldMappingSetId: 'test-saml-inbound' },
        allowedBindings: ['post'],
      }),
    });
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleUpdateProvider(
      createContext({
        params: { id: 'idp-1' },
        body: {
          config: {
            jitEmailLinkingPolicy: 'unsafe_email_takeover',
          },
        },
      })
    );

    expect(response.status).toBe(400);
    expect(coreAdapter.execute).not.toHaveBeenCalled();
  });

  it('normalizes SAML IdP JIT linking policy updates without dropping existing config', async () => {
    const coreAdapter = createMockAdapter();
    coreAdapter.queryOne.mockResolvedValue({
      id: 'idp-1',
      name: 'Example IdP',
      provider_type: 'saml_idp',
      enabled: 1,
      config_json: JSON.stringify({
        entityId: 'https://idp.example.test/idp',
        ssoUrl: 'https://idp.example.test/sso',
        certificate: 'invalid-test-certificate',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        attributeMapping: { email: 'mail' },
        identityMapping: { fieldMappingSetId: 'test-saml-inbound' },
        allowedBindings: ['post'],
      }),
    });
    mocks.createAuthContextFromHono.mockReturnValue({ coreAdapter });

    const response = await handleUpdateProvider(
      createContext({
        params: { id: 'idp-1' },
        body: {
          config: {
            jitEmailLinkingPolicy: 'disabled',
            allowSyntheticEmailFallback: true,
          },
        },
      })
    );
    const body = (await response.json()) as {
      config: {
        jitEmailLinkingPolicy?: string;
        allowSyntheticEmailFallback?: boolean;
        attributeMapping?: Record<string, string>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.config).toMatchObject({
      jitEmailLinkingPolicy: 'disabled',
      allowSyntheticEmailFallback: true,
      attributeMapping: { email: 'mail' },
    });
    expect(coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE identity_providers'),
      expect.arrayContaining([expect.stringContaining('"jitEmailLinkingPolicy":"disabled"')])
    );
  });

  it.each(['single shard', 'multiple shards', 'shared_pool', 'tenant_exclusive', 'adapter source'])(
    'creates selected aggregate entities through the batch API using the runtime storage resolver: %s',
    async () => {
      const coreAdapter = createMockAdapter();
      const adminAdapter = createMockAdapter();
      const waitUntil: Array<Promise<unknown>> = [];
      mocks.resolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue(coreAdapter);
      const previewId = 'preview-1';
      const env = {
        DEFAULT_TENANT_ID: 'tenant-a',
        DB_ADMIN: adminAdapter as never,
        SAML_AGGREGATE_METADATA_STORE: createAggregateStoreNamespace({
          previewId,
          preview: {
            tenantId: 'tenant-a',
            metadataXml: aggregateXml,
            metadataUrl: 'https://metadata.example.test/aggregate.xml',
            entities: [
              {
                entityId: 'https://sp.example.test/sp',
                role: 'saml_sp',
                acsUrl: 'https://sp.example.test/acs',
                certificateCount: 0,
              },
            ],
            verification: {
              status: 'skipped',
              policy: 'disabled',
              trustProfileId: 'trust-source-1',
            },
          },
        }) as never,
      };

      const startResponse = await handleStartAggregateBatchCreate(
        createContext({
          params: { previewId },
          body: {
            entityIds: ['https://sp.example.test/sp'],
            enabled: true,
            identityMapping: {
              fieldMappingSetId: 'test-saml-outbound',
              destinationFieldPolicies: { mail: 'optional' },
            },
          },
          env,
          waitUntil,
        })
      );

      expect(startResponse.status).toBe(202);
      await Promise.all(waitUntil);

      expect(mocks.resolveAuthCorePersistenceAdapterFromEnv).toHaveBeenCalledWith(env, 'core', {
        tenantId: 'tenant-a',
      });

      const startBody = (await startResponse.json()) as { batchId: string };
      const statusResponse = await handleGetAggregateBatchStatus(
        createContext({
          params: { batchId: startBody.batchId },
          env,
        })
      );
      const status = (await statusResponse.json()) as {
        status: string;
        tenantId: string;
        processed: number;
        succeeded: number;
        failed: number;
        results: unknown[];
      };

      expect(status).toMatchObject({
        status: 'completed',
        tenantId: 'tenant-a',
        processed: 1,
        succeeded: 1,
        failed: 0,
      });
      expect(coreAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO identity_providers'),
        expect.arrayContaining([
          expect.any(String),
          'tenant-a',
          'sp.example.test SP',
          'saml_sp',
          expect.stringContaining('"aggregateEntityId":"https://sp.example.test/sp"'),
          1,
          expect.any(Number),
          expect.any(Number),
        ])
      );
      expect(adminAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO federation_selected_entity_import_events'),
        expect.arrayContaining(['tenant-a', 'trust-source-1', null, expect.any(String)])
      );
    }
  );

  it('rejects an aggregate batch without a Mapping Set before starting async work', async () => {
    const previewId = 'preview-invalid-mapping';
    const waitUntil: Array<Promise<unknown>> = [];
    const response = await handleStartAggregateBatchCreate(
      createContext({
        params: { previewId },
        body: { entityIds: ['https://sp.example.test/sp'] },
        env: {
          DEFAULT_TENANT_ID: 'tenant-a',
          SAML_AGGREGATE_METADATA_STORE: createAggregateStoreNamespace({
            previewId,
            preview: {
              tenantId: 'tenant-a',
              metadataXml: aggregateXml,
              entities: [
                {
                  entityId: 'https://sp.example.test/sp',
                  role: 'saml_sp',
                  acsUrl: 'https://sp.example.test/acs',
                  certificateCount: 0,
                },
              ],
              verification: { status: 'skipped', policy: 'disabled' },
            },
          }) as never,
        },
        waitUntil,
      })
    );

    expect(response.status).toBe(400);
    expect(waitUntil).toHaveLength(0);
    expect(mocks.resolveAuthCorePersistenceAdapterFromEnv).not.toHaveBeenCalled();
  });

  it('registers mixed IdP and SP aggregate entities disabled for per-provider mapping setup', async () => {
    const previewId = 'preview-mixed-draft';
    const waitUntil: Array<Promise<unknown>> = [];
    const coreAdapter = createMockAdapter();
    mocks.resolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue(coreAdapter);
    const response = await handleStartAggregateBatchCreate(
      createContext({
        params: { previewId },
        body: {
          entityIds: ['https://sp.example.test/sp', 'https://idp.example.test/idp'],
          enabled: false,
        },
        env: {
          DEFAULT_TENANT_ID: 'tenant-a',
          SAML_AGGREGATE_METADATA_STORE: createAggregateStoreNamespace({
            previewId,
            preview: {
              tenantId: 'tenant-a',
              metadataXml: mixedAggregateXml,
              entities: [
                { entityId: 'https://sp.example.test/sp', role: 'saml_sp' },
                { entityId: 'https://idp.example.test/idp', role: 'saml_idp' },
              ],
              verification: { status: 'skipped', policy: 'disabled' },
            },
          }) as never,
        },
        waitUntil,
      })
    );

    expect(response.status).toBe(202);
    expect(waitUntil).toHaveLength(1);
    await Promise.all(waitUntil);
    const inserts = coreAdapter.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO identity_providers')
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.every(([, params]) => Array.isArray(params) && params[5] === 0)).toBe(true);
  });

  it('does not expose aggregate preview entities across tenants', async () => {
    const previewId = 'preview-foreign';
    const response = await handleListAggregatePreviewEntities(
      createContext({
        params: { previewId },
        tenantId: 'tenant-a',
        env: {
          SAML_AGGREGATE_METADATA_STORE: createAggregateStoreNamespace({
            previewId,
            preview: {
              tenantId: 'tenant-b',
              metadataXml: aggregateXml,
              verification: { status: 'skipped', policy: 'disabled' },
              entities: [{ entityId: 'https://sp.example.test/sp', role: 'saml_sp' }],
            },
          }) as never,
        },
      })
    );

    expect(response.status).toBe(404);
  });

  it('does not expose aggregate batch status across tenants', async () => {
    const aggregateStore = createAggregateStoreNamespace({
      previewId: 'preview-1',
      preview: {
        tenantId: 'tenant-b',
        metadataXml: aggregateXml,
        verification: { status: 'skipped', policy: 'disabled' },
        entities: [{ entityId: 'https://sp.example.test/sp', role: 'saml_sp' }],
      },
    });
    const env = {
      SAML_AGGREGATE_METADATA_STORE: aggregateStore as never,
    };
    const startResponse = await handleStartAggregateBatchCreate(
      createContext({
        params: { previewId: 'preview-1' },
        tenantId: 'tenant-b',
        body: { entityIds: ['https://sp.example.test/sp'] },
        env,
      })
    );
    const status = (await startResponse.json()) as { batchId: string };

    const response = await handleGetAggregateBatchStatus(
      createContext({
        params: { batchId: status.batchId },
        tenantId: 'tenant-a',
        env,
      })
    );

    expect(response.status).toBe(404);
  });
});
