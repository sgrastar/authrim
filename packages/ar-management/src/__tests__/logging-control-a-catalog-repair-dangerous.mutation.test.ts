/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
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
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { createApp, resetAdapter, routeSql } from './logging-control-a-harness';

const READ = ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ;
const RUN = ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN;
type Body = Record<string, any>;

let exportBucket: { put: ReturnType<typeof vi.fn> };
let tenantKey: string;

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; bucket?: boolean } = {}
) {
  const res = await createApp(perms, { platform: opts.platform ?? false }).request(
    `/api/admin/admin-logging${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    {
      DB_ADMIN: {},
      ...(opts.bucket === false ? {} : { EXPORT_ARTIFACTS: exportBucket }),
    }
  );
  return { status: res.status, body: await res.json<Body>() };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
  exportBucket = { put: vi.fn().mockResolvedValue({}) };
  tenantKey = await deriveTenantKeyFromTenantId('tenant-a');
});

describe('dangerous catalog repairs', () => {
  const objectRow = (extra: Record<string, unknown> = {}) => ({
    id: 'obj_1',
    tenant_key: tenantKey,
    log_type: 'diagnostic',
    plane: 'diagnostic_detail',
    object_key: 'logs/a.jsonl',
    object_kind: 'log_chunk',
    status: 'committed',
    record_count: '12',
    byte_count: 1,
    ...extra,
  });
  const manifestRow = (extra: Record<string, unknown> = {}) => ({
    id: 'man_1',
    tenant_key: tenantKey,
    log_type: 'diagnostic',
    plane: 'diagnostic_detail',
    manifest_object_key: 'manifests/a.json',
    record_count: 5,
    status: 'committed',
    ...extra,
  });
  const world = (rows: { object?: unknown; manifest?: unknown }) =>
    routeSql(mockAdapter, {
      one: [
        { match: /FROM log_object_catalog/, result: rows.object ?? null },
        { match: /FROM log_chunk_manifests/, result: rows.manifest ?? null },
      ],
    });
  const preview = (body: unknown, opts: { platform?: boolean } = {}) =>
    call([READ], 'POST', '/catalog-repairs/dangerous/preview', body, opts);
  const apply = (body: unknown, opts: { platform?: boolean } = {}) =>
    call([RUN], 'POST', '/catalog-repairs/dangerous/apply', body, opts);

  it('validates the action and its identifiers', async () => {
    const bad = await preview({ action: 'drop_everything' });
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields).toEqual([
      {
        path: 'action',
        code: 'invalid_value',
        message: 'Dangerous repair action is not supported.',
      },
    ]);
    for (const action of ['delete_object', 'purge_record_indexes']) {
      const res = await preview({ action });
      expect(res.body.details.fields).toEqual([
        { path: 'object_catalog_id', code: 'required', message: 'Object catalog id is required.' },
      ]);
    }
    const noManifest = await preview({ action: 'rewrite_manifest_lineage' });
    expect(noManifest.body.details.fields).toEqual([
      {
        path: 'manifest_id',
        code: 'required',
        message: 'Manifest id or manifest object key is required.',
      },
    ]);
  });

  it('404s unknown objects and manifests and enforces tenant scope', async () => {
    world({});
    expect((await preview({ action: 'delete_object', object_catalog_id: 'x' })).status).toBe(404);
    expect((await preview({ action: 'rewrite_manifest_lineage', manifest_id: 'x' })).status).toBe(
      404
    );
    expect(
      (await preview({ action: 'rewrite_manifest_lineage', manifest_object_key: 'x' })).status
    ).toBe(404);
    world({
      object: objectRow({ tenant_key: 'other' }),
      manifest: manifestRow({ tenant_key: 'other' }),
    });
    expect((await preview({ action: 'delete_object', object_catalog_id: 'obj_1' })).status).toBe(
      403
    );
    expect(
      (await preview({ action: 'rewrite_manifest_lineage', manifest_id: 'man_1' })).status
    ).toBe(403);
    expect(
      (await preview({ action: 'delete_object', object_catalog_id: 'obj_1' }, { platform: true }))
        .status
    ).toBe(200);
  });

  it('builds plans from objects and from manifests (by id or object key)', async () => {
    world({ object: objectRow(), manifest: manifestRow() });
    const del = await preview({ action: 'delete_object', object_catalog_id: 'obj_1' });
    expect(del.status).toBe(200);
    expect(del.body.item).toMatchObject({
      action: 'delete_object',
      tenantKey,
      impact: expect.objectContaining({
        objectCatalogId: 'obj_1',
        objectKey: 'logs/a.jsonl',
        affectedRecordCount: 12,
      }),
    });
    expect(del.body.item.confirmation).toEqual(expect.any(String));
    const byId = await preview({ action: 'rewrite_manifest_lineage', manifest_id: 'man_1' });
    expect(byId.body.item).toMatchObject({
      action: 'rewrite_manifest_lineage',
      impact: expect.objectContaining({
        manifestObjectKey: 'manifests/a.json',
        affectedRecordCount: 5,
      }),
      confirmation: 'CONFIRM REWRITE_MANIFEST_LINEAGE manifests/a.json',
    });
    const lookups = mockAdapter.queryOne.mock.calls.map(([s]) => String(s));
    expect(
      lookups.some((s) => s.includes('WHERE id = ?') && s.includes('log_chunk_manifests'))
    ).toBe(true);
    await preview({ action: 'rewrite_manifest_lineage', manifest_object_key: 'manifests/a.json' });
    expect(
      mockAdapter.queryOne.mock.calls.some(
        ([s, p]) => String(s).includes('manifest_object_key = ?') && p[0] === 'manifests/a.json'
      )
    ).toBe(true);
    expect(
      (await preview({ action: 'purge_record_indexes', object_catalog_id: 'obj_1' })).body.item
        .action
    ).toBe('purge_record_indexes');
  });

  it('requires the exact confirmation to apply', async () => {
    world({ object: objectRow() });
    const plan = (await preview({ action: 'delete_object', object_catalog_id: 'obj_1' })).body.item;
    const wrong = await apply({
      action: 'delete_object',
      object_catalog_id: 'obj_1',
      confirmation: 'nope',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.details.fields).toEqual([
      {
        path: 'confirmation',
        code: 'confirmation_mismatch',
        message: `Confirmation must be "${plan.confirmation}".`,
      },
    ]);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    const missing = await apply({ action: 'delete_object', object_catalog_id: 'obj_1' });
    expect(missing.status).toBe(400);
  });

  it('refuses while a tenant backup export is capturing, and honours step-up refusals', async () => {
    world({ object: objectRow() });
    const plan = (await preview({ action: 'delete_object', object_catalog_id: 'obj_1' })).body.item;
    const body = { action: 'purge_record_indexes', object_catalog_id: 'obj_1' };
    const purgePlan = (await preview(body)).body.item;
    stepUp.mockResolvedValueOnce(new Response('{}', { status: 428 }));
    const refused = await apply({ ...body, confirmation: purgePlan.confirmation });
    expect(refused.status).toBe(428);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      operation: 'audit.retention.shorten',
      targetIds: ['obj_1'],
      params: {
        kind: 'logging.catalog_repair.dangerous_apply',
        action: 'purge_record_indexes',
        object_catalog_id: 'obj_1',
        manifest_id: null,
        tenant_key: tenantKey,
      },
    });
    expect(plan.confirmation).toEqual(expect.any(String));
  });

  it('purges record indexes, logs a delivery event and audits critical', async () => {
    world({ object: objectRow() });
    const body = { action: 'purge_record_indexes', object_catalog_id: 'obj_1' };
    const plan = (await preview(body)).body.item;
    const res = await apply({ ...body, confirmation: plan.confirmation });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      action: 'purge_record_indexes',
      applied_at: expect.any(Number),
    });
    expect(res.body.audit_id).toBe('audit_1');
    const sqls = mockAdapter.execute.mock.calls.map(([s]) => String(s));
    expect(sqls[0]).toContain('UPDATE log_chunk_record_index');
    expect(mockAdapter.execute.mock.calls[0][1]).toEqual(['obj_1']);
    const event = mockAdapter.execute.mock.calls[1];
    expect(String(event[0])).toContain('INSERT INTO logging_delivery_events');
    expect(event[1].slice(1, 5)).toEqual([tenantKey, 'diagnostic', 'diagnostic_detail', 'obj_1']);
    expect(JSON.parse(event[1][7])).toMatchObject({
      action: 'catalog_repair.purge_record_indexes',
      dangerous_manual: true,
      confirmation: plan.confirmation,
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.catalog_repair.apply_dangerous',
        resourceType: 'log_object_catalog',
        resourceId: 'obj_1',
        severity: 'critical',
        metadata: expect.objectContaining({
          action: 'purge_record_indexes',
          confirmation: plan.confirmation,
        }),
      })
    );
  });

  it('deletes an object generation using the bucket binding of the object kind', async () => {
    for (const [extra, binding] of [
      [{ object_kind: 'dlq_payload' }, 'AUDIT_ARCHIVE'],
      [{ object_kind: 'export_artifact' }, 'EXPORT_ARTIFACTS'],
      [{ plane: 'sensitive_detail' }, 'SENSITIVE_DETAILS'],
      [{ plane: 'diagnostic_detail' }, 'DIAGNOSTIC_LOGS'],
      [{ plane: 'archive', log_type: 'diagnostic' }, 'DIAGNOSTIC_LOGS'],
      [{ plane: 'archive', log_type: 'audit' }, 'AUDIT_ARCHIVE'],
    ] as const) {
      mockAdapter.batch.mockReset();
      let retirement: Record<string, unknown> | null = null;
      mockAdapter.batch.mockImplementation(async (statements: Array<{ params: unknown[] }>) => {
        const p = statements[0].params;
        retirement = {
          id: p[0],
          tenant_key: p[1],
          bucket_binding: p[2],
          object_catalog_id: p[3],
          object_key: p[4],
          replacement_object_key: p[5],
          reason: p[6],
          key_registry_id: p[7],
          previous_key_version: p[8],
          replacement_key_version: p[9],
          record_count: p[10],
          accounting_applied: p[11],
          created_at: p[12],
        };
        return [{ rowsAffected: 1 }];
      });
      routeSql(mockAdapter, {
        one: [
          { match: /FROM tenant_backup_r2_retired_generations/, result: () => retirement },
          {
            match: /SELECT status, deleted_at FROM log_object_catalog/,
            result: () => ({ status: 'deleted', deleted_at: retirement?.created_at }),
          },
          { match: /FROM log_object_catalog/, result: objectRow(extra) },
        ],
      });
      const body = { action: 'delete_object', object_catalog_id: 'obj_1' };
      const plan = (await preview(body)).body.item;
      const res = await apply({ ...body, confirmation: plan.confirmation });
      expect(res.status).toBe(200);
      expect(mockAdapter.batch).toHaveBeenCalledTimes(1);
      expect(retirement).toMatchObject({
        id: 'log-delete:obj_1',
        tenant_key: tenantKey,
        bucket_binding: binding,
        object_catalog_id: 'obj_1',
        object_key: 'logs/a.jsonl',
        reason: 'catalog_delete',
      });
    }
  });

  it('marks a manifest for lineage repair and records the event without an object id', async () => {
    world({ manifest: manifestRow() });
    const body = { action: 'rewrite_manifest_lineage', manifest_id: 'man_1' };
    const plan = (await preview(body)).body.item;
    const res = await apply({ ...body, confirmation: plan.confirmation });
    expect(res.status).toBe(200);
    const update = mockAdapter.execute.mock.calls[0];
    expect(String(update[0])).toContain("SET status = 'repair_needed'");
    expect(update[1]).toEqual([res.body.result.applied_at, 'man_1']);
    expect(mockAdapter.execute.mock.calls[1][1][4]).toBeNull();
    expect(stepUp.mock.calls[0][1]).toMatchObject({
      targetIds: ['man_1'],
      params: expect.objectContaining({
        object_catalog_id: null,
        manifest_id: 'man_1',
        tenant_key: tenantKey,
      }),
    });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceType: 'log_chunk_manifest', resourceId: 'man_1' })
    );
  });

  it('maps database failures to 500', async () => {
    mockAdapter.queryOne.mockRejectedValue(new Error('db'));
    expect((await preview({ action: 'delete_object', object_catalog_id: 'x' })).status).toBe(500);
    expect((await apply({ action: 'delete_object', object_catalog_id: 'x' })).status).toBe(500);
  });
});
