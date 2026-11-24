/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { createApp, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const READ = ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ;
const RUN = ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN;
type Body = Record<string, any>;

async function call(perms: string[], method: string, path: string, body?: unknown) {
  const res = await createApp(perms, { platform: true }).request(
    `/api/admin/admin-logging${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {} }
  );
  return { status: res.status, body: await res.json<Body>() };
}

const OLD = 1_000; // far in the past: pending objects older than any TTL
const objectRow = (extra: Record<string, unknown>) => ({
  id: 'obj',
  tenant_key: 'tk1',
  log_type: 'audit',
  plane: 'archive',
  object_key: 'k',
  status: 'pending',
  record_count: '1',
  byte_count: '2',
  checksum_sha256: null,
  created_at: OLD,
  committed_at: null,
  ...extra,
});

const OBJECTS = [
  objectRow({ id: 'o_pending_a', status: 'pending' }),
  objectRow({
    id: 'o_orphan_b',
    status: 'orphan_candidate',
    tenant_key: 'tk2',
    log_type: 'job',
    plane: 'primary',
  }),
  objectRow({
    id: 'o_orphan_c',
    status: 'orphan_candidate',
    tenant_key: 'tk1',
    log_type: 'job',
    plane: 'archive',
  }),
  objectRow({
    id: 'o_orphan_d',
    status: 'orphan_candidate',
    tenant_key: 'tk1',
    log_type: 'audit',
    plane: 'primary',
  }),
];

function world(capturing: string[] = []) {
  routeSql(mockAdapter, {
    many: [
      { match: /FROM log_object_catalog/, result: OBJECTS },
      { match: /tenant_backup_snapshots/, result: capturing.map((tenant_key) => ({ tenant_key })) },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  world();
});

describe('GET /catalog-repairs findings', () => {
  const ids = (res: { body: Body }) => (res.body.items as Body[]).map((f) => f.objectCatalogId);

  it('detects expired pending objects and orphan candidates', async () => {
    const res = await call([READ], 'GET', '/catalog-repairs');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(['o_pending_a', 'o_orphan_b', 'o_orphan_c', 'o_orphan_d']);
    expect(res.body.items[0]).toMatchObject({
      type: 'expired_pending_object',
      action: 'mark_orphan_candidate',
      safety: 'safe_auto',
      tenantKey: 'tk1',
      logType: 'audit',
      plane: 'archive',
    });
    expect(res.body.items[1]).toMatchObject({
      type: 'orphan_candidate_cleanup',
      action: 'delete_orphan_indexes',
    });
    expect(res.body.total).toBe(4);
  });

  it('passes the tenant key and limit to the queries and applies the log type and plane filters', async () => {
    const res = await call([READ], 'GET', '/catalog-repairs?tenant_key=tk1&log_type=job&limit=7');
    expect(ids(res)).toEqual(['o_orphan_c']);
    const objectQuery = must(
      mockAdapter.query.mock.calls.find(([s]) => String(s).includes('FROM log_object_catalog'))
    );
    expect(objectQuery[0]).toContain('AND tenant_key = ?');
    expect(objectQuery[1]).toEqual(['tk1', 7]);

    expect(ids(await call([READ], 'GET', '/catalog-repairs?plane=primary'))).toEqual([
      'o_orphan_b',
      'o_orphan_d',
    ]);
    expect(
      ids(
        await call([READ], 'GET', '/catalog-repairs?filter[log_type]=audit&filter[plane]=primary')
      )
    ).toEqual(['o_orphan_d']);
    expect(ids(await call([READ], 'GET', '/catalog-repairs?tenant_key=tk2'))).toEqual([
      'o_orphan_b',
    ]);
    mockAdapter.query.mockClear();
    await call([READ], 'GET', '/catalog-repairs');
    const unfiltered = must(
      mockAdapter.query.mock.calls.find(([s]) => String(s).includes('FROM log_object_catalog'))
    );
    expect(unfiltered[0]).not.toContain('AND tenant_key = ?');
    expect(unfiltered[1]).toEqual([100]);
  });

  it('clamps the limit to between 1 and 500', async () => {
    await call([READ], 'GET', '/catalog-repairs?limit=100000');
    expect(
      must(
        mockAdapter.query.mock.calls.find(([s]) => String(s).includes('FROM log_object_catalog'))
      )[1]
    ).toEqual([500]);
    mockAdapter.query.mockClear();
    await call([RUN], 'POST', '/catalog-repairs/apply-safe', { limit: 100000 });
    expect(
      must(
        mockAdapter.query.mock.calls.find(([s]) => String(s).includes('FROM log_object_catalog'))
      )[1]
    ).toEqual([500]);
    mockAdapter.query.mockClear();
    await call([RUN], 'POST', '/catalog-repairs/apply-safe', { limit: 3 });
    expect(
      must(
        mockAdapter.query.mock.calls.find(([s]) => String(s).includes('FROM log_object_catalog'))
      )[1]
    ).toEqual([3]);
    mockAdapter.query.mockClear();
    await call([RUN], 'POST', '/catalog-repairs/apply-safe', { limit: 0 });
    expect(
      must(
        mockAdapter.query.mock.calls.find(([s]) => String(s).includes('FROM log_object_catalog'))
      )[1]
    ).toEqual([100]);
  });
});

describe('POST /catalog-repairs/apply-safe', () => {
  it('requires the run permission', async () => {
    expect((await call([READ], 'POST', '/catalog-repairs/apply-safe', {})).status).toBe(403);
  });

  it('applies safe findings, records the audit, and skips tenants with a capturing backup', async () => {
    world(['tk2']);
    const res = await call([RUN], 'POST', '/catalog-repairs/apply-safe', {});
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ finding_count: 4, applied_count: 3, skipped_count: 1 });
    expect(res.body.result.applied.map((f: Body) => f.objectCatalogId)).toEqual([
      'o_pending_a',
      'o_orphan_c',
      'o_orphan_d',
    ]);
    expect(res.body.result.skipped).toEqual([
      {
        finding: expect.objectContaining({ objectCatalogId: 'o_orphan_b' }),
        reason: 'backup_snapshot_active',
      },
    ]);
    const sqls = mockAdapter.execute.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => s.includes("SET status = 'orphan_candidate'"))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO logging_delivery_events'))).toBe(true);
    expect(
      mockAdapter.execute.mock.calls.some(([, p]) => Array.isArray(p) && p.includes('o_orphan_b'))
    ).toBe(false);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.catalog_repair.apply_safe',
        resourceType: 'log_object_catalog',
        resourceId: 'safe-auto-repair',
        severity: 'warn',
        metadata: expect.objectContaining({
          finding_count: 4,
          applied_count: 3,
          skipped_count: 1,
          tenant_key: null,
        }),
      })
    );
  });

  it('audits info severity when nothing was applied and maps failures to 500', async () => {
    routeSql(mockAdapter, { many: [] });
    const res = await call([RUN], 'POST', '/catalog-repairs/apply-safe', {});
    expect(res.body.result).toMatchObject({ finding_count: 0, applied_count: 0, skipped_count: 0 });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ severity: 'info' })
    );
    mockAdapter.query.mockRejectedValue(new Error('db'));
    expect((await call([RUN], 'POST', '/catalog-repairs/apply-safe', {})).status).toBe(500);
    expect((await call([READ], 'GET', '/catalog-repairs')).status).toBe(500);
  });
});
