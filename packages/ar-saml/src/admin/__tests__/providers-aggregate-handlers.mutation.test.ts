/**
 * Aggregate preview/batch handlers and the federation certificate preview: tenant isolation of
 * stored previews and batches, batch-create request validation and request forwarding.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, createAdapter, harnessContext } from './helpers/provider-handler-harness';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  audit: vi.fn(async (..._args: unknown[]) => undefined),
  safeFetch: vi.fn(),
  capability: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  logError: vi.fn(),
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
    safeFetch: mocks.safeFetch,
    tenantCapabilityRefusal: mocks.capability,
    createErrorResponse: (c: never, code: string, options?: unknown) => {
      mocks.errors.push({ code, options });
      return (actual.createErrorResponse as (...args: unknown[]) => unknown)(c, code, options);
    },
    getLogger: () => ({
      module: () => ({
        error: mocks.logError,
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      }),
    }),
  };
});

vi.mock('../metadata-polling', () => ({ refreshFederationMetadataSource: vi.fn() }));

import {
  handleGetAggregateBatchStatus,
  handleListAggregatePreviewEntities,
  handlePreviewFederationTrustCertificate,
  handleStartAggregateBatchCreate,
} from '../providers';
import { RSA_2048_SHA256_PEM } from '../__fixtures__/certificates';

interface StoreCall {
  path: string;
  search: string;
  method: string;
  body: unknown;
}

function store(routes: Record<string, () => Response>) {
  const calls: StoreCall[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    calls.push({
      path: parsed.pathname,
      search: parsed.search,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const route = routes[`${init.method ?? 'GET'} ${parsed.pathname}`];
    return route ? route() : new Response('{}', { status: 404 });
  });
  return {
    calls,
    env: {
      SAML_AGGREGATE_METADATA_STORE: {
        idFromName: vi.fn((name: string) => `id:${name}`),
        get: vi.fn(() => ({ fetch })),
      },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function lastErrorField(): unknown {
  return (mocks.errors.at(-1)?.options as { variables?: { field?: unknown } } | undefined)
    ?.variables?.field;
}

const entities = [
  { entityId: 'https://idp-a', role: 'saml_idp' },
  { entityId: 'https://idp-b', role: 'saml_idp' },
  { entityId: 'https://sp-a', role: 'saml_sp' },
  { entityId: 'https://both', role: 'ambiguous' },
  { entityId: 'https://weird', role: 'unknown' },
];

function preview(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-a',
    metadataXml: '<x/>',
    entities,
    verification: { status: 'verified' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.errors.length = 0;
  mocks.adapter = createAdapter();
  mocks.safeFetch.mockReset();
  mocks.capability.mockResolvedValue(null);
});

describe('handleListAggregatePreviewEntities', () => {
  it('refuses callers without the create permission and requests without a preview id', async () => {
    const s = store({});

    const forbidden = await handleListAggregatePreviewEntities(
      harnessContext({ params: { previewId: 'p-1' }, permissions: [], env: s.env })
    );
    const missing = await handleListAggregatePreviewEntities(harnessContext({ env: s.env }));

    expect([forbidden.status, missing.status]).toEqual([403, 404]);
    expect(s.calls).toEqual([]);
  });

  it('answers 404 for a preview of another tenant and for an unknown preview', async () => {
    const other = store({ 'GET /preview/p-1': () => json(preview({ tenantId: 'tenant-b' })) });
    const unknown = store({});

    const crossTenant = await handleListAggregatePreviewEntities(
      harnessContext({ params: { previewId: 'p-1' }, env: other.env })
    );
    const absent = await handleListAggregatePreviewEntities(
      harnessContext({ params: { previewId: 'p-1' }, env: unknown.env })
    );

    expect([crossTenant.status, absent.status]).toEqual([404, 404]);
    expect(other.calls).toHaveLength(1);
  });

  it('forwards the search, trimmed keywords and paging with defaults', async () => {
    const result = { entities: [], total: 0 };
    const s = store({
      'GET /preview/p-1': () => json(preview()),
      'GET /preview/p-1/entities': () => json(result),
    });

    const response = await handleListAggregatePreviewEntities(
      harnessContext({
        params: { previewId: 'p-1' },
        env: s.env,
        query: { query: 'uni', keyword: [' eduGAIN ', '  ', 'sp'] },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    const forwarded = new URLSearchParams(s.calls[1]?.search);
    expect(forwarded.get('query')).toBe('uni');
    expect(forwarded.getAll('keyword')).toEqual(['eduGAIN', 'sp']);
    expect(forwarded.get('offset')).toBe('0');
    expect(forwarded.get('limit')).toBe('50');
    expect(s.calls[1]?.method).toBe('GET');
  });

  it('forwards explicit paging and omits an empty query', async () => {
    const s = store({
      'GET /preview/p-1': () => json(preview()),
      'GET /preview/p-1/entities': () => json({}),
    });

    await handleListAggregatePreviewEntities(
      harnessContext({
        params: { previewId: 'p-1' },
        env: s.env,
        query: { offset: '100', limit: '10' },
      })
    );

    const forwarded = new URLSearchParams(s.calls[1]?.search);
    expect(forwarded.has('query')).toBe(false);
    expect(forwarded.has('keyword')).toBe(false);
    expect(forwarded.get('offset')).toBe('100');
    expect(forwarded.get('limit')).toBe('10');
  });

  it('answers 404 when the entity listing is not found and 500 when the store is missing', async () => {
    const s = store({ 'GET /preview/p-1': () => json(preview()) });

    const notFound = await handleListAggregatePreviewEntities(
      harnessContext({ params: { previewId: 'p-1' }, env: s.env })
    );
    const broken = await handleListAggregatePreviewEntities(
      harnessContext({ params: { previewId: 'p-1' } })
    );

    expect([notFound.status, broken.status]).toEqual([404, 500]);
    expect(mocks.logError).toHaveBeenCalledWith(
      'List aggregate preview entities error',
      { previewId: 'p-1' },
      expect.any(Error)
    );
  });
});

describe('handleGetAggregateBatchStatus', () => {
  it('returns a batch of the caller tenant and hides other tenants batches', async () => {
    const mine = store({ 'GET /batch/b-1': () => json({ tenantId: 'tenant-a', done: 3 }) });
    const theirs = store({ 'GET /batch/b-1': () => json({ tenantId: 'tenant-b', done: 3 }) });
    const gone = store({});

    const ok = await handleGetAggregateBatchStatus(
      harnessContext({ params: { batchId: 'b-1' }, env: mine.env })
    );
    const hidden = await handleGetAggregateBatchStatus(
      harnessContext({ params: { batchId: 'b-1' }, env: theirs.env })
    );
    const absent = await handleGetAggregateBatchStatus(
      harnessContext({ params: { batchId: 'b-1' }, env: gone.env })
    );

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ tenantId: 'tenant-a', done: 3 });
    expect([hidden.status, absent.status]).toEqual([404, 404]);
  });

  it('refuses callers without list permission, a missing id, and reports store failures', async () => {
    const s = store({});

    expect(
      (
        await handleGetAggregateBatchStatus(
          harnessContext({ params: { batchId: 'b' }, permissions: [] })
        )
      ).status
    ).toBe(403);
    expect((await handleGetAggregateBatchStatus(harnessContext({ env: s.env }))).status).toBe(404);
    expect(
      (await handleGetAggregateBatchStatus(harnessContext({ params: { batchId: 'b/1' } }))).status
    ).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Get aggregate batch status error',
      { batchId: 'b/1' },
      expect.any(Error)
    );
  });

  it('url-encodes the batch id towards the store', async () => {
    const s = store({ 'GET /batch/b%2F1': () => json({ tenantId: 'tenant-a' }) });

    const response = await handleGetAggregateBatchStatus(
      harnessContext({ params: { batchId: 'b/1' }, env: s.env })
    );

    expect(response.status).toBe(200);
  });
});

describe('handleStartAggregateBatchCreate validation', () => {
  async function start(
    body: Record<string, unknown>,
    options: {
      previewBody?: object;
      s?: ReturnType<typeof store>;
      pending?: Array<Promise<unknown>>;
    } = {}
  ) {
    const s =
      options.s ??
      store({
        'GET /preview/p-1': () => json(options.previewBody ?? preview()),
        'POST /batch': () => json({ batchId: 'batch-x', status: 'running' }),
      });
    const response = await handleStartAggregateBatchCreate(
      harnessContext({
        params: { previewId: 'p-1' },
        env: s.env,
        body,
        executionPromises: options.pending,
      })
    );
    return { response, s };
  }

  it('requires at least one non-blank entityId after trimming and de-duplicating', async () => {
    const { response } = await start({ entityIds: ['  ', ''] });

    expect(response.status).toBe(400);
    expect(lastErrorField()).toBe('entityIds');
    expect((await start({})).response.status).toBe(400);
  });

  it('refuses callers without permission and requests without a preview id', async () => {
    const s = store({});

    expect(
      (
        await handleStartAggregateBatchCreate(
          harnessContext({ params: { previewId: 'p-1' }, permissions: [], env: s.env, body: {} })
        )
      ).status
    ).toBe(403);
    expect(
      (await handleStartAggregateBatchCreate(harnessContext({ env: s.env, body: {} }))).status
    ).toBe(404);
  });

  it('answers 404 for a missing or foreign preview', async () => {
    expect(
      (
        await start(
          { entityIds: ['https://idp-a'] },
          { previewBody: preview({ tenantId: 'tenant-b' }) }
        )
      ).response.status
    ).toBe(404);
    expect((await start({ entityIds: ['https://idp-a'] }, { s: store({}) })).response.status).toBe(
      404
    );
  });

  it.each([
    ['an entity that is not in the preview', { entityIds: ['https://nope'] }, 'entityIds'],
    [
      'an entity with an unknown role',
      { entityIds: ['https://weird'], providerType: 'saml_idp' },
      'entityIds',
    ],
    [
      'an SP entity requested as an IdP',
      { entityIds: ['https://sp-a'], providerType: 'saml_idp' },
      'providerType',
    ],
    ['an ambiguous entity without providerType', { entityIds: ['https://both'] }, 'providerType'],
    [
      'enabling without an identity mapping',
      { entityIds: ['https://idp-a'] },
      'identityMapping.fieldMappingSetId',
    ],
    [
      'a mapping for a mix of roles',
      {
        entityIds: ['https://idp-a', 'https://sp-a'],
        enabled: false,
        identityMapping: { fieldMappingSetId: 'set-1' },
      },
      'entityIds',
    ],
  ])('rejects %s', async (_label, body, field) => {
    const { response, s } = await start(body);

    expect(response.status).toBe(400);
    expect(lastErrorField()).toBe(field);
    expect(s.calls.map((call) => call.path)).not.toContain('/batch');
  });

  it('rejects a mixed-role selection with a mapping when providerType is forced to differ', async () => {
    const { response } = await start({
      entityIds: ['https://idp-a', 'https://sp-a'],
      providerType: 'saml_idp',
      enabled: false,
      identityMapping: { fieldMappingSetId: 'set-1' },
    });

    expect(response.status).toBe(400);
    expect(lastErrorField()).toBe('providerType');
  });

  it('starts a disabled draft batch without a mapping and forwards the unique entity ids', async () => {
    const pending: Array<Promise<unknown>> = [];

    const { response, s } = await start(
      { entityIds: ['https://idp-a', ' https://idp-a ', 'https://idp-b'], enabled: false },
      { pending }
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ batchId: 'batch-x', status: 'running' });
    const created = s.calls.find((call) => call.path === '/batch');
    expect(created?.body).toMatchObject({ tenantId: 'tenant-a', total: 2 });
    expect(pending).toHaveLength(1);
    await pending[0];
  });

  it('applies the step-up before starting and stops when it refuses', async () => {
    mocks.stepUp.mockResolvedValueOnce(new Response('step-up', { status: 428 }));

    const { response, s } = await start({ entityIds: ['https://idp-a'], enabled: false });

    expect(response.status).toBe(428);
    expect(s.calls.map((call) => call.path)).not.toContain('/batch');
  });

  it('stops on the capability refusal when the preview carries a metadata URL', async () => {
    mocks.capability.mockResolvedValue({ status: 403, body: { error: 'capability_disabled' } });

    const withUrl = await start(
      { entityIds: ['https://idp-a'], enabled: false },
      { previewBody: preview({ metadataUrl: 'https://md.example.test/agg.xml' }) }
    );
    expect(withUrl.response.status).toBe(403);

    const withoutUrl = await start({ entityIds: ['https://idp-a'], enabled: false });
    expect(withoutUrl.response.status).toBe(202);
  });

  it('answers 500 when the batch cannot be registered', async () => {
    const s = store({
      'GET /preview/p-1': () => json(preview()),
      'POST /batch': () => new Response('{}', { status: 500 }),
    });

    const { response } = await start({ entityIds: ['https://idp-a'], enabled: false }, { s });

    expect(response.status).toBe(500);
    expect(mocks.logError).toHaveBeenCalledWith(
      'Start aggregate batch create error',
      { previewId: 'p-1' },
      expect.any(Error)
    );
  });
});

describe('handlePreviewFederationTrustCertificate', () => {
  const preview = (body: Record<string, unknown>, permissions?: string[]) =>
    handlePreviewFederationTrustCertificate(harnessContext({ body, permissions }));

  it('refuses callers without the create permission', async () => {
    expect((await preview({ certificate: RSA_2048_SHA256_PEM }, [])).status).toBe(403);
  });

  it('requires a certificate or a certificate URL', async () => {
    const response = await preview({ certificate: '  ', certificateUrl: ' ' });

    expect(response.status).toBe(400);
    expect(lastErrorField()).toBe('certificateUrl or certificate');
  });

  it('previews a pasted PEM certificate', async () => {
    const response = await preview({ certificate: `  ${RSA_2048_SHA256_PEM}  ` });

    expect(response.status).toBe(200);
    const body = await bodyOf<{ fingerprintSha256: string }>(response);
    expect(body.fingerprintSha256).toMatch(/^[0-9A-F:]+$/i);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('turns an unparsable certificate into a generic 400', async () => {
    const response = await preview({ certificate: 'garbage' });

    expect(response.status).toBe(400);
    const body = await bodyOf<{ error: string; error_description: string }>(response);
    expect(body.error).toBe('invalid_request');
    expect(typeof body.error_description).toBe('string');
  });

  it('refuses a non-HTTPS or local certificate URL without fetching', async () => {
    expect((await preview({ certificateUrl: 'http://pki.example.test/c.pem' })).status).toBe(400);
    expect((await preview({ certificateUrl: 'https://localhost/c.pem' })).status).toBe(400);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('refuses a certificate URL while metadata URLs are switched off', async () => {
    mocks.capability.mockResolvedValue({ status: 403, body: { error: 'capability_disabled' } });

    const response = await preview({ certificateUrl: 'https://pki.example.test/c.pem' });

    expect(response.status).toBe(403);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('fetches a certificate URL with limits and previews the body', async () => {
    mocks.safeFetch.mockResolvedValue(new Response(RSA_2048_SHA256_PEM, { status: 200 }));

    const response = await preview({ certificateUrl: ' https://pki.example.test/c.pem ' });

    expect(response.status).toBe(200);
    expect(mocks.safeFetch).toHaveBeenCalledWith('https://pki.example.test/c.pem', {
      timeoutMs: 10000,
      maxResponseSize: 64 * 1024,
      headers: { Accept: 'application/pkix-cert, application/x-x509-ca-cert, text/plain, */*' },
    });
  });

  it('answers 400 for a failed fetch and for an oversized response', async () => {
    mocks.safeFetch.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    const failed = await preview({ certificateUrl: 'https://pki.example.test/c.pem' });
    mocks.safeFetch.mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1), { status: 200 }));
    const oversized = await preview({ certificateUrl: 'https://pki.example.test/c.pem' });

    expect(failed.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      error_description: 'Certificate response exceeds size limit',
    });
  });

  it('accepts a response of exactly the size limit', async () => {
    mocks.safeFetch.mockResolvedValue(new Response(RSA_2048_SHA256_PEM.padEnd(64 * 1024, '\n')));

    const response = await preview({ certificateUrl: 'https://pki.example.test/c.pem' });

    expect(response.status).toBe(200);
  });
});
