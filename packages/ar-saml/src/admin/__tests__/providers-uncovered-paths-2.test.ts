import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  stepUp: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  adapter: null as ReturnType<typeof createAdapter> | null,
  dedicated: null as (() => unknown) | null,
  emitLog: vi.fn(async () => ({})),
}));

vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', () => ({
  emitLogIcebergRow: mocks.emitLog,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireAdminStepUp: mocks.stepUp,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.dedicated?.()),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.adapter),
    createAuditLog: vi.fn(async () => undefined),
    listEnvironmentTenantDefaultStores: vi.fn(async () => [{ tenantId: 'tenant-a' }]),
    bumpAuthenticationMethodsCacheRevision: vi.fn(async () => undefined),
    readLiteModeAuthoritative: vi.fn(async () => 'off'),
    getUIConfig: vi.fn(async () => null),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import {
  getIdPConfigByEntityId,
  getIdPUsageKeyByEntityId,
  handleStartAggregateBatchCreate,
  parseIdPMetadata,
  parseSPMetadata,
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

function context(options: {
  body?: unknown;
  params?: Record<string, string>;
  env?: Record<string, unknown>;
  waitUntil?: Array<Promise<unknown>>;
}): Parameters<typeof handleStartAggregateBatchCreate>[0] {
  return {
    env: options.env ?? {},
    req: {
      json: vi.fn(async () => options.body),
      param: vi.fn((name: string) => options.params?.[name]),
      header: vi.fn(() => undefined),
    },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        options.waitUntil?.push(promise);
      },
    },
    get: vi.fn((name: string) => {
      if (name === 'tenantId') return 'tenant-a';
      if (name === 'adminAuth') return { permissions: Object.values(ADMIN_PERMISSIONS) };
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

const MD = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"';
const DS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const PROTO = 'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

function spEntity(entityId: string): string {
  return `<md:EntityDescriptor entityID="${entityId}"><md:SPSSODescriptor ${PROTO}><md:AssertionConsumerService Binding="${POST}" Location="https://sp.example.test/acs" index="0" isDefault="true"/></md:SPSSODescriptor></md:EntityDescriptor>`;
}

function idpEntity(entityId: string, certificate = 'VEVTVA=='): string {
  return `<md:EntityDescriptor entityID="${entityId}"><md:IDPSSODescriptor ${PROTO}><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
}

function aggregate(...entities: string[]): string {
  return `<md:EntitiesDescriptor ${MD} ${DS} ID="_agg">${entities.join('')}</md:EntitiesDescriptor>`;
}

interface StoreCall {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function createStore(preview: object | null | (() => object | null)) {
  const calls: StoreCall[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    calls.push({
      path,
      method,
      body:
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    if (path === '/preview/p-1') {
      const value: object | null =
        typeof preview === 'function' ? (preview as () => object | null)() : preview;
      return new Response(JSON.stringify(value ?? {}), { status: value ? 200 : 404 });
    }
    if (path === '/batch' && method === 'POST') {
      return new Response(JSON.stringify({ batchId: 'b', status: 'running' }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  return {
    calls,
    env: {
      SAML_AGGREGATE_METADATA_STORE: {
        idFromName: vi.fn(() => 'id'),
        get: vi.fn(() => ({ fetch })),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter = createAdapter();
  mocks.dedicated = () => mocks.adapter;
});

const SP = 'https://sp.example.test/sp';
const IDP = 'https://idp.example.test/idp';

function previewOf(
  entities: unknown,
  extra: Record<string, unknown> = {},
  xml = aggregate(spEntity(SP), idpEntity(IDP))
) {
  return {
    tenantId: 'tenant-a',
    metadataXml: xml,
    entities,
    verification: { status: 'skipped', policy: 'disabled' },
    ...extra,
  };
}

const bothEntities = [
  { entityId: SP, role: 'saml_sp' },
  { entityId: IDP, role: 'saml_idp' },
];

async function startBatch(
  store: ReturnType<typeof createStore>,
  body: Record<string, unknown>
): Promise<Response> {
  const waitUntil: Array<Promise<unknown>> = [];
  const response = await handleStartAggregateBatchCreate(
    context({ env: store.env, params: { previewId: 'p-1' }, body, waitUntil })
  );
  await Promise.all(waitUntil);
  return response;
}

describe('aggregate batch request validation', () => {
  it('requires at least one non-blank entity id', async () => {
    const response = await startBatch(createStore(previewOf(bothEntities)), {
      entityIds: ['  ', ''],
    });
    expect(response.status).toBe(400);
  });

  it('requires entity ids in the body', async () => {
    const response = await startBatch(createStore(previewOf(bothEntities)), {});
    expect(response.status).toBe(400);
  });

  it('answers 404 without a preview id', async () => {
    const response = await handleStartAggregateBatchCreate(
      context({ env: createStore(null).env, body: { entityIds: [SP] } })
    );
    expect(response.status).toBe(404);
  });

  it('answers 500 when the store binding is missing', async () => {
    const response = await handleStartAggregateBatchCreate(
      context({ params: { previewId: 'p-1' }, body: { entityIds: [SP] } })
    );
    expect(response.status).toBe(500);
  });

  it.each([
    ['a preview without an entity list', undefined, { entityIds: [SP], enabled: false }],
    ['an entity outside the preview', bothEntities, { entityIds: ['urn:unknown'], enabled: false }],
    [
      'an entity with an unknown role',
      [{ entityId: SP, role: 'weird' }],
      { entityIds: [SP], enabled: false },
    ],
    [
      'a provider type that contradicts the entity role',
      bothEntities,
      { entityIds: [IDP], providerType: 'saml_sp', enabled: false },
    ],
    [
      'an ambiguous entity without a provider type',
      [{ entityId: SP, role: 'ambiguous' }],
      { entityIds: [SP], enabled: false },
    ],
    [
      'a mapping over entities of different roles',
      bothEntities,
      { entityIds: [SP, IDP], identityMapping: { fieldMappingSetId: 'set' }, enabled: false },
    ],
  ])('refuses %s with a 400 before any batch starts', async (_label, entities, body) => {
    const store = createStore(previewOf(entities));
    const response = await startBatch(store, body);
    expect(response.status).toBe(400);
    expect(store.calls.some((call) => call.path === '/batch')).toBe(false);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('answers with the invalid-value error code', async () => {
    const store = createStore(previewOf(bothEntities));
    const response = await startBatch(store, {
      entityIds: [IDP],
      providerType: 'saml_sp',
      enabled: false,
    });
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'The provided value is invalid.',
      error_code: 'AR130003',
    });
  });

  it('accepts an IdP mapping request while disabled without resolving the mapping', async () => {
    const store = createStore(previewOf(bothEntities));
    const response = await startBatch(store, {
      entityIds: [IDP],
      identityMapping: { fieldMappingSetId: 'set' },
      enabled: false,
    });
    expect(response.status).toBe(202);
  });

  it('refuses an enabled IdP mapping that the inbound contract cannot satisfy', async () => {
    const store = createStore(previewOf(bothEntities));
    const response = await startBatch(store, {
      entityIds: [IDP],
      identityMapping: { fieldMappingSetId: 'set', inboundContract: 'connection-v1' },
    });
    expect(response.status).toBe(400);
    expect(store.calls.some((call) => call.path === '/batch')).toBe(false);
  });
});

describe('aggregate batch processing', () => {
  it('imports the selected entities as disabled providers and reports each result', async () => {
    const store = createStore(previewOf(bothEntities));
    const response = await startBatch(store, { entityIds: [SP, IDP, SP], enabled: false });
    expect(response.status).toBe(202);
    const batchStart = store.calls.find((call) => call.path === '/batch');
    expect(batchStart?.body).toMatchObject({ tenantId: 'tenant-a', total: 2 });
    const inserts = mocks.adapter!.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO identity_providers')
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.map(([, params]) => (params as unknown[])[2])).toEqual([
      'sp.example.test SP',
      'idp.example.test IdP',
    ]);
    expect(inserts.map(([, params]) => (params as unknown[])[3])).toEqual(['saml_sp', 'saml_idp']);
    expect(inserts.every(([, params]) => (params as unknown[])[5] === 0)).toBe(true);
    const results = store.calls.filter((call) => call.path.endsWith('/result'));
    expect(results.map((call) => call.body)).toEqual([
      expect.objectContaining({ entityId: SP, success: true, providerType: 'saml_sp' }),
      expect.objectContaining({ entityId: IDP, success: true, providerType: 'saml_idp' }),
    ]);
    expect(store.calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(store.calls.at(-1)?.path).toMatch(/\/complete$/);
  });

  it('records a failure for an entity missing from the metadata and keeps going', async () => {
    const store = createStore(previewOf(bothEntities, {}, aggregate(spEntity(SP))));
    await startBatch(store, { entityIds: [IDP, SP], enabled: false });
    const results = store.calls.filter((call) => call.path.endsWith('/result'));
    expect(results.map((call) => call.body)).toEqual([
      {
        entityId: IDP,
        success: false,
        error: `Aggregate metadata does not contain entityID: ${IDP}`,
      },
      expect.objectContaining({ entityId: SP, success: true }),
    ]);
    expect(store.calls.at(-1)?.path).toMatch(/\/complete$/);
  });

  it('records a failure for an entity that already has a provider of that role', async () => {
    mocks.adapter!.query.mockResolvedValueOnce([
      { provider_type: 'saml_sp', config_json: JSON.stringify({ entityId: SP }) },
      { provider_type: 'saml_idp', config_json: 'not json' },
      { provider_type: 'saml_idp', config_json: JSON.stringify({}) },
    ]);
    const store = createStore(previewOf(bothEntities));
    await startBatch(store, { entityIds: [SP], enabled: false });
    const results = store.calls.filter((call) => call.path.endsWith('/result'));
    expect(results.map((call) => call.body)).toEqual([
      { entityId: SP, success: false, error: `Provider already exists for entityID: ${SP}` },
    ]);
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('records a failure when the metadata has no descriptor for the chosen role', async () => {
    const store = createStore(previewOf([{ entityId: SP, role: 'ambiguous' }]));
    await startBatch(store, { entityIds: [SP], providerType: 'saml_idp', enabled: false });
    const result = store.calls.find((call) => call.path.endsWith('/result'));
    expect(result?.body).toMatchObject({ entityId: SP, success: false });
    expect(String(result?.body?.error)).toContain('not an Identity Provider');
    expect(store.calls.at(-1)?.path).toMatch(/\/complete$/);
  });

  it('fails the whole batch when the preview disappears before processing', async () => {
    let reads = 0;
    const store = createStore(() => (reads++ === 0 ? previewOf(bothEntities) : null));
    const response = await startBatch(store, { entityIds: [SP], enabled: false });
    expect(response.status).toBe(202);
    const failure = store.calls.find((call) => call.path.endsWith('/fail'));
    expect(failure).toMatchObject({
      method: 'POST',
      body: { error: 'Aggregate preview not found' },
    });
    expect(store.calls.some((call) => call.path.endsWith('/complete'))).toBe(false);
  });

  it('fails the whole batch when the verified trust context is no longer current', async () => {
    const preview = previewOf(bothEntities, {
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'sha256:current',
      },
    });
    const store = createStore(preview);
    mocks.adapter!.queryOne.mockResolvedValue({ id: 'source-a', snapshot_hash: 'sha256:other' });
    // The step-up and validation do not look at the trust context; only processing does.
    await startBatch(store, { entityIds: [SP], enabled: false });
    const failure = store.calls.find((call) => call.path.endsWith('/fail'));
    expect(failure?.body).toEqual({ error: 'Aggregate preview trust context changed' });
    expect(mocks.adapter!.execute).not.toHaveBeenCalled();
  });

  it('emits import evidence for a trusted source', async () => {
    const preview = previewOf(bothEntities, {
      verification: {
        status: 'verified',
        policy: 'strict',
        trustProfileId: 'source-a',
        trustContextSnapshotHash: 'sha256:current',
      },
    });
    const store = createStore(preview);
    mocks.adapter!.queryOne.mockResolvedValue({ id: 'source-a', snapshot_hash: 'sha256:current' });
    const response = await startBatch(store, { entityIds: [SP], enabled: false });
    expect(response.status).toBe(202);
    expect(mocks.emitLog).toHaveBeenCalledTimes(1);
    const input = mocks.emitLog.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input[1]).toMatchObject({
      tenantId: 'tenant-a',
      sourceDataset: 'admin.federation_selected_entity_import_events',
      overview: { action: 'create_provider', result: 'success' },
    });
  });
});

describe('aggregate batch failure evidence', () => {
  it('emits failed import evidence for a trusted source', async () => {
    const preview = previewOf(
      bothEntities,
      {
        verification: {
          status: 'verified',
          policy: 'strict',
          trustProfileId: 'source-a',
          trustContextSnapshotHash: 'sha256:current',
        },
      },
      aggregate(idpEntity(IDP))
    );
    const store = createStore(preview);
    mocks.adapter!.queryOne.mockResolvedValue({ id: 'source-a', snapshot_hash: 'sha256:current' });
    await startBatch(store, { entityIds: [SP], enabled: false });
    expect(mocks.emitLog).toHaveBeenCalledTimes(1);
    const input = mocks.emitLog.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input[1]).toMatchObject({
      overview: { action: 'create_provider', result: 'failed', resource_id: 'source-a' },
    });
    expect(store.calls.some((call) => call.path.endsWith('/complete'))).toBe(true);
  });
});

describe('federation runtime entity resolution', () => {
  const ENTITY = 'urn:imported:idp';
  const xml = idpEntity(ENTITY).replace('<md:EntityDescriptor', `<md:EntityDescriptor ${MD} ${DS}`);

  function policyPayload(runtimeResolution: unknown, polling?: unknown): string {
    return JSON.stringify({
      runtimeResolution,
      ...(polling !== undefined ? { polling } : {}),
    });
  }

  const automatic = { mode: 'automatic', roles: ['saml_idp'], idpFieldMappingSetId: 'idp-set' };

  function row(overrides: Record<string, unknown> = {}) {
    return {
      trust_source_id: 'source-a',
      trust_context_snapshot_hash: 'ctx-a',
      source_url: 'https://metadata.example.test/federation.xml',
      protocol_payload_json: policyPayload(automatic),
      metadata_xml: xml,
      entity_categories_json: '[]',
      entity_category_support_json: '[]',
      registration_authority: null,
      valid_until: '2099-01-01T00:00:00Z',
      validated_at: 1,
      ...overrides,
    };
  }

  async function resolve(rows: unknown[]) {
    mocks.adapter!.query.mockImplementation(async (sql: string) =>
      sql.includes('federation_saml_runtime_entities') ? rows : []
    );
    return await getIdPConfigByEntityId({} as never, 'tenant-a', ENTITY);
  }

  it('resolves a trusted entity into a configuration bound to the policy mapping set', async () => {
    const config = await resolve([row()]);
    expect(config).toMatchObject({
      entityId: ENTITY,
      ssoUrl: 'https://idp.example.test/sso',
      metadataUrl: 'https://metadata.example.test/federation.xml',
      metadataLastFetched: 1,
      identityMapping: { fieldMappingSetId: 'idp-set' },
      aggregateImport: {
        aggregateEntityId: ENTITY,
        federationTrustProfileId: 'source-a',
        importedAt: 1,
        verification: {
          status: 'verified',
          policy: 'strict',
          trustContextSnapshotHash: 'ctx-a',
          verifiedAt: 1,
        },
      },
    });
  });

  it('queries only the dedicated admin adapter, bound to tenant, entity and role', async () => {
    await resolve([]);
    const call = mocks.adapter!.query.mock.calls.find(([sql]) =>
      String(sql).includes('federation_saml_runtime_entities')
    );
    expect(call?.[1]).toEqual(['tenant-a', ENTITY, 'saml_idp']);
  });

  it('resolves nothing when no dedicated admin adapter is available', async () => {
    mocks.dedicated = () => {
      throw new Error('not configured');
    };
    expect(await resolve([row()])).toBeNull();
  });

  it('resolves nothing when the directory lookup fails', async () => {
    mocks.adapter!.query.mockImplementation(async (sql: string) => {
      if (sql.includes('federation_saml_runtime_entities')) throw new Error('db down');
      return [];
    });
    expect(await getIdPConfigByEntityId({} as never, 'tenant-a', ENTITY)).toBeNull();
  });

  it('resolves nothing when the candidate limit is exceeded', async () => {
    expect(await resolve(Array.from({ length: 101 }, () => row()))).toBeNull();
  });

  it('resolves nothing when the stored metadata names another entity', async () => {
    expect(await resolve([row({ metadata_xml: xml.replace(ENTITY, 'urn:other:idp') })])).toBeNull();
  });

  it('resolves nothing when the stored metadata is unusable', async () => {
    expect(await resolve([row({ metadata_xml: '<broken' })])).toBeNull();
  });

  it('denies an ambiguous explicit provider match', async () => {
    const explicit = {
      enabled: 1,
      config_json: JSON.stringify({ entityId: ENTITY, ssoUrl: 'https://idp.example.test/sso' }),
    };
    mocks.adapter!.query.mockResolvedValue([explicit, explicit]);
    expect(await getIdPConfigByEntityId({} as never, 'tenant-a', ENTITY)).toBeNull();
    expect(mocks.adapter!.query).toHaveBeenCalledTimes(1);
  });

  it('rejects an explicit federation-linked provider when its source lookup throws', async () => {
    mocks.dedicated = () => {
      throw new Error('not configured');
    };
    mocks.adapter!.query.mockResolvedValue([
      {
        enabled: 1,
        config_json: JSON.stringify({
          entityId: ENTITY,
          ssoUrl: 'https://idp.example.test/sso',
          aggregateImport: {
            aggregateEntityId: ENTITY,
            federationTrustProfileId: 'source-a',
            verification: {
              status: 'verified',
              policy: 'strict',
              trustContextSnapshotHash: 'ctx-a',
            },
            importedAt: 1,
          },
        }),
      },
    ]);
    expect(await getIdPConfigByEntityId({} as never, 'tenant-a', ENTITY)).toBeNull();
  });

  describe('policy parsing', () => {
    const preset = 'basic.v1';
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['a null payload', { protocol_payload_json: null }, false],
      ['an invalid JSON payload', { protocol_payload_json: '{' }, false],
      ['an array payload', { protocol_payload_json: '[]' }, false],
      ['a payload without runtime resolution', { protocol_payload_json: '{}' }, false],
      ['an array runtime resolution', { protocol_payload_json: policyPayload([]) }, false],
      [
        'an expired polling state',
        { protocol_payload_json: policyPayload(automatic, { sourceState: 'expired' }) },
        false,
      ],
      [
        'an accepted valid-until in the past',
        {
          protocol_payload_json: policyPayload(automatic, {
            acceptedValidUntil: '2000-01-01T00:00:00Z',
          }),
        },
        false,
      ],
      [
        'a non-string accepted valid-until',
        { protocol_payload_json: policyPayload(automatic, { acceptedValidUntil: 5 }) },
        false,
      ],
      [
        'an accepted valid-until in the future',
        {
          protocol_payload_json: policyPayload(automatic, {
            sourceState: 'ok',
            acceptedValidUntil: '2099-01-01T00:00:00Z',
          }),
        },
        true,
      ],
      [
        'roles that are not a list',
        { protocol_payload_json: policyPayload({ ...automatic, roles: 'saml_idp' }) },
        false,
      ],
      [
        'an unknown role',
        { protocol_payload_json: policyPayload({ ...automatic, roles: ['saml_idp', 'x'] }) },
        false,
      ],
      [
        'a repeated role',
        {
          protocol_payload_json: policyPayload({ ...automatic, roles: ['saml_idp', 'saml_idp'] }),
        },
        false,
      ],
      [
        'inventory-only mode',
        { protocol_payload_json: policyPayload({ ...automatic, mode: 'inventory_only' }) },
        false,
      ],
      [
        'a policy for the other role only',
        { protocol_payload_json: policyPayload({ ...automatic, roles: ['saml_sp'] }) },
        false,
      ],
      [
        'a policy without an IdP mapping set',
        { protocol_payload_json: policyPayload({ ...automatic, idpFieldMappingSetId: '' }) },
        false,
      ],
      [
        'a non-integer priority (ignored)',
        { protocol_payload_json: policyPayload({ ...automatic, priority: 1.5 }) },
        true,
      ],
      [
        'a non-list registration authority set',
        {
          protocol_payload_json: policyPayload({ ...automatic, registrationAuthorities: 'x' }),
        },
        false,
      ],
      [
        'an empty registration authority entry',
        {
          protocol_payload_json: policyPayload({ ...automatic, registrationAuthorities: [''] }),
        },
        false,
      ],
      [
        'a registration authority that is not allowed',
        {
          registration_authority: 'other',
          protocol_payload_json: policyPayload({ ...automatic, registrationAuthorities: ['ra'] }),
        },
        false,
      ],
      [
        'a missing registration authority when one is required',
        {
          registration_authority: null,
          protocol_payload_json: policyPayload({ ...automatic, registrationAuthorities: ['ra'] }),
        },
        false,
      ],
      [
        'an allowed registration authority',
        {
          registration_authority: 'ra',
          protocol_payload_json: policyPayload({ ...automatic, registrationAuthorities: ['ra'] }),
        },
        true,
      ],
      ['an expired entity', { valid_until: '2000-01-01T00:00:00Z' }, false],
      ['an unparsable validity date', { valid_until: 'soon' }, false],
      ['no validity date', { valid_until: null }, true],
      ['malformed category JSON (ignored)', { entity_categories_json: '{' }, true],
      ['category JSON that is not a list', { entity_categories_json: '{}' }, true],
      ['a null category list', { entity_categories_json: null }, true],
    ];

    it.each(cases)('%s', async (_label, overrides, resolves) => {
      const config = await resolve([row(overrides)]);
      expect(config !== null).toBe(resolves);
    });

    const categoryPolicy = (policy: unknown, categories: string[] = ['cat-a']) => ({
      protocol_payload_json: policyPayload({ ...automatic, entityCategoryPolicy: policy }),
      entity_categories_json: JSON.stringify(categories),
    });
    const categoryCases: Array<[string, Record<string, unknown>, boolean]> = [
      ['a non-object category policy', categoryPolicy('allow'), false],
      ['an array category policy', categoryPolicy([]), false],
      ['an unknown default decision', categoryPolicy({ defaultDecision: 'x', rules: [] }), false],
      ['a category policy without rules', categoryPolicy({ defaultDecision: 'allow' }), false],
      ['a non-object rule', categoryPolicy({ defaultDecision: 'allow', rules: ['x'] }), false],
      [
        'a rule without a category',
        categoryPolicy({ defaultDecision: 'allow', rules: [{ decision: 'allow' }] }),
        false,
      ],
      [
        'a rule with an unknown decision',
        categoryPolicy({
          defaultDecision: 'allow',
          rules: [{ entityCategory: 'cat-a', decision: 'maybe' }],
        }),
        false,
      ],
      [
        'a rule with an unknown preset',
        categoryPolicy({
          defaultDecision: 'allow',
          rules: [{ entityCategory: 'cat-a', decision: 'allow', attributePresetId: 'nope' }],
        }),
        false,
      ],
      [
        'a repeated rule category',
        categoryPolicy({
          defaultDecision: 'allow',
          rules: [
            { entityCategory: 'cat-a', decision: 'allow' },
            { entityCategory: 'cat-a', decision: 'deny' },
          ],
        }),
        false,
      ],
      [
        'a matching deny rule',
        categoryPolicy({
          defaultDecision: 'allow',
          rules: [{ entityCategory: 'cat-a', decision: 'deny' }],
        }),
        false,
      ],
      [
        'allow rules that imply different presets',
        categoryPolicy(
          {
            defaultDecision: 'deny',
            rules: [
              { entityCategory: 'cat-a', decision: 'allow', attributePresetId: preset },
              {
                entityCategory: 'cat-b',
                decision: 'allow',
                attributePresetId: 'enterprise_saas.v1',
              },
            ],
          },
          ['cat-a', 'cat-b']
        ),
        false,
      ],
      [
        'a default deny without a matching allow',
        categoryPolicy({ defaultDecision: 'deny', rules: [] }),
        false,
      ],
      [
        'a default allow without a matching rule',
        categoryPolicy({ defaultDecision: 'allow', rules: [] }),
        true,
      ],
      [
        'a matching allow under a default deny',
        categoryPolicy({
          defaultDecision: 'deny',
          rules: [{ entityCategory: 'cat-a', decision: 'allow', attributePresetId: preset }],
        }),
        true,
      ],
    ];

    it.each(categoryCases)('%s', async (_label, overrides, resolves) => {
      const config = await resolve([row(overrides)]);
      expect(config !== null).toBe(resolves);
    });

    it('applies the default attribute preset when the policy has no category rules', async () => {
      const config = await resolve([
        row({
          protocol_payload_json: policyPayload({ ...automatic, defaultAttributePresetId: preset }),
        }),
      ]);
      expect(config).not.toBeNull();
    });

    it('applies the default attribute preset to a matching allow rule without its own preset', async () => {
      const config = await resolve([
        row({
          protocol_payload_json: policyPayload({
            ...automatic,
            defaultAttributePresetId: preset,
            entityCategoryPolicy: {
              defaultDecision: 'deny',
              rules: [{ entityCategory: 'cat-a', decision: 'allow' }],
            },
          }),
          entity_categories_json: '["cat-a"]',
        }),
      ]);
      expect(config).not.toBeNull();
    });
  });

  describe('candidate priority', () => {
    const withPriority = (priority: number, source: string) =>
      row({
        trust_source_id: source,
        protocol_payload_json: policyPayload({ ...automatic, priority }),
      });

    it('denies equally ranked candidates', async () => {
      expect(await resolve([withPriority(1, 'a'), withPriority(1, 'b')])).toBeNull();
    });

    it('prefers the highest priority candidate', async () => {
      const config = await resolve([withPriority(1, 'low'), withPriority(5, 'high')]);
      expect(config?.aggregateImport?.federationTrustProfileId).toBe('high');
    });
  });

  it('finds no usage key for a missing entity id', async () => {
    expect(await getIdPUsageKeyByEntityId({} as never, 'tenant-a', '')).toBeNull();
  });
});

describe('metadata parsing fallbacks', () => {
  const certificate = 'VEVTVA==';
  const key = `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`;
  const idp = (body: string) =>
    `<md:EntityDescriptor ${MD} ${DS} entityID="urn:idp"><md:IDPSSODescriptor ${PROTO}>${body}</md:IDPSSODescriptor></md:EntityDescriptor>`;
  const sp = (body: string) =>
    `<md:EntityDescriptor ${MD} entityID="urn:sp"><md:SPSSODescriptor ${PROTO}>${body}</md:SPSSODescriptor></md:EntityDescriptor>`;

  it('takes the first POST SSO location even when an earlier entry has none', () => {
    const config = parseIdPMetadata(
      idp(
        `${key}<md:SingleSignOnService Binding="${POST}"/><md:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/post"/><md:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/second"/>`
      )
    );
    expect(config.ssoUrl).toBe('https://idp.example.test/post');
  });

  it('takes the first redirect SSO location even when an earlier entry has none', () => {
    const config = parseIdPMetadata(
      idp(
        `${key}<md:SingleSignOnService Binding="${REDIRECT}"/><md:SingleSignOnService Binding="${REDIRECT}" Location="https://idp.example.test/redirect"/><md:SingleSignOnService Binding="${REDIRECT}" Location="https://idp.example.test/second"/>`
      )
    );
    expect(config.ssoUrl).toBe('https://idp.example.test/redirect');
  });

  it('refuses IdP metadata without a signing certificate', () => {
    expect(() =>
      parseIdPMetadata(
        idp(`<md:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/sso"/>`)
      )
    ).toThrow('Invalid metadata: no signing certificate found');
  });

  it('keeps a PEM wrapper for a certificate element without text', () => {
    const config = parseIdPMetadata(
      idp(
        `<md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate/></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="${POST}" Location="https://idp.example.test/sso"/>`
      )
    );
    expect(config.certificate).toBe('-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----');
  });

  it('takes a later POST ACS location when the first has none', () => {
    const config = parseSPMetadata(
      sp(
        `<md:AssertionConsumerService Binding="${POST}" index="0"/><md:AssertionConsumerService Binding="${POST}" Location="https://sp.example.test/acs" index="1"/>`
      )
    );
    expect(config.acsUrl).toBe('https://sp.example.test/acs');
  });

  it('takes a later redirect ACS location when the first has none', () => {
    const config = parseSPMetadata(
      sp(
        `<md:AssertionConsumerService Binding="${REDIRECT}" index="0"/><md:AssertionConsumerService Binding="${REDIRECT}" Location="https://sp.example.test/redirect" index="1"/>`
      )
    );
    expect(config.acsUrl).toBe('https://sp.example.test/redirect');
  });
});
