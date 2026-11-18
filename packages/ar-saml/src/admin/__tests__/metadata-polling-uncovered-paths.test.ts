import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  admin: null as ReturnType<typeof createAdapter> | null,
  core: null as ReturnType<typeof createAdapter> | null,
  resolveCore: vi.fn(),
  safeFetch: vi.fn(),
  isAggregate: vi.fn(),
  extract: vi.fn(),
  verify: vi.fn(),
  refreshProvider: vi.fn(),
  listProfiles: vi.fn(),
  audit: vi.fn(),
  bumpCache: vi.fn(async () => undefined),
  listTenants: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveCore,
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
  listFederationTrustProfiles: mocks.listProfiles,
  refreshSAMLProviderConfigFromMetadata: mocks.refreshProvider,
}));

import {
  pollSAMLMetadata,
  refreshFederationMetadataSource,
  resolveFederationSourceMetadataUrl,
} from '../metadata-polling';

type Row = Record<string, unknown>;
const FED_URL = 'https://metadata.example.test/federation.xml';
const IDP_URL = 'https://idp.example.test/metadata.xml';
const ENTITY = 'https://idp.example.test/entity';

function createAdapter() {
  return {
    query: vi.fn(async (_sql: string, _params?: unknown[]): Promise<Row[]> => []),
    queryOne: vi.fn(async (_sql: string, _params?: unknown[]): Promise<Row | null> => null),
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rowsAffected: 1,
      insertId: undefined,
    })),
    batch: vi.fn(async (_statements: unknown[]) => []),
  };
}

function sourceRow(payload: Row = { metadataUrl: FED_URL }, extra: Row = {}): Row {
  return {
    id: 'source-a',
    tenant_id: 'tenant-a',
    source_type: 'saml_aggregate',
    updated_at: 10,
    protocol_payload_json: JSON.stringify(payload),
    ...extra,
  };
}

function useSource(row: Row | null, jobCursor?: string, document?: Row) {
  mocks.admin!.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM federation_trust_sources')) return row;
    if (sql.includes('FROM federation_metadata_refresh_jobs') && jobCursor) {
      return { cursor_json: jobCursor };
    }
    if (sql.includes('FROM federation_metadata_documents')) return document ?? null;
    return null;
  });
}

function linkedConfig(extra: Row = {}): Row {
  return {
    entityId: ENTITY,
    metadataUrl: IDP_URL,
    aggregateImport: {
      aggregateSourceUrl: FED_URL,
      aggregateEntityId: ENTITY,
      federationTrustProfileId: 'source-a',
      verification: { status: 'verified', policy: 'strict' },
      importedAt: 1,
    },
    metadataRefreshPolicy: { mode: 'automatic', intervalSeconds: 21_600, nextRefreshAt: 0 },
    ...extra,
  };
}

function providerRow(id: string, config: Row | string, enabled = 1): Row {
  return {
    id,
    provider_type: 'saml_idp',
    enabled,
    updated_at: 10,
    config_json: typeof config === 'string' ? config : JSON.stringify(config),
  };
}

function aggregateResult(entities: Row[], verificationStatus = 'verified', validUntil?: string) {
  return {
    aggregate: { metadataXml: '<md:EntitiesDescriptor/>', entities, validUntil },
    verification: { status: verificationStatus, policy: 'strict', trustProfileId: 'source-a' },
  };
}

function refreshedProvider(extra: Row = {}) {
  return {
    config: { entityId: ENTITY, metadataRefreshPolicy: { mode: 'automatic' } },
    metadataRefreshStatus: { current: { validUntil: '2030-01-01T00:00:00Z' } },
    changed: true,
    expired: false,
    ...extra,
  };
}

function executeCalls(adapter: ReturnType<typeof createAdapter>, fragment: string) {
  return adapter.execute.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

function failureReason(): string {
  const call = executeCalls(mocks.admin!, 'INSERT INTO federation_metadata_validation_events')[0];
  return String((JSON.parse(String(call?.[1]?.[3])) as unknown[])[0]);
}

function policyOf(value: unknown): Row {
  return (JSON.parse(String(value)) as { metadataRefreshPolicy: Row }).metadataRefreshPolicy;
}

function fetchHeaders(): Headers {
  return (mocks.safeFetch.mock.calls[0]?.[1] as { headers: Headers }).headers;
}

function auditMeta(): Row {
  return JSON.parse((mocks.audit.mock.calls[0]?.[1] as { metadata: string }).metadata) as Row;
}

function settings(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = createAdapter();
  mocks.core = createAdapter();
  mocks.resolveCore.mockImplementation(async () => mocks.core);
  mocks.listTenants.mockResolvedValue([]);
  mocks.audit.mockResolvedValue(undefined);
  mocks.isAggregate.mockReturnValue(true);
  mocks.listProfiles.mockResolvedValue([{ id: 'source-a', policy: 'strict' }]);
  mocks.safeFetch.mockResolvedValue(new Response('<md:EntitiesDescriptor/>', { status: 200 }));
  mocks.verify.mockResolvedValue(aggregateResult([]));
  mocks.extract.mockReturnValue(new Map());
  mocks.refreshProvider.mockResolvedValue(refreshedProvider());
});

describe('resolveFederationSourceMetadataUrl exact-pattern filtering', () => {
  it('ignores wildcard, non-https and non-string patterns and requires exactly one match', () => {
    expect(
      resolveFederationSourceMetadataUrl({
        metadataUrlPatterns: [
          'http://a.example.test/x.xml',
          'https://b.example.test/*',
          42 as never,
        ],
      })
    ).toBeNull();
    expect(
      resolveFederationSourceMetadataUrl({
        metadataUrlPatterns: [' HTTPS://a.example.test/x.xml ', 'http://b.example.test/y.xml'],
      })
    ).toBe('HTTPS://a.example.test/x.xml');
    expect(
      resolveFederationSourceMetadataUrl({
        metadataUrl: '   ',
        metadataUrlPatterns: ['https://a.example.test/x.xml', 'https://b.example.test/y.xml'],
      })
    ).toBeNull();
  });
});

describe('refreshFederationMetadataSource preconditions and failures', () => {
  it('rejects an unknown source and a source without a usable metadata URL', async () => {
    useSource(null);
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('federation_source_not_found');
    expect(mocks.safeFetch).not.toHaveBeenCalled();

    useSource(sourceRow({ metadataUrlPatterns: ['https://metadata.example.test/*'] }));
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('federation_source_metadata_url_required');
    expect(mocks.admin!.execute).not.toHaveBeenCalled();
  });

  it('runs beforeApply only after the source is validated', async () => {
    useSource(sourceRow());
    const beforeApply = vi.fn(async () => undefined);
    await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'manual',
      1_000,
      beforeApply
    );
    expect(beforeApply).toHaveBeenCalledOnce();
    expect(mocks.safeFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['HTTP error', () => new Response('x', { status: 503 }), 'metadata_http_503'],
    ['non-error rejection', () => Promise.reject('boom'), 'metadata_refresh_failed'],
  ])(
    'persists %s as a stable failure code and fails the job',
    async (_name, makeResponse, code) => {
      useSource(sourceRow());
      mocks.safeFetch.mockImplementation(async () => makeResponse());
      await expect(
        refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
      ).rejects.toBeDefined();
      expect(failureReason()).toBe(code);
      const polling = executeCalls(mocks.admin!, 'json_set')[0];
      expect(JSON.parse(String(polling?.[1]?.[0]))).toMatchObject({ lastErrorCode: code });
      const jobUpdate = executeCalls(mocks.admin!, 'UPDATE federation_metadata_refresh_jobs')[0];
      expect(jobUpdate?.[1]?.[0]).toBe('failed');
      expect(JSON.parse(String(jobUpdate?.[1]?.[1]))).toEqual({ errorCode: code });
    }
  );

  it('rejects a non-aggregate document and a missing trust profile', async () => {
    useSource(sourceRow());
    mocks.isAggregate.mockReturnValue(false);
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('federation_source_not_aggregate');
    expect(mocks.verify).not.toHaveBeenCalled();

    mocks.isAggregate.mockReturnValue(true);
    mocks.listProfiles.mockResolvedValue([{ id: 'other', policy: 'strict' }]);
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('federation_trust_profile_not_found');
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('rejects an aggregate whose validUntil has already passed', async () => {
    useSource(sourceRow());
    mocks.verify.mockResolvedValue(aggregateResult([], 'verified', '1970-01-01T00:00:01Z'));
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 5_000)
    ).rejects.toThrow('metadata_expired');
    expect(failureReason()).toBe('metadata_expired');
    expect(mocks.admin!.batch).not.toHaveBeenCalled();
    const polling = executeCalls(mocks.admin!, 'json_set')[0];
    expect(JSON.parse(String(polling?.[1]?.[0]))).toMatchObject({ sourceState: 'expired' });
  });

  it.each([
    ['metadata has an expired validUntil', 'metadata_expired'],
    ['metadata_certificates_expired', 'metadata_certificates_expired'],
    ['bad signature on document', 'metadata_verification_failed'],
    ['no matching trust profile', 'metadata_verification_failed'],
    ['aggregate does not contain entityID', 'federation_entity_missing'],
    ['entityID changed unexpectedly', 'entity_id_change_pending'],
  ])('maps verification error "%s" to %s', async (message, code) => {
    useSource(sourceRow());
    mocks.verify.mockRejectedValue(new Error(message));
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow(message);
    expect(failureReason()).toBe(code);
  });

  it('logs and continues when the failure-state write, lease release and audit all fail', async () => {
    useSource(sourceRow());
    mocks.verify.mockRejectedValue(new Error('signature invalid'));
    mocks.admin!.execute.mockImplementation(async (sql: string) => {
      if (sql.includes('json_set')) return { rowsAffected: 0, insertId: undefined };
      if (
        sql.includes('refresh_operation_token = NULL') &&
        sql.includes("lifecycle_state = 'active'")
      ) {
        throw new Error('release failed');
      }
      return { rowsAffected: 1, insertId: undefined };
    });
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('signature invalid');
    expect(executeCalls(mocks.admin!, "lifecycle_state = 'active'")).toHaveLength(1);
    expect(failureReason()).toBe('metadata_verification_failed');
  });

  it('does not fail a successful refresh when its audit write fails', async () => {
    useSource(sourceRow());
    mocks.audit.mockRejectedValue(new Error('audit down'));
    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'manual',
      1_000
    );
    expect(result).toEqual({
      sourceId: 'source-a',
      changed: true,
      entityCount: 0,
      providersUpdated: 0,
      providersMissing: 0,
      providersFailed: 0,
      verificationStatus: 'verified',
    });
  });
});

describe('refreshFederationMetadataSource 304 handling', () => {
  const polling = {
    mode: 'automatic',
    intervalSeconds: 21_600,
    etag: '"v1"',
    validatorSourceUrl: FED_URL,
  };

  it('completes a not-modified refresh, expires stale linked providers and returns a continuation cursor', async () => {
    useSource(sourceRow({ metadataUrl: FED_URL, polling }));
    mocks.safeFetch.mockResolvedValue(new Response(null, { status: 304 }));
    const expiredProvider = providerRow(
      'p-00',
      linkedConfig({ metadataCriticalFields: { validUntil: '1970-01-01T00:00:01Z' } })
    );
    const unrelated = Array.from({ length: 25 }, (_v, i) =>
      providerRow(`p-${String(i + 1).padStart(2, '0')}`, '{}')
    );
    mocks.core!.query.mockResolvedValue([expiredProvider, ...unrelated]);

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'automatic',
      5_000
    );

    expect(result).toEqual({
      sourceId: 'source-a',
      changed: false,
      entityCount: 0,
      providersUpdated: 0,
      providersMissing: 0,
      providersFailed: 1,
      verificationStatus: 'not_modified',
    });
    const headers = fetchHeaders();
    expect(headers.get('If-None-Match')).toBe('"v1"');
    expect(mocks.verify).not.toHaveBeenCalled();
    const failureWrite = executeCalls(mocks.core!, 'UPDATE identity_providers')[0];
    expect(failureWrite?.[1]?.[1]).toBe(0);
    expect(policyOf(failureWrite?.[1]?.[0])).toMatchObject({
      lastErrorCode: 'metadata_expired',
      suspendedByMetadataSync: true,
    });
    expect(mocks.bumpCache).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
    const job = executeCalls(mocks.admin!, 'UPDATE federation_metadata_refresh_jobs')[0];
    expect(job?.[1]?.[0]).toBe('completed');
    expect(JSON.parse(String(job?.[1]?.[1]))).toEqual({
      notModified: true,
      providerCursor: 'p-24',
    });
    const pollingWrite = executeCalls(mocks.admin!, 'json_set')[0];
    expect(JSON.parse(String(pollingWrite?.[1]?.[0]))).toMatchObject({
      etag: '"v1"',
      validatorSourceUrl: FED_URL,
      lastSuccessAt: 5_000,
    });
  });

  it('marks certificate-expired providers and skips manual or foreign ones on a 304', async () => {
    useSource(sourceRow({ metadataUrl: FED_URL, polling }));
    mocks.safeFetch.mockResolvedValue(new Response(null, { status: 304 }));
    const certs = {
      certificateValidation: {
        checkedAt: 1,
        allExpired: false,
        hasExpired: false,
        hasWeakSignature: false,
        warnings: [],
        certificates: [
          { validTo: '1970-01-01T00:00:01Z', expired: false, notYetValid: false, warnings: [] },
        ],
      },
    };
    mocks.core!.query.mockResolvedValue([
      providerRow('p-1', linkedConfig(certs)),
      providerRow('p-2', linkedConfig({ ...certs, metadataRefreshPolicy: { mode: 'manual' } })),
      providerRow('p-3', linkedConfig({ ...certs, aggregateImport: undefined })),
      providerRow('p-4', linkedConfig()),
      providerRow('p-5', 'not json'),
    ]);

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'automatic',
      5_000
    );

    expect(result.providersFailed).toBe(1);
    const writes = executeCalls(mocks.core!, 'UPDATE identity_providers');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]?.[3]).toBe('p-1');
    expect(policyOf(writes[0]?.[1]?.[0]).lastErrorCode).toBe('metadata_certificates_expired');
  });

  it('rethrows a superseded lease raised while marking providers and logs other write errors', async () => {
    useSource(sourceRow({ metadataUrl: FED_URL, polling }));
    mocks.safeFetch.mockResolvedValue(new Response(null, { status: 304 }));
    const expired = { metadataCriticalFields: { validUntil: '1970-01-01T00:00:01Z' } };
    mocks.core!.query.mockResolvedValue([providerRow('p-1', linkedConfig(expired))]);
    mocks.core!.execute.mockResolvedValue({ rowsAffected: 0, insertId: undefined });

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'automatic',
      5_000
    );
    expect(result.providersFailed).toBe(0);
    expect(mocks.bumpCache).not.toHaveBeenCalled();

    mocks.admin!.execute.mockImplementation(async (sql: string) =>
      sql.includes('refresh_operation_expires_at = ?, updated_at = ?') &&
      !sql.includes('refresh_operation_token = ?,')
        ? { rowsAffected: 0, insertId: undefined }
        : { rowsAffected: 1, insertId: undefined }
    );
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 5_000)
    ).rejects.toThrow('metadata_refresh_superseded');
    expect(executeCalls(mocks.admin!, 'json_set')).toHaveLength(1);
  });

  it('resumes automatic provider scans from the last completed cursor without conditional headers', async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('<md:EntitiesDescriptor/>')
    );
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    useSource(
      sourceRow({ metadataUrl: FED_URL, polling }),
      JSON.stringify({ providerCursor: 'p-07' }),
      { id: 'samlmd_old', document_hash: hash, source_url: FED_URL, fetched_at: 1 }
    );
    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'automatic',
      5_000
    );
    expect(result.changed).toBe(false);
    const headers = fetchHeaders();
    expect(headers.has('If-None-Match')).toBe(false);
    expect(mocks.core!.query.mock.calls[0]?.[1]).toEqual(['tenant-a', 'p-07', 26]);
  });

  it.each([
    '{not json',
    JSON.stringify({ providerCursor: '' }),
    JSON.stringify({ providerCursor: 7 }),
  ])('ignores an unusable stored provider cursor: %s', async (cursor) => {
    useSource(sourceRow({ metadataUrl: FED_URL, polling }), cursor);
    await refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'automatic', 5_000);
    expect(mocks.core!.query.mock.calls[0]?.[1]).toEqual(['tenant-a', '', 26]);
  });
});

describe('refreshFederationMetadataSource document recording and reconciliation', () => {
  it('records runtime entities only for IdP, SP and ambiguous roles with extracted XML, in bounded batches', async () => {
    useSource(sourceRow());
    const entities = [
      { entityId: 'e-idp', role: 'saml_idp', certificateCount: 1 },
      { entityId: 'e-sp', role: 'saml_sp', certificateCount: 1 },
      { entityId: 'e-amb', role: 'ambiguous', certificateCount: 1 },
      { entityId: 'e-other', role: 'unknown', certificateCount: 0 },
      { entityId: 'e-nox', role: 'saml_idp', certificateCount: 1 },
      ...Array.from({ length: 300 }, (_v, i) => ({
        entityId: `bulk-${i}`,
        role: 'saml_idp',
        certificateCount: 1,
      })),
    ];
    mocks.verify.mockResolvedValue(aggregateResult(entities, 'unverified'));
    mocks.extract.mockImplementation(
      (_xml: string, ids: string[]) =>
        new Map(
          ids
            .filter((id) => id !== 'e-nox')
            .map((id) => [id, `<md:EntityDescriptor entityID="${id}"/>`])
        )
    );

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'manual',
      1_000
    );

    expect(mocks.extract.mock.calls[0]?.[1]).toHaveLength(304);
    expect(mocks.extract.mock.calls[0]?.[1]).not.toContain('e-other');
    expect(result.entityCount).toBe(305);
    const statements = mocks.admin!.batch.mock.calls[0]?.[0] as Array<{
      sql: string;
      params: unknown[];
    }>;
    const doc = statements.find((s) => s.sql.includes('INTO federation_metadata_documents'));
    expect(doc?.params[9]).toBe('warning');
    const runtime = statements.filter((s) =>
      s.sql.includes('INTO federation_saml_runtime_entities')
    );
    const rowCounts = runtime.map(
      (s) =>
        (JSON.parse(String(s.params.find((p) => String(p).startsWith('[')))) as unknown[]).length
    );
    expect(rowCounts).toEqual([250, 53]);
  });

  it('rejects an entity summary that cannot fit in a bounded batch', async () => {
    useSource(sourceRow());
    mocks.verify.mockResolvedValue(
      aggregateResult([
        { entityId: 'e-huge', role: 'saml_idp', displayName: 'x'.repeat(600 * 1024) },
      ])
    );
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('federation_entity_summary_too_large');
    expect(mocks.admin!.batch).not.toHaveBeenCalled();
    expect(failureReason()).toBe('metadata_refresh_failed');
  });

  it('counts provider failures per cause and keeps going', async () => {
    useSource(sourceRow());
    const ids = ['e-ok', 'e-sig', 'e-conflict', 'e-persist', 'e-missing'];
    const providers = ids.map((id, i) =>
      providerRow(
        `p-${i}`,
        linkedConfig({
          entityId: id,
          aggregateImport: { ...(linkedConfig().aggregateImport as Row), aggregateEntityId: id },
        })
      )
    );
    providers.push(
      providerRow('p-bad', 'not json'),
      providerRow(
        'p-noentity',
        linkedConfig({
          aggregateImport: { ...(linkedConfig().aggregateImport as Row), aggregateEntityId: '' },
        })
      )
    );
    mocks.core!.query.mockResolvedValue(providers);
    mocks.extract.mockImplementation((_xml: string, wanted: string[]) => {
      if (wanted.length === 0) return new Map();
      return new Map(ids.filter((id) => id !== 'e-missing').map((id) => [id, `<xml ${id}/>`]));
    });
    mocks.refreshProvider.mockImplementation(async ({ metadataXml }: { metadataXml: string }) => {
      if (metadataXml.includes('e-sig')) throw new Error('bad signature');
      if (metadataXml.includes('e-conflict')) throw new Error('metadata_refresh_conflict');
      if (metadataXml.includes('e-persist')) throw new Error('trust profile mismatch');
      return refreshedProvider();
    });
    mocks.core!.execute.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (params?.[3] === 'p-3' || params?.[3] === 'p-4') throw new Error('db down');
      return { rowsAffected: 1, insertId: undefined };
    });

    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'manual',
      1_000
    );

    expect(mocks.extract.mock.calls[1]?.[1]).toEqual(ids);
    expect(result).toMatchObject({ providersUpdated: 1, providersMissing: 2, providersFailed: 4 });
    const writes = executeCalls(mocks.core!, 'UPDATE identity_providers').map(([, p]) => ({
      id: p?.[3],
      code: policyOf(p?.[0]).lastErrorCode,
    }));
    expect(writes).toContainEqual({ id: 'p-1', code: 'metadata_verification_failed' });
    expect(writes.find((w) => w.id === 'p-2')?.code).not.toBe('metadata_refresh_conflict');
    expect(mocks.bumpCache).toHaveBeenCalledWith(expect.anything(), 'tenant-a');
    const audit: unknown = mocks.audit.mock.calls[0]?.[1];
    expect(audit).toMatchObject({ severity: 'warning', ipAddress: 'manual' });
  });

  it('aborts when a provider write reports the lease as superseded', async () => {
    useSource(sourceRow());
    mocks.core!.query.mockResolvedValue([providerRow('p-1', linkedConfig())]);
    mocks.extract.mockReturnValue(new Map([[ENTITY, '<xml/>']]));
    mocks.refreshProvider.mockRejectedValue(new Error('metadata_refresh_superseded'));
    await expect(
      refreshFederationMetadataSource({} as never, 'source-a', 'tenant-a', 'manual', 1_000)
    ).rejects.toThrow('metadata_refresh_superseded');
    expect(failureReason()).toBe('metadata_refresh_superseded');
    expect(executeCalls(mocks.admin!, 'json_set')).toHaveLength(0);
  });

  it('disables a provider whose refreshed certificates are all expired', async () => {
    useSource(sourceRow());
    mocks.core!.query.mockResolvedValue([providerRow('p-1', linkedConfig())]);
    mocks.extract.mockReturnValue(new Map([[ENTITY, '<xml/>']]));
    mocks.refreshProvider.mockResolvedValue(
      refreshedProvider({
        config: { entityId: ENTITY, certificateValidation: { allExpired: true } },
      })
    );
    const result = await refreshFederationMetadataSource(
      {} as never,
      'source-a',
      'tenant-a',
      'manual',
      1_000
    );
    expect(result.providersFailed).toBe(1);
    const write = executeCalls(mocks.core!, 'UPDATE identity_providers')[0];
    expect(write?.[1]?.[1]).toBe(0);
    expect(policyOf(write?.[1]?.[0])).toMatchObject({
      lastErrorCode: 'metadata_certificates_expired',
      suspendedByMetadataSync: true,
    });
  });
});

describe('pollSAMLMetadata scheduling cursors', () => {
  it('wraps the federation cursor, skips sources that are not due and isolates per-source failures', async () => {
    const env = { SETTINGS: settings({ 'saml_metadata_polling:federation_cursor': 'source-z' }) };
    const due = { metadataUrl: FED_URL, polling: { mode: 'automatic', nextRefreshAt: 0 } };
    const sources = [
      sourceRow(due, { id: 'source-a' }),
      sourceRow(due, { id: 'source-b' }),
      sourceRow({ metadataUrl: FED_URL, polling: { mode: 'manual' } }, { id: 'source-c' }),
      sourceRow({ metadataUrlPatterns: ['https://x.example.test/*'] }, { id: 'source-d' }),
    ];
    mocks.admin!.query.mockImplementation(async (sql: string) =>
      sql.includes('id > ?') ? [] : sources
    );
    mocks.admin!.queryOne.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('FROM federation_trust_sources') && params?.[0] === 'source-a'
        ? sources[0]
        : null
    );

    const result = await pollSAMLMetadata(env as never, 1_000);

    expect(result).toMatchObject({ federationSourcesProcessed: 1, federationSourcesFailed: 1 });
    expect(mocks.admin!.query.mock.calls[0]?.[1]).toEqual(['source-z', 10]);
    expect(mocks.admin!.query.mock.calls[1]?.[1]).toEqual([10]);
    expect(env.SETTINGS.put).toHaveBeenCalledWith(
      'saml_metadata_polling:federation_cursor',
      'source-d'
    );
    expect(mocks.safeFetch).toHaveBeenCalledOnce();
  });

  it('wraps the tenant cursor and polls every tenant of the page', async () => {
    const env = { SETTINGS: settings({ 'saml_metadata_polling:tenant_cursor': 'tenant-z' }) };
    mocks.listTenants.mockImplementation(async (_env: unknown, opts: { afterTenantId?: string }) =>
      opts.afterTenantId ? [] : [{ tenantId: 't1' }, { tenantId: 't2' }]
    );

    const result = await pollSAMLMetadata(env as never, 1_000);

    expect(mocks.listTenants.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      { limit: 25, afterTenantId: 'tenant-z' },
      { limit: 25, afterTenantId: undefined },
    ]);
    expect(result.tenantsProcessed).toBe(2);
    expect(mocks.resolveCore.mock.calls.map((c: unknown[]) => c[2])).toEqual([
      { tenantId: 't1' },
      { tenantId: 't2' },
    ]);
    expect(env.SETTINGS.put).toHaveBeenCalledWith('saml_metadata_polling:tenant_cursor', 't2');
  });

  it('falls back to the default tenant when the tenant registry is unavailable', async () => {
    mocks.listTenants.mockRejectedValue(new Error('registry down'));
    const result = await pollSAMLMetadata({ DEFAULT_TENANT_ID: 'tenant-d' } as never, 1_000);
    expect(result.tenantsProcessed).toBe(1);
    expect(mocks.resolveCore.mock.calls[0]?.[2]).toEqual({ tenantId: 'tenant-d' });
  });

  it('wraps the per-tenant provider cursor and persists the last provider id', async () => {
    const key = 'saml_metadata_polling:provider_cursor:default';
    const env = { SETTINGS: settings({ [key]: 'p-9' }) };
    mocks.core!.query.mockImplementation(async (sql: string) =>
      sql.includes('id > ?') ? [] : [providerRow('p-1', '{}')]
    );
    await pollSAMLMetadata(env as never, 1_000);
    expect(mocks.core!.query.mock.calls.map((c) => c[1])).toEqual([
      ['default', 'p-9', 25],
      ['default', 25],
    ]);
    expect(env.SETTINGS.put).toHaveBeenCalledWith(key, 'p-1');
  });

  it('counts a tenant whose provider page cannot be parsed as failed', async () => {
    mocks.core!.query.mockResolvedValue([providerRow('p-1', 'not json')]);
    const result = await pollSAMLMetadata({} as never, 1_000);
    expect(result).toMatchObject({
      individualProvidersProcessed: 0,
      individualProvidersFailed: 1,
      tenantsProcessed: 1,
    });
  });
});

describe('pollSAMLMetadata individual provider failures', () => {
  const policy = {
    mode: 'automatic',
    intervalSeconds: 21_600,
    nextRefreshAt: 0,
    etag: '"v"',
    validatorSourceUrl: IDP_URL,
  };
  const plain = (extra: Row = {}) => ({
    entityId: ENTITY,
    metadataUrl: IDP_URL,
    metadataRefreshPolicy: policy,
    ...extra,
  });
  const standalone = {
    aggregateSourceUrl: IDP_URL,
    verification: { status: 'verified', policy: 'strict' },
  };
  const persisted = () => ({
    metadataRefreshPolicy: policyOf(
      executeCalls(mocks.core!, 'UPDATE identity_providers')[0]?.[1]?.[0]
    ),
  });
  const auditedCode = () => auditMeta().error_code;

  it('suspends providers whose linked federation source is gone and ignores URL-less ones', async () => {
    mocks.core!.query.mockResolvedValue([
      providerRow(
        'p-1',
        linkedConfig({
          aggregateImport: {
            ...(linkedConfig().aggregateImport as Row),
            federationTrustProfileId: 'gone',
          },
        })
      ),
      providerRow('p-2', {
        entityId: ENTITY,
        aggregateImport: {
          ...standalone,
          federationTrustProfileId: 'gone',
          aggregateSourceUrl: undefined,
        },
      }),
    ]);
    const result = await pollSAMLMetadata({} as never, 2_000);
    expect(result.individualProvidersFailed).toBe(1);
    expect(mocks.admin!.query.mock.calls.at(-1)?.[1]).toEqual(['default', 'gone']);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    const write = executeCalls(mocks.core!, 'UPDATE identity_providers');
    expect(write).toHaveLength(1);
    expect(write[0]?.[1]?.[1]).toBe(0);
    expect(persisted().metadataRefreshPolicy).toMatchObject({
      lastErrorCode: 'federation_source_missing',
      sourceState: 'missing',
      suspendedByMetadataSync: true,
    });
    expect(auditedCode()).toBe('federation_source_missing');
  });

  it('does not write a failure state when a 304 update loses its optimistic-concurrency race', async () => {
    mocks.safeFetch.mockResolvedValue(new Response(null, { status: 304 }));
    mocks.core!.query.mockResolvedValue([providerRow('p-1', plain())]);
    mocks.core!.execute.mockResolvedValue({ rowsAffected: 0, insertId: undefined });
    const result = await pollSAMLMetadata({} as never, 2_000);
    expect(result.individualProvidersFailed).toBe(1);
    expect(executeCalls(mocks.core!, 'UPDATE identity_providers')).toHaveLength(1);
    expect(auditedCode()).toBe('metadata_refresh_conflict');
    expect(mocks.bumpCache).toHaveBeenCalledWith(expect.anything(), 'default');
  });

  it('fails an aggregate-linked provider that has no entity snapshot', async () => {
    mocks.core!.query.mockResolvedValue([
      providerRow('p-1', plain({ aggregateImport: { ...standalone, aggregateEntityId: '' } })),
    ]);
    const result = await pollSAMLMetadata({} as never, 2_000);
    expect(result.individualProvidersFailed).toBe(1);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(persisted().metadataRefreshPolicy.lastErrorCode).toBe('metadata_refresh_failed');
    expect(auditedCode()).toBe('metadata_refresh_failed');
  });

  it('verifies against all profiles and fails a missing entity for an unpinned aggregate provider', async () => {
    mocks.core!.query.mockResolvedValue([
      providerRow('p-1', plain({ aggregateImport: { ...standalone, aggregateEntityId: ENTITY } })),
    ]);
    const result = await pollSAMLMetadata({} as never, 2_000);
    expect(result.individualProvidersFailed).toBe(1);
    expect(mocks.verify).toHaveBeenCalledWith(
      '<md:EntitiesDescriptor/>',
      IDP_URL,
      [{ id: 'source-a', policy: 'strict' }],
      'strict'
    );
    expect(mocks.extract).toHaveBeenLastCalledWith('<md:EntitiesDescriptor/>', [ENTITY]);
    const write = executeCalls(mocks.core!, 'UPDATE identity_providers')[0];
    expect(write?.[1]?.[1]).toBe(1);
    expect(persisted().metadataRefreshPolicy).toMatchObject({
      lastErrorCode: 'federation_entity_missing',
      sourceState: 'missing',
      consecutiveFailures: 1,
    });
  });

  it('counts an expired refresh as failed, disables the provider and tolerates audit failure', async () => {
    mocks.isAggregate.mockReturnValue(false);
    mocks.audit.mockRejectedValue(new Error('audit down'));
    mocks.core!.query.mockResolvedValue([providerRow('p-1', plain())]);
    mocks.refreshProvider.mockResolvedValue(refreshedProvider({ expired: true }));
    const result = await pollSAMLMetadata({} as never, 2_000);
    expect(result).toMatchObject({ individualProvidersProcessed: 0, individualProvidersFailed: 1 });
    const write = executeCalls(mocks.core!, 'UPDATE identity_providers')[0];
    expect(write?.[1]?.[1]).toBe(0);
    expect(persisted().metadataRefreshPolicy).toMatchObject({
      lastErrorCode: 'metadata_expired',
      suspendedByMetadataSync: true,
    });
    expect(auditMeta()).toMatchObject({
      expired: true,
      error_code: 'metadata_expired',
    });
  });
});
