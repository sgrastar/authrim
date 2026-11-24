/* eslint-disable @typescript-eslint/no-unsafe-member-access -- admin API response bodies are untyped JSON in these route tests */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: (await import('./logging-control-b-harness')).auditWrite,
}));
vi.mock('../admin-step-up-gate', async () => {
  const { stepUpFakes } = await import('./logging-control-b-harness');
  return {
    requireAdminStepUp: stepUpFakes.requireAdminStepUp,
    refuseAdminFreshAuth: stepUpFakes.refuseAdminFreshAuth,
  };
});
vi.mock('../log-read-adapter', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildReadAdapterMock(
    await importOriginal<typeof import('../log-read-adapter')>()
  )
);
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./logging-control-b-harness')).buildCoreMock(
    await importOriginal<typeof import('@authrim/ar-lib-core')>()
  )
);

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';

import {
  auditWrite,
  coreFakes,
  mockAdapter,
  resetFakes,
  stepUpFakes,
} from './logging-control-b-harness';
import { ADMIN_LOGGING, call, createApp, createPlatformApp } from './logging-control-b-app';

const NOW = Date.UTC(2026, 2, 5, 10, 20, 30, 123);
const READ = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ];
const RUN = [ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN];

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('dangerous catalog repairs', () => {
  const PREVIEW = `${ADMIN_LOGGING}/catalog-repairs/dangerous/preview`;
  const APPLY = `${ADMIN_LOGGING}/catalog-repairs/dangerous/apply`;
  const object = (overrides: Record<string, unknown> = {}) => ({
    id: 'obj_1',
    tenant_key: 'tk_a',
    log_type: 'audit',
    plane: 'archive',
    object_key: 'logs/a.chunk',
    object_kind: 'chunk',
    status: 'committed',
    record_count: '5',
    byte_count: 10,
    ...overrides,
  });
  const manifest = (overrides: Record<string, unknown> = {}) => ({
    id: 'man_1',
    tenant_key: 'tk_a',
    log_type: 'audit',
    plane: 'archive',
    manifest_object_key: 'manifests/m1.json',
    record_count: 9,
    status: 'committed',
    ...overrides,
  });
  const arrange = (input: { object?: unknown; manifest?: unknown }) =>
    mockAdapter.queryOne.mockImplementation(async (sql: string) =>
      String(sql).includes('FROM log_object_catalog')
        ? (input.object ?? null)
        : String(sql).includes('FROM log_chunk_manifests')
          ? (input.manifest ?? null)
          : null
    );

  it('previews the plan for an object-level action', async () => {
    expect((await call(createApp([]), 'POST', PREVIEW, {})).status).toBe(403);
    arrange({ object: object() });
    const res = await call(createPlatformApp(READ), 'POST', PREVIEW, {
      action: 'delete_object',
      object_catalog_id: ' obj_1 ',
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toEqual({
      action: 'delete_object',
      safety: 'dangerous_manual',
      tenantKey: 'tk_a',
      logType: 'audit',
      plane: 'archive',
      impact: {
        objectCatalogId: 'obj_1',
        objectKey: 'logs/a.chunk',
        affectedRecordCount: 5,
      },
      confirmation: 'CONFIRM DELETE_OBJECT obj_1',
    });
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['obj_1']);
  });

  it('validates the dangerous request', async () => {
    const app = createPlatformApp(READ);
    const noAction = await call(app, 'POST', PREVIEW, { action: 'format_disk' });
    expect(noAction.body.details.fields).toEqual([
      {
        path: 'action',
        code: 'invalid_value',
        message: 'Dangerous repair action is not supported.',
      },
    ]);
    for (const action of ['delete_object', 'purge_record_indexes']) {
      const res = await call(app, 'POST', PREVIEW, { action });
      expect(res.body.details.fields).toEqual([
        { path: 'object_catalog_id', code: 'required', message: 'Object catalog id is required.' },
      ]);
      expect((await call(app, 'POST', PREVIEW, { action, object_catalog_id: 'nope' })).status).toBe(
        404
      );
    }
    const noManifest = await call(app, 'POST', PREVIEW, { action: 'rewrite_manifest_lineage' });
    expect(noManifest.body.details.fields).toEqual([
      {
        path: 'manifest_id',
        code: 'required',
        message: 'Manifest id or manifest object key is required.',
      },
    ]);
    expect(
      (await call(app, 'POST', PREVIEW, { action: 'rewrite_manifest_lineage', manifest_id: 'x' }))
        .status
    ).toBe(404);
    expect(
      (
        await call(app, 'POST', PREVIEW, {
          action: 'rewrite_manifest_lineage',
          manifest_object_key: 'x',
        })
      ).status
    ).toBe(404);
    arrange({
      object: object({ tenant_key: 'tk_other' }),
      manifest: manifest({ tenant_key: 'tk_other' }),
    });
    const tenant = createApp(READ);
    expect(
      (await call(tenant, 'POST', PREVIEW, { action: 'delete_object', object_catalog_id: 'obj_1' }))
        .status
    ).toBe(403);
    expect(
      (
        await call(tenant, 'POST', PREVIEW, {
          action: 'rewrite_manifest_lineage',
          manifest_id: 'man_1',
        })
      ).status
    ).toBe(403);
    mockAdapter.queryOne.mockRejectedValue(new Error('x'));
    expect(
      (await call(app, 'POST', PREVIEW, { action: 'delete_object', object_catalog_id: 'o' })).status
    ).toBe(500);
  });

  it('plans a manifest repair looked up by id or by object key', async () => {
    arrange({ manifest: manifest() });
    const byId = await call(createPlatformApp(READ), 'POST', PREVIEW, {
      action: 'rewrite_manifest_lineage',
      manifest_id: 'man_1',
    });
    expect(byId.body.item).toMatchObject({
      action: 'rewrite_manifest_lineage',
      impact: { manifestObjectKey: 'manifests/m1.json', affectedRecordCount: 9 },
      confirmation: 'CONFIRM REWRITE_MANIFEST_LINEAGE manifests/m1.json',
    });
    expect(mockAdapter.queryOne.mock.calls[0][0]).toContain('WHERE id = ?');
    mockAdapter.queryOne.mockClear();
    await call(createPlatformApp(READ), 'POST', PREVIEW, {
      action: 'rewrite_manifest_lineage',
      manifest_object_key: 'manifests/m1.json',
    });
    expect(mockAdapter.queryOne.mock.calls[0][0]).toContain('WHERE manifest_object_key = ?');
    expect(mockAdapter.queryOne.mock.calls[0][1]).toEqual(['manifests/m1.json']);
  });

  it('requires repair run and the exact confirmation to apply', async () => {
    arrange({ object: object() });
    const body = { action: 'delete_object', object_catalog_id: 'obj_1' };
    expect((await call(createApp(READ), 'POST', APPLY, body)).status).toBe(403);
    const invalid = await call(createPlatformApp(RUN), 'POST', APPLY, { action: 'nope' });
    expect(invalid.status).toBe(400);
    for (const confirmation of [undefined, 'CONFIRM DELETE_OBJECT other']) {
      const res = await call(createPlatformApp(RUN), 'POST', APPLY, { ...body, confirmation });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'confirmation',
          code: 'confirmation_mismatch',
          message: 'Confirmation must be "CONFIRM DELETE_OBJECT obj_1".',
        },
      ]);
    }
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
  });

  it('retains data while a tenant backup export is active', async () => {
    coreFakes.listBackupTenantKeys.mockResolvedValue(new Set(['tk_a']));
    for (const action of ['delete_object', 'purge_record_indexes']) {
      arrange({ object: object() });
      const res = await call(createPlatformApp(RUN), 'POST', APPLY, {
        action,
        object_catalog_id: 'obj_1',
        confirmation: `CONFIRM ${action.toUpperCase()} obj_1`,
      });
      expect(res.status).toBe(400);
      expect(res.body.details.fields).toEqual([
        {
          path: 'object_catalog_id',
          code: 'backup_snapshot_active',
          message:
            'Record indexes are retained while a tenant backup export of this tenant is active.',
        },
      ]);
    }
    expect(coreFakes.listBackupTenantKeys).toHaveBeenCalledWith(mockAdapter);
    expect(stepUpFakes.requireAdminStepUp).not.toHaveBeenCalled();
    // a manifest repair is not blocked by a backup export
    arrange({ manifest: manifest() });
    const manifestRes = await call(createPlatformApp(RUN), 'POST', APPLY, {
      action: 'rewrite_manifest_lineage',
      manifest_id: 'man_1',
      confirmation: 'CONFIRM REWRITE_MANIFEST_LINEAGE manifests/m1.json',
    });
    expect(manifestRes.status).toBe(200);
  });

  it('deletes an object through generation retirement, step-up first', async () => {
    arrange({ object: object() });
    const body = {
      action: 'delete_object',
      object_catalog_id: 'obj_1',
      confirmation: 'CONFIRM DELETE_OBJECT obj_1',
    };
    stepUpFakes.requireAdminStepUp.mockResolvedValueOnce(new Response('stepup', { status: 401 }));
    expect((await call(createPlatformApp(RUN), 'POST', APPLY, body)).status).toBe(401);
    expect(coreFakes.retireGeneration).not.toHaveBeenCalled();
    expect(stepUpFakes.requireAdminStepUp).toHaveBeenCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: 'tenant-a',
      targetIds: ['obj_1'],
      params: {
        kind: 'logging.catalog_repair.dangerous_apply',
        action: 'delete_object',
        object_catalog_id: 'obj_1',
        manifest_id: null,
        tenant_key: 'tk_a',
      },
    });
    const res = await call(createPlatformApp(RUN), 'POST', APPLY, body);
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ action: 'delete_object', applied_at: NOW });
    expect(res.body.result.plan.confirmation).toBe('CONFIRM DELETE_OBJECT obj_1');
    expect(coreFakes.retireGeneration).toHaveBeenCalledWith(mockAdapter, {
      retirementId: 'log-delete:obj_1',
      tenantKey: 'tk_a',
      objectCatalogId: 'obj_1',
      objectKey: 'logs/a.chunk',
      deletedAt: NOW,
      bucketBinding: 'AUDIT_ARCHIVE',
    });
    const insert = mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO logging_delivery_events')
    ) as [string, unknown[]];
    expect(insert[1]).toEqual([
      expect.stringMatching(/^lde_/),
      'tk_a',
      'audit',
      'archive',
      'obj_1',
      NOW,
      NOW,
      JSON.stringify({
        action: 'catalog_repair.delete_object',
        dangerous_manual: true,
        confirmation: 'CONFIRM DELETE_OBJECT obj_1',
        impact: { objectCatalogId: 'obj_1', objectKey: 'logs/a.chunk', affectedRecordCount: 5 },
      }),
    ]);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin_logging.catalog_repair.apply_dangerous',
        resourceType: 'log_object_catalog',
        resourceId: 'obj_1',
        severity: 'critical',
        metadata: {
          action: 'delete_object',
          confirmation: 'CONFIRM DELETE_OBJECT obj_1',
          impact: { objectCatalogId: 'obj_1', objectKey: 'logs/a.chunk', affectedRecordCount: 5 },
        },
      })
    );
  });

  it('chooses the bucket binding of the deleted object', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ object_kind: 'dlq_payload' }, 'AUDIT_ARCHIVE'],
      [{ object_kind: 'export_artifact' }, 'EXPORT_ARTIFACTS'],
      [{ plane: 'sensitive_detail' }, 'SENSITIVE_DETAILS'],
      [{ plane: 'diagnostic_detail' }, 'DIAGNOSTIC_LOGS'],
      [{ log_type: 'diagnostic' }, 'DIAGNOSTIC_LOGS'],
      [{}, 'AUDIT_ARCHIVE'],
    ];
    for (const [overrides, binding] of cases) {
      coreFakes.retireGeneration.mockClear();
      arrange({ object: object(overrides) });
      const res = await call(createPlatformApp(RUN), 'POST', APPLY, {
        action: 'delete_object',
        object_catalog_id: 'obj_1',
        confirmation: 'CONFIRM DELETE_OBJECT obj_1',
      });
      expect(res.status).toBe(200);
      expect(coreFakes.retireGeneration.mock.calls[0][1].bucketBinding).toBe(binding);
    }
  });

  it('purges record indexes and rewrites manifest lineage with targeted updates', async () => {
    arrange({ object: object() });
    const purge = await call(createPlatformApp(RUN), 'POST', APPLY, {
      action: 'purge_record_indexes',
      object_catalog_id: 'obj_1',
      confirmation: 'CONFIRM PURGE_RECORD_INDEXES obj_1',
    });
    expect(purge.status).toBe(200);
    const purgeUpdate = mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE log_chunk_record_index')
    ) as [string, unknown[]];
    expect(purgeUpdate[0]).toContain("SET status = 'deleted'");
    expect(purgeUpdate[0]).toContain("object_catalog_id = ? AND status <> 'deleted'");
    expect(purgeUpdate[1]).toEqual(['obj_1']);
    expect(coreFakes.retireGeneration).not.toHaveBeenCalled();

    mockAdapter.execute.mockClear();
    auditWrite.mockClear();
    arrange({ manifest: manifest() });
    const rewrite = await call(createPlatformApp(RUN), 'POST', APPLY, {
      action: 'rewrite_manifest_lineage',
      manifest_id: 'man_1',
      confirmation: 'CONFIRM REWRITE_MANIFEST_LINEAGE manifests/m1.json',
    });
    expect(rewrite.status).toBe(200);
    const update = mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE log_chunk_manifests')
    ) as [string, unknown[]];
    expect(update[0]).toContain("SET status = 'repair_needed', updated_at = ?");
    expect(update[1]).toEqual([NOW, 'man_1']);
    expect(stepUpFakes.requireAdminStepUp.mock.calls.at(-1)?.[1]).toMatchObject({
      targetIds: ['man_1'],
      params: { object_catalog_id: null, manifest_id: 'man_1', tenant_key: 'tk_a' },
    });
    const insert = mockAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO logging_delivery_events')
    ) as [string, unknown[]];
    expect(insert[1][4]).toBeNull();
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceType: 'log_chunk_manifest',
        resourceId: 'man_1',
        severity: 'critical',
      })
    );
    mockAdapter.execute.mockRejectedValue(new Error('x'));
    expect(
      (
        await call(createPlatformApp(RUN), 'POST', APPLY, {
          action: 'rewrite_manifest_lineage',
          manifest_id: 'man_1',
          confirmation: 'CONFIRM REWRITE_MANIFEST_LINEAGE manifests/m1.json',
        })
      ).status
    ).toBe(500);
  });
});
