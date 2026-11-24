/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditWrite = vi.hoisted(() => vi.fn(async () => 'audit_1'));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const stepUp = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const mockAdapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { createApp, resetAdapter, routeSql, type FakeAdapter } from './logging-control-a-harness';

const PERM = 'admin:logging:sensitive_detail:export';
const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
type Body = Record<string, any>;

function makeAdapter(): FakeAdapter & Record<string, ReturnType<typeof vi.fn>> {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    batch: vi.fn(),
    transaction: vi.fn(),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('d1'),
    close: vi.fn().mockResolvedValue(undefined),
  };
  resetAdapter(adapter);
  return adapter as never;
}

const chunkRow = (extra: Record<string, unknown> = {}) => ({
  catalog_id: 'cat_1',
  tenant_id: 'tenant-a',
  object_class: 'event_log_detail',
  bucket_binding: 'SENSITIVE_DETAILS',
  object_key: 'sensitive/a.jsonl.gz',
  content_encoding: 'gzip',
  line_number: '3',
  byte_offset: '10',
  byte_length: '20',
  key_version: '2',
  checksum_sha256: 'sha',
  created_at: '1000',
  deleted_at: null,
  public_artifact_id: 'art_1',
  ...extra,
});

let indexDb: ReturnType<typeof makeAdapter>;
let plainDb: ReturnType<typeof makeAdapter>;

async function probe(
  body: unknown,
  opts: { perms?: string[]; platform?: boolean; env?: Record<string, unknown> } = {}
) {
  const res = await createApp(opts.perms ?? [PERM], { platform: opts.platform ?? false }).request(
    '/api/admin/admin-logging/sensitive-detail/probe',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DB_ADMIN: {}, DB: plainDb, ...(opts.env ?? {}) }
  );
  return { status: res.status, body: await res.json<Body>() };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  indexDb = makeAdapter();
  plainDb = makeAdapter();
});

describe('POST /sensitive-detail/probe', () => {
  it('requires the export permission and a catalog id', async () => {
    const denied = await probe({ catalog_id: 'cat_1' }, { perms: [] });
    expect(denied.status).toBe(403);
    expect(denied.body.details.permission).toEqual({
      required_permission: PERM,
      reason: 'sensitive_detail_probe_permission_required',
    });
    const missing = await probe({});
    expect(missing.status).toBe(400);
    expect(missing.body.details.fields).toEqual([
      { path: 'catalog_id', code: 'required', message: 'Sensitive detail catalog id is required.' },
    ]);
  });

  it('rejects another tenant id for tenant admins', async () => {
    const res = await probe({ catalog_id: 'cat_1', tenant_id: 'tenant-b' });
    expect(res.status).toBe(403);
    expect(res.body.details.permission.reason).toBe('tenant_scope_mismatch');
  });

  it('searches LOGGING_INDEX_DB, then DB_ADMIN, then DB, skipping adapters that fail', async () => {
    indexDb.queryOne.mockRejectedValue(new Error('index db down'));
    routeSql(mockAdapter, {
      one: [{ match: /sensitive_detail_chunk_index/, result: null }],
    });
    plainDb.queryOne.mockResolvedValue(chunkRow());
    const res = await probe(
      { catalog_id: 'cat_1', read_payload: false },
      { env: { LOGGING_INDEX_DB: indexDb } }
    );
    expect(res.status).toBe(200);
    expect(indexDb.queryOne).toHaveBeenCalledTimes(1);
    expect(mockAdapter.queryOne).toHaveBeenCalledTimes(1);
    expect(plainDb.queryOne).toHaveBeenCalledTimes(1);
    expect(res.body.item.adapter_binding).toBe('DB');

    indexDb.queryOne.mockReset().mockResolvedValue(chunkRow());
    plainDb.queryOne.mockClear();
    const first = await probe(
      { catalog_id: 'cat_1', read_payload: false },
      { env: { LOGGING_INDEX_DB: indexDb } }
    );
    expect(first.body.item.adapter_binding).toBe('LOGGING_INDEX_DB');
    expect(plainDb.queryOne).not.toHaveBeenCalled();
  });

  it('404s when no adapter has the row', async () => {
    const res = await probe({ catalog_id: 'cat_1' }, { env: { LOGGING_INDEX_DB: indexDb } });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  });

  it('builds the lookup with tenant and object class filters', async () => {
    plainDb.queryOne.mockResolvedValue(chunkRow());
    await probe({ catalog_id: 'cat_1', object_class: 'event_log_detail', read_payload: false });
    const [sql, params] = plainDb.queryOne.mock.calls[0];
    expect(sql).toContain(
      'sdci.catalog_id = ? AND sdci.deleted_at IS NULL AND sdci.tenant_id = ? AND sdci.object_class = ?'
    );
    expect(params).toEqual(['cat_1', 'tenant-a', 'event_log_detail']);
    plainDb.queryOne.mockClear();
    await probe({ catalog_id: 'cat_1', read_payload: false }, { platform: true });
    const [platformSql, platformParams] = plainDb.queryOne.mock.calls[0];
    expect(platformSql).not.toContain('sdci.tenant_id = ?');
    expect(platformSql).not.toContain('sdci.object_class = ?');
    expect(platformParams).toEqual(['cat_1']);
  });

  it('enforces tenant access on the found row', async () => {
    plainDb.queryOne.mockResolvedValue(chunkRow({ tenant_id: 'tenant-b' }));
    const res = await probe({ catalog_id: 'cat_1', read_payload: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('returns metadata without the payload when not requested', async () => {
    plainDb.queryOne.mockResolvedValue(chunkRow());
    const res = await probe({ catalog_id: 'cat_1', read_payload: false });
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({
      catalog_id: 'cat_1',
      public_artifact_id: 'art_1',
      tenant_id: 'tenant-a',
      object_class: 'event_log_detail',
      bucket_binding: 'SENSITIVE_DETAILS',
      object_key: 'sensitive/a.jsonl.gz',
      content_encoding: 'gzip',
      line_number: 3,
      byte_offset: 10,
      byte_length: 20,
      key_version: 2,
      checksum_sha256: 'sha',
      created_at: 1000,
      adapter_binding: 'DB',
      read_status: 'not_requested',
      payload_shape: null,
    });
    expect(res.body.audit_id).toBe('audit_1');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.sensitive_detail.probe',
        resourceType: 'sensitive_detail_chunk_index',
        resourceId: 'cat_1',
        result: 'success',
        severity: 'warn',
        metadata: {
          tenant_id: 'tenant-a',
          object_class: 'event_log_detail',
          adapter_binding: 'DB',
          read_status: 'not_requested',
        },
      })
    );
  });

  it('reports null offsets as null', async () => {
    plainDb.queryOne.mockResolvedValue(chunkRow({ byte_offset: null, byte_length: '' }));
    const res = await probe({ catalog_id: 'cat_1', read_payload: false });
    expect(res.body.item.byte_offset).toBeNull();
    expect(res.body.item.byte_length).toBeNull();
  });

  it('reads the payload by default and classifies the outcome', async () => {
    plainDb.queryOne.mockResolvedValue(chunkRow());
    const unavailable = await probe({ catalog_id: 'cat_1' });
    expect(unavailable.body.item.read_status).toBe('unavailable');
    const half = await probe({ catalog_id: 'cat_1' }, { env: { SENSITIVE_DETAILS: {} } });
    expect(half.body.item.read_status).toBe('unavailable');
    const noKey = await probe(
      { catalog_id: 'cat_1' },
      { env: { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY } }
    );
    expect(noKey.body.item.read_status).toBe('unavailable');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'success' })
    );
  });

  it('flags rows with an unknown object class as errors and audits a failure', async () => {
    plainDb.queryOne.mockResolvedValue(chunkRow({ object_class: 'mystery' }));
    const res = await probe(
      { catalog_id: 'cat_1' },
      { env: { SENSITIVE_DETAILS: { get: vi.fn() }, OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY } }
    );
    expect(res.body.item.read_status).toBe('error');
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' })
    );
  });

  it('reports unreadable payloads and loader failures', async () => {
    const env = { SENSITIVE_DETAILS: { get: vi.fn() }, OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY };
    // The chunk lookup used by the loader finds nothing in the same adapter.
    plainDb.queryOne.mockImplementation(async (sql: string) =>
      String(sql).includes('INNER JOIN object_catalog') ? null : chunkRow()
    );
    const unreadable = await probe({ catalog_id: 'cat_1' }, { env });
    expect(unreadable.body.item.read_status).toBe('not_found_or_unreadable');
    expect(auditWrite).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure' })
    );
    plainDb.queryOne.mockImplementation(async (sql: string) => {
      if (String(sql).includes('INNER JOIN object_catalog')) throw new Error('loader failed');
      return chunkRow();
    });
    const failed = await probe({ catalog_id: 'cat_1' }, { env });
    expect(failed.body.item.read_status).toBe('error');
  });

  it('maps audit failures to 500', async () => {
    plainDb.queryOne.mockResolvedValue(chunkRow());
    auditWrite.mockRejectedValue(new Error('audit down'));
    expect((await probe({ catalog_id: 'cat_1', read_payload: false })).status).toBe(500);
  });
});
