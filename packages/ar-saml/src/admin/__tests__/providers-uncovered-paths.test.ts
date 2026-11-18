import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

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
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: mocks.audit,
    safeFetchText: mocks.safeFetchText,
    safeFetch: mocks.safeFetch,
    listEnvironmentTenantDefaultStores: vi.fn(async () => [{ tenantId: 'tenant-a' }]),
    bumpAuthenticationMethodsCacheRevision: vi.fn(async () => undefined),
    readLiteModeAuthoritative: vi.fn(async () => 'off'),
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
  handleCreateAttributePreset,
  handleDeleteAttributePreset,
  handleDeleteProvider,
  handleGetAggregateBatchStatus,
  handleGetProvider,
  handleListAggregatePreviewEntities,
  handleListAttributePresets,
  handlePreviewFederationTrustCertificate,
  handlePreviewMetadata,
  handleRefreshFederationMetadataSource,
  handleRefreshMetadata,
  handleStartAggregateBatchCreate,
  handleUpdateProvider,
  handleUpdateSAMLLocalSigning,
  handleUpdateSAMLSettings,
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

interface ContextOptions {
  body?: unknown;
  id?: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  queries?: Record<string, string[]>;
  permissions?: string[] | null;
  tenantId?: string;
  env?: Record<string, unknown>;
  waitUntil?: Array<Promise<unknown>>;
  contentType?: string | null;
}

function context(options: ContextOptions = {}): Parameters<typeof handleCreateAttributePreset>[0] {
  const params: Record<string, string | undefined> = {
    ...(options.id ? { id: options.id } : {}),
    ...(options.params ?? {}),
  };
  return {
    env: options.env ?? {},
    req: {
      json: vi.fn(async () => options.body),
      param: vi.fn((name: string) => params[name]),
      query: vi.fn((name: string) => options.query?.[name]),
      queries: vi.fn((name: string) => options.queries?.[name]),
      header: vi.fn((name: string) => {
        if (name.toLowerCase() !== 'content-type') return undefined;
        if (options.contentType !== undefined) return options.contentType ?? undefined;
        return options.body !== undefined ? 'application/json' : undefined;
      }),
    },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        options.waitUntil?.push(promise);
      },
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
    provider_type: 'saml_idp',
    config_json: JSON.stringify({ entityId: 'https://idp.example.test' }),
    enabled: 1,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter = createAdapter();
  mocks.safeFetchText.mockReset();
  mocks.safeFetch.mockReset();
  mocks.refreshFederationSource.mockReset();
});

describe('SAML admin permission refusals', () => {
  const handlers = [
    ['handleListAttributePresets', handleListAttributePresets],
    ['handleUpdateSAMLSettings', handleUpdateSAMLSettings],
    ['handleUpdateSAMLLocalSigning', handleUpdateSAMLLocalSigning],
    ['handleCreateAttributePreset', handleCreateAttributePreset],
    ['handleDeleteAttributePreset', handleDeleteAttributePreset],
    ['handleGetProvider', handleGetProvider],
    ['handleUpdateProvider', handleUpdateProvider],
    ['handleDeleteProvider', handleDeleteProvider],
    ['handleRefreshMetadata', handleRefreshMetadata],
    ['handleRefreshFederationMetadataSource', handleRefreshFederationMetadataSource],
    ['handlePreviewFederationTrustCertificate', handlePreviewFederationTrustCertificate],
    ['handleListAggregatePreviewEntities', handleListAggregatePreviewEntities],
    ['handleStartAggregateBatchCreate', handleStartAggregateBatchCreate],
    ['handleGetAggregateBatchStatus', handleGetAggregateBatchStatus],
  ] as const;

  it.each(handlers)('%s refuses a caller without the permission', async (_name, handler) => {
    const response = await handler(
      context({ id: 'x', params: { previewId: 'p', batchId: 'b' }, permissions: [] })
    );
    expect(response.status).toBe(403);
    expect(mocks.adapter!.queryOne).not.toHaveBeenCalled();
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it.each(handlers)('%s refuses an unauthenticated caller', async (_name, handler) => {
    const response = await handler(
      context({ id: 'x', params: { previewId: 'p', batchId: 'b' }, permissions: null })
    );
    expect(response.status).toBe(401);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });
});

describe('SAML attribute presets', () => {
  const rule = { name: 'mail', source: 'email' };

  it('rejects a rule without a name or source', async () => {
    const response = await handleCreateAttributePreset(
      context({
        body: { label: 'L', attributeReleasePolicy: { attributes: [{ name: 'mail' }] } },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('stores a trimmed preset with a default profile and description, then audits it', async () => {
    const response = await handleCreateAttributePreset(
      context({ body: { label: '  Staff  ', attributeReleasePolicy: { attributes: [rule] } } })
    );
    expect(response.status).toBe(201);
    const { preset } = await response.json<{ preset: Record<string, unknown> }>();
    expect(preset).toMatchObject({
      label: 'Staff',
      description: '',
      profile: 'custom',
      stability: 'custom',
      applicationMode: 'clone_edit',
      appliesTo: 'sp_attribute_release',
      isCustom: true,
      attributeReleasePolicy: { attributes: [rule] },
    });
    expect(String(preset.id)).toMatch(/^custom:/);
    const [sql, params] = mocks.adapter!.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO saml_attribute_presets');
    expect(params.slice(0, 9)).toEqual([
      preset.id,
      'tenant-a',
      'Staff',
      '',
      'sp_attribute_release',
      'custom',
      'custom',
      'clone_edit',
      JSON.stringify({ attributes: [rule] }),
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'saml.attribute_preset.created',
        resource: 'saml_attribute_preset',
        resourceId: preset.id,
      })
    );
  });

  it('keeps a supplied profile and trimmed description', async () => {
    const response = await handleCreateAttributePreset(
      context({
        body: {
          label: 'L',
          profile: 'research',
          description: ' desc ',
          attributeReleasePolicy: { attributes: [rule] },
        },
      })
    );
    const { preset } = await response.json<{ preset: Record<string, unknown> }>();
    expect(preset).toMatchObject({ profile: 'research', description: 'desc' });
  });

  it('answers 500 and records the failure when the insert fails', async () => {
    mocks.adapter!.execute.mockRejectedValueOnce(new Error('db down'));
    const response = await handleCreateAttributePreset(
      context({ body: { label: 'L', attributeReleasePolicy: { attributes: [rule] } } })
    );
    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Create SAML attribute preset error',
      {},
      expect.any(Error)
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'saml.attribute_preset.created',
        resource: 'saml_attribute_preset',
        resourceId: 'unknown',
      })
    );
  });

  it('refuses to delete a built-in preset id', async () => {
    const response = await handleDeleteAttributePreset(context({ id: 'builtin:x' }));
    expect(response.status).toBe(400);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('answers 404 when the custom preset does not exist', async () => {
    mocks.adapter!.execute.mockResolvedValueOnce({ rowsAffected: 0 });
    const response = await handleDeleteAttributePreset(context({ id: 'custom:gone' }));
    expect(response.status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('deletes a custom preset scoped to the tenant and audits it as a warning', async () => {
    const response = await handleDeleteAttributePreset(context({ id: 'custom:a' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.adapter!.execute).toHaveBeenCalledWith(
      'DELETE FROM saml_attribute_presets WHERE id = ? AND tenant_id = ?',
      ['custom:a', 'tenant-a']
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'saml.attribute_preset.deleted',
        resourceId: 'custom:a',
        severity: 'warning',
      })
    );
  });

  it('answers 500 when the delete fails', async () => {
    mocks.adapter!.execute.mockRejectedValueOnce(new Error('db down'));
    const response = await handleDeleteAttributePreset(context({ id: 'custom:a' }));
    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Delete SAML attribute preset error',
      { presetId: 'custom:a' },
      expect.any(Error)
    );
  });
});

describe('SAML provider deletion', () => {
  it('answers 404 when the row vanishes between the lookup and the delete', async () => {
    mocks.adapter!.queryOne.mockResolvedValueOnce({
      id: 'provider-a',
      provider_type: 'saml_idp',
      config_json: '{}',
    });
    mocks.adapter!.execute.mockResolvedValueOnce({ rowsAffected: 0 });
    const response = await handleDeleteProvider(context({ id: 'provider-a' }));
    expect(response.status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('records a failed delete against the provider id', async () => {
    mocks.adapter!.queryOne.mockResolvedValueOnce({
      id: 'provider-a',
      provider_type: 'saml_idp',
      config_json: '{}',
    });
    mocks.adapter!.execute.mockRejectedValueOnce(new Error('db down'));
    const response = await handleDeleteProvider(context({ id: 'provider-a' }));
    expect(response.status).toBe(500);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'saml.provider.deleted',
        resource: 'saml_provider',
        resourceId: 'provider-a',
      })
    );
  });
});

describe('metadata refresh request validation', () => {
  it('rejects a non-string metadataUrl before fetching', async () => {
    mocks.adapter!.queryOne.mockResolvedValueOnce(providerRow());
    const response = await handleRefreshMetadata(
      context({ id: 'provider-a', body: { metadataUrl: 42 } })
    );
    expect(response.status).toBe(400);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
  });

  it('requires a metadata URL when none is stored or supplied', async () => {
    mocks.adapter!.queryOne.mockResolvedValueOnce(providerRow());
    const response = await handleRefreshMetadata(context({ id: 'provider-a' }));
    expect(response.status).toBe(400);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
  });

  it('ignores a non-JSON body and uses the stored URL', async () => {
    mocks.adapter!.queryOne.mockResolvedValueOnce(
      providerRow({
        config_json: JSON.stringify({
          entityId: 'https://idp.example.test',
          metadataUrl: 'http://insecure.example.test/md.xml',
        }),
      })
    );
    const response = await handleRefreshMetadata(
      context({ id: 'provider-a', body: { metadataUrl: 'ignored' }, contentType: 'text/plain' })
    );
    // The stored http:// URL is refused by the SSRF guard, so nothing is fetched.
    expect(response.status).toBe(400);
    expect(mocks.safeFetchText).not.toHaveBeenCalled();
  });
});

describe('federation source refresh failures', () => {
  it.each([
    ['federation_source_metadata_url_required', 400],
    ['metadata_refresh_superseded', 409],
    ['federation_trust_context_changed', 409],
    ['something_else', 400],
  ])('maps %s to %i', async (code, status) => {
    mocks.refreshFederationSource.mockRejectedValueOnce(new Error(code));
    const response = await handleRefreshFederationMetadataSource(context({ id: 'source-a' }));
    expect(response.status).toBe(status);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'saml.federation.metadata_refresh_requested',
        resource: 'federation_trust_source',
        resourceId: 'source-a',
      })
    );
  });

  it('answers 404 without a source id', async () => {
    const response = await handleRefreshFederationMetadataSource(context());
    expect(response.status).toBe(404);
    expect(mocks.refreshFederationSource).not.toHaveBeenCalled();
  });
});

describe('federation trust certificate preview', () => {
  it('requires a certificate or a certificate URL', async () => {
    const response = await handlePreviewFederationTrustCertificate(
      context({ body: { certificate: '  ', certificateUrl: ' ' } })
    );
    expect(response.status).toBe(400);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('refuses a non-HTTPS certificate URL without fetching', async () => {
    const response = await handlePreviewFederationTrustCertificate(
      context({ body: { certificateUrl: 'http://ca.example.test/c.pem' } })
    );
    expect(response.status).toBe(400);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('refuses a certificate URL that answers with an error status', async () => {
    mocks.safeFetch.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const response = await handlePreviewFederationTrustCertificate(
      context({ body: { certificateUrl: 'https://ca.example.test/c.pem' } })
    );
    expect(response.status).toBe(400);
    expect(mocks.safeFetch).toHaveBeenCalledWith('https://ca.example.test/c.pem', {
      timeoutMs: 10000,
      maxResponseSize: 64 * 1024,
      headers: { Accept: 'application/pkix-cert, application/x-x509-ca-cert, text/plain, */*' },
    });
  });

  it('rejects an oversized certificate body and explains why', async () => {
    mocks.safeFetch.mockResolvedValueOnce(new Response(new Uint8Array(64 * 1024 + 1)));
    const response = await handlePreviewFederationTrustCertificate(
      context({ body: { certificateUrl: 'https://ca.example.test/c.pem' } })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Certificate response exceeds size limit',
    });
  });

  it('rejects an oversized body streamed in chunks', async () => {
    const chunk = new Uint8Array(40 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    mocks.safeFetch.mockResolvedValueOnce(new Response(stream));
    const response = await handlePreviewFederationTrustCertificate(
      context({ body: { certificateUrl: 'https://ca.example.test/c.pem' } })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_description: 'Certificate response exceeds size limit',
    });
  });

  it('answers a generic message for an unreadable PEM', async () => {
    const response = await handlePreviewFederationTrustCertificate(
      context({ body: { certificate: 'not a certificate' } })
    );
    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe('invalid_request');
  });

  it('reads a chunked URL response within the limit and rejects its unreadable content', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not a '));
        controller.enqueue(new TextEncoder().encode('certificate'));
        controller.close();
      },
    });
    mocks.safeFetch.mockResolvedValueOnce(new Response(stream));
    const response = await handlePreviewFederationTrustCertificate(
      context({ body: { certificateUrl: 'https://ca.example.test/c.pem' } })
    );
    expect(response.status).toBe(400);
  });
});

function createStore(
  respond: (path: string, init: RequestInit) => Response | Promise<Response>
): Record<string, unknown> {
  const fetch = vi.fn(async (url: string, init: RequestInit) =>
    respond(new URL(url).pathname + new URL(url).search, init)
  );
  return {
    SAML_AGGREGATE_METADATA_STORE: {
      idFromName: vi.fn(() => 'store-id'),
      get: vi.fn(() => ({ fetch })),
      fetch,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('aggregate preview entity listing', () => {
  const preview = { tenantId: 'tenant-a', entities: [], metadataXml: '<x/>', verification: {} };

  it('answers 404 without a preview id', async () => {
    const response = await handleListAggregatePreviewEntities(
      context({ env: createStore(() => jsonResponse({})) })
    );
    expect(response.status).toBe(404);
  });

  it('forwards the trimmed filters, offset and limit to the store', async () => {
    const env = createStore((path) =>
      path.startsWith('/preview/p-1?') || path === '/preview/p-1'
        ? jsonResponse(preview)
        : jsonResponse({ previewId: 'p-1', total: 0, offset: 5, limit: 10, entities: [] })
    );
    const response = await handleListAggregatePreviewEntities(
      context({
        env,
        params: { previewId: 'p-1' },
        query: { query: 'uni', offset: '5', limit: '10' },
        queries: { keyword: [' a ', '  ', 'b'] },
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      previewId: 'p-1',
      total: 0,
      offset: 5,
      limit: 10,
      entities: [],
    });
    const fetchMock = (env.SAML_AGGREGATE_METADATA_STORE as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://saml-aggregate-metadata.local/preview/p-1/entities?query=uni&keyword=a&keyword=b&offset=5&limit=10'
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('encodes the preview id in the store path', async () => {
    const env = createStore((path) =>
      path === '/preview/p-1' ? jsonResponse(preview) : jsonResponse({ entities: [] })
    );
    await handleListAggregatePreviewEntities(context({ env, params: { previewId: 'p 1' } }));
    const fetchMock = (env.SAML_AGGREGATE_METADATA_STORE as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://saml-aggregate-metadata.local/preview/p%201'
    );
  });

  it('uses 0 and 50 when no paging is supplied', async () => {
    const env = createStore((path) =>
      path === '/preview/p-1' ? jsonResponse(preview) : jsonResponse({ entities: [] })
    );
    await handleListAggregatePreviewEntities(context({ env, params: { previewId: 'p-1' } }));
    const fetchMock = (env.SAML_AGGREGATE_METADATA_STORE as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://saml-aggregate-metadata.local/preview/p-1/entities?offset=0&limit=50'
    );
  });

  it('answers 404 when the entity listing is unavailable', async () => {
    const env = createStore((path) =>
      path === '/preview/p-1' ? jsonResponse(preview) : jsonResponse({}, 500)
    );
    const response = await handleListAggregatePreviewEntities(
      context({ env, params: { previewId: 'p-1' } })
    );
    expect(response.status).toBe(404);
  });

  it('answers 500 and logs when the store binding is missing', async () => {
    const response = await handleListAggregatePreviewEntities(
      context({ params: { previewId: 'p-1' } })
    );
    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'List aggregate preview entities error',
      { previewId: 'p-1' },
      expect.any(Error)
    );
  });
});

describe('aggregate batch status', () => {
  it('answers 404 without a batch id', async () => {
    const response = await handleGetAggregateBatchStatus(context());
    expect(response.status).toBe(404);
  });

  it('answers 404 when the store does not know the batch', async () => {
    const env = createStore(() => jsonResponse({}, 404));
    const response = await handleGetAggregateBatchStatus(
      context({ env, params: { batchId: 'b-1' } })
    );
    expect(response.status).toBe(404);
  });

  it('answers 404 for another tenant batch and returns the status for the owner', async () => {
    const status = { batchId: 'b-1', tenantId: 'tenant-b', status: 'running' };
    const env = createStore(() => jsonResponse(status));
    const foreign = await handleGetAggregateBatchStatus(
      context({ env, params: { batchId: 'b-1' }, tenantId: 'tenant-a' })
    );
    expect(foreign.status).toBe(404);
    const owner = await handleGetAggregateBatchStatus(
      context({ env, params: { batchId: 'b-1' }, tenantId: 'tenant-b' })
    );
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual(status);
  });

  it('answers 500 and logs when the store binding is missing', async () => {
    const response = await handleGetAggregateBatchStatus(context({ params: { batchId: 'b-1' } }));
    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Get aggregate batch status error',
      { batchId: 'b-1' },
      expect.any(Error)
    );
  });
});

describe('preview metadata role detection', () => {
  const md = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"';
  const proto = 'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"';

  async function preview(metadataXml: string) {
    const response = await handlePreviewMetadata(context({ body: { metadataXml } }));
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  }

  it('refuses metadata that carries both roles', async () => {
    const result = await preview(
      `<md:EntityDescriptor ${md} entityID="urn:both"><md:IDPSSODescriptor ${proto}/><md:SPSSODescriptor ${proto}/></md:EntityDescriptor>`
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: 'invalid_request',
      error_description: 'metadata_invalid_xml',
    });
    expect(String(result.body.message)).toContain('both Identity Provider and Service Provider');
  });

  it('refuses metadata that carries neither role', async () => {
    const result = await preview(
      `<md:EntityDescriptor ${md} entityID="urn:none"></md:EntityDescriptor>`
    );
    expect(result.status).toBe(400);
    expect(result.body.message).toBe(
      'Invalid metadata: missing IDPSSODescriptor or SPSSODescriptor'
    );
  });

  it('refuses a document without an EntityDescriptor', async () => {
    const result = await preview(`<md:Other ${md}/>`);
    expect(result.status).toBe(400);
    expect(result.body.error_description).toBe('metadata_invalid_xml');
  });

  it('requires metadata XML or a URL', async () => {
    const response = await handlePreviewMetadata(context({ body: {} }));
    expect(response.status).toBe(400);
  });
});

describe('provider lookup', () => {
  it('answers 404 when the provider to read is missing', async () => {
    const response = await handleGetProvider(context({ id: 'missing' }));
    expect(response.status).toBe(404);
  });
});
